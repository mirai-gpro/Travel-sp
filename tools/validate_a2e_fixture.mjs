#!/usr/bin/env node
// UIKA Native Runtime v1.1 — Gate 3 §1 fixture validator (offline).
//
// Checks a captured real A2E JSON against the Gate 3 contract and prints its SHA-256.
// It reads the file and reports; it never writes, smooths, interpolates, decimates or
// restructures anything.
//
//   node tools/validate_a2e_fixture.mjs <capture.json> [basis-names.json] [--expect <expected.json>]
//
// The optional basis-names argument is a JSON array of the 51 UIKA basis names. Without it
// the mapping half of the contract is reported as NOT CHECKED, because the basis names are
// a property of the avatar asset, not of this script.
//
// --expect checks the file against the values the sender measured (SHA-256, byte count,
// frame and chunk structure, global range, per-channel maxima). That is what catches
// transit damage: a prettified or rounded copy still satisfies the structural contract but
// fails its own fingerprint.

import fs from 'node:fs';
import crypto from 'node:crypto';

const EXPECTED_INPUT_CHANNELS = 52;
const EXPECTED_BASIS_CHANNELS = 51;
const EXPECTED_DROPPED = ['tongueOut'];

const argv = process.argv.slice(2);
let expectPath = null;
const expectAt = argv.indexOf('--expect');
if (expectAt >= 0) {
    expectPath = argv[expectAt + 1];
    argv.splice(expectAt, 2);
}
const path = argv[0];
if (!path) {
    console.error('usage: node tools/validate_a2e_fixture.mjs <capture.json> [basis-names.json] [--expect <expected.json>]');
    process.exit(2);
}

const bytes = fs.readFileSync(path);
const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');

let data;
try {
    data = JSON.parse(bytes.toString('utf8'));
} catch (error) {
    console.error(`FAIL  not valid JSON: ${error.message}`);
    console.error(`sha256 ${sha256}`);
    process.exit(1);
}

const checks = [];
const add = (name, pass, detail) => checks.push({ name, pass, detail });

add('is an object', !!data && typeof data === 'object', `typeof ${typeof data}`);
add('fps > 0', typeof data.fps === 'number' && data.fps > 0, `fps=${data.fps}`);

const names = Array.isArray(data.expression_names) ? data.expression_names : null;
add(`expression_names.length == ${EXPECTED_INPUT_CHANNELS}`,
    names?.length === EXPECTED_INPUT_CHANNELS, `length=${names ? names.length : 'not an array'}`);

const frames = Array.isArray(data.frames) ? data.frames : null;
add('frames.length > 0', !!frames && frames.length > 0,
    `length=${frames ? frames.length : 'not an array'}`);

let nonArray = 0, wrongWidth = 0, nan = 0, inf = 0, nonNumeric = 0;
if (frames) {
    for (const f of frames) {
        if (!Array.isArray(f)) { nonArray++; continue; }
        if (f.length !== EXPECTED_INPUT_CHANNELS) wrongWidth++;
        for (const v of f) {
            if (typeof v !== 'number') { nonNumeric++; continue; }
            if (Number.isNaN(v)) nan++;
            else if (!Number.isFinite(v)) inf++;
        }
    }
}
add('every frame is an Array', nonArray === 0, `non-array frames=${nonArray}`);
add(`every frame length == ${EXPECTED_INPUT_CHANNELS}`, wrongWidth === 0, `wrong-width frames=${wrongWidth}`);
add('NaN == 0', nan === 0, `NaN values=${nan}`);
add('Inf == 0', inf === 0, `Inf values=${inf}`);
add('every value finite', nan === 0 && inf === 0 && nonNumeric === 0,
    `NaN=${nan} Inf=${inf} non-numeric=${nonNumeric}`);

const basisPath = argv[1];
let mappingChecked = false;
if (basisPath && names) {
    const basis = JSON.parse(fs.readFileSync(basisPath, 'utf8'));
    const basisSet = new Set(basis);
    const inputSet = new Set(names);
    const dropped = names.filter((n) => !basisSet.has(n));
    const missing = basis.filter((n) => !inputSet.has(n));
    add(`basisCount == ${EXPECTED_BASIS_CHANNELS}`, basis.length === EXPECTED_BASIS_CHANNELS,
        `basisCount=${basis.length}`);
    add(`dropped == ${JSON.stringify(EXPECTED_DROPPED)}`,
        JSON.stringify(dropped) === JSON.stringify(EXPECTED_DROPPED), `dropped=${JSON.stringify(dropped)}`);
    add('basis missing == []', missing.length === 0, `missing=${JSON.stringify(missing)}`);
    mappingChecked = true;
}

// ---- expected-value checks (v1.1 Gate 3 §2-§5) ------------------------------
let expectChecked = false;
if (expectPath) {
    expectChecked = true;
    const exp = JSON.parse(fs.readFileSync(expectPath, 'utf8'));
    const near = (a, b, tol) => typeof a === 'number' && Math.abs(a - b) <= tol;

    add('sha256 matches the received original', sha256 === exp.sha256,
        `got ${sha256}`);
    add('byte count matches', bytes.length === exp.bytes, `got ${bytes.length}, expected ${exp.bytes}`);
    add(`fps == ${exp.fps}`, data.fps === exp.fps, `fps=${data.fps}`);
    add(`frames == ${exp.frameCount}`, frames?.length === exp.frameCount,
        `frames=${frames ? frames.length : 'n/a'}`);
    add(`channels == ${exp.expressionNameCount}`, names?.length === exp.expressionNameCount,
        `channels=${names ? names.length : 'n/a'}`);

    const duration = frames && data.fps ? frames.length / data.fps : NaN;
    add(`duration == ${exp.durationSeconds}s`, near(duration, exp.durationSeconds, 1e-9),
        `duration=${duration}`);

    const chunks = Array.isArray(data.chunks) ? data.chunks : [];
    add(`chunks == ${exp.chunkCount}`, chunks.length === exp.chunkCount, `chunks=${chunks.length}`);
    const chunkCounts = chunks.map((c) => c.frames);
    add(`chunk frame counts == ${JSON.stringify(exp.chunkFrameCounts)}`,
        JSON.stringify(chunkCounts) === JSON.stringify(exp.chunkFrameCounts),
        `got ${JSON.stringify(chunkCounts)}`);
    const chunkSum = chunkCounts.reduce((a, b) => a + (b || 0), 0);
    add(`chunk frame sum == ${exp.chunkFrameCountSum}`, chunkSum === exp.chunkFrameCountSum,
        `sum=${chunkSum}`);
    let monotonic = true;
    for (let i = 1; i < chunks.length; i++) {
        if (!(chunks[i].perfMs >= chunks[i - 1].perfMs)) monotonic = false;
    }
    add('chunks[].perfMs is monotonic', chunks.length > 0 && monotonic === exp.chunkPerfMsMonotonic,
        `monotonic=${monotonic}`);

    let gMin = Infinity, gMax = -Infinity;
    if (frames) for (const f of frames) for (const v of f) {
        if (typeof v === 'number') { if (v < gMin) gMin = v; if (v > gMax) gMax = v; }
    }
    add(`global min == ${exp.globalMin}`, near(gMin, exp.globalMin, 1e-12), `min=${gMin}`);
    add(`global max == ${exp.globalMax}`, near(gMax, exp.globalMax, 1e-12), `max=${gMax}`);

    if (names && frames) {
        const idxOf = (n) => names.indexOf(n);
        const t = exp.tongueOut;
        add(`tongueOut index == ${t.index}`, idxOf('tongueOut') === t.index,
            `index=${idxOf('tongueOut')}`);
        const ti = idxOf('tongueOut');
        if (ti >= 0) {
            let nz = 0, mx = 0;
            for (const f of frames) { const v = Math.abs(f[ti]); if (v !== 0) nz++; if (v > mx) mx = v; }
            add(`tongueOut non-zero frames == ${t.nonZeroFrames}/${t.totalFrames}`,
                nz === t.nonZeroFrames && frames.length === t.totalFrames, `nonzero=${nz}/${frames.length}`);
            add(`tongueOut max abs ~= ${t.maxAbs}`, near(mx, t.maxAbs, t.maxAbsTolerance ?? 1e-9),
                `maxAbs=${mx}`);
        }
        for (const [channel, want] of Object.entries(exp.channelMax || {})) {
            const i = idxOf(channel);
            if (i < 0) { add(`${channel} present`, false, 'channel not in expression_names'); continue; }
            let mx = -Infinity;
            for (const f of frames) if (f[i] > mx) mx = f[i];
            add(`${channel} max == ${want}`, near(mx, want, 1e-12), `max=${mx}`);
        }
        for (const [channel, want] of Object.entries(exp.channelMin || {})) {
            const i = idxOf(channel);
            if (i < 0) { add(`${channel} present`, false, 'channel not in expression_names'); continue; }
            let mn = Infinity;
            for (const f of frames) if (f[i] < mn) mn = f[i];
            add(`${channel} min == ${want}`, near(mn, want, 1e-12), `min=${mn}`);
        }
    }
}

for (const c of checks) {
    console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}  (${c.detail})`);
}
if (!expectChecked) {
    console.log('----  expected values NOT CHECKED (pass --expect <expected.json>)');
}
if (!mappingChecked) {
    console.log('----  mapping contract NOT CHECKED (pass the 51 basis names as argv[2])');
}

console.log('');
console.log('provenance');
console.log(`  source                 live_expression capture`);
console.log(`  capture implementation a2eCapture.v1 (src/scripts/chat/a2e-replay.ts)`);
console.log(`  file                   ${path}`);
console.log(`  bytes                  ${bytes.length}`);
console.log(`  sha256                 ${sha256}`);
console.log(`  fps                    ${data.fps}`);
console.log(`  frame count            ${frames ? frames.length : 'n/a'}`);
console.log(`  channel count          ${names ? names.length : 'n/a'}`);
console.log(`  duration               ${frames && data.fps ? (frames.length / data.fps).toFixed(3) + ' s' : 'n/a'}`);
console.log(`  capturedAt             ${data.capturedAt}`);
console.log(`  chunks                 ${Array.isArray(data.chunks) ? data.chunks.length : 'n/a'}`);

const pass = checks.every((c) => c.pass);
console.log('');
console.log(pass ? 'FIXTURE CONTRACT: PASS' : 'FIXTURE CONTRACT: FAIL — Gate 3 must not run');
process.exit(pass ? 0 : 1);
