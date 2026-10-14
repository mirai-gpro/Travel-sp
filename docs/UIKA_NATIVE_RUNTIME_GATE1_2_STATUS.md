# UIKA Native Runtime — Gate 1 / Gate 2 Status

**Date:** 2026-10-13  
**Spec:** `docs/UIKA_NATIVE_RUNTIME_ARCHITECTURE_CORRECTION_v1.0.md`  
**Branch:** `poc/uika-native-runtime-v1`  
**Baseline:** `e86f066e03ade49bbe137acaed750e301be4f99a`  
**Current implementation head before this status note:** `a902fcc3abdf9678d5ed0a736cf8302c863ccfaa`

## Current decision

```text
GATE0_RENDERER_API_AUDIT        = PASS
GATE1_NEUTRAL_IMPLEMENTATION    = COMPLETE
GATE1_BROWSER_RUNTIME           = UNVERIFIED
GATE2_SINGLE_MORPH_IMPLEMENTATION = COMPLETE
GATE2_BROWSER_RUNTIME           = UNVERIFIED
GATE3_FIXED_A2E                 = DO NOT START YET
```

This document intentionally separates **implementation complete** from **runtime PASS**. A successful TypeScript/Astro/Vercel build does not prove that the browser runtime result is correct.

## 1. Gate 1 implementation confirmed by source audit

The new route is isolated at:

```text
/uika-native-v1
```

It uses:

```text
UikaNativeDriver
  -> UikaNativeAssetLoader
  -> reconstructed canonical PLY
  -> UikaRenderAdapter
  -> public Viewer.addSplatScene(... SceneFormat.Ply ...)
```

The UIKA Native path does **not** instantiate or depend on:

- `LAMAvatar`
- `LAMWebSocketManager`
- `LiveAudioManager`
- `GaussianSplatRenderer.getInstance()` OAC lifecycle
- `animation.glb`
- LAM skeleton / joints / skin weights as animation semantics
- `headBoneIndex`
- LAM bind-space / `UIKA_CANO_TO_LAM_BIND`
- `rigid` / `rigidPivot`
- head-camera compensation
- `morphFast`
- procedural blink
- expression `provider/cache` workaround

The current 133K compatibility ZIP is used only as a temporary **data carrier**. The loader extracts verified base positions, dense D_UIKA morph deltas/names and canonical Gaussian appearance; compatibility-only animation/skeleton semantics are ignored.

## 2. Gate 2 implementation confirmed by source audit

Gate 2 currently uses a CPU reference deformation intentionally:

```text
P_i' = P_i + sum_k weight_k * D_UIKA[k,i]
```

The single-channel controls are:

- `jawOpen = 1.0`
- `mouthSmileLeft = 1.0`
- `mouthSmileRight = 1.0`
- `eyeBlinkLeft = 1.0`
- `eyeBlinkRight = 1.0`
- neutral restore

For Gate 2 the CPU result is written into an in-memory PLY and loaded into a fresh Viewer. This is a **correctness reference only** and is explicitly not the Gate 3 real-time implementation.

## 3. Normal LAM isolation check

The following key files on `poc/uika-native-runtime-v1` are byte-identical to baseline `e86f066` by Git blob SHA:

```text
src/components/LAMAvatar.astro
  7285e967b32b1dc97cc775ca397b84403a35488b

src/scripts/chat/lam-websocket-manager.ts
  78544dd16bdbc5b66c6167fe82133e969212eceb

src/scripts/chat/live-audio-manager.ts
  11d6de997a8e12b9c6f0ffeeac6291b3c957325a
```

Therefore the current Gate 0–2 Native implementation has not modified the normal LAM runtime path through these primary integration files.

## 4. Build/deployment status

Commit `a902fcc3abdf9678d5ed0a736cf8302c863ccfaa` has GitHub/Vercel status:

```text
state       = success
context     = Vercel
description = Deployment has completed
```

This proves the current head builds/deploys. It does **not** prove Gate 1 or Gate 2 runtime correctness.

## 5. Mandatory browser runtime checks before Gate 3

Run `/uika-native-v1` on the Preview deployment and record the following without changing code.

### Gate 1 — neutral

Required evidence:

1. page reaches `neutral READY`;
2. `gaussianCount = 133541`;
3. `basisCount = 51`;
4. Viewer reported splat count is 133541 when the package exposes it;
5. source SHA-256 equals `efe206d7ce164f4cde52642bdd454aa1fbfba3d0ab2d36234ffb8a3c0cb6d421`;
6. canonical bounds pass the existing tolerance gate;
7. visible neutral face is not broken/cropped/mirrored;
8. `glErrorCount = 0`;
9. runtime `errors = []`.

If any item fails, **STOP at Gate 1**.

### Gate 2 — deterministic single basis

Run the five buttons one by one, returning to neutral between cases. Record the on-screen report for each:

- `jawOpen`
- `mouthSmileLeft`
- `mouthSmileRight`
- `eyeBlinkLeft`
- `eyeBlinkRight`

Required evidence:

1. expected anatomical region moves;
2. left/right pairs move on the correct side;
3. no global translation/rotation is introduced;
4. no NaN/Inf or GL errors;
5. neutral restore visually and numerically returns to canonical state;
6. reported max displacement agrees with the offline Phase 1 reference within its declared tolerance.

If any item fails, **STOP at Gate 2**.

## 6. Gate 3 boundary

Do not implement or wire fixed real-A2E playback until Gate 1 and Gate 2 are recorded as PASS.

Gate 3 must not reuse the current Gate 2 mechanism of regenerating/reloading a PLY every frame. The next implementation must keep the Viewer/scene alive and establish a frame-update path suitable for 30 fps.

Before coding that update path, audit the pinned renderer for the exact supported/usable mechanism to update Gaussian centers or host a project-owned deformation representation. Do not guess private APIs and do not reintroduce the LAM OAC skeleton lifecycle as a workaround.

## 7. Explicit STOP rule

```text
Gate 1 runtime PASS
    AND
Gate 2 runtime PASS
```

are prerequisites for Gate 3.

Until then, no change to:

- A2E/backend
- Live timing
- normal LAM
- old `uika-133k-mode.ts`
- production deployment

is authorized by Correction v1.0.
