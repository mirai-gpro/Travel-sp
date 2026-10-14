# UIKA Native Runtime — Gate 4B-1 GPU Draw Bottleneck Isolation

Spec: UIKA Native Runtime v1.1 Gate 4B-1.
Route: `/uika-native-draw-isolation`.
Status: harness delivered and self-tested. The measurement itself has to be taken on the
machine with the real GPU, so §6 is PENDING until that run comes back.

---

## 0. Where this starts

Gate 4A is FAIL (`UIKA_NATIVE_RUNTIME_GATE4A_REAL_GPU_BASELINE.md` §6.2). On
AMD Radeon(TM) 860M Graphics / Chrome 154 / Windows, drawingBuffer 1138 x 1138, DPR 1.5:

```text
Test A neutral      13.51 fps   GPU draw p50 73.16 ms   sortRuns 0
Test B fixed pose   13.16 fps   GPU draw p50 74.67 ms   sortRuns 0
Test C real A2E     13.03 fps   GPU draw p50 74.03 ms   GPU sort p50 6.85 ms
CPU mapper / weight upload / submission   approx. 0 - 0.2 ms

PRIMARY BOTTLENECK = GPU draw path
NOT PRIMARY        = CPU, mapper, weight upload, JS submission, sort alone
```

Gate 4B-1 does not optimise any of it. It splits those ~74 ms into

```text
A  raster / pixel fill
B  base Gaussian rendering
C  133541 x 51 basis evaluation
```

and stops once the split is measured.

---

## 1. What is NOT touched

Unchanged, and verified by blob SHA against the Gate 4A head `31fb3a0`:

```text
/uika-native-replay                 the page and its script
SplatMaterial.js                    the production shader source
SplatMesh.js                        production behaviour
uika-expression-mapper.ts           the mapper
LAMAvatar.astro, lam-websocket-manager.ts, live-audio-manager.ts,
uika-133k-mode.ts, a2e-replay.ts    normal LAM path
support-base/**                     backend, Live API, A2E
package.json, package-lock.json     dependencies
```

The old Gate 1/2 files (`uika-render-adapter.ts`, `uika-native-driver.ts`,
`uika-deformation.ts`) are kept untouched until Live passes.

Also not done, per §9: no basis texture format change, no half float, no basis
compression, no basis reduction, no Gaussian reduction, no LOD, no thresholding, no
active-channel skipping, no sort reduction, no precomputed deformation, no transform
feedback for deformation, no render-to-texture deformation, and no production shader
replacement. The diagnostic shader variants live only while the harness is running, and
the harness restores the production source before it returns — the report carries the
restored shader's fingerprint so that is checkable from the JSON.

---

## 2. How the three costs are separated

### Diagnostic 1 — resolution sweep (§3)

The same fixed pose, the same production 51-basis shader, three drawing-buffer sizes:
100 %, 50 %, 25 %. Only `WebGLRenderer.setPixelRatio` moves. The CSS size does not
change, `renderer.getSize()` keeps reporting the CSS size so the focal length this viewer
computes per frame does not move, and `SplatMesh.updateUniforms` derives `viewport` and
`basisViewport` from the mesh's own `devicePixelRatio`, which is also left alone. The
vertex shader therefore emits identical clip-space geometry at every scale and only the
number of rasterised samples changes. The exact drawing-buffer dimensions are read back
from GL into the JSON rather than computed.

```text
GPU draw falls a lot as resolution falls   raster / fill cost is significant
GPU draw barely moves                      vertex / per-Gaussian / basis cost dominates
```

No automatic resolution downgrade is implemented.

### Diagnostic 2 — canonical no-basis shader (§4, §5)

Same 133,541 Gaussians, same canonical data, same opacity, scale, rotation, SH/RGB, same
camera, same resolution. The one difference is that the 51-channel basis loop is **absent
from the shader source**:

```glsl
// production
for (int k = 0; k < uikaBasisCount; ++k) {
    splatCenter += uikaWeight(k) * uikaBasisDelta(k, splatIndex);
}

// canonical no-basis variant
// UIKA Gate 4B-1 diagnostic variant: the basis loop is absent from
// this shader source. No uikaBasisDelta / uikaWeight fetch is issued.
```

Setting the weights to zero is explicitly not used, because the Gate 4A Test A shader ran
51 iterations and 51 texture fetches with every weight at zero — that is why Test A was
13.51 fps and not faster than Test B. The variant is produced by matching the production
loop statement in the generated vertex-shader source and replacing only that statement,
so the rest of the shader is carried over character for character.

### Diagnostic 3 — basis-count scaling (§7, optional)

Run only when Diagnostic 2 shows the basis loop dominant (or forced with `?d3=1`). The
same variant mechanism with literal bounds 0, 8, 16, 32, 51. Expression correctness is
not evaluated here; the point is draw time against the number of basis fetches. The
report also carries a least-squares fit of `drawP50` against basis count, so the fixed
cost and the per-channel cost are separated.

---

## 3. Proof that the variant is real

A requested shader variant is worth nothing unless it actually compiled. Before any
measurement the harness renders three frames and hashes the drawing buffer:

```text
production shader + neutral weights    -> H0, the canonical pose
production shader + frame 20 weights   -> H1, must differ from H0
no-basis shader   + frame 20 weights   -> H2, must equal H0
```

The third frame is taken with the frame-20 weights still resident on the GPU, so H2 == H0
can only mean the loop is gone from the source. Sorting is suspended for the three
frames, so all of them share one draw order and the vertex shader is the only variable
(alpha compositing is order dependent). The harness also records, from the source itself,
that the production shader carries exactly one basis loop and one `uikaBasisDelta` call
and that the variant carries none. If any of this fails, the run stops at `INCOMPLETE`
and no numbers are reported.

---

## 4. GPU timer sanity rule (§8)

The Gate 4A run carried one obviously impossible GPU timer sample of
`184467.440737 ms` in Test A and one in Test B. A single GL command cannot take longer
than the measurement window it was issued in, so from now on a sample above that window
is excluded from the percentiles instead of being averaged in, and

```text
invalidSamples     how many were excluded
invalidValuesMs    the excluded values themselves, up to 16
invalidRuleMs      the threshold used, i.e. the measurement window
```

are written into the JSON for every test — nothing is hidden. The rule only touches
samples that are longer than the whole window, so every plausible sample, and therefore
the Gate 4A Test B and Test C percentiles already reported, is unaffected. The same
filter is now in the Gate 4A harness and in this one.

---

## 5. How to run it

```text
1. Open  /uika-native-draw-isolation  on the real-GPU machine.
2. Wait for "Start Diagnostics" to enable (the asset and the fixture are loaded by then).
3. Close DevTools. Keep the tab visible and in the foreground, do not switch tabs and do
   not minimise the window for the whole run.
4. Click Start Diagnostics.
5. When it finishes, click Export JSON.
```

The page needs no DevTools: drawing-buffer size, whether the basis loop is present,
effective FPS, GPU draw p50, GL errors and the conclusion are all on screen, and every
measurement lands in a table with fps, wall-clock p50/p95/p99, GPU draw p50/p95/p99, GPU
sort p50, sortRuns, GL errors and validity.

Duration: warm-up 6 s plus 30 s of measurement per point. Three resolution points and two
shader variants is about 3 minutes; the optional basis-count pass adds about 3 more.
A hidden tab marks that point invalid, exactly as in Gate 4A.

Query parameters for a quicker driver check: `?warmupMs=`, `?measureMs=`, `?scales=`,
`?basisCounts=`, `?d3=1|0`, and `?allowSoftware=1`, which runs the diagnostics on a
software renderer and forces the conclusion to `BLOCKED` so it can never be mistaken for
a result.

For the Diagnostic 3 completion run, the counts have to be passed explicitly:

```text
/uika-native-draw-isolation?d3=1&basisCounts=0,8,16,32,51
```

§6.2 has the measured reason why the default does not survive on its own.

---

## 6. Results

### 6.1 Run 1 — real GPU, 2026-10-14 (Diagnostics 1 and 2 valid, Diagnostic 3 incomplete)

The user ran the page on the real GPU and reported the result. Diagnostics 1 and 2 stand;
Diagnostic 3 came back with one point instead of five, for the reason in §6.2.

```text
variant proof      PASS

rasterShare        47.7 %
basisShare         56.4 %

production draw p50   91.25 ms
no-basis   draw p50   39.82 ms
no-basis   FPS        23.82

conclusion         = MIXED
basisLoopDominant  = YES
```

What that fixes, and nothing beyond it:

```text
the 51-channel basis loop is a major bottleneck
removing it entirely still does not reach 30 fps
raster / base Gaussian render cannot be ignored either
```

Arithmetic on the reported numbers, not an interpretation: the loop accounts for
91.25 - 39.82 = 51.43 ms of the production draw time, and what is left, 39.82 ms, is
already above the 33.3 ms a 30 fps frame allows for everything including the sort and the
CPU stages. 23.82 fps is 41.98 ms per frame.

§7's caution applies to these two shares: `rasterShare` and `basisShare` are not
orthogonal components of one budget and must not be added up to a 100 % breakdown. The
resolution sweep lowers the raster work of the same 51-channel shader, so part of what it
measures is also inside what the no-basis comparison measures.

One fact to carry into the rerun, recorded without a cause attached: production draw p50
here is 91.25 ms, while the Gate 4A clean rerun reported 74.67 ms for Test B — the same
pose, the same resolution, the same shader. Both are real measurements from different
runs. The shares above are computed only from comparisons inside one run, so they do not
depend on the two runs being comparable; `repeatabilityDeltaMs` in the rerun will put a
number on that spread, since Diagnostic 1 at 100 % and the Diagnostic 2 production point
measure the identical configuration twice.

Fields the user did not quote (per-measurement buffer dimensions, wall-clock percentiles,
draw p95/p99, GPU sort, GL and page errors, invalid GPU timer samples, and whether the
`184467.440737 ms` sample recurred) are not reproduced here and were not inferred.

### 6.2 Why Diagnostic 3 came back with one point

Reported from the JSON:

```text
diagnostic3.length           1
basisCount                   0 only
basisScalingFit              null
literal51MinusUniform51Ms    null
```

The cause is in `isolationOptionsFromUrl()` in `uika-draw-isolation.ts`, and it is
confirmed by reading the code and running the expression, not inferred from the symptom:

```js
const counts = (q.get('basisCounts') || '').split(',').map(Number)
    .filter((v) => Number.isInteger(v) && v >= 0);
if (counts.length > 0) o.basisCounts = counts;
```

With no `basisCounts` in the URL, `q.get('basisCounts')` is `null`, `(null || '')` is `''`,
`''.split(',')` is `['']`, `Number('')` is `0`, and `0` passes
`Number.isInteger(v) && v >= 0`. So `counts` is `[0]`, `counts.length > 0` holds, and the
default `[0, 8, 16, 32, 51]` is overwritten with `[0]`.

```text
absent  basisCounts  ->  [0]            measured, not assumed
explicit             ->  [0,8,16,32,51]
absent  scales       ->  []             the same shape of code, but its filter is v > 0,
                                        so 0 is rejected and the default survives
```

That is why Diagnostic 1 ran at the intended three scales and only Diagnostic 3 lost its
points. The Diagnostic 3 loop itself is correct: the one point it did run,
`d3-basis-0`, carries the right shader state.

This defect is **not fixed in this commit**, as instructed: no production code, shader or
renderer change for the rerun. The rerun passes the counts explicitly, which bypasses the
default path entirely.

### 6.3 Run 2 — Diagnostic 3 completion (PENDING)

```text
/uika-native-draw-isolation?d3=1&basisCounts=0,8,16,32,51
```

Same conditions as Run 1: DevTools closed, tab visible, no tab switching, no window
minimise, real GPU. Start Diagnostics, then Export JSON when it finishes.

Required from the run — all five points present:

```text
basis 0    GPU draw p50 / p95, effectiveFPS, valid, GL errors, page errors, invalid GPU timer samples   PENDING
basis 8    same                                                                                          PENDING
basis 16   same                                                                                          PENDING
basis 32   same                                                                                          PENDING
basis 51   same                                                                                          PENDING

basisScalingFit    interceptMs / msPerBasis / points = 5                                                 PENDING
literal51MinusUniform51Ms   (literal 51 vs the production uniform-bounded 51)                            PENDING
repeatabilityDeltaMs        (the noise floor those two should sit inside)                                 PENDING
```

The least-squares fit over the five points and `literal51MinusUniform51Ms` are already
implemented and need no change; with five valid points `basisScalingFit.points` reads 5.
`literal51MinusUniform51Ms` is produced as soon as a `d3-basis-51` point exists, and
whether it sits inside `repeatabilityDeltaMs` is the check that a literal bound of 51 and
the production uniform bound of 51 really are the same work.

Run 1's results are kept: the variant proof, the two shares, `MIXED` and
`basisLoopDominant = YES` stand as a valid result. Run 2 exists only to complete
Diagnostic 3.

### 6.4 Remaining fields — to be filled from the runs

```text
GPU / browser / DPR                                                      PENDING
Diagnostic 1  100% / 50% / 25%  buffer, fps, wall p50-p95-p99, draw p50-p95-p99   PENDING
Diagnostic 2  production / no-basis  fps, draw p50-p95-p99                PENDING
invalid GPU timer samples                                                PENDING
GL errors / page errors                                                  PENDING
```

Nothing above is estimated or extrapolated.

---

## 7. Classification rules as implemented

Computed from GPU draw p50 of valid measurements only:

```text
rasterShare      = (draw@100% - draw@25%) / draw@100%
basisShare       = (draw production - draw no-basis) / draw production
baseRenderShare  = 1 - basisShare
```

```text
basisShare >= 0.5 and rasterShare < 0.3   BASIS_LOOP_DOMINANT
rasterShare >= 0.5 and basisShare < 0.3   RASTER_DOMINANT
basisShare < 0.3 and rasterShare < 0.3    BASE_RENDER_DOMINANT
otherwise                                 MIXED

BASIS_LOOP_DOMINANT = YES  when basisShare >= 0.5
```

`rasterShare` and `basisShare` must not be added together as a 100 % breakdown. They are
not orthogonal components of one budget: the resolution sweep lowers the raster work of
the same 51-channel shader, so part of what it measures also sits inside what the no-basis
comparison measures, and the two overlap by an amount this gate does not separate. Each
share answers one question — "how much does the raster own" and "how much does the loop
own" — and nothing is claimed about their sum.

The 0.5 and 0.3 shares are decision rules chosen for this gate, not measured quantities:
a component counts as dominant when removing it takes at least half the draw time away,
and as not a factor when it takes less than 30 %. The report also states whether the
no-basis variant alone reaches 30 fps, which is the §6 Case A / Case B question:

```text
Case A   51 basis ~ 74 ms, no basis much lower   -> basis evaluation architecture is next
Case B   no basis still 50 - 70 ms               -> base render or raster is the main cost,
                                                    and basis optimisation alone will not
                                                    reach 30 fps
```

Two self-consistency numbers come out of the same data and are reported next to the
shares: `repeatabilityDeltaMs`, the gap between the two measurements of the identical
configuration (Diagnostic 1 at 100 % and the Diagnostic 2 production point), which is the
measurement noise floor; and `literal51MinusUniform51Ms`, a literal bound of 51 against
the uniform-bounded production loop, which is the same work and should therefore be close
to zero. A share that is not larger than the noise floor is not evidence.

A measurement whose tab went hidden is excluded from the shares and named in `reasons`;
if that leaves a share uncomputable the conclusion is `INCOMPLETE`, not a guess.

---

## 8. Harness self-test (not a Gate 4B-1 result)

This container has no GPU: Chromium falls back to ANGLE + SwiftShader, which §2 of the
Gate 4A spec excludes from any verdict. The self-test therefore only proves the driver
works. It ran with `?allowSoftware=1` and short windows, which forces the conclusion to
`BLOCKED`.

Run 1 — `?allowSoftware=1&warmupMs=3000&measureMs=12000&d3=1&basisCounts=0,8,51`

```text
conclusion                      BLOCKED (forced, as designed)
basisLoopDominant               UNDETERMINED
GL errors / page errors         0 / 0

variant proof                   ok = true
  production + neutral          frame hash fd2002df   shader 401299d2  loop uikaBasisCount  fetches 1
  production + frame 20         frame hash ab7e6127   shader 401299d2  loop uikaBasisCount  fetches 1
  no-basis   + frame 20         frame hash fd2002df   shader ba1e3a50  loop absent          fetches 0
  productionDeforms             true   (ab7e6127 != fd2002df)
  noBasisIsCanonical            true   (fd2002df == fd2002df, with all 51 pose weights resident)
  pose weights non-zero         51 of 51

drawing buffer per scale        386x386  ->  193x193  ->  96x96   (read back from GL)
restored shader after the run   401299d2, loop uikaBasisCount, 1 fetch — the production source
```

That is the point of the proof: the third frame is pixel-identical to the neutral frame
while every one of the 51 pose weights is resident, and its shader hash differs from the
production one. The loop is gone from the source, not zeroed.

Run 2 — same page with a 9 s window instead of 12 s

Every measurement came back with `gpuDrawMs.count = 0`, so every share is `null` and no
number was invented: at ~0.3 fps under SwiftShader a 9 s window is about three frames,
and a timer query is only polled four frames after it is submitted. The harness reports
the absence instead of filling it in, which is the behaviour that matters. On the real GPU
a 30 s window at ~13 fps is about 390 frames, so this does not arise there — but if a
future run ever comes back with `count = 0`, the conclusion will be `INCOMPLETE` rather
than a share computed from nothing.

Software-renderer numbers from these runs are deliberately not quoted as a result.

---

## 9. Changes in the harness commit (`44fc259`)

```text
new   src/pages/uika-native-draw-isolation.astro          Gate 4B-1 route, table and controls
new   src/scripts/chat/uika-native/uika-draw-isolation.ts harness, analysis, classification
edit  src/scripts/chat/uika-native/renderer/uika-gaussian-viewer.ts
        diagnostic-only, opt-in and inert by default:
          setDiagnosticBasisBound / getDiagnosticShaderInfo   shader variants
          setDrawingBufferScale / getDrawingBufferInfo        resolution sweep
          requestDrawingBufferHash / clearPendingDrawingBufferHash  variant proof
          setSortSuspended                                   one draw order for the proof
edit  src/scripts/chat/uika-native/renderer/index.ts       export the diagnostic types
edit  src/scripts/chat/uika-native/uika-native-benchmark.ts
        §8 invalid GPU timer sample rule; GpuTimerPool exported for reuse
edit  docs/UIKA_NATIVE_RUNTIME_GATE4A_REAL_GPU_BASELINE.md  clean rerun recorded, GATE4A = FAIL
```

With nothing calling the diagnostic methods, the generated shader source, every uniform
and the drawing-buffer size are exactly what Gate 3 and the Gate 4A rerun measured.
`tsc --noEmit` reports the same 9 pre-existing errors as before.

---

## 10. STOP

The gate ends when the cause is classified. Gate 4B-2 production optimisation is not
implemented, and Gate 5 Live is not started. The optimisation approach is decided after
this report.

The Run 1 record in §6 was added in a later, documentation-only commit: no file under
`src/`, `support-base/` or `tools/` was touched for it, so the harness the rerun uses is
byte-identical to the one Run 1 was measured with. The `isolationOptionsFromUrl()` defect
in §6.2 is deliberately left in place for that reason.
