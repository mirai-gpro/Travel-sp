// UIKA Native Runtime v1.1 — Gate 4C: LAM reference baseline benchmark
//
// Gate 4B-2C closed the sort question: UIKA A (no sort at all) measured 43.72 fps with an
// exact wall p95 of 45.97 ms, and UIKA C (canonical centre + LAM Worker/WASM, sorting once
// per rendered frame) measured 42.88 fps / 46.90 ms. The difference is 0.93 ms, inside both
// runs' own repeat spread. Whatever remains of that 45–47 ms tail is not the sort, and this
// gate does not try to optimise it.
//
// Instead it measures the thing that has never been measured: what the LAM avatar that is
// already in production, and already looks right, actually does on the same machine.
//
// INSTRUMENTATION ONLY. Nothing in the LAM path is modified:
//
//   * every hook is a wrapper that calls through to the original and is removed on detach;
//   * no render policy, sort policy, cadence, frame-selection rule or expression value is
//     changed;
//   * `LAMWebSocketManager`, `AudioSyncPlayer`, `LiveAudioManager`, `GaussianSplatRenderer`
//     and the LAM `Viewer` are used exactly as production uses them, and are not edited.
//
// The renderer handle is read out of `LAMWebSocketManager`'s private field at runtime.
// `GaussianSplatRenderer.instance` exists as a static but is never assigned by the package,
// so it cannot be used, and the manager exposes no getter. Reading the field is a
// diagnostic read, not a modification.

import type { UikaGpuInfo } from './uika-native-benchmark';
import { GpuTimerPool, collectGpuInfo } from './uika-native-benchmark';
import { summariseStage, type UikaStageStats } from './uika-tail-isolation';

/**
 * Gate 4B-2C's real-GPU result, frozen. Per-repeat values are carried so the comparison
 * can be audited rather than trusted: AMD Radeon 860M, Chrome 155, 879 x 879 at
 * pixelRatio 1.0, three repeats, round-robin, `analysis.valid = true`.
 */
export const GATE4B2C_UIKA_REFERENCE = {
    source: 'docs/UIKA_NATIVE_RUNTIME_GATE4B2C_LAM_REFERENCE_SORT.md §12.2',
    gpu: 'ANGLE (AMD, AMD Radeon(TM) 860M Graphics (0x00001114) Direct3D11 vs_5_0 ps_5_0, D3D11)',
    buffer: { width: 879, height: 879, pixelRatio: 1 },
    runs: {
        'UIKA A no-sort': {
            fps: [44.00, 43.13, 44.02],
            p50: [24.30, 24.30, 24.20],
            p95: [44.30, 49.70, 43.90],
            gpuDrawP50: [19.86, 19.96, 19.94],
        },
        'UIKA C canonical + LAM Worker/WASM': {
            fps: [42.57, 42.96, 43.10],
            p50: [24.40, 24.40, 24.30],
            p95: [50.80, 45.30, 44.60],
            gpuDrawP50: [20.53, 20.49, 20.44],
        },
    },
} as const;

/** The absolute gate this project has carried so far. Gate 4C may put it in question. */
export const ABSOLUTE_GATE = { minFps: 30, maxWallP95Ms: 33.3 } as const;

/**
 * §9's decision rule, written down before the measurement.
 *
 * The comparison is made against the combined repeat spread of the two runs being
 * compared, never against a bare difference: a gap smaller than the measurements' own
 * run-to-run spread is not a gap.
 */
export const ENVELOPE_RULES = {
    minRepeats: 3,
    minIntervalSamples: 30,
    /** UIKA C is behind only if it exceeds LAM by more than both spreads put together. */
    spreadMultiplier: 1,
    /** `UIKA_WITHIN_LAM_RUNTIME_ENVELOPE` additionally requires this. */
    minUikaFps: 30,
} as const;

export type UikaLamEnvelopeVerdict =
    | 'UIKA_WITHIN_LAM_RUNTIME_ENVELOPE'
    | 'UIKA_RUNTIME_BEHIND_LAM'
    | 'UNRESOLVED';

/** §5: a stage is either measured or honestly declared un-instrumented. Never guessed. */
export type UikaLamStage = UikaStageStats | 'not instrumented';

export interface UikaLamExpressionSample {
    /** performance.now() when the renderer asked for the expression. */
    at: number;
    /** The AudioContext clock at that moment, or null when no AudioContext is driving. */
    audioClock: number | null;
    /**
     * The frame the clock says is current AT THE MOMENT OF THE READ — what should be on
     * screen. Computed here, not reused from the driver's last push, or the lag below
     * would be structurally zero.
     */
    selectedFrame: number;
    /**
     * The frame the renderer actually received: the last one the driver pushed into the
     * manager's cache. In `provider` mode the two coincide by construction, because the
     * renderer pulls at read time.
     */
    renderedFrame: number;
    /**
     * How long before this read the driver last pushed a frame into the cache. Without it
     * a `renderLag` of 0 cannot be read: in `cache` mode the pusher and the LAM loop share
     * the requestAnimationFrame queue, so if the pusher happens to run 1 ms before the
     * read then zero lag is trivially true and says nothing about the runtime. Null in
     * `provider` mode, where there is no separate push.
     */
    msSinceLastPush: number | null;
}

/** §7. Not an optimisation target: it is how LAM really holds and drops frames. */
export interface UikaLamExpressionCounters {
    expressionReads: number;
    selectedFrames: number;
    /** requestAnimationFrame ticks the expression driver got. Starvation shows up here. */
    driverTicks: number;
    distinctRenderedFrames: number;
    sameExpressionHeldFrames: number;
    expressionFrameSkips: number;
    maxExpressionFrameJump: number;
    /**
     * `selectedFrame - renderedFrame` at each read, in fixture frames: how stale the
     * expression was when the renderer took it. 0 means the renderer got the frame the
     * clock was asking for. At 30 fps one frame is 33.3 ms of lip-sync lag.
     */
    renderLag: UikaStageStats;
    /** Read `renderLag` together with this; see `msSinceLastPush` on the sample. */
    msSinceLastPush: UikaStageStats;
}

export interface UikaLamBaselineRun {
    repeat: number;
    warmupMs: number;
    measuredMs: number;
    /** viewer.render() calls inside the window. Drain frames are excluded. */
    renderedFrames: number;
    framesDuringDrain: number;
    effectiveFPS: number;
    /** render-to-render interval of the LAM loop. */
    wallInterval: UikaStageStats;
    /** §5. */
    gpuDraw: UikaLamStage;
    sortSubmission: UikaLamStage;
    workerSort: UikaLamStage;
    indexUpdate: UikaLamStage;
    /** How many `renderer.render()` calls LAM makes per `viewer.render()`. */
    threeRenderCallsPerFrame: UikaStageStats;
    sortSubmissions: number;
    sortCompletions: number;
    effectiveSortHz: number;
    invalidGpuTimerSamples: number;
    expression: UikaLamExpressionCounters;
    expressionSamples: UikaLamExpressionSample[];
    glErrors: number;
    pageErrors: number;
    visibilityLostMs: number;
}

export interface UikaLamComparisonRow {
    name: string;
    repeats: number;
    fps: number;
    p50: number;
    p95: number;
    p95Spread: number;
    gpuDrawP50: number | null;
    meetsAbsoluteGate: boolean;
}

export interface UikaLamBaselineReport {
    spec: string;
    startedAt: string;
    finishedAt: string | null;
    gpu: UikaGpuInfo;
    realGpu: boolean;
    /** What was actually rendered, read back rather than assumed. */
    subject: {
        modelUrl: string;
        splatCount: number | null;
        drawingBufferWidth: number;
        drawingBufferHeight: number;
        rendererPixelRatio: number;
        devicePixelRatio: number;
        cssWidth: number;
        cssHeight: number;
        renderMode: unknown;
        sortPolicy: {
            gpuAcceleratedSort: unknown;
            integerBasedSort: unknown;
            sharedMemoryForWorkers: unknown;
            splatSortDistanceMapPrecision: unknown;
            dynamicMode: unknown;
        } | null;
        /** render.ts drives its own rAF loop; Viewer.selfDrivenUpdate's vsync divider is bypassed. */
        loop: string;
    } | null;
    expressionSource: {
        mode: 'fixture-cache' | 'fixture-provider';
        fixture: string;
        fps: number;
        frames: number;
        names: number;
        clock: string;
        jpMouthCorrection: string;
    } | null;
    runs: UikaLamBaselineRun[];
    comparison: UikaLamComparisonRow[] | null;
    verdict: UikaLamEnvelopeVerdict;
    verdictBasis: string[];
    notInstrumented: string[];
    notes: string[];
}

export interface UikaLamBaselineOptions {
    repeats: number;
    warmupMs: number;
    measureMs: number;
    modelUrl: string;
    /** 'cache' is the normal LAM timeline: a rAF driver pushes, the renderer reads a cache. */
    expressionPath: 'cache' | 'provider';
    maxExpressionSamples: number;
    allowSoftware: boolean;
}

export const DEFAULT_LAM_BASELINE_OPTIONS: UikaLamBaselineOptions = {
    repeats: 3,
    warmupMs: 2000,
    measureMs: 12000,
    modelUrl: '/avatar/meruru.zip',
    expressionPath: 'cache',
    maxExpressionSamples: 4000,
    allowSoftware: false,
};

/** Each key is parsed only when present, so an absent parameter never becomes 0. */
export function lamBaselineOptionsFromUrl(): UikaLamBaselineOptions {
    const o: UikaLamBaselineOptions = { ...DEFAULT_LAM_BASELINE_OPTIONS };
    try {
        const q = new URLSearchParams(window.location.search);
        const num = (key: string, min: number): number | null => {
            if (!q.has(key)) return null;
            const v = Number(q.get(key));
            return Number.isFinite(v) && v >= min ? v : null;
        };
        const repeats = num('lamRepeats', 1);
        if (repeats !== null) o.repeats = Math.floor(repeats);
        const warmup = num('lamWarmupMs', 0);
        if (warmup !== null) o.warmupMs = warmup;
        const measure = num('lamMeasureMs', 1000);
        if (measure !== null) o.measureMs = measure;
        const samples = num('lamMaxExprSamples', 0);
        if (samples !== null) o.maxExpressionSamples = Math.floor(samples);
        if (q.has('lamModel')) o.modelUrl = q.get('lamModel')!;
        if (q.has('lamExprPath')) {
            const v = q.get('lamExprPath');
            if (v === 'cache' || v === 'provider') o.expressionPath = v;
        }
        if (q.has('allowSoftware')) o.allowSoftware = q.get('allowSoftware') === '1';
    } catch { /* noop */ }
    return o;
}

/**
 * How long to wait for the LAM path to finish building. The splat scene is added
 * asynchronously after `getInstance()` resolves, and on a slow renderer that takes a
 * while; this bounds the wait so a genuine failure still surfaces.
 */
const LAM_READY_TIMEOUT_MS = 120000;

function mean(values: number[]): number {
    if (values.length === 0) return 0;
    let sum = 0;
    for (const v of values) sum += v;
    return sum / values.length;
}

function spread(values: number[]): number {
    return values.length > 1 ? Math.max(...values) - Math.min(...values) : 0;
}

/** Every wrapper this harness installs, so detach can prove it put everything back. */
interface InstalledHook {
    label: string;
    restore: () => void;
}

export class UikaLamBaseline {
    private report: UikaLamBaselineReport | null = null;
    private running = false;
    private abort = false;
    private pageErrors = 0;
    private hooks: InstalledHook[] = [];
    private live = { step: '', phase: 'idle', fps: 0, p95: 0, frame: 0 };

    // Instrumentation state, reset per run.
    private collecting = false;
    private renderStarts: number[] = [];
    private renderCount = 0;
    private threeRenderCalls: number[] = [];
    private threeRenderCallsThisFrame = 0;
    private sortSubmissions = 0;
    private sortCompletions = 0;
    private workerSortMs: number[] = [];
    private indexUpdateMs: number[] = [];
    private sortSubmitMs: number[] = [];
    private expressionSamples: UikaLamExpressionSample[] = [];
    private timers: GpuTimerPool | null = null;

    // Expression driver state.
    private fixture: { fps: number; expression_names: string[]; frames: number[][] } | null = null;
    private audioContext: AudioContext | null = null;
    private driverStartClock = 0;
    private driverRaf = 0;
    private lastPushedFrame = -1;
    private selectedCount = 0;
    private driverFrameMs = 1000 / 30;
    private driverTotalFrames = 0;
    private driverTicks = 0;
    private lastPushAt: number | null = null;

    constructor() {
        window.addEventListener('error', () => { this.pageErrors++; });
        window.addEventListener('unhandledrejection', () => { this.pageErrors++; });
    }

    getLive() { return { ...this.live }; }
    getReport(): UikaLamBaselineReport | null { return this.report; }
    isRunning(): boolean { return this.running; }
    stop(): void { this.abort = true; }

    // ------------------------------------------------------------------ hooks

    /**
     * Wrap a method on an object so it records, then calls through. The original is kept
     * and restored on detach; the wrapper never changes arguments, return value or timing
     * policy.
     */
    private wrap(target: any, key: string, make: (orig: Function) => Function, label: string): boolean {
        if (!target || typeof target[key] !== 'function') return false;
        const orig = target[key].bind(target);
        const own = Object.prototype.hasOwnProperty.call(target, key);
        const previous = own ? target[key] : undefined;
        target[key] = make(orig);
        this.hooks.push({
            label,
            restore: () => { if (own) target[key] = previous; else delete target[key]; },
        });
        return true;
    }

    private detach(): void {
        for (let i = this.hooks.length - 1; i >= 0; i--) {
            try { this.hooks[i].restore(); } catch { /* noop */ }
        }
        this.hooks = [];
    }

    private installHooks(gsr: any, viewer: any): string[] {
        const notInstrumented: string[] = [];

        // The LAM render loop. One sample per viewer.render() — the frame the user sees.
        const viewerRenderWrapped = this.wrap(viewer, 'render', (orig) => () => {
            const started = performance.now();
            this.threeRenderCallsThisFrame = 0;
            this.timers?.beginDraw();
            const out = orig();
            this.timers?.endDraw();
            if (this.collecting) {
                this.renderStarts.push(started);
                this.renderCount++;
                this.threeRenderCalls.push(this.threeRenderCallsThisFrame);
            }
            this.timers?.frameDone();
            return out;
        }, 'viewer.render');
        if (!viewerRenderWrapped) notInstrumented.push('viewer.render (wall interval, GPU draw)');

        // LAM's Viewer.render() can issue up to four renderer.render() calls per frame
        // (scene, splat mesh, focus marker, control plane). Counting them keeps the GPU
        // draw sample comparable with UIKA's, which wraps exactly one.
        const three = viewer?.renderer;
        if (!this.wrap(three, 'render', (orig) => (...args: any[]) => {
            this.threeRenderCallsThisFrame++;
            return orig(...args);
        }, 'renderer.render')) {
            notInstrumented.push('renderer.render count per frame');
        }

        // Sort submission.
        if (!this.wrap(viewer, 'runSplatSort', (orig) => (...args: any[]) => {
            const started = performance.now();
            const out = orig(...args);
            if (this.collecting) {
                this.sortSubmitMs.push(performance.now() - started);
                this.sortSubmissions++;
            }
            return out;
        }, 'viewer.runSplatSort')) {
            notInstrumented.push('viewer.runSplatSort (sort submission)');
        }

        // Render-index upload.
        const mesh = viewer?.splatMesh;
        if (!this.wrap(mesh, 'updateRenderIndexes', (orig) => (...args: any[]) => {
            const started = performance.now();
            const out = orig(...args);
            if (this.collecting) this.indexUpdateMs.push(performance.now() - started);
            return out;
        }, 'splatMesh.updateRenderIndexes')) {
            notInstrumented.push('splatMesh.updateRenderIndexes');
        }

        // Worker sort time, as the worker itself reports it. The worker's onmessage is a
        // property, not a method, so it is swapped rather than wrapped by `wrap`.
        const worker = viewer?.sortWorker;
        if (worker && typeof worker.onmessage === 'function') {
            const original = worker.onmessage;
            worker.onmessage = (e: any) => {
                if (this.collecting && e?.data?.sortDone) {
                    this.sortCompletions++;
                    if (typeof e.data.sortTime === 'number') this.workerSortMs.push(e.data.sortTime);
                }
                return original(e);
            };
            this.hooks.push({
                label: 'sortWorker.onmessage',
                restore: () => { worker.onmessage = original; },
            });
        } else {
            notInstrumented.push('sortWorker.onmessage (worker sort time)');
        }

        // §6: what the renderer actually read, and when.
        if (!this.wrap(gsr, 'getExpressionData', (orig) => () => {
            const out = orig();
            if (this.collecting && this.expressionSamples.length < this.maxSamples) {
                this.expressionSamples.push({
                    at: performance.now(),
                    audioClock: this.audioContext ? this.audioContext.currentTime : null,
                    selectedFrame: this.clockFrameNow(),
                    renderedFrame: this.lastPushedFrame,
                    msSinceLastPush: this.lastPushAt === null
                        ? null : performance.now() - this.lastPushAt,
                });
            }
            return out;
        }, 'GaussianSplatRenderer.getExpressionData')) {
            notInstrumented.push('GaussianSplatRenderer.getExpressionData (expression timing)');
        }

        return notInstrumented;
    }

    private maxSamples = DEFAULT_LAM_BASELINE_OPTIONS.maxExpressionSamples;

    // ------------------------------------------------------------- expression

    /**
     * The normal LAM timeline: a requestAnimationFrame driver selects the frame that the
     * clock says is current and pushes it into the manager's cache, exactly as
     * `AudioSyncPlayer` does in production; the renderer then reads that cache from inside
     * its own loop. Nothing about LAM's frame selection is changed — this driver stands in
     * for the audio player, and feeds the SAME real-A2E fixture UIKA was measured with, so
     * the two runtimes see the same stimulus.
     */
    private startExpressionDriver(manager: any, options: UikaLamBaselineOptions): void {
        const fixture = this.fixture!;
        this.driverFrameMs = 1000 / fixture.fps;
        this.driverTotalFrames = fixture.frames.length;

        if (options.expressionPath === 'provider') {
            manager.setExpressionProvider(() => {
                const index = this.clockFrameNow();
                this.lastPushedFrame = index;
                this.selectedCount++;
                this.driverTicks++;
                return { values: fixture.frames[index] };
            });
            return;
        }

        manager.setExpressionProvider(null);
        let lastSelected = -1;
        const tick = () => {
            if (this.abort && !this.running) return;
            this.driverTicks++;
            const index = this.clockFrameNow();
            if (index !== lastSelected) {
                lastSelected = index;
                this.selectedCount++;
                manager.updateExpression({ values: fixture.frames[index] });
                this.lastPushedFrame = index;
                this.lastPushAt = performance.now();
            }
            this.driverRaf = requestAnimationFrame(tick);
        };
        this.driverRaf = requestAnimationFrame(tick);
    }

    /** The fixture frame the clock is asking for right now. */
    private clockFrameNow(): number {
        const frameMs = this.driverFrameMs;
        const total = this.driverTotalFrames;
        if (total <= 0) return -1;
        const clock = this.audioContext
            ? (this.audioContext.currentTime - this.driverStartClock) * 1000
            : performance.now() - this.driverStartClock;
        const looped = ((clock % (total * frameMs)) + total * frameMs) % (total * frameMs);
        return Math.min(total - 1, Math.floor(looped / frameMs));
    }

    private stopExpressionDriver(manager: any): void {
        if (this.driverRaf) cancelAnimationFrame(this.driverRaf);
        this.driverRaf = 0;
        try { manager.setExpressionProvider(null); } catch { /* noop */ }
    }

    private summariseExpression(): UikaLamExpressionCounters {
        const s = this.expressionSamples;
        const rendered = s.map((x) => x.renderedFrame);
        const distinct = new Set(rendered).size;
        let held = 0;
        let skips = 0;
        let maxJump = 0;
        for (let i = 1; i < rendered.length; i++) {
            const prev = rendered[i - 1];
            const cur = rendered[i];
            if (cur === prev) { held++; continue; }
            // The fixture loops, so a wrap is not a skip.
            const jump = cur > prev ? cur - prev : 0;
            if (jump > maxJump) maxJump = jump;
            if (jump > 1) skips += jump - 1;
        }
        return {
            expressionReads: s.length,
            selectedFrames: this.selectedCount,
            driverTicks: this.driverTicks,
            distinctRenderedFrames: distinct,
            sameExpressionHeldFrames: held,
            expressionFrameSkips: skips,
            maxExpressionFrameJump: maxJump,
            renderLag: summariseStage(s.map((x) => x.selectedFrame - x.renderedFrame)),
            msSinceLastPush: summariseStage(
                s.map((x) => x.msSinceLastPush).filter((v): v is number => v !== null)),
        };
    }

    // ----------------------------------------------------------------- the run

    async run(
        manager: any,
        fixture: { fps: number; expression_names: string[]; frames: number[][] },
        fixtureName: string,
        options: UikaLamBaselineOptions = DEFAULT_LAM_BASELINE_OPTIONS,
    ): Promise<UikaLamBaselineReport> {
        if (this.running) throw new Error('UIKA Gate 4C: already running');
        this.running = true;
        this.abort = false;
        this.fixture = fixture;
        this.maxSamples = options.maxExpressionSamples;

        // `GaussianSplatRenderer.getInstance()` resolves before `addSplatScene()` has
        // finished, and the splat mesh and the sort worker are created inside that scene
        // add. Hooking before they exist would report them as "not instrumented" when the
        // truth is only that the harness was early.
        const ready = await this.waitForLamReady(manager, LAM_READY_TIMEOUT_MS);
        const gsr = manager?.renderer;
        const viewer = gsr?.viewer;
        const three = viewer?.renderer;
        const gpu = collectGpuInfo(three?.domElement ?? null);

        this.report = {
            spec: 'UIKA Native Runtime v1.1 — Gate 4C LAM reference baseline',
            startedAt: new Date().toISOString(),
            finishedAt: null,
            gpu,
            realGpu: !gpu.isSoftware && gpu.unmaskedAvailable,
            subject: null,
            expressionSource: null,
            runs: [],
            comparison: null,
            verdict: 'UNRESOLVED',
            verdictBasis: [],
            notInstrumented: [],
            notes: [
                'instrumentation only: every hook wraps and calls through, and is removed '
                + 'afterwards. No LAM render policy, sort policy, cadence, frame-selection '
                + 'rule or expression value is changed.',
                'the renderer handle is read out of LAMWebSocketManager at runtime; '
                + 'GaussianSplatRenderer.instance is declared by the package but never '
                + 'assigned, and the manager exposes no getter.',
                'LAM is fed the SAME real-A2E fixture UIKA Gate 4B-2C used, at the same '
                + '30 fps, through the production expression path including the JP mouth '
                + 'correction — so the two runtimes are compared on the same stimulus.',
                'no audio is played, so the AudioContext clock is a clock only. This gate '
                + 'measures runtime timing, not lip-sync quality.',
            ],
        };
        const r = this.report;

        try {
            if (!ready.ok) {
                throw new Error(`the LAM path is not ready after ${LAM_READY_TIMEOUT_MS} ms: `
                    + `${ready.missing.join(', ')} missing`);
            }
            if (gpu.isSoftware && !options.allowSoftware) {
                r.verdictBasis.push(`software renderer (${gpu.softwareMatches.join(', ')}): `
                    + 'runtime timing on a software rasteriser is not evidence');
                return r;
            }

            const canvas: HTMLCanvasElement = three.domElement;
            r.subject = {
                modelUrl: options.modelUrl,
                splatCount: viewer.splatMesh?.getSplatCount?.() ?? null,
                drawingBufferWidth: three.getContext().drawingBufferWidth,
                drawingBufferHeight: three.getContext().drawingBufferHeight,
                rendererPixelRatio: three.getPixelRatio(),
                devicePixelRatio: window.devicePixelRatio || 1,
                cssWidth: canvas.clientWidth,
                cssHeight: canvas.clientHeight,
                renderMode: viewer.renderMode,
                sortPolicy: {
                    gpuAcceleratedSort: viewer.gpuAcceleratedSort,
                    integerBasedSort: viewer.integerBasedSort,
                    sharedMemoryForWorkers: viewer.sharedMemoryForWorkers,
                    splatSortDistanceMapPrecision: viewer.splatSortDistanceMapPrecision,
                    dynamicMode: viewer.splatMesh?.dynamicMode,
                },
                loop: 'GaussianSplatRenderer.render() drives its own requestAnimationFrame '
                    + 'loop and calls viewer.update() + viewer.render() on every tick. '
                    + "Viewer.selfDrivenUpdate()'s vsyncNum = 4 divider is not on this path.",
            };
            r.expressionSource = {
                mode: options.expressionPath === 'provider' ? 'fixture-provider' : 'fixture-cache',
                fixture: fixtureName,
                fps: fixture.fps,
                frames: fixture.frames.length,
                names: fixture.expression_names.length,
                clock: 'AudioContext.currentTime (no audio playing)',
                jpMouthCorrection: 'applied by LAMWebSocketManager, unchanged',
            };

            // The clock LAM's own expression timing is built on.
            try {
                this.audioContext = new AudioContext();
                await this.audioContext.resume();
                this.driverStartClock = this.audioContext.currentTime;
            } catch {
                this.audioContext = null;
                this.driverStartClock = performance.now();
                r.notes.push('AudioContext unavailable: the expression driver fell back to '
                    + 'performance.now(), and the audioClock column is null');
            }

            try { manager.setExpressionNames(fixture.expression_names); } catch { /* noop */ }
            this.startExpressionDriver(manager, options);

            r.notInstrumented = this.installHooks(gsr, viewer);

            for (let repeat = 1; repeat <= options.repeats; repeat++) {
                if (this.abort) break;
                r.runs.push(await this.measureRun(repeat, options, viewer, three));
            }

            r.comparison = this.buildComparison(r.runs);
            this.classify(r);
        } finally {
            this.detach();
            this.stopExpressionDriver(manager);
            try { await this.audioContext?.close(); } catch { /* noop */ }
            this.audioContext = null;
            this.timers?.dispose?.();
            this.timers = null;
            this.live.phase = 'idle';
            this.live.step = '';
            this.running = false;
            r.finishedAt = new Date().toISOString();
        }

        return r;
    }

    private async measureRun(
        repeat: number,
        options: UikaLamBaselineOptions,
        viewer: any,
        three: any,
    ): Promise<UikaLamBaselineRun> {
        const gl: WebGL2RenderingContext | null = three.getContext?.() ?? null;
        const ext = gl ? gl.getExtension('EXT_disjoint_timer_query_webgl2') : null;
        this.timers = gl && ext ? new GpuTimerPool(gl, ext) : null;
        if (this.timers) this.timers.maxValidMs = options.measureMs;

        this.live.step = `repeat ${repeat}`;
        this.live.phase = 'warmup';
        const warmupStart = performance.now();
        await this.waitFor(() => performance.now() - warmupStart >= options.warmupMs);
        const warmupMs = performance.now() - warmupStart;

        // reset
        this.renderStarts = [];
        this.renderCount = 0;
        this.threeRenderCalls = [];
        this.sortSubmissions = 0;
        this.sortCompletions = 0;
        this.workerSortMs = [];
        this.indexUpdateMs = [];
        this.sortSubmitMs = [];
        this.expressionSamples = [];
        this.selectedCount = 0;
        this.driverTicks = 0;
        this.timers?.reset();
        this.timers?.setCollecting(true);

        const glErrors0 = this.readGlErrors(gl);
        const pageErrors0 = this.pageErrors;
        let visibilityLostMs = 0;
        let hiddenSince: number | null = document.visibilityState === 'hidden' ? performance.now() : null;
        const onVis = () => {
            if (document.visibilityState === 'hidden') hiddenSince = performance.now();
            else if (hiddenSince !== null) { visibilityLostMs += performance.now() - hiddenSince; hiddenSince = null; }
        };
        document.addEventListener('visibilitychange', onVis);

        this.live.phase = 'measuring';
        this.collecting = true;
        const measureStart = performance.now();
        await this.waitFor(
            () => performance.now() - measureStart >= options.measureMs,
            () => {
                this.live.frame = this.lastPushedFrame;
                if (this.renderStarts.length > 2) {
                    this.live.p95 = summariseStage(this.intervals()).p95;
                }
            },
        );
        this.collecting = false;
        const measuredMs = performance.now() - measureStart;
        const framesAtWindowEnd = this.renderCount;

        // A short drain so the GPU timer queries issued inside the window can be read back.
        this.live.phase = 'draining';
        const drainStart = performance.now();
        await this.waitFor(() => performance.now() - drainStart >= 250);
        const framesDuringDrain = this.renderCount - framesAtWindowEnd;

        document.removeEventListener('visibilitychange', onVis);
        if (hiddenSince !== null) visibilityLostMs += performance.now() - hiddenSince;
        this.timers?.setCollecting(false);

        const intervals = this.intervals();
        const effectiveFPS = measuredMs > 0 ? framesAtWindowEnd / (measuredMs / 1000) : 0;
        this.live.fps = effectiveFPS;

        const stage = (samples: number[], ok: boolean): UikaLamStage =>
            (ok ? summariseStage(samples) : 'not instrumented');
        const has = (label: string) => !this.report!.notInstrumented.some((x) => x.startsWith(label));

        return {
            repeat,
            warmupMs,
            measuredMs,
            renderedFrames: framesAtWindowEnd,
            framesDuringDrain,
            effectiveFPS,
            wallInterval: summariseStage(intervals),
            gpuDraw: this.timers ? summariseStage(this.timers.drawMs) : 'not instrumented',
            sortSubmission: stage(this.sortSubmitMs, has('viewer.runSplatSort')),
            workerSort: stage(this.workerSortMs, has('sortWorker.onmessage')),
            indexUpdate: stage(this.indexUpdateMs, has('splatMesh.updateRenderIndexes')),
            threeRenderCallsPerFrame: summariseStage(this.threeRenderCalls),
            sortSubmissions: this.sortSubmissions,
            sortCompletions: this.sortCompletions,
            effectiveSortHz: measuredMs > 0 ? this.sortCompletions / (measuredMs / 1000) : 0,
            invalidGpuTimerSamples: this.timers ? this.timers.invalidMs.length : 0,
            expression: this.summariseExpression(),
            expressionSamples: this.expressionSamples.slice(0, options.maxExpressionSamples),
            glErrors: this.readGlErrors(gl) - glErrors0,
            pageErrors: this.pageErrors - pageErrors0,
            visibilityLostMs,
        };
    }

    private intervals(): number[] {
        const out: number[] = [];
        for (let i = 1; i < this.renderStarts.length; i++) {
            out.push(this.renderStarts[i] - this.renderStarts[i - 1]);
        }
        return out;
    }

    /**
     * Polling `gl.getError()` would clear errors the LAM path is entitled to see, so this
     * returns 0 and the field is reported as such. Changing LAM's error state to measure
     * it would be exactly the kind of interference this gate forbids.
     */
    private readGlErrors(_gl: WebGL2RenderingContext | null): number {
        return 0;
    }

    // ------------------------------------------------------------- comparison

    private buildComparison(runs: UikaLamBaselineRun[]): UikaLamComparisonRow[] {
        const rows: UikaLamComparisonRow[] = [];
        if (runs.length > 0) {
            const p95s = runs.map((x) => x.wallInterval.p95);
            const draws = runs
                .map((x) => (x.gpuDraw === 'not instrumented' ? null : x.gpuDraw.p50))
                .filter((v): v is number => v !== null);
            const fps = mean(runs.map((x) => x.effectiveFPS));
            const p95 = mean(p95s);
            rows.push({
                name: 'LAM reference (production path)',
                repeats: runs.length,
                fps,
                p50: mean(runs.map((x) => x.wallInterval.p50)),
                p95,
                p95Spread: spread(p95s),
                gpuDrawP50: draws.length > 0 ? mean(draws) : null,
                meetsAbsoluteGate: fps >= ABSOLUTE_GATE.minFps && p95 <= ABSOLUTE_GATE.maxWallP95Ms,
            });
        }
        for (const [name, v] of Object.entries(GATE4B2C_UIKA_REFERENCE.runs)) {
            const fps = mean([...v.fps]);
            const p95 = mean([...v.p95]);
            rows.push({
                name,
                repeats: v.fps.length,
                fps,
                p50: mean([...v.p50]),
                p95,
                p95Spread: spread([...v.p95]),
                gpuDrawP50: mean([...v.gpuDrawP50]),
                meetsAbsoluteGate: fps >= ABSOLUTE_GATE.minFps && p95 <= ABSOLUTE_GATE.maxWallP95Ms,
            });
        }
        return rows;
    }

    private classify(r: UikaLamBaselineReport): void {
        const lam = r.comparison?.find((x) => x.name.startsWith('LAM reference'));
        const uikaC = r.comparison?.find((x) => x.name.startsWith('UIKA C'));
        if (!lam || !uikaC) {
            r.verdictBasis.push('the comparison table is incomplete');
            return;
        }
        if (lam.repeats < ENVELOPE_RULES.minRepeats) {
            r.verdictBasis.push(`LAM was measured ${lam.repeats} time(s); `
                + `${ENVELOPE_RULES.minRepeats} repeats are required`);
            return;
        }
        const thin = r.runs.filter((x) => x.wallInterval.count < ENVELOPE_RULES.minIntervalSamples);
        if (thin.length > 0) {
            r.verdictBasis.push(`LAM repeat(s) ${thin.map((x) => x.repeat).join(', ')} carried `
                + `fewer than ${ENVELOPE_RULES.minIntervalSamples} measured intervals`);
            return;
        }

        const gap = uikaC.p95 - lam.p95;
        const combinedSpread = (lam.p95Spread + uikaC.p95Spread) * ENVELOPE_RULES.spreadMultiplier;
        r.verdictBasis.push(`LAM p95 ${lam.p95.toFixed(2)} ms (spread ${lam.p95Spread.toFixed(2)}), `
            + `UIKA C p95 ${uikaC.p95.toFixed(2)} ms (spread ${uikaC.p95Spread.toFixed(2)})`);
        r.verdictBasis.push(`gap ${gap.toFixed(2)} ms against a combined repeat spread of `
            + `${combinedSpread.toFixed(2)} ms`);
        r.verdictBasis.push(`LAM ${lam.fps.toFixed(2)} fps, UIKA C ${uikaC.fps.toFixed(2)} fps`);

        if (gap > combinedSpread) {
            r.verdict = 'UIKA_RUNTIME_BEHIND_LAM';
            r.verdictBasis.push('UIKA C is behind LAM by more than the two measurements\' own '
                + 'run-to-run spread');
            return;
        }
        if (uikaC.fps >= ENVELOPE_RULES.minUikaFps) {
            r.verdict = 'UIKA_WITHIN_LAM_RUNTIME_ENVELOPE';
            r.verdictBasis.push(`the gap is inside the combined spread and UIKA C holds `
                + `${ENVELOPE_RULES.minUikaFps}+ fps`);
            return;
        }
        r.verdictBasis.push(`the gap is inside the combined spread but UIKA C is below `
            + `${ENVELOPE_RULES.minUikaFps} fps`);
    }

    /**
     * Wait until every object this harness hooks exists. Returns what is still missing so
     * a failure names the piece rather than the set.
     */
    private async waitForLamReady(
        manager: any,
        timeoutMs: number,
    ): Promise<{ ok: boolean; missing: string[] }> {
        const started = performance.now();
        let missing: string[] = [];
        for (;;) {
            missing = [];
            const gsr = manager?.renderer;
            const viewer = gsr?.viewer;
            if (!gsr) missing.push('LAMWebSocketManager.renderer');
            if (!viewer) missing.push('GaussianSplatRenderer.viewer');
            if (viewer && !viewer.renderer) missing.push('Viewer.renderer (THREE.WebGLRenderer)');
            if (viewer && !viewer.splatMesh) missing.push('Viewer.splatMesh');
            if (viewer && !viewer.sortWorker) missing.push('Viewer.sortWorker');
            if (gsr && typeof gsr.getExpressionData !== 'function') {
                missing.push('GaussianSplatRenderer.getExpressionData');
            }
            if (missing.length === 0) return { ok: true, missing };
            if (this.abort || performance.now() - started >= timeoutMs) return { ok: false, missing };
            await new Promise<void>((resolve) => { requestAnimationFrame(() => resolve()); });
        }
    }

    private waitFor(done: () => boolean, each?: () => void): Promise<void> {
        return new Promise((resolve) => {
            const step = () => {
                each?.();
                if (this.abort || done()) { resolve(); return; }
                requestAnimationFrame(step);
            };
            requestAnimationFrame(step);
        });
    }
}
