# UIKA Native Runtime — Gate 4B-2A Pre-Deformation Texture PoC

Spec: UIKA Native Runtime v1.1 Gate 4B-2A.
Route: `/uika-native-predeform-benchmark`.
Status: PoC built, **correctness measured and PASS**. Performance has to be measured on
the machine with the real GPU, so §6 is PENDING until that run comes back.

---

## 0. Where this starts

Gate 4B-1 is closed with `MIXED`
(`UIKA_NATIVE_RUNTIME_GATE4B1_DRAW_ISOLATION.md` §6.3):

```text
production 51-basis draw p50   72.06 ms     basisShare  47.5 %
no-basis            draw p50   37.82 ms     rasterShare 31.9 %
basis removal delta            34.25 ms
no-basis effectiveFPS          25.04
```

So the 51-channel loop is a major cost, and removing it outright still does not reach
30 fps at DPR 1.5 — 37.82 ms of draw alone against a 33.3 ms frame budget. That is why
§15 of this gate asks for a pixelRatio 1.0 diagnostic alongside the full-resolution
measurement, and why this PoC does not pretend that removing the loop is the whole answer.

What this PoC changes is not how much work the basis costs, but how many times it is done.

```text
now      every rendered Gaussian, every frame:  51 basis fetches in the render shader
         and 51 more in the distance/sort shader

PoC      expression weights change
           -> one pass over 133,541 Gaussians x 51 channels into animatedCenterTexture
           -> render : one texel fetch per Gaussian
           -> sort   : one texel fetch per Gaussian, from the same texture
```

The animated centre of one A2E frame is one value per Gaussian, and at 30 fps of A2E
against 60+ rendered frames the render path recomputes it repeatedly while the sort path
computes it a second time. This removes that repetition. It is not basis reduction:

```text
133,541 Gaussians    kept
51 basis channels    kept
D_UIKA               untouched
expression weights   untouched
the mapper           untouched
visual quality       not traded away — see §3, the frames are pixel-identical
```

---

## 1. What is NOT touched

Unchanged, verified by blob SHA against the Gate 4B-1 head `d4067a5`:

```text
/uika-native-replay                  the page and its script
/uika-native-benchmark               Gate 4A route
SplatMaterial.js                     the production shader source
SplatMesh.js                         production behaviour
uika-expression-mapper.ts            the mapper
a2e-real-capture-gate3.json          the fixture
LAMAvatar.astro, lam-websocket-manager.ts, live-audio-manager.ts,
uika-133k-mode.ts, a2e-replay.ts     normal LAM path
support-base/**                      backend, Live API, A2E
package.json, package-lock.json      dependencies
```

Not done, per §17: no basis channel reduction, no Gaussian reduction, no D_UIKA
approximation, no half precision, no active-channel threshold, no LOD, no Live
connection, no backend change, no LAM change, and no production integration.

The PoC render variant and the PoC distance pass are installed on the viewer only while a
run is in progress and removed in a `finally` block; the report carries the restored
shader's fingerprint, so that is checkable from the JSON.

---

## 2. How it is built

### 2.1 The pre-deformation output (§5)

```text
format              RGBA32F
dimensions          4096 x 33  = 135,168 texels for 133,541 Gaussians
bytes               2,162,688  (2.06 MiB)
capability needed   EXT_color_buffer_float
```

The capability is checked before anything is allocated. If it is missing the PoC stops
and says so — it never silently drops to a lower-precision format, because then the
measurement would be of a different thing than the one being proposed.

### 2.2 The pre-deformation pass (§6)

A single full-coverage pass writes, for Gaussian `i`:

```text
animatedCenter[i] = canonicalCenter[i] + sum(k = 0..50) weight[k] * D_UIKA[k, i]
```

The three helper functions that read the canonical centre, the basis delta and the weight
are copied **verbatim** from the production vertex shader in `SplatMaterial.js`, including
the texture sampling convention and the accumulation order, and the pass samples the very
same texture objects the production material samples — no second copy of D_UIKA is
uploaded. So the value written is produced by the production expression, not by a
re-derivation of it.

The pass runs when the weights change, not once per animation frame: the viewer calls a
hook after every weight upload, which marks the pass dirty, and the pass runs at the top
of the next frame only if that flag is set. The report counts both, and §13's requirement
is checked as `predeformPassCount <= weightUploadCount`.

### 2.3 The render variant (§7)

The production vertex shader's basis loop statement — and only that statement — is
replaced:

```glsl
// production
for (int k = 0; k < uikaBasisCount; ++k) {
    splatCenter += uikaWeight(k) * uikaBasisDelta(k, splatIndex);
}

// PoC
splatCenter = uikaPredeformedCenter(splatIndex);   // one texelFetch
```

Opacity, scale, rotation, SH/RGB, covariance and the projection are carried over
character for character, because the rest of the generated source is reused as it stands.

### 2.4 The sort / distance variant (§8)

The production distance pass (`SplatMesh.computeDistancesOnGPU`) evaluates all 51 channels
a second time. The PoC installs its own transform-feedback pass that fetches the same
pre-deformed centre and computes the same dot product in the same order:

```glsl
vec3 animatedCenter = texelFetch(uikaAnimatedCenterTexture, ivec2(i % w, i / w), 0).xyz;
distance = animatedCenter.x * modelViewProj.x +
           animatedCenter.y * modelViewProj.y +
           animatedCenter.z * modelViewProj.z;
```

Mechanism, fence and readback mirror the production path, so a production-vs-PoC sort
comparison differs only in where the centre comes from. Render and sort read one texture:
there is no second deformation result anywhere.

---

## 3. Correctness — measured, PASS

Run on this container (ANGLE + SwiftShader). Correctness does not depend on GPU speed,
and the same shader source and the same textures are used there as on real hardware, so
this part of the gate is settled here; only the timings in §6 need the real GPU.

Each case sets the weights, then compares three things over **all 133,541 Gaussians**:
the pre-deformed centres against the CPU reference
(`applyUikaBasisWeightsCpu`, which accumulates in float64), the production 51-channel GPU
distance pass against the PoC distance pass, and the rendered frame against the
production-rendered frame pixel for pixel with the sort order held still.

```text
capability            EXT_color_buffer_float = available
texture               RGBA32F 4096 x 33, 135,168 texels, 2,162,688 bytes
MAX_TEXTURE_SIZE      8192
```

```text
case                  non-zero w   max |xyz - CPU|   max |dist prod - PoC|   frames   pass
A-neutral                      0    0.000000e+00          0.000000e+00       same     PASS
B-jawOpen                      1    0.000000e+00          0.000000e+00       same     PASS
B-eyeBlinkLeft                 1    0.000000e+00          0.000000e+00       same     PASS
B-eyeBlinkRight                1    0.000000e+00          0.000000e+00       same     PASS
B-mouthSmileLeft               1    0.000000e+00          0.000000e+00       same     PASS
B-mouthSmileRight              1    0.000000e+00          0.000000e+00       same     PASS
C-a2e-frame-20                51    4.470348e-08          0.000000e+00       same     PASS
C-a2e-frame-63                51    4.470348e-08          0.000000e+00       same     PASS
C-a2e-frame-123               51    4.470348e-08          0.000000e+00       same     PASS
C-a2e-frame-132               51    5.215406e-08          0.000000e+00       same     PASS
C-a2e-frame-191               47    3.725290e-08          0.000000e+00       same     PASS

CORRECTNESS = PASS   (11 of 11 cases)
GL errors 0, page errors 0, no non-finite centre component
mean |xyz - CPU| across the A2E cases: 1.18e-09 to 1.57e-09
```

Reading those three columns:

- **Against the production GPU path**, which is the reference §10 names, the difference is
  **exactly zero** in all eleven cases, over every Gaussian. The depth key is a dot
  product of the animated centre, so a single differing bit in any centre would show up
  here, and none does.
- **Against the CPU reference**, neutral and every single-channel morph are exactly zero.
  The full 51-channel frames differ by 2.5 to 3.5 float32 ulp at the coordinate magnitude
  involved (ulp = 2^-26 = 1.4901e-08 for |x| in [0.125, 0.25); 4.470348e-08 is exactly
  3 ulp, 5.215406e-08 exactly 3.5 ulp, 3.725290e-08 exactly 2.5 ulp). That is the CPU
  reference accumulating 51 channels in float64 and the GPU accumulating them in float32,
  which is the same comparison Gate 3B made of the production path; it is not a loss
  introduced by the texture, which stores float32 exactly.
- **The rendered frames are pixel-identical** — the same hash, the same non-zero pixel
  count, the same alpha sum — in all eleven cases, with the same camera, the same
  resolution and the sort suspended so that compositing order cannot differ.

### 3.1 Visual comparison (§11)

§11's checklist — jaw, blink, pucker, stretch, neutral, face outline, hair/face depth,
Gaussian smear, explosion — is answered by that last column rather than by eye: when the
drawing buffers hash identically there is no visual difference to inspect, at any of the
five A2E frames or the five morphs. The route also renders either mode live, so the same
frames can be looked at directly on the real GPU.

Note what the pixel-identity does and does not cover: it was measured at this container's
386 x 386 buffer, and with the sort suspended. The real-GPU run repeats the whole
correctness suite at 1138 x 1138 before it measures anything, so the same check is made at
the resolution that matters.

---

## 4. Thresholds used

```text
max |pre-deformed - CPU reference|   <= 1e-6      decision rule for this gate
max |production distance - PoC|      <= 1e-6      decision rule for this gate
rendered frames                      identical    required
Gate 3B's figure for the production path against the same CPU reference: 9.80e-09
```

The two 1e-6 bounds are decision rules chosen for this gate, not measured quantities. The
measured values are three to four orders of magnitude below them, and the production-path
comparison is exactly zero.

---

## 5. How to run it on the real GPU

```text
1. Open  /uika-native-predeform-benchmark
2. Wait for "Start PoC" to enable (asset and fixture loaded).
3. Close DevTools. Keep the tab visible and in the foreground; do not switch tabs and do
   not minimise the window for the whole run.
4. Click Start PoC.
5. When it finishes, click Export JSON.
```

The run does correctness first and reports no timing at all if it fails. Then, at the CSS
size this route shares with the Gate 4A and 4B-1 routes (759 x 759 at DPR 1.5 on that
machine, so a 1138 x 1138 drawing buffer):

```text
production-51-basis / fixed-pose     frame 20 held
predeform           / fixed-pose     frame 20 held, pre-deformation already complete
production-51-basis / real-a2e       192-frame fixture, 30 fps, time-based
predeform           / real-a2e       same replay
```

Each is a 6 s warm-up and a 30 s measurement. If the pre-deformed real-A2E run misses
30 fps at full DPR, two more measurements follow at pixelRatio 1.0 (a 759 x 759 buffer —
higher quality than Gate 4B-1's 50 % point, which was pixelRatio 0.75): production and
pre-deformed, real A2E. No automatic quality switch is implemented, here or anywhere else.

Query parameters: `?warmupMs=`, `?measureMs=`, `?dpr1=1|0`, `?correctnessOnly=1`,
`?allowSoftware=1`.

---

## 6. Performance — PENDING (real GPU)

```text
GPU / browser / DPR / drawingBuffer                                PENDING

DPR 1.5
  production / fixed-pose   draw p50-p95, sort p50, fps            PENDING
  predeform  / fixed-pose   predeform p50, draw p50-p95, sort p50, fps   PENDING
  production / real-a2e     draw p50-p95, sort p50-p95, fps, wall p50-p95-p99   PENDING
  predeform  / real-a2e     predeform p50-p95, draw p50-p95, sort p50-p95,
                            fps, wall p50-p95-p99                  PENDING
  predeformPassCount vs changed expression frames                  PENDING
  draw saved / sort saved                                          PENDING

pixelRatio 1.0 (only if full DPR misses 30 fps)
  production / real-a2e     fps                                    PENDING
  predeform  / real-a2e     fps, wall p95                          PENDING

invalid GPU timer samples / GL errors / page errors                PENDING

FULL_DPR_PERF  = PENDING
DPR1_PERF      = PENDING
DECISION       = PENDING
```

Nothing above is estimated or extrapolated.

### Acceptance as implemented (§16)

```text
real A2E, pre-deformed, full DPR:
  effectiveFPS >= 30 and wall p95 <= 33.3 ms and GL errors 0 and page errors 0
  and predeformPassCount <= changed expression frames        -> FULL_DPR_PERF_PASS
the same at pixelRatio 1.0 only                              -> PREDEFORM_PASS
                                                                FULL_DPR_PERF_FAIL
                                                                DPR1_PERF_PASS
neither                                                      -> FULL_DPR_PERF_FAIL
                                                                DPR1_PERF_FAIL
software renderer                                            -> PERF_BLOCKED_SOFTWARE_RENDERER
```

Correctness is reported separately and always, as `PREDEFORM_CORRECTNESS_PASS` or
`_FAIL`; a correctness failure stops the run before any timing is produced.

---

## 7. Harness self-test (not a Gate 4B-2A performance result)

This container has no GPU, so the timings it produces are not evidence and the decision is
forced to `PERF_BLOCKED_SOFTWARE_RENDERER`. What the self-test establishes is that the
driver works end to end:

Two runs, both with `?allowSoftware=1`: one `?correctnessOnly=1`, and one full run with
short windows (`warmupMs=3000&measureMs=12000`).

```text
decision              PREDEFORM_CORRECTNESS_PASS, PERF_BLOCKED_SOFTWARE_RENDERER
correctness           PASS, 11 of 11, identical in both runs
capability            EXT_color_buffer_float available, RGBA32F 4096 x 33 allocated
GL errors             0        page errors 0        pageerror events 0
shader before / after 401299d2 / 401299d2   loop present, 1 basis fetch, 0 predeform fetch
```

The four measurements ran in both modes and the mode really switched:

```text
measurement                         shader.predeformActive   predeform fetches
production-51-basis / fixed-pose    false                    0
predeform           / fixed-pose    true                     1
production-51-basis / real-a2e      false                    0
predeform           / real-a2e      true                     1
```

§13's requirement was checked and held: `predeformPassCount = 5` for
`weightUploadCount = 5` in the pre-deformed real-A2E measurement, so the pass ran once per
changed expression frame and never on a frame whose weights had not changed.

One thing that measurement makes concrete, and that §3's framing should be read against:
the replay is ticked once per rendered frame, so while the render rate is **below** 30 fps
every rendered frame lands on a new A2E frame and the deformation pass runs once per
rendered frame — here 5 passes for 5 frames. The saving in that regime is not that the
pass runs rarely; it is that the 51-channel evaluation happens once per Gaussian in one
pass instead of once per Gaussian in the render shader **and** again in the distance
shader, and that the render and sort passes drop to a single fetch each. Only above 30 fps
do rendered frames start sharing an A2E frame and the pass additionally run less often
than the frames. Which of those matters more is what the real-GPU numbers in §6 will say;
nothing is claimed here.

Software-renderer timings from these runs are deliberately not quoted as a result, and the
report's `fullDprPerf` field reads FAIL only because 0.26 fps on SwiftShader fails the
arithmetic — the decision list is what governs, and it says
`PERF_BLOCKED_SOFTWARE_RENDERER`. As in Gate 4B-1, the GPU timer sample counts are tiny
here (0 to 2 per window) because a frame takes about 4 seconds and a timer query is polled
four frames after it is submitted; a 30 s window at real-GPU frame rates is several hundred
frames, and where a window yields no samples the report states the absence instead of
filling it in (`drawSavedMs` came back `null` in this self-test for exactly that reason).

The correctness numbers in §3 come from this same environment and **are** a result: they
depend on the shader source and the data, not on how fast the GPU is.

---

## 8. Gate 4B-1 known bug (§18)

`isolationOptionsFromUrl()` overwrote the default `basisCounts` with `[0]` whenever the
parameter was absent, which is what cost Gate 4B-1 Run 1 four of its five Diagnostic 3
points. Both list parameters are now parsed only when the parameter is actually present.
Verified:

```text
absent   -> [0,8,16,32,51]
explicit -> [0,8,16,32,51]
'0,51'   -> [0,51]
'abc'    -> [0,8,16,32,51]
```

Diagnostic harness only; no production path.

---

## 9. Changes in this commit

```text
new   src/pages/uika-native-predeform-benchmark.astro              Gate 4B-2A route
new   src/scripts/chat/uika-native/predeform/uika-predeform-pass.ts
        RGBA32F render target, the deformation pass, the PoC distance pass, readback
new   src/scripts/chat/uika-native/uika-predeform-benchmark.ts
        correctness suite, measurements, analysis, decision
edit  src/scripts/chat/uika-native/renderer/uika-gaussian-viewer.ts
        PoC-only and inert by default:
          setPredeformCenterTexture / isPredeformActive   render variant
          setDistanceProvider                            sort source
          setPreRenderHook / setExpressionWeightHook      when the pass runs
          getPoCHandles                                   borrowed renderer and mesh
edit  src/scripts/chat/uika-native/uika-native-benchmark.ts
        a third GPU timer bucket (predeform); empty on every other route
edit  src/scripts/chat/uika-native/uika-draw-isolation.ts
        §18 query-parsing fix
edit  docs/UIKA_NATIVE_RUNTIME_GATE4B1_DRAW_ISOLATION.md
        Gate 4B-1 closed as MIXED, Diagnostic 3 recorded as not a scaling model
```

With nothing calling the PoC methods, the generated shader source, every uniform, the sort
path and the drawing-buffer size are exactly what Gate 3, Gate 4A and Gate 4B-1 measured.
`tsc --noEmit` reports the same 9 pre-existing errors.

---

## 10. STOP

The gate ends when the PoC's correctness and performance are measured. Production
integration is not started, Gate 5 Live is not started, and the production architecture
decision comes after this report.
