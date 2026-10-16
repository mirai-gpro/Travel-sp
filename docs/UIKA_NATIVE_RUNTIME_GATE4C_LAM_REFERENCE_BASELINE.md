# UIKA Native Runtime v1.1 — Gate 4C: LAM reference baseline benchmark

| field | value |
| --- | --- |
| route | `/uika-native-lam-baseline` (new; every earlier route untouched) |
| subject | the **production** LAM avatar, mounted through the unmodified `LAMWebSocketManager` |
| nature | **instrumentation only** |
| status | **measured on the real GPU, twice — `UIKA_RUNTIME_BEHIND_LAM` both times** |

---

## 0. Why this gate exists

Gate 4B-2C closed the sort question and, in closing it, made this gate necessary:

```
UIKA A  no sort at all                       43.72 fps   wall p95 45.97 ms
UIKA C  canonical centre + LAM Worker/WASM   42.88 fps   wall p95 46.90 ms
                                             difference  +0.93 ms
```

0.93 ms, inside both runs' own repeat spread. No amount of further work on sort Hz,
buckets, fences, polling, readback or workers removes the remaining 45–47 ms tail, because
the run that does **no sorting at all** already has it.

The project has been measuring UIKA against a 33.3 ms p95 figure that came from 30 fps
arithmetic, not from anything observed. Meanwhile a LAM avatar has been running in
production, looking right, and has **never been measured**. This gate measures it.

The open question was whether that 33.3 ms figure was unnecessarily harsh. **It is not.**
LAM holds a wall p95 of **9.40 ms** on the same machine — 3.5x better than the threshold.
The absolute gate stands, and it stands because it was measured, not because it was
assumed.

---

## 1. Instrumentation only

Nothing in the LAM path is modified. No file under `LAMWebSocketManager`,
`AudioSyncPlayer`, `LiveAudioManager`, `GaussianSplatRenderer`, the LAM `Viewer`, the A2E
path, the JP mouth correction or the backend is edited by this gate.

Every hook is a wrapper that records, calls through to the original, and is restored on
detach. No render policy, sort policy, cadence, frame-selection rule or expression value is
changed.

The renderer handle is **read** out of `LAMWebSocketManager` at runtime.
`GaussianSplatRenderer.instance` is declared as a static by the package but is never
assigned to — the `if (this.instance != undefined) return this.instance` guard in
`getInstance()` is dead code — and the manager exposes no getter. Reading the field is a
diagnostic read, not a modification.

### What is hooked

| hook | measures |
| --- | --- |
| `viewer.render` | render-to-render wall interval, and one GPU timer query per frame |
| `viewer.renderer.render` | how many `renderer.render()` calls LAM makes per frame |
| `viewer.runSplatSort` | sort submissions and submission wall time |
| `viewer.splatMesh.updateRenderIndexes` | render-index upload time |
| `viewer.sortWorker.onmessage` | sort completions and the worker's own `sortTime` |
| `GaussianSplatRenderer.getExpressionData` | expression read timing (§6) |

A stage that cannot be hooked is reported as `not instrumented`. It is never estimated.

`gl.getError()` is deliberately **not** polled: reading it would clear errors the LAM path
is entitled to see. The field is reported as 0 with that reason, rather than silently
interfering.

---

## 2. What the LAM path actually does

Read from the package source and then **confirmed at runtime** on the mounted avatar:

| | value | how |
| --- | --- | --- |
| loop | `GaussianSplatRenderer.render()` drives its own `requestAnimationFrame` and calls `viewer.update()` + `viewer.render()` on **every tick** | source |
| `Viewer.selfDrivenUpdate()`'s `vsyncNum = 4` divider | **not on this path** — it belongs to the `viewer.start()` route, which this app does not use | source |
| `renderMode` | `0` = `RenderMode.Always` | runtime |
| `gpuAcceleratedSort` | **`true`** | runtime |
| `integerBasedSort` | **`true`** | runtime |
| `sharedMemoryForWorkers` | `false` | runtime |
| `splatSortDistanceMapPrecision` | `16` → 65,536 buckets | runtime |
| `renderer.render()` calls per frame | **1** on this avatar (`Viewer.render()` can issue up to four — scene, splat mesh, focus marker, control plane — and the harness counts them so the GPU draw sample stays comparable with UIKA's single call) | runtime |
| **splat count** | **20,018** | runtime |

Two of these matter more than the rest.

**LAM's production sort is the D-shaped arrangement.** `gpuAcceleratedSort: true` means LAM
runs GPU distance → `fenceSync` → `getBufferSubData` → Worker/WASM sort — the arrangement
Gate 4B-2C measured as variant D and found to cost 52.97 ms of tail **at 133,541
Gaussians**. LAM runs it at 20,018.

**LAM renders 20,018 Gaussians against UIKA's 133,541 — 6.67x fewer.** This is the single
most important caveat on the comparison table in §6, and it is stated there rather than
smoothed over.

---

## 3. Measurement conditions

`devicePixelRatio` is **not** touched. In the LAM `Viewer` that value is passed to the
`SplatMesh` constructor as well as to the renderer, and feeds the splat scale maths
(`Viewer.js` lines 366, 815–824); overriding it after construction would change how LAM
looks, which §1 forbids. `renderer.setPixelRatio` is only called once in `setupRenderer()`
and the `ResizeObserver` only calls `setSize`, so the ratio set at construction stands.

Instead the container is sized to `round(879 / devicePixelRatio)` CSS pixels so that the
**drawing buffer** lands on 879 x 879 — the rasterised sample count UIKA Gate 4B-2C was
measured at. The actual drawing buffer, renderer pixel ratio, device pixel ratio and canvas
CSS size are all read back into the report, so the condition is measured rather than
assumed.

Three repeats minimum, 12 s each by default, same machine, visible tab, DevTools closed.

---

## 4. The stimulus is the same one UIKA was measured with

LAM is fed the **bundled real-A2E fixture** `a2e-real-capture-gate3.json` — 192 frames at
30 fps over 52 ARKit channels — the same fixture Gate 4B-2C drove UIKA with, through the
production expression path including the JP mouth correction. The two runtimes therefore
see the same stimulus.

Two paths, both production code:

* **`cache`** (default) — a `requestAnimationFrame` driver selects the frame the clock is
  asking for and pushes it with `manager.updateExpression()`, exactly as `AudioSyncPlayer`
  does; the renderer reads the cache from inside its own loop. This is the normal LAM
  timeline.
* **`provider`** (`?lamExprPath=provider`) — `manager.setExpressionProvider()`, the public
  method the UIKA 133K mode already uses, so the renderer pulls at read time.

**No audio is played.** The `AudioContext` is used as a clock only, and the report says so.
This gate measures runtime timing. It does not measure lip-sync quality, and no number in
it should be read as such.

---

## 5. Expression timing, and one measurement that had to be fixed twice

§6 asks for the audio clock, the selected frame, the frame the renderer received, and the
render timestamp. The first implementation recorded "selected" and "rendered" from the same
variable at push time, so `renderLag` was **structurally zero** — it could not have been
anything else. That is now fixed: `selectedFrame` is computed **at the moment the renderer
reads** (what the clock is asking for) and `renderedFrame` is the last frame actually
pushed into the cache, so `renderLag = selected − rendered` is how stale the expression was
when LAM took it. At 30 fps one frame is 33.3 ms.

The container self-test then still returned `renderLag` 0, and that needed a second fix —
not to the number, but to whether it can be read at all. In `cache` mode the pusher and the
LAM loop share the `requestAnimationFrame` queue; if the pusher happens to run 1 ms before
the read, zero lag is trivially true and says nothing. So each sample now also carries
`msSinceLastPush`, and each run carries `driverTicks`. A `renderLag` of 0 is only
meaningful alongside them.

§7's counters — `selectedFrames`, `renderedFrames`, `sameExpressionHeldFrames`,
`expressionFrameSkips`, `maxExpressionFrameJump` — are reported as measured. They exist to
show how much LAM really holds and drops while still looking right, not as an optimisation
target.

---

## 6. The comparison, and what it cannot settle

The report puts LAM beside the frozen Gate 4B-2C numbers. The UIKA rows carry their
**per-repeat values** as constants so the means can be audited rather than trusted.

| | FPS | wall p50 | wall p95 | p95 spread | GPU draw p50 | splats | meets 30 fps / 33.3 ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| **LAM reference, §9.2 run (120 Hz display)** | **119.96** | **8.30** | **9.40** | **0.60** | **4.17** | 20,018 | **yes** |
| **LAM reference, §9.3 run (60 Hz display)** | **60.02** | **16.67** | **19.03** | **0.40** | **7.16** | 20,018 | **yes** |
| UIKA A no-sort | 43.72 | 24.27 | 45.97 | 5.80 | 19.92 | 133,541 | no |
| UIKA C canonical + LAM Worker/WASM | 42.88 | 24.37 | 46.90 | 6.20 | 20.49 | 133,541 | no |

**Verdict: `UIKA_RUNTIME_BEHIND_LAM` in both runs.** The gap is 37.50 ms against a combined
repeat spread of 6.80 ms in the first and 27.87 ms against 6.60 ms in the second — 5.5x and
4.2x the spread. LAM meets the 30 fps / 33.3 ms gate at both display refresh rates. §9.3
records why the *magnitude* of the gap should not be quoted as a single number.

**What this table cannot settle.** LAM and UIKA differ in at least three ways at once: the
Gaussian count (6.67x), the sort arrangement (LAM runs the D-shaped GPU-distance + readback
path with integer centres; UIKA C runs canonical centres with no readback), and the asset
itself. If UIKA C lands outside LAM's envelope, this table does **not** say the cause is
runtime scheduling. Isolating that would be the next gate, not a conclusion of this one.

---

## 7. Verdict rule, fixed before the measurement

The comparison is made against the **combined repeat spread** of the two runs, never
against a bare difference: a gap smaller than the measurements' own run-to-run spread is
not a gap.

```
gap            = UIKA C p95 − LAM p95
combinedSpread = LAM p95 spread + UIKA C p95 spread

gap > combinedSpread                      -> UIKA_RUNTIME_BEHIND_LAM
gap <= combinedSpread and UIKA C >= 30 fps -> UIKA_WITHIN_LAM_RUNTIME_ENVELOPE
otherwise                                  -> UNRESOLVED
```

The verdict is refused outright — `UNRESOLVED`, with the reason named — when LAM was
measured fewer than 3 times, when any LAM repeat carried fewer than 30 measured intervals,
or when the renderer is a software rasteriser.

`UIKA_WITHIN_LAM_RUNTIME_ENVELOPE` makes the 33.3 ms absolute gate a **candidate** for
redefinition against LAM's real operating values. It does not redefine it. Nothing in this
gate changes that threshold.

---

## 8. Not done

No production integration, no Live Gate 5, no canonical-sort adoption, no change to the
33.3 ms gate, no Gaussian reduction, no basis reduction, no LOD, no integer-sort migration.
The Gate 4B-2C result is frozen, and UIKA C's visual verdict stays
`REQUIRES_HUMAN_INSPECTION`.

---

## 9. Results

### 9.1 Container self-test (SwiftShader)

Correctness of the instrumentation only. ANGLE + SwiftShader renders this avatar at
roughly 1 fps, so **no timing number from this container is evidence**.

What it established:

* every hook installed — `notInstrumented` is empty, including `sortWorker.onmessage`,
  which needs the readiness wait described below;
* the subject reads back as expected: `/avatar/meruru.zip`, 20,018 splats, drawing buffer
  879 x 879 at renderer pixel ratio 1, `renderMode` 0, `gpuAcceleratedSort` true,
  `integerBasedSort` true, `sharedMemoryForWorkers` false, precision 16, one
  `renderer.render()` per frame;
* the expression path runs: the fixture is selected from the `AudioContext` clock and read
  back through `getExpressionData`;
* the verdict rule refuses correctly — `UNRESOLVED`, "LAM was measured 1 time(s); 3 repeats
  are required".

It also put a number on the §5 caveat. Over two repeats the driver's last push landed
**0.2–0.3 ms (p50)** before the renderer's read, with a maximum of 13.9–17.1 ms. At that
spacing a `renderLag` of 0 is trivially true and carries no information about the runtime.
On a real GPU the LAM loop runs near 45 Hz while the fixture advances at 30 Hz, so the
pusher will frequently *not* have run immediately before the read and the lag number
becomes informative — but it must still be read next to `msSinceLastPush`, never alone.

Two harness defects it found. First: `GaussianSplatRenderer.getInstance()` resolves **before**
`addSplatScene()` completes, and the splat mesh and the sort worker are created inside that
scene add. Hooking immediately after mount reported `sortWorker.onmessage` as "not
instrumented" when the truth was only that the harness was early. A bounded readiness wait
now blocks until every hooked object exists and names whichever one is missing if it times
out. Second, the two `renderLag` defects described in §5, both of which would have produced
a confident zero on the real GPU.

### 9.2 Real GPU

ANGLE (AMD, AMD Radeon(TM) 860M Graphics (0x00001114) Direct3D11 vs_5_0 ps_5_0, D3D11),
Chrome, `devicePixelRatio` 1.5, container 586 x 586 CSS → **drawing buffer 879 x 879**, the
same rasterised sample count UIKA Gate 4B-2C was measured at. Three repeats of 12 s.
Run 2026-10-16T05:28:38Z.

Clean throughout: GL errors 0, page errors 0, visibility never lost, invalid GPU timer
samples 0 / 0 / 1, `notInstrumented` empty, 1,438–1,439 measured intervals per repeat.

| repeat | FPS | frames | wall p50 | p90 | p95 | p99 | max | GPU draw p50 | sort sub / comp | sort Hz |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 119.99 | 1440 | 8.30 | 9.00 | 9.20 | 18.10 | 19.90 | 4.13 | 1440 / 288 | 24.00 |
| 2 | 119.91 | 1439 | 8.30 | 9.20 | 9.80 | 14.70 | 20.60 | 4.20 | 1439 / 303 | 25.25 |
| 3 | 119.99 | 1440 | 8.30 | 9.00 | 9.20 | 9.50 | 13.40 | 4.17 | 1440 / 473 | 39.41 |

Stages (p50 / p95 ms): sort submission 0.00 / 0.10–0.20, worker sort 0.10–0.20 / 0.30,
render-index update 0.00 / 0.00–0.10. One `renderer.render()` per frame on this avatar.

**LAM is vsync-locked.** 1,440 frames in 12,001 ms is 120.0 fps, and the wall p50 of 8.30 ms
is 1/120 s. The display runs at 120 Hz and LAM meets it on every frame. UIKA, at 42.88 fps
on the same display, is missing roughly two of every three refreshes.

#### Where the difference actually is

> **Corrected after the second run (§9.3).** This section first presented a "wall p50 minus
> GPU draw p50" decomposition and read the ~4 ms left over as a non-draw overhead that was
> the same in all three runs. That reading was wrong. LAM is vsync-locked — its wall p50 is
> exactly one refresh period at both refresh rates measured — so for LAM that remainder is
> mostly **waiting for the next vsync**, not work. Comparing it against UIKA's remainder,
> whose composition is unknown and whose display state was not recorded, was not a
> like-for-like decomposition, and the conclusion drawn from it ("there is no median-level
> scheduling deficit to find") was not supported. The corrected reading is below.

**LAM is vsync-locked, at whatever the display is doing.**

| | display | wall p50 | one refresh period | GPU draw p50 |
| --- | --- | ---: | ---: | ---: |
| LAM, §9.2 run | 120 Hz | 8.30 | 8.33 | 4.17 |
| LAM, §9.3 run | 60 Hz | 16.67 | 16.67 | 7.16 |

In both runs LAM lands on exactly one refresh period, with the GPU draw taking roughly half
of it. Its frame time is set by the display, not by its own work.

UIKA's two runs were measured in an earlier session whose refresh rate was not recorded, so
UIKA's wall p50 of 24.27 / 24.37 ms **cannot** be decomposed the same way here. What can be
said is that UIKA C's GPU draw p50 of 20.49 ms puts a 48.8 fps ceiling on it before anything
else is counted, and it measured 42.88 fps.

**The difference that survives both runs is a tail LAM does not have.**

| | p95 − p50 |
| --- | ---: |
| LAM, §9.2 run (120 Hz) | **1.10** |
| LAM, §9.3 run (60 Hz) | **2.37** |
| UIKA A no-sort | **21.70** |
| UIKA C | **22.53** |

LAM's frame time barely moves — 1.1 ms between its median and its 95th percentile at
120 Hz, 2.4 ms at 60 Hz, with a run-to-run p95 spread of 0.60 / 0.40 ms. UIKA's p95 sits
22 ms above its own median, and that is true of the run that does **no sorting at all**.
Whatever produces it is present in UIKA with the sort removed, and absent from LAM.

This is the finding that depends on neither the display state, nor the decomposition above,
nor the absolute magnitudes questioned in §9.3: a frame-time distribution with a 22 ms tail
against one with a 1–2 ms tail. Each comparison is of a run against **itself**.

#### Sort behaviour (§5)

LAM requests a sort on every frame — 1,440 submissions — and completes 288 / 303 / 473 of
them, because the one-sort-in-flight rule drops the rest. Effective sort rate 24.0 / 25.3 /
39.4 Hz at 20,018 splats through the GPU-distance + fence + readback path. Gate 4B-2C
measured the same arrangement (variant D) at **7.45 Hz** with 133,541 splats.

#### Expression (§6, §7)

| | r1 | r2 | r3 |
| --- | ---: | ---: | ---: |
| expression reads | 1440 | 1439 | 1440 |
| frames selected by the clock | 368 | 368 | 368 |
| distinct frames rendered | **192 / 192** | **192 / 192** | **192 / 192** |
| same expression held | 1079 | 1078 | 1079 |
| **expression frame skips** | **0** | **0** | **0** |
| max frame jump | 1 | 1 | 1 |
| render lag p50 / p95 / max (frames) | 0 / 1 / 1 | 0 / 1 / 1 | 0 / 1 / 1 |
| ms since last push p50 / p95 | 18.10 / 39.90 | 18.50 / 40.00 | 19.20 / 40.10 |

This is the reference behaviour the project set out to find. LAM renders every one of the
192 fixture frames, **skips none**, never jumps more than one frame, and holds each 30 fps
expression across about 3.9 render frames (1440 reads / 368 selections).

The render lag is now a real measurement rather than a tautology: the driver's last push
was a median of 18.1–19.2 ms before the read (p95 ~40 ms), and the expression the renderer
took was still within one fixture frame of what the clock was asking for. At 30 fps one
frame is 33.3 ms, so LAM's expression pipeline is holding the audio clock to within one
frame while rendering at four times the expression rate.

### 9.3 Real GPU, second run — same verdict, and a caveat that limits every magnitude

Run 2026-10-16T10:45:55Z, same machine, same avatar, same 879 x 879 drawing buffer, three
repeats of 12 s, again clean: GL errors 0, page errors 0, visibility never lost, 719–720
intervals per repeat, nothing un-instrumented. Confirmed a distinct run rather than a
re-export: the report hashes differ and the timestamps are five hours apart.

**The display was at 60 Hz this time, and LAM locked to it exactly.**

| repeat | FPS | frames | wall p50 | p90 | p95 | p99 | max | GPU draw p50 | sort sub / comp | sort Hz |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 60.00 | 720 | 16.70 | 18.40 | 19.30 | 21.50 | 35.80 | 7.02 | 720 / 240 | 20.00 |
| 2 | 60.05 | 721 | 16.70 | 18.30 | 18.90 | 20.30 | 35.00 | 7.29 | 721 / 241 | 20.07 |
| 3 | 60.03 | 721 | 16.60 | 18.30 | 18.90 | 20.30 | 27.70 | 7.16 | 721 / 241 | 20.06 |

Means: **60.02 fps, wall p50 16.67 ms, p95 19.03 ms (spread 0.40), GPU draw p50 7.16 ms.**
Verdict unchanged — **`UIKA_RUNTIME_BEHIND_LAM`**, gap 27.87 ms against a combined repeat
spread of 6.60 ms. LAM still meets the 30 fps / 33.3 ms gate, with its p95 at 57 % of it.

Expression behaviour is unchanged and still the reference: **192 / 192** fixture frames
rendered in every repeat, **0 skips**, max jump 1, render lag p50 0 / p95 1 / max 1 frame,
with the driver's last push a median 14.8–25.3 ms before the read. Each 30 fps expression is
now held across about 2.0 render frames (721 reads / 367 selections) instead of 3.9 — exactly
what halving the render rate should do.

#### The caveat: this machine's GPU throughput is not stable between sessions

**The same avatar, the same buffer and the same machine measured a GPU draw p50 of 4.17 ms
in §9.2 and 7.16 ms here — a factor of 1.72 on identical work.** The worker sort moved the
same way (0.1–0.2 ms → 0.3–0.4 ms). No cause is asserted: the harness records GPU timings,
not clock or power state.

The consequence is methodological and it applies to everything above:

* The UIKA rows come from the **Gate 4B-2C session**, hours earlier, with the machine in an
  unknown state. Comparing LAM's milliseconds against UIKA's across sessions is therefore
  unreliable **in magnitude**.
* The **verdict survives both LAM states** — 37.50 ms against a 6.80 ms spread in one run,
  27.87 ms against 6.60 ms in the other — so "UIKA C is outside LAM's runtime envelope"
  stands. The *size* of the gap does not have a single trustworthy value.
* The shape-based findings survive too, because each compares a run against **itself**:
  LAM's p95 − p50 of 1.1–2.4 ms against UIKA's 21.7–22.5 ms, and LAM's zero expression
  skips.

To put a reliable magnitude on the gap, UIKA and LAM must be measured **in the same
session**. That is a measurement-method point, not a decision, and this gate does not act
on it.

#### What this does and does not establish

It establishes that the 33.3 ms gate is achievable on this hardware, that LAM achieves it
with large margin, and that UIKA C is outside LAM's runtime envelope by far more than
measurement noise.

It does **not** identify the cause. LAM and UIKA differ in Gaussian count (6.67x), in sort
arrangement (LAM runs the GPU-distance + readback path with integer centres; UIKA C runs
canonical centres with no readback), and in the asset itself. One further condition
difference is recorded here rather than smoothed over: LAM ran at `devicePixelRatio` 1.5
with a 586 CSS container, UIKA at 1.0 with an 879 CSS container. The drawing buffer is
879 x 879 in both cases, but LAM's device pixel ratio also feeds its splat scale maths, so
the two are matched on rasterised sample count and not on every rendering condition.

The one thing the numbers do localise is **which part** of UIKA's frame to look at next:
not the median, which its draw explains, but the 22 ms tail above its own median that
survives with the sort switched off entirely.
