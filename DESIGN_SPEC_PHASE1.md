# フェーズ1 設計書: REST API → LiveAPI 移行 + アバター導入

## 🚨 原則7: AIの知識不足の宣言

**Gemini Live API は 2024年末〜2025年にリリースされた新技術であり、Claude (本AI) はこのAPIの実装詳細について信頼できる知識を持っていません。**

以下について、Claude の知識は **不十分または不正確** である可能性が高い:
- `google.genai.live` モジュールの正確なAPI仕様
- LiveConnect のセッション管理方法
- tool_call のハンドリング仕様
- 音声入出力のフォーマット仕様

**→ 実装時は必ず公式ドキュメントと stt_stream.py（会議アシスタントの実装）を正として参照すること**

---

## 1. 現状アーキテクチャ

### 1.1 バックエンド (gourmet-support)
```
app_customer_support.py  ← Flask Webアプリ層
support_core.py          ← ビジネスロジック (SupportSession, SupportAssistant)
api_integrations.py      ← 外部API連携 (Places, HotPepper, TripAdvisor)
long_term_memory.py      ← Supabase長期記憶
```

### 1.2 フロントエンド (gourmet-sp)
```
src/scripts/chat/
  core-controller.ts       ← 共通ベース
  chat-controller.ts       ← グルメモード (extends CoreController)
  concierge-controller.ts  ← コンシェルジュモード (extends CoreController)
  audio-manager.ts         ← マイク入力・Socket.IO送信
```

### 1.3 現在のデータフロー（REST API版）
```
[ユーザー音声]
  → AudioWorklet (16kHz PCM)
  → Socket.IO → Google Cloud STT
  → テキスト → /api/chat (REST)
  → Gemini REST API (gemini-2.5-flash)
  → テキスト応答 → /api/tts/synthesize
  → Google Cloud TTS → MP3
  → フロントエンド再生
```

---

## 2. Phase1 目標アーキテクチャ

### 2.1 新しいデータフロー（LiveAPI版）
```
[ユーザー音声]
  → AudioWorklet (16kHz PCM)
  → WebSocket → バックエンド → Gemini LiveAPI セッション
  → LiveAPIが内部でSTT+LLM+TTS処理
  → 音声出力 → WebSocket → フロントエンド再生

🚨例外: ショップカード提示時のみ
  → Gemini LiveAPIのtool_callでshops取得
  → REST API /api/tts/synthesize で長文TTS生成
  → ショップ紹介セリフはREST APIで生成
```

### 2.2 🚨 変えない箇所（原則5: やらないことの明記）

| 項目 | 変更しない理由 |
|------|-------------|
| api_integrations.py | Places API等の外部連携はそのまま使用 |
| long_term_memory.py | Supabase長期記憶はそのまま使用 |
| ショップカード提示のTTS | 長文のためREST APIを継続使用 |
| ProposalCard / ShopCardList コンポーネント | UI表示はそのまま |
| PWA設定 | そのまま |
| i18n.ts | そのまま |
| prompts/ ディレクトリ | そのまま |

---

## 3. ディレクトリ構成

```
gourmet-sp3/
├── support-base/              ← バックエンド（Cloud Runデプロイ対象）
│   ├── Dockerfile
│   ├── requirements.txt
│   ├── app_customer_support.py   ← Flask + WebSocket メインアプリ
│   ├── support_core.py           ← ビジネスロジック
│   ├── api_integrations.py       ← 外部API連携（変更なし）
│   ├── long_term_memory.py       ← 長期記憶（変更なし）
│   ├── live_session.py           ← 🆕 Gemini LiveAPI セッション管理
│   ├── prompts/
│   │   ├── support_system_ja.txt
│   │   ├── support_system_en.txt
│   │   ├── support_system_zh.txt
│   │   ├── support_system_ko.txt
│   │   └── concierge_ja.txt
│   └── templates/
│       └── support.html
│
├── src/                          ← フロントエンド（Astro）
│   ├── components/
│   │   ├── GourmetChat.astro
│   │   ├── Concierge.astro
│   │   ├── ProposalCard.astro
│   │   ├── ShopCardList.astro
│   │   ├── ReservationModal.astro
│   │   └── InstallPrompt.astro
│   ├── constants/
│   │   └── i18n.ts
│   ├── layouts/
│   │   └── Layout.astro
│   ├── pages/
│   │   ├── index.astro
│   │   ├── concierge.astro
│   │   ├── chat.astro
│   │   └── 404.astro
│   ├── scripts/chat/
│   │   ├── core-controller.ts      ← 改修: LiveAPI WebSocket対応
│   │   ├── chat-controller.ts      ← 改修: LiveAPI モード追加
│   │   ├── concierge-controller.ts ← 改修: LiveAPI + アバター
│   │   └── audio-manager.ts        ← 改修: LiveAPI用音声送受信
│   └── styles/
│       └── global.css
│
├── public/                       ← 静的アセット
├── package.json
├── astro.config.mjs
├── tsconfig.json
└── DESIGN_SPEC_PHASE1.md        ← 本ファイル
```

---

## 4. バックエンド詳細設計

### 4.1 live_session.py（🆕 新規ファイル）

🚨 **原則7再掲: このファイルの実装はstt_stream.pyを正とする。Claude の推測コードは使用しない。**

#### 4.1.1 役割
- Gemini LiveAPI セッションの確立・維持
- 音声入力の受信とLiveAPIへの転送
- LLMからの音声出力・テキスト出力・tool_callの受信と転送
- ショップ検索時のtool_call処理

#### 4.1.2 クラス設計

```python
# 🚨 以下はインターフェース定義のみ。実装はstt_stream.pyを参照して書くこと。

class GourmetLiveSession:
    """
    1つのユーザーセッションに対応するLiveAPIセッション

    🚨 具体値（原則1）:
    - モデル: "gemini-2.0-flash-live-001"  ← stt_stream.pyと同じ値を使用
    - 音声入力形式: PCM 16kHz 16bit mono
    - 音声出力形式: PCM 24kHz 16bit mono  ← stt_stream.pyと同じ
    """

    def __init__(self, session_id: str, mode: str, language: str, system_prompt: str):
        """
        処理順序（原則3）:
        1. session_id, mode, language, system_prompt を保存
        2. SupportSession を初期化
        3. LiveAPI セッションは start() で別途開始（コンストラクタでは開始しない）
        """
        pass

    async def start(self):
        """
        処理順序（原則3）:
        1. genai.Client を作成
        2. LiveConnectConfig を構築（system_instruction, tools 設定）
        3. client.aio.live.connect() でセッション開始
        4. 受信ループを開始（別タスク）
        """
        pass

    async def send_audio(self, audio_chunk: bytes):
        """
        処理順序（原則3）:
        1. audio_chunk が空でないことを確認
        2. session.send(input=audio_chunk) で送信
        🚨 形式は PCM 16kHz 16bit mono（フロントエンドから受信したまま）
        """
        pass

    async def send_text(self, text: str):
        """
        テキスト入力をLiveAPIに送信（テキスト入力モード用）
        処理順序（原則3）:
        1. session.send(input=text, end_of_turn=True)
        """
        pass

    async def _receive_loop(self):
        """
        LiveAPIからの受信を処理するループ

        処理順序（原則3）:
        1. async for response in session.receive():
        2. response の種類を判定:
           a. 音声データ → コールバックで通知
           b. テキストデータ → コールバックで通知
           c. tool_call → _handle_tool_call() で処理
           d. turn_complete → コールバックで通知

        🚨 tool_call検知順序は変更禁止（原則4）
        """
        pass

    async def _handle_tool_call(self, tool_call):
        """
        tool_callの処理

        処理順序（原則3）:
        1. tool_call.name を判定
        2. "search_restaurants" の場合:
           a. パラメータを抽出
           b. Gemini REST API で検索実行（Google Search Grounding使用）
           c. 結果をパースしてshops配列を生成
           d. api_integrations.enrich_shops_with_photos() で写真付与
           e. コールバックでshopsを通知
           f. session.send(tool_response=...) でLiveAPIに結果を返す

        🚨 ショップ紹介セリフの音声はREST API TTS で生成する（LiveAPIでは生成しない）
        """
        pass

    async def close(self):
        """セッション終了"""
        pass
```

#### 4.1.3 🚨 LiveAPI設定値（原則1: 具体値を書く）

```python
# 🚨 改変禁止（原則2）: 以下の設定値はstt_stream.pyから移植
LIVE_API_CONFIG = {
    "model": "gemini-2.0-flash-live-001",
    "generation_config": {
        "response_modalities": ["AUDIO"],  # 音声出力モード
        "speech_config": {
            "voice_config": {
                "prebuilt_voice_config": {
                    "voice_name": "Aoede"  # 🚨 stt_stream.pyの値を確認して設定
                }
            }
        }
    }
}
```

### 4.2 app_customer_support.py の変更

#### 4.2.1 新しいWebSocketイベント

```
🚨 処理順序（原則3）:

[接続確立]
1. 'connect' → クライアントSID記録

[LiveAPI セッション開始]
2. 'start_live_session' →
   a. mode, language, user_info を受信
   b. SupportSession を初期化
   c. GourmetLiveSession を作成
   d. コールバックを登録:
      - on_audio: 音声データをクライアントに送信
      - on_text: テキストをクライアントに送信
      - on_shops: ショップデータをクライアントに送信
      - on_turn_complete: ターン完了を通知
   e. session.start() でLiveAPIセッション開始
   f. 'live_session_ready' を emit

[音声データ送信]
3. 'live_audio' →
   a. base64デコード
   b. session.send_audio(audio_bytes) でLiveAPIに転送

[テキスト入力]
4. 'live_text' →
   a. テキストを受信
   b. session.send_text(text) でLiveAPIに転送

[セッション終了]
5. 'stop_live_session' →
   a. session.close()
   b. セッションを破棄

[切断]
6. 'disconnect' →
   a. アクティブなLiveAPIセッションがあれば close()
```

#### 4.2.2 🚨 既存のREST APIエンドポイント（変更しない）

以下のエンドポイントは **そのまま残す**（原則5: やらないこと）:
- `POST /api/session/start` - セッション初期化（LiveAPIセッションとは別にセッション管理として残す）
- `POST /api/chat` - テキストチャット（LiveAPIが使えない場合のフォールバック）
- `POST /api/tts/synthesize` - ショップ紹介セリフ用TTS（これだけREST API）
- `POST /api/cancel` - 処理中止
- `GET /health` - ヘルスチェック

---

## 5. フロントエンド詳細設計

### 5.1 audio-manager.ts の変更

#### 5.1.1 LiveAPI用の音声送受信モード追加

```typescript
// 🚨 改変禁止: 追加するメソッドのインターフェース

/**
 * LiveAPI用ストリーミング開始
 *
 * 処理順序（原則3）:
 * 1. マイクアクセス取得
 * 2. AudioWorklet初期化（16kHz PCMダウンサンプリング）
 * 3. socket.emit('start_live_session', { mode, language, user_info })
 * 4. 'live_session_ready' を待機
 * 5. AudioWorkletからの音声チャンクをsocket.emit('live_audio', { chunk: base64 }) で送信
 *
 * 🚨 既存のstartStreaming()は残す（フォールバック用）
 */
public async startLiveStreaming(
    socket: any,
    mode: string,
    language: string,
    callbacks: {
        onAudio: (audioBase64: string) => void;  // サーバーからの音声
        onText: (text: string, role: string) => void;  // テキスト
        onShops: (shops: any[]) => void;  // ショップデータ
        onTurnComplete: () => void;  // ターン完了
    }
): Promise<void>

/**
 * LiveAPI用ストリーミング停止
 */
public stopLiveStreaming(): void
```

#### 5.1.2 音声再生バッファ

```typescript
/**
 * LiveAPIからの音声チャンクを順序保証で再生
 *
 * 🚨 具体値（原則1）:
 * - 入力: PCM 24kHz 16bit mono（LiveAPIの出力形式）
 * - AudioContextのsampleRateと合わない場合はリサンプリング必要
 *
 * 処理順序（原則3）:
 * 1. base64デコード → ArrayBuffer
 * 2. Int16Array に変換
 * 3. Float32Array に変換（-1.0〜1.0）
 * 4. AudioBuffer を作成
 * 5. AudioBufferSourceNode で再生キューに追加
 */
private playAudioChunk(audioBase64: string): void
```

### 5.2 core-controller.ts の変更

#### 5.2.1 LiveAPI対応の追加プロパティ

```typescript
// 🚨 追加するプロパティ（原則2: 改変禁止）
protected isLiveMode = true;  // LiveAPI使用フラグ（デフォルトON）
protected liveSessionActive = false;  // LiveAPIセッションが有効か
```

#### 5.2.2 sendMessage() の変更

```
処理順序（原則3）:

[LiveAPIモードの場合]
1. メッセージをUIに表示
2. socket.emit('live_text', { text: message }) でLiveAPIに送信
3. 応答はWebSocketコールバックで受信:
   - 'live_audio' → 音声再生
   - 'live_text' → チャットに表示
   - 'live_shops' → ショップカード表示 + REST API TTSで紹介セリフ再生
   - 'live_turn_complete' → 入力可能状態に戻す

[REST APIフォールバック（LiveAPI接続失敗時）]
→ 既存のfetch('/api/chat') フローをそのまま使用
```

### 5.3 concierge-controller.ts の変更

#### 5.3.1 アバター・リップシンク統合

```
処理順序（原則3）:

[LiveAPIからの音声受信時]
1. 音声チャンクを受信
2. 音声をAudioBufferSourceNodeで再生キューに追加
3. 同時に Audio2Expression サービスに音声を送信
4. 表情フレームデータを受信
5. アバターに表情を適用（フレームレートに合わせて）

🚨 Audio2Expression サービスへの送信は、
   ショップ紹介セリフ（REST API TTS）の場合のみ。
   LiveAPIの音声出力は短いチャンクなので、
   まとめてから送信する必要がある。

🚨 アバター実装の詳細は A2E サービスの仕様に依存。
   既存の get_expression_frames() 関数を参考にする。
```

---

## 6. 移植元との対応表（原則6）

| 現在のコード | 新しいコード | 変更内容 |
|------------|------------|---------|
| `app_customer_support.py` WebSocket STT | `app_customer_support.py` WebSocket LiveAPI | STTのみ → 全会話をLiveAPI化 |
| `support_core.py` SupportAssistant.process_user_message() | `live_session.py` GourmetLiveSession._receive_loop() | REST API呼び出し → LiveAPIリアルタイム処理 |
| `audio-manager.ts` startStreaming() | `audio-manager.ts` startLiveStreaming() | STTのみ送信 → 音声送受信双方向 |
| `core-controller.ts` sendMessage() fetch('/api/chat') | `core-controller.ts` sendMessage() socket.emit('live_text') | REST API → WebSocket |
| `core-controller.ts` speakTextGCP() fetch('/api/tts/synthesize') | LiveAPIからの音声を直接再生 | REST TTS → LiveAPI音声出力 |
| `concierge-controller.ts` CSSアニメーション | `concierge-controller.ts` A2E表情フレーム | CSS → A2Eリップシンク |
| ショップ紹介セリフ speakTextGCP() | **変更なし** REST API TTS継続 | 長文のためREST API維持 |

---

## 7. 検証条件（原則8: assertで書く）

### 7.1 バックエンド検証

```python
# test_live_session.py

def test_live_session_creation():
    """LiveAPIセッションが正常に作成できること"""
    session = GourmetLiveSession("test-001", "chat", "ja", "テスト用プロンプト")
    assert session.session_id == "test-001"
    assert session.mode == "chat"
    assert session.language == "ja"

def test_live_audio_format():
    """音声フォーマットが正しいこと"""
    # 入力: PCM 16kHz 16bit mono
    sample_rate = 16000
    bit_depth = 16
    channels = 1
    assert sample_rate == 16000, "入力サンプルレートは16kHz"
    assert bit_depth == 16, "ビット深度は16bit"
    assert channels == 1, "モノラル"

def test_shop_card_uses_rest_tts():
    """ショップカード提示時はREST API TTSを使用すること"""
    # ショップ紹介セリフが生成された場合、
    # LiveAPIの音声ではなくREST API TTSで音声合成する
    assert USE_REST_TTS_FOR_SHOP_INTRO == True

def test_existing_rest_endpoints_preserved():
    """既存のREST APIエンドポイントが維持されていること"""
    endpoints = ['/api/session/start', '/api/chat', '/api/tts/synthesize',
                 '/api/cancel', '/health']
    for ep in endpoints:
        assert endpoint_exists(ep), f"{ep} が削除されている"
```

### 7.2 フロントエンド検証

```typescript
// 手動検証チェックリスト

// ✅ グルメモード（/）
// 1. ページ表示 → 初回挨拶が音声で再生される
// 2. マイクボタン → 音声入力 → LiveAPIで処理 → 音声応答
// 3. テキスト入力 → LiveAPIで処理 → 音声応答
// 4. ショップ提案 → カード表示 + REST API TTSでセリフ再生
// 5. LiveAPI接続失敗 → REST APIフォールバック動作

// ✅ コンシェルジュモード（/concierge）
// 6. ページ表示 → 初回挨拶 + アバター口パク
// 7. 音声入力 → LiveAPI → アバター口パク付き音声応答
// 8. ショップ提案 → カード表示 + REST API TTS + アバター口パク
// 9. 名前登録 → action処理 → 長期記憶更新
// 10. モード切替 → ページ遷移正常
```

---

## 8. 実装順序（フェーズ1）

```
🚨 この順序は厳守（原則3）

Step 1: ベースコード配置
  - gourmet-support の 4つのPyファイル + prompts/ を support-base/ にコピー
  - gourmet-sp の src/ を本リポジトリの src/ にコピー
  - package.json, astro.config.mjs 等の設定ファイルをコピー
  - public/ 配下の静的アセットをコピー

Step 2: バックエンド LiveAPI基盤
  - live_session.py を新規作成（🚨 stt_stream.pyを参照）
  - app_customer_support.py にWebSocketイベントを追加

Step 3: フロントエンド LiveAPI対応
  - audio-manager.ts にLiveAPI送受信メソッド追加
  - core-controller.ts にLiveAPIモード追加
  - chat-controller.ts をLiveAPI対応に改修
  - concierge-controller.ts をLiveAPI + アバター対応に改修

Step 4: アバター・リップシンク統合
  - concierge-controller.ts にA2E表情フレーム処理追加
  - Concierge.astro にアバター表示エリア強化

Step 5: 検証・修正
  - 各検証条件をパス
  - フォールバック動作確認
```

---

## 9. 🚨 リスク・注意事項

1. **LiveAPI の音声出力形式**: stt_stream.py で実際に使われている値を確認すること
2. **tool_call の仕様**: Google Search Grounding がLiveAPIのtoolsとして使えるか要確認
3. **セッション寿命**: LiveAPIセッションのタイムアウト値を確認（長時間接続時の再接続処理が必要）
4. **同時接続数**: Cloud Run の同時接続制限とLiveAPIのセッション制限を確認
5. **コスト**: LiveAPI は REST API よりコストが高い可能性あり
