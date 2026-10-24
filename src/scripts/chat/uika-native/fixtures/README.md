# UIKA Native Gate 3 — real A2E fixture

Drop the captured file here as:

```
a2e-real-capture-gate3.json
```

Any `*.json` in this directory is picked up automatically at build time
(`import.meta.glob`), so no code change is needed when the file lands. The page
`/uika-native-replay` then offers it as **load fixture: bundled**.

## How to produce it

1. Open the normal Travel-sp chat with `?a2eCapture=1`.
2. Speak once so a full A2E turn streams. The HUD shows `A2E CAPTURE frames=…`.
3. In the browser console run `copy(__a2eCaptureJson())`.
4. Save the clipboard to `a2e-real-capture-gate3.json` in this directory.

## What must not be done to it

The file is stored byte-for-byte as captured. Per v1.1 Gate 3 §2:

* values are not changed,
* no smoothing,
* no interpolation,
* no frame decimation,
* no chunk restructuring.

`fps`, `expression_names`, `frames`, `chunks` and `capturedAt` are kept exactly as
`captureLiveExpression()` wrote them.

## Contract checked before Gate 3 runs

```text
fps > 0
expression_names.length == 52
frames.length > 0
every frame is an Array
every frame length == 52
every value finite      (NaN == 0, Inf == 0)

basisCount  == 51
mappedCount == 51
dropped     == ["tongueOut"]
missing     == []
```

If any check fails, Gate 3 does not run.

## Offline check

```
node tools/validate_a2e_fixture.mjs src/scripts/chat/uika-native/fixtures/a2e-real-capture-gate3.json
```

prints the same checks plus the SHA-256 that the results document records as the
fixture's Source of Truth.
