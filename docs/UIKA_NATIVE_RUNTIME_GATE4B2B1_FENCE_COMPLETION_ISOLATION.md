# UIKA Native Runtime — Gate 4B-2B-1 Fence / GPU→CPU Completion Path Isolation

Spec: UIKA Native Runtime v1.1 Gate 4B-2B-1.
Route: `/uika-native-predeform-benchmark`, fifth button — **Run Fence Poll Isolation**.
Status: variants delivered and self-tested. The measurement has to be taken on the machine
with the real GPU, so §5 is PENDING until that run comes back.

---

## 0. Where this starts

Gate 4B-2B-0 (`UIKA_NATIVE_RUNTIME_GATE4B2B0_DPR1_TAIL_ISOLATION.md` §10.7), real GPU, all
four runs with `lifecycleInvariantFailures = 0`:

```text
Run B  no sort                        exact p95 34.6 ms    FPS 52.90
Run C  distance + fence + readback    exact p95 51.0 ms    FPS 48.60
Run D  C + CPU DepthSorter            exact p95 54.3 ms    FPS 47.62
Run A  full pipeline                  exact p95 54.9 ms    FPS 47.92

B -> C  +16.4 ms   29.87 % of Run A's p95
C -> D   +3.3 ms    6.01 %
D -> A   +0.6 ms    1.09 %
whole sort pipeline 36.98 %

SORT_PIPELINE_TAIL_CONFIRMED = true
classification = SORT_PIPELINE_TAIL_CONFIRMED_BUT_RESIDUAL_TAIL
```

The priority target is therefore the **distance / fence / GPU-to-CPU completion path**, not
the CPU depth sort and not the render-index update.

### What is not explained yet

```text
Run C measured stage work
  GPU distance p95   ~0.80 ms
  submit CPU   p95    0.20 ms
  readback     p95    0.70 ms
                     -------
                      1.70 ms

B -> C wall p95 cost  +16.4 ms
unaccounted for        14.7 ms
```

The fence elapsed p95 of 112.0 ms does not close that gap: it is wall-clock elapsed across
asynchronous `setTimeout` polls, not main-thread blocking time. So the +16.4 ms is
currently **not explained by the individual measurements**, and this gate measures one
thing about it — what the poll scheduling does to the wall tail.

### Hypotheses, recorded as hypotheses (§4)

```text
H1  setTimeout / clientWaitSync polling callback overhead
H2  transform feedback + fence GPU or driver scheduling interaction
H3  getBufferSubData completion timing disturbing frame scheduling
H4  a combination of the above
```

None of these is written as a finding before it is measured. The report carries the list
under `hypothesesNotTested`.

---

## 1. What is held constant

Every run uses the Run C conditions:

```text
pixelRatio 1.0            759 x 759 drawing buffer
133,541 Gaussians         51 basis channels
real A2E fixture          pre-deformed path
CPU sort OFF              render-index update OFF
```

and the distance shader, the fence and `getBufferSubData` are **identical** in every run.
Only the scheduling of `clientWaitSync` differs. A no-sort run is kept alongside as the
reference the gap is measured against.

---

## 2. The variants (§5)

```text
B-no-sort-reference        no sort at all
C0-immediate-poll          setTimeout(checkSync) with no delay — the current behaviour
C1-frame-poll              at most one clientWaitSync per rendered frame, driven from the
                           viewer's own frame tick
C2-timer-8ms               setTimeout(checkSync, 8)
C3-timer-16ms              setTimeout(checkSync, 16)
C0-immediate-poll-repeat   C0 again, to size the run-to-run spread of the p95 the
                           classification rests on
```

Six runs, 6 s warm-up and 30 s measured each — about 3.6 minutes. `?repeatC0=0` drops the
repeat, `?measureMs=` and `?warmupMs=` shorten the windows.

The poll strategy lives in the pre-deformation pass as
`setFencePollStrategy('immediate' | 'frame' | 'timer8' | 'timer16')`, with `'immediate'`
the production behaviour and `pollFenceOnFrame()` the one-poll-per-frame entry point.
Diagnostic only.

---

## 3. What each run records (§6)

```text
effectiveFPS
exact frame interval        p50 / p90 / p95 / p99 / max
GPU distance                p50 / p95          (the transform-feedback pass)
fence elapsed               p50 / p95 / p99
poll count per submitted sort  p50 / p95
readback                    p50 / p95
totalLifecycle              p50 / p95
requested / submitted / completed / pendingSkip
lifecycleInvariantFailures
GL errors / page errors / visibilityLostMs
```

`totalLifecycle` is measured from the submitted sort, with the invariant
`totalLifecycle + 0.5 ms >= fenceWait` checked per completed sort — the fix from Gate
4B-2B-0.1. A non-zero failure count makes the run UNRESOLVED rather than classified.

---

## 4. Classification (§8)

```text
originalGap   = C0 - no-sort            what the completion path costs today
closed        = C0 - best poll run      what the scheduling accounts for
residual      = best poll run - no-sort what survives the scheduling change
closedShare   = closed / originalGap
```

```text
closedShare >= 0.7                           POLLING_OVERHEAD_CONFIRMED
closedShare <= 0.2                           GPU_COMPLETION_PATH_DOMINANT
in between                                   MIXED_COMPLETION_PATH
effect < 2x the measured C0 spread,          UNRESOLVED
an invalid run, any invariant failure, or
a run that never exercised the completion path
```

A variant only contributes a p95 when it actually submitted **and** completed a sort in the
measured window (`completionPathExercised`). A window in which a warm-up sort was still
pending throughout submits nothing, so its p95 is a no-sort measurement wearing the
variant's name; such a run is named with its counters and forces UNRESOLVED instead. The
self-test found exactly that case and §8 records it.

The 0.7, 0.2 and 2x figures are decision rules chosen for this gate, not measured
quantities. The repeat of C0 is what makes the UNRESOLVED rule a measurement rather than a
guess: if changing the poll scheduling moves the p95 by less than twice the amount two
identical runs already differ by, the effect is not separable from the spread and the gate
says so.

### A note on what is deliberately not optimised for (§9)

A longer poll interval is expected to raise the fence elapsed time, the pending-skip count
and the sort completion latency. None of that is the metric under test. The question is
only what happens to the main rendering wall tail; a fence signalling sooner is not a goal.

---

## 5. Results — PENDING (real GPU)

```text
GPU / browser / drawingBuffer                                      PENDING

B-no-sort-reference        fps, exact p50/p90/p95/p99/max           PENDING
C0-immediate-poll          the same + fence, polls, readback, total PENDING
C1-frame-poll              the same                                 PENDING
C2-timer-8ms               the same                                 PENDING
C3-timer-16ms              the same                                 PENDING
C0-immediate-poll-repeat   the same                                 PENDING

originalGap / closed / residual / closedShare                       PENDING
C0 run-to-run spread                                                PENDING
lifecycleInvariantFailures (must be 0)                              PENDING
CLASSIFICATION                                                      PENDING
```

Nothing above is estimated or extrapolated.

---

## 6. How to run it

```text
1. Open  /uika-native-predeform-benchmark  on the real-GPU machine.
2. Wait for the buttons to enable.
3. Close DevTools. Keep the tab visible and in the foreground; do not switch tabs and do
   not minimise the window for the whole run.
4. Click Run Fence Poll Isolation.
5. When it finishes, click Export JSON.
```

Check `lifecycleInvariantFailures` first: it must be 0 in every run, or the lifecycle
numbers are not trustworthy.

---

## 7. What this gate does not do (§10, §11)

No optimisation. Unchanged: the production sort algorithm, `DepthSorter`, the sort
frequency, the render-index format, `SplatMesh`, `SplatMaterial`, the mapper, LAM, A2E and
the backend. The poll strategy is a diagnostic knob on the PoC pass, defaulting to the
production behaviour, and nothing reads it outside this gate.

The result selects the next step, which is decided in a later gate:

```text
POLLING_OVERHEAD_CONFIRMED      -> a minimal PoC that changes the completion polling design
GPU_COMPLETION_PATH_DOMINANT    -> consider a path with no GPU-to-CPU sync or readback
MIXED_COMPLETION_PATH           -> fix the polling, then re-measure the residual
```

---

## 8. Harness self-test (not a Gate 4B-2B-1 result)

Two runs on this container (ANGLE + SwiftShader at roughly 0.27 fps, so none of the
timings are evidence — only the instrument is being checked):
`?allowSoftware=1&warmupMs=3000&measureMs=11000` and the same with
`measureMs=9000&repeatC0=0`.

```text
all six variants executed       B, C0, C1, C2, C3, C0-repeat
fencePollStrategy recorded      immediate / immediate / frame / timer8 / timer16 / immediate
sortStage                       full (B, suspended) and distance (every C variant)
cpuSort samples                 0 in every run        index update samples 0 in every run
lifecycleInvariantFailures      0 in every run
GL errors 0, pageErrors 0, pageerror events 0, finishedAt set
```

The frame-poll path works end to end: `C1-frame-poll` submitted and completed a sort with
`polls per sort p50 = 2` and a fence elapsed p95 of 7312 ms — on this renderer each poll
waits a whole ~3.4 s frame, which is exactly the trade §9 says is acceptable and is
visible in the numbers rather than hidden.

**One robustness hole found and fixed by the self-test.** In the first run `C0` reported an
exact p95 of 13.3 ms with **0 sorts submitted** and 3 pending skips: a sort submitted
during warm-up never completed on this renderer, so `sortPending` stayed true for the whole
measured window and nothing was submitted. That p95 is a no-sort measurement wearing C0's
name — and the classifier was about to use it as the baseline the whole comparison rests
on, which would have produced a confident, wrong answer.

Fixed: every run now carries `completionPathExercised` (submitted > 0 and completed > 0;
null for the no-sort reference). A variant that did not exercise the completion path
contributes no p95, is named in `classificationBasis` with its counters, and forces
`UNRESOLVED`. The re-run confirms it:

```text
B-no-sort-reference   sub 0  done 0  exercised null   (nothing to exercise)
C0-immediate-poll     sub 1  done 1  exercised true
C1-frame-poll         sub 1  done 1  exercised true
C2-timer-8ms          sub 0  done 0  exercised false  -> excluded, reason recorded
C3-timer-16ms         sub 0  done 0  exercised false  -> excluded, reason recorded
classification        UNRESOLVED
```

On the real GPU at ~48 fps with a ~100 ms fence, every variant submits and completes sorts,
so this guard should stay inert there — its job is to make sure a window that measured
nothing can never be published as a measurement.

Both UNRESOLVED paths were exercised: the spread rule (the first run's poll effect was
smaller than twice the measured C0-to-C0-repeat spread) and the exclusion rule above.

---

## 9. STOP

The gate ends at the C0 / C1 / C2 / C3 comparison and its classification. Production
integration and Gate 5 Live are not started.
