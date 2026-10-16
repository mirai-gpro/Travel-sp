# UIKA Native Runtime v1.1 — LAM Reference Runtime sort PoC

Gate 4B-2B-3A (the 4 Hz cadence trial) is **stopped**. This document records the change of
direction and the PoC that replaces it.

| field | value |
| --- | --- |
| route | `/uika-native-lam-sort` (new; every earlier diagnostic route untouched) |
| acceptance | `gate4b2c-v1-structural-pass-plus-human-visual` |
| production integration | none |
| status | real-GPU A/B/C/D measured; STOP per §"STOP" — nothing adopted |
| variants | A no-sort · B exact animated-centre + main-thread sort · D exact animated-centre + LAM worker · C canonical-centre + LAM worker |

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
| `gpuAcceleratedSort` | **`true`** (`render.ts`) | **variant D reproduces it; variant C does not** | The real LAM runtime uses GPU distance → `fenceSync` → `getBufferSubData` → Worker/WASM sort. Variant **D** is that arrangement, with UIKA's animated-centre distance pass in place of `SplatMesh.computeDistancesOnGPU` and `usePrecomputedDistances: true`. Variant **C** keeps the canonical-centre, readback-free adaptation; it is a deliberate UIKA adaptation and is **not** a reproduction of the LAM runtime. |
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

| run | depth keys | sort |
| --- | --- | --- |
| `A-no-sort` | — | sorting suspended; everything else identical |
| `B-exact-animated-centre-sort` | animated centre, GPU distance pass + fence + `getBufferSubData` | project-owned main-thread counting sort |
| `D-lam-exact-distance-worker-sort` | **the same**, from the same function object | vendored LAM Worker/WASM, `usePrecomputedDistances: true` |
| `C-lam-canonical-centre-worker-sort` | canonical centre, computed inside the worker, no readback | vendored LAM Worker/WASM, `usePrecomputedDistances: false` |

What each pair isolates:

| pair | difference | question |
| --- | --- | --- |
| B → D | only the sort implementation | the LAM Worker/WASM migration effect |
| D → C | only the distance source and its readback | the GPU→CPU distance/readback cost |
| A → C | the whole canonical worker sort | what that sort still costs over no sort |

No second distance shader exists. `measureRun` builds **one** `distanceProvider` closure over
`UikaPredeformPass.computeDistances` and hands the same object to `viewer.setDistanceProvider`
for B and to `host.setDistanceSource` for D. In D the host sets `running` **before** the GPU
distance pass, because that pass is part of the submission; otherwise one frame could start
several distance passes.

D is invalid unless all of these hold, and the harness refuses the comparison when they do not:
`readbackPathExercisedInD` (the pre-deformation pass's own counters show a GPU distance
submission **and** a readback), `dUsedPrecomputedDistances`, `distanceErrors == 0`, and, for
every run, the warm-up drain and post-window drain both completed and `submitted == completed`.

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

No production integration, no Gate 5 Live, no canonical-sort adoption, no readback
elimination, no integer-sort migration, no Gaussian reduction, no basis reduction, no LOD,
no half float, no new GPU sort implementation, and no project-written sort algorithm inside
the worker.

`integerBasedSort` stays `false` for **every** variant, D included, so D's precomputed
distances are float. LAM's own default is `true`. This gate does not change the numeric
representation of the splat data; an integer variant is a separate decision to be taken
only if these results call for it. The deviation is carried in every report.

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

### 12.1.1 B vs D — measured, and it does NOT match

The gate's own expectation was that two sorts given the same depth keys should produce the
same order. **They do not**, and the harness measured why rather than arguing about it.

Frame 20, SwiftShader, both sorts fed from the same `computeDistances` call:

| measurement | value |
| --- | --- |
| depth keys handed to the two sorts | **bit-identical** (`maxDepthKeyAbsDifference = 0`) |
| same splat multiset | yes |
| index positions differing | **132,487 / 133,541**, first at position 10 (B→128348, D→131730) |
| **distinct depth keys among the splats** | **133,355 / 133,541** |
| emitted key sequences identical | **no**, first differing at position 10, max difference 4.3805e-04 |
| depth key range | [-0.0607986, 0.2073789], span 0.2681775 |
| B worst local inversion | 4.0829e-06 = **1.5225e-05** of the range |
| D worst local inversion | 4.4565e-04 = **1.6618e-03** of the range |
| framebuffer | 95,143 differing pixels, max RGBA byte delta 17, max alpha byte delta 2 |

Reading these in order:

1. With 133,355 distinct keys among 133,541 splats there is almost no exact tie, so the
   disagreement is **not** tie-breaking. The verdict is `ORDER_DIFFERS`, not
   `TIE_ORDER_DIFFERS`.
2. Neither order is exactly monotonic in the raw float key, which is expected of any
   bucketed counting sort. What differs is by how much: the project-owned sorter's worst
   local inversion is 1/65,700 of the key range, the LAM worker's is 1/602 — about 109x
   coarser, although both are configured with `1 << 16` buckets.
3. No claim is made here about what the WebAssembly module does internally. The numbers
   above are measurements of its output; its bucket mapping is not readable from this
   repository.

Consequence for the gate: **D is not "B's order produced by a worker"** — it is a different
order. A B→D performance difference therefore carries both the migration cost and whatever
the coarser ordering costs or saves, and must not be read as migration cost alone. The
framebuffer difference B vs D (95,143 px) is of the same order as B vs C (106,165 px on the
same frame), which is consistent with the two worker variants sharing a sort and differing
only in where their keys came from.

### 12.1.2 Two more harness defects the variant-D self-test found

1. Variant D reported **1 submitted, 2 completed**. The GPU distance pass alone measured a
   p50 of **9,305 ms** on this renderer, outrunning the fixed 10 s warm-up drain, so a
   warm-up sort completed inside the measured window. The drain timeout is now an option
   (`?lamIdleTimeoutMs=`, default 30 s) and every run records `idleBeforeMeasurement`,
   `drainedAfterMeasurement` and `submittedEqualsCompleted`. Any run failing one of them
   invalidates the whole comparison instead of being averaged in.
2. `host.setDistanceSource()` refuses to run while a sort is in flight, so `measureRun` now
   drains before it rewires anything.

### 12.2 Real GPU — A / B / C / D

ANGLE (AMD, AMD Radeon(TM) 860M Graphics (0x00001114) Direct3D11 vs_5_0 ps_5_0, D3D11),
Chrome 155, Windows, devicePixelRatio 1.5 with `setDrawingBufferScale(1/dpr)` so the
drawing buffer is 879 x 879 at pixelRatio 1.0. 3 repeats, round-robin A, B, D, C.
Run 2026-10-16T04:32:27Z, 3 min 39 s. GL errors 0, page errors 0.

**Every validity condition held, so the comparison is reported as valid**
(`analysis.valid = true`, `invalidReasons` empty):

```
readbackPathExercisedInD   true     D ran a GPU distance submission AND a readback
dUsedPrecomputedDistances  true     every D submission used usePrecomputedDistances
readbackPathExercisedInC   false    C ran no GPU distance pass at all
distanceErrors             0
workerErrors               0
drains (warm-up / post / submitted==completed)   all 12 samples y/y/y
interval samples per run   A 1310, B 973, D 1297, C 1285   (>= 30 required)
```

#### Means over 3 repeats

| run | FPS | exact wall p50 | exact wall p95 | p95 spread | GPU draw p50 | predeform p50 | sort Hz |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| A no-sort | 43.72 | 24.30 | **45.97** | 5.80 | 19.92 | 2.41 | — |
| B exact + main-thread sort | 32.43 | 8.40 | **118.40** | 2.90 | 26.51 | 2.97 | 5.88 |
| D exact + LAM worker | 43.25 | 8.40 | **98.93** | 1.50 | 19.62 | 1.90 | 7.45 |
| C canonical + LAM worker | 42.88 | 24.37 | **46.90** | 6.20 | 20.49 | 2.01 | 42.84 |

Worker stages, D and C (p50):

| | worker sort | index update | distance stage (GPU pass + fence + readback) | round trip |
| --- | ---: | ---: | ---: | ---: |
| D | 1.10 ms | 0.00 ms | **130.0 ms** (p95 154.6) | 1.60 ms |
| C | 1.00 ms | 0.00 ms | — (no distance pass) | 23.90 ms |

#### The three questions

| pair | isolates | p95 | FPS |
| --- | --- | ---: | ---: |
| **B → D** | the LAM Worker/WASM migration alone | **−19.47 ms** | **+10.82** |
| **D → C** | the GPU→CPU distance pass and its readback | **−52.03 ms** | −0.37 |
| **A → C** | what the canonical worker sort still costs | **+0.93 ms** | −0.84 |

Share of the B-over-A sort tail closed: **C 98.71 %**, **D 26.88 %**.

#### What the numbers say

1. **The GPU→CPU readback is essentially the whole sort tail.** C's p95 sits 0.93 ms above
   the no-sort run — inside both runs' own p95 spread (A 5.80, C 6.20) — while its sort
   runs at 42.84 Hz, i.e. once per rendered frame. D, which keeps the readback, still
   carries 52.97 ms of tail above A.
2. **Moving the sort to the worker helps, but does not remove the tail.** B → D is a real
   19.47 ms p95 improvement and +10.82 fps, 6.7x and far outside the p95 spreads — yet D's
   p95 is still 98.93 ms.
3. **The readback bounds the sort rate.** D's distance stage p50 is 130.0 ms, and D sorts
   at 7.45 Hz; 1/0.130 s = 7.7 Hz. B is slower still at 5.88 Hz. C, with no readback, sorts
   at the frame rate.
4. **B and D render in bursts.** Their wall p50 is 8.40 ms against a p95 near 100–120 ms,
   while A and C sit at p50 ≈ 24.3 ms with p95 ≈ 46 ms. The readback lumps its cost into a
   few frames rather than spreading it.
5. **None of the four meets the 30 fps / 33.3 ms p95 target** — including **A, which does no
   sorting at all** (p95 45.97 ms, 12.67 ms above target). Whatever remains of the tail at
   that point is not the sort. This gate records that and decides nothing about it.
6. **B's GPU draw p50 is 26.51 ms against 19.62–20.49 ms for the other three** (+6.59 ms
   over A). Measured, and not explained here.

#### Correctness, exact animated-centre sort vs C canonical-centre sort (192 frames)

Structural contract **PASS**: 192/192 compared, 0 GL errors, 0 page errors, 0 worker
errors, 389 sorts submitted and 389 completed, both modes rendering 133,541/133,541.

| | value |
| --- | --- |
| pixel-identical frames | 1 / 192 |
| worst different pixels | 57,844 = 7.4865 % (frame 20) |
| mean different-pixel ratio | 6.8264 % |
| worst max RGBA byte delta | 60 (frame 132) |
| worst max alpha byte delta | 3 (frame 21) |
| frames with an alpha difference | 191 / 192 |

The difference is spread over the whole head — the 8 x 8 tile totals are non-zero in 46 of
64 tiles, heaviest in the upper-middle band (hair and forehead) and nowhere concentrated in
a single region.

**Visual gate: still `REQUIRES_HUMAN_INSPECTION`.** On the six worst frames the two renders
are, at full frame and at 3x magnification over the mouth, not distinguishable by the
author of this document: the mouth interior, lip edges, teeth, nose and silhouette match,
and the difference mask is a diffuse speckle over hair strands and skin shading rather than
a layering failure. That is an observation offered alongside the captures, not a PASS.

#### B vs D — measured again on the real GPU, and it still does not match

192 frames, and the SwiftShader result reproduces exactly:

| | value |
| --- | --- |
| frames with identical index order | **0 / 192** |
| frames pixel-identical | 0 / 192 |
| depth keys bit-identical in every frame | **yes (192/192, max difference 0)** |
| same splat multiset in every frame | yes (192/192) |
| differing index positions | mean 132,512 of 133,541 (min 132,450, max 132,578) |
| emitted key sequences identical | **no (0/192)**, max difference 4.8865e-04 |
| distinct depth keys | 133,308 – 133,375 of 133,541 |
| worst local inversion, project sorter | 1.5255e-05 of the key range |
| worst local inversion, LAM worker | 1.8111e-03 of the key range (**≈ 119x coarser**) |
| framebuffer | mean 52,110 differing pixels, max 53,226; max RGBA delta 33, max alpha delta 3 |

With 133,308+ distinct keys among 133,541 splats this is not tie-breaking. Both orders are
bucketed and neither is exactly monotonic in the raw float key, but the two bucket
granularities differ by about two orders of magnitude although both are configured with
`1 << 16` buckets. No claim is made about the WebAssembly module's internals.

**Consequence: the B → D figure above is not migration cost alone.** D does not reproduce
B's order; it produces a coarser one. −19.47 ms p95 and +10.82 fps is the combined effect of
moving the sort off the main thread and of ordering more coarsely, and this gate does not
separate them.

#### Not decided

Per §"STOP": no production integration, no Live Gate 5, no canonical-sort adoption, no
readback elimination, no integer-sort migration.
