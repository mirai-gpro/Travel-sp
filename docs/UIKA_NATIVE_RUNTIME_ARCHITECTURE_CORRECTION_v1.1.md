# UIKA Native Runtime Architecture Correction v1.1

Version: 1.1
Date: 2026-10-13
Status: Implementation Source of Truth
Target repository: `mirai-gpro/Travel-sp`
Implementation branch: `poc/uika-native-runtime-v1`
Baseline: `e86f066e03ade49bbe137acaed750e301be4f99a`
Official UIKA reference: `ant-research/UIKA @ c539f41df842ff21faba49cd60e65e73774e8fbd`
Existing LAM renderer: `gaussian-splat-renderer-for-lam@0.0.9-alpha.1`

## 0. 本仕様の目的

UIKA 133,541 Gaussian アバターを Travel-sp 上でリアルタイムA2E駆動するにあたり、従来の「UIKAをLAM OAC runtimeへ適合させる」方式を廃止し、UIKA本来のデータ構造を維持した UIKA Native Runtime を構築する。

今回の問題は、単なるリップシンクタイミング調整ではない。

旧方式ではUIKAを、

```
LAM skin.glb
LAM animation.glb
LAM skeleton
LAM bind-space
LAM head bone
LAM WebRender OAC lifecycle
```

へ組み込み、その不整合をUIKA専用runtime patchで補償していた。

その結果、

```
bind-space compensation
head-bone neutralization
camera compensation
rigidPivot
morphFast
sort interception
provider/cache
warm-up
procedural blink
```

等の補償コードが増加した。

本仕様では、この方向を根本的に修正する。

## 1. Architecture Decision

UIKA Native v1 の基本構成を以下に固定する。

```
Gemini Live / Audio
        │
        ▼
既存A2E
ARKit52 @ 30fps
        │
        ▼
Name Mapping
        │
        ▼
既存日本語口形補正
        │
        ▼
51 UIKA deformation weights
        │
        ▼
D_UIKA
        │
        ▼
UIKA canonical 133,541 Gaussian xyz
        │
        ▼
UIKA Native Render Adapter
        │
        ▼
Gaussian Rasterizer
```

UIKA Native runtimeに、

```
LAM animation.glb
LAM skeleton
LAM headBone
LAM bind-space
LAM state animation
```

を含めない。

## 2. 絶対前提

現在の通常LAM Liveリップシンクは正常である。

したがって以下を変更しない。

* Gemini Live
* A2E backend
* ARKit52生成処理
* backend `live_audio`
* backend `live_expression`
* Socket.IO protocol
* LiveAudioManagerの基本同期ロジック
* 通常LAM renderer経路
* 通常LAM OAC asset
* 通常LAM camera
* 通常LAM animation

UIKA実装のために共通系を変更してはならない。

## 3. 流用するもの

### 3.1 A2E

既存LAM-A2Eをそのまま使用する。

```
input  : 16kHz audio
output : ARKit52
rate   : 30fps
```

再学習しない。
ARKit52→FLAME100等の新規変換を導入しない。

### 3.2 ARKit name contract

index位置の推測は禁止。

必ず、

```
expression_names
```

をSource of Truthとしてname mappingする。

UIKA basisは51 channel。
A2E側の `tongueOut` はUIKA basisに存在しないため明示的にdropする。

### 3.3 日本語口形補正

既存productionで使用している、

* mouthStretch
* jawOpen
* mouthFunnel
* mouthPucker
* イ／エ系jaw抑制
* anti-mumbling jaw floor

をUIKA Native `UikaExpressionMapper`へ移植・再利用する。
新しい補正を追加しない。

## 4. D_UIKA

D_UIKA方式を維持する。

定義：

```
D_UIKA[k,i]
 =
Σj bary[i,j]
×
D_FLAME[k, vertex_index[i,j]]
```

これは公式UIKAでFLAME属性をGaussianへ転送するbarycentric interpolation構造と整合する。

UIKA Native v1 のA2E facial deformationは、

```
P_i(frame)
 =
P_i(canonical)
 +
Σk weight_k(frame) × D_UIKA[k,i]
```

とする。

## 5. UIKA canonical asset

現PoCでは以下を使用する。

```
Gaussian count = 133,541
Basis count    = 51
```

canonical appearanceとして、

* xyz
* RGB / SH
* opacity
* Gaussian rotation
* Gaussian scaling

を保持する。

表情で変更する基本対象はxyz。

## 6. migration source ZIP

現在の、

```
public/avatar/uika-gakki-133k.zip
```

は当面利用してよい。

ただしこれは、
UIKA Native runtime format
ではなく、
既に検証済みのUIKAデータを取り出すためのmigration container
としてのみ扱う。

使用してよい内容：

```
skin.glb POSITION
skin.glb 51 morph deltas
skin.glb morph target names
offset.ply xyz
offset.ply Gaussian appearance
```

無視するもの：

```
animation.glb
vertex_order.json のLAM rendering semantics
skin/joint animation
JOINTS_0
WEIGHTS_0
inverse bind matrices
LAM skeleton
```

将来的にはUIKA Native packageへ分離する。

## 7. Gaussian renderer

`gaussian-splat-renderer-for-lam@0.0.9-alpha.1` 全体をLAM runtimeとして使用するのではなく、
Gaussian Viewer / rasterizer layer
だけを再利用する。

Gate 0確認結果：

```
Viewer public export          PASS
SceneFormat public export     PASS
SplatMesh public export       FAIL
Direct PLY route              PASS
LAM OAC runtime required      NO
```

UIKA Nativeでは、

```
Viewer
↓
addSplatScene(... SceneFormat.Ply ...)
```

を基本とする。

`GaussianSplatRenderer.getInstance()` をUIKA Native runtime ownerとして使用しない。

> **訂正あり。** 本章の Gate 0 判定のうち `Direct PLY route = PASS` は
> 実browser runtime検証により撤回された。§31 と
> `docs/UIKA_NATIVE_RUNTIME_GATE0_CORRECTION.md` を参照。

## 8. 廃止するLAM依存

UIKA Native v1では以下を使用禁止とする。

```
animation.glb
LAM AnimationManager
LAM 262-joint skeleton
headBoneIndex
LAM head bone transform
LAM bind-space
UIKA_CANO_TO_LAM_BIND
rigid
rigidPivot
H_head neutralization
LAM state clips
cameraによるhead compensation
```

## 9. 廃止する旧UIKA patch

新Native経路へ以下を持ち込まない。

```
morphFast monkey-patch
sortMode patch
expression provider/cache A/B
procedural blink
legacy warm-up
OrbitControls monkey-patch
legacy UIKA animation override
```

ただし旧 `?uika133k=1` コード自体は比較対象として当面保存する。
Native runtimeから旧経路への自動fallbackは禁止。

## 10. UIKA Native Driver

以下の責務を分離する。

```
UikaNativeDriver
 ├─ UikaNativeAssetLoader
 ├─ UikaExpressionMapper
 ├─ UikaRenderAdapter
 └─ Expression Source
```

## 11. UikaNativeAssetLoader

責務：

* source asset取得
* SHA-256確認
* Gaussian数検証
* basis数検証
* basis names検証
* NaN / Inf検証
* canonical xyz再構築
* D_UIKA検証
* canonical appearance取得

異常時は失敗させる。
推測によるdefault補完は禁止。

## 12. UikaExpressionMapper

入力：

```
expression_names
ARKit52 values
```

処理：

```
name mapping
↓
production JP mouth correction
↓
51 basis weights
```

出力：

```
Float32Array(51)
```

責務外：

* AudioContext
* render loop
* camera
* skeleton
* Live timing

## 13. UikaRenderAdapter

責務：

* Viewer生成
* canonical Gaussian load
* UIKA camera適用
* expression deformation
* render
* frame timing測定
* GL error測定

禁止：

```
LAM skeleton
LAM AnimationManager
headBone
bind-space
animation.glb
```

## 14. Per-frame Runtime

最終目標：

```
D_UIKA
   ↓
GPU resident

毎frame:
51 weightsだけ更新
   ↓
shader
   ↓
133541 Gaussian xyz
   ↓
render
```

ただし、GPU方式を事前に決め打ちしない。
renderer実装を確認し、

* GPU basis evaluation
* position buffer update
* texture update

のどの方式が正しく利用できるか確認して決定する。
APIを推測して実装してはならない。

## 15. Gate 0 — Renderer Capability

Status: PASS

確認済み：

```
Viewer public            PASS
SceneFormat public       PASS
direct PLY rendering     PASS
OAC runtime dependency   NO
```

Gate 0を再実装しない。

> **訂正あり。** `direct PLY rendering = PASS` は撤回。§31 を参照。

## 16. Gate 1 — Neutral Native Render

入力：

```
UIKA canonical 133541
expression = zero
skeleton = none
Live = none
```

合格条件：

```
Gaussian count == 133541
basisCount == 51
NaN == 0
Inf == 0
GL error == 0
正常なneutral UIKA表示
```

現状：

```
IMPLEMENTATION = COMPLETE
BROWSER RUNTIME VALIDATION = UNVERIFIED
```

> **更新あり。** `BROWSER RUNTIME VALIDATION = FAIL`。§31 を参照。

## 17. Gate 2 — Deterministic Morph

以下を1channelずつ適用する。

```
jawOpen = 1.0
mouthSmileLeft = 1.0
mouthSmileRight = 1.0
eyeBlinkLeft = 1.0
eyeBlinkRight = 1.0
```

各テスト後neutralへ戻す。

確認：

* 正しい部位
* 正しい左右
* 正しい方向
* 異常変形なし
* neutral復帰
* offline referenceとの数値一致

現在は正しさ確認のため、

```
CPU deformation
→ temporary PLY
→ Viewer reload
```

として実装されている。
これはGate 2専用であり、リアルタイム方式ではない。

現状：

```
IMPLEMENTATION = COMPLETE
BROWSER RUNTIME VALIDATION = UNVERIFIED
```

## 18. Gate 3開始条件

以下の両方がPASSになるまでGate 3へ進んではならない。

```
Gate 1 Browser Runtime = PASS
Gate 2 Browser Runtime = PASS
```

画面：

```
/uika-native-v1
```

## 19. Gate 3A — Dynamic Update Capability Audit

Gate 3実装前に追加する必須sub-gate。

目的：
Viewerを再生成せず、既存133K Gaussianを毎frame変形する正しいAPI/内部経路を確定する。

確認対象：

1. Gaussian positionのGPU/CPU保存形式
2. actual splat center buffer/texture
3. position更新API
4. update後のsortとの関係
5. shader側expression追加可能性
6. GPU texture上限
7. update後に必要なdirty/update flag
8. Viewer lifecycle
9. private APIを使う場合の正確なversion dependency

成果物には必ず、

```
package version
source file
line / symbol
actual data structure
actual update call
```

を記録する。

確認できないAPIを推測で呼ばない。

## 20. Gate 3 — Fixed Real-A2E Replay

既存のreal A2E capture/replayを使用する。
Liveは使用しない。

入力：

```
captured real A2E
52 coefficients
30fps
```

経路：

```
Fixed A2E fixture
↓
expression_names
↓
UikaExpressionMapper
↓
51 weights
↓
UikaRenderAdapter
↓
UIKA Native 133K
```

以下を通さない。

```
Gemini Live
Socket.IO arrival timing
LiveAudioManager buffer timing
backend chunk timing
```

合格条件：

* 口形が正しい
* 表情が正しい
* 30fps time-baseで進行
* visible hold/jumpなし
* legacy patchなし
* skeletonなし
* Viewer再生成なし
* PLY再生成/reloadを毎frame行わない

## 21. Gate 4 — 30fps Performance

Gate 3 correctness PASS後に行う。

測定：

```
expression mapping
deformation evaluation
GPU upload
sort
rasterization
total frame
```

記録：

```
frame count
p50
p95
p99
max
>33ms
>50ms
>100ms
```

目標：

```
30fps
```

performance不足時も、まずボトルネックを分類する。
旧LAM OAC方式へ戻すことは禁止。

## 22. Gate 5 — Live Integration

Gate 1〜4 PASS後のみ実施。

```
Existing LiveAudioManager
↓
existing A2E frames
↓
UikaExpressionMapper
↓
UikaNativeDriver
```

Backend変更なし。
LiveAudioManager変更なし。
A2E変更なし。
通常LAM変更なし。

UIKA driverがREADYになるまでUIKA Liveを開始しない。

## 23. Gate 6 — Head / Idle Motion

v1 facial lipsync完成後の別phase。
初期Live完成条件に含めない。

候補：

* UIKA native FLAME pose
* independent rigid head transform
* UIKA-specific pose layer

LAM animation.glbを暗黙流用しない。

## 24. Travel-sp最小並列実装

Native v1は明示的な独立routeで構築する。

PoC段階では：

```
/uika-native-v1
```

を使用する。

その後Travel-sp本画面へ統合する場合も、

```
Normal LAM path
UIKA Native path
```

を明確に分岐する。

通常LAM path内へUIKA条件分岐を大量に追加しない。

## 25. 旧UIKA path

旧：

```
?uika133k=1
```

は比較用。

Native：

```
/uika-native-v1
```

または将来：

```
?uikaNativeV1=1
```

旧pathとNative pathを混在させない。

## 26. 禁止事項

以下を禁止する。

* backend修正
* A2E修正
* LiveAudioManager修正
* 通常LAM修正
* shared AV scheduler追加
* FLAME100変換追加
* UIKA retraining
* VHAP再導入
* LAM skeleton再導入
* animation.glb再導入
* bind-space補償
* legacy monkey-patch移植
* 推測によるAPI利用
* Gateを飛ばしてLiveへ接続
* エラー時のsilent fallback
* production merge
* production deploy

## 27. STOP条件

以下の場合は実装を止めて報告する。

1. Gate 1/2が実ブラウザでPASSしない
2. D_UIKA結果がoffline referenceと一致しない
3. Viewerでdynamic xyz更新経路が確認できない
4. 133K dynamic updateがrenderer構造上成立しない
5. LAM skeletonを使わないと進められない
6. canonical appearanceを意図せず変更する必要がある
7. 通常LAM側変更が必要になる
8. A2E/backend変更が必要に見える

その場で workaroundを作らない。

## 28. 現在のステータス

```
Gate 0
Renderer/API capability
PASS

Gate 1
Neutral Native Render
IMPLEMENTED
RUNTIME VALIDATION REQUIRED

Gate 2
Deterministic Morph
IMPLEMENTED
RUNTIME VALIDATION REQUIRED

Gate 3A
Dynamic Update Capability Audit
NOT STARTED

Gate 3
Fixed Real-A2E Replay
NOT STARTED

Gate 4
30fps Performance
NOT STARTED

Gate 5
Live
NOT STARTED

Gate 6
Head/Idle
OUT OF v1 FACIAL SCOPE
```

> **更新あり。** 実測後のステータスは §31 を参照。

## 29. 完了条件

UIKA Native facial runtime v1は以下で完成とする。

1. canonical UIKA 133,541をLAM skeletonなしで表示
2. 51 D_UIKA morphが正しく動作
3. fixed real-A2E replayがNative runtimeで正常動作
4. 30fps browser performance成立
5. real Live A2Eで通常LAM同等の連続リップシンク
6. backend/A2E/LiveAudioManager変更なし
7. 通常LAM回帰なし
8. legacy UIKA monkey-patch不要
9. LAM skeleton/animation.glb不要

## 30. 最終設計原則

UIKAをLAMに似せるのではない。

既に正しい、

```
A2E
→ ARKit52
→ D_UIKA
```

をUIKA Native runtimeへ正しく接続する。

再利用するのは、
Gaussian rendering technology
であり、
LAM avatar runtime semantics
ではない。

今後の実装・レビュー・判断はすべてこの原則をSource of Truthとする。

---

## 31. 追記 — Gate 3A 実測による訂正 (2026-10-13)

本章は v1.1 本文を**取り消さず**、実browser runtime検証で判明した事実を追記するものである。
根拠の全文は `docs/UIKA_NATIVE_RUNTIME_GATE3A_DYNAMIC_UPDATE_AUDIT.md` に記録済み。

### 31.1 §7 / §15 の `Direct PLY route = PASS` は撤回

素の `new Viewer(...)` + `addSplatScene(...)` は
`gaussian-splat-renderer-for-lam@0.0.9-alpha.1` では**完了しない**。

```text
SplatMesh.setupDataTextures()  (bundle 64586-64598)
  -> this.flameModel.geometry.morphAttributes.position.length   // flameModel は null
```

`SplatMesh.flameModel` は constructor で `null` (63786)、代入は 139397 の1箇所のみで
LAM OAC `loadModel()` 経路でしか通らない。結果として scene build が途中で TypeError
となり、`splatRenderReady` が false のまま `addSplatScene` の promise が settle しない。

旧 Gate 0 の `GATE0_DIRECT_PLY_ROUTE = PASS` は compile probe と source audit に基づく
判定であり、runtime を実行した結果ではなかった。`Viewer` / `SceneFormat` が public
named export である事実は変わらない。

### 31.2 §16 Gate 1 は実browserで FAIL

```text
phase          = "loading-renderer" のまま (90回ポーリング / 約3分)
ready          = false
renderedFrames = 0
errors         = []        ← ページ自身が失敗を検知できない
画面            = 全面黒
```

### 31.3 §17 Gate 2 は未実行

Gate 1 FAIL のため実行していない。

### 31.4 §19 Gate 3A の結論

* GPU basis evaluation の数式自体は既に shader 内に存在し (bundle 61742-61769)、
  `133541 × 52 = 6,944,132 texels ≤ 4096×2048 = 8,388,608` で容量にも収まる。
* CPU xyz upload 経路 (`updateTetureAfterBSAndSkeleton`, 64775) も存在する。
* ただし**両経路とも `flameModel` 必須**のため、現状どちらも到達不能。
* `Viewer.update()` は `avatarMesh` (null) を無条件参照するため使用不可。
  `render()` / `runSplatSort()` は使用可。

### 31.5 §27 STOP条件への該当と決定

```text
§27.1 Gate 1/2 が実ブラウザでPASSしない     -> HIT
§27.3 dynamic xyz 更新経路が確認できない     -> HIT
```

この結果を受け、以下を正式決定した (2026-10-13)。

**採用: project-owned minimal renderer adapter/fork (Gate 3B)**

**不採用: `viewer.splatMesh.flameModel` への fake data injection**

不採用の理由：

1. `flameModel` は LAM OAC semantics そのものへの依存である
2. `setupDataTextures()` が skeleton / bone texture を要求する
3. `Viewer.update()` も OAC 側 `avatarMesh` を要求する
4. 133,541点では既存固定 boneWeight texture 容量にも構造上の問題がある
   (`buildBoneWeightTexture` は 512×512 固定、必要 index 1,068,324 > 1,048,576)
5. これを回避するにはさらに dummy skeleton / fake bones / private member 操作が必要になる
6. それは本 Architecture Correction に反する

### 31.6 Native経路で作ってはいけないもの (追加禁止事項)

§26 に以下を追加する。

```
fake flameModel
dummy LAM skeleton
dummy head bone
dummy animation.glb
fake avatarMesh
boneWeightTexture を成立させるためだけの JOINTS / WEIGHTS
private flameModel injection
prototype monkey-patch
```

### 31.7 更新後のステータス

```
Gate 0   Renderer/API capability        PARTIAL (export=PASS / bare Viewer runtime=FAIL)
Gate 1   Neutral Native Render          FAIL (旧 Viewer 経路)
Gate 2   Deterministic Morph            NOT RUN
Gate 3A  Dynamic Update Capability      DONE (STOP条件該当)
Gate 3B  Project-Owned Minimal Renderer IN PROGRESS
Gate 3   Fixed Real-A2E Replay          NOT STARTED
Gate 4   30fps Performance              NOT STARTED
Gate 5   Live                           NOT STARTED
Gate 6   Head/Idle                      OUT OF v1 FACIAL SCOPE
```
