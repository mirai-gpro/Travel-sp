# A2E リップシンク包括的実装ガイド

**作成日**: 2026-03-20
**前提ドキュメント**: docs/11（実装ルール）, docs/12（修正案C仕様）を統合
**対象コード**: `live_api_handler.py`, `live-audio-manager.ts`, `core-controller.ts`, `lam-websocket-manager.ts`

---

## 1. A2Eの基本特性（公式リポジトリ準拠）

### 1.1 入出力の決定論的対応

| 入力 | 出力 | 根拠 |
|------|------|------|
| 16,000サンプル（1秒 @ 16kHz） | 30フレーム（1秒 @ 30fps） | `frame_length = math.ceil(audio.shape[0] / ssr * 30)` |
| N秒の音声 | N × 30 フレーム | 線形対応。例外なし |

参照: https://github.com/aigc3d/LAM_Audio2Expression `engines/infer.py`

### 1.2 推論レイテンシ = 事実上ゼロ

公式デモで確認済み。「A2Eの処理時間が遅延の原因」と推測してはならない。
同期がズレている場合、原因は**常にアプリケーション側のコードロジック**。

### 1.3 ストリーミングcontext

```python
context = {
    'previous_audio': ...,       # 前チャンクの音声波形（オーバーラップ用）
    'previous_expression': ...,  # 前チャンクの出力blendshape
    'previous_volume': ...,      # 前チャンクの音量（無音判定用）
    'is_initial_input': False    # 初回フラグ
}
```

- `is_start=True` → context リセット（新しい音声セグメント開始）
- `is_start=False` → 前チャンクとの連続性保持（スライディングウィンドウ）
- **意味的に独立した音声**（別のショップ説明、キャッシュ音声）は `is_start=True` で切る

### 1.4 後処理パイプライン（A2Eサービス内部で完結）

1. `smooth_mouth_movements()` — 無音区間の口パクパク抑制
2. `apply_frame_blending()` — チャンク境界の線形補間
3. `apply_savitzky_golay_smoothing()` — 時間軸の多項式平滑化
4. `symmetrize_blendshapes()` — 左右20ペアの対称化
5. `apply_random_eye_blinks_context()` — 手続き的まばたき生成
6. `apply_random_brow_movement()` — 音声RMSに基づく眉の動き

**アプリケーション側で再実装してはならない。**

---

## 2. 同期メカニズムの全体像

### 2.1 データフロー（4コンポーネント）

```
┌──────────────────────────────────────────────────────────────┐
│ バックエンド: live_api_handler.py                              │
│                                                              │
│  LiveAPI → PCM音声チャンク到着                                  │
│    ├── socketio.emit('live_audio')     → [フロントへ]          │
│    └── _buffer_for_a2e(pcm)                                   │
│          └── _flush_a2e_buffer()                              │
│                └── _send_to_a2e(pcm, chunk_index, is_final)   │
│                      └── 24kHz→16kHz リサンプリング             │
│                      └── HTTP POST → A2Eサービス               │
│                      └── socketio.emit('live_expression')     │
│                            → [フロントへ]                      │
└──────────────────────────────────────────────────────────────┘
        │                              │
        ▼                              ▼
┌──────────────────────────────────────────────────────────────┐
│ フロントエンド: core-controller.ts                             │
│                                                              │
│  socket.on('live_audio')                                      │
│    → liveAudioManager.onAiResponseStarted()                   │
│    → liveAudioManager.playPcmAudio(data)                      │
│                                                              │
│  socket.on('live_expression')                                 │
│    → liveAudioManager.onExpressionReceived(data)              │
│                                                              │
│  socket.on('live_expression_reset')                           │
│    → liveAudioManager.resetForNewSegment()                    │
└──────────────────────────────────────────────────────────────┘
        │                              │
        ▼                              ▼
┌─────────────────────────┐  ┌─────────────────────────────────┐
│ live-audio-manager.ts   │  │ lam-websocket-manager.ts        │
│                         │  │                                 │
│ playPcmAudio():         │  │ レンダリングループ（毎フレーム）:    │
│   AudioContext再生       │  │   frame = liveAudioManager      │
│   firstChunkStartTime   │  │     .getCurrentExpressionFrame() │
│   _scheduleBuffer()     │  │   updateExpression(frame)        │
│                         │  │   → blendshapeに反映              │
│ getCurrentExpression     │  │                                 │
│   Frame():              │  │ _getExpressionData():            │
│   offsetMs計算           │  │   currentExpression.values       │
│   frameIndex算出         │  │   → ARKit 52 blendshape map     │
│   バッファから取得        │  │                                 │
└─────────────────────────┘  └─────────────────────────────────┘
```

### 2.2 同期の3条件（全て必須）

| 条件 | 説明 |
|------|------|
| **条件1: 時間ベースの一致** | `firstChunkStartTime` が音声再生開始時刻と一致 |
| **条件2: フレーム数の一致** | `expressionFrameBuffer` のフレーム数 = 再生音声の秒数 × 30 |
| **条件3: ギャップの不在** | `firstChunkStartTime` から現在まで、音声もフレームもない空白期間がないこと |

**条件3が最重要。** `audioContext.currentTime` は音声が鳴っていなくても進む。

---

## 3. 音声パス別の同期方式

### 3.1 正常パス: 通常会話（`_receive_and_forward`）

**方式**: インターリーブ（音声とExpressionが交互に到着）

```
live_audio → playPcmAudio() → firstChunkStartTime設定
↕ 同時進行
_buffer_for_a2e → A2Eサービス → live_expression → バッファ追加
↕ 繰り返し
turn_complete → リセット
```

**なぜ動くか**: LiveAPIが音声を連続ストリーミング → 空白期間なし → 3条件充足

**コード位置**: `live_api_handler.py` L630-713 `_receive_and_forward()`

### 3.2 ショップ1軒目: ストリーミング（`_stream_single_shop` + `_receive_shop_description`）

**方式**: インターリーブ（正常パスと同等）

```
live_expression_reset → resetForNewSegment()
  ↓
新LiveAPIセッション → ストリーミング受信
  live_audio + _buffer_for_a2e（正常パスと同じインターリーブ）
  ↓
turn_complete → フラッシュ
```

**コード位置**: `live_api_handler.py` L917-960 `_stream_single_shop()`、L1052-1110 `_receive_shop_description()`

### 3.3 ショップ2軒目以降: A2E先行方式（`_emit_collected_shop`）

**方式**: A2E先行（Expression全フレームが先着 → 音声再生開始）

```
live_expression_reset → resetForNewSegment()
  ↓
_send_a2e_ahead(全PCM結合) → live_expression（全フレーム先着）
  ↓
sleep(50ms) → 到着マージン
  ↓
live_audio × N chunks → 再生開始
```

**コード位置**: `live_api_handler.py` L1029-1051 `_emit_collected_shop()`

### 3.4 キャッシュ音声: A2E先行方式（`_emit_cached_audio`）

**方式**: A2E先行（3.3と同じ）

```
live_expression_reset → resetForNewSegment()
  ↓
_send_a2e_ahead(PCM) → live_expression（全フレーム先着）
  ↓
sleep(50ms) → 到着マージン
  ↓
live_audio × N chunks → 再生開始
```

**コード位置**: `live_api_handler.py` L1116-1146 `_emit_cached_audio()`

**現在の状態**: L729-737でコメントアウト（切り分けテスト用に無効化中）

---

## 4. セグメント境界リセットの仕組み

### 4.1 `live_expression_reset` イベントフロー

```
バックエンド                           フロントエンド
────────                           ──────────
socketio.emit                      core-controller.ts L305:
  ('live_expression_reset')   →      socket.on('live_expression_reset')
                                       → liveAudioManager.resetForNewSegment()

                                   live-audio-manager.ts L340-358:
                                     resetForNewSegment():
                                       nextPlayTime = 0
                                       scheduledSources → 全stop
                                       expressionFrameBuffer = []
                                       firstChunkStartTime = 0
                                       isAiSpeaking = true  ← 維持！
```

### 4.2 なぜ `isAiSpeaking = true` を維持するか

```
× もし isAiSpeaking = false にした場合:
  live_expression_reset → isAiSpeaking = false
  _send_a2e_ahead → live_expression → バッファにフレーム追加
  live_audio → onAiResponseStarted()
    isAiSpeaking was false → リセット実行！
    expressionFrameBuffer = []  ← A2E先行で追加したフレームが消える！

✓ isAiSpeaking = true を維持した場合:
  live_expression_reset → isAiSpeaking = true（維持）
  _send_a2e_ahead → live_expression → バッファにフレーム追加
  live_audio → onAiResponseStarted()
    isAiSpeaking was true → リセット不実行！
    expressionFrameBuffer 保持！ ← A2E先行のフレームが保持される
  playPcmAudio()
    firstChunkStartTime = audioContext.currentTime ← 設定
    → 同期成立
```

### 4.3 リセットが必要なタイミング一覧

| タイミング | 信号 | コード位置 |
|-----------|------|-----------|
| 通常会話のターン完了 | `turn_complete` | L650-663 |
| ユーザー割り込み | `interrupted` | L666-673 |
| キャッシュ音声の前 | `live_expression_reset` | `_emit_cached_audio()` L1130 |
| 1軒目ストリーミングの前 | `live_expression_reset` | `_describe_shops_via_live()` L882 |
| 2軒目以降 collected の前 | `live_expression_reset` | `_emit_collected_shop()` L1038 |

---

## 5. ショップ検索フロー全体のタイムライン

```
LLM発話 → tool_call: search_shops
  ↓
shop_search_start送信 (L725)
  ↓
[キャッシュ音声は現在無効化 L729-737]
  ↓
REST API検索 → shop_search_result送信 (L797)
  ↓
_describe_shops_via_live() (L860):
  ├── 2軒目以降の並行生成をasyncio.create_task (L876-879)
  ├── live_expression_reset (L882) ← 1軒目前のリセット
  ├── _a2e_chunk_index = 0, _a2e_audio_buffer クリア (L883-884)
  ├── _stream_single_shop() (L887) ← 1軒目ストリーミング
  │     └── _receive_shop_description() ← インターリーブ方式
  ├── sleep(1軒目の音声再生時間) (L890-893)
  └── 2軒目以降を順次再生 (L896-909):
        ├── _emit_collected_shop() ← A2E先行方式
        └── sleep(音声再生時間) ← 各ショップ間
  ↓
会話履歴に追加 (L912-913)
needs_reconnect = True → 通常会話に復帰 (L915)
```

---

## 6. バッファリング定数

| 定数 | 値 | 意味 | コード位置 |
|------|-----|------|-----------|
| `A2E_MIN_BUFFER_BYTES` | 4,800 | 最低バッファサイズ（0.1秒 @ 24kHz 16bit mono） | L31 |
| `A2E_FIRST_FLUSH_BYTES` | 4,800 | 初回フラッシュ閾値（低遅延優先） | L32 |
| `A2E_AUTO_FLUSH_BYTES` | 240,000 | 2回目以降フラッシュ閾値（5秒分、品質優先） | L33 |
| `A2E_EXPRESSION_FPS` | 30 | Expression フレームレート | L34 |
| A2E先行後のsleep | 50ms | Socket.IO emit→フロント処理の往復マージン | `_emit_cached_audio` L1136 |

**これらの値は実証テスト済み。変更するな。**

---

## 7. リサンプリング（24kHz → 16kHz）

`_send_to_a2e()` L1215-1268:

```python
# LiveAPIの出力: 24kHz 16bit mono PCM
# A2Eの入力: 16kHz 16bit mono PCM
int16_array = np.frombuffer(pcm_data, dtype=np.int16)
resampled = resample_poly(int16_array.astype(np.float32), up=2, down=3)  # 24→16kHz
int16_resampled = np.clip(resampled, -32768, 32767).astype(np.int16)
audio_b64 = base64.b64encode(int16_resampled.tobytes()).decode('utf-8')
```

A2EサービスのAPIパラメータ:
- `audio_base64`: raw int16 PCM のbase64
- `audio_format`: `"pcm"`
- `session_id`: セッション識別子
- `is_start`: 新セグメント開始
- `is_final`: セグメント最終チャンク

---

## 8. フロントエンドのExpression適用パス

### 8.1 `getCurrentExpressionFrame()` (live-audio-manager.ts L237-270)

```typescript
offsetMs = (audioContext.currentTime - firstChunkStartTime) * 1000
frameIndex = Math.floor((offsetMs / 1000) * expressionFrameRate)  // = offsetMs * 30 / 1000
clampedIndex = Math.min(frameIndex, expressionFrameBuffer.length - 1)
return expressionFrameBuffer[clampedIndex]
```

### 8.2 LAMレンダラーへの適用 (lam-websocket-manager.ts)

```
GaussianSplatRenderer コールバック:
  getExpressionData()
    → currentExpression.values を ARKit 52 blendshape map に変換
    → レンダラーが毎フレーム呼び出し
```

レンダリングループ（concierge-controller.ts から linkLamAvatar() 経由）:
```
毎フレーム:
  frame = liveAudioManager.getCurrentExpressionFrame()
  lamWebSocketManager.updateExpression(frame)
```

---

## 9. 現在の残課題

### 9.1 キャッシュ音声の再有効化

L729-737でコメントアウト中。A2Eバッファ汚染の切り分けテスト用に無効化されている。
A2E先行方式（`_emit_cached_audio`）が正常動作すれば、コメントアウトを解除して再有効化できる。

### 9.2 ショップ間のsleep値の最適化

`_describe_shops_via_live()` L890-907:
- 1軒目再生待ち: `_last_stream_pcm_bytes / 48000` 秒
- 2軒目以降再生待ち: `len(all_pcm) / 48000` 秒

これらのsleep値は「前セグメントの音声が再生し終わるまで待つ」ための概算値。
音声再生とA2Eフレーム消費が完全に同期していれば、次セグメントの `live_expression_reset` で安全にリセットできるため、厳密なsleep値は不要。

---

## 10. 実装の必須ルール（チェックリスト）

新たに `live_audio` を送信するコードパスを作る場合:

- [ ] セグメント開始前に `live_expression_reset` を送っているか
- [ ] 音声チャンクごとに `_buffer_for_a2e()` を呼んでいるか（インターリーブ方式の場合）
- [ ] または `_send_a2e_ahead()` でExpression先行送信しているか（A2E先行方式の場合）
- [ ] セグメント終了時に `_flush_a2e_buffer(force=True, is_final=True)` を呼んでいるか
- [ ] セグメント終了時に `_a2e_chunk_index = 0` にリセットしているか
- [ ] 無音ギャップが発生する場合、前後でリセットしているか

---

## 11. 禁止事項

1. **A2Eの推論遅延を仮定するな** — ゼロレイテンシ。ズレの原因はアプリ側
2. **A2Eの後処理を再実装するな** — サービス内部で完結
3. **フロントの同期メカニズムを迂回するな** — `firstChunkStartTime` + `expressionFrameBuffer` は実証済み
4. **正常パスのコードを表面だけコピーするな** — `turn_complete` リセットが欠落すれば同期崩壊
5. **バッファ閾値を変更するな** — 実証テスト済みの値

---

## 参照ドキュメント

| 文書 | 内容 |
|------|------|
| `docs/09_liveapi_migration_design_v6.md` §4 | V6統合仕様書（A2Eセクション） |
| `docs/10_lam_audio2expression_spec.md` | A2E技術仕様書 |
| `docs/11_a2e_lipsync_implementation_guide.md` | リップシンク実装ルール（本ドキュメントに統合） |
| `docs/12_shop_audio_a2e_sync_fix_spec.md` | 修正案C仕様（本ドキュメントに統合） |
| A2E公式リポジトリ | https://github.com/aigc3d/LAM_Audio2Expression |
| 論文 | He, Y. et al. (2025). "LAM: Large Avatar Model" arXiv:2502.17796v2 |
