// UIKA Native Runtime Architecture Correction v1.1 — Gate 3
//
// Fixed real-A2E replay into the UIKA Native GPU renderer.
//
// What this does NOT touch: Gemini Live, Socket.IO, the A2E backend, LiveAudioManager,
// any AudioContext, and the normal LAM path. The only input is a previously captured
// real A2E sequence; the only output is 51 basis weights per expression frame.
//
// The A2E sequence itself is NEVER synthesised here. If no real capture is available the
// controller fails loudly; it does not fall back to generated data.

import { loadCapturedA2E, type CapturedA2E } from '../a2e-replay';
import { mapA2eToUikaBasis } from './uika-expression-mapper';

/**
 * Any JSON dropped into ./fixtures is bundled automatically, so landing the captured file
 * needs no code change. Raw text is imported (not parsed JSON) so the SHA-256 is taken
 * over the exact bytes on disk.
 */
const BUNDLED_JSON = import.meta.glob('./fixtures/*.json', {
    query: '?raw',
    import: 'default',
    eager: true,
}) as Record<string, string>;

/** `*.expected.json` holds the sender's measurements, not a capture. */
const EXPECTED_SUFFIX = '.expected.json';

const BUNDLED_FIXTURES: Record<string, string> = Object.fromEntries(
    Object.entries(BUNDLED_JSON).filter(([k]) => !k.endsWith(EXPECTED_SUFFIX)),
);

const BUNDLED_EXPECTATIONS: Record<string, string> = Object.fromEntries(
    Object.entries(BUNDLED_JSON).filter(([k]) => k.endsWith(EXPECTED_SUFFIX)),
);

/**
 * Check a capture against the values its sender measured. A prettified, rounded or
 * otherwise reformatted copy still satisfies the structural contract but fails here,
 * which is exactly the transit damage v1.1 Gate 3 §1 forbids.
 */
export function validateGate3Expectations(
    data: any,
    sha256: string,
    byteLength: number,
    expected: any,
): UikaGate3Validation {
    const checks: UikaGate3Check[] = [];
    const add = (name: string, pass: boolean, detail: string) => checks.push({ name, pass, detail });
    const near = (a: number, b: number, tol: number) => Number.isFinite(a) && Math.abs(a - b) <= tol;

    const names: string[] = Array.isArray(data.expression_names) ? data.expression_names : [];
    const frames: number[][] = Array.isArray(data.frames) ? data.frames : [];
    const chunks: any[] = Array.isArray(data.chunks) ? data.chunks : [];

    add('sha256 matches the received original', sha256 === expected.sha256, `got ${sha256}`);
    add('byte count matches', byteLength === expected.bytes,
        `got ${byteLength}, expected ${expected.bytes}`);
    add(`fps == ${expected.fps}`, data.fps === expected.fps, `fps=${data.fps}`);
    add(`frames == ${expected.frameCount}`, frames.length === expected.frameCount,
        `frames=${frames.length}`);
    add(`channels == ${expected.expressionNameCount}`, names.length === expected.expressionNameCount,
        `channels=${names.length}`);
    add(`chunks == ${expected.chunkCount}`, chunks.length === expected.chunkCount,
        `chunks=${chunks.length}`);

    const chunkCounts = chunks.map((c) => c.frames);
    add(`chunk frame counts == ${JSON.stringify(expected.chunkFrameCounts)}`,
        JSON.stringify(chunkCounts) === JSON.stringify(expected.chunkFrameCounts),
        `got ${JSON.stringify(chunkCounts)}`);

    let monotonic = chunks.length > 0;
    for (let i = 1; i < chunks.length; i++) {
        if (!(chunks[i].perfMs >= chunks[i - 1].perfMs)) monotonic = false;
    }
    add('chunks[].perfMs is monotonic', monotonic === expected.chunkPerfMsMonotonic,
        `monotonic=${monotonic}`);

    let gMin = Infinity;
    let gMax = -Infinity;
    for (const f of frames) for (const v of f) { if (v < gMin) gMin = v; if (v > gMax) gMax = v; }
    add(`global min == ${expected.globalMin}`, near(gMin, expected.globalMin, 1e-12), `min=${gMin}`);
    add(`global max == ${expected.globalMax}`, near(gMax, expected.globalMax, 1e-12), `max=${gMax}`);

    const t = expected.tongueOut;
    if (t) {
        const ti = names.indexOf('tongueOut');
        add(`tongueOut index == ${t.index}`, ti === t.index, `index=${ti}`);
        if (ti >= 0) {
            let nz = 0;
            let mx = 0;
            for (const f of frames) { const v = Math.abs(f[ti]); if (v !== 0) nz++; if (v > mx) mx = v; }
            add(`tongueOut non-zero frames == ${t.nonZeroFrames}/${t.totalFrames}`,
                nz === t.nonZeroFrames && frames.length === t.totalFrames,
                `nonzero=${nz}/${frames.length}`);
            add(`tongueOut max abs ~= ${t.maxAbs}`, near(mx, t.maxAbs, t.maxAbsTolerance ?? 1e-9),
                `maxAbs=${mx}`);
        }
    }

    for (const [channel, want] of Object.entries(expected.channelMax || {})) {
        const i = names.indexOf(channel);
        if (i < 0) { add(`${channel} present`, false, 'not in expression_names'); continue; }
        let mx = -Infinity;
        for (const f of frames) if (f[i] > mx) mx = f[i];
        add(`${channel} max == ${want}`, near(mx, want as number, 1e-12), `max=${mx}`);
    }

    return { pass: checks.every((c) => c.pass), checks };
}

/** Quiet tail appended to each loop so the pass restarts from a closed mouth. */
const LOOP_GAP_MS = 1000;

/** The A2E output contract Gate 3 accepts, per v1.1 Gate 3 §1. */
export const GATE3_EXPECTED_INPUT_CHANNELS = 52;
export const GATE3_EXPECTED_BASIS_CHANNELS = 51;
export const GATE3_EXPECTED_DROPPED_NAMES = ['tongueOut'] as const;

/** Mouth channels reported for inspection, per v1.1 Gate 3 §10. */
const WATCHED_CHANNELS = [
    'jawOpen',
    'mouthStretchLeft',
    'mouthStretchRight',
    'mouthFunnel',
    'mouthPucker',
] as const;

export type UikaReplayFixtureOrigin = 'bundled' | 'localStorage' | 'url' | 'inline';

export interface UikaGate3Check {
    name: string;
    pass: boolean;
    detail: string;
}

export interface UikaGate3Validation {
    pass: boolean;
    checks: UikaGate3Check[];
}

export interface UikaReplayFixtureInfo {
    origin: UikaReplayFixtureOrigin;
    detail: string;
    /** SHA-256 of the exact bytes loaded. This is the fixture's Source of Truth. */
    sha256: string;
    fps: number;
    frameCount: number;
    durationMs: number;
    expressionNameCount: number;
    expressionNames: string[];
    capturedAt: string;
    chunkCount: number;
}

export interface UikaReplayMappingInfo {
    inputChannels: number;
    outputChannels: number;
    droppedNames: string[];
    missingBasisNames: string[];
}

export interface UikaReplayStats {
    running: boolean;
    replayStart: number | null;
    elapsedMs: number;
    loop: number;
    inGap: boolean;
    requestedFrame: number;
    selectedFrame: number;
    mappedFrameCount: number;
    weightUploadCount: number;
    duplicateFrameRenders: number;
    skippedExpressionFrames: number;
    maxFrameJump: number;
    maxHoldMs: number;
    watchedWeights: Record<string, number>;
    uploadMs: { count: number; p50: number; p95: number; max: number };
    errors: string[];
}

function percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const i = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * sorted.length)));
    return sorted[i];
}

function fail(message: string): never {
    throw new Error(`UIKA Native Replay: ${message}`);
}

async function sha256Hex(text: string): Promise<string> {
    const bytes = new TextEncoder().encode(text);
    if (!globalThis.crypto?.subtle) return 'unavailable (no Web Crypto)';
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The structural half of the v1.1 Gate 3 §1 contract. Every check is reported, pass or
 * fail, so a rejected fixture says exactly which rule it broke.
 */
export function validateGate3Fixture(data: any): UikaGate3Validation {
    const checks: UikaGate3Check[] = [];
    const add = (name: string, pass: boolean, detail: string) => checks.push({ name, pass, detail });

    const isObject = !!data && typeof data === 'object';
    add('is an object', isObject, isObject ? 'ok' : `typeof ${typeof data}`);
    if (!isObject) return { pass: false, checks };

    const fpsOk = typeof data.fps === 'number' && data.fps > 0;
    add('fps > 0', fpsOk, `fps=${data.fps}`);

    const namesIsArray = Array.isArray(data.expression_names);
    const nameCount = namesIsArray ? data.expression_names.length : -1;
    add(`expression_names.length == ${GATE3_EXPECTED_INPUT_CHANNELS}`,
        nameCount === GATE3_EXPECTED_INPUT_CHANNELS, `length=${nameCount}`);

    const framesIsArray = Array.isArray(data.frames);
    const frameCount = framesIsArray ? data.frames.length : -1;
    add('frames.length > 0', framesIsArray && frameCount > 0, `length=${frameCount}`);

    if (!framesIsArray || frameCount === 0) return { pass: false, checks };

    let nonArray = 0;
    let wrongWidth = 0;
    let nanCount = 0;
    let infCount = 0;
    let otherNonFinite = 0;
    for (let i = 0; i < data.frames.length; i++) {
        const f = data.frames[i];
        if (!Array.isArray(f)) { nonArray++; continue; }
        if (f.length !== GATE3_EXPECTED_INPUT_CHANNELS) wrongWidth++;
        for (let k = 0; k < f.length; k++) {
            const v = f[k];
            if (typeof v !== 'number') { otherNonFinite++; continue; }
            if (Number.isNaN(v)) nanCount++;
            else if (!Number.isFinite(v)) infCount++;
        }
    }
    add('every frame is an Array', nonArray === 0, `non-array frames=${nonArray}`);
    add(`every frame length == ${GATE3_EXPECTED_INPUT_CHANNELS}`, wrongWidth === 0,
        `wrong-width frames=${wrongWidth}`);
    add('NaN == 0', nanCount === 0, `NaN values=${nanCount}`);
    add('Inf == 0', infCount === 0, `Inf values=${infCount}`);
    add('every value finite', nanCount === 0 && infCount === 0 && otherNonFinite === 0,
        `NaN=${nanCount} Inf=${infCount} non-numeric=${otherNonFinite}`);

    return { pass: checks.every((c) => c.pass), checks };
}

/**
 * The mapping half of the v1.1 Gate 3 §1 contract, checked against the asset's own basis
 * names rather than against a hard-coded list.
 */
export function validateGate3Mapping(
    inputNames: readonly string[],
    basisNames: readonly string[],
    mappedLength: number,
): UikaGate3Validation {
    const checks: UikaGate3Check[] = [];
    const add = (name: string, pass: boolean, detail: string) => checks.push({ name, pass, detail });

    const basisSet = new Set(basisNames);
    const inputSet = new Set(inputNames);
    const dropped = inputNames.filter((n) => !basisSet.has(n));
    const missing = basisNames.filter((n) => !inputSet.has(n));
    const expectedDropped = [...GATE3_EXPECTED_DROPPED_NAMES];

    add(`basisCount == ${GATE3_EXPECTED_BASIS_CHANNELS}`,
        basisNames.length === GATE3_EXPECTED_BASIS_CHANNELS, `basisCount=${basisNames.length}`);
    add(`mappedCount == ${GATE3_EXPECTED_BASIS_CHANNELS}`,
        mappedLength === GATE3_EXPECTED_BASIS_CHANNELS, `mappedCount=${mappedLength}`);
    add(`dropped == ${JSON.stringify(expectedDropped)}`,
        JSON.stringify(dropped) === JSON.stringify(expectedDropped), `dropped=${JSON.stringify(dropped)}`);
    add('basis missing == []', missing.length === 0, `missing=${JSON.stringify(missing)}`);

    return { pass: checks.every((c) => c.pass), checks };
}

function describeFailure(validation: UikaGate3Validation): string {
    return validation.checks.filter((c) => !c.pass).map((c) => `${c.name} (${c.detail})`).join('; ');
}

/**
 * Time-based replay of a captured real A2E sequence.
 *
 * The frame is always chosen from the current clock, never advanced by a counter, so a
 * slow frame catches up instead of drifting:
 *
 *     requestedFrame = floor(elapsedMs * fps / 1000)
 */
export class UikaNativeReplay {
    private data: CapturedA2E | null = null;
    private fixture: UikaReplayFixtureInfo | null = null;
    private mapping: UikaReplayMappingInfo | null = null;
    private basisNames: readonly string[] = [];

    private lastValidation: UikaGate3Validation | null = null;
    private lastMappingValidation: UikaGate3Validation | null = null;
    private lastExpectationValidation: UikaGate3Validation | null = null;

    private start = 0;
    private running = false;
    private durationMs = 0;
    private periodMs = 0;

    private lastSelected = -1;
    private lastUploadAt = 0;
    private readonly uploadMs: number[] = [];
    private readonly stats: UikaReplayStats = {
        running: false,
        replayStart: null,
        elapsedMs: 0,
        loop: 0,
        inGap: false,
        requestedFrame: -1,
        selectedFrame: -1,
        mappedFrameCount: 0,
        weightUploadCount: 0,
        duplicateFrameRenders: 0,
        skippedExpressionFrames: 0,
        maxFrameJump: 0,
        maxHoldMs: 0,
        watchedWeights: {},
        uploadMs: { count: 0, p50: 0, p95: 0, max: 0 },
        errors: [],
    };

    constructor(private readonly applyWeights: (weights: Float32Array) => void) {}

    getFixture(): UikaReplayFixtureInfo | null {
        return this.fixture;
    }

    getMapping(): UikaReplayMappingInfo | null {
        return this.mapping;
    }

    getValidation(): {
        fixture: UikaGate3Validation | null;
        expectations: UikaGate3Validation | null;
        mapping: UikaGate3Validation | null;
    } {
        return {
            fixture: this.lastValidation,
            expectations: this.lastExpectationValidation,
            mapping: this.lastMappingValidation,
        };
    }

    /** Names of the JSON files bundled from ./fixtures, if any. */
    static listBundledFixtures(): string[] {
        return Object.keys(BUNDLED_FIXTURES).sort();
    }

    /** Returns a snapshot, so a caller can diff two reads. */
    getStats(): UikaReplayStats {
        const sorted = [...this.uploadMs].sort((a, b) => a - b);
        this.stats.running = this.running;
        this.stats.uploadMs = {
            count: this.uploadMs.length,
            p50: percentile(sorted, 0.5),
            p95: percentile(sorted, 0.95),
            max: sorted.length ? sorted[sorted.length - 1] : 0,
        };
        return {
            ...this.stats,
            watchedWeights: { ...this.stats.watchedWeights },
            uploadMs: { ...this.stats.uploadMs },
            errors: [...this.stats.errors],
        };
    }

    /** Load the fixture committed under ./fixtures. Throws if none is bundled. */
    async loadBundled(name?: string): Promise<UikaReplayFixtureInfo> {
        const keys = UikaNativeReplay.listBundledFixtures();
        if (keys.length === 0) {
            fail('no fixture is bundled under src/scripts/chat/uika-native/fixtures/. '
                 + 'See that directory\'s README.md for how to capture one. '
                 + 'No synthetic expression data is generated as a substitute.');
        }
        const key = name ? keys.find((k) => k.endsWith(name)) : keys[0];
        if (!key) fail(`bundled fixture "${name}" not found; have ${JSON.stringify(keys)}`);
        return this.adopt(BUNDLED_FIXTURES[key], 'bundled', key);
    }

    /** Load the capture saved by `?a2eCapture=1`. Throws if there is none. */
    async loadFromLocalStorage(): Promise<UikaReplayFixtureInfo> {
        const data = loadCapturedA2E();
        if (!data) {
            fail('no captured A2E found in localStorage (key "a2eCapture.v1"). '
                 + 'Record one first with ?a2eCapture=1 on a page that runs a real Live turn. '
                 + 'No synthetic expression data is generated as a substitute.');
        }
        return this.adopt(JSON.stringify(data), 'localStorage', 'localStorage["a2eCapture.v1"]');
    }

    /** Load a capture JSON exported from `__a2eCaptureJson()`. */
    async loadFromUrl(url: string): Promise<UikaReplayFixtureInfo> {
        const response = await fetch(url, { cache: 'no-store' });
        if (!response.ok) fail(`fetch ${url} failed: ${response.status} ${response.statusText}`);
        return this.adopt(await response.text(), 'url', url);
    }

    /** Load a capture JSON pasted into the page. */
    async loadFromJson(json: string, detail = 'inline JSON'): Promise<UikaReplayFixtureInfo> {
        return this.adopt(json, 'inline', detail);
    }

    /**
     * Parse, run the v1.1 Gate 3 §1 structural contract, and keep the data only if every
     * check passes. A failing fixture is reported check by check and Gate 3 does not run.
     */
    private async adopt(
        text: string,
        origin: UikaReplayFixtureOrigin,
        detail: string,
    ): Promise<UikaReplayFixtureInfo> {
        let raw: unknown;
        try {
            raw = JSON.parse(text);
        } catch (error: any) {
            fail(`${detail}: not valid JSON (${error?.message || error})`);
        }

        const validation = validateGate3Fixture(raw);
        this.lastValidation = validation;
        if (!validation.pass) {
            this.data = null;
            this.fixture = null;
            fail(`${detail} failed the Gate 3 fixture contract: ${describeFailure(validation)}`);
        }
        const data = raw as CapturedA2E;
        const sha256 = await sha256Hex(text);

        // When the sender's measurements are bundled alongside, the file must match them.
        const expectedKey = Object.keys(BUNDLED_EXPECTATIONS)[0];
        if (expectedKey) {
            const expected = JSON.parse(BUNDLED_EXPECTATIONS[expectedKey]);
            const byteLength = new TextEncoder().encode(text).length;
            const expectations = validateGate3Expectations(data, sha256, byteLength, expected);
            this.lastExpectationValidation = expectations;
            if (!expectations.pass) {
                this.data = null;
                this.fixture = null;
                fail(`${detail} does not match ${expectedKey}: ${describeFailure(expectations)}`);
            }
        } else {
            this.lastExpectationValidation = null;
        }
        this.data = data;
        this.durationMs = (data.frames.length / data.fps) * 1000;
        this.periodMs = this.durationMs + LOOP_GAP_MS;
        this.fixture = {
            origin,
            detail,
            sha256,
            fps: data.fps,
            frameCount: data.frames.length,
            durationMs: this.durationMs,
            expressionNameCount: data.expression_names.length,
            expressionNames: [...data.expression_names],
            capturedAt: data.capturedAt,
            chunkCount: Array.isArray(data.chunks) ? data.chunks.length : 0,
        };
        return this.fixture;
    }

    /**
     * Resolve the 52 -> 51 name contract against the asset's basis names, once, so the
     * dropped and missing channels are on the record before any frame is played.
     */
    bindBasis(basisNames: readonly string[]): UikaReplayMappingInfo {
        if (!this.data) fail('load a fixture first');
        const inputNames = this.data.expression_names;
        const basisSet = new Set(basisNames);
        const inputSet = new Set(inputNames);

        // Map one real frame so mappedCount is measured, not assumed.
        const probe = mapA2eToUikaBasis(
            { names: inputNames, values: this.data.frames[0] },
            basisNames,
        );
        const mappingValidation = validateGate3Mapping(inputNames, basisNames, probe.weights.length);
        this.lastMappingValidation = mappingValidation;
        if (!mappingValidation.pass) {
            this.basisNames = [];
            this.mapping = null;
            fail(`mapping contract failed: ${describeFailure(mappingValidation)}`);
        }

        this.basisNames = basisNames;
        this.mapping = {
            inputChannels: inputNames.length,
            outputChannels: basisNames.length,
            droppedNames: inputNames.filter((n) => !basisSet.has(n)),
            missingBasisNames: basisNames.filter((n) => !inputSet.has(n)),
        };
        return this.mapping;
    }

    start_(): void {
        if (!this.data) fail('load a fixture first');
        if (this.basisNames.length === 0) fail('bindBasis() has not run');
        this.start = performance.now();
        this.lastSelected = -1;
        this.lastUploadAt = this.start;
        this.running = true;
        this.stats.replayStart = this.start;
    }

    stop(): void {
        this.running = false;
    }

    /**
     * Called once per rendered frame. Picks the A2E frame for the current clock and, only
     * when that frame actually changed, maps it and pushes 51 weights to the GPU.
     */
    tick(): void {
        if (!this.running || !this.data) return;

        const elapsed = performance.now() - this.start;
        const loop = Math.floor(elapsed / this.periodMs);
        const t = elapsed - loop * this.periodMs;
        const total = this.data.frames.length;

        this.stats.elapsedMs = elapsed;
        this.stats.loop = loop;

        // The gap at the end of each loop plays the neutral pose.
        const inGap = t >= this.durationMs;
        this.stats.inGap = inGap;

        const requested = Math.floor((t / 1000) * this.data.fps);
        const selected = inGap ? -1 : Math.min(total - 1, requested);
        this.stats.requestedFrame = requested;
        this.stats.selectedFrame = selected;

        if (selected === this.lastSelected) {
            this.stats.duplicateFrameRenders++;
            const held = performance.now() - this.lastUploadAt;
            if (held > this.stats.maxHoldMs) this.stats.maxHoldMs = held;
            return;
        }

        // Count A2E frames the clock skipped past within one loop.
        if (this.lastSelected >= 0 && selected > this.lastSelected) {
            const jump = selected - this.lastSelected;
            if (jump > this.stats.maxFrameJump) this.stats.maxFrameJump = jump;
            if (jump > 1) this.stats.skippedExpressionFrames += jump - 1;
        }

        const values = selected < 0
            ? new Array(this.data.expression_names.length).fill(0)
            : this.data.frames[selected];

        const t0 = performance.now();
        const mapped = mapA2eToUikaBasis(
            { names: this.data.expression_names, values },
            this.basisNames,
        );
        this.applyWeights(mapped.weights);
        const dt = performance.now() - t0;

        this.uploadMs.push(dt);
        if (this.uploadMs.length > 4000) this.uploadMs.shift();

        this.lastSelected = selected;
        this.lastUploadAt = performance.now();
        this.stats.mappedFrameCount++;
        this.stats.weightUploadCount++;

        const watched: Record<string, number> = {};
        for (const name of WATCHED_CHANNELS) {
            const index = this.basisNames.indexOf(name);
            watched[name] = index >= 0 ? mapped.weights[index] : Number.NaN;
        }
        this.stats.watchedWeights = watched;
    }
}
