// UIKA Native Runtime v1.1 — Gate 4B-2B-0 DPR1 tail-latency isolation
//
// Gate 4B-2A on the real GPU: correctness PASS, performance FAIL. The pre-deformation
// path itself measured a large improvement (full DPR 12.56 -> 23.38 fps, GPU draw p50
// 74.90 -> 38.42 ms, GPU sort p50 5.95 -> 0.66 ms; at pixelRatio 1.0, 45.19 fps with
// pre-deformation p50 2.03 ms, draw p50 17.71 ms, sort p50 0.62 ms) — but wall p95 was
// 68.90 ms. Average throughput is past 30 fps at DPR 1; the tail is what fails
// acceptance. This gate finds the stall. It does not optimise anything.
//
//   Run A  NORMAL                   the sort pipeline as it stands
//   Run B  SORT SUSPENDED           diagnostic control: is the tail the sort at all
//   Run C  DISTANCE / READBACK ONLY GPU distance + fence + getBufferSubData
//   Run D  DISTANCE + CPU SORT      the above plus the CPU counting sort
//
// Runs B, C and D are diagnostic truncations and are not valid for any visual or
// correctness judgement. Full DPR is not re-measured: at a pre-deformed draw p50 of
// 38.42 ms the draw alone exceeds the 33.3 ms budget, so FULL_DPR_PERF_FAIL already
// stands and the tail work belongs at DPR 1.

import type { UikaNativeRuntime } from './uika-native-runtime';
import type { UikaNativeReplay } from './uika-native-replay';
import type { UikaFrameTick, UikaSortStage, UikaDrawingBufferInfo } from './renderer';
import {
    GpuTimerPool,
    collectGpuInfo,
    summariseIntervals,
    type UikaGpuInfo,
    type UikaIntervalStats,
} from './uika-native-benchmark';
import { UikaPredeformPass } from './predeform/uika-predeform-pass';

/**
 * §3: how far below the fence wait a lifecycle total may fall before it is recorded as an
 * instrumentation error rather than a measurement. A decision rule for this gate.
 */
export const LIFECYCLE_INVARIANT_EPSILON_MS = 0.5;

/** §11: the target is unchanged; only the instrument is new. */
export const TAIL_TARGET = { minFps: 30, maxExactWallP95Ms: 33.3 } as const;

export type UikaTailRunName =
    | 'A-normal'
    | 'B-sort-suspended'
    | 'C-distance-readback-only'
    | 'D-distance-plus-cpu-sort';

export interface UikaStageStats {
    count: number;
    mean: number;
    p50: number;
    p90: number;
    p95: number;
    p99: number;
    max: number;
}

function emptyStage(): UikaStageStats {
    return { count: 0, mean: 0, p50: 0, p90: 0, p95: 0, p99: 0, max: 0 };
}

export function summariseStage(samples: number[]): UikaStageStats {
    if (samples.length === 0) return emptyStage();
    const sorted = [...samples].sort((a, b) => a - b);
    const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
    let sum = 0;
    for (const v of samples) sum += v;
    return {
        count: samples.length,
        mean: sum / samples.length,
        p50: at(0.5), p90: at(0.9), p95: at(0.95), p99: at(0.99),
        max: sorted[sorted.length - 1],
    };
}

/** §6: one entry per actual rendered frame. */
export interface UikaTailFrameRecord {
    index: number;
    exactWallInterval: number | null;
    weightChangedSincePreviousFrame: boolean;
    predeformRanSincePreviousFrame: boolean;
    sortSubmittedSincePreviousFrame: boolean;
    sortCompletedSincePreviousFrame: boolean;
    sortReadbackOccurred: boolean;
    cpuSortOccurred: boolean;
    renderIndexUpdateOccurred: boolean;
}

export interface UikaTailRun {
    name: UikaTailRunName;
    description: string;
    sortStage: UikaSortStage;
    sortSuspended: boolean;
    buffer: UikaDrawingBufferInfo;
    warmupMs: number;
    measuredMs: number;
    renderedFrames: number;
    effectiveFPS: number;
    /** §3: measured inside render(), not polled from a counter. */
    exactFrameInterval: UikaStageStats;
    /** The old polled interval, kept side by side so the two can be compared. */
    polledFrameInterval: UikaIntervalStats;
    gpu: {
        available: boolean;
        predeformMs: UikaIntervalStats | null;
        drawMs: UikaIntervalStats | null;
        sortMs: UikaIntervalStats | null;
        invalidSamples: number;
    };
    /** §4: the sort lifecycle, stage by stage. */
    sortLifecycle: {
        submitCpuMs: UikaStageStats;
        fenceWaitMs: UikaStageStats;
        readbackMs: UikaStageStats;
        cpuSortMs: UikaStageStats;
        indexUpdateMs: UikaStageStats;
        totalLifecycleMs: UikaStageStats;
        fencePolls: UikaStageStats;
        /** §3: must be 0. Non-zero means the lifecycle timing is wrong, not the GPU slow. */
        lifecycleInvariantFailures: number;
        lifecycleInvariantDetails: Array<{ totalMs: number; fenceMs: number }>;
    };
    /** §5: how often a sort was wanted, started, finished, or could not start. */
    sortCounters: {
        sortRequestedCount: number;
        sortSubmittedCount: number;
        sortCompletedCount: number;
        sortPendingSkipCount: number;
        pendingDurationMs: UikaStageStats;
    };
    /** §6: frames split by whether a sort completed during them. */
    frameCorrelation: {
        frames: number;
        framesWithSortCompletion: number;
        framesWithoutSortCompletion: number;
        withSortCompletion: UikaStageStats;
        withoutSortCompletion: UikaStageStats;
        framesWithWeightChange: number;
        framesWithPredeform: number;
        framesWithReadback: number;
        framesWithCpuSort: number;
        framesWithIndexUpdate: number;
    };
    predeformPassCount: number;
    weightUploadCount: number;
    glErrors: number;
    pageErrors: number;
    visibilityLostMs: number;
    valid: boolean;
    invalidReason: string | null;
    /** Against §11, using the exact interval. Diagnostic truncations are not acceptance. */
    meetsTarget: boolean | null;
    /** Kept for inspection; capped so the JSON stays readable. */
    frameRecords: UikaTailFrameRecord[];
}

export type UikaTailClassification =
    | 'SORT_PIPELINE_NOT_PRIMARY'
    | 'SORT_PIPELINE_TAIL_CONFIRMED'
    | 'READBACK_SYNC_DOMINANT'
    | 'CPU_DEPTH_SORT_DOMINANT'
    | 'INDEX_UPDATE_DOMINANT'
    | 'MIXED_SORT_COMPLETION'
    /**
     * §9 / §11: the sort pipeline carries the tail, and removing it entirely still leaves
     * the exact wall p95 above the target — so fixing the sort is not by itself a pass.
     */
    | 'SORT_PIPELINE_TAIL_CONFIRMED_BUT_RESIDUAL_TAIL'
    | 'UNRESOLVED';

export interface UikaTailReport {
    spec: 'UIKA Native Runtime v1.1 Gate 4B-2B-0';
    startedAt: string;
    finishedAt: string | null;
    gpu: UikaGpuInfo;
    realGpu: boolean;
    target: typeof TAIL_TARGET;
    runs: UikaTailRun[];
    analysis: {
        normalExactP95: number | null;
        suspendedExactP95: number | null;
        distanceOnlyExactP95: number | null;
        cpuSortExactP95: number | null;
        /** How much of the p95 the sort pipeline accounts for, as a share of Run A. */
        sortShareOfP95: number | null;
        readbackShareOfP95: number | null;
        cpuSortShareOfP95: number | null;
        indexUpdateShareOfP95: number | null;
    } | null;
    classification: UikaTailClassification;
    /**
     * Reported separately from `classification` so the finding already established on the
     * real GPU is never retracted by a later run's wording: the sort pipeline is a major
     * contributor to the tail (46.8% of Run A's p95 measured).
     */
    sortPipelineTailConfirmed: boolean | null;
    /** How far Run B's p95 still sits above the target. Positive means a residual tail. */
    residualTailAboveTargetMs: number | null;
    /** Never asserted true: Run B above the target means the sort is not the sole source. */
    sortIsSoleSourceOfTail: boolean | null;
    classificationBasis: string[];
    notes: string[];
}

export interface UikaTailOptions {
    warmupMs: number;
    measureMs: number;
    /**
     * §5: C and D now run by default. The earlier "only when Run B cleared the target"
     * rule would have skipped them on the real-GPU run, where Run B landed at 35.00 ms
     * against a 33.3 ms target — and the stage split is what the gate is for. `?cd=0`
     * still skips them.
     */
    forceCD: boolean | null;
    allowSoftware: boolean;
    maxFrameRecords: number;
}

export const DEFAULT_TAIL_OPTIONS: UikaTailOptions = {
    warmupMs: 6000,
    measureMs: 30000,
    forceCD: null,
    allowSoftware: false,
    maxFrameRecords: 4000,
};

/** `?warmupMs=`, `?measureMs=`, `?cd=1|0`, `?allowSoftware=1`, `?maxFrameRecords=`. */
export function tailOptionsFromUrl(): UikaTailOptions {
    const o = { ...DEFAULT_TAIL_OPTIONS };
    try {
        const q = new URLSearchParams(window.location.search);
        // Parse each number only when the parameter is present. Number(null) is 0, which
        // passes a ">= 0" test and would silently overwrite the default with zero — the
        // same defect that cost Gate 4B-1 four of its five Diagnostic 3 points.
        const warm = Number(q.get('warmupMs'));
        const meas = Number(q.get('measureMs'));
        if (Number.isFinite(warm) && warm > 0) o.warmupMs = warm;
        if (Number.isFinite(meas) && meas > 0) o.measureMs = meas;
        const rawCap = q.get('maxFrameRecords');
        if (rawCap !== null) {
            const cap = Number(rawCap);
            if (Number.isFinite(cap) && cap >= 0) o.maxFrameRecords = Math.floor(cap);
        }
        if (q.get('cd') === '1') o.forceCD = true;
        if (q.get('cd') === '0') o.forceCD = false;
        if (q.get('allowSoftware') === '1') o.allowSoftware = true;
    } catch { /* noop */ }
    return o;
}

/** Collects one run's lifecycle samples. One instance per run. */
class LifecycleCollector {
    readonly submitCpuMs: number[] = [];
    readonly fenceWaitMs: number[] = [];
    readonly readbackMs: number[] = [];
    readonly cpuSortMs: number[] = [];
    readonly indexUpdateMs: number[] = [];
    readonly totalLifecycleMs: number[] = [];
    readonly pendingDurationMs: number[] = [];
    readonly fencePolls: number[] = [];

    sortRequestedCount = 0;
    sortSubmittedCount = 0;
    sortCompletedCount = 0;
    sortPendingSkipCount = 0;

    /** Set while a sort is in flight, so the next frame's tags can see it. */
    readbackSinceFrame = false;
    cpuSortSinceFrame = false;
    indexUpdateSinceFrame = false;
    sortCompletedSinceFrame = false;

    /**
     * §3: an instrumentation invariant. The fence wait happens inside the lifecycle, so
     * a total below it means the lifecycle was mis-timed, not that the GPU was fast.
     */
    lifecycleInvariantFailures = 0;
    readonly lifecycleInvariantDetails: Array<{ totalMs: number; fenceMs: number }> = [];

    private collecting = false;
    private submitStartedAt = 0;
    private lifecycleStartedAt = 0;
    private currentFenceWaitMs: number | null = null;
    private fenceStartedAt = 0;
    private readbackStartedAt = 0;
    private cpuSortStartedAt = 0;
    private indexUpdateStartedAt = 0;
    private pendingSince: number | null = null;

    setCollecting(on: boolean): void { this.collecting = on; }

    // --- viewer side -----------------------------------------------------
    /**
     * §1 / §2: a counter and nothing else. runSort() is entered on every frame whose
     * weights changed, including while a sort is still in flight, so writing a lifecycle
     * timestamp here made `totalLifecycleMs` measure "latest request -> completion"
     * instead of "submitted sort -> completion". That is what produced a total of 2.9 ms
     * p50 alongside a 100.2 ms p50 fence wait, which cannot both describe one lifecycle.
     */
    requested(): void {
        if (this.collecting) this.sortRequestedCount++;
    }
    /** Counts, and measures how long the in-flight sort had been pending. Never a start. */
    pendingSkip(at: number): void {
        if (!this.collecting) return;
        this.sortPendingSkipCount++;
        if (this.pendingSince !== null) this.pendingDurationMs.push(at - this.pendingSince);
    }
    submitStart(at: number): void {
        // The lifecycle starts here, with the sort that is actually submitted.
        this.lifecycleStartedAt = at;
        this.submitStartedAt = at;
        this.pendingSince = at;
        this.currentFenceWaitMs = null;
        if (this.collecting) this.sortSubmittedCount++;
    }
    submitEnd(at: number): void {
        if (this.collecting) this.submitCpuMs.push(at - this.submitStartedAt);
    }
    cpuSortStart(at: number): void { this.cpuSortStartedAt = at; }
    cpuSortEnd(at: number): void {
        if (!this.collecting) return;
        this.cpuSortMs.push(at - this.cpuSortStartedAt);
        this.cpuSortSinceFrame = true;
    }
    indexUpdateStart(at: number): void { this.indexUpdateStartedAt = at; }
    indexUpdateEnd(at: number): void {
        if (!this.collecting) return;
        this.indexUpdateMs.push(at - this.indexUpdateStartedAt);
        this.indexUpdateSinceFrame = true;
    }
    completed(at: number): void {
        this.pendingSince = null;
        if (!this.collecting) return;
        this.sortCompletedCount++;
        const total = at - this.lifecycleStartedAt;
        this.totalLifecycleMs.push(total);
        // §3: the fence wait is contained in the lifecycle. EPSILON covers the timer
        // granularity and the submit/CPU boundaries; it is a decision rule, not a measurement.
        if (this.currentFenceWaitMs !== null
            && total + LIFECYCLE_INVARIANT_EPSILON_MS < this.currentFenceWaitMs) {
            this.lifecycleInvariantFailures++;
            if (this.lifecycleInvariantDetails.length < 16) {
                this.lifecycleInvariantDetails.push({ totalMs: total, fenceMs: this.currentFenceWaitMs });
            }
        }
        this.currentFenceWaitMs = null;
        this.sortCompletedSinceFrame = true;
    }
    failed(): void { this.pendingSince = null; this.currentFenceWaitMs = null; }

    // --- pass side -------------------------------------------------------
    fenceWaitStart(at: number): void { this.fenceStartedAt = at; }
    fenceWaitEnd(at: number, polls: number): void {
        const elapsed = at - this.fenceStartedAt;
        this.currentFenceWaitMs = elapsed;
        if (!this.collecting) return;
        this.fenceWaitMs.push(elapsed);
        this.fencePolls.push(polls);
    }
    readbackStart(at: number): void { this.readbackStartedAt = at; }
    readbackEnd(at: number): void {
        if (!this.collecting) return;
        this.readbackMs.push(at - this.readbackStartedAt);
        this.readbackSinceFrame = true;
    }

    /** Called after a frame record is written. */
    clearFrameFlags(): void {
        this.readbackSinceFrame = false;
        this.cpuSortSinceFrame = false;
        this.indexUpdateSinceFrame = false;
        this.sortCompletedSinceFrame = false;
    }
}

export class UikaTailIsolation {
    private report: UikaTailReport | null = null;
    private pass: UikaPredeformPass | null = null;
    private running = false;
    private abort = false;
    private pageErrors = 0;
    private live = { step: '', phase: 'idle', elapsedMs: 0, exactP95: 0, fps: 0 };

    constructor(
        private readonly runtime: UikaNativeRuntime,
        private readonly replay: UikaNativeReplay,
    ) {
        window.addEventListener('error', () => { this.pageErrors++; });
        window.addEventListener('unhandledrejection', () => { this.pageErrors++; });
    }

    getLive() { return { ...this.live }; }
    getReport(): UikaTailReport | null { return this.report; }
    isRunning(): boolean { return this.running; }
    stop(): void { this.abort = true; }

    private viewer(): any { return this.runtime.getViewer(); }
    private gl(): WebGL2RenderingContext | null { return this.viewer()?.renderer?.getContext?.() ?? null; }

    async run(options: UikaTailOptions = DEFAULT_TAIL_OPTIONS): Promise<UikaTailReport> {
        if (this.running) throw new Error('UIKA Gate 4B-2B-0: already running');
        this.running = true;
        this.abort = false;

        const viewer = this.viewer();
        const gpu = collectGpuInfo(viewer?.renderer?.domElement ?? null);
        this.report = {
            spec: 'UIKA Native Runtime v1.1 Gate 4B-2B-0',
            startedAt: new Date().toISOString(),
            finishedAt: null,
            gpu,
            realGpu: !gpu.isSoftware && gpu.unmaskedAvailable,
            target: TAIL_TARGET,
            runs: [],
            analysis: null,
            classification: 'UNRESOLVED',
            sortPipelineTailConfirmed: null,
            residualTailAboveTargetMs: null,
            sortIsSoleSourceOfTail: null,
            classificationBasis: [],
            notes: [
                'pixelRatio 1.0, pre-deformed, real A2E only; full DPR is not re-measured '
                + 'because the pre-deformed draw p50 of 38.42 ms already exceeds the 33.3 ms budget',
                'Runs B, C and D are diagnostic truncations of the sort pipeline and are not '
                + 'valid for any visual or correctness judgement',
                'measurement only: no algorithm, threading, frequency or upload change',
                'fenceWaitMs is wall-clock elapsed across asynchronous setTimeout polls. It is '
                + 'NOT main-thread blocking time, and it is not read as such: how much of it '
                + 'lands on the wall interval is what Run C measures',
                'totalLifecycleMs is measured from the SUBMITTED sort, not from the latest '
                + 'request; the earlier build timed the latter and its totalLifecycleMs is void',
            ],
        };
        const r = this.report;

        try {
            if (gpu.isSoftware && !options.allowSoftware) {
                r.classification = 'UNRESOLVED';
                r.classificationBasis.push(`software renderer (${gpu.softwareMatches.join(', ')}): `
                    + 'tail latency on a software rasteriser is not evidence');
                return r;
            }

            const handles = viewer.getPoCHandles();
            if (!handles) throw new Error('the viewer has no renderer or splat mesh yet');

            this.pass = new UikaPredeformPass();
            const layout = this.pass.init(handles);

            // The pre-deformed path, at pixelRatio 1.0 (§13: only setPixelRatio moves, so
            // the clip-space geometry is unchanged and only the raster sample count drops).
            viewer.setPredeformCenterTexture(this.pass.getTexture(), layout.textureWidth, layout.textureHeight);
            viewer.setDistanceProvider((m: any, out: Float32Array) => this.pass!.computeDistances(m, out));
            viewer.setPreRenderHook(() => { this.pass?.runIfDirty(); });
            viewer.setExpressionWeightHook(() => { this.pass?.markDirty(); });
            const dpr = window.devicePixelRatio || 1;
            viewer.setDrawingBufferScale(1 / dpr);

            r.runs.push(await this.measureRun('A-normal', 'full', false, options));
            if (!this.abort) r.runs.push(await this.measureRun('B-sort-suspended', 'full', true, options));

            const runCD = options.forceCD ?? true;
            if (runCD && !this.abort) {
                r.runs.push(await this.measureRun('C-distance-readback-only', 'distance', false, options));
                if (!this.abort) {
                    r.runs.push(await this.measureRun('D-distance-plus-cpu-sort', 'distance+cpuSort', false, options));
                }
            } else {
                r.notes.push('Runs C and D were skipped by request (?cd=0)');
            }

            r.analysis = this.analyse();
            this.classify();
        } finally {
            try {
                viewer?.setFrameTickHook?.(null);
                viewer?.setSortLifecycleRecorder?.(null);
                viewer?.setDiagnosticSortStage?.('full');
                viewer?.setSortSuspended?.(false);
                viewer?.setPreRenderHook?.(null);
                viewer?.setExpressionWeightHook?.(null);
                viewer?.setDistanceProvider?.(null);
                viewer?.setPredeformCenterTexture?.(null, 0, 0);
                viewer?.setDrawingBufferScale?.(1);
                viewer?.setGpuTimer?.(null);
            } catch { /* noop */ }
            this.pass?.setDistanceLifecycleRecorder(null);
            this.pass?.dispose();
            this.pass = null;
            this.replay.stop();
            this.runtime.setExpressionSource(null);
            this.runtime.setNeutral();
            this.live.phase = 'idle';
            this.live.step = '';
            this.running = false;
            r.finishedAt = new Date().toISOString();
        }

        return r;
    }

    private async measureRun(
        name: UikaTailRunName,
        stage: UikaSortStage,
        suspended: boolean,
        options: UikaTailOptions,
    ): Promise<UikaTailRun> {
        const viewer = this.viewer();
        const gl = this.gl();
        const ext = gl ? gl.getExtension('EXT_disjoint_timer_query_webgl2') : null;
        const timers = gl && ext ? new GpuTimerPool(gl, ext) : null;
        viewer.setGpuTimer?.(timers);
        this.pass!.setGpuTimer(timers as any);

        const collector = new LifecycleCollector();
        viewer.setSortLifecycleRecorder({
            requested: () => collector.requested(),
            pendingSkip: (at: number) => collector.pendingSkip(at),
            submitStart: (at: number) => collector.submitStart(at),
            submitEnd: (at: number) => collector.submitEnd(at),
            cpuSortStart: (at: number) => collector.cpuSortStart(at),
            cpuSortEnd: (at: number) => collector.cpuSortEnd(at),
            indexUpdateStart: (at: number) => collector.indexUpdateStart(at),
            indexUpdateEnd: (at: number) => collector.indexUpdateEnd(at),
            completed: (at: number) => collector.completed(at),
            failed: () => collector.failed(),
        });
        this.pass!.setDistanceLifecycleRecorder({
            fenceWaitStart: (at: number) => collector.fenceWaitStart(at),
            fenceWaitEnd: (at: number, polls: number) => collector.fenceWaitEnd(at, polls),
            readbackStart: (at: number) => collector.readbackStart(at),
            readbackEnd: (at: number) => collector.readbackEnd(at),
        });

        viewer.setDiagnosticSortStage(stage);
        viewer.setSortSuspended(suspended);

        this.replay.stop();
        this.runtime.setExpressionSource(null);
        this.replay.start_();
        this.runtime.setExpressionSource(() => this.replay.tick());

        const descriptions: Record<UikaTailRunName, string> = {
            'A-normal': 'the sort pipeline exactly as it stands',
            'B-sort-suspended': 'diagnostic control: no sort at all, everything else identical',
            'C-distance-readback-only': 'GPU distance + fence + getBufferSubData; no CPU sort, '
                + 'no render-index update',
            'D-distance-plus-cpu-sort': 'the above plus the CPU counting sort; no render-index update',
        };

        this.live.step = name;
        this.live.phase = 'warmup';
        const warmupStart = performance.now();
        await this.waitFor(() => performance.now() - warmupStart >= options.warmupMs);
        const warmupMs = performance.now() - warmupStart;

        // --- measure -----------------------------------------------------
        const exactIntervals: number[] = [];
        const frameRecords: UikaTailFrameRecord[] = [];
        const withCompletion: number[] = [];
        const withoutCompletion: number[] = [];
        let framesWithWeightChange = 0;
        let framesWithPredeform = 0;
        let framesWithReadback = 0;
        let framesWithCpuSort = 0;
        let framesWithIndexUpdate = 0;
        let previousStart: number | null = null;
        let frameIndex = 0;
        let collecting = false;
        let lastUploadCount = this.replay.getStats().weightUploadCount;
        let lastPassCount = this.pass!.getStats().passCount;

        viewer.setFrameTickHook((tick: UikaFrameTick) => {
            if (!collecting) { previousStart = tick.startedAt; collector.clearFrameFlags(); return; }
            const interval = previousStart === null ? null : tick.startedAt - previousStart;
            previousStart = tick.startedAt;
            if (interval !== null) exactIntervals.push(interval);

            const uploads = this.replay.getStats().weightUploadCount;
            const passes = this.pass!.getStats().passCount;
            const weightChanged = uploads !== lastUploadCount;
            const predeformRan = passes !== lastPassCount;
            lastUploadCount = uploads;
            lastPassCount = passes;

            const record: UikaTailFrameRecord = {
                index: frameIndex++,
                exactWallInterval: interval,
                weightChangedSincePreviousFrame: weightChanged,
                predeformRanSincePreviousFrame: predeformRan,
                sortSubmittedSincePreviousFrame: tick.sortSubmitted,
                sortCompletedSincePreviousFrame: collector.sortCompletedSinceFrame,
                sortReadbackOccurred: collector.readbackSinceFrame,
                cpuSortOccurred: collector.cpuSortSinceFrame,
                renderIndexUpdateOccurred: collector.indexUpdateSinceFrame,
            };
            if (weightChanged) framesWithWeightChange++;
            if (predeformRan) framesWithPredeform++;
            if (record.sortReadbackOccurred) framesWithReadback++;
            if (record.cpuSortOccurred) framesWithCpuSort++;
            if (record.renderIndexUpdateOccurred) framesWithIndexUpdate++;
            if (interval !== null) {
                (record.sortCompletedSincePreviousFrame ? withCompletion : withoutCompletion).push(interval);
            }
            if (frameRecords.length < options.maxFrameRecords) frameRecords.push(record);
            collector.clearFrameFlags();
        });

        timers?.reset();
        if (timers) timers.maxValidMs = options.measureMs;
        timers?.setCollecting(true);
        collector.setCollecting(true);
        this.replay.resetInstrumentation();
        this.pass!.resetStats();

        const polled: number[] = [];
        let lastFrames = viewer.stats.renderedFrames;
        let lastAt = performance.now();
        const frames0 = viewer.stats.renderedFrames;
        const glErrors0 = viewer.stats.glErrorCount;
        const pageErrors0 = this.pageErrors;
        let visibilityLostMs = 0;
        let hiddenSince: number | null = document.visibilityState === 'hidden' ? performance.now() : null;
        const onVis = () => {
            if (document.visibilityState === 'hidden') hiddenSince = performance.now();
            else if (hiddenSince !== null) { visibilityLostMs += performance.now() - hiddenSince; hiddenSince = null; }
        };
        document.addEventListener('visibilitychange', onVis);

        this.live.phase = 'measuring';
        collecting = true;
        const measureStart = performance.now();
        await this.waitFor(
            () => performance.now() - measureStart >= options.measureMs,
            () => {
                const frames = viewer.stats.renderedFrames;
                if (frames > lastFrames) {
                    const now = performance.now();
                    const advanced = frames - lastFrames;
                    const dt = (now - lastAt) / advanced;
                    for (let i = 0; i < advanced; i++) polled.push(dt);
                    lastFrames = frames;
                    lastAt = now;
                }
                if (exactIntervals.length > 0) {
                    this.live.exactP95 = summariseStage(exactIntervals).p95;
                }
            },
        );
        collecting = false;
        const measuredMs = performance.now() - measureStart;
        document.removeEventListener('visibilitychange', onVis);
        if (hiddenSince !== null) visibilityLostMs += performance.now() - hiddenSince;
        timers?.setCollecting(false);
        collector.setCollecting(false);
        viewer.setFrameTickHook(null);
        viewer.setSortLifecycleRecorder(null);
        this.pass!.setDistanceLifecycleRecorder(null);

        const renderedFrames = viewer.stats.renderedFrames - frames0;
        const effectiveFPS = measuredMs > 0 ? renderedFrames / (measuredMs / 1000) : 0;
        this.live.fps = effectiveFPS;
        const exact = summariseStage(exactIntervals);
        const replayStats = this.replay.getStats();

        const run: UikaTailRun = {
            name,
            description: descriptions[name],
            sortStage: stage,
            sortSuspended: suspended,
            buffer: viewer.getDrawingBufferInfo(),
            warmupMs,
            measuredMs,
            renderedFrames,
            effectiveFPS,
            exactFrameInterval: exact,
            polledFrameInterval: summariseIntervals(polled),
            gpu: timers ? {
                available: true,
                predeformMs: summariseIntervals(timers.predeformMs),
                drawMs: summariseIntervals(timers.drawMs),
                sortMs: summariseIntervals(timers.sortMs),
                invalidSamples: timers.invalidMs.length,
            } : { available: false, predeformMs: null, drawMs: null, sortMs: null, invalidSamples: 0 },
            sortLifecycle: {
                submitCpuMs: summariseStage(collector.submitCpuMs),
                fenceWaitMs: summariseStage(collector.fenceWaitMs),
                readbackMs: summariseStage(collector.readbackMs),
                cpuSortMs: summariseStage(collector.cpuSortMs),
                indexUpdateMs: summariseStage(collector.indexUpdateMs),
                totalLifecycleMs: summariseStage(collector.totalLifecycleMs),
                fencePolls: summariseStage(collector.fencePolls),
                lifecycleInvariantFailures: collector.lifecycleInvariantFailures,
                lifecycleInvariantDetails: collector.lifecycleInvariantDetails.slice(),
            },
            sortCounters: {
                sortRequestedCount: collector.sortRequestedCount,
                sortSubmittedCount: collector.sortSubmittedCount,
                sortCompletedCount: collector.sortCompletedCount,
                sortPendingSkipCount: collector.sortPendingSkipCount,
                pendingDurationMs: summariseStage(collector.pendingDurationMs),
            },
            frameCorrelation: {
                frames: frameIndex,
                framesWithSortCompletion: withCompletion.length,
                framesWithoutSortCompletion: withoutCompletion.length,
                withSortCompletion: summariseStage(withCompletion),
                withoutSortCompletion: summariseStage(withoutCompletion),
                framesWithWeightChange,
                framesWithPredeform,
                framesWithReadback,
                framesWithCpuSort,
                framesWithIndexUpdate,
            },
            predeformPassCount: this.pass!.getStats().passCount,
            weightUploadCount: replayStats.weightUploadCount,
            glErrors: viewer.stats.glErrorCount - glErrors0,
            pageErrors: this.pageErrors - pageErrors0,
            visibilityLostMs,
            valid: visibilityLostMs === 0,
            invalidReason: visibilityLostMs > 0
                ? `the tab was hidden for ${Math.round(visibilityLostMs)} ms during measurement`
                : null,
            meetsTarget: name === 'A-normal'
                ? effectiveFPS >= TAIL_TARGET.minFps && exact.p95 <= TAIL_TARGET.maxExactWallP95Ms
                  && viewer.stats.glErrorCount - glErrors0 === 0 && this.pageErrors - pageErrors0 === 0
                : null,
            frameRecords,
        };

        timers?.dispose();
        viewer.setGpuTimer?.(null);
        this.pass!.setGpuTimer(null);
        viewer.setSortSuspended(false);
        viewer.setDiagnosticSortStage('full');
        return run;
    }

    private waitFor(done: () => boolean, each?: () => void): Promise<void> {
        return new Promise((resolve) => {
            const started = performance.now();
            const step = () => {
                if (this.abort || done()) { resolve(); return; }
                each?.();
                this.live.elapsedMs = performance.now() - started;
                requestAnimationFrame(step);
            };
            requestAnimationFrame(step);
        });
    }

    private p95(name: UikaTailRunName): number | null {
        const run = this.report!.runs.find((x) => x.name === name);
        return run && run.valid && run.exactFrameInterval.count > 0 ? run.exactFrameInterval.p95 : null;
    }

    private analyse(): UikaTailReport['analysis'] {
        const a = this.p95('A-normal');
        const b = this.p95('B-sort-suspended');
        const c = this.p95('C-distance-readback-only');
        const d = this.p95('D-distance-plus-cpu-sort');
        const share = (from: number | null, to: number | null) =>
            from !== null && to !== null && a !== null && a > 0 ? (from - to) / a : null;
        return {
            normalExactP95: a,
            suspendedExactP95: b,
            distanceOnlyExactP95: c,
            cpuSortExactP95: d,
            sortShareOfP95: share(a, b),
            // A -> D removes only the index update; D -> C removes only the CPU sort;
            // C -> B removes the distance pass, its fence and its readback.
            indexUpdateShareOfP95: share(a, d),
            cpuSortShareOfP95: share(d, c),
            readbackShareOfP95: share(c, b),
        };
    }

    /**
     * §9. Decided from the measurements only. The 0.5 / 0.3 shares are decision rules for
     * this gate, not measured quantities, and no cause outside the measured stages is named.
     */
    private classify(): void {
        const r = this.report!;
        const a = r.analysis;
        const basis: string[] = [];
        const runA = r.runs.find((x) => x.name === 'A-normal');

        if (!a || a.normalExactP95 === null || a.suspendedExactP95 === null) {
            r.classification = 'UNRESOLVED';
            r.classificationBasis = ['Run A or Run B produced no valid exact-interval sample'];
            return;
        }

        basis.push(`Run A exact wall p95 ${a.normalExactP95.toFixed(2)} ms, `
            + `effectiveFPS ${runA?.effectiveFPS.toFixed(2)}, target `
            + `${TAIL_TARGET.maxExactWallP95Ms} ms / ${TAIL_TARGET.minFps} fps`);
        basis.push(`Run B (no sort) exact wall p95 ${a.suspendedExactP95.toFixed(2)} ms`);
        if (a.sortShareOfP95 !== null) {
            basis.push(`removing the sort moves the p95 by `
                + `${(a.sortShareOfP95 * 100).toFixed(1)}% of Run A's p95`);
        }
        if (runA) {
            basis.push(`sort requested ${runA.sortCounters.sortRequestedCount}, submitted `
                + `${runA.sortCounters.sortSubmittedCount}, completed `
                + `${runA.sortCounters.sortCompletedCount}, could not start because one was in `
                + `flight ${runA.sortCounters.sortPendingSkipCount}`);
            basis.push(`frames with a sort completion ${runA.frameCorrelation.framesWithSortCompletion} `
                + `(p95 ${runA.frameCorrelation.withSortCompletion.p95.toFixed(2)} ms) vs without `
                + `${runA.frameCorrelation.framesWithoutSortCompletion} `
                + `(p95 ${runA.frameCorrelation.withoutSortCompletion.p95.toFixed(2)} ms)`);
            basis.push(`lifecycle p95 — submit ${runA.sortLifecycle.submitCpuMs.p95.toFixed(2)}, `
                + `fence ${runA.sortLifecycle.fenceWaitMs.p95.toFixed(2)}, `
                + `readback ${runA.sortLifecycle.readbackMs.p95.toFixed(2)}, `
                + `CPU sort ${runA.sortLifecycle.cpuSortMs.p95.toFixed(2)}, `
                + `index update ${runA.sortLifecycle.indexUpdateMs.p95.toFixed(2)}, `
                + `total ${runA.sortLifecycle.totalLifecycleMs.p95.toFixed(2)} ms`);
        }

        // A negative share means the truncated run measured SLOWER than the fuller one,
        // which can only be noise in the p95; it is reported rather than read as a cause.
        for (const [label, value] of [
            ['sort', a.sortShareOfP95],
            ['render-index update', a.indexUpdateShareOfP95],
            ['CPU depth sort', a.cpuSortShareOfP95],
            ['distance + fence + readback', a.readbackShareOfP95],
        ] as Array<[string, number | null]>) {
            if (value !== null && value < 0) {
                basis.push(`the ${label} share is negative (${(value * 100).toFixed(1)}%): the `
                    + 'truncated run measured slower than the fuller one, which is noise in the '
                    + 'p95 and not a stage cost');
            }
        }

        // §11: how much of the tail survives with no sort at all.
        const residual = a.suspendedExactP95 - TAIL_TARGET.maxExactWallP95Ms;
        r.residualTailAboveTargetMs = residual;
        const sortShare = a.sortShareOfP95;
        r.sortPipelineTailConfirmed = sortShare !== null ? sortShare >= 0.3 : null;
        r.sortIsSoleSourceOfTail = residual > 0 ? false : null;
        if (residual > 0) {
            basis.push(`with no sort at all the exact wall p95 is still ${residual.toFixed(2)} ms `
                + `above the ${TAIL_TARGET.maxExactWallP95Ms} ms target, so the sort is not the `
                + 'sole source of the tail and fixing it is not by itself a pass');
        }

        const invariantFailures = r.runs.reduce(
            (sum, x) => sum + x.sortLifecycle.lifecycleInvariantFailures, 0);
        if (invariantFailures > 0) {
            basis.push(`${invariantFailures} lifecycle invariant failures (total below the fence `
                + 'wait): the lifecycle timing in this run is not trustworthy');
        }

        if (sortShare === null || sortShare < 0.3) {
            r.classification = 'SORT_PIPELINE_NOT_PRIMARY';
            basis.push('removing the sort entirely leaves most of the p95 in place');
        } else {
            const stages: Array<[UikaTailClassification, number | null]> = [
                ['READBACK_SYNC_DOMINANT', a.readbackShareOfP95],
                ['CPU_DEPTH_SORT_DOMINANT', a.cpuSortShareOfP95],
                ['INDEX_UPDATE_DOMINANT', a.indexUpdateShareOfP95],
            ];
            const measured = stages.filter(([, v]) => v !== null) as Array<[UikaTailClassification, number]>;
            if (measured.length === 0) {
                r.classification = residual > 0
                    ? 'SORT_PIPELINE_TAIL_CONFIRMED_BUT_RESIDUAL_TAIL'
                    : 'SORT_PIPELINE_TAIL_CONFIRMED';
                basis.push('the sort pipeline carries the tail, but Runs C and D were not '
                    + 'executed so the stage inside it is not separated');
            } else {
                measured.sort((x, y) => y[1] - x[1]);
                const [topName, topValue] = measured[0];
                const second = measured[1]?.[1] ?? 0;
                if (topValue >= 0.5 && topValue >= second * 2) {
                    r.classification = topName;
                    basis.push(`${topName} accounts for ${(topValue * 100).toFixed(1)}% of Run A's p95`);
                } else if (residual > 0) {
                    r.classification = 'SORT_PIPELINE_TAIL_CONFIRMED_BUT_RESIDUAL_TAIL';
                    basis.push('no single stage of the sort completion accounts for the tail on '
                        + 'its own, and a residual tail remains with the sort removed');
                } else {
                    r.classification = 'MIXED_SORT_COMPLETION';
                    basis.push('no single stage of the sort completion accounts for the tail on '
                        + 'its own');
                }
            }
        }
        r.classificationBasis = basis;
    }
}
