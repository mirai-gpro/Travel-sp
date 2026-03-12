# Gemini LiveAPI 移植設計書 v3（gourmet-sp3）

> **作成日**: 2026-03-11
> **前版**: `docs/02_liveapi_migration_design_v2.md`（v2: 2026-03-11）
> **前提文書**: `docs/01_stt_stream_detailed_spec.md`, `docs/03_prompt_modification_spec.md`
> **成功事例**: `docs/stt_stream.py`（インタビューモードの再接続方式）
> **移植元安定版**: `github.com/mirai-gpro/gourmet-support`（REST版）
> **v3変更理由**: コンシェルジュモードの短期記憶がLiveAPI再接続時に失われる問題の対策

---

## v2 → v3 変更概要

| 項目 | v2（旧） | v3（新） |
|---|---|---|
| 再接続時のコンテキスト | チャットログの断片を要約テキストとして注入 | **構造化された条件状態 + 会話履歴の`send_client_content()`再送** |
| 短期記憶の管理 | なし（Geminiのセッション内記憶に依存） | **サーバー側で`short_term_memory`として構造化管理** |
| ヒアリング進捗の追跡 | なし | **`hearing_step`（1〜4）で現在のステップを追跡** |
| `_get_context_summary()` | `"user: xxx\nai: xxx"` 形式のテキスト断片 | **確定済み/未確認条件の構造化テキスト + 禁止事項** |
| 再接続時の`send_client_content()` | `"続きをお願いします"` のみ | **会話履歴turnsの再送 + トリガーメッセージ** |
| `LIVEAPI_CONCIERGE_SYSTEM` | 短期記憶ルールなし | **短期記憶の注入指示を追加**（03_prompt_modification_spec.md準拠で最小限） |

### v3変更の背景

**REST版（gourmet-support）で短期記憶が機能していた理由:**
```
REST: 毎回 system_prompt（concierge_ja.txt全文）+ 全会話履歴 → Gemini REST API
→ Geminiは全ターンを見て「何が確定済みか」を自然に把握できた
→ 短期記憶は会話履歴の全量送信により「無料で」成立していた
```

**LiveAPI版で壊れた理由:**
```
LiveAPI: セッション内はGeminiが記憶保持 → だが再接続で全消失
→ 再接続時に「user: 接待で... ai: 承知しました...」の断片しか渡していない
→ Geminiは「何が確定済みで何が未確認か」を構造的に把握できない
→ ステップ1に戻って同じ質問を繰り返す → 検索に辿りつけない
```

**v3の解決方針:**
```
LiveAPI v3: サーバー側で条件を構造化管理（short_term_memory）
→ 再接続時に「確定済み条件」「未確認条件」「次のステップ」を明示的に注入
→ さらにsend_client_content()で会話履歴turnsも再送
→ REST版と同等の情報量をGeminiに渡す
```

---

## 0. Claudeへの厳守事項（v1から継続）

### 防止ルール

1. **修正する前に、必ず `01_stt_stream_detailed_spec.md` の該当セクションを `Read` ツールで読む**
2. **「確認しました」と報告する場合、確認したファイルパスと行番号を明記する**
3. **仕様書に記載がない機能を追加しない**
4. **推測で API の引数やメソッド名を変えない**
5. **困ったらユーザーに聞く。推測で進めない**
6. **間違えたら戻る。修正を重ねない。`git checkout`で最後の正常状態に戻してからやり直す** ← v3追加
7. **診断ログを入れて→ログを見て→推測で修正、のサイクルは禁止** ← v3追加

---

## 1. 移植のスコープ（v3改訂）

### 1.1 やること

| # | 内容 | 優先度 | v3変更 |
|---|---|---|---|
| 1 | バックエンド: LiveAPI WebSocketプロキシの新設 | 必須 | 変更なし |
| 2 | フロントエンド: LiveAudioManager の実装 | 必須 | 変更なし |
| 3 | LiveAPI → REST API フォールバック機構 | 必須 | 変更なし |
| 4 | セッション再接続メカニズム | 必須 | 変更なし |
| 5 | トランスクリプション（文字起こし）表示 | 必須 | 変更なし |
| 6 | ショップ説明のLiveAPI読み上げ（1軒ごとに再接続） | 必須 | 変更なし |
| 7 | **短期記憶の構造化管理（コンシェルジュモード）** | **必須** | **v3新規** |
| 8 | **再接続時の会話履歴再送** | **必須** | **v3新規** |

### 1.2 やらないこと（v2から変更なし）

- ショップ説明用のREST TTS呼び出しは廃止
- `/api/chat` エンドポイント自体はショップデータ取得用に残す（音声生成はしない）
- `/api/tts/synthesize` はフォールバック時のみ使用
- PyAudio関連の移植

---

## 2. 全体アーキテクチャ（v2から変更なし）

v2のセクション2をそのまま維持。

---

## 3. バックエンド設計（v3改訂：短期記憶追加）

### 3.1 LiveAPISession クラスの拡張（v3新規）

#### 3.1.1 短期記憶データ構造

```python
class LiveAPISession:
    def __init__(self, session_id, mode, language,
                 system_prompt, socketio, client_sid):
        # ... 既存の初期化（v2と同じ）...

        # ===== v3新規: 短期記憶（コンシェルジュモード用） =====
        self.short_term_memory = {
            'area': None,         # エリア（例: "六本木"）
            'purpose': None,      # 利用目的（例: "接待"）
            'cuisine': None,      # 料理ジャンル（例: "和食"）
            'atmosphere': None,   # 雰囲気（例: "落ち着いた"）
            'party_size': None,   # 人数（例: "4名"）
            'budget': None,       # 予算（例: "1万円程度"）
            'date': None,         # 日時（例: "来週金曜"）
        }
        self.hearing_step = 1     # ヒアリングステップ（1〜4、5=全条件確定）
        # concierge_ja.txt のステップ定義:
        #   1: 場所・目的
        #   2: ジャンル・雰囲気・人数
        #   3: 予算
        #   4: 日程
        #   5: 全条件確定 → 検索可能
```

**設計根拠:**
- REST版（gourmet-support）では `concierge_ja.txt` の【初回ヒアリングの必須フロー】で定義されたステップ1〜4を、Geminiが会話履歴全量から自然に追跡していた
- LiveAPIでは再接続で会話履歴が消えるため、サーバー側で明示的に追跡する必要がある
- `short_term_memory` の各フィールドは `concierge_ja.txt` の【短期記憶・セッション行動ルール】セクションの「記憶対象となる情報」に対応

#### 3.1.2 短期記憶の更新（ターン完了時）

```python
def _update_short_term_memory(self, user_text: str, ai_text: str):
    """
    ターン完了時に呼ばれる。ユーザー発言から条件をキーワードベースで抽出。

    【設計方針】
    - LLM呼び出しは行わない（レイテンシ回避）
    - キーワードマッチによる簡易抽出
    - 拾えない条件は会話履歴の再送で補完される（3.2.2参照）
    - ユーザーが明示的に言った条件のみ記録。推測しない。
    """
    if not user_text:
        return

    import re

    # ---- エリア検出 ----
    area_keywords = [
        '六本木', '渋谷', '新宿', '銀座', '恵比寿', '池袋',
        '表参道', '赤坂', '麻布', '品川', '東京駅', '丸の内',
        '目黒', '中目黒', '代官山', '自由が丘', '吉祥寺',
        '横浜', '新橋', '浜松町', '五反田', '大崎', '田町',
        '上野', '秋葉原', '神田', '日本橋', '八重洲',
        '大阪', '梅田', '難波', '心斎橋', '京都', '神戸',
        '名古屋', '栄', '福岡', '天神', '博多', '札幌',
    ]
    for area in area_keywords:
        if area in user_text:
            self.short_term_memory['area'] = area
            break

    # ---- 利用目的検出 ----
    purpose_map = {
        '接待': '接待', 'デート': 'デート', '女子会': '女子会',
        '忘年会': '忘年会', '新年会': '新年会', '歓迎会': '歓迎会',
        '送別会': '送別会', '家族': '家族利用', '記念日': '記念日',
        '誕生日': '誕生日', '会食': '会食', '飲み会': '飲み会',
        '合コン': '合コン', '同窓会': '同窓会', 'ランチ': 'ランチ',
        '食事会': '食事会', '打ち上げ': '打ち上げ',
    }
    for kw, purpose in purpose_map.items():
        if kw in user_text:
            self.short_term_memory['purpose'] = purpose
            break

    # ---- 料理ジャンル検出 ----
    cuisine_map = {
        '和食': '和食', '洋食': '洋食', 'イタリアン': 'イタリアン',
        'フレンチ': 'フレンチ', '中華': '中華', '焼肉': '焼肉',
        '寿司': '寿司', '鮨': '寿司', '焼き鳥': '焼き鳥',
        'ラーメン': 'ラーメン', 'カフェ': 'カフェ',
        '居酒屋': '居酒屋', '韓国料理': '韓国料理',
        'タイ料理': 'タイ料理', 'インド料理': 'インド料理',
        'スペイン料理': 'スペイン料理', '鉄板焼': '鉄板焼',
        'しゃぶしゃぶ': 'しゃぶしゃぶ', 'すき焼き': 'すき焼き',
        '天ぷら': '天ぷら', 'うなぎ': 'うなぎ', 'そば': 'そば',
    }
    for kw, cuisine in cuisine_map.items():
        if kw in user_text:
            self.short_term_memory['cuisine'] = cuisine
            break

    # ---- 人数検出 ----
    party_match = re.search(r'(\d+)\s*[人名]', user_text)
    if party_match:
        self.short_term_memory['party_size'] = f"{party_match.group(1)}名"
    else:
        num_words = {
            '二人': '2名', 'ふたり': '2名', '2人': '2名',
            '三人': '3名', '四人': '4名', '五人': '5名',
        }
        for kw, size in num_words.items():
            if kw in user_text:
                self.short_term_memory['party_size'] = size
                break

    # ---- 雰囲気検出 ----
    atmo_map = {
        '落ち着い': '落ち着いた雰囲気', '静か': '静かな雰囲気',
        'カジュアル': 'カジュアル', '高級': '高級感',
        '個室': '個室希望', 'おしゃれ': 'おしゃれ',
        '賑やか': '賑やかな雰囲気', 'アットホーム': 'アットホーム',
        '隠れ家': '隠れ家的', 'モダン': 'モダン',
    }
    for kw, atmo in atmo_map.items():
        if kw in user_text:
            self.short_term_memory['atmosphere'] = atmo
            break

    # ---- 予算検出 ----
    # 「5000円」「五千円」「1万円」等
    budget_match = re.search(r'(\d[\d,]*)\s*円', user_text)
    if budget_match:
        self.short_term_memory['budget'] = budget_match.group(0)
    else:
        man_match = re.search(r'(\d+)\s*万', user_text)
        if man_match:
            self.short_term_memory['budget'] = f"{man_match.group(1)}万円程度"

    # ---- 日時検出 ----
    date_patterns = [
        '今日', '明日', '明後日', '今週', '来週', '再来週',
        '今月', '来月', '月曜', '火曜', '水曜', '木曜',
        '金曜', '土曜', '日曜', '週末', '祝日',
    ]
    for pattern in date_patterns:
        if pattern in user_text:
            self.short_term_memory['date'] = user_text  # 日時は文脈が重要なので発言全体を保持
            break
    # 「○月○日」「○/○」パターン
    if not self.short_term_memory['date']:
        date_match = re.search(r'\d+[月/]\d+', user_text)
        if date_match:
            self.short_term_memory['date'] = date_match.group(0)

    # ---- ヒアリングステップの自動更新 ----
    self._update_hearing_step()

    logger.info(f"[ShortTermMemory] step={self.hearing_step}, "
                f"conditions={self._get_confirmed_conditions()}")
```

#### 3.1.3 ヒアリングステップの自動更新

```python
def _update_hearing_step(self):
    """
    確定条件に基づいてヒアリングステップを更新。

    concierge_ja.txt のヒアリングフローに対応:
      ステップ1: 場所・目的
      ステップ2: ジャンル・雰囲気・人数
      ステップ3: 予算
      ステップ4: 日程
      ステップ5: 全条件確定
    """
    m = self.short_term_memory

    # ステップ1: 場所 or 目的が1つでもあれば次へ
    if not m['area'] and not m['purpose']:
        self.hearing_step = 1
        return

    # ステップ2: ジャンル or 人数があれば次へ
    if not m['cuisine'] and not m['party_size']:
        self.hearing_step = 2
        return

    # ステップ3: 予算
    if not m['budget']:
        self.hearing_step = 3
        return

    # ステップ4: 日時（省略可能 — ユーザーが言わなくてもAIが検索を促してよい）
    if not m['date']:
        self.hearing_step = 4
        return

    self.hearing_step = 5

def _get_confirmed_conditions(self) -> dict:
    """確定済み条件のみを返す（ログ・デバッグ用）"""
    return {k: v for k, v in self.short_term_memory.items() if v}
```

#### 3.1.4 _process_turn_complete() の修正

```python
def _process_turn_complete(self):
    """
    ターン完了時の処理（v3改訂: 短期記憶更新を追加）
    """
    user_text = ""
    if self.user_transcript_buffer.strip():
        user_text = self.user_transcript_buffer.strip()
        logger.info(f"[LiveAPI] ユーザー: {user_text}")
        self._add_to_history("user", user_text)
        self.user_transcript_buffer = ""

    if self.ai_transcript_buffer.strip():
        ai_text = self.ai_transcript_buffer.strip()
        logger.info(f"[LiveAPI] AI: {ai_text}")
        self._add_to_history("ai", ai_text)

        # ★ v3新規: 短期記憶を更新（コンシェルジュモードのみ）
        if self.mode == 'concierge':
            self._update_short_term_memory(user_text, ai_text)

        # ショップ検索トリガー検知（v2と同じ）
        if should_trigger_shop_search(ai_text):
            user_request = self._build_search_request(user_text)
            logger.info(f"[LiveAPI] ショップ検索トリガー: '{user_request}'")
            self.socketio.emit('shop_search_trigger', {
                'user_request': user_request,
                'session_id': self.session_id,
                'language': self.language,
                'mode': self.mode
            }, room=self.client_sid)
        else:
            logger.debug(f"[LiveAPI] トリガー未検知: '{ai_text[:50]}'")

        # 発言途切れチェック・文字数カウント・再接続判定（v2と同じ）
        is_incomplete = self._is_speech_incomplete(ai_text)
        char_count = len(ai_text)
        self.ai_char_count += char_count
        remaining = MAX_AI_CHARS_BEFORE_RECONNECT - self.ai_char_count
        logger.info(f"[LiveAPI] 累積: {self.ai_char_count}文字 / 残り: {remaining}文字")

        self.ai_transcript_buffer = ""

        if is_incomplete:
            logger.info("[LiveAPI] 発言途切れのため再接続")
            self.needs_reconnect = True
        elif char_count >= LONG_SPEECH_THRESHOLD:
            logger.info(f"[LiveAPI] 長い発話({char_count}文字)のため再接続")
            self.needs_reconnect = True
        elif self.ai_char_count >= MAX_AI_CHARS_BEFORE_RECONNECT:
            logger.info("[LiveAPI] 累積制限到達のため再接続")
            self.needs_reconnect = True
```

### 3.2 再接続時のコンテキスト復元（v3全面改訂）

REST版では毎回全会話履歴をGemini APIに送信していた。
v3ではそれと同等の情報量を、以下の2つの手段で復元する:

1. **`_get_context_summary()`** → システムプロンプトに構造化された条件状態を注入
2. **`send_client_content()`** → 会話履歴turnsを再送

#### 3.2.1 _get_context_summary()（v3全面改訂）

```python
def _get_context_summary(self) -> str:
    """
    再接続時のコンテキスト注入。

    【v3変更点】
    v2: チャットログの断片（"user: xxx\nai: xxx"）
    v3: 構造化された条件状態 + ヒアリングステップ + 禁止事項

    【設計根拠】
    REST版では concierge_ja.txt の【短期記憶・セッション行動ルール】に
    「一度確定した情報は有効」「聞き直し禁止」と明記されていた。
    LiveAPIでは再接続でGeminiが全てを忘れるため、
    この「何が確定済みか」を明示的に伝える必要がある。
    """
    parts = []

    # ===== 1. 短期記憶（コンシェルジュモードのみ） =====
    if self.mode == 'concierge' and any(self.short_term_memory.values()):
        condition_labels = {
            'area': 'エリア',
            'purpose': '利用目的',
            'cuisine': '料理ジャンル',
            'atmosphere': '雰囲気',
            'party_size': '人数',
            'budget': '予算',
            'date': '日時',
        }

        confirmed = []
        unconfirmed = []

        for key, label in condition_labels.items():
            value = self.short_term_memory[key]
            if value:
                confirmed.append(f"  - {label}: {value}")
            else:
                unconfirmed.append(f"  - {label}: 未確認")

        parts.append("【ユーザーの確定済み条件（短期記憶）】")
        parts.append("以下は会話で既に確認済み。再度質問してはならない。")
        parts.extend(confirmed)

        if unconfirmed:
            parts.append("")
            parts.append("【未確認の条件】")
            parts.extend(unconfirmed)

        # ステップ指示
        step_instructions = {
            1: "まずエリアと利用目的を質問してください。",
            2: "料理ジャンル・雰囲気・人数を質問してください。",
            3: "予算を質問してください。",
            4: "日時を質問してください。なお日時はユーザーが言わなければ省略可。",
            5: "条件は十分です。「お探ししますね」と言って検索を開始してください。",
        }
        parts.append(f"\n【次のステップ】{step_instructions.get(self.hearing_step, '')}")

    # ===== 2. 直前の会話（最小限の参考情報） =====
    # send_client_content() で会話履歴turnsを別途再送するため、
    # ここでは最後のAI発言が質問だった場合のみ強調する
    if self.conversation_history:
        last_ai = None
        for h in reversed(self.conversation_history):
            if h['role'] == 'ai':
                last_ai = h['text']
                break

        if last_ai and ('?' in last_ai or '？' in last_ai
                        or 'ですか' in last_ai or 'ますか' in last_ai):
            parts.append(f"\n【直前のAIの質問（回答を待っています）】\n{last_ai[:200]}")

    return "\n".join(parts)
```

#### 3.2.2 再接続時の会話履歴再送（v3新規）

```python
async def _send_history_on_reconnect(self, session):
    """
    再接続時に会話履歴をsend_client_content()で再送する。

    【設計根拠】
    REST版では毎回全会話履歴をAPI引数として送信していた。
    LiveAPIのsend_client_content()のturnsパラメータで同等のことができる。
    これにより、Geminiは再接続後も直前の会話文脈を把握できる。

    【注意】
    - turnsは types.Content のリストとして送信
    - role は "user" または "model"（"ai"ではない）
    - 直近10ターン、各150文字までに制限（トークン消費抑制）
    """
    if not self.conversation_history:
        return

    recent = self.conversation_history[-10:]
    history_turns = []

    for h in recent:
        role = "user" if h['role'] == 'user' else "model"
        text = h['text'][:150]
        history_turns.append(
            types.Content(
                role=role,
                parts=[types.Part(text=text)]
            )
        )

    if history_turns:
        await session.send_client_content(
            turns=history_turns,
            turn_complete=False  # ★ まだターンは終わっていない
        )
        logger.info(f"[LiveAPI] 会話履歴 {len(history_turns)} ターン再送")
```

#### 3.2.3 run() の再接続フロー修正（v3改訂）

```python
async def run(self):
    """メインループ（v3改訂: 再接続時の履歴再送を追加）"""
    self.audio_queue_to_gemini = asyncio.Queue(maxsize=5)
    self.is_running = True

    try:
        while self.is_running:
            self.session_count += 1
            self.ai_char_count = 0
            self.needs_reconnect = False

            context = None
            if self.session_count > 1:
                context = self._get_context_summary()  # ★ v3: 構造化コンテキスト

            config = self._build_config(with_context=context)

            try:
                async with self.client.aio.live.connect(
                    model=LIVE_API_MODEL,
                    config=config
                ) as session:

                    if self.session_count == 1:
                        # 初回接続: ダミーメッセージで初期あいさつを発火（v2と同じ）
                        self._is_initial_greeting_phase = True
                        trigger_msgs = self.INITIAL_GREETING_TRIGGERS
                        mode_msgs = trigger_msgs.get(self.mode, trigger_msgs['chat'])
                        dummy_text = mode_msgs.get(self.language, mode_msgs['ja'])

                        await session.send_client_content(
                            turns=types.Content(
                                role="user",
                                parts=[types.Part(text=dummy_text)]
                            ),
                            turn_complete=True
                        )
                        logger.info(f"[LiveAPI] 初期あいさつトリガー送信: '{dummy_text}'")
                    else:
                        # ★ v3改訂: 再接続時に会話履歴を再送
                        self._is_initial_greeting_phase = False
                        self.socketio.emit('live_reconnecting', {},
                                           room=self.client_sid)

                        # 1. 会話履歴turnsを再送（turn_complete=False）
                        await self._send_history_on_reconnect(session)

                        # 2. トリガーメッセージ（turn_complete=True）
                        await session.send_client_content(
                            turns=types.Content(
                                role="user",
                                parts=[types.Part(text="続きをお願いします")]
                            ),
                            turn_complete=True
                        )
                        logger.info("[LiveAPI] 再接続: 履歴再送 + トリガー送信")
                        self.socketio.emit('live_reconnected', {},
                                           room=self.client_sid)

                    await self._session_loop(session)

                    if not self.needs_reconnect:
                        break

            except Exception as e:
                # エラーハンドリング（v2と同じ）
                error_msg = str(e).lower()
                if any(kw in error_msg for kw in
                       ["1011", "internal error", "disconnected",
                        "closed", "websocket"]):
                    logger.warning(f"[LiveAPI] 接続エラー、3秒後に再接続: {e}")
                    await asyncio.sleep(3)
                    self.needs_reconnect = True
                    continue
                else:
                    logger.error(f"[LiveAPI] 致命的エラー: {e}")
                    self.socketio.emit('live_fallback', {
                        'reason': str(e)
                    }, room=self.client_sid)
                    break

    except asyncio.CancelledError:
        pass
    finally:
        self.is_running = False
        logger.info(f"[LiveAPI] セッション終了: {self.session_id}")
```

### 3.3 プロンプトへの短期記憶指示追加（v3新規）

`03_prompt_modification_spec.md` に準拠し、`LIVEAPI_CONCIERGE_SYSTEM` への追加は最小限とする。

#### 3.3.1 追加する内容

```python
# live_api_handler.py の LIVEAPI_CONCIERGE_SYSTEM に以下を追加:

LIVEAPI_CONCIERGE_SYSTEM = """あなたはグルメコンシェルジュです。
高級レストランのコンシェルジュのように、丁寧にユーザーの好みを引き出してください。

## 役割
- 会話のキャッチボールを通じて、ユーザーの本当の希望を引き出す。
- 一方的に質問を並べるのではなく、ユーザーの回答に寄り添い、深掘りする。
- 条件が十分に揃ったら、「お探ししますね」と言って店舗検索を促す。

{user_context}

## 質問ルール（厳守）
- 1ターンの質問は最大3つまで。それ以上は絶対に聞かない。
- 理想は1ターン1質問。必要な場合のみ2-3に増やす。
- ユーザーが答えやすい順番で聞く（まず大枠、次に詳細）。

## 禁止事項
以下のように一度に大量の質問を並べることは禁止：
「料理のジャンルは？エリアは？人数は？目的は？予算は？雰囲気は？」
→ ユーザーは一度にこれだけの質問には答えられない。

## 正しい会話の進め方
2ターン目以降: ユーザーの回答に応じて自然に深掘りする。
例: 「接待ですね。和食と洋食、どちらがお好みですか？」
例: 「お二人でしたら、カウンターのお店も素敵ですよ。いかがですか？」

## 応答スタイル
- 丁寧語（です・ます調）を基本とする。
- 押しつけず、提案する姿勢。「いかがですか？」「よろしければ」を活用。
- ユーザーの発言を受け止めてから次に進む。「素敵ですね」「なるほど」等。

## 短期記憶ルール（v3追加・厳守）
- 再接続時、システムインストラクションに【ユーザーの確定済み条件】が注入される。
- 確定済み条件は既にユーザーが回答済み。再度質問してはならない。
- 確定済み条件を踏まえて、未確認の条件のみを質問する。
- 条件が十分に揃ったら「お探ししますね」と言って検索を促す。

{common_rules}
"""
```

#### 3.3.2 追加しないもの（意図的な除外）

`concierge_ja.txt` から以下は **LiveAPIプロンプトに含めない**:

| 項目 | 除外理由 |
|---|---|
| JSON出力形式（`{"message": ..., "shops": ...}`） | LiveAPIは音声出力。JSONは不要 |
| shops配列の構造定義 | 同上。ショップデータはREST APIで別途取得 |
| 長期記憶サマリー生成ルール | LiveAPIモードでは別途実装。プロンプトに含めると肥大化 |
| actionフィールド（名前変更等） | LiveAPIモードでの名前変更は音声で処理。JSON actionは不要 |
| 予算表記ルール（漢数字等） | LiveAPIは音声出力なのでGeminiが自然に処理 |

---

## 4. フロントエンド設計（v2から変更なし）

v2のセクション4をそのまま維持。
短期記憶はサーバー側で完結するため、フロントエンド変更は不要。

---

## 5. ショップ提案の処理フロー（v2から変更なし）

v2のセクション5をそのまま維持。

---

## 6. セッション管理（v3改訂）

### 6.1 LiveAPIセッションのライフサイクル（v3改訂）

```
[通常会話]
LiveAPIセッション#1 (初回接続・挨拶)
  ↓ 累積制限 or 発話途切れ
  ↓ ★ short_term_memory は保持される（サーバー側）
LiveAPIセッション#2 (再接続・構造化コンテキスト注入 + 履歴再送)
  ↓ ...
  ↓ ★ short_term_memory は累積更新される
LiveAPIセッション#N (会話中にショップ検索トリガー)
  ↓
[ショップ検索]
REST API でショップデータ取得 (JSONのみ)
  ↓
[ショップ説明]
LiveAPIセッション#N+1 (ショップ1説明)
  ↓ 再接続
LiveAPIセッション#N+2 (ショップ2説明)
  ↓ 再接続
LiveAPIセッション#N+3 (ショップ3説明)
  ↓ 再接続
[通常会話復帰]
LiveAPIセッション#N+4 (「気になるお店はありましたか？」)
  ↓ ★ short_term_memory はショップ検索後もリセットしない（追加検索対応）
```

### 6.2 セッション状態遷移（v2と同じ）

```python
class SessionState(Enum):
    CONVERSATION = "conversation"
    SHOP_SEARCHING = "shop_searching"
    SHOP_DESCRIBING = "shop_describing"
    RETURNING_TO_CHAT = "returning_to_chat"
```

### 6.3 短期記憶のライフサイクル（v3新規）

```
short_term_memory の状態遷移:

1. 初期化（全てNone） → LiveAPISession.__init__()
2. ターンごとに更新    → _update_short_term_memory() ※コンシェルジュモードのみ
3. 再接続時に注入      → _get_context_summary() → system_instruction に含める
4. ショップ検索後      → リセットしない（追加条件の変更検索に対応）
5. セッション終了      → LiveAPISession と共に破棄
```

**リセットしない理由:**
ユーザーが「別のエリアでも探して」と言った場合、既存条件を土台に
area だけ上書きして再検索できる。REST版（gourmet-support）でも
セッション内で条件は蓄積されていた。

---

## 7. 再接続メカニズム（v3改訂）

### 7.1 通常会話の再接続（v3改訂）

| # | 項目 | v2 | v3 |
|---|---|---|---|
| 1 | 再接続トリガー | 発言途切れ / 長い発話 / 累積上限 | **変更なし** |
| 2 | システムプロンプト注入 | チャットログ断片 | **構造化された条件状態**（3.2.1） |
| 3 | 会話履歴の再送 | なし | **send_client_content()でturns再送**（3.2.2） |
| 4 | トリガーメッセージ | `"続きをお願いします"` | **変更なし**（履歴再送の後に送信） |

**再接続時のデータフロー（v3）:**

```
                   system_instruction
                   ┌──────────────────────────────────────┐
                   │ LIVEAPI_CONCIERGE_SYSTEM              │
                   │ + 短期記憶ルール（v3追加）              │
                   │ + user_context（初期挨拶指示）          │
                   │ + LIVEAPI_COMMON_RULES                │
                   │                                        │
                   │ 【ユーザーの確定済み条件（短期記憶）】    │
                   │   - エリア: 六本木                      │
                   │   - 利用目的: 接待                      │
                   │ 以上は再度質問してはならない。            │
                   │                                        │
                   │ 【未確認の条件】                        │
                   │   - 料理ジャンル: 未確認                │
                   │   - 予算: 未確認                        │
                   │                                        │
                   │ 【次のステップ】                        │
                   │ 料理ジャンル・雰囲気・人数を質問。      │
                   └──────────────────────────────────────┘

                   send_client_content (turns)
                   ┌──────────────────────────────────────┐
                   │ user: "接待で使いたい"                  │
                   │ model: "どのエリアをお考えですか？"      │
                   │ user: "六本木で"                        │
                   │ model: "六本木ですね。ジャンルは？"      │
                   └──────────────────────────────────────┘

                   send_client_content (trigger)
                   ┌──────────────────────────────────────┐
                   │ user: "続きをお願いします"              │ turn_complete=True
                   └──────────────────────────────────────┘

→ Geminiは「六本木で接待、ジャンルを聞いている途中」と正確に把握できる
→ REST版と同等のコンテキストが復元される
```

### 7.2 ショップ説明の再接続（v2と同じ）

v2のセクション7.2をそのまま維持。

---

## 8. フォールバック戦略（v2から変更なし）

v2のセクション8をそのまま維持。

---

## 9. 実装フェーズ計画（v3改訂）

### Phase 1: 基盤構築（v1と同じ）
- LiveAPI接続 → 音声送受信 → ブラウザ再生の最小ループ確認

### Phase 2: トランスクリプション（v1と同じ）
- input/output_transcription → チャット欄表示

### Phase 2.5: 短期記憶（v3新規）

| # | 内容 | 詳細 |
|---|---|---|
| 1 | `short_term_memory` dict追加 | LiveAPISession.__init__() に追加 |
| 2 | `_update_short_term_memory()` 実装 | キーワードベースの条件抽出 |
| 3 | `_update_hearing_step()` 実装 | ステップ自動更新 |
| 4 | `_get_context_summary()` 全面改訂 | 構造化された条件状態の注入 |
| 5 | `_send_history_on_reconnect()` 実装 | send_client_content()で履歴再送 |
| 6 | `run()` の再接続フロー修正 | 履歴再送 → トリガー の2段階送信 |
| 7 | `LIVEAPI_CONCIERGE_SYSTEM` に短期記憶ルール追加 | 最小限の追加（03仕様書準拠） |

### Phase 3: ショップ説明のLiveAPI統一（v2と同じ）

v2のPhase 3をそのまま維持。

### Phase 4: 安定化（v3改訂）
- v2のPhase 4テスト項目に加え、以下を追加:
  - 短期記憶が再接続後も維持されるか
  - 同じ質問を繰り返さないか
  - 検索トリガーに正しく到達するか

### Phase 5: 最適化（v1と同じ）

---

## 10. 既知のリスク・未解決課題（v3改訂）

### 10.1 v1からの継続リスク（変更なし）
- LiveAPIプレビュー版の制約
- WebSocketの二重化
- async/syncの混在
- 音声再生の連続性

### 10.2 v2追加リスク（変更なし）

v2のセクション10.2をそのまま維持。

### 10.3 v3追加リスク

| リスク | 影響 | 対策 |
|---|---|---|
| キーワード抽出の網羅性不足 | 「表参道ヒルズ付近で」等、リストにないエリアを拾えない | 会話履歴のsend_client_content()再送で補完。Geminiが文脈から判断 |
| send_client_content()のturns再送がトークンを消費 | コンテキストウィンドウの圧迫 | 直近10ターン・各150文字に制限。context_window_compression(32000)も有効 |
| ユーザーが条件を暗示的に変更した場合 | 「やっぱり...」のニュアンスを拾えない | キーワードマッチは最後にマッチしたもので上書き。大きな変更はユーザーが明示する前提 |
| ステップの厳密な追跡が困難 | カジュアルな業態（ラーメン等）ではステップ2-4が不要 | concierge_ja.txtの業態別制御ルールに従い、cuisineが簡易業態ならstep=5に飛ばす（将来拡張） |

### 10.4 キーワード抽出 vs 会話履歴再送 の役割分担

```
キーワード抽出（short_term_memory）:
  ✅ 「何が確定済みか」を構造化して明示 → Geminiに「聞き直すな」と指示
  ✅ ヒアリングステップの自動追跡
  ❌ 網羅性は完璧ではない

会話履歴再送（send_client_content turns）:
  ✅ 会話の文脈を正確に復元 → Geminiが自分で判断できる
  ✅ キーワード抽出が拾えない情報も含まれる
  ❌ 「何が確定済みか」の構造的な指示にはならない

→ 両方を併用することで、REST版と同等の精度を実現する
```

---

## 11. テスト計画（v3改訂）

### 11.1〜11.2 v1と同じ

### 11.3 Phase 2.5 テスト項目（v3新規）

| # | テスト内容 | 期待結果 |
|---|---|---|
| 1 | コンシェルジュモードで「接待で六本木」と発言 | short_term_memory に purpose="接待", area="六本木" が記録される |
| 2 | 再接続が発生した後 | AIが「エリアは？」「目的は？」と聞き直さない |
| 3 | 再接続後にAIが次のステップの質問をする | ステップ2（ジャンル・雰囲気・人数）の質問が出る |
| 4 | 条件を段階的に伝える（3〜4ターン） | 各ターンでshort_term_memoryが累積更新される |
| 5 | 全条件確定後 | AIが「お探ししますね」と発言し、検索トリガーが発火する |
| 6 | 検索後に「別のエリアで」と言う | short_term_memory.area のみ上書きされ、他条件は維持 |
| 7 | chatモードでは短期記憶が動作しない | _update_short_term_memory()が呼ばれない |
| 8 | キーワードリストにないエリア名 | 会話履歴再送でGeminiが文脈から理解する（短期記憶にはNone） |

### 11.4 Phase 3 テスト項目（v2と同じ）

v2のセクション11.3をそのまま維持。

---

## 12. REST版（gourmet-support）との対応表（v3新規・参考資料）

LiveAPI移行で「何がどう変わったか」の対応表。
実装時に迷った場合の参照用。

| 機能 | REST版（gourmet-support） | LiveAPI版（gourmet-sp3 v3） |
|---|---|---|
| システムプロンプト | concierge_ja.txt（537行） | LIVEAPI_CONCIERGE_SYSTEM（短期記憶ルール含む） |
| 会話履歴の送信 | 毎回全履歴をGemini REST APIに送信 | send_client_content(turns)で再接続時に再送 |
| 短期記憶 | Geminiが全履歴から自然に把握 | サーバー側のshort_term_memoryで構造化管理 |
| ヒアリングステップ追跡 | Geminiが自然に追跡 | サーバー側のhearing_stepで明示的追跡 |
| 条件の重複質問防止 | concierge_ja.txt内のルールで制御 | 構造化コンテキスト注入 + プロンプトルール |
| セッション管理 | RAMベースのSupportSession | LiveAPISession + short_term_memory |
| 出力形式 | JSON（message + shops配列） | 音声（LiveAPI audio） |
| ショップ検索 | /api/chat が全て処理 | REST API(データ取得のみ) + LiveAPI(音声説明) |

---

*以上が LiveAPI 移植設計書 v3。v2との差分はセクション3（短期記憶）、セクション7（再接続メカニズム）が中心。
実装時は本設計書、`01_stt_stream_detailed_spec.md`、`03_prompt_modification_spec.md` を常に参照すること。*
