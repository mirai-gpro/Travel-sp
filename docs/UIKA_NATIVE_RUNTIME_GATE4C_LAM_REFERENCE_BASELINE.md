# UIKA Native Runtime v1.1 — Gate 4C: LAM reference baseline benchmark

| field | value |
| --- | --- |
| route | `/uika-native-lam-baseline` (new; every earlier route untouched) |
| subject | the **production** LAM avatar, mounted through the unmodified `LAMWebSocketManager` |
| nature | **instrumentation only** |
| status | harness complete and self-tested on the container; awaiting the real-GPU run |

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

| | FPS | wall p50 | wall p95 | p95 spread | GPU draw p50 | splats |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| LAM reference (production path) | _pending_ | | | | | 20,018 |
| UIKA A no-sort | 43.72 | 24.27 | 45.97 | 5.80 | 19.92 | 133,541 |
| UIKA C canonical + LAM Worker/WASM | 42.88 | 24.37 | 46.90 | 6.20 | 20.49 | 133,541 |

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

_pending_
