# 初期起動改善の顛末と二重リセット（2026-10-23〜10-30）

本書は、2026-10-23〜10-30 に行った初期起動改善（「アバターが表示されてから初期挨拶を始める」）の経緯、最終的に本番へ入れた仕組み、二重リセットについて分かったことをまとめたものである。
旧版の `docs/旧版仕様書/21_lipsync_startup_fix_guide.md`（初期あいさつリップシンク不具合 対処ガイド）は、本書に置き換える。同書のうち今も有効な内容（再ビルド問題と復旧手順）は、本書の §5 に引き継いだ。

- 記載の時刻は git の commit 時刻（日本時間）。PR 番号は `mirai-gpro/Travel-sp`。
- 「事実」はログ・コード・git 履歴で確認したもの。「推測」と書いたものは確認していない。
- Gemini Live API と A2E の内部挙動については、推測で断定しない。

---

## 1. 結論

| 項目 | 内容 |
|---|---|
| 最終的に本番へ入れた変更 | PR #112（`b0a8ea3`）、PR #114（`2d94650`）。どちらもフロントのみ |
| 仕組み | Gemini 側の流れ（二重リセット・G1/G2・挨拶の生成）は Golden のまま変えず、フロントで**挨拶の再生だけ**をアバターの表示まで保留する。ソフトリセット後も同じく保留する |
| バックエンド | 変更なし。本番は 4 月のイメージの revision `travel-sp-base-00029-6cz`（traffic 100%） |
| 結果（PC、ユーザー確認） | アバターが表示されてから挨拶が始まる。挨拶の冒頭から口が止まらない。ソフトリセット後も止まらない |
| 未確認 | スマホでの確認 |
| 未解明 | 二重リセットが何を正常化しているのか（§4） |

---

## 2. 経緯

### 2.1 10-23〜10-27：起動改善の連続失敗（採用ゼロ）

この期間に本番ブランチへの merge は 21 件、取り消し・復旧の PR は 6 件。起動改善として残ったものはなく、残った変更はスマホ向けの PR #104（スマホ + FULL133 で描画解像度 DPR を 1.0 に）だけだった。

| 日付 | 主な出来事 |
|---|---|
| 10-23 | FULL133 の端末インストール（PR #85〜#87）。実機で 2 回止まり、都度修正 |
| 10-24 | 口のフリーズ対策（PR #88）から起動改善へ（PR #89〜#91）。挨拶の途切れ、先読み時間の誤った調整を経て、**二重リセットを撤去して初回 Live を 1 本化**（PR #92 / #93）→ 初期挨拶が約 22 秒待ち（表情データ 553 フレームが最後に一括で到着）。バックエンドが約 6 ヶ月ぶりに本番デプロイされる。PR #94 で二重リセットを戻し、最終的に `7711271d` の tree へ全面復旧（PR #96 / #97） |
| 10-25 | 起動再設計 B-1（PR #98）→ 撤回（PR #99）。**Startup Architecture Phase 1〜5（PR #100）**を本番へ入れ、バックエンドもデプロイ（run #150）→ 口の動きの質が下がる（スマホはさらに顕著）。全撤回（PR #101、run #151、revision `00034-2ss`）しても音声が途切れる。ユーザーが 4 月の revision `00029-6cz` へ traffic を戻して PC は回復 |
| 10-26 | スマホ UIKA：PR #102 は前提が誤りで PR #103 で取り消し。PR #104（DPR 1.0）で成功。Golden Baseline を `732cb5ab` に整理。Startup R2 Round 1 は FAIL で破棄 |
| 10-27 | v2.0（**PR #105**：FULL133 のアバター初期化を Live 開始前に移す）→ 本番でリップシンク回帰 → PR #106 で取り消し。本番は Golden（tree `3dfd8baf`）に戻る |

この期間の詳細な時系列と Claude 側の誤り（10 件）は、Claude Docs の「Travel-sp Startup 改善 4日間の顛末」（https://claude.ai/artifact/Fuv7SJn6PvdxNdw5iCBEwC）に記録した。

### 2.2 10-27〜10-29：PR #100 をベースにした改善の検討

ユーザーの方針：「起動改善は諦めない。PR #100 をベースに改善する」。

#### 検証の方法（本番に影響させない）

- バックエンドは、4 月の正常なイメージ（`travel-sp-base@sha256:df982977…`）を土台に `.py` だけを上書きし、Cloud Build でビルドする。`gcloud run deploy --no-traffic --tag=<tag>` で、traffic 0% の検証用 revision にする（§5.2）。
- フロントは、実験ブランチ（`exp/*`）の Vercel Preview（ブランチ固定 URL）で動かす。検証用 revision の CORS に、その Preview の URL を加える。
- 比較の基準は **T1**（`exp/resume-gate-t1`、`1018b00`、tag `rgt1`）：Golden に CORS と接続先の固定だけを加えたもの。T1 は本番と同等の結果になり、ビルド方法と検証経路に問題がないことを確認した。

#### 試した案と結果

| 案 | ブランチ / tag | 内容 | 結果 |
|---|---|---|---|
| 案A | `exp/resume-gate`（`e1891f5`）/ `rgt2` | G2 が Gemini に接続した**後**、最初の入力（`send_realtime_input`）の直前で、フロントの合図（`LAMAvatar連携完了` の後）を待つ | 交互比較で「案A だけ明らかに止まる」→ **不合格**。本番用の PR #111 は merge せずに閉じた |
| 案1 | `exp/connect-gate`（`6dbffe8`）/ `rgt3` | G2 が Gemini に接続する**前**で合図を待つ。接続後は Golden と同じく、すぐに最初の入力を送る | 「冒頭からリップシンクが良くない」。2 ターン目で約 1.08 秒止まる → **不合格** |
| 案3 | `exp/visible-gate`（`9c015d3`）/ `rgt4` | 案1 のバックエンドに、PR #100 のアバター表示判定（AVATAR_VISIBLE、`SceneRevealMode.Instant`）を加え、表示後に合図 | 挨拶で約 1.65 秒、2 ターン目で約 1.29 秒止まる → **不合格** |
| **再生だけを遅らせる案** | `exp/playback-hold`（`1e2e15a`）/ `rgt5` | **バックエンドは Golden のまま**。フロントで、届いたイベントの処理をアバターの表示まで保留する | 挨拶の冒頭から口が止まらない。会話中の止まり方は T1 と同等 → **合格** |

#### この期間の事故

| 日時 | 出来事 | 対処 |
|---|---|---|
| 10-28 22:56 | **PR #107**（実験ブランチ `exp/resume-gate` → 本番）が merge され、本番のページが検証用の `rgt2`（404）を指して壊れる | 23:00 PR #109 で取り消し |
| 10-29 16:02 | **PR #108**（実験ブランチ `exp/resume-gate-t1` → 本番）が merge され、本番が `rgt1` を指して壊れる | 16:07 PR #110 で取り消し |
| 10-29〜10-30 | PR #113、PR #115（実験ブランチ `exp/playback-hold` → 本番）が作られる。中身はすでに PR #112 / #114 で本番に入っており、残りは検証用の変更（接続先の tag、CORS）だけだった | merge せずに閉じた |

どの場合も、traffic は `00029-6cz` 100% のままで、バックエンドへの影響はなかった。

### 2.3 10-29〜10-30：本番へ

| 日時 | 出来事 |
|---|---|
| 10-29 | `exp/playback-hold` で、ソフトリセット（タイトルのクリック、120 秒以上のバックグラウンドからの復帰）も二重リセットにした（`c611a38`）。Preview でユーザーが確認 |
| 10-29 23:51 | **PR #112 を merge**（起動時の再生保留 + ソフトリセットの二重リセット）。Vercel のみデプロイ、Cloud Run は動かず |
| 10-30 | 本番で「ソフトリセット後は毎回止まる」。新しい版のログ（二重リセット）でも、ソフトリセット後の挨拶で約 0.48 秒と約 1.33 秒止まっていた |
| 10-30 | ソフトリセット後にも保留を効かせる（`4c3b85d`）。Preview でユーザーが確認 |
| 10-30 02:38 | **PR #114 を merge**。Vercel のみデプロイ、Cloud Run は動かず |

#### 本番確認で起きた混乱：古い版がブラウザに残っていた

本番の確認中に、ユーザーの PC で**古い版のプログラムが動いていた**ログが 2 回あった。

- ログのファイル名（`hoisted.Cg-Lx0C6.js`、`lam-websocket-manager.Cd5ZnRVq.js`）は、本番サーバーに問い合わせると **404** だった。サーバーからではなく、ブラウザ側（Service Worker のキャッシュ）から読み込まれていたと考えられる（推測）。
- ログには、10-25 に入って同日取り消した PR #102 のコード（`[LegacyAvatarInstallCleanup]`）が出ていて、`[PlaybackHold]` は出ていなかった。
- Vercel のデプロイ画面は、正しい版（`b0a8ea3`）を表示していた。

**本番で確認する時は、まずログで版を確かめる（§3.5）。**

---

## 3. 本番の仕組み（PR #112 + #114）

### 3.1 用語

| 用語 | 意味 |
|---|---|
| G1 | 二重リセットの 1 回目の `live_start` で作られる `LiveAPISession` |
| G2 | 2 回目の `live_start` で作られる `LiveAPISession`。`greeted_client_sids` により `session_count=1` となり、`run()` で再接続扱いの分岐に入る。最初の入力は `send_realtime_input(text="続きをお願いします")` |
| 保留 | フロントで、受け取ったイベントの処理を後回しにして溜めておくこと |

### 3.2 ページを開いた時

1. `core-controller.ts` の `init()` が、Golden どおり `resetAppContent()` を 2 回呼ぶ（二重リセット）。
2. 同時に、フロントは保留の状態から始まる（`startupPlaybackHold = true`）。
3. 届いた次のイベントは、`isLiveMode` の判定を到着時に行い、受け付けたものの処理だけを到着順に溜める。
   - `live_audio`、`live_expression`、`live_expression_reset`、`ai_transcript`、`turn_complete`、`interrupted`
   - 状態系のイベント（`live_stopped`、`live_ready`、`greeting_done`、`live_reconnecting`、`live_reconnected` など）は保留しない。
4. リセットでセッションが終了した時点（`terminateLiveSession()`）で溜まっていた分は捨てる。Golden ではその時点で再生ごと消えていたものだから。
5. `LAMAvatar連携完了` の後、`[AVATAR] visible`（AVATAR_VISIBLE）を受けたら保留を解除し、溜めた処理を同じ順に流す。3D アバターの初期化に失敗した場合（静止画表示）や、アバターのコントローラが無い場合は、その時点で解除する。
6. 解除した時点で最初の `playPcmAudio()` が走り、`firstChunkStartTime` が決まる。それまでに届いた表情データはすべてバッファに入っているので、挨拶の冒頭から表情データが音声より先にそろっている。

AVATAR_VISIBLE の判定は PR #100 のものを移植した（`lam-websocket-manager.ts`）。

- 最初の有効な描画を検知（`[AVATAR] first_valid_frame_rendered`）した後、有効な geometry での `viewer.render()` が 1 回以上終わったら `[AVATAR] visible`。
- `SceneRevealMode.Instant` で、アバターは一度に表示される。
- アバター用の読み込み中表示は、AVATAR_VISIBLE で消す。

### 3.3 ソフトリセット（タイトルのクリック、120 秒以上のバックグラウンドからの復帰）

1. 保留を再開する（`beginSoftResetPlaybackHold()`）。起動時の保留がまだ解除されていない場合は、起動時の解除条件のまま何もしない。
2. ページを開いた時と同じく、`resetAppContent()` を 2 回続けて呼ぶ（二重リセット）。
3. 2 回のリセットが終わってから、解除の条件を有効にする（`armSoftResetPlaybackRelease()`）。1 回目のセッションの残りのデータで、早く解除されないようにするため。
4. 解除の条件：最初の 0.1 秒分（chunk 0）の**次の表情データ（chunk 1 以降）が届いた時点**。それより先に `turn_complete` や `interrupted` が来た場合は、その時点で解除する。固定の待ち時間は使わない。

### 3.4 変更したファイル

| ファイル | 内容 |
|---|---|
| `src/scripts/chat/core-controller.ts` | 保留と解除、ソフトリセットの二重リセットと保留 |
| `src/scripts/chat/lesson-controller.ts`、`concierge-controller.ts` | AVATAR_VISIBLE（または失敗）で起動時の保留を解除 |
| `src/scripts/chat/lam-websocket-manager.ts`、`src/components/LAMAvatar.astro` | PR #100 のアバター表示判定 |

変更していないもの：`support-base/**`、`live-audio-manager.ts`、`audio-sync-player.ts`、A2E、PR #104 の DPR=1.0。

### 3.5 ログで確かめること

| 場面 | 出るログ |
|---|---|
| ページを開いた時 | `[PlaybackHold] hold 開始` → `[AVATAR] visible` → `[PlaybackHold] release … events=N` |
| ソフトリセット | `[Reset] Starting soft reset...` が 2 回、`[PlaybackHold] ソフトリセットで保留を再開`、`[PlaybackHold] ソフトリセット後の解除条件を有効化`、`[PlaybackHold] release … events=N` |
| 古い版が動いている時 | 上のログが出ない。タイトルのクリックで `[Reset] Starting soft reset...` が 1 回だけ |

古い版が動いている場合は、DevTools の「Application」→「Storage」→「Clear site data」と、「Service Workers」の「Unregister」の後に開き直す。

### 3.6 分かっている注意点

- **保留が解除されない場合：** 時間切れの自動解除は入れていない（フォールバック禁止）。起動時に、アバターが表示されず、失敗の判定にもならない場合は、挨拶が流れない。ソフトリセット後に、chunk 1 も `turn_complete` も届かない場合も同じ。
- **1 回目のセッションの残り：** 二重リセットの後に、1 回目のセッションの音声が遅れて届いた場合、それも保留に入り、解除の時に一緒に流れる。Golden でも、2 回目のリセットの後に G1 の音声が数個届いて再生されている。
- **保留中のマイク：** スプラッシュ画面は 2 秒で消えるので、アバターの表示前にマイクを押せる。その時点では `isAiSpeaking` が false なので、挨拶の再生前にマイクの音声が送られる可能性がある。対策は入れていない。
- **スマホ：** 未確認。

---

## 4. 二重リセットについて

### 4.1 経緯

| 日付 | 出来事 |
|---|---|
| 2026-04-03 | Chatty-sp で、`requirements.txt` の完全固定と `init()` のソフトリセット経由（二重リセット）を入れて改善 |
| 2026-04-04 | Travel-sp で、`requirements.txt` の完全固定だけでは改善せず、二重リセットを追加して改善（旧 `docs/21`） |
| 2026-10-24 | PR #92 / #93 で二重リセットを撤去して初回 Live を 1 本化 → 初期挨拶が約 22 秒待ち → PR #94 で戻す |
| 2026-10-25 | PR #100（G2 を final 扱いにし、`send_client_content` で始める構成など）→ 口の動きの質が低下 → PR #101 で撤回 |
| 2026-10-27〜10-29 | G2 の開始を遅らせる案（PR #105・案A・案1・案3）がすべて劣化 |
| 2026-10-30 | ソフトリセット（リセット 1 回）の後、毎回止まることを確認。二重リセット + 保留で解消（ユーザー確認） |

旧 `docs/21` の「原因2」の説明（アバターの初期化前に表情データが届くため）は誤り（ユーザー確認）。その対策をしても改善しなかった。また二重リセットは、起動直後だけでなく、その後の会話全体（数分〜数十分）のリップシンクの品質に効いていた。

### 4.2 コード上の事実（Golden）

- G2 は `greeted_client_sids` により `session_count=1` となり、再接続扱いの分岐に入る（`app_customer_support.py`、`live_api_handler.py` の `run()`）。G2 は新しいオブジェクトなので、会話履歴は空。最初の入力は `send_realtime_input(text="続きをお願いします")` だけ。
- G1 は `send_client_content(ダミーの挨拶依頼, turn_complete=True)` で始まる。
- `stop()` はフラグを下ろすだけで、`run()` は開始直後にそのフラグを立て直す。
- フロントは、イベントをセッションごとに区別せずに受け付ける。
- 表情データ（A2E）をバックエンドが送り出すきっかけは次の 4 つ（`live_api_handler.py`）。
  1. ターンの最初の 0.1 秒分（`A2E_FIRST_FLUSH_BYTES = 4800`）
  2. `output_transcription` に句読点（。？！?!、，,）が来てから 250ms 後
  3. 5 秒分（`A2E_AUTO_FLUSH_BYTES = 240000`）が溜まった時
  4. `turn_complete` の時（送信完了を待ってから `turn_complete` を送る）
- 口のフレームは、`firstChunkStartTime` からの経過時間 × 30fps で選ばれる。手元のフレームを使い切ると、最後のフレームのまま止まる（`live-audio-manager.ts` の `getCurrentExpressionFrame()`）。

### 4.3 今回の検証で否定・確認されたこと

**否定されたもの**

| 仮説 | 否定の根拠 |
|---|---|
| G2 が Gemini に接続してから最初の入力までの空き時間が原因 | 案1・案3 は、この空き時間を Golden と同じにしたのに劣化した |
| G1 停止から G2 の最初の入力までの間隔が長いことが共通原因 | PR #105 は、この間隔が Golden どおりなのに劣化した |
| G1 の残りの `turn_complete` が、表情データのバッファをリセットする | 案1・案3 のログで、ターンの途中のリセットは起きていない |
| ビルド方法や検証経路が原因 | T1 は同じ方法で本番と同等。PR #105 は本番のバックエンドのままで劣化した |

**十分条件としては否定されたもの**

- G2 を再接続扱いで始め、最初の入力を `send_realtime_input` にすること。案A・案1・案3 はこれを守ったうえで劣化した。必要な条件としては否定されていない（PR #100 と、二重リセット導入前の劣化は、これで説明できる）。

**確認されたこと**

- 劣化した 4 つ（PR #105・案A・案1・案3）は、すべて **Gemini 側の挨拶の生成の開始を、アバターの準備の後へ遅らせた**ものだった。Golden と T1 では、G2 の最初の入力は、アバターのロードが終わる前に送られている。
- **生成の開始を Golden のまま保ち、再生だけを遅らせる**と、劣化しなかった（`exp/playback-hold`）。「生成の開始を遅らせる」ことと「再生の開始を遅らせる」ことは、別の操作として扱う必要がある（ChatGPT の分析と一致）。
- 劣化は、挨拶だけでなく 2 ターン目以降も続く。セッションを始めた時点の何かが、その後も影響し続けている。
- 案3 の挨拶では、chunk 1 の後、3.87 秒分（116 フレーム、185,600 バイト）の音声が溜まるまで、表情データが送り出されなかった。5 秒分には届いていないので自動の送り出しではなく、`turn_complete` の約 2 秒前に届いているので `turn_complete` の時の送り出しでもない。コード上、残るきっかけは句読点による送り出しだけ。
- ソフトリセット（リセット 1 回、保留なし）の後は、3 回とも挨拶の話し始めの約 0.5〜0.7 秒、口が音声に付いていけなかった。表情データが 0.2〜0.3 秒届かず、最初の 0.17〜0.33 秒分を使い切った後、次が届くまで約 0.3〜0.4 秒止まる、という形が毎回同じだった。

### 4.4 未解明のまま残っているもの

- 二重リセットが何を正常化しているのか。逆に、何がリップシンクを壊していて、二重リセットがそれを隠しているのか。
- 生成の開始を遅らせると劣化する仕組み。劣化した 4 つに共通する条件として、次の 2 つが残っているが、区別できていない。
  - (a) G2 の挨拶の生成が、アバターの描画が動いている状態で始まる（フロント側から見た条件）
  - (b) G2 の最初の入力が、ソケット接続の数秒後になる（バックエンド側から見た条件）
  - 症状（表情データが遅れて届く）はバックエンドの送り出しで決まるので、(a) が正しい場合、フロントの状態がどう影響するのかは説明できていない。
- 同じソースなのに、4 月のビルドと再ビルドで動作が違う理由（§5.1）。
- ソフトリセット後の改善が、二重リセットと保留のどちらによるものか。二重リセットだけの版（PR #112）のログは 1 回分だけで、約 0.48 秒と約 1.33 秒止まっていた。

### 4.5 今後の改善で守ること

- 二重リセットは外さない。G1・G2 の開始と停止のタイミング、G2 を再接続扱いで始めること、最初の入力が `send_realtime_input` であることを、Golden のまま保つ。
- Gemini 側の生成の開始を、アバターの準備の後へ遅らせない。表示を待つ必要がある時は、フロントで再生だけを遅らせる。
- 評価は、初期挨拶だけでなく、2 ターン目以降の会話、ソフトリセット後、スマホの実機でも行う。

---

## 5. 運用上の注意（旧 `docs/21` 原因1 から引き継ぎ、今回の経験を追加）

### 5.1 再ビルドでリップシンクが壊れることがある

- コードを変えていなくても、Cloud Run の再ビルドでリップシンクが壊れることがある。2026-04 に `requirements.txt` を全依存固定にした（`pip freeze`。手順は旧 `docs/21` 原因1）が、`Dockerfile` の `FROM python:3.11-slim` は版数を固定していない。
- 2026-10-25 に、4 月と同じソースを再ビルドした revision（`00034-2ss`）では音声が途切れ、4 月のビルド済みイメージ（digest `df982977…`）の revision `00029-6cz` に traffic を戻して回復した。00029 と 00034 の環境変数と設定は同一で、違いはイメージだけだった。原因は特定していない。
- **障害時は、Git revert + 再ビルドではなく、正常だった旧 revision に traffic を戻す。**

### 5.2 検証用 revision の作り方（本番に流さない）

```bash
SVC=travel-sp-base; REGION=us-central1; PROJECT=ai-avator-492205
IMG=us-central1-docker.pkg.dev/$PROJECT/travel-sp-base/travel-sp-base
BASE=$IMG@sha256:df982977bb69aca0e89cfe7c6619e46696eaf6e2197936e3e280cf6ed31c9046
SHA=<検証するコミット>
mkdir -p ~/rg-x && cd ~/rg-x
for f in live_api_handler.py app_customer_support.py; do
  curl -fsSL -o $f https://raw.githubusercontent.com/mirai-gpro/Travel-sp/$SHA/support-base/$f
done
printf 'FROM %s\nCOPY live_api_handler.py app_customer_support.py /app/\n' "$BASE" > Dockerfile
gcloud builds submit --tag=$IMG:exp-<tag> --project=$PROJECT . && \
gcloud run deploy $SVC --image=$IMG:exp-<tag> --region=$REGION --project=$PROJECT --no-traffic --tag=<tag>
gcloud run services describe $SVC --region=$REGION --project=$PROJECT --format='yaml(status.traffic)'
```

- Cloud Shell からの `docker push` は `connection refused` で失敗したので、Cloud Build を使う。
- tag 名は 3 文字以上（`t0` は失敗した）。
- CORS（`app_customer_support.py` の `allowed_origins`）は固定のリスト。Preview の URL を加えないと、検証用 revision につながらない。
- 停止していた検証用 revision は、初回の応答に数十秒〜1 分以上かかる。テストの前に起動しておく。

### 5.3 やってはいけないこと

- `gcloud run services update-traffic … --to-latest` を実行しない。最新の revision は検証用のイメージである場合がある。
- 実験ブランチ（`exp/*`）から本番ブランチへの PR を作らない・merge しない（PR #107、#108 で本番が 2 回壊れた。PR #113、#115 は閉じた）。GitHub で実験ブランチへ push した直後に出る「Compare & pull request」から PR を作らない。
- 本番へ入れる時は、本番ブランチから新しいブランチを作り、検証用の変更（接続先の tag URL、CORS）を除いたものだけを PR にする。
- `support-base/**` が変わる PR を本番ブランチへ merge すると、Cloud Run のデプロイが動き、新しいビルドの revision に traffic が流れる（workflow に `--no-traffic` は無い）。バックエンドを変える時は、ユーザーの判断を先に得る。

### 5.4 2026-10-30 時点で残っているもの

- 検証用の Cloud Run tag：`rgt1`、`rgt3`、`rgt4`、`rgt5`（traffic 0%）
- 実験ブランチ：`exp/resume-gate`、`exp/resume-gate-t1`、`exp/connect-gate`、`exp/visible-gate` など。`exp/playback-hold` は GitHub の画面からの削除を依頼済み（作業環境からは削除できなかった）
