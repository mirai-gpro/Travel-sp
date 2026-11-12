# ショップ推薦エンジン v2 — 実装仕様書（PoC Step 1〜2）

- 上位文書: 「Travel-sp ショップ推薦エンジン 新基本仕様書 Version 1.0」（2026-11-12、以下「基本仕様」）
- 本書の位置づけ: 基本仕様を、コードとして検証できる粒度に落としたもの。**数値（時間予算・候補数・閾値）はすべて PoC で実測して決める暫定値**であり、確定値ではない。
- 実装場所: `support-base/shop_engine/`（独立パッケージ。Dockerfile の COPY 対象外のため、現行の本番イメージには入らない）
- 本書の範囲: Step 1（推薦エンジン単体）と Step 2（Places 照合）。Step 3〜6 はインタフェースのみ定義し、PoC 結果を見てから実装する。

---

## 0. 前提として確定している事実

| 事実 | 根拠 |
|---|---|
| Live の `search_shops` が渡す入力は `user_request`（条件の要約文字列）1つ | `live_api_handler.py` `SEARCH_SHOPS_DECLARATION` |
| 現行（33秒版）は Gemini 2.5 Flash + Google 検索を**毎回**実行し、それだけで 19.8〜39.4 秒（2026-11-12 実測 3 回） | Cloud Logging（00060-car / sc-7655ca0） |
| 現行の Places 照合は「検索結果の先頭の営業中店舗を採用」で、店名の照合をしていない | `api_integrations.search_place()` |
| 現行の Places 等の処理は直列で 4.3〜4.4 秒、並列化で 0.46 秒（各 1〜2 回の実測） | 同上 |
| 33秒版でも、`tool_response` 後に Live モデルが話さない事象がある（09:29 の 1 回） | 同上。本エンジンの範囲外（Step 5 で扱う） |

**未検証（PoC で測る）**: 推薦 LLM が 1〜3 秒で候補を返せるか。使えるモデル名。Places 照合率。基本仕様の時間目標は、この実測が出るまで達成可能とも不可能とも書かない。

---

## 1. 全体構成

```
user_request ─▶ [A] Recommender（LLM・ストリーミング・検索ツールなし）
                    │  1行目: plan（area / genre / freshness 判断）
                    │  2行目〜: candidate（推薦順に1件ずつ）
                    ▼
                ├─▶ [B] Freshness Search（plan.freshness.required のときだけ。別スレッド）
                ├─▶ Geocoding（plan.area。1回だけ）
                └─▶ [C] Place Verifier（candidate が届いた順に並列照会）
                         │ VERIFIED / AMBIGUOUS / NOT_FOUND / CLOSED / ERROR
                         ▼
                    [D] Card Composer（推薦順に確定したものから shop_card_ready）
                         ▼
                    [E] Presentation Coordinator（Step 4〜5。本書ではイベント定義のみ）
```

### 1.1 速度の設計（クリティカルパス）

現行の遅さの主因は「Google 検索付き生成を毎回、全文 JSON が出来上がるまで待つ」こと。v2 は次の 3 点でクリティカルパスを短くする。

1. **検索ツールを付けない推薦呼び出し**（検索は LLM が必要と判断した場合のみ、別経路）。
2. **ストリーミング**: 1 件目の候補の行が届いた瞬間に、その店の Places 照合を開始する。全文の完成を待たない。
3. **照合の並列化と順序付き確定**: 照合は並列、カードの確定は推薦順（§5）。

初回カードの理論的な所要時間 ≒ LLM の「1 件目の候補行が届くまで」＋「その店の Places 照合 1 回」。これが 5 秒に収まるかは PoC で測る。

---

## 2. [A] Recommender

### 2.1 呼び出し

- SDK: `google-genai`（現行と同じ `genai.Client`）。`generate_content_stream` を使う。
- ツール: **なし**（Google 検索は付けない）。
- モデル・推論設定: **未確定（基本仕様 §12-1）**。PoC ベンチで実在するモデルを列挙し（`--list-models`）、候補を比較する。既定値は現行コードで使用実績のある `gemini-2.5-flash`。モデル名は推測で書かない。
- 思考設定: `thinking_budget` を引数化（PoC で 0 / 既定 などを比較）。
- 候補数 `N`: 既定 8（基本仕様 §4 Phase 2 の検証初期値）。引数化。

### 2.2 出力形式（NDJSON。1 行 1 オブジェクト）

全体を 1 個の JSON にすると、閉じ括弧まで解析できずストリーミングの利点が消えるため、1 行ごとに完結する JSON を出力させる。

```
{"type":"plan","area":"中目黒","genre":"焼き鳥","count":5,"freshness":{"required":false,"central":false,"reason":"","query":""}}
{"type":"candidate","rank":1,"name":"店名","name_variants":["別表記","English Name"],"area":"中目黒","category":"焼き鳥","reason":"推薦理由（2〜3文）","specialty":"看板料理","price_range":"5,000〜7,000円"}
...（N 件）
{"type":"end"}
```

- `plan` を最初に出させることで、Geocoding と（必要なら）Freshness Search を候補生成と並行して開始できる。
- `name_variants`: 正式名の別表記（読み・英字・旧店名）。**LLM 自身の出力**であり、Maps 由来データを LLM に渡すものではない。照合（§4）の表記揺れ対策に使う。
- `freshness.required`: 最新情報の補完が推薦品質に有益と LLM が判断したか。`central`: 最新情報がユーザー要望の中心か（例「最近オープンした」）。
- プロンプトで禁止: 候補不足・確信度不足を理由に検索を要求すること（基本仕様 §2.2）。
- 解析: 受信テキストをバッファし、改行ごとに `{` で始まる行を `json.loads`。コードフェンス・空行・解析不能行は無視して記録。`rank` は**受信順で付け直す**（LLM の rank 値は参考）。

### 2.3 失敗時

- 例外（503 等）・タイムアウト（既定 20 秒、PoC で決定）→ `recommendation_error`（`reason=upstream_error|timeout|parse_error`）。**再試行・別モデルへの切替はしない**（基本仕様 §12-6 で決めるまで）。
- 有効な candidate が 0 件 → `recommendation_completed(cards=0, status=no_candidates)`。

---

## 3. [B] Freshness Search（Step 3 で本実装。Step 1 では判断の記録と所要時間の計測のみ）

- 起動条件: `plan.freshness.required == true` のときだけ。候補不足・照合失敗では起動しない。
- 呼び出し: Google 検索ツール付きの別 LLM 呼び出し（`query` と `user_request` を入力）。出力は「最新情報メモ」。
- Step 1 の扱い: 起動・終了時刻とメモを記録するだけで、カードには反映しない。
- 反映方式（基本仕様 §12-4, 5）は未決定。**提案（要承認）**:
  - `central == false`: カードは検索を待たずに表示。検索結果は表示済みカードの順位・内容を変えない。
  - `central == true`: 検索付き呼び出しで候補を作る経路に切り替える（速度より品質を優先。基本仕様 §5.2）。

---

## 4. [C] Place Verifier

### 4.1 照会

- API: 現行と同じ Places Text Search（legacy, `textsearch/json`）。**Places 側の順位は採用基準に使わない**。上位 5 件すべてを照合して、最もよく一致する 1 件を選ぶ。
- クエリ: `"{name} {area}"`、`language=ja`, `region=jp`。Geocoding が取れていれば `location` + `radius=3000` で位置バイアス（現行と同じ値）。`type` は付けない（カフェ・バーを除外しないため。業態は §4.3 で判定）。
- `NOT_FOUND` のときだけ、`name_variants` の先頭で 1 回だけ再照会する。
- タイムアウト: 1 リクエスト 5 秒（暫定）。超過は `ERROR`（表示しない）。
- Place Details は照合には使わない（往復を増やさないため）。

### 4.2 名前の正規化（決定的ルール）

1. NFKC 正規化、小文字化。
2. 括弧内（`(...)`・`（...）`・`【...】`）を別表記として分離。
3. 末尾の支店名を除去: 空白区切りの最終語が `店` で終わる（`中目黒店`・`本店` 等）、または `{area}店` で終わる場合。
4. 業態の一般語（`炭火焼鳥` `焼鳥` `焼き鳥` `やきとり` `串焼き` `居酒屋` `レストラン` `trattoria` `ristorante` `pizzeria` `bistro` `cafe` 等。一覧はコード内定数）を除去。ただし除去後の残りが 2 文字未満なら除去しない。
5. 空白・記号を除去 → **コア名**。

### 4.3 判定

候補の名前群（`name` と `name_variants`）× Places 結果の名前群（`name` と括弧内）について、コア名の類似度の最大値 `S` を求める。

- 一致: コア名が完全一致 → 1.0
- 包含: 短い方が 2 文字以上で長い方に含まれ、長さ比 ≥ 0.5 → 0.9
- それ以外: 文字 bigram の Dice 係数

位置の一致 `L`: Places の住所に `area` 文字列が含まれる、または Geocoding した area 中心から `R` km 以内（暫定 `R=2.0`）。

業態 `F`: Places の `types` に飲食系（`restaurant` `food` `bar` `cafe` `bakery` `meal_takeaway` `meal_delivery`）のいずれかを含む。

| 判定 | 条件 |
|---|---|
| **VERIFIED** | `S ≥ 0.85` かつ `L` かつ `F` かつ `business_status == OPERATIONAL`（未記載は OPERATIONAL 扱い） かつ、同条件を満たす**別の place_id が無い** |
| **CLOSED** | `S ≥ 0.85` かつ `L` で、`CLOSED_PERMANENTLY` / `CLOSED_TEMPORARILY` |
| **AMBIGUOUS** | `S ≥ 0.6` だが VERIFIED 条件を満たさない、または VERIFIED 条件を満たす別店舗が複数 |
| **NOT_FOUND** | 上記いずれでもない（結果 0 件を含む） |
| **ERROR** | API エラー・タイムアウト |

- **VERIFIED 以外は通常カードにしない**（基本仕様 §4 Phase 4）。
- 「似た名前の別店舗」の防止は `S` と `L` の両方で行う（同名チェーンの別地域店は `L` で落ちる）。
- 閾値 0.85 / 0.6 / 2.0km は暫定。PoC で全照合結果（候補名・Places 名・S・L・判定）を記録し、ユーザー評価と突き合わせて決める。
- Places から得た情報は LLM に渡さない（基本仕様 §4 規約条件）。

---

## 5. [D] Card Composer（順序付き確定）

- 照合は並列だが、**カードは推薦順でしか確定しない**: 推薦順 `k` の候補は、`1..k-1` の照合がすべて終わってから確定する。VERIFIED なら次の表示順位を割り当てて `shop_card_ready` を出す。そうでなければ飛ばす（＝次順位の候補で補う）。
- これにより、先に出したカードの順位が後から変わらない（基本仕様 §4 Phase 5）。
- 5 件確定したら完了（残りの照合結果は待たない・使わない）。候補を使い切って 5 件未満なら、その件数で完了し `status=short` を記録する。**未検証店舗で埋めない**。
- カードの項目（既存 `ShopCardList` と互換）:
  - LLM 由来: `category`, `description`（= reason）, `priceRange`, `highlights`（specialty）
  - Places 由来: `name`（照合済みの Places 名）, `location`（住所）, `latitude`/`longitude`, `rating`, `reviewCount`, `maps_url`, `place_id`, `image`
  - 付加: `recommend_rank`（推薦順）, `display_rank`（表示順）, `verification`（判定と S）
- `image` は現行と同じ Places Photo URL 形式（API キーを含む URL がブラウザに渡る点は現行と同じ。変更するかは別途判断）。
- Hot Pepper / TripAdvisor / 食べログ等の外部リンクは Step 4 で扱う（カードの必須項目ではない）。

---

## 6. [E] イベント（Step 4 で実装。本書では定義のみ）

| イベント | 主な項目 |
|---|---|
| `recommendation_started` | `request_id` |
| `candidate_verified` | `request_id`, `recommend_rank`, `status`（VERIFIED 等） |
| `shop_card_ready` | `request_id`, `display_rank`, `place_id`, `card` |
| `recommendation_completed` | `request_id`, `count`, `status`（`ok` / `short` / `no_candidates`）, `cards` |
| `recommendation_error` | `request_id`, `reason` |

- フロントは「最後に開始した `request_id`」以外のイベントを捨てる。同一 `request_id` 内で `place_id` が重複するカードは捨てる（サーバー側でも重複排除する）。
- Live への `tool_response` は `recommendation_completed` の確定リストから作る（音声・チャット・カードが同じ確定データを参照する。基本仕様 §7.2）。

---

## 7. 計測（基本仕様 §9.1）

| 記号 | 時点 | 記録する場所 |
|---|---|---|
| T0 | 推薦要求の受理 | `pipeline.run` 開始 |
| T1 | LLM の最初のチャンク受信 | Recommender |
| T1p | plan 行の受信 | Recommender |
| T1c | 1 件目の candidate 行の受信 | Recommender |
| T2 | LLM 出力の完了 | Recommender |
| T3 | 最初の Places 照会開始 | Verifier |
| T4 | 最初の照合完了 | Verifier |
| T5 | 初回カード確定（サーバー側） | Composer |
| T6 | 5 件目のカード確定（サーバー側） | Composer |
| T7 | 推薦処理の完了 | `pipeline.run` 終了 |
| Fs/Fe | Freshness Search の開始・終了と理由 | Freshness |

- 基本仕様の T5/T6 は**ブラウザでの実表示**。サーバー側の確定時刻との差（転送＋描画）は Step 4 でフロント計測を入れて測る。
- 失敗の種類（`upstream_error` / `timeout` / `parse_error` / `no_candidates`）は成功と分けて記録し、成功時の統計に混ぜない。

---

## 8. PoC の手順と判定材料

### Step 1+2 ベンチ（本書で実装済み）

`tools/shop-engine-poc/run_poc_step12.sh` を Cloud Shell で実行（読み取り専用。Cloud Run・トラフィック・本番設定は変更しない）。

1. 利用可能な Gemini モデルを列挙する。
2. 評価クエリ（基本仕様 §9.2 ＋中目黒の 3 件）を、指定したモデル・設定で各 `R` 回実行する。
3. 各回の T0〜T7、全候補の照合結果（候補名・Places 名・S・L・判定）、最終カード、Freshness 判断を JSON と表で出力する。

### 決めること（ユーザー判断）

- モデル・思考設定・候補数（速度と推薦品質の兼ね合い。品質評価はユーザーが行う）
- 照合の閾値（誤った VERIFIED が 0 件になる値。VERIFIED 漏れの率も見る）
- 時間目標が達成可能か。不可能な場合、実測に基づくボトルネックと下限

### Step 3 以降の着手条件

Step 1+2 で「候補生成と照合の速度・品質がユーザーの合格水準にある」構成が見つかった後に着手する。見つからない場合は、実測値を添えて報告し、方式の判断をユーザーに委ねる。

---

## 9. 変更しないもの

UIKA FULL133・LAM/A2E・アバター起動・double reset・Greeting・Live 音声モデルと起動処理・既存の `search_shops` 経路・本番 Cloud Run / Vercel。
本 PoC は新規パッケージの追加のみで、既存ファイルを変更しない。
