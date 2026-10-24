# UIKA Native Runtime — Gate 4B-2B-3 Completion Frequency vs GPU→CPU Sync / Readback

Spec: UIKA Native Runtime v1.1 Gate 4B-2B-3.
Route: `/uika-native-predeform-benchmark`, seventh button —
**Run Completion Lever Isolation**.
Status: variants delivered and self-tested. The measurement has to be taken on the machine
with the real GPU, so §12 is PENDING until that run comes back.

---

## 0. Where this starts

Gate 4B-2B-2 is closed (`UIKA_NATIVE_RUNTIME_GATE4B2B2_SORT_SUBMISSION_PHASE.md` §6):

```text
POST_DRAW_PHASE_NOT_PRIMARY
pre-draw mean p95   84.10 ms     spread 1.00 ms
post-draw mean p95  96.65 ms     spread 0.10 ms
phaseRegression    +12.55 ms     about 12.6x the larger repeat spread
```

Post-draw is not a candidate and the queue-submission-phase line of enquiry is finished.
What remains from that gate's §15 is a straight comparison of the two levers left:

```text
A  completion-path frequency reduction
B  GPU -> CPU synchronization / readback elimination
```

measured in **one session**, against the same reference.

---

## 1. What this gate separates

The current pre-draw completion path is:

```text
GPU distance transform feedback
  -> fenceSync
  -> clientWaitSync polling
  -> getBufferSubData
  -> CPU-side continuation
```

Two questions, kept apart:

```text
does doing it LESS OFTEN reduce the tail?
does removing the GPU -> CPU completion boundary, at the same frequency and with the
same GPU distance work, reduce the tail?
```

This is not a production optimisation.

---

## 2. Held constant (§2)

```text
pixelRatio 1.0        drawingBuffer 759 x 759     Gaussians 133,541
basis 51              real A2E fixture            pre-deformation ON
submission phase PRE-DRAW                         CPU DepthSorter OFF
render-index update OFF
poll strategy: immediate wherever a fence exists
```

POST-DRAW is not used anywhere in this gate.

---

## 3. Why 4 Hz (§3)

Gate 4B-2B-2's PRE-DRAW runs submitted 234 and 237 distance passes in 30 s:

```text
234 / 30.069 s = 7.78 Hz        237 / 30.012 s = 7.90 Hz        mean 7.84 Hz
```

A 250 ms minimum interval is 4 Hz, which is 51 % of the current effective rate — a large
enough first step to separate from noise, without going to 2 Hz before 4 Hz has been
measured.

---

## 4. The cadence gate (§4)

```ts
setDiagnosticSortMinIntervalMs(null | number)   // null = production, the default
```

A frame that arrives before the interval has elapsed does **not** submit, and **does not
clear `sortDirty`** — the request is kept, and the next eligible frame submits the newest
state rather than a stale one. The skipped and eligible counts are recorded separately
(`cadenceSkipped`, `cadenceEligible`), so the gate's behaviour is visible in the JSON
rather than inferred from the submission count.

---

## 5. The two completion modes (§5)

```ts
setDiagnosticCompletionMode('cpu-readback' | 'gpu-only')   // cpu-readback is the default
```

```text
cpu-readback   distance transform feedback, fenceSync, clientWaitSync, getBufferSubData
               — identical to the current PoC

gpu-only       the same distance shader, the same transform-feedback draw, the same MVP,
               the same pre-deformed centre texture, the same output buffer format
               and NOT: fenceSync, clientWaitSync polling, getBufferSubData, or the CPU
               distance array update
```

No second distance shader exists. Everything up to and including the transform-feedback
draw and the texture-unit restore is one code path; the two modes diverge only after the
submission (§7).

---

## 6. The GPU-only premise, checked before implementing (§6)

Audited in `predeform/uika-predeform-pass.ts` rather than assumed. The transform-feedback
output buffer is created once with `STATIC_READ` and is referenced in exactly three places:

```text
bufferData            the one-time allocation
bindBufferBase        making it the transform-feedback target for the draw
getBufferSubData      inside the fence continuation — the only CPU read
```

Nothing else reads it: no vertex attribute, no uniform block, no `copyBufferSubData`. And
WebGL2 has no buffer mapping, so there is no persistent mapping to invalidate. Successive
writes are issued on one context's command stream and are therefore ordered against each
other by GL itself; the fence exists only to tell the CPU when it may read.

With no CPU read, there is nothing for the fence to guard. The CPU distance array is
deliberately left stale in `gpu-only`, which is only valid with the `distance` sort stage
where neither the CPU depth sort nor the render-index update consumes it — **the harness
throws rather than measuring any other combination**. The reasoning is also carried in the
report as `gpuOnlySafetyNote`, so the JSON states its own premise.

---

## 7. Counters are not faked (§8)

`completed` used to mean "the GPU result reached the CPU and the provider promise
resolved". In `gpu-only` that event does not exist, so it is not reported as if it did:

```text
distanceSubmitted              GPU distance submissions, both modes
gpuOnlyDistanceSubmittedCount  submissions with no completion boundary
cpuCompletionCount             provider promises resolved after a readback
cpuReadbackCount               getBufferSubData calls
fencePollCount                 clientWaitSync calls
completionMode                 always reported
```

`submitted == completed` is asserted only for `cpu-readback` runs. For `gpu-only` the
assertions are the opposite way round (§9).

---

## 8. The runs (§9, §10)

```text
B0-no-sort-start              no distance submission, measured first
C0-current                    uncapped cadence, cpu-readback, pre-draw
C0R-current-repeat
F4-4hz-cpu-readback           250 ms minimum interval, cpu-readback
F4R-4hz-cpu-readback-repeat
G4-4hz-gpu-only               250 ms minimum interval, gpu-only
G4R-4hz-gpu-only-repeat
B1-no-sort-end                no distance submission, measured last
```

Eight runs, 6 s warm-up and 30 s measured each — about 5 minutes. The no-sort reference is
measured at **both ends**, because across earlier sessions it has come back at 34.6, 34.8
and 43.4 ms; a single B is not the baseline.

```text
BMeanP95 = (B0.p95 + B1.p95) / 2        BSpread = |B0.p95 - B1.p95|
```

---

## 9. Guards (§13)

Every run:

```text
GL errors = 0      page errors = 0      visibilityLostMs = 0      phaseStateMismatches = 0
```

`cpu-readback` runs additionally:

```text
lifecycleInvariantFailures = 0     idleBeforeMeasurement = true
drainedAfterMeasurement = true     submittedEqualsCompleted = true
```

`gpu-only` runs:

```text
gpuOnlyDistanceSubmittedCount > 0      cpuReadbackCount = 0      fencePollCount = 0
```

A failure makes the run invalid and the selection `UNRESOLVED`.

---

## 10. The 4 Hz condition (§11)

```text
actualDistanceSubmissionHz          per run
3.8 <= F4 mean Hz <= 4.2            and the same for G4
|F4 mean Hz - G4 mean Hz| <= 0.2
```

If that does not hold, the readback comparison is not valid and the gate says so instead
of comparing two different workloads.

---

## 11. Analysis and classification (§14 - §20)

```text
CurrentMean = mean(C0, C0R)      CurrentSpread = |C0 - C0R|
F4Mean      = mean(F4, F4R)      F4Spread      = |F4 - F4R|
G4Mean      = mean(G4, G4R)      G4Spread      = |G4 - G4R|
BMean       = mean(B0, B1)       BSpread       = |B0 - B1|
```

```text
frequencyImprovementMs    = CurrentMean - F4Mean
  significant when |effect| >= 2 x max(CurrentSpread, F4Spread)

syncReadbackImprovementMs = F4Mean - G4Mean
  significant when |effect| >= 2 x max(F4Spread, G4Spread)

gpuDistanceResidualMs     = G4Mean - BMean        reported with BSpread beside it
```

Reference shares only, never the basis of a verdict (§18): `frequencyClosedShare`,
`syncReadbackClosedShare`, `gpuDistanceResidualShare`, each over
`CurrentGap = CurrentMean - BMean`. B moves within a session, so a share alone decides
nothing; the primary judgement is the absolute effect against that lever's own repeat
noise.

Per-lever verdicts:

```text
|effect| < noise floor      NULL
effect  > 0, above noise    EFFECTIVE
effect  < 0, above noise    REGRESSION
a lever could not be evaluated   UNDETERMINED
```

Overall selection:

```text
both EFFECTIVE, frequency >= 2 x sync        FREQUENCY_PRIMARY
both EFFECTIVE, sync >= 2 x frequency        GPU_CPU_SYNC_READBACK_PRIMARY
both EFFECTIVE, neither dominates            MIXED_LEVERS
only frequency EFFECTIVE                     FREQUENCY_PRIMARY
only sync/readback EFFECTIVE                 GPU_CPU_SYNC_READBACK_PRIMARY
neither above noise                          NEITHER_LEVER_ESTABLISHED
an invalid run, a failed guard, or the
4 Hz condition unmet                         UNRESOLVED
```

The 2x factors, the 3.8-4.2 Hz band and the 0.2 Hz match are decision rules chosen for
this gate, not measured quantities.

---

## 12. Results — PENDING (real GPU)

```text
GPU / browser / drawingBuffer                                      PENDING

B0 / C0 / C0R / F4 / F4R / G4 / G4R / B1
  fps, exact p50/p90/p95/p99/max                                   PENDING
  GPU draw p50-p95, GPU distance p50-p95                           PENDING
  fence p50-p95, readback p50-p95                                  PENDING
  requested / cadenceEligible / cadenceSkipped / distanceSubmitted  PENDING
  cpuCompletionCount / pendingSkip / actualDistanceSubmissionHz     PENDING
  predeformPassCount / weightUploadCount                            PENDING
  guards                                                            PENDING

frequency effect vs its noise floor                                 PENDING
sync/readback effect vs its noise floor                             PENDING
GPU distance residual, with BSpread                                 PENDING
cadence validity                                                    PENDING
FREQUENCY verdict / SYNC_READBACK verdict / SELECTION               PENDING
```

Nothing above is estimated or extrapolated.

---

## 13. Interpretation boundary (§21, §22)

A GPU-only improvement would **not** by itself mean "implement a GPU sort". What this gate
can establish is only which of

```text
the GPU distance work itself
the boundary that returns the GPU result to the CPU
```

contributes to the wall tail.

CPU sort and the render-index update are off in every run, so the draw order is fixed and
nothing here judges visual correctness. No claim is made that a 4 Hz cadence is visually
acceptable.

---

## 14. How to run it

```text
1. Open  /uika-native-predeform-benchmark  on the real-GPU machine.
2. Wait for the buttons to enable.
3. Close DevTools. Keep the tab visible and in the foreground; do not switch tabs and do
   not minimise the window for the whole run.
4. Click Run Completion Lever Isolation.
5. When it finishes, click Export JSON.
```

Check in this order: every run's guards, then `analysis.cadenceValid` with the two mean Hz
figures, then each lever's effect against its own noise floor, then the selection.

---

## 15. Harness self-test (not a Gate 4B-2B-3 result)

`?allowSoftware=1&warmupMs=3000&measureMs=9000&idleTimeoutMs=25000` on this container
(ANGLE + SwiftShader at about 0.3 fps, so no timing here is evidence — only the instrument
is being checked).

```text
all eight runs executed, all valid, pageerror events 0
cadence before the run   null        cadence after the run   null (restored)
```

**The counters are separated, not faked (§7).**

```text
run                           mode           cadence  sub  gpuOnly  cpuDone  readbacks  polls
C0-current                    cpu-readback   none      1        0        1          1      2
F4-4hz-cpu-readback           cpu-readback   250 ms    1        0        1          1      2
G4-4hz-gpu-only               gpu-only       250 ms    2        2        0          0      0
G4R-4hz-gpu-only-repeat       gpu-only       250 ms    2        2        0          0      0
B0 / B1 no-sort               cpu-readback   none      0        0        0          0      0
```

The §9 `gpu-only` assertions are exactly what the runs report: GPU submissions non-zero,
CPU readbacks zero, fence polls zero. No `submitted == completed` is claimed for them.

**The cadence gate works and keeps the request.** `G4R` shows `cadenceSkipped = 1` against
`cadenceEligible = 2`: a request arrived inside the 250 ms window, was held back, and
`sortDirty` stayed set so the next eligible frame submitted.

**The §10 validity guard rejected the comparison, correctly.** This renderer runs at about
0.3 fps — 3.4 s per frame — so a 250 ms cadence can never be reached; the submission rate
is frame-limited, not cadence-limited:

```text
F4 mean submission rate   0.09 Hz      outside 3.8 - 4.2 Hz
G4 mean submission rate   0.18 Hz      outside 3.8 - 4.2 Hz
cadenceValid              false
selection                 UNRESOLVED, with both rates named in cadenceNotes
```

That is the guard doing its job: rather than comparing a 0.09 Hz run against a 0.18 Hz run
and reporting a readback effect, the gate refuses. On the real GPU at ~45 fps a 250 ms
interval is 4.0 Hz and the band is comfortably reachable.

**The no-sort reference justified measuring it at both ends.** B0 came in at 7608.6 ms and
B1 at 3674.4 ms — a 3934 ms spread within one session on this renderer. A single B would
have been a meaningless baseline here, which is the §8 point in miniature.

Both per-lever verdicts came back `NULL` through the noise rule (the repeat spreads on this
renderer are in the seconds), and the overall selection is `UNRESOLVED` because of the
cadence condition. All four UNRESOLVED paths — invalid run, failed guard, cadence invalid,
lever undetermined — are present in the classifier and the cadence one is exercised here.

---

## 16. STOP

The gate ends at the frequency effect, the sync/readback effect, the GPU-distance residual
and the overall selection. Not started: a production cadence change, a GPU sort, Worker or
WASM, production integration of readback elimination, Gaussian or basis reduction, LOD,
Gate 5 Live.
