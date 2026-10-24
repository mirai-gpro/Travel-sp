# UIKA Native Runtime Architecture Correction v1.0

**Version:** 1.0  
**Date:** 2026-10-13  
**Status:** Implementation Source of Truth  
**Target repository:** `mirai-gpro/Travel-sp`  
**Implementation branch:** `poc/uika-native-runtime-v1`  
**Baseline:** `e86f066e03ade49bbe137acaed750e301be4f99a` (PR #47: fixed real-A2E capture/replay)  
**UIKA reference:** `ant-research/UIKA @ c539f41df842ff21faba49cd60e65e73774e8fbd`  
**Renderer lock for existing LAM path:** `gaussian-splat-renderer-for-lam@0.0.9-alpha.1` (package-lock pinned)  

---

## 0. Purpose of this correction

This document corrects the browser runtime architecture for the UIKA 133,541-Gaussian PoC.

The original UIKA Native design fixed two requirements:

1. keep UIKA's **133,541 Gaussians** without reducing them to the LAM 20,018 representation;
2. continue using the existing **LAM-A2E ARKit52 @ 30 fps** output.

The original design also explicitly stated that UIKA should **not be forced into the conventional LAM OAC package contract** (`skin.glb + offset.ply + animation.glb + vertex_order.json`). Instead, UIKA was to have a native avatar package and a parallel runtime driver.

The current Travel-sp PoC diverged from that boundary. It proved that the LAM renderer can technically load 133,541 splats, but it also introduced LAM-specific skeleton, animation, bind-space and camera behavior into the UIKA path and then compensated for those differences at runtime.

**Correction v1.0 restores the original architectural boundary:**

> UIKA facial animation is driven as a native 133,541-Gaussian deformation path. LAM OAC skeleton/animation semantics are not part of the UIKA runtime contract.

This is an architectural correction, not another symptom-level lipsync patch.

---

## 1. Evidence and verified facts

### 1.1 Official UIKA animation model

Pinned UIKA `c539f41...` uses `UVFlameHead` to rasterize the FLAME UV surface and barycentrically sample per-Gaussian FLAME attributes, including:

- `pix_to_v_idx_flatten`
- `pix_bary_flatten`
- `lbs_weights_pix`
- `J_regressor_pix`
- `posedirs_pix`
- `shapedirs_pix`

The official `UVFlameHead.forward()` animation path is:

```text
FLAME controls
  expr / rotation / neck / jaw / eyes / translation
        |
        v
joint transforms + expression deformation
        |
        v
per-Gaussian LBS
        |
        v
animated Gaussian xyz
```

Official `UVGSRenderer.animate_gs()` creates the animated frame by changing **Gaussian `xyz`**. The following appearance attributes remain canonical:

- opacity
- Gaussian rotation
- Gaussian scaling
- RGB / SH
- offset attribute

Therefore, for browser A2E integration, changing Gaussian center positions while retaining canonical appearance is consistent with the pinned UIKA renderer.

### 1.2 A2E contract remains ARKit52

The existing A2E contract is not changed by this correction:

```text
input  : audio 16 kHz
output : ARKit52 coefficients
rate   : 30 fps
```

The `tongueOut` channel is the 52nd ARKit channel and has no corresponding morph in the verified 51-morph browser basis. Mapping must remain **name-based**, never positional guesswork.

### 1.3 D_UIKA is a valid deformation representation

Phase 1 already established the following mapping:

```text
D_UIKA[k,i] = sum_j bary[i,j] * D_FLAME[k, v_idx[i,j]]
```

This is the same barycentric interpolation structure used by official UIKA for FLAME attributes.

Verified Phase 1 results include:

- `PHASE1_RIG_FEASIBILITY = PASS`
- FLAME 5,023 topology coverage: 5,023 / 5,023
- 51 browser morphs mapped by name; missing A2E channel = `tongueOut`
- UIKA 133,541 deformation generated through real UIKA UV bary mapping
- neutral preserves `P' == P`
- representative L/R channels respond on the correct side
- representative UIKA max displacement is within roughly 1.3% of the LAM vertex-field maximum

Therefore, this correction does **not** reject D_UIKA or the ARKit-on-UIKA deformation concept.

### 1.4 Existing LAM browser runtime semantics

The existing LAM renderer's OAC path is built around a `skin.glb` / `offset.ply` asset and state animation. In the audited path, the splat center is effectively composed from:

```text
skin.glb POSITION
+ offset.ply xyz
+ ARKit morph displacement
```

The distributed renderer also applies the `head` bone transform as a rigid transform to all splats in its active skeleton path. Existing `animation.glb` clips contain bone TRS animation and no morph-weight animation.

Those semantics are valid for the LAM OAC runtime. They are **not** part of official UIKA's runtime contract.

### 1.5 Current Travel-sp UIKA path is compensation-heavy

The current UIKA compatibility path has accumulated UIKA-only runtime adaptation, including:

- use of the LAM OAC ZIP structure for the UIKA 133K asset;
- reused `animation.glb` and LAM skeleton/node hierarchy;
- head-bone neutralization / head compensation;
- canonical-to-LAM-bind translation (`UIKA_CANO_TO_LAM_BIND`);
- `rigid` / `rigidPivot` modes;
- camera compensation for LAM head motion;
- UIKA-only depth-sort interception;
- UIKA-only `runMorphUpdate` fast path;
- UIKA-only expression-provider path;
- procedural blink layer;
- UIKA-specific warm-up/readiness state.

Each item was introduced for a concrete observed incompatibility or performance symptom. The correction does not claim each item is individually wrong. The architectural problem is that **UIKA depends on all of them only because it is being executed through LAM OAC runtime semantics**.

---

## 2. Original design vs current implementation vs corrected design

| Area | Original UIKA Native design | Current Travel-sp UIKA compatibility path | Correction v1.0 |
|---|---|---|---|
| Gaussian count | 133,541 | 133,541 | **133,541** |
| A2E | ARKit52 @ 30fps | ARKit52 @ 30fps | **reuse unchanged** |
| Facial deformation | ARKit field -> UIKA UV/bary -> 133K xyz | dense 51 morphs inside LAM `skin.glb` | **D_UIKA / equivalent 133K basis** |
| Avatar package semantics | UIKA Native | LAM OAC-compatible ZIP | **UIKA Native** |
| `skin.glb` | not a UIKA semantic dependency | required | **not a UIKA semantic dependency** |
| `animation.glb` | not required for v1 facial PoC | reused from LAM | **not used** |
| LAM skeleton | not part of UIKA v1 | loaded/reused | **not used** |
| LAM head bone | not part of UIKA v1 | must be neutralized/compensated | **not used** |
| LAM bind space | not part of UIKA v1 | requires pivot/bind compensation | **not used** |
| Camera | UIKA camera/meta | UIKA camera + compensation for LAM motion | **UIKA camera/meta only** |
| Idle head motion | later independent layer | borrowed from LAM skeleton clips | **out of v1 scope** |
| Blink | A2E/UIKA expression only for first pass | A2E + procedural layer | **A2E only for first pass** |
| Sort policy | renderer concern after correct geometry path | UIKA monkey-patch | **measure after native path works** |
| Live connection | final validation stage | connected early | **last stage** |

---

## 3. What is reused

The following are retained because they are already verified or are outside the architectural error.

### 3.1 A2E and audio pipeline

Reuse unchanged:

- backend A2E service;
- 16 kHz input contract;
- ARKit52 coefficient output;
- 30 fps frame rate;
- `LiveAudioManager` audio/A2E buffering and timing for the **Live validation stage**;
- current backend / Gemini Live pipeline;
- existing Japanese mouth-shape post-processing, but only after its exact input/output semantics are isolated as a reusable expression stage.

No A2E retraining, no FLAME100 conversion, and no backend timing change is part of Correction v1.0.

### 3.2 Fixed A2E replay diagnostic

Reuse:

- `src/scripts/chat/a2e-replay.ts`
- `?a2eCapture=1`
- `?a2eReplay=1`

This provides a deterministic real-A2E input and is the first browser animation gate before Live is connected.

### 3.3 ARKit name contract

Reuse the verified ARKit52 names and name-based mapping.

The UIKA native driver receives either:

```ts
Record<string, number>
```

or an equivalent packed 51-weight array produced **after name mapping**.

No implicit index coupling is allowed.

### 3.4 UIKA canonical asset data

Reuse:

- UIKA canonical 133,541 Gaussian attributes;
- nose-tip corrected canonical geometry when that is the selected source asset;
- canonical RGB/SH, opacity, scale and rotation;
- real UIKA UV mapping;
- D_UIKA 51 x 133,541 x 3 deformation basis, or an equivalent runtime representation proven numerically identical.

### 3.5 Gaussian rasterization technology

The current `gaussian-splat-renderer-for-lam` package may still be reused **only at the Gaussian viewer/rasterizer layer** if its exact exported API allows UIKA Native data to be loaded and updated without LAM OAC skeleton/animation semantics.

This is an implementation gate, not an assumption.

If the package exposes a clean low-level `Viewer` / scene-loading route, use that route. If it does not, create an explicit project-owned adapter/fork of the minimal MIT renderer functionality required by UIKA. Do **not** restore the OAC skeleton contract merely to avoid creating a clean adapter.

---

## 4. What is retired from the UIKA Native v1 path

The following are removed from the **new native path**. They may remain temporarily in the legacy hidden path as a comparison control, but there must be no automatic fallback to them.

### 4.1 LAM OAC semantic dependencies

Retire from UIKA Native v1:

- `animation.glb` as an animation dependency;
- LAM state-driven skeleton animation;
- LAM 262-joint hierarchy as an animation contract;
- `headBoneIndex` handling;
- fake/dummy `JOINTS_0` / `WEIGHTS_0` as a requirement for UIKA animation;
- LAM bind-space as the coordinate system for UIKA motion.

### 4.2 Runtime compensation code

The new path must not need:

- `UIKA_CANO_TO_LAM_BIND`;
- `rigid` / `rigidPivot`;
- `H_head` neutralization;
- camera-based compensation of LAM head motion;
- `setupHeadCompensation()`;
- UIKA-specific animation-manager overrides.

If the new driver requires any of these, the architecture has regressed back into the compatibility path.

### 4.3 Symptom-level UIKA-only runtime patches

Do not carry these into the initial native driver:

- UIKA-only depth-sort throttling policy;
- `morphFast` monkey-patch;
- procedural blink;
- expression `provider/cache` A/B path;
- UIKA OAC warm-up loop.

Performance and scheduling are measured **after** the native deformation path has passed fixed offline replay.

### 4.4 No automatic legacy fallback

The old hidden UIKA path may remain available only as an explicit diagnostic control, e.g. an explicit legacy query mode.

The new path must never silently fall back to the old UIKA OAC path when initialization or rendering fails. Failure must remain visible.

---

## 5. New UIKA Native Driver responsibilities

Create a separate runtime owner, conceptually:

```text
UikaNativeDriver
  |
  +-- UikaNativeAssetLoader
  +-- UikaExpressionMapper
  +-- UikaRenderAdapter
  +-- UikaFrameClock / expression source
```

The exact filenames may change, but responsibilities must not be merged back into `LAMWebSocketManager`.

### 5.1 `UikaNativeAssetLoader`

Responsibilities:

- load UIKA Native manifest/package;
- validate format/version;
- validate Gaussian count from real data (`133541` for the current test asset);
- validate coordinate-system metadata;
- validate morph basis name list / count (`51` for the current basis);
- validate NaN/Inf;
- expose canonical Gaussian attributes and D_UIKA basis;
- reject partial/mismatched assets instead of filling defaults.

The UIKA Native package is conceptually:

```text
manifest.json
canonical Gaussian data
ARKit/UIKA deformation basis or common-rig reference
checksums / provenance
```

The implementation may initially use separate files during PoC. ZIP packaging is not allowed to dictate runtime semantics.

### 5.2 `UikaExpressionMapper`

Responsibilities:

- accept A2E `ExpressionFrame` + `expression_names`, or equivalent fixed replay frame;
- map by name into the verified 51 UIKA deformation channels;
- explicitly drop/report `tongueOut` when no basis exists;
- preserve the existing Japanese mouth-shape post-processing semantics when enabled;
- output a stable 51-weight vector in the exact D_UIKA basis order.

This component contains **no rendering code, no audio clock, no camera code and no skeleton code**.

### 5.3 `UikaRenderAdapter`

Responsibilities:

- own the UIKA Gaussian renderer/viewer instance;
- upload canonical appearance attributes once;
- upload D_UIKA deformation basis once, or an equivalent GPU representation;
- each frame, apply only current expression weights to produce animated xyz;
- render with UIKA camera/meta;
- report render timing and GL errors.

Target equation:

```text
P_i(frame) = P_i(canonical) + sum_k weight_k(frame) * D_UIKA[k,i]
```

For the initial A2E-only browser path, this is the required facial motion equation.

Preferred runtime behavior:

- D_UIKA is resident on GPU;
- per-frame transfer is only the small weight vector, not 133,541 x 3 positions from JavaScript;
- appearance attributes remain fixed;
- no LAM skeleton matrices are part of the shader input for UIKA v1.

If the existing package cannot expose this cleanly, implementation must stop at the renderer-adapter gate and report the exact missing API. It must not reintroduce skeleton/OAC semantics as a workaround.

### 5.4 `UikaNativeDriver`

Responsibilities:

- initialize asset + render adapter;
- expose `ready` only after asset validation and one valid neutral render;
- choose the active expression source for the current test phase;
- drive the render loop;
- provide read-only diagnostics.

Minimum state:

```ts
{
  ready: boolean;
  gaussianCount: number;
  basisCount: number;
  expressionSource: 'neutral' | 'fixed-replay' | 'live';
  renderedFrames: number;
  lastFrameMs: number;
  p50FrameMs?: number;
  p95FrameMs?: number;
  glErrorCount: number;
  errors: string[];
}
```

It must not know about:

- LAM `AnimationManager`;
- `headBoneIndex`;
- LAM chat-state clips;
- LAM bind-space pivot compensation;
- OAC `animation.glb`.

---

## 6. Verification order — mandatory gates

The order below is part of the specification. Do not skip directly to Live.

### Gate 0 — Renderer/API capability audit

Goal: prove the exact browser renderer path before implementing UIKA motion.

Verify on pinned `gaussian-splat-renderer-for-lam@0.0.9-alpha.1`:

1. exact exported low-level classes/functions;
2. whether a `Viewer`/scene route can load canonical Gaussian data without `GaussianSplatRenderer.getInstance()` OAC lifecycle;
3. whether the existing SplatMesh/material can accept a project-owned expression basis without skeleton dependence;
4. exact sort/update/render calls in the low-level route.

Output: `PASS` or explicit blocker with source locations. No workaround during this gate.

### Gate 1 — Neutral native browser render

Input:

- canonical UIKA 133,541 asset;
- all expression weights = 0;
- no Live, no A2E timing, no LAM skeleton.

Pass conditions:

- Gaussian count = 133,541;
- visual output matches the accepted canonical UIKA browser reference within the agreed render condition;
- NaN = 0;
- Inf = 0;
- WebGL error = 0;
- no LAM skeleton/animation code is instantiated by the UIKA driver.

### Gate 2 — Single-channel deterministic morphs

Apply constant/synthetic weights through the new native driver:

- `jawOpen = 1.0`
- `mouthSmileLeft = 1.0`
- `mouthSmileRight = 1.0`
- `eyeBlinkLeft = 1.0`
- `eyeBlinkRight = 1.0`

Pass conditions:

- expected side/sign behavior;
- browser deformation statistics match the offline D_UIKA reference within a predeclared tolerance;
- neutral round-trip remains exact when weights return to zero;
- no skeleton/camera compensation is activated.

### Gate 3 — Offline fixed real-A2E replay @ 30 fps

Use the existing captured real A2E fixture and the existing replay clock.

This test must bypass:

- Gemini Live;
- Socket.IO arrival timing;
- `LiveAudioManager` expression buffering;
- A2E chunk timing.

But it must include:

- the real captured 52 coefficients;
- name mapping;
- the same Japanese mouth-shape post-processing intended for production;
- UIKA D_UIKA deformation;
- browser render loop.

Pass conditions:

- replay progression is time-based, not accumulated-frame based;
- target 30 fps expression sequence is represented without long visible holds/jumps caused by the UIKA driver;
- render p50/p95/max are recorded;
- no UIKA-specific scheduler or cache/provider workaround is required.

If Gate 3 fails, **do not connect Live**. Fix the native renderer/deformation path first.

### Gate 4 — Browser 30 fps performance characterization

Only after Gate 3 correctness:

Measure independently:

- expression basis evaluation cost;
- sort cost;
- rasterization cost;
- JS -> GPU upload cost;
- total frame time.

The original design target is 30 fps at the intended meeting viewport. Falling below 30 fps does not automatically fail the architecture; the bottleneck must be identified by category before optimization.

Optimization must be performed inside the native adapter. Do not restore OAC skeleton semantics or old monkey patches.

### Gate 5 — Live integration

Only after Gates 1-4 pass.

Connect the new driver to existing `LiveAudioManager` / real streaming A2E.

Pass conditions:

- normal LAM remains unchanged;
- UIKA uses the same A2E/backend data contract;
- expression source becomes `live` only after UIKA Native driver is ready;
- lipsync timing is compared against normal LAM under the same session conditions;
- no automatic fallback to legacy UIKA;
- no production merge from this branch without explicit approval.

### Gate 6 — Idle/head motion (separate project phase)

Head/idle motion is deliberately outside v1 facial-lipsync validation.

After Live facial animation is correct, design a native UIKA head-motion layer separately. Candidates may include native FLAME pose controls or a deliberate rigid transform around a UIKA-defined pivot, but **LAM skeleton clips must not be inherited implicitly**.

---

## 7. Minimal parallel implementation in Travel-sp

### 7.1 Branch isolation

Implementation branch:

```text
poc/uika-native-runtime-v1
```

Base:

```text
e86f066e03ade49bbe137acaed750e301be4f99a
```

Reason for this base:

- includes fixed real-A2E capture/replay diagnostic;
- predates the later shared AV scheduler experiment;
- provides a stable comparison point;
- production and existing LAM behavior are not modified by creating this branch.

### 7.2 Explicit URL gate

Use a new explicit flag for the corrected path, for example:

```text
?uikaNativeV1=1
```

Rules:

- `/concierge` / `/lesson` without this flag use the normal existing LAM path;
- the old `?uika133k=1` compatibility path remains a diagnostic control only while the new path is built;
- `?uikaNativeV1=1` must not call `applyUika133kMode()`;
- no automatic switching between native and legacy paths.

### 7.3 New files

Initial structure:

```text
src/scripts/chat/uika-native/
  uika-native-driver.ts
  uika-native-asset-loader.ts
  uika-expression-mapper.ts
  uika-render-adapter.ts
  uika-native-types.ts
```

The exact split may be simplified if source audit shows a better boundary, but `LAMWebSocketManager` must not become the owner of the new UIKA runtime.

### 7.4 Existing files changed minimally

Initial integration is allowed to touch only the minimum entry/wiring points, expected to be:

- `src/components/LAMAvatar.astro` — choose normal LAM vs explicit UIKA Native v1 controller;
- possibly one controller-facing interface to expose the existing expression source after Gate 3/5.

Do not modify in the first native implementation commit:

- `support-base/`;
- A2E backend;
- `LiveAudioManager` timing algorithm;
- normal LAM camera/orbit behavior;
- current normal LAM renderer path;
- CI/CD;
- production environment variables.

### 7.5 Legacy code deletion timing

Do not delete `uika-133k-mode.ts` in the first commit. It remains an explicit comparison control until the new native path passes fixed replay and Live.

After the new path is accepted, remove obsolete UIKA compatibility code in a separate cleanup commit so that architecture change and deletion are not mixed.

---

## 8. Commit sequence

Changes must remain individually reviewable.

### Commit A — specification only

This document only.

### Commit B — Gate 0 audit / adapter boundary

- inspect exact alpha.1 exports/source;
- add only the native renderer adapter boundary or audit utility required to prove the path;
- no Live wiring.

### Commit C — neutral native render

- canonical asset load;
- UIKA camera;
- no expressions;
- no skeleton.

### Commit D — deterministic expression basis

- 51-channel basis upload;
- single-channel tests;
- diagnostics.

### Commit E — fixed real-A2E replay

- attach existing replay source;
- include production-equivalent name/post-processing path;
- record frame-time statistics.

### Commit F — Live wiring

Only after prior gates pass.

No commit in this sequence is automatically merged or deployed to production.

---

## 9. Acceptance / rejection rules

### Architecture PASS

Correction v1.0 is architecturally established when:

1. UIKA 133,541 canonical geometry renders without LAM skeleton/OAC animation semantics;
2. D_UIKA single-channel browser deformation matches offline reference;
3. fixed real-A2E replay animates through the native driver without legacy UIKA monkey patches;
4. the normal LAM path is unchanged;
5. Live integration can be added only by supplying the expression source, not by adding LAM skeleton/camera compensation back into UIKA.

### STOP / review required

Stop and report before continuing if any of the following is found:

- the pinned renderer package cannot expose a usable low-level Gaussian path;
- native deformation requires modifying canonical appearance unexpectedly;
- D_UIKA browser result disagrees materially with offline reference;
- 133,541 basis representation cannot fit/use available GPU resources under the chosen renderer;
- the only apparent way forward requires LAM skeleton, `animation.glb`, bind-space or `headBoneIndex` to be reintroduced.

At a STOP, compare renderer-adapter options explicitly. Do not hide the failure with a fallback.

---

## 10. Out of scope for v1.0

Not part of this correction until the facial path passes:

- UIKA retraining;
- VHAP;
- A2E retraining;
- ARKit52 -> FLAME100 fitting;
- native UIKA jaw/eye/neck pose parity beyond the current ARKit deformation basis;
- procedural blink;
- idle/speak head-body motion;
- production package compression optimization;
- sparse uint32 morph optimization;
- production deployment.

---

## 11. Decision

The implementation direction is fixed as follows:

> **Keep the verified A2E -> ARKit -> D_UIKA facial deformation. Replace the UIKA-via-LAM-OAC runtime contract with a dedicated UIKA Native driver. Reuse only verified common components and the Gaussian rendering layer. Validate neutral -> deterministic morph -> fixed real-A2E -> 30 fps browser -> Live, in that order.**

Until this sequence passes, further tuning of `sortMode`, `morphFast`, `rigidPivot`, `exprPath`, warm-up timing or other legacy UIKA compensation code is not the mainline solution.
