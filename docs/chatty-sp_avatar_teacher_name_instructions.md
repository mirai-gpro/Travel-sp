# Chatty-sp 向け指示書: 新規ユーザー初期表示修正 + アバター毎の講師名対応

## 前提

- 対象リポジトリ: `mirai-gpro/Chatty-sp`
- 対象ブランチ: `claude/refactor-reset-logic-eXNFd`（またはユーザー指定のブランチ）
- Travel-sp で実施済みの修正を Chatty-sp にも適用する
- Chatty-sp 固有の `shop_id` パラメータは**削除せず保持**すること

## 背景

### 問題1: 新規ユーザーの初期表示

新規ユーザーが初回起動時、`lesson`モードのメルルのカメラパラメータが
`avatar-config.json`の値ではなく、`lam-websocket-manager.ts`内のハードコード
デフォルト値（`posZ: 0.4, targetY: 1.62`）で表示される。
メルルの正しい値は `posZ: 0.45, targetY: 1.67`。

**原因:** 新規ユーザー時 `localStorage` が空のため、`lam-websocket-manager.ts` 内で
`selectedCamera_${mode}` が見つからず、ハードコードデフォルトにフォールバックする。

**対策:** localStorage が空の場合、`avatar-config.json` からモードのデフォルト
アバターのカメラパラメータを取得して `localStorage` に保存する関数を追加。

### 問題2: アバター共通の呼び名

現状、全アバターの AI 講師名が `'Lisa'` 固定になっている
（`live_api_handler.py` / `support_core.py` の `lesson_teacher_name` デフォルト値）。
アバターを切り替えても呼び名が変わらない。

**対策:** `avatar-config.json` に `teacherName` フィールドを追加し、
アバター選択時に localStorage に保存。
フロントエンドから `live_start` イベントで送信し、
バックエンドの `user_profile.lesson_teacher_name` に反映する。

---

## 修正対象ファイル（6ファイル）

1. `public/avatar/avatar-config.json`
2. `src/config/avatar-config.ts`
3. `src/scripts/chat/lam-websocket-manager.ts`
4. `src/scripts/chat/core-controller.ts`
5. `chatty-base/app_customer_support.py`
6. `chatty-base/live_api_handler.py`（確認のみ、既存コードで OK のはず）

---

## 修正1: `public/avatar/avatar-config.json`

全アバターに `teacherName` フィールドを追加。**各アバター毎の呼び名は
Chatty-sp のプロジェクトコンセプトに合わせて決めること**。

参考（Travel-sp で使った値）:

```json
{
  "id": "meruru",
  "teacherName": "Meruru",
  ...
},
{
  "id": "elf",
  "teacherName": "Elfi",
  ...
},
{
  "id": "mizuki",
  "teacherName": "Mizuki",
  ...
},
{
  "id": "nao",
  "teacherName": "Nao",
  ...
},
{
  "id": "ryusei",
  "teacherName": "Ryusei",
  ...
},
{
  "id": "okabe",
  "teacherName": "Okabe",
  ...
}
```

**注意:** `name` 項目はそのまま残し、新たに `teacherName` を追加する。

---

## 修正2: `src/config/avatar-config.ts`

### 2-1. `AvatarDef` インターフェースに `teacherName` を追加

```typescript
export interface AvatarDef {
  id: string;
  name: string;
  teacherName?: string; // AI講師の呼び名（プロンプト内の{teacher_name}に使用）
  modelUrl: string;
  thumbnail?: string;
  voiceModel: string;
  liveVoice?: string;
  camera?: CameraParams;
}
```

### 2-2. `setSelectedAvatar()` で `teacherName` を localStorage に保存

```typescript
export function setSelectedAvatar(mode: string, avatar: AvatarDef): void {
  localStorage.setItem(`${STORAGE_KEY}_${mode}`, avatar.id);
  localStorage.setItem(`selectedAvatarUrl_${mode}`, avatar.modelUrl);
  localStorage.setItem(`selectedVoiceModel_${mode}`, avatar.voiceModel);
  localStorage.setItem(`selectedLiveVoice_${mode}`, avatar.liveVoice || '');
  localStorage.setItem(`selectedTeacherName_${mode}`, avatar.teacherName || ''); // ★追加
  if (avatar.camera) {
    localStorage.setItem(`selectedCamera_${mode}`, JSON.stringify(avatar.camera));
  }
}
```

### 2-3. 新規関数 `ensureDefaultAvatarInStorage()` を追加

`setSelectedAvatar()` の直後あたりに追加:

```typescript
/** 新規ユーザー時: モードのデフォルトアバターのlocalStorageを初期化 */
export async function ensureDefaultAvatarInStorage(mode: string): Promise<void> {
  if (localStorage.getItem(`selectedCamera_${mode}`)) return; // 既に設定済み
  const avatars = await loadAvatarConfig();
  const defaultId = MODE_DEFAULT_AVATAR[mode] || 'meruru';
  const avatar = getAvatarById(avatars, defaultId);
  if (avatar) {
    setSelectedAvatar(mode, avatar);
  }
}
```

---

## 修正3: `src/scripts/chat/lam-websocket-manager.ts`

### 3-1. import 追加

```typescript
import * as GaussianSplats3D from 'gaussian-splat-renderer-for-lam';
import type { ExpressionFrame } from './live-audio-manager';
import { ensureDefaultAvatarInStorage } from '../../config/avatar-config'; // ★追加
```

### 3-2. `initialize()` の先頭で `ensureDefaultAvatarInStorage()` を呼ぶ

```typescript
async initialize(config: LAMConfig): Promise<void> {
    try {
        // ★ 新規ユーザー対応: モードのデフォルトアバター情報をlocalStorageに確実に設定
        const mode = window.location.pathname.includes('concierge') ? 'concierge' : 'lesson';
        await ensureDefaultAvatarInStorage(mode);

        this.renderer = await GaussianSplats3D.GaussianSplatRenderer.getInstance(
            config.containerElement,
            config.modelUrl,
            {
                getChatState: () => this.chatState,
                getExpressionData: () => this._getExpressionData(),
                backgroundColor: '0x000000',
                alpha: 0.0,
            }
        );

        // カメラ位置を調整してアバターの顔サイズ・位置を制御
        // avatar-config.json のcameraパラメータをlocalStorageから読み込み
        let camParams = { posY: 1.73, posZ: 0.4, targetY: 1.62 }; // デフォルト
        // 以下既存コード（mode 変数宣言を削除したので、try ブロック内の mode 参照は上のもの使用）
        ...
    }
}
```

**注意:** 既存の `initialize()` 内にも `const mode = ...` が宣言されている場合、
重複宣言にならないよう、既存の宣言を削除するか `let` に変更する。

---

## 修正4: `src/scripts/chat/core-controller.ts`

### 4-1. import 追加

```typescript
import { i18n } from '../../constants/i18n';
import { AudioManager } from './audio-manager';
import { LiveAudioManager } from './live-audio-manager';
import { ensureDefaultAvatarInStorage } from '../../config/avatar-config'; // ★追加
```

### 4-2. `startLiveMode()` で `ensureDefaultAvatarInStorage()` を呼び、
`teacher_name` を `live_start` に追加

**重要:** Chatty-sp には `shop_id` パラメータが既にあります。これは**削除せず保持**し、
その上で `teacher_name` を追加してください。

```typescript
try {
  // LiveAudioManager初期化（マイク取得 + AudioWorklet設定）
  await this.liveAudioManager.initialize(this.socket);

  // ★ 新規ユーザー対応: デフォルトアバター情報をlocalStorageに確実に設定
  await ensureDefaultAvatarInStorage(this.currentMode);

  // サーバーにLiveAPIセッション開始を通知
  const voiceModel = localStorage.getItem(`selectedVoiceModel_${this.currentMode}`) || '';
  const liveVoice = localStorage.getItem(`selectedLiveVoice_${this.currentMode}`) || '';
  const teacherName = localStorage.getItem(`selectedTeacherName_${this.currentMode}`) || ''; // ★追加
  this.socket.emit('live_start', {
    session_id: this.sessionId,
    mode: this.currentMode,
    language: this.currentLanguage,
    voice_model: voiceModel,
    live_voice: liveVoice,
    teacher_name: teacherName, // ★追加
    shop_id: this.currentMode === 'concierge'
      ? (localStorage.getItem('selectedShop_concierge') || 'dennys')
      : '' // ★Chatty-sp固有: 既存のshop_idは必ず保持する
  });
  ...
```

---

## 修正5: `chatty-base/app_customer_support.py`

`handle_live_start()` で `teacher_name` を受け取り、
`user_profile['lesson_teacher_name']` に追加する。

**重要:** Chatty-sp の既存 `shop_id` 受信ロジックは**削除せず保持**すること。

```python
@socketio.on('live_start')
def handle_live_start(data):
    """LiveAPIセッション開始"""
    client_sid = request.sid
    session_id = data.get('session_id')
    mode = data.get('mode', 'chat')
    language = data.get('language', 'ja')
    voice_model = data.get('voice_model', '')
    live_voice = data.get('live_voice', '')
    shop_id = data.get('shop_id', '')  # ★既存: 保持する
    teacher_name = data.get('teacher_name', '')  # ★追加

    # 既存のLiveAPIセッションがあれば停止
    if client_sid in active_live_sessions:
        old_session = active_live_sessions[client_sid]
        old_session.stop()
        del active_live_sessions[client_sid]

    user_profile = None
    user_id = None
    if session_id:
        try:
            session = SupportSession(session_id)
            session_data = session.get_data()
            if session_data:
                user_id = session_data.get('user_id')
                is_first_visit = session_data.get('is_first_visit', True)
                profile = session_data.get('long_term_profile') or {}
                user_profile = {
                    'is_first_visit': is_first_visit,
                    'preferred_name': profile.get('preferred_name', ''),
                    'name_honorific': profile.get('name_honorific', ''),
                }
                # ★ アバター毎の講師名（フロントエンドから受信）
                if teacher_name:
                    user_profile['lesson_teacher_name'] = teacher_name
                logger.info(
                    f"[LiveAPI] ユーザープロファイル取得: "
                    f"first_visit={is_first_visit}, "
                    f"name={profile.get('preferred_name', '')}, "
                    f"teacher={teacher_name}"
                )
```

---

## 修正6: `chatty-base/live_api_handler.py`（確認のみ）

既存コードで `teacher_name = user_profile.get('lesson_teacher_name', 'Lisa')` と
なっている箇所を**変更しない**。
修正5 で `user_profile['lesson_teacher_name']` に値が入るので、既存コードが
そのまま動作する。

既存の動作を変えないこと。ハードコード `'Lisa'` はフォールバック用として残す。

---

## 実装手順

1. 修正前に `src/scripts/chat/lam-websocket-manager.ts` と
   `src/scripts/chat/core-controller.ts` の現在の `const mode` 宣言位置を
   確認し、重複宣言を避ける
2. 上記 1-5 の修正を順番に適用
3. Chatty-sp ローカルでビルド確認（`npm run build` 等）
4. コミット & プッシュ

## コミットメッセージ案

```
新規ユーザー初期表示修正 + アバター毎の講師名対応

1. 新規ユーザーがメルルの表示でカメラパラメータが初期値（posZ=0.4, targetY=1.62）
   のまま表示される問題を修正。
   avatar-config.ts に ensureDefaultAvatarInStorage() を追加し、
   localStorageが空の場合にモードのデフォルトアバター情報を初期化。
   lam-websocket-manager と core-controller の両方で初期化前に呼ぶ。

2. avatar-config.json に teacherName 項目を追加。
   各アバター毎に固有の呼び名を設定。
   フロントエンドから live_start イベントで teacher_name を送信し、
   バックエンドの user_profile の lesson_teacher_name に反映。

既存の shop_id パラメータはそのまま保持。
```

---

## 動作確認項目

- [ ] 新規ユーザー（localStorage 空の状態）で lesson モードを起動し、
      メルルが avatar-config.json のカメラパラメータで正しく表示される
- [ ] 新規ユーザーで concierge モードを起動し、エルフが正しく表示される
- [ ] アバターを切り替えた際に AI 講師の呼び名が変わる（発話で確認）
- [ ] Chatty-sp 固有の `shop_id` 機能が引き続き正常動作する
- [ ] コンシェルジュモードの店舗選択が正しく動作する

---

## Travel-sp 実装参照

Travel-sp リポジトリの以下のコミットを参考にできる:
- ブランチ: `claude/improvements-and-fixes-i3sLA`
- コミットハッシュ: `e22ff58` (新規ユーザー初期表示修正 + アバター毎の講師名対応)

Travel-sp と Chatty-sp の主な差分:
- Chatty-sp には `shop_id` パラメータあり → **保持**
- Travel-sp は 2モード（lesson, concierge）、Chatty-sp も同じ構造
- `MODE_DEFAULT_AVATAR` の内容は両者で同じ（lesson: meruru, concierge: elf）
