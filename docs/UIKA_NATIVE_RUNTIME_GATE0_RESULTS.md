# UIKA Native Runtime — Gate 0 Results

**Date:** 2026-10-13  
**Spec:** `docs/UIKA_NATIVE_RUNTIME_ARCHITECTURE_CORRECTION_v1.0.md`  
**Branch:** `poc/uika-native-runtime-v1`  
**Baseline:** `e86f066e03ade49bbe137acaed750e301be4f99a`  
**Renderer:** `gaussian-splat-renderer-for-lam@0.0.9-alpha.1`

## Result

```text
GATE0_PUBLIC_VIEWER          = PASS
GATE0_PUBLIC_SCENE_FORMAT    = PASS
GATE0_PUBLIC_SPLAT_MESH      = FAIL (do not depend on it)
GATE0_DIRECT_PLY_ROUTE       = PASS (source audit + public Viewer boundary)
GATE0_OAC_RUNTIME_REQUIRED   = NO
```

## 1. Compile probes against the actual pinned package

The probes were intentionally done as isolated commits on the PoC branch and judged by the existing Vercel Preview build.

### 1.1 Viewer

Commit `d45f11ee231e8d918fc17e6bfb8b3601e67786ef`

```ts
import { Viewer } from 'gaussian-splat-renderer-for-lam';
```

Vercel build: **PASS**.

Therefore `Viewer` is a public named export of the package that Travel-sp actually installs.

### 1.2 SplatMesh

Commit `bf0f1e6979568daa09e635a78683600b60635d0f`

The only capability change was adding a named `SplatMesh` import/probe.

Vercel build: **FAIL**.

The following commit `90c9ffb4376630eaa016c9b0cc9228c1d229f9d4` removed only that probe and restored the Viewer-only version.

Vercel build: **PASS**.

A/B conclusion: Correction v1.0 must **not** depend on `SplatMesh` being a public named export.

### 1.3 SceneFormat

Commit `64bd23da0d61685e467ded3f7b8adadad186a9d1`

```ts
import { SceneFormat, Viewer } from 'gaussian-splat-renderer-for-lam';
```

Vercel build: **PASS**.

Therefore `SceneFormat` is available for an explicit PLY load from a Blob URL or normal URL.

## 2. Direct PLY route vs LAM OAC route

Earlier source audit of the same `0.0.9-alpha.1` bundle established two separate layers:

- high-level LAM OAC `loadModel()` requires `skin.glb`, `animation.glb`, `vertex_order.json`, and `offset.ply`;
- the underlying Viewer path uses `addSplatScene(..., format: Ply, ...)` to load Gaussian PLY data.

The 133K limit audit also found no 20,018 hardcode in the PLY loading/rendering path.

Correction v1.0 therefore uses the public `Viewer` + direct PLY scene route and does **not** use `GaussianSplatRenderer.getInstance()` as the UIKA Native runtime owner.

## 3. Migration source asset

Travel-sp currently stores the verified UIKA 133K data inside the compatibility ZIP. For the first native PoC, that ZIP may be used only as a **data carrier**:

```text
skin.glb POSITION            -> UIKA base positions
skin.glb 51 morph targets    -> D_UIKA
skin.glb targetNames         -> verified 51-channel basis order
offset.ply xyz               -> canonical offset
other offset.ply properties  -> canonical Gaussian appearance
```

Native canonical position is reconstructed once as:

```text
canonical_xyz[i] = POSITION[i] + offset_xyz[i]
```

This is the same equation already verified for the compatibility asset.

The following compatibility data is explicitly ignored by the new driver:

- `animation.glb`
- skeleton / skins / joints
- `JOINTS_0`
- `WEIGHTS_0`
- inverse bind matrices
- LAM head bone / bind space
- `vertex_order.json` rendering semantics

The fact that the migration source happens to be a LAM-compatible ZIP must not become a native runtime requirement. It is an interim extraction source only.

## 4. Gate 1 implementation boundary

Gate 1 will therefore be implemented as:

```text
verified 133K compatibility ZIP (migration source only)
        |
        +-- parse skin.glb POSITION
        +-- parse 51 dense morph targets / names
        +-- parse offset.ply appearance + xyz offset
        |
        v
in-memory canonical UIKA PLY
        |
        v
public Viewer.addSplatScene(blobUrl, { format: SceneFormat.Ply, ... })
        |
        v
neutral 133,541-Gaussian render
```

No LAM animation or skeleton object is initialized by the UIKA Native driver.

## 5. STOP conditions carried forward

Stop rather than workaround if:

- the current 133K ZIP does not contain the verified dense morph/position layout;
- PLY/GLB counts are not exactly consistent;
- canonical reconstruction differs from the previously verified neutral geometry;
- `Viewer.addSplatScene` cannot render the reconstructed PLY without invoking OAC lifecycle;
- the only way to continue requires reintroducing LAM skeleton/bind-space semantics.
