# UIKA Native Runtime — Gate 4B-2A Pre-Deformation Texture PoC

Spec: UIKA Native Runtime v1.1 Gate 4B-2A.
Route: `/uika-native-predeform-benchmark`.
Status: **`GATE4B2A_CORRECTNESS = PASS`** under acceptance v2; **performance FAIL**
(`FULL_DPR_PERF = FAIL`, `DPR1_PERF = FAIL`) with a large measured improvement — see §6.
The DPR 1 failure is a tail-latency failure, not a throughput one, and is now
Gate 4B-2B-0.

Correctness status in full:
(numeric + visual equivalence), decided on the 192-frame real-GPU sweep. Reported
separately and kept that way: `BIT_EXACT_EQUIVALENCE = FAIL` (135/192),
`NUMERIC_EQUIVALENCE = PASS` (192/192), `VISUAL_EQUIVALENCE = PASS` (192/192 within the
explicit tolerance). Under the earlier v1 rule (pixel-identical) this PoC was
`CORRECTNESS = FAIL`, and that result is kept, not rewritten — §3 is in chronological
order. Performance is now unblocked and is the open work (§6).

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

## 3. Correctness

### 3.0 Correction to the scope of §3.1

§3.1 was written as though correctness were settled by the SwiftShader run, on the
grounds that the shader source and the data are the same on any GPU. The real-GPU run
disproved that: the arithmetic a driver emits for the same GLSL is not the same on every
device. Two statements from the earlier record are therefore withdrawn as
hardware-independent claims and now read:

```text
production GPU distance vs PoC distance
  SwiftShader    bit-exact (0.000000e+00 in all eleven cases)
  AMD real GPU   tiny non-zero floating-point differences observed on real A2E frames,
                 of the order 3.725e-09 and 7.451e-09
```

"The PoC is bit-exact against the production GPU path" is not used as a
hardware-independent fact anywhere in this document. What §3.1 measures is what that
machine does.

### 3.1 Correctness on SwiftShader — PASS (this container)

Run on this container (ANGLE + SwiftShader).

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
  **exactly zero** in all eleven cases on this renderer, over every Gaussian — see §3.0:
  this is a SwiftShader result, not a hardware-independent one. The depth key is a dot
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

### 3.2 Correctness on the real GPU — FAIL (1 of 11)

```text
CORRECTNESS = FAIL
PERFORMANCE = NOT_RUN
DECISION    = PREDEFORM_CORRECTNESS_FAIL
```

The failing case, as reported from the JSON:

```text
C-a2e-frame-20
  gaussiansCompared            133541
  max |xyz - CPU|              4.470348358154297e-08
  max distance diff            3.725290298461914e-09
  nonFiniteCenters             0

  production framebuffer hash  b55a0889
  predeform  framebuffer hash  b487892c

  nonZeroPixels                702787  /  702787
  alphaSum                     174749179  /  174749179
```

Only the framebuffer hash differs. The other real A2E frames — 63, 123, 132 and 191 —
carry numerical differences of the same order and their framebuffer hashes match
completely.

What that does and does not establish:

- The numbers are within the §4 rules by a wide margin: 4.47e-08 against a 1e-06 bound
  (and 4.47e-08 is exactly 3 float32 ulp at this coordinate magnitude), 3.73e-09 against
  the same bound.
- The frame nevertheless renders differently, so **something** reaches the pixels. An
  identical non-zero pixel count and an identical alpha sum are consistent with a tiny
  colour difference but do not prove the alpha plane is bit-exact: a sum can match while
  individual values move in opposite directions.
- Four other 51-channel frames with comparable numerical differences produce identical
  pixels, so the relationship between the centre difference and the pixel difference is
  not a simple function of magnitude.

Nothing beyond that is claimed. In particular the gate does not record "visually
identical, therefore acceptable": whether a difference is acceptable is decided after it
is measured, not instead of measuring it.

### 3.3 Acceptance at that point — unchanged (historical)

While the difference was being investigated the thresholds stayed exactly as they were,
including **pixel-identical**: a hash mismatch counted as a failure until there was a
measured reason to treat it otherwise, and any change to the rule was to be a separate
decision taken on the numbers, not a loosening to make the run pass.

That is what happened. The numbers came from the 192-frame sweep (§3.4.3), and the rule
was then revised deliberately in §3.6. The `CORRECTNESS = FAIL` of §3.2 stands as the
result under v1 and is not rewritten.

### 3.4 The difference investigation — result

```text
INVESTIGATION CLASSIFICATION = B-deterministic-float-level-difference
```

Set by the user after reviewing the real-GPU run, replacing the `A-real-correctness-defect`
the harness had reported. `A` is not adopted. Frame 20, real GPU:

```text
production hash stable       20 / 20
predeform  hash stable       20 / 20

different pixels             1 / 1,295,044        (= 7.72e-07 of the frame)
different channels           1 / 5,180,176
R max byte delta             1
G / B / A delta              0
alpha plane identical        YES

max  centre abs diff         1.490116119e-08
mean centre abs diff         2.17e-11
nonFinite                    0
```

Both modes are self-consistent across 20 renders of the same pose, so this is not
measurement nondeterminism: the difference is deterministic. And 1.490116119e-08 is
exactly 2^-26, one float32 ULP at this coordinate magnitude, against a numeric bound of
1e-06 — so one pixel in 1.3 million moved by one byte level in R alone.

```text
B does NOT mean PASS.
```

The acceptance rule is still pixel-identical (§3.3), so under the rule in force:

```text
CORRECTNESS = FAIL
PERFORMANCE = NOT_RUN
```

### 3.4.1 ULP distance is no longer a severity classifier

The harness classified on `maxUlp <= 4`. The real-GPU run contradicts that rule directly:

```text
frame 132   maxUlpDifference 2706   differentPixels 0   framebuffer pixel-identical
frame  20   maxUlpDifference 1364   differentPixels 1   framebuffer differs
```

The frame with more than twice the ULP distance is the one that renders identically. Near
zero a large ULP count can accompany a vanishing absolute difference — two values either
side of zero are far apart in ordered-integer space and almost equal in value — so a ULP
count is not a magnitude.

The classifier now uses the absolute difference, the determinism result and the presence
of non-finite values, and nothing else:

```text
a mode disagrees with itself                          -> C-measurement-nondeterminism
no pixel and no centre difference at all               -> NO-DIFFERENCE-REPRODUCED
a non-finite component, or centre abs > 1e-06          -> A-real-correctness-defect
otherwise (deterministic, inside the numeric bound)    -> B-deterministic-float-level-difference
```

The ULP histogram stays in the report as a diagnostic, and each comparison now also
carries `absAtMaxUlp` — the absolute difference at the component where the ULP distance
was largest — so the two can never be confused again.

### 3.4.2 What the three diagnostics measure

Unchanged from the plan, and all four ran on the real GPU:

**Diagnostic A — repeatability.** Frame held, same camera, same weights, sort suspended,
same resolution; 20 consecutive renders per mode, every framebuffer hash kept with its
frequency.

**Diagnostic B — pixel-level diff.** Both RGBA buffers kept and compared value by value:
`totalPixels`, `differentPixels`, `differentPixelRatio`, `differentChannels`, per-channel
differing count / max abs byte diff / mean abs diff, `maxRgbaByteDelta`,
`sumAbsoluteDifference`, the difference bounding box, and a histogram of `|delta|`.

**Alpha, independently (§6).** Per-channel FNV hashes of the R, G, B and A planes for both
modes, so "is the alpha plane exact?" and "is this an RGB-only difference?" are answered
directly rather than inferred from a matching sum.

**Diagnostic C — GPU centre comparison.** The animated centre XYZ read out of the GPU by
transform feedback, by three routes using the verbatim production expression
(`production-attribute`, the production distance shader's attribute route;
`production-texture`, the same vertex stage with the render shader's centre fetch;
`predeform`, the fragment-stage RGBA32F texture), compared over all 133,541 Gaussians.

**Diagnostic D.** The same three for frame 20 (hash FAIL) and frames 63 and 132 (hash PASS).

**Hypotheses, recorded as hypotheses.** FMA contraction, rounding, instruction ordering or
stage-specific optimisation differing between the production vertex shader and the
pre-deformation fragment shader on the AMD driver. None of it was tested, so none of it is
a finding; the report carries the list under `hypothesesNotTested`.

### 3.4.3 Full-fixture sweep (§5 - §8) — result

All 192 frames of `a2e-real-capture-gate3.json`, production against pre-deformed, one
comparison per frame, same camera, same resolution, sort suspended, one draw order. Real
GPU: AMD Radeon 860M / Chrome 154 / DPR 1.5.

```text
frames compared               192

pixel-identical frames        135
frames with a pixel diff       57

worst different pixels          5
worst different ratio           3.8608726807737804e-06
max RGBA byte delta             1

worst centre maxAbs             1.4901161193847656e-08
worst centre meanAbs            2.1734084847940168e-11
worst distance maxAbs           7.450580596923828e-09
worst centre-vs-CPU maxAbs      5.960464477539063e-08

frames with an alpha diff       [64, 159]
frames with non-finite          []
frames outside the 1e-06 bound  []

allWithinNumericBound           true
```

The arithmetic those numbers imply, stated rather than left to be taken on trust:

```text
5 differing pixels / 1,295,044        = 3.8608726807737804e-06   exactly the reported ratio
worst centre maxAbs                   = 2^-26, one float32 ULP at that magnitude
worst distance maxAbs                 = 2^-27
worst centre-vs-CPU maxAbs            = 4 x 2^-26
57 of 192 frames (29.7%) differed in at least one pixel; none by more than one byte level
```

### 3.4.4 ULP, once more, measured

```text
max ULP distance                           91834
absolute difference at that component      8.15649769947413e-11
```

8.16e-11 is 0.0055 of a float32 ULP at the |x| ∈ [0.125, 0.25) scale — the component sits
near zero, where ordered-integer distance says nothing about magnitude. The ULP histogram
stays in the report as a diagnostic and is not used for severity or for PASS/FAIL.

### 3.6 Acceptance revision — v2

On the evidence above, cross-GPU correctness is no longer judged by bit-exact framebuffer
equality but by

```text
numeric equivalence  +  visual equivalence
```

Why: the same GLSL arithmetic does not produce the same final float32 bits across shader
stages and GPU drivers — measured, not assumed (§3.0, §3.2, §3.4) — so bit-exact
framebuffer equality is not a portable contract. Over the whole fixture the actual
differences stayed minute: one ULP of centre, half an ULP of depth key, one byte level of
colour, five pixels in 1.3 million at worst.

```text
acceptanceVersion          v2-numeric-and-visual-equivalence
previousAcceptanceVersion  v1-pixel-identical
```

**A. Structural**

```text
framesCompared == expected frames
nonFinite == 0
GL errors == 0
page errors == 0
```

**B. Numeric equivalence** — the v1 bound carried over, plus the depth key

```text
max animated-centre absolute difference  <= 1e-06
max distance absolute difference         <= 1e-06
```

**C. Visual equivalence** — explicit cross-GPU tolerances

```text
max RGBA byte delta          <= 1
differentPixelRatio          <= 1e-05   per frame
```

Alpha is evaluated under the same rules as the colour channels: it is not required to be
bit-exact, but an alpha byte delta above 1, or a ratio above the per-frame limit, fails.
That is why frames 64 and 159 — which differ in alpha — are reported individually and are
also measured against the byte-delta rule rather than waved through.

The three equivalences are reported separately and never collapsed into one flag:
`bitExactVerdict`, `numericVerdict`, `visualVerdict`, `correctnessVerdict`,
`acceptanceVersion`. Each run also reports `underPreviousAcceptance`, so what v1 would
have said stays visible in the JSON.

### 3.7 Final correctness decision

```text
BIT_EXACT_EQUIVALENCE  = FAIL      135 / 192
NUMERIC_EQUIVALENCE    = PASS      192 / 192
VISUAL_EQUIVALENCE     = PASS      192 / 192 within the explicit tolerance

GATE4B2A_CORRECTNESS   = PASS      under v2-numeric-and-visual-equivalence
```

Margins against the v2 rules, from the worst case of the sweep:

```text
centre         1.4901e-08  against 1e-06     67x inside
distance       7.4506e-09  against 1e-06    134x inside
centre vs CPU  5.9605e-08  against 1e-06     17x inside
byte delta     1           against 1          at the limit
pixel ratio    3.8609e-06  against 1e-05    2.6x inside
```

The history is kept, not rewritten: under v1 this PoC was `CORRECTNESS = FAIL`
(§3.2), the difference investigation classified it `B-deterministic-float-level-difference`
(§3.4), and the revision to v2 (§3.6) is what changes the verdict — not a re-reading of
the earlier run. `BIT_EXACT_EQUIVALENCE = FAIL` remains in every report.

Performance is unblocked by this decision and is the next measurement (§6).

### 3.8 Visual comparison (§11)

§11's checklist — jaw, blink, pucker, stretch, neutral, face outline, hair/face depth,
Gaussian smear, explosion — is answered by that last column rather than by eye: when the
drawing buffers hash identically there is no visual difference to inspect. On SwiftShader
that held for all ten morph and A2E cases; on the real GPU it holds for every case except
frame 20, whose actual pixel difference §3.4's Diagnostic B measures instead of
eyeballing. The route also renders either mode live, so the same
frames can be looked at directly on the real GPU.

Note what the pixel-identity does and does not cover: it was measured at this container's
386 x 386 buffer, and with the sort suspended. The real-GPU run repeats the whole
correctness suite at 1138 x 1138 before it measures anything, so the same check is made at
the resolution that matters.

---

## 4. Thresholds used

Acceptance **v1** (pixel-identical), in force until §3.6:

```text
max |pre-deformed - CPU reference|   <= 1e-6
max |production distance - PoC|      <= 1e-6
rendered frames                      identical     required
```

Acceptance **v2** (`v2-numeric-and-visual-equivalence`), in force now and implemented in
`predeform/uika-correctness-contract.ts`:

```text
A structural   framesCompared == expected, nonFinite == 0, GL errors == 0, page errors == 0
B numeric      max animated-centre absolute difference  <= 1e-06
               max distance absolute difference         <= 1e-06
C visual       max RGBA byte delta                      <= 1
               differentPixelRatio per frame            <= 1e-05
               alpha under the same rules; not required to be bit-exact
```

Every bound is a decision rule chosen for this gate, not a measured quantity. The
measured worst case over the whole fixture sits 17x to 134x inside the numeric bounds and
2.6x inside the pixel-ratio bound, with the byte-delta rule met exactly at 1 (§3.7).
Gate 3B's figure for the production path against the same CPU reference, for comparison:
9.80e-09. Bit-exactness is still measured and still reported — as
`BIT_EXACT_EQUIVALENCE`, which is FAIL — it is simply no longer a requirement.

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

## 6. Performance — FAIL, with a large measured improvement

Real GPU, AMD Radeon 860M / Chrome 154.

```text
FULL DPR (1138 x 1138) — real A2E
  production effectiveFPS     12.56      predeform effectiveFPS     23.38
  GPU draw p50                74.90 ms   ->                         38.42 ms
  GPU sort p50                 5.95 ms   ->                          0.66 ms

pixelRatio 1.0 (759 x 759) — real A2E, pre-deformed
  effectiveFPS                45.19
  GPU pre-deformation p50      2.03 ms
  GPU draw p50                17.71 ms
  GPU sort p50                 0.62 ms
  wall p95                    68.90 ms
```

```text
FULL_DPR_PERF       = FAIL
DPR1_PERF           = FAIL
overall performance = FAIL
```

Full DPR fails outright: a pre-deformed draw p50 of 38.42 ms already exceeds the 33.3 ms
a 30 fps frame allows, before the deformation pass and the sort are counted. That verdict
needs no re-measurement.

DPR 1 fails on the tail, not on throughput. 45.19 fps is 22.13 ms per frame on average,
and the three stages sum to 2.03 + 17.71 + 0.62 = 20.36 ms, which accounts for that
average — while wall p95 is 68.90 ms, 3.11x the mean. Average capability is past 30 fps;
something stalls at the tail. That is Gate 4B-2B-0
(`UIKA_NATIVE_RUNTIME_GATE4B2B0_DPR1_TAIL_ISOLATION.md`).

### 6.1 The production baseline in that run was contaminated

The hooks that drive the deformation pass were installed once for the whole benchmark run
rather than per mode, so the **production** measurement ran the pass as well:

```text
production, DPR 1.5    predeformPassCount = 197
production, DPR 1.0    predeformPassCount = 261
```

A production baseline that runs a pre-deformation pass is not a baseline. The
production-side figures above, and therefore the production-to-pre-deformed deltas, are
affected — the production path was charged for work it does not do. The pre-deformed
figures are not affected, because that mode is supposed to run the pass.

Fixed: `measure()` now installs `setPreRenderHook` and `setExpressionWeightHook` only in
pre-deformed mode and clears them in production mode, and a production measurement is
marked **invalid** unless

```text
predeformPassCount == 0
gpuPredeform sample count == 0
```

so a contaminated baseline can no longer be reported as a measurement. The production
numbers above are kept as what that run produced, with this caveat attached; a clean
production baseline needs a re-run and is not claimed here.

### 6.2 `realA2eTotalGpuP50` renamed

The field that summed `p50(pre-deformation) + p50(draw) + p50(sort)` was called
`realA2eTotalGpuP50`, which claims more than it is: `p50(A) + p50(B) + p50(C)` is not
`p50(A + B + C)`, and the stages do not all run on every frame.

```text
FULL DPR, pre-deformed    passCount 330 of 703 frames        (47%)
DPR 1,    pre-deformed    passCount 687 of 1356 frames       (51%)
                          sortRuns  282 of 1356 frames       (21%)
```

It is now `realA2eSumOfStageP50s`, documented as a sum of per-stage p50s and not a
per-frame total, and the report carries `realA2ePassCount`, `realA2eSortRuns` and
`realA2eRenderedFrames` next to it so the "not every frame" part is visible. The
difference field is `sumOfStageP50sSavedMs`. Report terminology only; no measurement
changed.

Two things that fall out of those counts, as arithmetic rather than interpretation: at
45.19 fps the replay is above its own 30 fps, so only 51% of rendered frames land on a new
A2E frame and the deformation pass runs on about half of them — the regime the earlier
self-test predicted. And 687 weight uploads produced only 282 sort runs, so 405 wanted
sorts did not start; Gate 4B-2B-0 §5 counts that directly.

```text
draw p50 full DPR / DPR 1 = 38.42 / 17.71 = 2.17, against a pixel-count ratio of 1.5^2 = 2.25
```

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


### 7.1 Difference-investigation self-test

`?repeats=3&frames=20,63` on this container, which is enough to exercise every
diagnostic at 3.4 s per rendered frame.

```text
classification        NO-DIFFERENCE-REPRODUCED
finishedAt            set (Gate 4B-2A §10 fix verified)
GL errors             0        pageerror events 0
buffer                386 x 386, pixelRatio 1
```

```text
Diagnostic A   frame 20   production 1 unique hash (ab7e6127 x3)   predeform 1 unique hash (ab7e6127 x3)
               frame 63   production 1 unique hash (dcf70b96 x3)   predeform 1 unique hash (dcf70b96 x3)
               both modes self-consistent, and equal to each other

Diagnostic B   0 of 148,996 pixels differ, 0 differing channels, max byte delta 0,
               sum of absolute differences 0, bounding box null, histogram empty,
               alpha plane identical

Diagnostic C   400,623 components per pair, all three pairs bit-exact, max ULP 0
                 production-attribute vs predeform            0 differing components
                 production-texture   vs predeform            0 differing components
                 production-attribute vs production-texture   0 differing components
               max |centre - CPU reference| = 4.470348e-08 for all three routes,
               the same value the correctness run reported, so the probe reads the same
               centres the PoC and the production path use
```

So on this renderer there is nothing to investigate — which is the point of the
`NO-DIFFERENCE-REPRODUCED` outcome existing separately from `B`. What the self-test
establishes is that the three diagnostics, the per-channel hashes, the ULP histogram, the
three centre routes and the `finishedAt` fix all work, and that the centre probe agrees
with the PoC and the production path to the bit where the hardware has no disagreement to
report.

---


### 7.2 Full-fixture sweep self-test

`?sweepFrames=0,20,63,132` and then `?sweepFrames=20` on this container.

```text
finishedAt            set
GL errors             0        pageerror events 0
buffer                386 x 386, pixelRatio 1
centre route          production-attribute
numeric bound         1e-06
```

```text
frame   centre maxAbsXYZ   diffComps   ULP   centre vs CPU   distance   pixels   alpha
    0     0.000e+00            0         0     3.725e-08      0.0e+00    0 diff   same
   20     0.000e+00            0         0     4.470e-08      0.0e+00    0 diff   same
   63     0.000e+00            0         0     4.470e-08      0.0e+00    0 diff   same
  132     0.000e+00            0         0     5.215e-08      0.0e+00    0 diff   same

summary   framesCompared 4, framesPixelIdentical 4, framesWithPixelDifference 0
          worstCenterVsCpuMaxAbs 5.215406e-08 @frame 132
          framesWithAlphaDifference none, framesWithNonFinite none
          framesOutsideNumericBound none, allWithinNumericBound true
acceptance rule 'pixel-identical', ruleChangedByThisRun false
```

Every per-frame field and every summary field is populated, each worst case carries its
frame number, and `acceptance.ruleChangedByThisRun` is `false` — the harness records what
the current rule says and does not touch it. On this renderer the centre difference is
again zero everywhere, so the numbers that matter will come from the real GPU; what the
self-test establishes is that the sweep measures and summarises correctly, and that the
centre-vs-CPU figures match the correctness run frame for frame (3.725e-08 / 4.470e-08 /
5.215e-08), which is how the sweep is known to be comparing the same thing.

---


### 7.3 Acceptance v2 self-test

Two runs on this container: the sweep with `?sweepFrames=0,20,63,132`, and the full PoC
run with `?allowSoftware=1&warmupMs=3000&measureMs=12000&dpr1=0`.

```text
sweep      acceptanceVersion v2-numeric-and-visual-equivalence (previous v1-pixel-identical)
           structural PASS 4/4, GL 0, page 0
           BIT_EXACT PASS 4/4   NUMERIC PASS 4/4   VISUAL PASS 4/4
           correctnessVerdict PASS, underPreviousAcceptance PASS
           per-frame aMaxAbsByteDiff / rMaxAbsByteDiff present

PoC run    contract structural PASS 11/11, BIT_EXACT PASS 11/11, NUMERIC PASS, VISUAL PASS
           correctnessVerdict PASS
           decision  PREDEFORM_CORRECTNESS_PASS, PERF_BLOCKED_SOFTWARE_RENDERER
           the four DPR measurements ran, so correctness no longer blocks the timings
           pre-deformed real A2E: predeform p50 46.66 ms, passes 3 for 3 uploads
           realA2eTotalGpuP50 (pre-deformation + draw + sort) computed for the
           pre-deformed mode; the production total came back null because its draw had no
           timer samples in a 12 s window at 0.25 fps, and totalGpuSavedMs is null rather
           than a figure computed from a missing stage
GL errors 0, page errors 0, pageerror events 0
```

Everything bit-exact on this renderer, so `BIT_EXACT` reads PASS here; the 135/192 FAIL is
the real-GPU result. What the self-test establishes is that the v2 contract is wired into
both the sweep and the eleven-case suite, that the three equivalences are reported
separately alongside `underPreviousAcceptance`, that a correctness PASS now lets the
performance measurements run, and that the total-GPU-cost figures appear — or are reported
as absent — rather than being filled in from a partial sum.

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

## 9. Changes

Acceptance v2 commit:

```text
new   src/scripts/chat/uika-native/predeform/uika-correctness-contract.ts
        the v1 history, the v2 tolerances, per-sample evaluation and the roll-up:
        bitExactVerdict / numericVerdict / visualVerdict / correctnessVerdict /
        acceptanceVersion / underPreviousAcceptance
edit  src/scripts/chat/uika-native/uika-predeform-investigation.ts
        the sweep evaluates and rolls up the contract, records per-channel max byte
        deltas, and counts GL and page errors
edit  src/scripts/chat/uika-native/uika-predeform-benchmark.ts
        the eleven-case suite compares pixels (not just hashes), judges under v2, and
        gates the performance run on correctnessVerdict; realA2eTotalGpuP50 and
        totalGpuSavedMs added for the §10 total-cost comparison
edit  src/pages/uika-native-predeform-benchmark.astro
        the three verdicts in the live panel and a contract table
```

Full-fixture sweep commit:

```text
edit  src/scripts/chat/uika-native/uika-predeform-investigation.ts
        runSweep(): all 192 frames, one comparison each, per-frame centre / distance /
        framebuffer metrics and a worst-case summary carrying frame numbers;
        classification no longer uses maxUlp — absolute difference, determinism and
        non-finite values only; absAtMaxUlp added to every centre comparison
edit  src/pages/uika-native-predeform-benchmark.astro
        the third button, the sweep summary table and a per-frame table for any frame
        that is not pixel-identical
edit  docs/UIKA_NATIVE_RUNTIME_GATE4B2A_PREDEFORMATION_POC.md
        classification B recorded, the ULP-classifier correction, the sweep plan
```

Difference-investigation commit:

```text
new   src/scripts/chat/uika-native/uika-predeform-investigation.ts
        Diagnostics A-D, per-channel hashes, ULP histograms, classification
new   src/scripts/chat/uika-native/predeform/uika-center-probe.ts
        animated centre XYZ out of the GPU by three routes, verbatim production expression
edit  src/scripts/chat/uika-native/renderer/uika-gaussian-viewer.ts
        requestDrawingBufferPixels() and per-channel hashes on the readback
edit  src/scripts/chat/uika-native/uika-predeform-benchmark.ts
        §10: finishedAt is set even when the run stops early
edit  src/pages/uika-native-predeform-benchmark.astro
        the second button and the investigation table
```

PoC commit:

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
