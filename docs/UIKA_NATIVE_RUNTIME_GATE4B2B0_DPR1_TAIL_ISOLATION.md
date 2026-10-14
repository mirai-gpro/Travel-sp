# UIKA Native Runtime — Gate 4B-2B-0 DPR1 Tail-Latency Isolation

Spec: UIKA Native Runtime v1.1 Gate 4B-2B-0.
Route: `/uika-native-predeform-benchmark`, fourth button — **Run DPR1 Tail Isolation**.
Status: complete. All four runs measured on the real GPU with
`lifecycleInvariantFailures = 0`: the sort pipeline accounts for 36.98 % of Run A's exact
wall p95, split 29.87 % distance/fence/readback, 6.01 % CPU depth sort, 1.09 % index
update (§10.7). `classification = SORT_PIPELINE_TAIL_CONFIRMED_BUT_RESIDUAL_TAIL`. The
per-stage measurements leave 14.7 ms of the 16.4 ms B→C cost unaccounted for (§10.8),
which is what Gate 4B-2B-1 investigates.

Earlier status, kept: Run A and Run B measured on the real GPU —
**`SORT_PIPELINE_TAIL_CONFIRMED`**, 46.8% of Run A's exact wall p95 (§10.1). Not
concluded: that the sort is the sole source, because Run B is still 1.70 ms over target
(§10.2). One instrumentation bug found and fixed — `totalLifecycleMs` timed the latest
sort *request* instead of the submitted sort, so that one field from the earlier run is
void and nothing else is (§10.3, §10.4). Runs C and D now always execute; the stage
isolation is PENDING (§10.7).

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
A -> B   the whole sort                sortShareOfP95
A -> D   the render-index update       indexUpdateShareOfP95
D -> C   the CPU counting sort         cpuSortShareOfP95
C -> B   distance + fence + readback   readbackShareOfP95
```

```text
sort share < 0.3                                  SORT_PIPELINE_NOT_PRIMARY
sort share >= 0.3, C and D not run                SORT_PIPELINE_TAIL_CONFIRMED
one stage >= 0.5 and >= 2x the next                READBACK_SYNC_DOMINANT
                                                   CPU_DEPTH_SORT_DOMINANT
                                                   INDEX_UPDATE_DOMINANT
otherwise, no residual tail                        MIXED_SORT_COMPLETION
otherwise, Run B still above target                SORT_PIPELINE_TAIL_CONFIRMED_BUT_RESIDUAL_TAIL
Run A or B produced no valid sample                UNRESOLVED
```

`sortPipelineTailConfirmed`, `residualTailAboveTargetMs` and `sortIsSoleSourceOfTail` are
reported as their own fields, so the confirmed finding cannot be lost in the wording of a
later run's classification, and `sortIsSoleSourceOfTail` is never asserted true while a
residual tail remains.

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

## 10. Results

### 10.1 Run A and Run B — real GPU (valid)

```text
Run A  normal            effectiveFPS 42.63    exact wall p95 65.80 ms
Run B  sort suspended    effectiveFPS 46.10    exact wall p95 35.00 ms

p95 improvement          30.80 ms
share of Run A's p95     46.8 %

CLASSIFICATION = SORT_PIPELINE_TAIL_CONFIRMED
```

The sort pipeline is a major contributor to the tail. That finding stands and is not
retracted by anything below; the report carries it as its own field,
`sortPipelineTailConfirmed`.

Arithmetic on those figures: 42.63 fps is 23.46 ms per frame, so Run A's p95 is 2.80x its
own mean, and removing the sort takes 30.80 ms of that away.

### 10.2 What is NOT concluded (§11)

```text
Run B exact wall p95        35.00 ms
target                      33.3 ms
residual above target        1.70 ms
```

With no sort at all the p95 is still 1.70 ms over. So **"the sort is the sole source of
the tail" is not concluded**, and neither is "fixing the sort necessarily passes the
gate". The report states this as `residualTailAboveTargetMs` and
`sortIsSoleSourceOfTail: false`, and the classification
`SORT_PIPELINE_TAIL_CONFIRMED_BUT_RESIDUAL_TAIL` exists for exactly this shape of result.
A 30.80 ms improvement still makes the sort pipeline the first thing to investigate.

### 10.3 `totalLifecycleMs` was mis-instrumented (§1 - §3)

```text
fenceWait        p50 100.2 ms
totalLifecycle   p50   2.9 ms
```

Those cannot both describe one lifecycle: the fence wait happens inside it. The cause was
in the collector:

```ts
requested(at) { ...; this.lifecycleStartedAt = at; }   // wrong
```

`runSort()` is entered on every frame whose weights changed, including while a sort is
still in flight — in that run, 4 requests for 2 submissions with 2 pending skips per
window. Each of those later requests overwrote `lifecycleStartedAt`, so by the time the
submitted sort completed the field pointed at the most recent *request*.
`totalLifecycleMs` therefore measured "latest sort request -> completion", not
"submitted sort -> completion".

Fixed: the lifecycle starts in `submitStart()`, with the sort that is actually submitted;
`requested()` is a counter and writes no timestamp; `pendingSkip()` writes none either.

An invariant now guards it. For each completed sort, if

```text
totalLifecycle + 0.5 ms < fenceWait
```

the sample is counted in `lifecycleInvariantFailures` — which must be 0 — and the first 16
offending pairs are listed in `lifecycleInvariantDetails`. The 0.5 ms epsilon covers timer
granularity and the submit boundary and is a decision rule, not a measurement.

### 10.4 Which of the earlier results survive (§4)

Valid, and kept:

```text
Run A / Run B exact frame intervals
effectiveFPS
sort requested / submitted / completed / pendingSkip
frame-to-sort-completion correlation
the individual readback / cpuSort / indexUpdate timings
SORT_PIPELINE_TAIL_CONFIRMED
```

Void, and only this:

```text
totalLifecycleMs
```

The rest of the run is not invalidated.

### 10.5 How fenceWaitMs is read (§10)

`fenceWaitMs` is wall-clock elapsed from the fence being created after `drawArrays` to the
poll that finds it signalled. The polling is asynchronous `setTimeout`, so this is **not**
main-thread blocking time and is not reported as such. What it does say, as arithmetic: at
42.63 fps a 100.2 ms p50 fence wait spans about 4.27 rendered frames, which is consistent
with the sort completing several frames after it was submitted and with the pending-skip
count. How much of it lands on the wall interval is what Run C measures — that is the
question, not the assumption.

### 10.6 Runs C and D now always execute (§5)

The earlier build ran C and D only when Run B had brought the p95 inside the target, which
on the real GPU it did not (35.00 ms against 33.3 ms) — so the stage split, which is the
point of the gate, would have been skipped. C and D now run by default; `?cd=0` skips them.

```text
B -> C   distance + fence + readback contribution
C -> D   CPU DepthSorter contribution
D -> A   updateRenderIndexes / full-completion contribution
```

### 10.7 Stage isolation — result (real GPU)

All four runs, with `lifecycleInvariantFailures = 0` in every one, so the lifecycle
timings in this run are trustworthy.

```text
Run B  no sort                        exact p95 34.6 ms    FPS 52.90
Run C  distance + fence + readback    exact p95 51.0 ms    FPS 48.60
Run D  C + CPU DepthSorter            exact p95 54.3 ms    FPS 47.62
Run A  full pipeline                  exact p95 54.9 ms    FPS 47.92
```

```text
B -> C   +16.4 ms     distance / fence / readback
C -> D    +3.3 ms     CPU DepthSorter
D -> A    +0.6 ms     render-index update
```

As a share of Run A's exact wall p95:

```text
distance / fence / readback   29.87 %
CPU DepthSorter                6.01 %
render-index update            1.09 %
whole sort pipeline           36.98 %
```

```text
SORT_PIPELINE_TAIL_CONFIRMED = true
classification = SORT_PIPELINE_TAIL_CONFIRMED_BUT_RESIDUAL_TAIL
```

The three stage deltas sum to 20.3 ms, which is exactly Run A minus Run B, so the split is
internally consistent. Run B is 1.3 ms above the 33.3 ms target in this run, which is why
the classification keeps the residual qualifier.

These Run A and Run B figures are from a later run than §10.1's (A p95 65.80, B p95 35.00);
both are kept. The stage shares are taken from this run, where all four runs were measured
together.

### 10.8 What the stage split does not explain

In Run C the measured stage work is:

```text
GPU distance p95   ~0.80 ms
submit CPU   p95    0.20 ms
readback     p95    0.70 ms
                   -------
                    1.70 ms
```

against a B -> C wall p95 cost of +16.4 ms, leaving **14.7 ms unaccounted for by the
per-stage measurements**. The fence elapsed p95 of 112.0 ms does not close that gap either,
because it is wall-clock elapsed across asynchronous polls and not main-thread blocking
time (§10.5).

So the priority target is the **distance / fence / GPU-to-CPU completion path**, not the
CPU depth sort (6.01 %) and not the render-index update (1.09 %). That is Gate 4B-2B-1
(`UIKA_NATIVE_RUNTIME_GATE4B2B1_FENCE_COMPLETION_ISOLATION.md`), and until it has measured
something, no cause is named for the 14.7 ms.

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

Four runs of 36 s, about 2.5 minutes. The page switches to pixelRatio 1.0 itself and
restores everything afterwards. Use `?cd=1` (or nothing — C and D are the default now) for
all four; `?cd=0` runs only A and B.

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

### 12.1 Self-test of the 0.1 fix

`?allowSoftware=1&warmupMs=3000&measureMs=12000` on this container, with C and D now
running by default.

```text
all four runs executed            A, B, C, D
lifecycleInvariantFailures        0 in every run
totalLifecycle >= fenceWait       holds in every run that has samples
  A   total p50 3947.4 ms   fence p50 3911.0 ms
  C   total p50 3692.2 ms   fence p50 3691.8 ms
  D   total p50 136435.8 ms fence p50 136435.6 ms
B   fence 0 samples, total 0 samples, 0 submitted, 0 completed — the truncation holds
frameRecords                      populated in all four runs
GL errors 0, pageErrors 0, pageerror events 0, finishedAt set
```

Before the fix the same shape of run produced a total *below* the fence wait; now the
total brackets it in every case, which is the invariant §3 asks for. The absolute values
are SwiftShader's and are not evidence — Run D's 136 s fence is a fence on a starved
software rasteriser, and it is reported as measured rather than filtered, because
`fenceWaitMs` is wall-clock elapsed across asynchronous polls and a long one is a fact
about this renderer, not an invalid sample.

---

## 13. STOP

The gate ends when the tail stall is classified. Optimisation is decided afterwards, in a
separate gate, from these numbers.
