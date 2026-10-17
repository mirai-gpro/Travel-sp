# UIKA Native Runtime — Gate 3B Results

**Date:** 2026-10-14
**Spec:** `docs/UIKA_NATIVE_RUNTIME_ARCHITECTURE_CORRECTION_v1.1.md`
**Boundary audit:** `docs/UIKA_NATIVE_RUNTIME_GATE3B_FORK_BOUNDARY.md`
**Branch:** `poc/uika-native-runtime-v1`
**Start HEAD:** `a7376b3a0fdc7a1aee7900001a8b122759b14bfa`
**Page:** `/uika-native-v1`

```text
GATE3B_1_NEUTRAL_RENDER        = PASS
GATE3B_2_GPU_DEFORMATION       = PASS
GATE3B_SORT_ANIMATED_CENTER    = PASS
GATE3B_CPU_GPU_AGREEMENT       = PASS
GATE3B_OAC_FREE                = PASS
GATE4_PERFORMANCE              = NOT RUN (software rasteriser only here)
GATE3_FIXED_A2E                = NOT STARTED
```

---

## 1. Test environment

```text
build    : npx astro build (PASS, 5 pages)
served   : dist/ over http://127.0.0.1:4399
browser  : Chromium 1194 (Playwright)
GL       : WebGL2 via ANGLE (Google, Vulkan 1.3.0, SwiftShader driver) — SOFTWARE
viewport : 360 x 980 CSS px, canvas 326 x 326
asset    : /avatar/uika-gakki-133k.zip
           sha256 efe206d7ce164f4cde52642bdd454aa1fbfba3d0ab2d36234ffb8a3c0cb6d421
```

**This machine has no GPU.** Every correctness number below is valid; every timing
number is not representative and is reported only as a sanity figure.

---

## 2. Gate 3B-1 — neutral render (PASS)

```json
{ "ready": true, "phase": "neutral-ready",
  "gaussianCount": 133541, "viewerSplatCount": 133541, "basisCount": 51,
  "renderedFrames": 23, "glErrorCount": 0, "errors": [] }
```

* distance keys: NaN 0, Inf 0, non-zero 133,541 / 133,541
* screen: the UIKA avatar renders correctly — correct colour, correct depth order,
  not a black screen and not a blob.

`readPixels()` on the default framebuffer reads 0 here, because the context is created
without `preserveDrawingBuffer` and the read happens outside the rAF callback. The
screenshot is the valid evidence; the pixel probe is not.

### 2.1 OAC-free check — every entry false

Read off the live SplatMesh / viewer instances:

```json
{ "flameModel": false, "skeleton": false, "bonesMatrix": false, "bonesWeight": false,
  "morphTargetDictionary": false, "boneTextureUniform": false,
  "boneWeightTextureUniform": false, "headBoneIndexUniform": false,
  "flameModelTextureUniform": false, "avatarMeshOnViewer": false, "splatTree": false }
```

No `animation.glb` is fetched, no skeleton object exists, no bind space, no head bone.

### 2.2 Two defects found by measurement during 3B-1

**`minimumAlpha` silently dropped 48 % of the avatar.** `PlyLoader.loadFromFileData`
defaults `minimumAlpha = 1`, and `splatAlphaRemovalThreshold` defaults to 1 as well.
The UIKA asset stores opacity in logit space; `sigmoid(x) * 255 < 1` for `x < -5.5373`,
and 64,153 of the 133,541 Gaussians are below it:

```text
measured: splats below threshold 64,153   splats kept 69,388
observed: viewer splatCount = 69388       (exactly the kept count)
```

Both thresholds are now 0.

**Sort direction was unknown, so it was measured rather than assumed.** With the camera
on +Z looking at the origin:

```text
farthest canonical splat  z = -0.20734  ->  depth key +0.20738
nearest  canonical splat  z = +0.06074  ->  depth key -0.06075
```

A larger key means farther, so the counting sort walks buckets in reverse to composite
back to front.

---

## 3. Gate 3B-2 — GPU deformation (PASS)

### 3.1 Per-frame contract

```text
once      : setExpressionBasis(deltas, names)  -> D_UIKA uploaded to the GPU
per frame : setExpressionWeights(Float32Array(51))  -> 51 floats, nothing else
```

No PLY regeneration, no Blob, no `Viewer.dispose()`, no `new Viewer()`, no
`addSplatScene()`. The renderer instance is created once and lives for the session —
`renderedFrames` keeps incrementing monotonically across every expression change
(23 → 37 → 69 → 101 → 133 → 162 → 184 in the run below).

### 3.2 GPU basis texture layout (measured)

```text
basisCount                    51
gaussianCount                 133,541
requiredTexels                6,810,591
basisTexture                  4096 x 2048  =  8,388,608 texels
basisTexture bytes            134,217,728  (128 MiB, RGBA32UI)
rows actually used            1,663 of 2,048
weightTexture                 16 x 1  (4 channels per texel, 13 texels used of 16)
MAX_TEXTURE_SIZE (measured)   8,192
```

Addressing: texel `i + gaussianCount * k` holds `(dx, dy, dz)` for Gaussian `i`,
channel `k`, each component bit-cast float→uint.

### 3.3 Equation

Render shader and GPU distance shader both evaluate, from the same two textures:

```glsl
animatedCenter(i) = canonicalCenter(i) + Σ(k = 0..50) uikaWeight(k) * uikaBasisDelta(k, i)
```

Render shader: `i` comes from the `splatIndex` attribute.
Distance shader: `i` comes from `gl_VertexID`, which equals the global splat index
because the centres buffer is filled in splat-index order by `getFloatCenters()`.

LAM naming is not used anywhere: `uikaBasisTexture`, `uikaBasisTextureSize`,
`uikaWeightTexture`, `uikaWeightTextureSize`, `uikaBasisCount`, `uikaGaussianCount`.
There is no skinning stage after the basis sum — not `USE_FLAME`, not `USE_SKINNING`.

---

## 4. GPU Gate 2 — deterministic single-channel morphs (PASS)

Each channel driven to 1.0, then back to neutral, without reloading the renderer.

| channel | visual result | neutral restore |
| --- | --- | --- |
| `jawOpen` | mouth opens wide, nothing else moves | correct |
| `mouthSmileLeft` | avatar's left cheek/mouth corner only | correct |
| `mouthSmileRight` | avatar's right cheek/mouth corner only | correct |
| `eyeBlinkLeft` | avatar's **left** eye closes, right eye unaffected | correct |
| `eyeBlinkRight` | avatar's **right** eye closes, left eye unaffected | correct |

Left/right follow the ARKit convention (the avatar's own left/right, i.e. mirrored on
screen). No global translation or rotation is introduced in any case.

---

## 5. CPU reference vs GPU (PASS)

The CPU reference is the existing `uika-deformation.ts`
(`P + Σ w·D`, all 133,541 points, double-precision accumulation in JS). It is never part
of the per-frame path.

The GPU side is compared through the depth key it actually produces, which is a linear
functional of the animated centre:

```text
key(i) = animatedCenter(i) · (mvp[2], mvp[6], mvp[10])
```

so `|key_GPU(i) − key_CPU(i)|` over all 133,541 points measures the agreement of the two
animated centres along that direction.

| channel | max abs diff | mean abs diff | CPU max displacement | non-zero points | GL errors |
| --- | ---: | ---: | ---: | ---: | ---: |
| `jawOpen` | 9.7985e-09 | 1.3384e-09 | 0.050257 | 33,407 | 0 |
| `mouthSmileLeft` | 9.7612e-09 | 1.3404e-09 | 0.006105 | 10,200 | 0 |
| `mouthSmileRight` | 9.7612e-09 | 1.3401e-09 | 0.006103 | 11,637 | 0 |
| `eyeBlinkLeft` | 9.7612e-09 | 1.3416e-09 | 0.010183 | 74,762 | 0 |
| `eyeBlinkRight` | 9.7612e-09 | 1.3418e-09 | 0.008810 | 76,034 | 0 |

**Tolerance, derived from the measurement rather than chosen.** The keys are of order
0.2; one float32 ulp there is `2^-24 × 0.25 ≈ 1.5e-08`. Every observed max is below that,
so the agreement is at float32 round-off and the adopted tolerance is:

```text
UIKA_GPU_CPU_TOLERANCE = 1.5e-08   (absolute, on a depth key of order 0.2)
```

---

## 6. Render centre and sort centre are the same (PASS)

Before the distance shader carried the basis, the same measurement read:

```text
jawOpen   |key_GPU − key_CPU(animated) |  = 4.4205e-02
          |key_GPU − key_CPU(canonical)|  = 9.7612e-09
```

i.e. the sort was demonstrably running on canonical centres — the exact defect v1.1 §12
forbids. After the change the two swap:

```text
jawOpen   |key_GPU − key_CPU(animated) |  = 9.7985e-09
          |key_GPU − key_CPU(canonical)|  = 4.4205e-02
```

### 6.1 Two defects found by measurement while implementing this

**The weight texture was one frame stale on the GPU.** `setUikaWeights` relied on
three.js's `needsUpdate`, but three.js uploads during `renderer.render()`, and the
transform-feedback distance pass runs before that. The sort therefore used the previous
frame's weights. Probing the shader directly showed `uikaBasisDelta()` returning the
correct delta (e.g. splat 0, `jawOpen`: expected `dy = 3.328194e-04`, shader produced
`3.328194e-04`) while `uikaWeight(26)` returned 0. Fixed by calling
`renderer.initTexture()` at the end of `setUikaWeights`.

**Raw texture binds corrupted the next draw.** Binding the basis and weight textures with
`gl.activeTexture` / `gl.bindTexture` for the distance program left three.js's
texture-unit cache stale, so three.js skipped re-binding its own textures and the avatar
rendered as a smeared blob. Fixed by saving units 0 and 1 plus the active unit before the
pass and restoring them immediately after the transform-feedback draw.

---

## 7. Frame timing (NOT a Gate 4 result)

```text
renderedFrames 184, glErrorCount 0, errors []
last frame: draw submit 0.2 ms, wall-clock total ~3.2 s
```

The draw figure is only the submit call; the wall-clock figure is the software
rasteriser painting 133,541 Gaussians. Neither number says anything about a real GPU.
Gate 4 must be measured on real hardware and is not claimed here.

---

## 8. Normal LAM regression (PASS)

Blob SHA comparison against baseline `e86f066`:

```text
SAME  src/components/LAMAvatar.astro
SAME  src/scripts/chat/lam-websocket-manager.ts
SAME  src/scripts/chat/live-audio-manager.ts
SAME  src/scripts/chat/uika-133k-mode.ts
SAME  package.json
SAME  package-lock.json
support-base/**  : no diff
```

`node_modules/gaussian-splat-renderer-for-lam` is untouched, unpatched and
un-reversioned; no `patch-package`. The normal LAM path still imports it exactly as
before and never imports anything under `renderer/`.

`tsc --noEmit` reports 9 errors, all pre-existing at the baseline; none is in any file
added or changed here.

---

## 9. v1.1 §17 Gate 3B PASS criteria

| criterion | result |
| --- | --- |
| 133,541 neutral render | PASS |
| LAM `flameModel` not needed | PASS |
| LAM skeleton not needed | PASS |
| `animation.glb` not needed | PASS |
| `avatarMesh` not needed | PASS |
| `boneWeightTexture` not needed | PASS |
| `headBoneIndex` not needed | PASS |
| 51 basis GPU resident | PASS |
| morph driven by 51 weights only | PASS |
| render centre == sort centre | PASS |
| single morph matches CPU reference | PASS (≤ 9.80e-09) |
| no viewer/renderer recreation | PASS |
| GL errors == 0 | PASS |

---

## 10. STOP conditions (v1.1 §27 / Gate 3B §23)

None hit.

```text
LAM skeleton required                         NO
flameModel required                           NO
boneWeightTexture required                    NO
animation.glb required                        NO
upstream package change required              NO
D_UIKA GPU result disagrees with CPU          NO (≤ 9.80e-09)
render and sort cannot share animated centre  NO (they share it)
133,541 exceeds a WebGL resource limit        NO (6,810,591 of 8,388,608 texels;
                                                  MAX_TEXTURE_SIZE 8,192)
```

---

## 11. Not done

* Gate 3 fixed real-A2E replay — not started, per instruction.
* Gate 4 performance — needs real GPU hardware.
* `uika-render-adapter.ts` and `uika-native-driver.ts` (the Gate 1/2 implementation that
  used the old `GaussianSplatRenderer` Viewer) are still in the tree, now unused by the
  page. They were left in place because deleting files needs explicit approval.
* No production merge, no production deploy.
