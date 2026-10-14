# Third-party notice — UIKA Native Runtime renderer fork

Everything under this `vendor/` directory is derived from:

```
@mkkellogg/gaussian-splats-3d   version 0.4.6
https://github.com/mkkellogg/GaussianSplats3D
MIT License, Copyright (c) 2023 Mark Kellogg
```

The full licence text is in `./LICENSE` (copied unchanged from the
`gaussian-splat-renderer-for-lam` package, which carries the same notice).

## How these sources were obtained

The installed package `gaussian-splat-renderer-for-lam@0.0.9-alpha.1` ships only a
bundle, but its published source map (`build/gaussian-splat-renderer-for-lam.module.js.map`)
contains `sourcesContent` for all 120 inputs. The same is true of the upstream
`@mkkellogg/gaussian-splats-3d` tarballs on npm.

Byte-comparing the 51 `src/**/*.js` files of both revealed the base version:

```
vs @mkkellogg/gaussian-splats-3d 0.4.5 : identical 36 / differing 15
vs @mkkellogg/gaussian-splats-3d 0.4.6 : identical 41 / differing 10   <-- base
vs @mkkellogg/gaussian-splats-3d 0.4.7 : identical 30 / differing 21
```

The files here were taken from **upstream 0.4.6**, not from the LAM fork. None of the
LAM avatar additions (`flameModel`, skeleton, bone textures, `headBoneIndex`,
`avatarMesh`, `USE_FLAME` / `USE_SKINNING`, chat state, animation clips) are present,
because upstream 0.4.6 never had them.

## File status

Verbatim copies of upstream 0.4.6 — 25 files:

```
AbortablePromise.js
Constants.js
LogLevel.js
SceneRevealMode.js
SplatRenderMode.js
Util.js
loaders/DirectLoadError.js
loaders/InternalLoadType.js
loaders/LoaderStatus.js
loaders/SplatBuffer.js
loaders/SplatBufferGenerator.js
loaders/SplatPartitioner.js
loaders/UncompressedSplatArray.js
loaders/ply/INRIAV2PlyParser.js
loaders/ply/PlayCanvasCompressedPlyParser.js
loaders/ply/PlyFormat.js
loaders/ply/PlyLoader.js
loaders/ply/PlyParser.js
loaders/ply/PlyParserUtils.js
splatmesh/SplatGeometry.js
splatmesh/SplatMaterial2D.js
splatmesh/SplatScene.js
splattree/SplatTree.js
three-shim/WebGLCapabilities.js
three-shim/WebGLExtensions.js
```

Upstream 0.4.6 **with UIKA modifications** — 4 files. Each carries a header block and
every change is marked with a `UIKA MODIFICATION` comment:

| file | change | rationale |
| --- | --- | --- |
| `loaders/ply/INRIAV1PlyParser.js` | `f_dc_*` treated as linear RGB, not SH DC | measured: all 133,541 points lie inside [0, 1] |
| `splatmesh/SplatMaterial3D.js` | fragment discards below 1/255 alpha instead of `A > 8.0` | keeps the appearance baseline of the previously validated UIKA renders |
| `splatmesh/SplatMaterial.js` | UIKA expression basis block in the vertex shader | the animated-centre equation, under UIKA names |
| `splatmesh/SplatMesh.js` | `setUikaBasis` / `setUikaWeights` / `applyUikaUniforms` / `bindUikaDistanceUniforms`, the same basis evaluation in the GPU distance shader, and no splat-octree build | GPU-resident D_UIKA, and one animated centre shared by render and sort |

Full rationale, with the measurements behind each change:
`docs/UIKA_NATIVE_RUNTIME_GATE3B_FORK_BOUNDARY.md` §5.

## Not forked

`Viewer.js`, `OrbitControls.js`, `SceneHelper.js`, `ArrowHelper.js`, `ui/**`,
`raycaster/**`, `webxr/**`, `worker/SortWorker.js` (and its four `.wasm` blobs),
`loaders/splat/**`, `loaders/ksplat/**`, `loaders/SceneFormat.js` and
`loaders/Utils.js` are not part of this fork.

`../uika-gaussian-viewer.ts` replaces `Viewer.js` and contains no third-party code.
The depth sort is a project-owned counting sort, so no upstream worker or WebAssembly
blob is vendored.

## Upstream package is untouched

`node_modules/gaussian-splat-renderer-for-lam` is not modified, not patched and not
re-versioned. The normal LAM path keeps using it exactly as before.
