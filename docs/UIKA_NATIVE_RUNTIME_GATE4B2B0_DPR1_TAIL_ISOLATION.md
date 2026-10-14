# UIKA Native Runtime — Gate 4B-2B-0 DPR1 Tail-Latency Isolation

Spec: UIKA Native Runtime v1.1 Gate 4B-2B-0.
Route: `/uika-native-predeform-benchmark`, fourth button — **Run DPR1 Tail Isolation**.
Status: instrumentation delivered and self-tested. The measurement has to be taken on the
machine with the real GPU, so §6 is PENDING until that run comes back.

---

## 0. Where this starts

Gate 4B-2A on the real GPU (`UIKA_NATIVE_RUNTIME_GATE4B2A_PREDEFORMATION_POC.md` §6):

```text
GATE4B2A_CORRECTNESS = PASS
FULL_DPR_PERF        = FAIL
DPR1_PERF            = FAIL
overall performance  = FAIL
```

The pre-deformation approach itself measured a large improvement:

```text
FULL DPR real A2E   production 12.56 fps  ->  predeform 23.38 fps
                    GPU draw p50 74.90 ms ->  38.42 ms
                    GPU sort p50  5.95 ms ->   0.66 ms

pixelRatio 1.0      predeform 45.19 fps
                    GPU pre-deformation p50  2.03 ms
                    GPU draw p50            17.71 ms
                    GPU sort p50             0.62 ms
                    wall p95                68.90 ms
```

At DPR 1 the average is past 30 fps — 45.19 fps is 22.13 ms per frame, and the three
stages sum to 20.36 ms, which accounts for it — while wall p95 is 68.90 ms, 3.11x the
mean. Throughput is not what fails acceptance; the tail is. This gate locates the stall.

Full DPR is not re-measured: at a pre-deformed draw p50 of 38.42 ms the draw alone exceeds
the 33.3 ms budget, so `FULL_DPR_PERF_FAIL` already stands (§10 of the gate). All the tail
work is at DPR 1.

**No optimisation here.** Not done in this gate: any `DepthSorter` algorithm change, Web
Worker, WASM, GPU sort, sort-frequency reduction, index-upload change, Gaussian reduction,
basis reduction, LOD, half float, production integration, Gate 5 Live.

---

## 1. Benchmark contamination, fixed first (§1)

The deformation-pass hooks were installed once for the whole benchmark run, so the
**production** measurement ran the pass too: `predeformPassCount` 197 at DPR 1.5 and 261
at DPR 1.0. A production baseline that runs a pre-deformation pass is not a baseline.

```text
predeform mode     setPreRenderHook / setExpressionWeightHook installed
production mode    both cleared to null
```

and a production measurement is now marked **invalid**, with the reason recorded, unless

```text
predeformPassCount == 0
gpuPredeform sample count == 0
```

Diagnostic harness only; the production runtime is unchanged. The affected Gate 4B-2A
production figures are kept with the caveat attached rather than quietly replaced — see
that document's §6.1.

---

## 2. `realA2eTotalGpuP50` renamed (§2)

`p50(A) + p50(B) + p50(C)` is not `p50(A + B + C)`, and the stages do not all run on every
frame (full DPR: 330 passes in 703 frames; DPR 1: 687 passes and 282 sort runs in 1356
frames). The field is now `realA2eSumOfStageP50s`, with `realA2ePassCount`,
`realA2eSortRuns` and `realA2eRenderedFrames` beside it and `sumOfStageP50sSavedMs` for
the difference. Report terminology only.

---

## 3. Exact render intervals (§3)

The benchmark measured frame intervals by polling `viewer.stats.renderedFrames` from a
second `requestAnimationFrame` and splitting the elapsed time evenly whenever the counter
had advanced by more than one — which smears exactly the spikes a tail investigation is
looking for.

The viewer now calls a benchmark-only hook once per actual `render()`, with that frame's
own `performance.now()` timestamps:

```ts
setFrameTickHook((tick) => { /* tick.startedAt, tick.endedAt, tick.sortSubmitted */ })
```

It is `null` on every production route and completely inert there. Intervals are the
differences between consecutive `startedAt` values, reported as
`exactFrameInterval` with count / mean / p50 / p90 / p95 / p99 / max. The old polled
figures are reported alongside as `polledFrameInterval` so the two can be compared. The
§11 judgement in this gate uses the exact interval.

---

## 4. The sort lifecycle, stage by stage (§4)

The GPU sort timer only ever covered the transform-feedback submission. Each stage is now
timed separately, every one with count / mean / p50 / p90 / p95 / p99 / max:

```text
A  submitCpuMs        runSort's submission, on the CPU
B  fenceWaitMs        from the fence being created after drawArrays to it signalling
C  readbackMs         the getBufferSubData call
D  cpuSortMs          DepthSorter.sort
E  indexUpdateMs      updateRenderIndexes
F  totalLifecycleMs   runSort entry -> updateRenderIndexes complete
   fencePolls         how many setTimeout polls the fence took
```

B and C live inside the pre-deformation pass, which owns the fence and the buffer, so the
pass records them through its own optional recorder. The production
`SplatMesh.computeDistancesOnGPU` is **not** instrumented, because editing production
`SplatMesh.js` is forbidden — and it is not needed: this gate measures the pre-deformed
path only.

---

## 5. Sort counters and pending (§5)

```text
sortRequestedCount     runSort was entered
sortSubmittedCount     a sort actually started
sortCompletedCount     a sort finished
sortPendingSkipCount   a sort was wanted but one was already in flight
pendingDurationMs      how long the in-flight sort had been pending when that happened
```

This is what puts a number on the DPR 1 run's 687 weight uploads against 282 sort runs:
405 wanted sorts did not start, and the skip counter and pending duration say when and for
how long.

---

## 6. Frame-to-sort correlation (§6)

Every rendered frame is tagged, from inside the frame tick:

```text
weightChangedSincePreviousFrame
predeformRanSincePreviousFrame
sortSubmittedSincePreviousFrame
sortCompletedSincePreviousFrame
sortReadbackOccurred
cpuSortOccurred
renderIndexUpdateOccurred
exactWallInterval
```

and the summary splits the frames in two and compares their interval distributions:

```text
framesWithSortCompletion      count + p50 / p90 / p95 / p99 / max
framesWithoutSortCompletion   count + p50 / p90 / p95 / p99 / max
```

Per-frame records are kept in the JSON up to `maxFrameRecords` (4000 by default, which
covers a 30 s run at these rates).

---

## 7. The runs (§7, §8)

All at pixelRatio 1.0, pre-deformed, real A2E, 759 x 759, 6 s warm-up and 30 s measured.

```text
Run A  NORMAL                    the sort pipeline as it stands
Run B  SORT SUSPENDED            no sort at all; same fixture, same pre-deformation,
                                 same render shader, same DPR, same 133,541 Gaussians —
                                 nothing but the sort changes
Run C  DISTANCE / READBACK ONLY  GPU distance + fence + getBufferSubData;
                                 no DepthSorter.sort, no updateRenderIndexes
Run D  DISTANCE + CPU SORT       the above plus DepthSorter.sort; no updateRenderIndexes
```

Runs C and D run when Run B brought the exact wall p95 inside the target, or when forced
with `?cd=1`; otherwise the report says why they were skipped. B, C and D are diagnostic
truncations and are **not** valid for any visual or correctness judgement — Run B is also
how §7 asks the question "is the tail the sort at all" and nothing more.

Query parameters: `?warmupMs=`, `?measureMs=`, `?cd=1|0`, `?maxFrameRecords=`,
`?allowSoftware=1`.

§13 is unchanged: `setDrawingBufferScale()` moves only `setPixelRatio`, so the viewport and
focal uniforms stay on the full-DPR basis, the clip-space geometry is fixed, and only the
raster sample count drops. That is what makes DPR 1 a diagnostic rather than a different
scene.

---

## 8. Classification (§9)

Shares are taken against Run A's exact wall p95, each step removing exactly one stage:

```text
A -> B   the whole sort            sortShareOfP95
A -> D   the render-index update   indexUpdateShareOfP95
D -> C   the CPU counting sort     cpuSortShareOfP95
C -> B   distance + fence + readback   readbackShareOfP95
```

```text
sort share < 0.3                                  SORT_PIPELINE_NOT_PRIMARY
sort share >= 0.3, C and D not run                SORT_PIPELINE_TAIL_CONFIRMED
one stage >= 0.5 and >= 2x the next                READBACK_SYNC_DOMINANT
                                                   CPU_DEPTH_SORT_DOMINANT
                                                   INDEX_UPDATE_DOMINANT
otherwise                                          MIXED_SORT_COMPLETION
Run A or B produced no valid sample                UNRESOLVED
```

The 0.3, 0.5 and 2x figures are decision rules chosen for this gate, not measured
quantities. Nothing outside the measured stages is named as a cause.

---

## 9. Target (§11) — unchanged

```text
effectiveFPS      >= 30
exact wall p95    <= 33.3 ms
GL errors         = 0
page errors       = 0
```

Only Run A is judged against it; the truncated runs carry `meetsTarget: null` because they
do not render a valid result.

---

## 10. Results — PENDING (real GPU)

```text
GPU / browser / drawingBuffer                                      PENDING

Run A  fps, exact p50/p90/p95/p99/max, polled p95                  PENDING
Run B  the same                                                    PENDING
Run C  the same                                                    PENDING
Run D  the same                                                    PENDING

sort lifecycle per run  submit / fence / readback / cpu sort /
                        index update / total, each p50-p95-p99      PENDING
sort counters           requested / submitted / completed / skipped PENDING
pending duration        p50 / p95 / p99 / max                       PENDING
frame correlation       with vs without sort completion             PENDING
GL errors / page errors / visibilityLostMs                          PENDING

CLASSIFICATION                                                      PENDING
```

Nothing above is estimated or extrapolated.

---

## 11. How to run it

```text
1. Open  /uika-native-predeform-benchmark  on the real-GPU machine.
2. Wait for the buttons to enable.
3. Close DevTools. Keep the tab visible and in the foreground; do not switch tabs and do
   not minimise the window for the whole run.
4. Click Run DPR1 Tail Isolation.
5. When it finishes, click Export JSON.
```

Two runs of 36 s if Run B does not clear the tail, four if it does — about 2.5 minutes at
most. The page switches to pixelRatio 1.0 itself and restores everything afterwards.

---

## 12. Harness self-test (not a Gate 4B-2B-0 result)

Two runs on this container (ANGLE + SwiftShader, so the timings are not evidence — only
the instrument is being checked): `?allowSoftware=1&warmupMs=3000&measureMs=14000&cd=1`
to force all four runs, and `?...&measureMs=10000&cd=0` to check the skip path.

**Each run truncates exactly where it should.** Lifecycle sample counts per run:

```text
run                        submit  fence  readback  cpuSort  indexUpdate
A-normal                        2      2         2        2            2
B-sort-suspended                0      0         0        0            0
C-distance-readback-only        1      2         2        0            0
D-distance-plus-cpu-sort        2      2         2        2            0
```

and the per-frame tags agree: in Run B every `sortSubmitted` / `sortCompleted` /
`sortReadbackOccurred` / `cpuSortOccurred` / `renderIndexUpdateOccurred` is false, in
Run C the readback flags are set and the CPU-sort and index flags are not, in Run D the
CPU-sort flag is set and the index flag is not.

**The exact interval is not the polled one.** Run A reported

```text
exact wall p95    8222.0 ms
polled wall p95   4207.6 ms
```

a factor of 1.95 between the two on the same frames, which is exactly the smearing §3
describes: the polled method divides a long gap evenly across the frames it missed. The
tail judgement uses the exact figure.

**Everything else populates.** Counters (`requested 4 / submitted 2 / completed 2 /
pendingSkip 2`, pending duration p95), frame correlation (frames with a sort completion
p95 3833.2 ms against 8222.0 ms without), `fencePolls` p50, GPU predeform / draw / sort
buckets, `frameRecords`, `glErrors 0`, `pageErrors 0`, `pageerror events 0`, `finishedAt`
set, and the shader, sort stage, sort suspension and drawing-buffer scale all restored
afterwards.

**One defect found and fixed in the harness itself.** `maxFrameRecords` came back as 0 on
the first run, so no per-frame record was kept: `Number(q.get('maxFrameRecords'))` is
`Number(null)` = 0 when the parameter is absent, and 0 passes a `>= 0` test — the same
defect class that cost Gate 4B-1 four of its five Diagnostic 3 points. Every numeric query
parameter here is now parsed only when the parameter is present. Verified:
absent -> 4000, `'0'` -> 0, `'500'` -> 500. After the fix Run A and Run B both kept their
four frame records.

**The classifier behaves on nonsense input.** On this renderer the sort share came out at
-3.9% (the truncated run measured slower than the fuller one, which at three samples is
noise), and the report says so in `classificationBasis` instead of treating a negative
share as a stage cost; `SORT_PIPELINE_NOT_PRIMARY` was returned because the sort share is
below the 0.3 rule, and the `>= 0.5` guard means a negative share can never be named
dominant.

---

## 13. STOP

The gate ends when the tail stall is classified. Optimisation is decided afterwards, in a
separate gate, from these numbers.
