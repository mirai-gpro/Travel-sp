# UIKA Native Runtime — Gate 4B-2B-2 Sort Submission Phase PoC

Spec: UIKA Native Runtime v1.1 Gate 4B-2B-2.
Route: `/uika-native-predeform-benchmark`, sixth button — **Run Sort Phase PoC**.
Status: PoC delivered and self-tested. The measurement has to be taken on the machine with
the real GPU, so §6 is PENDING until that run comes back.

---

## 0. Where this starts

Gate 4B-2B-1 (`UIKA_NATIVE_RUNTIME_GATE4B2B1_FENCE_COMPLETION_ISOLATION.md` §5):

```text
B  no-sort       34.8 ms        C0 immediate poll   72.0 ms
C1 frame poll    65.6 ms        C2 timer 8 ms       75.6 ms
C3 timer 16 ms   75.0 ms        C0 repeat           75.1 ms

original gap 37.2 ms, best improvement 6.4 ms, residual 30.8 ms, closed share 17.2 %
classification = GPU_COMPLETION_PATH_DOMINANT
```

The finding carried forward is the sentence, not the percentage: **poll callback frequency
alone does not solve the tail.** Dropping the polls per sort from about 11 to about 4 moved
the p95 by 6.4 ms of a 37.2 ms gap, and the two fixed-timer variants were worse than the
current behaviour.

So the target is the distance / fence / GPU-to-CPU completion path. This gate isolates one
property of it: **GPU queue ordering**.

### What this gate changes

The viewer's frame is, today:

```text
update uniforms
if (sortDirty) runSort()      // the distance transform feedback is submitted here
renderer.render()             // ... before this frame's draw
```

so the distance pass is queued ahead of the draw it belongs to. The PoC variant submits the
draw first:

```text
renderer.render()
if (sortDirty) runSort()
```

Both happen inside the **same synchronous `render()` call**. Nothing moves between them:
the expression weights are applied before `render()` is entered, the camera is static, the
MVP is derived inside `runSort()` from that camera, and the pre-deformed centres were
written by the pre-render hook at the top of the same frame.

That is asserted rather than assumed. The viewer computes a key over the state the distance
pass reads — the weight-upload sequence plus the camera world matrix, the projection matrix
and the mesh world matrix — before the draw and again before the post-draw submission, and
counts every frame where they differ as `phaseStateMismatches`. A run with any mismatch is
marked **invalid**.

---

## 1. What is NOT changed (§4)

```text
distance shader          predeform math          fence scheme
getBufferSubData         DepthSorter             sort frequency
sortDirty semantics      Gaussian count          basis count
render-index format      mapper                  A2E / LAM / backend
```

The fence-poll strategy is identical in every run of this gate — the production
`immediate` — so the only variable is the submission phase.

The switch is a diagnostic on the viewer:

```ts
setDiagnosticSortSubmissionPhase('pre-draw' | 'post-draw')   // default 'pre-draw'
```

`pre-draw` is the production order, so with no call the frame is the production sequence.
No production route calls it.

---

## 2. Warm-up spill, fixed (§8)

Gate 4B-2B-1's C1 reported `submitted 317, completed 318`, with a fence max around 6033 ms
and a pending max around 6019 ms: a sort submitted during warm-up completed inside the
measured window, so the window counted a completion it never paid for.

Each run now:

```text
warm up
wait until no sort is in flight          (sortPending == false, 5 s cap)
reset the counters, open the window
measure
close the window, then drain the in-flight sort before reading the counters
assert submitted == completed
```

A run is **invalid** if a sort was still in flight when the window opened, if the
in-flight sort did not drain afterwards, if `submitted != completed`, or if any
`phaseStateMismatches` were counted. `isSortPending()` and `isSortSuspended()` are
diagnostic getters on the viewer; the drain is bounded by `idleTimeoutMs` (default 10 s,
above the ~6033 ms fence max Gate 4B-2B-1 measured) so a stuck fence fails the run rather
than hanging the harness, and `idleWaitMs` / `drainWaitMs` are reported.

The drain **suspends sorting while it waits**, then restores the previous suspension
state. That is not cosmetic: the weights change on nearly every frame, so `render()`
submits a new sort in the same frame the previous one completed, and a once-per-frame poll
of `sortPending` would read `true` for ever. The self-test measured exactly that — 43 s of
waiting against a 40 s cap on a renderer that was completing six sorts per window — so
without the suspension every run, on this machine and on the real GPU alike, would have
been marked invalid. See §10.

---

## 3. The runs (§9)

Every run:

```text
pixelRatio 1.0            133,541 Gaussians        51 basis channels
real A2E fixture          pre-deformed path        CPU DepthSorter OFF
render-index update OFF   immediate fence polling
warm-up >= 6 s            measure >= 30 s
```

```text
B-no-sort-reference    no sort at all
P0-pre-draw            the production order
P0-pre-draw-repeat     P0 again
P1-post-draw           the draw submitted first, then the distance pass
P1-post-draw-repeat    P1 again
```

Five runs, about 3 minutes.

---

## 4. Metrics (§10)

Per run: `effectiveFPS`; exact frame interval p50/p90/p95/p99/max; GPU draw p50/p95; GPU
distance p50/p95; fence elapsed p50/p95; readback p50/p95; total lifecycle p50/p95;
`requested` / `submitted` / `completed` / `pendingSkip`; `lifecycleInvariantFailures`;
`completionPathExercised`; `phaseStateMismatches`; `submittedEqualsCompleted`;
`idleBeforeMeasurement`; GL errors; page errors; `visibilityLostMs`.

---

## 5. Analysis and classification (§11 - §13)

Each phase is measured twice and compared on the **mean** of its two p95s; a single run is
never the baseline. Gate 4B-2B-1 is the reason: there, using C0's first run gave a 17.2 %
share and using the C0 mean gave 20.5 %, on opposite sides of a threshold.

```text
preDrawSpread      = |P0.p95 - P0-repeat.p95|
postDrawSpread     = |P1.p95 - P1-repeat.p95|
phaseImprovementMs = preDrawMeanP95 - postDrawMeanP95
originalGapMs      = preDrawMeanP95 - B.p95
closedShare        = phaseImprovementMs / originalGapMs
```

```text
closedShare >= 0.5, effect > 2x the larger spread   POST_DRAW_PHASE_EFFECTIVE
0.2 < closedShare < 0.5, effect > noise             POST_DRAW_PHASE_PARTIAL
closedShare <= 0.2, effect > noise                  POST_DRAW_PHASE_NOT_PRIMARY
effect < 2x the larger spread                       UNRESOLVED
a run invalid, or any invariant failure             UNRESOLVED
```

The 0.5, 0.2 and 2x figures are decision rules chosen for this gate, not measured
quantities.

---

## 6. Results — PENDING (real GPU)

```text
GPU / browser / drawingBuffer                                      PENDING

B-no-sort-reference      fps, exact p50/p90/p95/p99/max            PENDING
P0-pre-draw              the same + draw, distance, fence, readback, lifecycle   PENDING
P0-pre-draw-repeat       the same                                  PENDING
P1-post-draw             the same                                  PENDING
P1-post-draw-repeat      the same                                  PENDING

preDrawMeanP95 / postDrawMeanP95 / spreads                          PENDING
phaseImprovementMs / originalGapMs / closedShare                    PENDING
phaseStateMismatches (must be 0)                                    PENDING
submittedEqualsCompleted (must hold) / idleBeforeMeasurement        PENDING
lifecycleInvariantFailures (must be 0)                              PENDING
CLASSIFICATION                                                      PENDING
```

Nothing above is estimated or extrapolated.

---

## 7. Visual correctness is NOT judged here (§14)

CPU sort and the render-index update are off in every run, so both phases draw in the same
fixed order and the screen is the same either way. These runs isolate GPU queue submission
phase and say nothing about visual correctness. If the post-draw phase turns out to be
worth keeping, a later gate re-introduces the full sort pipeline in that phase and checks
correctness **and** performance together.

---

## 8. How to run it

```text
1. Open  /uika-native-predeform-benchmark  on the real-GPU machine.
2. Wait for the buttons to enable.
3. Close DevTools. Keep the tab visible and in the foreground; do not switch tabs and do
   not minimise the window for the whole run.
4. Click Run Sort Phase PoC.
5. When it finishes, click Export JSON.
```

Check in this order: `lifecycleInvariantFailures = 0`, `phaseStateMismatches = 0`,
`submittedEqualsCompleted = true` and `idleBeforeMeasurement = true` in every run, then
`analysis.closedShare` against the two spreads.

---

## 9. What the result selects (§15)

```text
POST_DRAW_PHASE_EFFECTIVE   -> a later gate puts the FULL sort pipeline post-draw and
                               verifies correctness and performance together
POST_DRAW_PHASE_PARTIAL     -> keep post-draw as a candidate, then investigate sort cadence
                               and completion-path frequency
POST_DRAW_PHASE_NOT_PRIMARY -> queue phase does not solve it; compare a completion-path
                               frequency reduction against removing the GPU-to-CPU readback
```

---

## 10. Harness self-test (not a Gate 4B-2B-2 result)

Three runs on this container (ANGLE + SwiftShader, about 0.3 fps, so no timing here is
evidence — only the instrument is being checked).

```text
all five runs executed, all valid
phase applied per run        pre-draw, pre-draw, pre-draw, post-draw, post-draw
phase after the run          pre-draw (restored)
phaseStateMismatches         0 in every run, including both post-draw runs
submittedEqualsCompleted     true in every run
idleBeforeMeasurement        true in every run      idle wait ~7.5 s on this renderer
drainedAfterMeasurement      true in every run      drain wait 3.8 - 8.2 s
lifecycleInvariantFailures   0        GL errors 0        pageerror events 0
classification               UNRESOLVED via the noise rule (spread 3661 ms on this renderer)
```

`phaseStateMismatches = 0` in the post-draw runs is the §7 assertion holding: the weights,
the camera, the MVP and the pre-deformed centres were identical for the draw and for the
distance pass submitted after it.

**Two flaws found and fixed by the self-test, both of which would have cost a real-GPU run.**

1. The idle cap was a hard-coded 5 s. Gate 4B-2B-1 measured a fence max of about 6033 ms on
   the real GPU, so a legitimate run could have exceeded it. It is now
   `idleTimeoutMs`, default 10 s, `?idleTimeoutMs=` to override, with `idleWaitMs` and
   `drainWaitMs` recorded per run.

2. **The idle wait could never succeed at all.** The weights change on nearly every frame,
   so `render()` submits a new sort in the same frame the previous one completed; a
   once-per-frame poll of `sortPending` samples at exactly the wrong moment and reads
   `true` for ever. Measured in the self-test: 43 s of waiting against a 40 s cap, on a
   renderer that was completing six sorts per window. Every run would have come back
   `idleBeforeMeasurement: false` and therefore invalid — on the real GPU too, where a
   ~100 ms fence still spans several frames at 48 fps.

   Fixed by suspending sorting for the duration of the drain and restoring the previous
   suspension state afterwards, so the in-flight sort can finish with no new one starting.
   After the fix every run reports `idle true` and `drained true`, as above.

The UNRESOLVED path is exercised: on this renderer the two pre-draw runs differ by 3661 ms,
the phase effect is 1970 ms, and the gate says the effect is not separable from the
run-to-run variation rather than classifying it.

---

## 11. STOP

The gate ends at the PRE/POST comparison and its classification. No GPU sort, no sort
cadence change, no Worker, no WASM, no production integration, no Gate 5.
