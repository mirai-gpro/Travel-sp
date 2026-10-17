# UIKA Native Runtime — Gate 0 Correction

**Date:** 2026-10-13
**Spec:** `docs/UIKA_NATIVE_RUNTIME_ARCHITECTURE_CORRECTION_v1.1.md`
**Branch:** `poc/uika-native-runtime-v1`
**Corrects:** `docs/UIKA_NATIVE_RUNTIME_GATE0_RESULTS.md` (元記録は改竄せず保持)
**Evidence:** `docs/UIKA_NATIVE_RUNTIME_GATE3A_DYNAMIC_UPDATE_AUDIT.md`
**Renderer:** `gaussian-splat-renderer-for-lam@0.0.9-alpha.1`

## 訂正後の判定

```text
GATE0_PUBLIC_VIEWER_EXPORT      = PASS
GATE0_PUBLIC_SCENEFORMAT_EXPORT = PASS
GATE0_PUBLIC_SPLATMESH_EXPORT   = FAIL   (変更なし)

GATE0_BARE_VIEWER_RUNTIME       = FAIL
GATE0_DIRECT_PLY_RUNTIME        = FAIL
```

## 原因

`SplatMesh.setupDataTextures()` が `flameModel` を無条件参照する。

bundle `build/gaussian-splat-renderer-for-lam.module.js` 64586–64598:

```js
this.expressionBSNum = this.flameModel.geometry.morphAttributes.position.length;
this.material.uniforms.bsCount.value = this.expressionBSNum;

this.flameModel.skeleton.bones.forEach((bone, index) => {
    if (bone.name == 'head') this.material.uniforms.headBoneIndex.value = index;
});

this.buildModelTexture(this.flameModel);
this.buildBoneMatrixTexture();
if (this.useFlameModel) {
    this.buildBoneWeightTexture(this.flameModel);
}
```

`SplatMesh.flameModel` は constructor で `null` (63786)。代入箇所は 139397 の1つだけで、
これは `GaussianSplatRenderer.getInstance()` → `loadModel()` / `loadFlameModel()` の
LAM OAC 経路でしか到達しない。

したがって素の `new Viewer(...)` + `addSplatScene(...)` では

```text
SplatMesh.build()
  -> refreshGPUDataFromSplatBuffers()
    -> refreshDataTexturesFromSplatBuffers()
      -> setupDataTextures()        <-- TypeError: reading 'geometry' of null
```

で scene build が中断し、`splatRenderReady` が false のまま
`addSplatScene` の promise が settle しない。

## 撤回する旧記録

`docs/UIKA_NATIVE_RUNTIME_GATE0_RESULTS.md` の

```text
GATE0_DIRECT_PLY_ROUTE       = PASS (source audit + public Viewer boundary)
GATE0_OAC_RUNTIME_REQUIRED   = NO
```

のうち `GATE0_DIRECT_PLY_ROUTE = PASS` を撤回する。

これは Vercel compile probe（`Viewer` / `SceneFormat` の named import が build を通る）と
bundle の source audit に基づく判定であり、**`addSplatScene` を実際に実行した結果ではなかった**。
import できることと、単体で scene build が完了することは別である。

`GATE0_OAC_RUNTIME_REQUIRED = NO` についても、現行 package をそのまま使う限りは
`NO` ではない。OAC 由来の `flameModel` が無いと scene build が通らないため、
正しくは次のとおり。

```text
GATE0_OAC_RUNTIME_REQUIRED (現行 package をそのまま使う場合)        = YES
GATE0_OAC_RUNTIME_REQUIRED (project-owned minimal renderer の場合)  = NO (Gate 3B で検証)
```

`Viewer` / `SceneFormat` が public named export である事実、
`SplatMesh` が public named export でない事実は変更しない。

## 実測条件

```text
build        : npx astro build (PASS)
served       : dist/ over http://127.0.0.1:4399
browser      : Chromium 1194, WebGL2 via ANGLE/SwiftShader
page         : /uika-native-v1/
asset sha256 : efe206d7ce164f4cde52642bdd454aa1fbfba3d0ab2d36234ffb8a3c0cb6d421
```

観測結果:

```json
{ "ready": false, "phase": "loading-renderer", "gaussianCount": 133541,
  "basisCount": 51, "renderedFrames": 0, "glErrorCount": 0, "errors": [] }
```

画面は全面黒。asset gate（SHA-256 / 133,541 / 51 channel / canonical bounds /
Phase 1 D_UIKA reference）はすべて PASS しており、失敗しているのは render 経路のみ。

## 影響

Gate 1 は旧 Viewer 経路では成立しない。
Gate 2 は Gate 1 に阻まれて未実行。

この訂正を受けて Gate 3B（project-owned minimal renderer）へ方針を変更した。
決定内容は v1.1 §31.5 を参照。
