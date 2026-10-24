# UIKA Native Runtime — Gate 3A Dynamic Update Capability Audit

**Date:** 2026-10-13
**Spec (Source of Truth):** UIKA Native Runtime Architecture Correction v1.1
**Branch:** `poc/uika-native-runtime-v1`
**Audited commit:** `6519512 docs: record UIKA Native Gate 1/2 verification status`
**Baseline:** `e86f066e03ade49bbe137acaed750e301be4f99a`
**Renderer package:** `gaussian-splat-renderer-for-lam@0.0.9-alpha.1`
**Bundle audited:** `node_modules/gaussian-splat-renderer-for-lam/build/gaussian-splat-renderer-for-lam.module.js` (152,643 lines)

All line numbers below refer to that exact bundle file. All runtime numbers were
measured in a real browser; nothing in this document is inferred.

---

## 0. Headline result

```text
GATE1_BROWSER_RUNTIME            = FAIL
GATE2_BROWSER_RUNTIME            = NOT RUN (blocked by Gate 1)
GATE3A_POSITION_SOURCE_OF_TRUTH  = IDENTIFIED
GATE3A_GPU_BASIS_ROUTE           = EXISTS IN SHADER, NOT REACHABLE FROM A BARE Viewer
GATE3A_CPU_XYZ_UPLOAD_ROUTE      = EXISTS, NOT REACHABLE FROM A BARE Viewer
GATE3A_STOP_CONDITION            = HIT (v1.1 §27.3 / §27.4)
```

`Viewer.addSplatScene()` on a bare `new Viewer(...)` **cannot complete** in this
package version. Both dynamic-update routes are therefore unreachable until the
scene build itself is made to complete. Gate 3 implementation must not start.

---

## 1. Gate 1 browser runtime — FAIL

### 1.1 How it was run

```text
build        : npx astro build  -> PASS (5 pages)
served       : dist/ over http://127.0.0.1:4399 (localhost = secure context, Web Crypto available)
browser      : Chromium 1194 (Playwright), WebGL2 via ANGLE/SwiftShader
viewport     : 820 x 1000
page         : /uika-native-v1/
asset served : dist/avatar/uika-gakki-133k.zip
               sha256 efe206d7ce164f4cde52642bdd454aa1fbfba3d0ab2d36234ffb8a3c0cb6d421
```

### 1.2 Asset gates — PASS

Console, verbatim:

```text
[UIKA NATIVE V1] asset gates PASS {
  sourceByteLength: 24707432,
  sourceSha256: efe206d7ce164f4cde52642bdd454aa1fbfba3d0ab2d36234ffb8a3c0cb6d421,
  gaussianCount: 133541,
  basisCount: 51,
  canonicalBounds: Object }
```

Measured `canonicalBounds`:

```text
min = [-0.20702186226844788, -0.17729105055332184, -0.20733742415905]
max = [ 0.11540722101926804,  0.13352105021476746,  0.060738399624824524]
```

These equal `EXPECTED_CANONICAL_BOUNDS` in
`src/scripts/chat/uika-native/uika-native-asset-loader.ts` to the printed digits,
so the bounds gate and the Phase 1 D_UIKA reference gate
(`validateUikaBasis`) both passed — the loader throws otherwise.

Ignored compatibility entries, as reported by the loader:

```text
chatting_avatar_20260327004322/animation.glb
chatting_avatar_20260327004322/vertex_order.json
```

Basis names: 51 channels, order as extracted from `skin.glb`
`extras.targetNames` (`mouthShrugLower` first, `mouthLowerDownLeft` last).

### 1.3 Render gate — FAIL

Runtime status, unchanged across 90 polls over ~3 minutes:

```json
{ "ready": false, "phase": "loading-renderer", "gaussianCount": 133541,
  "basisCount": 51, "renderedFrames": 0, "lastFrameMs": 0,
  "glErrorCount": 0, "errors": [] }
```

Screen: viewport entirely black, all Gate 2 buttons disabled.

Uncaught exception, 0.4 s after the asset gates passed, with stack:

```text
TypeError: Cannot read properties of null (reading 'geometry')
    at SplatMesh.setupDataTextures
    at SplatMesh.refreshDataTexturesFromSplatBuffers
    at SplatMesh.refreshGPUDataFromSplatBuffers
    at SplatMesh.build
    at Viewer.addSplatBuffersToMesh
```

### 1.4 Root cause (exact source)

`SplatMesh.setupDataTextures()` ends with an **unguarded** `flameModel`
dereference, bundle lines 64586–64598:

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

`SplatMesh.flameModel` is initialised to `null` (line 63786) and is assigned in
exactly one place, line 139397 (`this.splatMesh.flameModel = inputMesh`), which
is on the LAM OAC `loadModel()` / `loadFlameModel()` path reached only through
`GaussianSplatRenderer.getInstance()`.

Consequently, for a bare `new Viewer(...)` + `addSplatScene(...)`:

* `SplatMesh.build()` throws partway through,
* `splatRenderReady` stays `false`,
* the `addSplatScene` promise never settles,
* `UikaRenderAdapter.loadPly()` never returns, so `phase` stays
  `loading-renderer` and `status.errors` stays `[]` — **the page cannot even
  observe its own failure**.

### 1.5 Post-mortem viewer state (measured)

```json
{ "selfDrivenMode": false, "initialized": true, "splatRenderReady": false,
  "sortRunning": false, "hasSortWorker": false, "avatarMesh": null,
  "gaussianSplatCount": 0, "runAfterNextSortLen": 0,
  "splatCount": 0, "maxSplatCount": 69388,
  "useFlameModel": true,
  "bsCountUniform": 1, "gaussianSplatCountUniform": 1,
  "flameModelTextureNull": true, "boneTextureNull": true,
  "boneWeightTextureNull": true, "headBoneIndexUniform": -1,
  "dataTexKeys": ["baseData","centerColors","covariances","sceneIndexes"],
  "centersLen": 208164 }
```

Notes on these numbers:

* `maxSplatCount = 69388` and `centersLen = 208164 = 69388 * 3`: the mesh build
  aborted before the full 133,541 splats were registered.
* `dataTexKeys` contains no `flameModel` and no `boneMatrix` — neither morph
  texture was built.
* `useFlameModel = true` is the `SplatMesh` constructor default (line 63794), so
  the material was compiled with `#define USE_FLAME` (line 61532–61535).
* `bsCount`, `gaussianSplatCount`, `headBoneIndex` and all three morph/bone
  textures are still at their defaults (lines 62141–62156, 62258–62269).

### 1.6 `v.render()` / `v.update()` "not throwing" is not a pass

Called directly after the failure, `render()`, `runSplatSort(true,true)` and
`update()` all returned without throwing and `gl.getError()` was `0`. This is
**not** evidence that they work: all three early-return on
`!this.splatRenderReady` (lines 138764–138771, 138806–138812, 139102). Nothing
was drawn; `renderedFrames` stayed 0.

### 1.7 Contradiction with the recorded Gate 0 result

`docs/UIKA_NATIVE_RUNTIME_GATE0_RESULTS.md` records
`GATE0_DIRECT_PLY_ROUTE = PASS (source audit + public Viewer boundary)`.
That conclusion came from **Vercel compile probes plus a source audit**, not
from executing `addSplatScene`. At runtime the direct-PLY route does not
complete. `Viewer` and `SceneFormat` being public named exports remains true;
being importable is not the same as being usable standalone.

---

## 2. Gate 3A — Gaussian centre: Source of Truth

For a splat whose global index is `i`, the centre reaches the GPU through this
chain:

| Stage | Where | Type / size |
| --- | --- | --- |
| Parsed PLY | `viewer.getSplatScene(0).splatBuffer` | packed binary, read via `fillSplatCenterArray` (55437) |
| CPU staging | `splatMesh.splatDataTextures.baseData.centers` | `Float32Array(maxSplatCount * 3)` (64362) |
| Texture staging | `splatDataTextures.centerColors.data` | `Uint32Array(w*h*4)`, centre bit-cast by `updateCenterColorsPaddedData` (64783–64787) |
| GPU | `material.uniforms.centersColorsTexture` | `DataTexture`, `RGBA32UI`, size from `computeDataTextureSize(4, 4)` (64373–64382) |
| Sort input | `distancesTransformFeedback.centersBuffer` | separate GL buffer, written by `updateGPUCentersBufferForDistancesComputation` (65517) |

The vertex shader reads the centre at line 61738–61739:

```glsl
uvec3 sampledCenter = texture(centersColorsTexture, getDataUV(1, 0, centersColorsTextureSize)).gba;
vec3 splatCenter = uintBitsToFloat(uvec3(sampledCenter));
```

So **`baseData.centers` → `centerColors.data` → `centersColorsTexture`** is the
position Source of Truth for rendering, and
`distancesTransformFeedback.centersBuffer` is a *separate* Source of Truth for
sorting.

---

## 3. Gate 3A — Candidate A: GPU-resident basis evaluation

### 3.1 The shader already implements the v1.1 §14 equation

Bundle lines 61742–61769, verbatim structure:

```glsl
vec2 flameTextureUV   = getBSFlameDataUV(bsCount, 1, 0, flameModelTextureSize);
uvec3 sampledflamePos = texture(flameModelTexture, flameTextureUV).rgb;
// splatCenter += uintBitsToFloat(uvec3(sampledflamePos.rgb));   <- commented out in the package

for (int i = 0; i < bsCount; ++i) {
    vec2  flameBSTextureUV = getBSFlameDataUV(i, 1, 0, flameModelTextureSize);
    uvec3 sampledBSPos     = texture(flameModelTexture, flameBSTextureUV).rgb;

    float d      = float(i / 4 + 5 * 4) / boneTextureSize.x;
    vec2 samplerUV = vec2(fract(d), floor(d) / boneTextureSize.y);
    vec4 bsWeight  = uintBitsToFloat(texture(boneTexture, samplerUV));
    float weight   = bsWeight.r;
    if (i % 4 == 1) weight = bsWeight.g;
    if (i % 4 == 2) weight = bsWeight.b;
    if (i % 4 == 3) weight = bsWeight.a;

    splatCenter = splatCenter + weight * uintBitsToFloat(sampledBSPos);
}
```

This is exactly `P_i = P_i(canonical) + Σ_k w_k · D_UIKA[k, i]`, evaluated per
splat on the GPU, with the only per-frame input being the 51 weights.

Addressing (`getBSFlameDataUV`, line 61691–61697; `internal` is the shader
constant `1`, line 61650):

```text
flameModelTexture texel index for channel k, splat i  =  i + gaussianSplatCount * k
```

### 3.2 Per-frame cost is 51 floats

`SplatMesh.updateBoneMatrixTexture(false)` (lines 64650–64684) writes
`boneMatrix[ morphTargetDictionary[name] + bonesNum*16 ]` for each key of
`bsWeight`, flips `needsUpdate`, and re-points two uniforms. With
`bonesNum = 5` the write offset is `80`, and the shader reads element
`80 + k` — verified consistent:

```text
k = 0  -> d = (0/4 + 20)/4 = 5.0  -> texel (col 0, row 5)  -> element 80
k = 50 -> d = (12  + 20)/4 = 8.0  -> texel (col 0, row 8)  -> element 128, component 2 -> 130
```

`buildBoneMatrixTexture` (64601) allocates `boneTextureSize = (4, 32)` =
512 uint32 elements, so indices 80..130 are in range.

### 3.3 GPU resource budget for 51 × 133,541

`buildModelTexture` (64725) fixes `flameModelTexSize = (4096, 2048)`:

```text
texels required  = gaussianCount * (basisCount + 1) = 133541 * 52 = 6,944,132
texels available = 4096 * 2048                                     = 8,388,608      OK
rows used        = ceil(6944132 / 4096)                            = 1,696 of 2,048
MAX_TEXTURE_SIZE measured (SwiftShader/ANGLE)                      = 8,192          OK
package MAX_TEXTURE_TEXELS constant (line 63711)                   = 16,777,216     OK
```

Memory, as the package allocates it:

```text
flameModelDataInt : Uint32Array(4096*2048*4)   = 134,217,728 B  (128 MiB, CPU)
flameModelData    : Float32Array(4096*2048*4)  = 134,217,728 B  (128 MiB, CPU, kept as
                                                 splatDataTextures.baseData.flameModelPos)
GPU texture RGBA32UI 4096x2048                 = 134,217,728 B  (128 MiB, GPU)
```

Build-time risk, recorded as a fact about the code: `buildModelTexture` assembles
its source data as a plain JS `Array` with 52 successive
`shapedMeshArray.concat(Array.from(bsMesh.array))` calls (lines 64734–64745).
That is 52 full copies of a growing array totalling 20,832,396 boxed numbers —
on the order of 5.5 × 10^8 element copies. It is startup-only, but it must be
measured before it is accepted.

### 3.4 Why Candidate A is not reachable today

`buildModelTexture` and `buildBoneMatrixTexture` are called **only** from
`setupDataTextures` (64594–64595), which requires `this.flameModel` (§1.4).
`SplatMesh` is not a public export (Gate 0, confirmed again here: the bundle's
export list at line 152642 contains `Viewer` and `SceneFormat` but no
`SplatMesh`), so the class cannot be subclassed; only the instance at
`viewer.splatMesh` is reachable.

What `setupDataTextures` actually needs from `flameModel` is data, not a LAM
skeleton:

```text
flameModel.geometry.attributes.position.array      -> base positions
flameModel.geometry.morphAttributes.position[]     -> the 51 delta arrays
flameModel.morphTargetDictionary                   -> name -> channel index
flameModel.skeleton.bones                          -> only scanned for a bone named 'head'
```

With `useFlameModel = true` it additionally calls
`buildBoneWeightTexture(flameModel)` (64596), which reads `this.bonesWeight`
(initialised `null`, line 63792, assigned only at 139565) and would throw.
That function also allocates `boneWeightTextureSize = (512, 512)` =
1,048,576 elements while writing indices `i*8 + 0 .. i*8 + 4` for
`i < pointNum`. At `pointNum = 133541` the highest written index is
`133540*8 + 4 = 1,068,324`, i.e. **19,748 elements past the end of the array**;
overflow begins at `i = 131072`. Typed-array out-of-range writes are silent, so
splats 131,072..133,540 (2,469 splats) would receive zero bone weights.

### 3.5 Post-morph transform

After the morph loop the shader always applies one of two skinning stages; there
is no "morph only" variant:

* `#define USE_SKINNING` (set when `useFlameModel === false`, line 61535):
  lines 61786–61806 — `splatCenter = getBoneMatrix0(headBoneIndex) * splatCenter`,
  and when `headBoneIndex < 0` `skinned` stays `vec4(0)`, collapsing every splat
  to the origin. This is the variant production UIKA uses today, and it is the
  reason `uika-133k-mode.ts` neutralises the head slot.
* `#define USE_FLAME` (the `SplatMesh` default, line 61533):
  lines 61812–61847 — a 5-bone LBS driven by `boneWeightTexture`, selected by
  `weight > 0.0 && weight > minWeight`.

Making the `USE_FLAME` stage an identity needs only data: five identity matrices
in `boneTexture` elements 0..79 and per-splat weights `(1,0,0,0,0)`. No
skeleton, no `animation.glb`, no bind space, no `headBoneIndex`. The 512×512
`boneWeightTexture` must be replaced by one of at least
`133541 * 2 = 267,082` texels (e.g. 1024 × 512 = 524,288) with
`boneWeightTextureSize` set to match.

---

## 4. Gate 3A — Candidate B: CPU xyz upload

The package's own per-frame position path is
`SplatMesh.updateTetureAfterBSAndSkeleton(fromSplat, toSplat, useFlameModel)`
(64775–64797):

```js
this.getScene(0).splatBuffer.fillSplatCenterArray(
    this.morphedMesh, this.splatDataTextures.baseData.centers,
    sceneTransform, fromSplat, toSplat, 0);
SplatMesh.updateCenterColorsPaddedData(fromSplat, toSplat,
    this.splatDataTextures.baseData.centers,
    this.splatDataTextures.baseData.colors, paddedCenterColors);
this.updateDataTexture(paddedCenterColors, ... fromSplat, toSplat);
this.updateBoneMatrixTexture(useFlameModel);
```

Facts:

* `morphedMesh` is an **additive per-splat offset** array, not absolute
  positions: `fillSplatCenterArray` computes
  `out[i] = transform(splatBufferCenter[i]) + morphedMesh[i]` (lines 55475–55477).
  This matches the Native loader's `canonical = skin POSITION + offset.ply xyz`
  reconstruction.
* The GPU upload is partial and uses `gl.texSubImage2D`
  (`updateDataTexture`, 65026–65040) — no texture reallocation per frame.
* It does **not** touch the sort buffer.
* Per frame it rewrites 133,541 × 3 floats on the CPU plus a
  133,541 × 4 uint32 texture region. No measurement of this cost exists yet.
* It is reachable only on a built scene, so it is blocked by §1.4 exactly as
  Candidate A is.

---

## 5. Gate 3A — relationship to sorting

`updateTetureAfterBSAndSkeleton` never calls
`updateGPUCentersBufferForDistancesComputation`. Therefore in the **current,
working production LAM path** the depth sort runs on the un-morphed centres, and
sort/morph consistency is not a requirement the shipped product satisfies.

If the Native path ever wants sort-consistent centres, the call exists and is
incremental:

```js
splatMesh.updateGPUCentersBufferForDistancesComputation(true, paddedCenters, 0);
// line 65517; isUpdate=true -> gl.bufferSubData, 16 bytes per splat
```

Note that `getIntegerCenters` / `getFloatCenters` (64261–64262) read from the
splat buffer, i.e. they return canonical centres, not morphed ones; a morphed
array would have to be built by the caller.

---

## 6. Additional blocker: `Viewer.update()` cannot be used by a Native adapter

Independently of §1.4, `Viewer.update(renderer, camera)` (line 138796)
unconditionally calls, at lines 138825–138826:

```js
this.runMorphUpdate();
this.runSplatSort(true, true);
```

and `Viewer.runMorphUpdate()` (139477–139478) begins with:

```js
this.gaussianSplatCount = this.avatarMesh.geometry.attributes.position.count;
```

`Viewer.avatarMesh` is `null` in the constructor (line 137053) and is assigned
only at 139396 and at 152540 / 152578 — all on the OAC path. So any UIKA Native
adapter must drive the frame itself:

```text
viewer.render()               line 138764  — no avatarMesh dependency
viewer.runSplatSort(f, fAll)  line 139101  — no avatarMesh dependency
viewer.update()               line 138796  — unusable
```

The current `UikaRenderAdapter.renderOnce()` calls `viewer.update()` and must be
changed before any Gate 3 work.

---

## 7. Decision

**No Gate 3 implementation method is selected, and none may be selected yet.**

Both candidates are blocked by the same single fact: `addSplatScene` cannot
complete without `splatMesh.flameModel`. Until that is resolved there is nothing
to measure and nothing to choose between.

If and only if the resolution is approved, Candidate A is the one that matches
v1.1 §14 ("毎frame 51 weightsだけ更新"), because the package's own shader already
computes `canonical + Σ w·D` on the GPU and the per-frame write is 51 floats.
Candidate B would re-upload 133,541 centres every frame.

---

## 8. STOP conditions hit (v1.1 §27)

```text
§27.8  Gate 1/2 が FAIL                                   -> HIT (Gate 1, §1.3)
§27.3  Viewer で dynamic xyz 更新経路が確認できない        -> HIT (reachable only via flameModel, §3.4 / §4)
§27.4  133K dynamic update が renderer 構造上成立しない    -> PARTIAL: the shader route exists and fits
                                                             (§3.1–§3.3) but is gated behind OAC-only setup
```

Per v1.1 §27 the correct action is to stop and report, not to work around this.
No workaround was implemented. In particular, none of the following was done:

* no `Viewer`/`SplatMesh` prototype patching,
* no reintroduction of `animation.glb`, the LAM skeleton, `headBoneIndex` or
  `UIKA_CANO_TO_LAM_BIND`,
* no change to `uika-133k-mode.ts`, normal LAM, `live-audio-manager.ts`, A2E or
  the backend,
* no fallback from the Native route to the legacy `?uika133k=1` route.

---

## 9. Open question for review

Resolving §1.4 requires giving `splatMesh.flameModel` an object with the four
data members listed in §3.4 before `addSplatScene` runs. That object would be
built from the UIKA 51-channel basis the Native loader already extracts and
validates, and it would carry no animation clips and no LAM joint hierarchy —
but it does mean the Native adapter writes to a non-exported renderer instance
member, which v1.1 §10 says must be proposed before it is implemented rather
than patched in.

Two directions exist. Neither has been implemented:

1. Populate `viewer.splatMesh.flameModel` (and `bonesWeight`, `bonesMatrix`,
   `bonesNum`) from UIKA Native data inside `UikaRenderAdapter`, keeping every
   write inside the adapter, and set the five bone matrices to identity so the
   post-morph stage is a no-op.
2. Carve out a project-owned minimal renderer adapter/fork, as v1.1 §10 allows,
   so the `flameModel` requirement is removed at the source instead of
   satisfied with a stub.
