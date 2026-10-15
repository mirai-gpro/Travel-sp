# UIKA Native Runtime v1.1 — LAM Reference Runtime sort PoC

Gate 4B-2B-3A (the 4 Hz cadence trial) is **stopped**. This document records the change of
direction and the PoC that replaces it.

| field | value |
| --- | --- |
| route | `/uika-native-lam-sort` (new; every earlier diagnostic route untouched) |
| acceptance | `gate4b2c-v1-structural-pass-plus-human-visual` |
| production integration | none |
| status | harness complete and self-tested; awaiting the real-GPU run |

---

## 1. What changed

Out of the PoC path (§2 of the instruction — removed from the diagnostic path, **not**
deleted; the code stays as the comparison baseline):

```
animated centre
  -> GPU distance transform feedback
  -> fenceSync
  -> clientWaitSync
  -> getBufferSubData
  -> CPU counting sort
  -> explicit sort cadence
```

In:

```
canonical Gaussian centres
  -> Web Worker
  -> WebAssembly depth sort
  -> sorted indexes
  -> SplatMesh.updateRenderIndexes
```

Kept unchanged (§1): the 133,541 canonical Gaussians, `D_UIKA`, the pre-deformation pass,
the animated-centre texture, the 51 ARKit basis channels, `UikaExpressionMapper`, the JP
mouth correction, the real-A2E fixture, the render shader and the Gaussian appearance. The
draw position is still `canonical + D_UIKA x weights`.

---

## 2. The sort is not project-written

`src/scripts/chat/uika-native/renderer/vendor/worker/` holds the LAM lineage sort verbatim:

| file | provenance |
| --- | --- |
| `SortWorker.js` | `gaussian-splat-renderer-for-lam@0.0.9-alpha.1` `src/worker/SortWorker.js`, recovered from that package's published source map. `sortWorker()` and `createSortWorker()` are **byte-identical**; only the five `import` lines were rewritten. |
| `sorter-wasm.js` | the four base64 `.wasm` payloads exactly as the LAM bundle inlines them (`var SorterWasm = "AGFzbQ…"`). |

Verified, not assumed:

* `diff` of the LAM `SortWorker.js` against `@mkkellogg/gaussian-splats-3d@0.4.6`'s own
  `SortWorker.js` (also from its source map) differs in **exactly two lines** — the LAM
  fork drops the `Math.min(..., uploadedSplatCount)` clamp on the render and sort counts.
  The LAM version is the one vendored, because this is a LAM-reference comparison. UIKA
  uploads all 133,541 centres in one range before the first sort, so the clamp is a no-op
  either way.
* SHA-256 over each of the four base64 literals: LAM and upstream 0.4.6 are **identical**
  (2988, 2796, 2888, 2792 characters; all four decode to the `\0asm` magic).

The `import` rewrite, and the only project-authored change to the file:

```
-  import SorterWasm from './sorter.wasm';          (and three more)
+  import { SorterWasm, … } from './sorter-wasm.js';
```

This project's Astro/Vite build has no rollup wasm-to-base64 plugin, which is what
produced those literals in the LAM bundle in the first place. `createSortWorker()`'s
`atob(sourceWasm)` is untouched.

---

## 3. Configuration, and the two deviations from LAM's own options

Read off the LAM fork's `Viewer.js` and `render.ts`:

| option | LAM value | this PoC | why |
| --- | --- | --- | --- |
| `useSharedMemory` | `false` (hard-coded in the LAM fork) | `false` | same |
| `enableSIMDInSort` | `true` (default) | `true` | same |
| `splatSortDistanceMapPrecision` | `16` → 65,536 buckets | `16` | same |
| `dynamicMode` | `false` | `false` | same |
| `gpuAcceleratedSort` | **`true`** (`render.ts`) | **not used** | §2 removes the GPU distance / fence / readback path. The same unmodified worker is run with `usePrecomputedDistances: false`, where the WebAssembly module computes the depth keys itself from the uploaded centres. That is the upstream default path, not a new one. |
| `integerBasedSort` | **`true`** (default) | **`false`** | LAM passes this one flag to *both* `createSortWorker` and the `SplatMesh` constructor as `integerBasedDistancesComputation` (`Viewer.js:367-368`), so the uploaded centre array and the way the worker reads it always agree. UIKA's `SplatMesh` is built with `integerBasedDistancesComputation = false` and §1 keeps it that way, so float centres are uploaded and the worker is told to read float centres. `?lamIntSort=1` runs the integer variant instead (centres then come from `getIntegerCenters()` explicitly). |

Both deviations are carried in the report as `sortConfiguration.deviationsFromLamDefaults`,
so no run can be read without them.

---

## 4. Canonical centres, deliberately

The array uploaded to the worker is `SplatMesh.getFloatCenters(0, 133540, true)` — the
canonical centres straight out of the splat buffer. No basis, no weights, no animated
centre. Only the draw uses the animated ones (§4 of the instruction).

The report records the canonical centre AABB actually uploaded, the array type and its byte
size, so the quantisation is inspectable rather than inferred — and, for the integer
variant, the AABB after `Math.round(x * 1000)`.

It also records an **emitted-order probe**: for one completed sort, the clip-space z of the
first and the last emitted index, recomputed on the CPU from the canonical centre and the
same matrix. This states which end of the order is farther from the camera as a
measurement. No claim is made about what the WebAssembly module computes internally.

---

## 5. Cadence: none

The only back-pressure is LAM's own, taken from `Viewer.js:runSplatSort`:

```
every rendered frame:  request a sort
if one is already running:  drop the request
else:  submit the latest matrix
```

No 4 Hz, no 250 ms, no deadline, no timer. Because the policy is "every frame requests",
the viewer bypasses its own `sortDirty` flag while an external driver is installed — that
flag is UIKA's, not LAM's.

---

## 6. Counters

Per §6, each performance run reports `sortRequested`, `sortSubmitted`, `sortCompleted`,
`sortSkippedWhileRunning`, `sortSkippedBeforeReady`, `workerSortMs` (as the worker itself
measured it), `indexUpdateMs`, `submitMs`, `roundTripMs`, `workerErrors` and
`effectiveSortHz`. 133,541 points are never sorted on the main thread.

---

## 7. Runs

Measured round-robin (A, B, C, A, B, C, …) so that session drift lands on all three
equally, `?lamRepeats=N` samples each, means compared rather than first runs.

| run | sort |
| --- | --- |
| `A-no-sort` | sorting suspended; everything else identical |
| `B-exact-animated-centre-sort` | the existing path: animated-centre GPU distance pass, fence, readback, CPU counting sort |
| `C-lam-canonical-centre-worker-sort` | the LAM reference canonical-centre Worker/WASM sort |

`readbackPathExercisedInC` is reported explicitly: if any GPU sort-submission timer sample
appears in run C, run C was contaminated and its numbers do not answer the question.

---

## 8. Correctness contract — separate, and with no automatic visual PASS

`lam-sort/uika-lam-sort-contract.ts` is a **new** contract. The Gate 4B-2A contract (v1
pixel-identical, v2 numeric + visual equivalence) is **not imported and not reused**,
because the two gates compare different things:

* Gate 4B-2A compared two implementations of the *same* equation, so a one-byte tolerance
  was a statement about float32 rounding.
* This gate compares two *different* depth orders. The differences are alpha-compositing
  differences from a genuinely different draw order. A one-byte tolerance would say
  nothing about whether they are acceptable.

So this contract carries **structural checks only** — all fixture frames compared, zero GL
errors, zero page errors, zero worker errors, every submitted sort completed, and both
modes rendering all 133,541 splats. The visual dimension is reported as
`REQUIRES_HUMAN_INSPECTION` and the harness can never return a visual PASS.

Measured per frame, both modes, over the whole real-A2E fixture (192 frames, once each):
`differentPixels`, `differentPixelRatio`, `maxRgbaByteDelta`, alpha reported separately
(`maxAlphaByteDelta`, `differentAlphaPixels`, `alphaPlaneIdentical`, `alphaSum` for both),
`nonZeroPixels` for both, the byte-delta histogram, the bounding box of the difference, and
the difference localised to a fixed 8×8 tile grid.

---

## 9. Visual gate

§9 asks for the mouth interior, lips, teeth, nose, eyes and face silhouette to be
inspected. The harness does not label face parts — doing so would be a guess. Instead it:

* localises every difference to a fixed 8×8 tile grid, per frame and summed over the
  fixture, rendered as a heat grid on the page; and
* re-renders the worst `?lamCaptures=N` frames and keeps **three PNGs each** — the exact
  sort, the LAM sort, and a difference mask (white where any RGBA channel differs) — shown
  side by side for direct inspection.

The judgement "as unproblematic as LAM" is left to the viewer of those captures.

---

## 10. Performance

At pixelRatio 1.0 (`setDrawingBufferScale(1 / devicePixelRatio)`, CSS untouched):
`effectiveFPS`, exact per-`render()` wall interval percentiles, GPU draw, GPU
pre-deformation, worker sort time, render-index update time.

The question this gate exists for: **does the GPU→CPU readback tail disappear?** The
report answers it with `tailGapAboveNoSortB` and `tailGapAboveNoSortC` (each run's mean
exact p95 above run A's) and `tailGapClosedShare`, alongside the run-to-run p95 spread so a
difference inside the spread can be seen for what it is.

Target, unchanged from the tail gates: 30 fps and an exact wall p95 of 33.3 ms.

---

## 11. Not done

No production integration, no Gate 5 Live, no Gaussian reduction, no basis reduction, no
LOD, no half float, no new GPU sort implementation, and no project-written sort algorithm
inside the worker.

---

## 12. Results

To be filled in from the real-GPU run. The container this harness was written in runs
ANGLE + SwiftShader at roughly 0.25–0.3 fps, where correctness is measurable and
performance is not.

### 12.1 Container self-test (SwiftShader)

ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader
driver), drawing buffer 878 x 878, pixelRatio 1.0, frames `0,20,63,123,132,191`.
**Correctness is measurable here; performance is not** — the renderer produces roughly
one frame every 3.4 s.

**Vendored WebAssembly, checked outside the browser.** The `sorter.wasm` payload was
instantiated directly in Node with the same memory layout `SortWorker.js` computes, fed
eight points on the z axis and an identity matrix:

```
exports: __wasm_call_ctors, __wasm_apply_data_relocs, sortIndexes, emscripten_tls_init
emitted order (index, by z): 7 6 5 4 3 2 1 0
monotonic descending in z: true   ascending: false   permutation of 0..7: true
```

Farthest first, back to front — what `updateRenderIndexes` needs. The in-browser order
probe agrees: `farthestFirst: true` (first emitted clip-space z 0.97016, last 0.70209).

**Configuration actually used.** `integerBasedSort=false`, `enableSIMDInSort=true`,
distance map `1 << 16` = 65,536 buckets, `useSharedMemory=false`, `dynamicMode=false`,
`usePrecomputedDistances=false`. Canonical centres uploaded: `Float32Array`, 2,136,656
bytes for 133,541 splats, AABB x[-0.20702, 0.11541] y[-0.17729, 0.13352]
z[-0.20734, 0.06074].

**Structural contract: PASS.** 6/6 frames compared, 0 GL errors, 0 page errors, 0 worker
errors, 9 sorts submitted and 9 completed, both modes rendering 133,541/133,541.

**Measured difference, exact animated-centre sort vs LAM canonical-centre sort:**

| frame | different pixels | ratio | max RGBA byte delta | max alpha delta | alpha-differing pixels | non-zero pixels (exact / LAM) |
| ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 0 | 94,739 | 0.12290 | 21 | 2 | 1,655 | 422,096 / 422,096 |
| 20 | 106,165 | 0.13772 | 27 | 2 | 1,640 | 422,079 / 422,079 |
| 63 | 98,190 | 0.12737 | 33 | 2 | 1,644 | 422,097 / 422,097 |
| 123 | 98,589 | 0.12789 | 17 | 2 | 1,630 | 422,096 / 422,096 |
| 132 | 99,123 | 0.12858 | 35 | 2 | 1,659 | 422,089 / 422,089 |
| 191 | 93,637 | 0.12147 | 25 | 2 | 1,643 | 422,097 / 422,097 |

0 of 6 frames pixel-identical; mean different-pixel ratio 0.12765. The non-zero pixel
count is identical in both modes on every frame — the same Gaussians are drawn, in a
different order. The difference spreads over most of the head rather than concentrating
in one tile, and its amplitude stays well below the 1-byte-per-channel level that Gate
4B-2A's differences sat at: max RGBA byte delta 17–35, max alpha byte delta 2.

At full frame the two captures are not distinguishable by eye, and the difference mask
shows a diffuse speckle over hair strands and skin shading rather than a structural
compositing failure. **That is an observation, not the §9 verdict.** The captures are in
the report (`correctness.captures`, three PNGs per frame) and the visual gate stays
`REQUIRES_HUMAN_INSPECTION`.

**Performance: not measurable here, and the harness says so.** Each run rendered 1 frame
in its 3 s window, so every run carried 0 measured frame intervals and the comparison was
**refused**:

```
analysis.valid            false
invalidReasons            A/B/C each measured only 0 frame intervals; 30 are required
exactP95DeltaMs           null
tailGapClosedShare        null
readbackPathExercisedInC  false      <- run C ran no GPU distance pass, as intended
```

Two harness defects that this self-test found and that are fixed:

1. `renderedFrames` (and therefore `effectiveFPS`) counted frames rendered during the
   post-window drain. On a slow renderer the drain can render more frames than the window
   did. Now snapshotted before the drain, with `framesDuringDrain` reported separately.
2. The analysis computed p95 deltas from runs with too few samples. The first self-test
   produced run A with one rendered frame — zero intervals, p95 0.00 ms — and the analysis
   reported "100 % of the tail closed" from it. `MIN_INTERVALS_FOR_COMPARISON = 30` now
   refuses the comparison instead of estimating it.

### 12.2 Real GPU

_pending_
