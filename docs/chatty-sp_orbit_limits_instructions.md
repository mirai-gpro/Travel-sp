# Chatty-sp 向け指示書: アバター可動域制限の追加

## 前提

- 対象リポジトリ: `mirai-gpro/Chatty-sp`
- 対象ブランチ: `claude/refactor-reset-logic-eXNFd`（またはユーザー指定のブランチ）
- Travel-sp で実施済みの修正を Chatty-sp にも適用する

## 背景

アバター表示エリアでカーソル操作（マウス/タッチ）により、上下左右の顔の向きや
顔の拡大・縮小が自由にできるが、可動範囲が広すぎて以下の問題がある：

- 顔の裏側（後頭部）が見える
- 頭のてっぺん（頭頂）が見える
- データ範囲外の領域まで表示される

## 対策

`public/avatar/orbit-limits.json` に可動域制限値を定義し、
`lam-websocket-manager.ts` の `initialize()` 内で読み込んで
Three.js OrbitControls に適用する。

**設計方針：**
- アバター毎の設定ではなく、**全アバター共通の単一JSONファイル**で集約管理
- `avatar-config.json` を複雑にしない
- 数値調整だけでデプロイ可能（コード再ビルド不要）

---

## 修正対象ファイル（2ファイル）

1. **新規作成：** `public/avatar/orbit-limits.json`
2. **修正：** `src/scripts/chat/lam-websocket-manager.ts`

---

## 修正1: `public/avatar/orbit-limits.json`（新規作成）

以下の内容で新規ファイルを作成する：

```json
{
  "minPolarAngle": 1.17,
  "_minPolarAngle_説明": "上方向の制限（ラジアン）。π/2(=1.57)が水平、小さいほど上を向く。1.17 ≈ 67度（顔をやや見上げる位置まで）",

  "maxPolarAngle": 1.87,
  "_maxPolarAngle_説明": "下方向の制限（ラジアン）。1.87 ≈ 107度（顔をやや見下ろす位置まで）。これより大きくすると頭頂や後頭部が見えてしまう",

  "minAzimuthAngle": -1.05,
  "_minAzimuthAngle_説明": "左方向の水平回転制限（ラジアン）。-1.05 ≈ -60度（左横顔まで）",

  "maxAzimuthAngle": 1.05,
  "_maxAzimuthAngle_説明": "右方向の水平回転制限（ラジアン）。1.05 ≈ +60度（右横顔まで）。これを超えると顔の裏側が見えてしまう",

  "minDistance": 0.25,
  "_minDistance_説明": "ズームインの上限（カメラと注視点の最短距離）。小さくすると顔のアップに寄れる",

  "maxDistance": 0.8,
  "_maxDistance_説明": "ズームアウトの上限（カメラと注視点の最長距離）。大きくすると上半身まで引いて見える"
}
```

**注意：**
- `_xxx_説明`フィールドはコメント代わり。コード側は`typeof === 'number'`チェックで弾くので影響なし
- 値はすべてラジアン or 距離の数値
- 後でアバターの見え方を見て調整可能

---

## 修正2: `src/scripts/chat/lam-websocket-manager.ts`

`initialize()` メソッド内の `controls.target.set(0, camParams.targetY, 0);` と
`controls.update();` の間に fetch + 適用ロジックを追加する。

### 修正前（現状コード）

```typescript
if (this.renderer.viewer && this.renderer.viewer.camera) {
    const camera = this.renderer.viewer.camera;
    camera.position.z = camParams.posZ;
    camera.position.y = camParams.posY;

    // 注視点（controls.target）を顔〜首の高さに合わせる
    const controls = this.renderer.viewer.controls;
    if (controls) {
        controls.target.set(0, camParams.targetY, 0);
        controls.update();
    }

    camera.updateProjectionMatrix();
    console.log('[LAMWebSocketManager] カメラ位置調整: y=', camera.position.y, 'z=', camera.position.z, 'target.y=', controls?.target?.y);
}
```

### 修正後

```typescript
if (this.renderer.viewer && this.renderer.viewer.camera) {
    const camera = this.renderer.viewer.camera;
    camera.position.z = camParams.posZ;
    camera.position.y = camParams.posY;

    // 注視点（controls.target）を顔〜首の高さに合わせる
    const controls = this.renderer.viewer.controls;
    if (controls) {
        controls.target.set(0, camParams.targetY, 0);

        // ★ カーソル操作の可動域制限（orbit-limits.jsonから読み込み）
        try {
            const resp = await fetch('/avatar/orbit-limits.json');
            if (resp.ok) {
                const limits = await resp.json();
                if (typeof limits.minPolarAngle === 'number') controls.minPolarAngle = limits.minPolarAngle;
                if (typeof limits.maxPolarAngle === 'number') controls.maxPolarAngle = limits.maxPolarAngle;
                if (typeof limits.minAzimuthAngle === 'number') controls.minAzimuthAngle = limits.minAzimuthAngle;
                if (typeof limits.maxAzimuthAngle === 'number') controls.maxAzimuthAngle = limits.maxAzimuthAngle;
                if (typeof limits.minDistance === 'number') controls.minDistance = limits.minDistance;
                if (typeof limits.maxDistance === 'number') controls.maxDistance = limits.maxDistance;
                console.log('[LAMWebSocketManager] orbit-limits適用:', limits);
            }
        } catch (e) {
            console.warn('[LAMWebSocketManager] orbit-limits.json読み込み失敗、制限なし', e);
        }

        controls.update();
    }

    camera.updateProjectionMatrix();
    console.log('[LAMWebSocketManager] カメラ位置調整: y=', camera.position.y, 'z=', camera.position.z, 'target.y=', controls?.target?.y);
}
```

**注意：**
- `initialize()` メソッドはすでに `async` なので `await fetch()` が使える
- `_xxx_説明`の文字列フィールドは`typeof === 'number'`チェックで自動的にスキップされる
- 読み込み失敗時はログ警告のみで制限なし状態にフォールバック

---

## 実装手順

1. `public/avatar/orbit-limits.json` を新規作成
2. `src/scripts/chat/lam-websocket-manager.ts` の `initialize()` を上記の通り修正
3. ローカルでビルド確認（`npm run build` 等）
4. コミット & プッシュ
5. デプロイ後、アバターの可動域が制限されていることを確認

---

## コミットメッセージ案

```
アバターのカーソル可動域を制限

public/avatar/orbit-limits.json を新規作成し、
lam-websocket-manager.tsで読み込んでThree.js OrbitControlsに適用。
顔の裏側や頭頂などデータ範囲外の表示を防止。

- 上下: 約67〜107度（やや見上げ〜やや見下ろし）
- 左右: ±60度（横顔まで）
- ズーム: 0.25〜0.8

orbit-limits.json の値を調整するだけで全アバター共通で可動域を変更可能。
```

---

## 動作確認項目

- [ ] 新規作成した `orbit-limits.json` が `public/avatar/` 配下に存在する
- [ ] アバター表示エリアで上方向にドラッグしても頭頂が見えない
- [ ] アバター表示エリアで下方向にドラッグしても顎下/首の中まで見えない
- [ ] アバター表示エリアで左右にドラッグしても顔の裏側（後頭部）が見えない
- [ ] ズームイン/アウトが妥当な範囲に制限されている
- [ ] ブラウザコンソールに `[LAMWebSocketManager] orbit-limits適用:` のログが出る

---

## パラメータ調整の指針（必要に応じて）

| 症状 | 調整するパラメータ | 方向 |
|-----|-----------------|-----|
| もっと下まで見えるようにしたい | `maxPolarAngle` | 大きく（例: 2.0） |
| もっと上まで見えるようにしたい | `minPolarAngle` | 小さく（例: 1.0） |
| もっと横まで回せるようにしたい | `minAzimuthAngle`/`maxAzimuthAngle` | より大きい絶対値（例: ±1.3） |
| もっとアップに寄れるようにしたい | `minDistance` | 小さく（例: 0.2） |
| もっと引きで見たい | `maxDistance` | 大きく（例: 1.0） |

数値だけ変更してプッシュすればデプロイで即反映される（コード変更なし）。

---

## Travel-sp 実装参照

Travel-sp リポジトリの以下のコミットを参考にできる:
- ブランチ: `claude/improvements-and-fixes-i3sLA`
- コミットハッシュ: `f3eeee9` (orbit-limits.json コメント追加版)
- 元のコミット: `111c2b8` (アバターのカーソル可動域を制限)

Travel-sp と Chatty-sp の構造はほぼ同一なので、上記コードをそのまま適用可能。
