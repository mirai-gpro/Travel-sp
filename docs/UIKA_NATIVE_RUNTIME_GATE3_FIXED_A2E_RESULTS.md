# UIKA Native Runtime — Gate 3 Fixed Real-A2E Replay Results

**Date:** 2026-10-14
**Spec:** `docs/UIKA_NATIVE_RUNTIME_ARCHITECTURE_CORRECTION_v1.1.md`
**Branch:** `poc/uika-native-runtime-v1`
**Start HEAD:** `95b1af777163022c22dbc44e3ef349d12b69b2e5`
**Implementation commits:** `3fe4c0b` (replay wiring), `09ba2e4` (fixture intake + contract)
**Page:** `/uika-native-replay`

```text
GATE3_IMPLEMENTATION        = COMPLETE
GATE3_CLOCK_LOGIC           = PASS
GATE3_MAPPING_CONTRACT      = PASS
GATE3_RENDERER_LIFECYCLE    = PASS
GATE3_NO_SILENT_FALLBACK    = PASS
GATE3_FIXTURE_CONTRACT      = IMPLEMENTED (v1.1 Gate 3 §1), rejection paths verified
GATE3_FIXTURE_EXPECTATIONS  = RECORDED (sender's SHA-256 and statistics, §2-§5)
GATE3_FIXTURE_INTAKE        = READY (drop the JSON in, no code change needed)

GATE3_FIXED_REAL_A2E        = BLOCKED — the fixture file itself has still not arrived
```

**Gate 3 is not claimed as PASS.** Everything that does not depend on real A2E content is
implemented and verified; the replay itself has never been run, because the fixture it
requires does not exist anywhere this session can reach.

---

## 1. Why it is blocked

v1.1 Gate 3 §4 requires the existing real A2E capture fixture and forbids creating new
artificial expression data or a new A2E generator.

That fixture is not a file in the repository. `src/scripts/chat/a2e-replay.ts` stores and
reads it from browser storage only:

```js
const STORAGE_KEY = 'a2eCapture.v1';                       // a2e-replay.ts:25
window.localStorage.setItem(STORAGE_KEY, JSON.stringify(capture));   // :113
raw = window.localStorage.getItem(STORAGE_KEY);                      // :173
```

It is written by `captureLiveExpression(data)`, which is called from
`core-controller.ts:360` while a **real Gemini Live turn** is streaming `live_expression`
from the backend.

Searched and confirmed absent from the repository:

```text
grep for a2eCapture / expression_names in *.json, *.ts, *.js, *.md  -> only source and docs
find for fixture / fixtures / testdata directories                 -> none
find for *.json larger than 50 KB outside node_modules             -> only package-lock.json
```

This container cannot produce one either: Gate 3 §3 forbids using real communication at
all, the backend CORS allowlist does not include a local origin, and there is no Gemini
credential here. Fabricating 52-channel values would violate §4, so none was fabricated.

### What unblocks it

One real capture, taken once by a human:

1. open the normal Travel-sp chat with `?a2eCapture=1`,
2. speak once so a full A2E turn streams (the HUD shows `A2E CAPTURE frames=…`),
3. in the console run `copy(__a2eCaptureJson())`,
4. save it as `src/scripts/chat/uika-native/fixtures/a2e-real-capture-gate3.json`.

Anything committed in that directory is bundled automatically, so no code change is
needed when it lands. The page also accepts the same JSON pasted into its textarea,
fetched from `?fixture=<url>`, or read from `localStorage` when the capture was taken in
the same browser profile.

### Attempt 2 — 2026-10-14, execution instruction received, file still absent

An execution instruction was issued stating the fixture had been received, and giving its
name, SHA-256 (`54f581ac…e24b`), byte count (214,357) and measured statistics. **The file
itself was not attached and is not reachable from this session.** Searched before doing
anything else:

```text
find / -name 'a2e-real-capture-gate3*'                            0 hits
working tree src/scripts/chat/uika-native/fixtures/               README.md only
every remote branch of mirai-gpro/travel-sp                       0 hits
any 200-300 KB *.json modified in the last 12 h                   0 hits
```

v1.1 Gate 3 §2 says the saved copy's SHA-256 must be recomputed and must match, otherwise
Gate 3 does not run. There is nothing to save and nothing to hash, and reconstructing the
frames from the quoted statistics would be exactly the synthetic data §4 forbids. Gate 3
therefore remains BLOCKED.

What was done instead: the quoted measurements were recorded as the acceptance criteria
(see below), so that when the file does arrive it is checked against **its own
fingerprint**, not merely against the generic contract.

### Expected values are now recorded (§2-§5)

`src/scripts/chat/uika-native/fixtures/a2e-real-capture-gate3.expected.json` holds the
sender's measurements — the file's fingerprint and summary statistics only, no expression
data:

```text
sha256 54f581aca7c5994cf4a818f71e7673a1bd689767097ab5b692e5dad65be2e24b
bytes  214357
fps 30 / frames 192 / channels 52 / chunks 6 / duration 6.4 s
chunk frame counts [6, 26, 64, 34, 36, 26], sum 192, perfMs monotonic
global min 0.0 / global max 0.9002304077148438 / NaN 0 / Inf 0
tongueOut index 51, non-zero in 192/192 frames, max abs 0.0014989759 (kept, not zeroed)
jawOpen max 0.3598918318748474            mouthPucker max 0.30823880434036255
mouthStretchLeft  max 0.3514883816242218  eyeBlinkLeft  max 0.886151909828186
mouthStretchRight max 0.3514883816242218  eyeBlinkRight max 0.886151909828186
mouthFunnel max 0.08393868803977966
```

Both the offline validator (`--expect`) and the browser path check these. The point is
transit damage: a prettified or rounded copy still satisfies the structural contract but
fails its own SHA-256 and byte count. Verified by running `--expect` against a
structurally valid but wrong-content stand-in — the nine structural checks passed while
sha256, bytes, frame count, duration, chunk layout, global max, tongueOut statistics and
all seven channel maxima failed, and the tool exited non-zero.

The `*.expected.json` file is excluded from the fixture glob, confirmed in the browser
(`bundledFixtures: []` with the expectations file present).

### Intake is implemented and verified

The acceptance side is in place and was exercised against deliberately broken inputs:

* `validateGate3Fixture()` / `validateGate3Mapping()` in
  `src/scripts/chat/uika-native/uika-native-replay.ts` implement the v1.1 Gate 3 §1
  contract check by check, and a fixture that fails any check is not adopted — Gate 3
  does not run on it.
* `mappedCount` is measured by mapping one real frame, not assumed.
* `tools/validate_a2e_fixture.mjs` runs the same contract offline and prints the
  provenance block, including the SHA-256 that §3 designates as the Source of Truth.
* Six malformed inputs (`fps = 0`, 51 names, zero frames, a wrong-width frame, a
  non-array frame, non-numeric values) were each rejected with the failing check named,
  and the tool exits non-zero with `FIXTURE CONTRACT: FAIL — Gate 3 must not run`.
* In the browser with nothing bundled: `bundledFixtures = []`, the bundled button is
  disabled, every loader fails with an explicit message, `start replay` stays disabled,
  `weightUploadCount` stays 0, and the renderer stays healthy
  (`splatCount 133541`, `basisResident true`, `glErrorCount 0`, OAC-free all false,
  page errors 0).

Nothing is substituted for the missing data.

---

## 2. What was implemented

```text
captured real A2E (localStorage / URL / pasted JSON)
        │
        ▼  time-based clock, no frame accumulation
UikaNativeReplay.tick()
        │
        ▼  existing src/scripts/chat/uika-native/uika-expression-mapper.ts
52 names + 52 values  ->  production JP mouth processing  ->  Float32Array(51)
        │
        ▼  only when the frame index actually changed
UikaNativeRuntime.applyWeights()  ->  SplatMesh.setUikaWeights()
        │
        ▼
UIKA Native GPU renderer (133,541 Gaussians, D_UIKA GPU-resident)
```

Files:

| file | change |
| --- | --- |
| `src/scripts/chat/uika-native/uika-native-replay.ts` | new — the replay controller and its diagnostics |
| `src/pages/uika-native-replay.astro` | new — isolated PoC route |
| `src/scripts/chat/uika-native/uika-native-runtime.ts` | per-frame expression-source hook, `applyWeights`, render-interval statistics |
| `src/scripts/chat/uika-native/fixtures/README.md` | new — where the capture goes, and what must not be done to it |
| `tools/validate_a2e_fixture.mjs` | new — offline Gate 3 §1 contract check and SHA-256 provenance |

`src/scripts/chat/a2e-replay.ts` is **unchanged**; the controller imports
`loadCapturedA2E` from it. No separate Gate 3 mapping exists — the production mapper is
the only path.

---

## 3. Clock logic — PASS

The frame is always derived from the clock:

```ts
const elapsed   = performance.now() - this.start;
const loop      = Math.floor(elapsed / this.periodMs);
const t         = elapsed - loop * this.periodMs;
const requested = Math.floor((t / 1000) * this.data.fps);
const selected  = inGap ? -1 : Math.min(total - 1, requested);
```

Verified under a mocked clock, with the real production mapper and a stubbed GPU sink:

```text
PASS  t=+0ms    -> frame 0
PASS  t=+33ms   -> frame 0
PASS  t=+34ms   -> frame 1
PASS  t=+500ms  -> frame 15
PASS  1000ms stall catches up to frame 45 (not 16)
PASS  stall maps exactly one frame
PASS  skipped A2E frames counted (cumulative 13+29 = 42)
PASS  max frame jump recorded (30)
PASS  no upload while the frame is unchanged
PASS  duplicate renders counted
PASS  t=3100ms is the loop gap -> -1
PASS  gap flag set
PASS  loop 1 at +100ms -> frame 3
PASS  loop index advanced
PASS  applyWeights calls == weightUploadCount
```

**This is a clock test, not an A2E result.** Every expression value in it is `0.0` — the
same neutral pose the replay plays in its own loop gap — nothing was rendered, and no
claim about A2E behaviour is made. It asserts frame selection against the clock,
duplicate suppression, skip counting and loop handling, nothing else.

The key property for v1.1 §6 is the fifth line: after a 1000 ms stall the replay jumps to
the frame the clock points at (45) and maps exactly one frame, instead of advancing a
counter to 16 and drifting.

---

## 4. 52 → 51 mapping contract — PASS

Resolved in the browser against the asset's own basis names:

```json
{ "arkitCount": 52, "basisCount": 51,
  "dropped": ["tongueOut"], "missingFromInput": [] }
```

Exactly one channel is dropped, `tongueOut`, as v1.1 §3.2 requires, and every one of the
51 UIKA basis channels is present in the ARKit input. The controller records the same
resolution per fixture (`droppedNames`, `missingBasisNames`) from the fixture's own
`expression_names`, so a capture with a different name list is reported rather than
silently mismatched.

---

## 5. Renderer lifecycle — PASS

On `/uika-native-replay`, with the renderer running and no fixture loaded:

```json
{ "ready": true, "phase": "neutral-ready",
  "gaussianCount": 133541, "viewerSplatCount": 133541,
  "basisCount": 51, "basisResident": true,
  "renderedFrames": 23, "glErrorCount": 0, "errors": [] }
```

```json
"oacFreeCheck": { "flameModel": false, "skeleton": false, "bonesMatrix": false,
  "bonesWeight": false, "morphTargetDictionary": false, "boneTextureUniform": false,
  "boneWeightTextureUniform": false, "headBoneIndexUniform": false,
  "flameModelTextureUniform": false, "avatarMeshOnViewer": false, "splatTree": false }
```

The replay path contains no `new Viewer`, no `dispose`, no PLY rewrite, no `Blob`, no
`addSplatScene` and no basis-texture rebuild; the only per-frame write is
`setUikaWeights(Float32Array(51))`. Page errors: 0. Console errors: 1, a `favicon.ico`
404 from the static test server.

---

## 6. No silent fallback — PASS

With `localStorage['a2eCapture.v1']` cleared, loading the fixture throws and the page
reports it verbatim:

```text
UIKA Native Replay: no captured A2E found in localStorage (key "a2eCapture.v1").
Record one first with ?a2eCapture=1 on a page that runs a real Live turn.
No synthetic expression data is generated as a substitute.
```

`start replay` stays disabled, `weightUploadCount` stays 0, and the avatar keeps its
canonical pose. Nothing is invented to fill the gap.

---

## 7. Not measured

These need the fixture and are therefore absent, not estimated:

```text
fixture SHA-256 / provenance / frame count / duration / expression rate
replayed expression progression on real data
duplicate and skipped expression frames on real data
weight upload count and timing on real data
visual result (jawOpen continuity, mouth stretch, smile sidedness, neutral return,
               no Gaussian smearing, no depth-order breakdown)
```

Render timing is also not reported as a result: this machine renders through
ANGLE + SwiftShader with no GPU, where a frame costs seconds. Per v1.1 Gate 3 §15 that
environment is usable for logic, GL-error and consistency checks only, which is what
sections 3–6 use it for.

---

## 8. Normal LAM regression — PASS

Blob SHA against baseline `e86f066`:

```text
SAME  src/components/LAMAvatar.astro
SAME  src/scripts/chat/lam-websocket-manager.ts
SAME  src/scripts/chat/live-audio-manager.ts
SAME  src/scripts/chat/uika-133k-mode.ts
SAME  src/scripts/chat/a2e-replay.ts
SAME  package.json
SAME  package-lock.json
support-base/**  : no diff
```

`node_modules/gaussian-splat-renderer-for-lam` untouched. `tsc --noEmit` reports the same
9 pre-existing errors; none in any file added or changed here.

`uika-render-adapter.ts` and `uika-native-driver.ts` are retained unchanged and unrenamed,
per the instruction to keep them until Gate 5.

---

## 9. STOP conditions (v1.1 Gate 3 §19)

```text
fixed real A2E で GPU/CPU deformation 不一致   NOT REACHED (no fixture)
renderer の再生成が必要                        NO
LAM skeleton が必要                            NO
flameModel が必要                              NO
animation.glb が必要                           NO
backend / A2E 変更が必要                       NO
LiveAudioManager 変更が必要                    NO
通常 LAM 変更が必要                            NO
```

No STOP condition in §19 was hit. The blocker is an absent input, not a design problem,
and no workaround was built for it.
