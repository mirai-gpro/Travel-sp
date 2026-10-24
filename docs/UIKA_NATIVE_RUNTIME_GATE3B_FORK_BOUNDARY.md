# UIKA Native Runtime — Gate 3B Fork Boundary

**Date:** 2026-10-14
**Spec:** `docs/UIKA_NATIVE_RUNTIME_ARCHITECTURE_CORRECTION_v1.1.md` (§31.5 の決定に基づく)
**Branch:** `poc/uika-native-runtime-v1`
**Start HEAD:** `a7376b3a0fdc7a1aee7900001a8b122759b14bfa`

本書は、コードを1行もコピーする前に行った source audit の結果である。
すべて実測。推測でファイルを選んでいない。

---

## 1. 現在インストールされている package

```text
name       : gaussian-splat-renderer-for-lam
version    : 0.0.9-alpha.1
module     : build/gaussian-splat-renderer-for-lam.module.js   (4,067,925 B)
sourcemap  : build/gaussian-splat-renderer-for-lam.module.js.map (8,476,675 B)
umd        : package.json の files には記載があるが、インストール済みツリーには存在しない
license    : MIT, "Copyright (c) 2023 Mark Kellogg"
dependencies     : { "three": "^0.173.0" }
peerDependencies : なし
```

package の file tree は 5 ファイルのみ：

```text
LICENSE
README.md
package.json
build/gaussian-splat-renderer-for-lam.module.js
build/gaussian-splat-renderer-for-lam.module.js.map
```

### 1.1 build 前 source は package 内に存在するか

`src/` ディレクトリとしては**存在しない**。bundle だけである。

ただし `.map` が `sourcesContent` を持っており、**120 件すべての原本ソースが完全に含まれている**。
うち `../src/**` は 58 件。これを抽出して audit に使用した。
（抽出は scratchpad 内で行い、リポジトリには置いていない。）

### 1.2 provenance

`README.md` 冒頭、原文：

> 3D Gaussian Splatting Renderer for [LAM: Large Avatar Model for One-shot Animatable
> Gaussian Head](https://github.com/aigc3d/LAM), developed based on
> [@mkkellogg/gaussian-splats-3d](https://github.com/mkkellogg/GaussianSplats3D).

`LICENSE` の著作権表示も `Copyright (c) 2023 Mark Kellogg`（= GaussianSplats3D 本家）である。

---

## 2. 本家 GaussianSplats3D との差分の由来（実測）

`@mkkellogg/gaussian-splats-3d` の 0.4.5 / 0.4.6 / 0.4.7 を npm から取得し、
同じ方法で source map から原本ソースを抽出して、LAM 版 51 個の `.js` と byte 比較した。

```text
vs 0.4.5 : identical 36 / differing 15
vs 0.4.6 : identical 41 / differing 10      <-- 最も近い
vs 0.4.7 : identical 30 / differing 21
```

**base は `@mkkellogg/gaussian-splats-3d@0.4.6`** と判断する。

0.4.6 と異なる 10 ファイルの差分量：

| file | +added | -removed | 性質 |
| --- | ---: | ---: | --- |
| `Viewer.js` | 2570 | 1780 | LAM runtime（`avatarMesh` / `runMorphUpdate` / `frame` / chat state）+ 全面再整形 |
| `splatmesh/SplatMaterial.js` | 233 | 5 | FLAME morph / bone / skinning shader ブロック |
| `splatmesh/SplatMesh.js` | 225 | 16 | `flameModel` / `bonesMatrix` / `bonesWeight` / bone texture 群、splat tree build の削除 |
| `raycaster/Raycaster.js` | 17 | 19 | ray 判定の調整 |
| `loaders/SplatBuffer.js` | 14 | 5 | `getSplatCenter` / `fillSplatCenterArray` に `morphedMesh` 加算引数を追加 |
| `splatmesh/SplatMaterial3D.js` | 12 | 5 | fragment の discard 条件変更、未使用 varying 追加 |
| `loaders/ply/INRIAV1PlyParser.js` | 6 | 3 | `f_dc_*` の色変換を SH 変換から linear 直結へ変更 |
| `worker/SortWorker.js` | 2 | 2 | render/sort count の `Math.min(..., uploadedSplatCount)` clamp を削除 |
| `splattree/SplatTree.js` | 1 | 1 | `processSplatMesh` を function → arrow |
| `splatmesh/SplatGeometry.js` | 0 | 0 | 空白のみ |

つまり **51 ファイル中 41 が本家 0.4.6 と byte 一致**で、LAM 固有部分は
`Viewer.js` / `SplatMaterial.js` / `SplatMesh.js` の 3 ファイルにほぼ集中している。

---

## 3. fork に持ち込まないもの（確定）

v1.1 §8 / §9 / §31.6 に対応。

```text
src/render.ts          GaussianSplatRenderer OAC owner / GLTFLoader / jszip / axios / nprogress
src/state.ts           AnimationManager / chat state / state clips
src/interface.ts       OAC public interface
src/Viewer.js          LAM runtime (avatarMesh, runMorphUpdate, frame, getChatState)
```

`SplatMaterial.js` / `SplatMesh.js` の LAM 追加分：

```text
flameModel
expressionBSNum
bsWeight / morphTargetDictionary
bonesMatrix / bonesNum / bonesWeight
buildModelTexture / buildBoneMatrixTexture / updateBoneMatrixTexture / buildBoneWeightTexture
updateTetureAfterBSAndSkeleton
boneTexture / boneTexture0 / boneWeightTexture / flameModelTexture
headBoneIndex / bindMatrix / bindMatrixInverse
USE_FLAME / USE_SKINNING shader branch
skeleton / skinIndex / skinWeight
```

これらは本家 0.4.6 には**存在しない**（LAM が追加したもの）。
したがって本家 0.4.6 をそのまま fork すれば、除外のために削る作業は発生しない。

また `SplatBuffer.getSplatCenter` / `fillSplatCenterArray` の `morphedMesh` 引数も
持ち込まない。UIKA Native の変形は GPU 側で行うため、CPU center fill に
変形を注入する必要がないからである。

---

## 4. fork に必要なもの（import closure 実測）

`Viewer.js` を entry にした closure は 50 ファイル（+ 4 wasm）。
`SplatMesh.js` を entry にした closure は 15 ファイル。
外部依存は `three` のみ（`three/tsl` は `Viewer.js` 経由のみで、fork しないので不要）。

UIKA Native が必要とするのは次の集合である。

### 4.1 本家 0.4.6 から逐語コピー（UIKA 変更なし）

```text
Constants.js
LogLevel.js
SplatRenderMode.js
SceneRevealMode.js
Util.js
AbortablePromise.js
three-shim/WebGLExtensions.js
three-shim/WebGLCapabilities.js
splatmesh/SplatGeometry.js
splatmesh/SplatScene.js
splattree/SplatTree.js
loaders/SplatBuffer.js
loaders/UncompressedSplatArray.js
loaders/SplatPartitioner.js
loaders/SplatBufferGenerator.js
loaders/SceneFormat.js
loaders/Utils.js
loaders/LoaderStatus.js
loaders/DirectLoadError.js
loaders/InternalLoadType.js
loaders/ply/PlyFormat.js
loaders/ply/PlyParser.js
loaders/ply/PlyParserUtils.js
loaders/ply/INRIAV2PlyParser.js
loaders/ply/PlayCanvasCompressedPlyParser.js
loaders/ply/PlyLoader.js
worker/SortWorker.js
```

### 4.2 本家 0.4.6 + UIKA 独自変更

```text
loaders/ply/INRIAV1PlyParser.js   色変換（§5.1）
splatmesh/SplatMaterial.js        UIKA basis block の追加（§5.2）
splatmesh/SplatMaterial3D.js      fragment discard 条件（§5.3）
splatmesh/SplatMesh.js            UIKA basis texture / weights / distance shader（§5.4）
```

### 4.3 fork しない（project 独自に新規作成）

```text
Viewer.js  ->  uika-gaussian-viewer.ts   (新規、最小)
```

`Viewer.js` は 99,005 B で LAM runtime が全面に織り込まれている。
必要なのは「sort worker をまわして render index を更新し、描画する」という
数百行分の責務だけなので、fork せず project 独自に書く。

### 4.4 不要（closure に入るが UIKA Native では使わない）

```text
OrbitControls.js      UIKA camera は meta 固定
SceneHelper.js / ArrowHelper.js
ui/LoadingSpinner.js / LoadingProgressBar.js / InfoPanel.js / ui/Util.js
raycaster/*           pick 不要
webxr/*               WebXR 不要
loaders/splat/*       .splat 読まない
loaders/ksplat/*      .ksplat 読まない
splatmesh/SplatMaterial2D.js   SplatRenderMode.ThreeD のみ使用
```

---

## 5. UIKA 独自変更の内訳と根拠

### 5.1 `INRIAV1PlyParser` の色変換

本家 0.4.6：

```js
const SH_C0 = 0.28209479177387814;
newSplat[OFFSET_FDC0] = (0.5 + SH_C0 * rawSplat[F_DC_0]) * 255;
```

UIKA Native：

```js
newSplat[OFFSET_FDC0] = rawSplat[F_DC_0] * 255;
```

**根拠（実測）。** `uika-gakki-133k.zip` の `offset.ply` は
`property float f_dc_0/1/2` を持つが、その値域は

```text
f_dc_0  min +0.00000  med +0.26602  max +0.99947   [0,1] 外は 0 / 133541 件
f_dc_1  min +0.00000  med +0.23943  max +1.00000
f_dc_2  min +0.00000  med +0.23982  max +1.00000
```

で、**全点が [0,1] に収まっている**。これは SH DC 係数ではなく linear RGB である。
本家の式を適用すると全画素が約 128〜200 に圧縮され、色が破綻する。

LAM 版も同じ変更をしているが、ここでは LAM に合わせたのではなく、
asset の実測値から決定した。

### 5.2 `SplatMaterial.js` の UIKA basis block

本家 0.4.6 の vertex shader には morph/blendshape のコードが**一切ない**
（LAM の +233 行がそれを足したもの）。したがって除去作業は不要で、
UIKA 独自の block を新規に足す。

LAM の命名・storage contract は持ち込まない（v1.1 §10 相当）。

| LAM | UIKA Native |
| --- | --- |
| `flameModelTexture` | `uikaBasisTexture` |
| `flameModelTextureSize` | `uikaBasisTextureSize` |
| `boneTexture`（の bsWeight 領域） | `uikaWeightTexture` |
| `bsCount` | `uikaBasisCount` |
| `gaussianSplatCount` | `uikaGaussianCount` |
| `USE_FLAME` / `USE_SKINNING` | （なし。skinning 段そのものを持たない） |

morph 後に必ず skinning 行列を掛ける LAM の構造は再現しない。
UIKA Native の vertex shader では、basis 加算の結果がそのまま `splatCenter` になる。

### 5.3 `SplatMaterial3D.js` の fragment discard

本家 0.4.6：

```glsl
if (A > 8.0) discard;
float opacity = exp(-0.5 * A) * vColor.a;
```

LAM 版は `A > 8.0` の discard をコメントアウトし、代わりに
`if (opacity < 1.0/255.0) discard;` を入れている。
数学的には `A > 8` は `exp(-0.5A) < 0.0183`、LAM の閾値は `0.0039` なので、
LAM の方が裾を広く残す。

UIKA Native は **LAM 版の条件を採用する**。理由は、これまで実機で見えていた
UIKA の見え方がこの条件下のものであり、Gate 3B で比較対象を変えないため。
これは rasterization の品質選択であり、OAC/skeleton 依存ではない。
変更したことは本書に記録する。

なお LAM が足した未使用 varying `vSplatIndex` は持ち込まない。

### 5.4 `SplatMesh.js` の UIKA 追加

本家 0.4.6 をベースに、次を**新規に**足す（LAM の bone/flame 群は持ち込まない）。

```text
setUikaBasis(deltas, basisCount, gaussianCount)   D_UIKA を GPU texture 化（1回）
setUikaWeights(Float32Array(51))                  毎frame 51 float のみ更新
```

および §7 のとおり、GPU distance 計算シェーダにも同じ basis 評価を入れる。

本家 0.4.6 の `build()` は `buildSplatTree()` を呼ぶが（LAM 版はこの呼び出しを削除している）、
UIKA Native では splat tree を使わず全点を毎回 sort するため、この呼び出しは行わない。

---

## 6. 新しい所有境界

```text
src/scripts/chat/uika-native/renderer/
    vendor/                     <- 本家 0.4.6 逐語コピー（MIT header 保持）
        NOTICE.md
        ...
    uika-splat-material.js      <- 本家 + UIKA basis block
    uika-splat-mesh.js          <- 本家 + UIKA basis / weights / distance shader
    uika-gaussian-viewer.ts     <- project 独自（Viewer.js は fork しない）
    index.ts                    <- public API
```

外部へ公開する型に LAM runtime 型を漏らさない。public API は次に限定する。

```ts
export interface UikaGaussianRenderer {
    loadCanonicalPly(ply: Blob): Promise<void>;
    setExpressionBasis(deltas: Float32Array[], basisNames: readonly string[]): void;
    setExpressionWeights(weights: Float32Array): void;
    render(): void;
    dispose(): void;
}
```

---

## 7. sort と render の animated center 一致（Architecture Requirement）

旧 renderer では

```text
render center Source of Truth  = centersColorsTexture（morph 後）
sort   center Source of Truth  = distancesTransformFeedback.centersBuffer（morph 前）
```

と**一致していなかった**（`updateTetureAfterBSAndSkeleton` は sort buffer を更新しない）。
これを UIKA Native へ持ち込まない。

本家 0.4.6 の GPU distance 計算は transform feedback の vertex shader で、
`in vec4 center` 属性（または整数版 `in ivec4 center`）だけを読む
（`setupDistancesComputationTransformFeedback`, upstream `SplatMesh.js` 1404–1495）。

UIKA Native では、この distance shader にも render 側と**同一の**

```text
animatedCenter(i) = canonicalCenter(i) + Σ(k=0..50) weight[k] * D_UIKA[k, i]
```

を入れ、同じ `uikaBasisTexture` と同じ `uikaWeightTexture` を読ませる。
splat index は `gl_VertexID` から得る。

整数版の距離計算（`integerBasedDistancesComputation`）は量子化により
render 側と式が一致しないため、UIKA Native では float 版に固定する。

これが成立しない場合は STOP して報告する（v1.1 §31 / 本指示 §23）。

---

## 8. ライセンス

```text
元ライセンス : MIT
著作権表示   : Copyright (c) 2023 Mark Kellogg
```

fork した全ファイルの先頭に、元ライセンスと出自を明記した header を付ける。
`vendor/NOTICE.md` に MIT 全文と、本家 0.4.6 からの変更点一覧（§5）を置く。
ライセンス header は削除しない。

第三者コードと project 独自コードの境界：

```text
vendor/**                  第三者コード（本家 0.4.6 逐語）
uika-splat-material.js     第三者コード + project 変更（§5.2 / §5.3）
uika-splat-mesh.js         第三者コード + project 変更（§5.4）
uika-gaussian-viewer.ts    project 独自（第三者コードなし）
```

---

## 9. upstream package を触らないこと

`node_modules/gaussian-splat-renderer-for-lam` は**一切変更しない**。
`patch-package` 等も使わない。
`package.json` / `package-lock.json` の renderer version も変更しない。

`three` は renderer package の `dependencies` に `^0.173.0` として宣言済みで、
`node_modules/three` に 0.173.0 が実在する。したがって fork 側から
`import * as THREE from 'three'` しても依存関係の追加にはならない。

通常 LAM は従来どおり `gaussian-splat-renderer-for-lam` をそのまま使い続ける。
UIKA Native renderer は**並列に追加**するだけで、通常 LAM からは参照しない。
