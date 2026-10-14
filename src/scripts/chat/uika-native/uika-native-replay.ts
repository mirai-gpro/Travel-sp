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

/** Quiet tail appended to each loop so the pass restarts from a closed mouth. */
const LOOP_GAP_MS = 1000;

/** Mouth channels reported for inspection, per v1.1 Gate 3 §10. */
const WATCHED_CHANNELS = [
    'jawOpen',
    'mouthStretchLeft',
    'mouthStretchRight',
    'mouthFunnel',
    'mouthPucker',
] as const;

export type UikaReplayFixtureOrigin = 'localStorage' | 'url' | 'inline';

export interface UikaReplayFixtureInfo {
    origin: UikaReplayFixtureOrigin;
    detail: string;
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

function validateCapture(data: any, detail: string): CapturedA2E {
    if (!data || typeof data !== 'object') fail(`${detail}: not an object`);
    if (typeof data.fps !== 'number' || !(data.fps > 0)) fail(`${detail}: fps=${data.fps}`);
    if (!Array.isArray(data.expression_names) || data.expression_names.length === 0) {
        fail(`${detail}: expression_names is empty`);
    }
    if (!Array.isArray(data.frames) || data.frames.length === 0) fail(`${detail}: frames is empty`);
    if (!Array.isArray(data.frames[0])) fail(`${detail}: frames[0] is not an array`);
    const width = data.expression_names.length;
    for (let i = 0; i < data.frames.length; i++) {
        const f = data.frames[i];
        if (!Array.isArray(f) || f.length !== width) {
            fail(`${detail}: frame ${i} has ${Array.isArray(f) ? f.length : 'non-array'} values, expected ${width}`);
        }
        for (let k = 0; k < f.length; k++) {
            if (!Number.isFinite(f[k])) fail(`${detail}: frame ${i} channel ${k} is not finite`);
        }
    }
    return data as CapturedA2E;
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

    /** Load the capture saved by `?a2eCapture=1`. Throws if there is none. */
    loadFromLocalStorage(): UikaReplayFixtureInfo {
        const data = loadCapturedA2E();
        if (!data) {
            fail('no captured A2E found in localStorage (key "a2eCapture.v1"). '
                 + 'Record one first with ?a2eCapture=1 on a page that runs a real Live turn. '
                 + 'No synthetic expression data is generated as a substitute.');
        }
        return this.adopt(data, 'localStorage', 'localStorage["a2eCapture.v1"]');
    }

    /** Load a capture JSON exported from `__a2eCaptureJson()`. */
    async loadFromUrl(url: string): Promise<UikaReplayFixtureInfo> {
        const response = await fetch(url, { cache: 'no-store' });
        if (!response.ok) fail(`fetch ${url} failed: ${response.status} ${response.statusText}`);
        return this.adopt(await response.json(), 'url', url);
    }

    /** Load a capture JSON pasted into the page. */
    loadFromJson(json: string, detail = 'inline JSON'): UikaReplayFixtureInfo {
        let parsed: unknown;
        try {
            parsed = JSON.parse(json);
        } catch (error: any) {
            fail(`${detail}: ${error?.message || error}`);
        }
        return this.adopt(parsed, 'inline', detail);
    }

    private adopt(raw: unknown, origin: UikaReplayFixtureOrigin, detail: string): UikaReplayFixtureInfo {
        const data = validateCapture(raw, detail);
        this.data = data;
        this.durationMs = (data.frames.length / data.fps) * 1000;
        this.periodMs = this.durationMs + LOOP_GAP_MS;
        this.fixture = {
            origin,
            detail,
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
        this.basisNames = basisNames;
        const inputNames = this.data.expression_names;
        const basisSet = new Set(basisNames);
        const inputSet = new Set(inputNames);
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
