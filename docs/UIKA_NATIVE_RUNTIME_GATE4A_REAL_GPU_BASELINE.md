# UIKA Native Runtime — Gate 4A Real GPU Baseline

**Date:** 2026-10-14
**Spec:** `docs/UIKA_NATIVE_RUNTIME_ARCHITECTURE_CORRECTION_v1.1.md` + Gate 4A instruction
**Branch:** `poc/uika-native-runtime-v1`
**Start HEAD:** `b92f64893eb95fc36dab1d3c44b6d1a7a44607a9`
**Page:** `/uika-native-benchmark`

```text
GATE4A_HARNESS            = READY (self-tested end to end)
GATE4A_SOFTWARE_REJECTION = VERIFIED
GATE4A_REAL_GPU           = BLOCKED on this machine — awaiting a run on real hardware
```

MEASURE FIRST, OPTIMIZE LATER. Nothing in this change optimises anything: no shader loop
change, no basis compression or reduction, no Gaussian reduction, no sort-frequency
change, no texture-layout change, no half-float, no LOD, no frame skipping, no automatic
resolution drop, no expression-channel reduction. The renderer is measured exactly as
Gate 3 left it.

---

## 1. Why this machine cannot produce the result

The Claude Code cloud container renders through

```text
ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)
```

which is a software rasteriser. Per Gate 4A §2 and §7 that is not a Gate 4 judgement
environment. The harness detects it and refuses to judge:

```json
{ "verdict": "BLOCKED",
  "verdictReasons": ["software renderer detected (swiftshader): ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)"],
  "realGpu": false,
  "tests": [] }
```

No test runs, and no PASS/BORDERLINE/FAIL is produced. Markers checked:
`swiftshader`, `llvmpipe`, `software`, `microsoft basic render driver`, `softpipe`,
`mesa offscreen`. A missing `WEBGL_debug_renderer_info` also yields BLOCKED, because
hardware acceleration then cannot be confirmed.

---

## 2. How to run it

1. Open the Preview deployment of this branch on the Windows PC, in Chrome, on the
   machine's real GPU.
2. Go to **`/uika-native-benchmark`**.
3. Wait for the avatar to appear and for **Start Benchmark** to become enabled (the page
   loads the Gate 3 fixture and runs all three validators first).
4. Press **Start Benchmark**. Keep the tab visible and in the foreground. The run takes
   about 3.5 minutes: three tests, each 6 s warm-up then 60 s measured.
5. Press **Export JSON** (or **Copy Results**) and send the file back.

DevTools does not need to be open: the live panel shows tab visibility, hardware-GPU
status, GPU name, phase, elapsed, rendered frames, effective FPS, p95 interval, GL errors,
splat count, basis state and the verdict.

If the tab is hidden at any point during a measurement, that test is marked
`valid: false` with the hidden duration, and the overall verdict becomes `INCOMPLETE`
rather than a performance judgement.

### Diagnostic query parameters

| parameter | effect |
| --- | --- |
| `?warmupMs=` | override the 6000 ms warm-up |
| `?measureMs=` | override the 60000 ms measurement |
| `?allowSoftware=1` | run the tests on a software renderer **for self-testing the harness only**; the verdict is then forced to `BLOCKED` and can never be PASS, BORDERLINE or FAIL |

The §24 resolution diagnostic (100 % / 50 % / 25 %) is deliberately **not** implemented as
an automatic behaviour. If Test C comes back FAIL or BORDERLINE, it is run manually
afterwards; no automatic resolution drop exists in the renderer.

---

## 3. What the harness measures

**Tests** (Gate 4A §10), each 6 s warm-up then 60 s measured:

| test | what it holds | purpose |
| --- | --- | --- |
| A — neutral | all 51 weights zero; the shader still evaluates every basis channel | renderer floor |
| B — fixed pose | fixture frame 20, the widest jaw/stretch pose of the take | cost with the basis actually deforming |
| C — real A2E replay | the 192-frame 30 fps capture, time-based replay | closest to production |

**Frame interval** (§13): count, mean, p50, p90, p95, p99, max, and counts over 16.7 /
33.3 / 50 / 100 ms, plus `effectiveFPS = renderedFrames / elapsedSeconds`.

**Expression** (§14, Test C, Gate 3 definitions): requestedFrame, selectedFrame, loops,
mappedFrameCount, weightUploadCount, skippedExpressionFrames, duplicateFrameRenders,
maxFrameJump, maxHoldMs, clampViolations, rangeViolations.

**CPU** (§15), p50 / p95 / max each: A2E frame selection, `UikaExpressionMapper`,
`setUikaWeights` upload, sort preparation + submission, render submission. These are
`performance.now()` around the submitting JS; they are reported separately from GPU time
and are not conflated with it.

**GPU** (§16, §17): `EXT_disjoint_timer_query_webgl2` `TIME_ELAPSED` queries around the
distance/sort submission and around the draw, polled at least four frames later so the
benchmark never stalls on the GPU, with any `GPU_DISJOINT_EXT` sample discarded and
counted. Whether a sample counts is decided when the query is *submitted*, so warm-up
queries cannot leak into the measured window. Without the extension the report records
`"GPU_TIMER_QUERY = UNAVAILABLE"` and that alone is not a FAIL reason.

**Environment** (§6, §19, §20): unmasked vendor and renderer, `MAX_TEXTURE_SIZE`,
`MAX_VERTEX_TEXTURE_IMAGE_UNITS`, `MAX_COMBINED_TEXTURE_IMAGE_UNITS`,
`MAX_TEXTURE_IMAGE_UNITS`, timer-query availability, user agent, platform, visibility
state, devicePixelRatio, canvas CSS size and drawingBuffer size. The canvas is left at its
normal size; nothing is shrunk.

**Lifecycle**: `sortRuns` per test, GL errors per test, page errors per test. Note that
Tests A and B hold their weights constant, so the depth sort is not re-submitted during
them (`sortRuns` 0) — that is the renderer's existing policy, not a benchmark shortcut,
and it is reported rather than hidden.

---

## 4. Verdict rules as implemented (§21, §22)

Hard requirements, any failure ⇒ FAIL: hardware GPU, 133,541 splats, 51 basis resident,
clamp violations 0, range violations 0, GL errors 0, page errors 0, OAC dependency 0.

Then, from Test C:

```text
effectiveFPS >= 30  and  p95 <= 33.3 ms  and  p99 <= 50 ms   -> PASS
effectiveFPS >= 30  but  p95 > 33.3 ms   or   p99 > 50 ms    -> BORDERLINE
effectiveFPS <  30                                            -> FAIL
any test invalid (tab hidden during measurement)              -> INCOMPLETE
software renderer / unconfirmable GPU                         -> BLOCKED
```

---

## 5. Harness self-test (not a Gate 4A result)

Run on this container's SwiftShader with `?allowSoftware=1&warmupMs=6000&measureMs=20000`,
purely to prove the driver works before it is handed over:

```text
verdict BLOCKED
reasons software renderer detected (swiftshader): ANGLE (… SwiftShader driver)
        tests were executed with allowSoftware=1 to self-test the harness;
        these numbers are NOT a Gate 4A result

A-neutral          frames 7  sortRuns 0  gpuSortSamples 0  gpuDrawSamples 4  gl 0  page 0
B-fixed-pose       frames 6  sortRuns 0  gpuSortSamples 0  gpuDrawSamples 3  gl 0  page 0
C-real-a2e-replay  frames 6  sortRuns 3  gpuSortSamples 2  gpuDrawSamples 3  gl 0  page 0
                   clampViolations 0  rangeViolations 0
```

All three tests execute, every metric populates, the GPU timer path works, and the verdict
is forced to BLOCKED. The sample counts line up with the sort policy (A and B never
re-sort, C does), which is also what confirmed the warm-up-leak fix: before it, Tests A
and B reported GPU sort samples despite `sortRuns 0`.

Gate 3 remains intact on `/uika-native-replay`: fixture SHA
`54f581ac…e24b`, all three validators pass, 133,541 splats, GL errors 0, page errors 0,
and the new CPU split reports selection ~0.0 ms, mapper ~0.1 ms, upload p50 0.2 ms.

---

## 6. Results

### 6.1 Run 1 — real GPU, 2026-10-14 (INCOMPLETE)

The user ran `/uika-native-benchmark` on the real Windows PC in Chrome and reported the
result JSON. Official verdict for that run, as set by the user:

```text
GATE4A (Run 1) = INCOMPLETE
reason          Test A  visibilityLostMs = 17624.9 , valid = false
```

Test A is therefore not usable as a measurement. Tests B and C were `valid`, and the
figures below are the ones the user quoted from the exported JSON. Nothing here is
estimated, interpolated or extrapolated; fields the user did not quote are recorded as
not reported rather than filled in.

```text
Test B (expression hold, no sort)
  effectiveFPS        13.60
  sortRuns            0
  GPU draw p50        72.90 ms
  GPU draw p95        73.74 ms

Test C (replay + sort)
  effectiveFPS        13.01
  GPU draw p50        73.93 ms
  GPU draw p95        78.43 ms
  GPU sort p50         6.81 ms
  GPU sort p95         7.51 ms

CPU stages (Tests B/C)   0.1 – 0.2 ms per stage

OS / browser                       not reported in this record
GPU vendor / renderer              not reported in this record
software renderer ruled out        not reported in this record
canvas CSS / drawingBuffer / DPR   not reported in this record
WebGL limits                       not reported in this record
wall-clock p99                     not reported in this record
Test C expression diagnostics      not reported in this record
GL / page errors                   not reported in this record
OAC-free                           not reported in this record
```

Recorded as instructed, as a candidate only and not as a Gate 4A verdict:

```text
primary bottleneck candidate = GPU draw / 133541 x 51 basis evaluation
```

Basis for calling it a candidate, from the two valid tests only: Test B has
`sortRuns = 0` and still shows GPU draw p50 72.90 ms, and the CPU stages are 0.1–0.2 ms,
so neither sorting nor CPU work accounts for the frame time in that run. GPU sort adds
~6.8 ms p50 in Test C. No cause beyond that is asserted here.

### 6.2 Run 2 — clean real-GPU rerun (PENDING)

Run 1 cannot carry a formal Gate 4A PASS/FAIL because Test A is invalid. A clean rerun of
the same page, with no code change and no optimization, is required first.

Conditions for Run 2, as instructed:

```text
same route            /uika-native-benchmark , harness unchanged
DevTools              closed
tab                   never hidden, never switched away from, window never minimised
required outcome      Test A, B and C all valid: true , visibilityLostMs = 0
then                  Export JSON
```

Also to be recorded from Run 2, without changing the harness for it: whether the
anomalous GPU timer sample `184467.440737 ms` — one occurrence in Test A and one in
Test B of Run 1 — appears again.

Judgement for Run 2 uses `effectiveFPS`, wall-clock frame interval p95/p99 and GPU timer
p50/p95/p99 — not mean and not max — then the rules already implemented in §4.

```text
Test C   effectiveFPS >= 30 and p95 <= 33.3 ms and p99 <= 50 ms   PASS
Test C   effectiveFPS < 30                                        FAIL
Test C   fps >= 30 but p95/p99 over                               BORDERLINE

GATE4A (Run 2) = PENDING
```

No Gate 4B optimization and no Live work until Run 2 is judged.

---

## 7. Changes in the harness commit (`10e5636`)

```text
new   src/pages/uika-native-benchmark.astro              Gate 4A route and controls
new   src/scripts/chat/uika-native/uika-native-benchmark.ts   harness, metrics, verdict
edit  src/scripts/chat/uika-native/renderer/uika-gaussian-viewer.ts
        GPU timer hooks (UikaGpuTimer), sortRuns counter — instrumentation only
edit  src/scripts/chat/uika-native/renderer/index.ts     export the timer type
edit  src/scripts/chat/uika-native/uika-native-replay.ts
        split the single uploadMs timer into selectMs / mapMs / uploadMs,
        add resetInstrumentation() — instrumentation only
```

`/uika-native-replay` is untouched in behaviour. Unchanged and verified by blob SHA
against baseline `e86f066`: `LAMAvatar.astro`, `lam-websocket-manager.ts`,
`live-audio-manager.ts`, `uika-133k-mode.ts`, `a2e-replay.ts`, `package.json`,
`package-lock.json`, `support-base/**`. Unchanged since `b92f648`:
`SplatMaterial.js`, `SplatMesh.js`, `uika-expression-mapper.ts` (so no shader, basis or
mapper change), the Gate 3 fixture, and the old Gate 1/2 files
(`uika-render-adapter.ts`, `uika-native-driver.ts`, `uika-deformation.ts`), which are kept
until Live passes. `tsc --noEmit` reports the same 9 pre-existing errors.

The Run 1 record in §6 was added in a later, documentation-only commit: no file under
`src/`, `support-base/` or `tools/` was touched for it, and the harness is byte-identical
to the one Run 1 was measured with.
