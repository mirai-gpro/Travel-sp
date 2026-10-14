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
import type {
    UikaFrameTick,
    UikaSortStage,
    UikaSortSubmissionPhase,
    UikaDrawingBufferInfo,
} from './renderer';
import {
    GpuTimerPool,
    collectGpuInfo,
    summariseIntervals,
    type UikaGpuInfo,
    type UikaIntervalStats,
} from './uika-native-benchmark';
import { UikaPredeformPass, type UikaFencePollStrategy } from './predeform/uika-predeform-pass';

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
    | 'D-distance-plus-cpu-sort'
    // Gate 4B-2B-1: the same Run C conditions with different fence-poll scheduling.
    | 'B-no-sort-reference'
    | 'C0-immediate-poll'
    | 'C0-immediate-poll-repeat'
    | 'C1-frame-poll'
    | 'C2-timer-8ms'
    | 'C3-timer-16ms'
    // Gate 4B-2B-2: the same Run C conditions with the sort submitted before or after
    // the current frame's draw.
    | 'P0-pre-draw'
    | 'P0-pre-draw-repeat'
    | 'P1-post-draw'
    | 'P1-post-draw-repeat';

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
    /** Gate 4B-2B-1: which fence-poll scheduling this run used. */
    fencePollStrategy: UikaFencePollStrategy;
    /** Gate 4B-2B-2: when the distance pass was submitted within the frame. */
    sortSubmissionPhase: UikaSortSubmissionPhase;
    /** Gate 4B-2B-2 §7: frames where the post-draw sort would have read changed state. */
    phaseStateMismatches: number;
    /** Gate 4B-2B-2 §8: the window started with no sort in flight and ended drained. */
    submittedEqualsCompleted: boolean;
    idleBeforeMeasurement: boolean;
    idleWaitMs: number;
    drainedAfterMeasurement: boolean;
    drainWaitMs: number;
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
    /**
     * Gate 4B-2B-1: did this run actually exercise the completion path? A window in which
     * no sort was submitted or none completed measures nothing about the fence, and must
     * not contribute a p95 to the comparison. null for a no-sort run, where there is
     * nothing to exercise.
     */
    completionPathExercised: boolean | null;
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
    /** Gate 4B-2B-1: measure C0 twice, to size the run-to-run spread. */
    repeatC0: boolean;
    /**
     * Gate 4B-2B-2 §8: how long to wait for the sort pipeline to go idle before opening
     * and after closing the measured window. The real GPU showed a fence max around
     * 6033 ms in Gate 4B-2B-1, so the default leaves headroom above that; a timeout makes
     * the run invalid rather than measuring a window a warm-up sort spills into.
     */
    idleTimeoutMs: number;
}

export const DEFAULT_TAIL_OPTIONS: UikaTailOptions = {
    warmupMs: 6000,
    measureMs: 30000,
    forceCD: null,
    allowSoftware: false,
    maxFrameRecords: 4000,
    repeatC0: true,
    idleTimeoutMs: 10000,
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
        if (q.get('repeatC0') === '0') o.repeatC0 = false;
        const idle = Number(q.get('idleTimeoutMs'));
        if (Number.isFinite(idle) && idle > 0) o.idleTimeoutMs = idle;
    } catch { /* noop */ }
    return o;
}


// ---------------------------------------------------------------------------
// Gate 4B-2B-1 — fence / GPU->CPU completion path isolation
// ---------------------------------------------------------------------------

export type UikaFenceClassification =
    | 'POLLING_OVERHEAD_CONFIRMED'
    | 'GPU_COMPLETION_PATH_DOMINANT'
    | 'MIXED_COMPLETION_PATH'
    | 'UNRESOLVED';

export interface UikaFenceReport {
    spec: 'UIKA Native Runtime v1.1 Gate 4B-2B-1';
    startedAt: string;
    finishedAt: string | null;
    gpu: UikaGpuInfo;
    realGpu: boolean;
    target: typeof TAIL_TARGET;
    runs: UikaTailRun[];
    analysis: {
        noSortP95: number | null;
        c0P95: number | null;
        c0RepeatP95: number | null;
        /** |C0 - C0 repeat|: the run-to-run spread of the number being compared. */
        c0RepeatabilityMs: number | null;
        c1P95: number | null;
        c2P95: number | null;
        c3P95: number | null;
        bestPollP95: number | null;
        bestPollRun: UikaTailRunName | null;
        /** C0 - no-sort: the gap the completion path costs today. */
        originalGapMs: number | null;
        /** C0 - best: how much of it the poll scheduling accounts for. */
        closedByPollingMs: number | null;
        /** best - no-sort: what survives the poll change. */
        residualGapMs: number | null;
        closedShare: number | null;
    } | null;
    classification: UikaFenceClassification;
    classificationBasis: string[];
    /** Hypotheses, explicitly not findings (§4). */
    hypothesesNotTested: string[];
    notes: string[];
}


// ---------------------------------------------------------------------------
// Gate 4B-2B-2 — sort submission phase PoC
// ---------------------------------------------------------------------------

export type UikaPhaseClassification =
    | 'POST_DRAW_PHASE_EFFECTIVE'
    | 'POST_DRAW_PHASE_PARTIAL'
    | 'POST_DRAW_PHASE_NOT_PRIMARY'
    | 'UNRESOLVED';

/** §13: decision rules for this gate, not measured quantities. */
export const PHASE_RULES = {
    effectiveClosedShare: 0.5,
    notPrimaryClosedShare: 0.2,
    /** The effect must be at least this many times the larger repeat spread. */
    noiseFactor: 2,
} as const;

export interface UikaPhaseReport {
    spec: 'UIKA Native Runtime v1.1 Gate 4B-2B-2';
    startedAt: string;
    finishedAt: string | null;
    gpu: UikaGpuInfo;
    realGpu: boolean;
    target: typeof TAIL_TARGET;
    rules: typeof PHASE_RULES;
    runs: UikaTailRun[];
    analysis: {
        noSortP95: number | null;
        preDrawP95: number[];
        postDrawP95: number[];
        preDrawMeanP95: number | null;
        postDrawMeanP95: number | null;
        preDrawSpreadMs: number | null;
        postDrawSpreadMs: number | null;
        phaseImprovementMs: number | null;
        originalGapMs: number | null;
        closedShare: number | null;
        /** §7: a post-draw frame must read the same state the draw used. */
        phaseStateMismatches: number;
    } | null;
    classification: UikaPhaseClassification;
    /**
     * Set when post-draw measured SLOWER than pre-draw by more than the noise floor: how
     * much slower, at p95. A regression is a result, so it is reported as one.
     */
    phaseRegressionMs?: number;
    classificationBasis: string[];
    notes: string[];
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
    private fenceReport: UikaFenceReport | null = null;
    private phaseReport: UikaPhaseReport | null = null;
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
    getFenceReport(): UikaFenceReport | null { return this.fenceReport; }
    getPhaseReport(): UikaPhaseReport | null { return this.phaseReport; }
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


    /**
     * Gate 4B-2B-1. The Run C conditions throughout — pre-deformed, pixelRatio 1.0, real
     * A2E, 133,541 Gaussians, 51 basis, CPU sort OFF, render-index update OFF — with only
     * the fence-poll scheduling changed between runs, plus a no-sort reference and a
     * repeat of C0 to size the run-to-run spread.
     *
     * Longer poll intervals are expected to raise the fence elapsed time, the pending-skip
     * count and the sort completion latency (§9). None of that is the question: the
     * question is what happens to the main rendering wall tail.
     */
    async runFenceIsolation(options: UikaTailOptions = DEFAULT_TAIL_OPTIONS): Promise<UikaFenceReport> {
        if (this.running) throw new Error('UIKA Gate 4B-2B-1: already running');
        this.running = true;
        this.abort = false;

        const viewer = this.viewer();
        const gpu = collectGpuInfo(viewer?.renderer?.domElement ?? null);
        const report: UikaFenceReport = {
            spec: 'UIKA Native Runtime v1.1 Gate 4B-2B-1',
            startedAt: new Date().toISOString(),
            finishedAt: null,
            gpu,
            realGpu: !gpu.isSoftware && gpu.unmaskedAvailable,
            target: TAIL_TARGET,
            runs: [],
            analysis: null,
            classification: 'UNRESOLVED',
            classificationBasis: [],
            hypothesesNotTested: [
                'H1 setTimeout / clientWaitSync polling callback overhead',
                'H2 transform feedback + fence GPU or driver scheduling interaction',
                'H3 getBufferSubData completion timing disturbing frame scheduling',
                'H4 a combination of the above',
                'none of these is a finding: this gate measures the effect of the poll '
                + 'scheduling on the wall tail and nothing else',
            ],
            notes: [
                'every run uses the Run C conditions: CPU sort off, render-index update off, '
                + 'pre-deformed, pixelRatio 1.0, real A2E, 133,541 Gaussians, 51 basis',
                'the distance shader, the fence and getBufferSubData are identical in every '
                + 'run; only the scheduling of clientWaitSync differs',
                'fence elapsed, pendingSkip and completion latency may rise with a longer poll '
                + 'interval; that is expected and is not the metric under test',
                'measurement only: no production sort, DepthSorter, sort frequency, render '
                + 'index format, SplatMesh, SplatMaterial, mapper, LAM, A2E or backend change',
            ],
        };
        this.fenceReport = report;

        try {
            if (gpu.isSoftware && !options.allowSoftware) {
                report.classificationBasis.push(`software renderer `
                    + `(${gpu.softwareMatches.join(', ')}): completion-path timing on a software `
                    + 'rasteriser is not evidence');
                return report;
            }

            const handles = viewer.getPoCHandles();
            if (!handles) throw new Error('the viewer has no renderer or splat mesh yet');

            this.pass = new UikaPredeformPass();
            const layout = this.pass.init(handles);
            viewer.setPredeformCenterTexture(this.pass.getTexture(), layout.textureWidth, layout.textureHeight);
            viewer.setDistanceProvider((m: any, out: Float32Array) => this.pass!.computeDistances(m, out));
            viewer.setPreRenderHook(() => { this.pass?.runIfDirty(); });
            viewer.setExpressionWeightHook(() => { this.pass?.markDirty(); });
            const dpr = window.devicePixelRatio || 1;
            viewer.setDrawingBufferScale(1 / dpr);

            const plan: Array<[UikaTailRunName, UikaSortStage, boolean, UikaFencePollStrategy]> = [
                ['B-no-sort-reference', 'full', true, 'immediate'],
                ['C0-immediate-poll', 'distance', false, 'immediate'],
                ['C1-frame-poll', 'distance', false, 'frame'],
                ['C2-timer-8ms', 'distance', false, 'timer8'],
                ['C3-timer-16ms', 'distance', false, 'timer16'],
            ];
            if (options.repeatC0) plan.push(['C0-immediate-poll-repeat', 'distance', false, 'immediate']);

            for (const [name, stage, suspended, strategy] of plan) {
                if (this.abort) break;
                report.runs.push(await this.measureRun(name, stage, suspended, options, strategy));
            }

            report.analysis = this.analyseFence(report);
            this.classifyFence(report);
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
            this.pass?.setFencePollStrategy('immediate');
            this.pass?.dispose();
            this.pass = null;
            this.replay.stop();
            this.runtime.setExpressionSource(null);
            this.runtime.setNeutral();
            this.live.phase = 'idle';
            this.live.step = '';
            this.running = false;
            report.finishedAt = new Date().toISOString();
        }

        return report;
    }


    /**
     * Gate 4B-2B-2. Run C conditions throughout — pre-deformed, pixelRatio 1.0, real A2E,
     * 133,541 Gaussians, 51 basis, CPU sort OFF, render-index update OFF, immediate fence
     * polling in every run — with only the moment the distance pass is submitted changed:
     * before this frame's draw (production) or after it, inside the same render() call.
     *
     * Each phase is measured twice and compared on the mean of the two p95s, so a single
     * run is never the baseline.
     */
    async runSubmissionPhase(options: UikaTailOptions = DEFAULT_TAIL_OPTIONS): Promise<UikaPhaseReport> {
        if (this.running) throw new Error('UIKA Gate 4B-2B-2: already running');
        this.running = true;
        this.abort = false;

        const viewer = this.viewer();
        const gpu = collectGpuInfo(viewer?.renderer?.domElement ?? null);
        const report: UikaPhaseReport = {
            spec: 'UIKA Native Runtime v1.1 Gate 4B-2B-2',
            startedAt: new Date().toISOString(),
            finishedAt: null,
            gpu,
            realGpu: !gpu.isSoftware && gpu.unmaskedAvailable,
            target: TAIL_TARGET,
            rules: PHASE_RULES,
            runs: [],
            analysis: null,
            classification: 'UNRESOLVED',
            classificationBasis: [],
            notes: [
                'every run uses the Run C conditions and immediate fence polling; only the '
                + 'submission phase differs',
                'the distance shader, the pre-deformation maths, the fence, getBufferSubData, '
                + 'DepthSorter, the sort frequency, sortDirty semantics, the Gaussian and basis '
                + 'counts, the render-index format, the mapper, A2E, LAM and the backend are all '
                + 'unchanged',
                'both phases submit inside the same synchronous render() call, so the weights, '
                + 'the camera, the MVP and the pre-deformed centres are identical for the draw '
                + 'and for the distance pass; the viewer counts any frame where that does not '
                + 'hold and such a run is marked invalid',
                'CPU sort and the render-index update are off, so every run draws in the same '
                + 'fixed order: these runs say nothing about visual correctness (§14)',
                'measurement only: no GPU sort, no sort cadence change, no Worker, no WASM',
            ],
        };
        this.phaseReport = report;

        try {
            if (gpu.isSoftware && !options.allowSoftware) {
                report.classificationBasis.push(`software renderer `
                    + `(${gpu.softwareMatches.join(', ')}): submission-phase timing on a software `
                    + 'rasteriser is not evidence');
                return report;
            }

            const handles = viewer.getPoCHandles();
            if (!handles) throw new Error('the viewer has no renderer or splat mesh yet');

            this.pass = new UikaPredeformPass();
            const layout = this.pass.init(handles);
            viewer.setPredeformCenterTexture(this.pass.getTexture(), layout.textureWidth, layout.textureHeight);
            viewer.setDistanceProvider((m: any, out: Float32Array) => this.pass!.computeDistances(m, out));
            viewer.setPreRenderHook(() => { this.pass?.runIfDirty(); });
            viewer.setExpressionWeightHook(() => { this.pass?.markDirty(); });
            const dpr = window.devicePixelRatio || 1;
            viewer.setDrawingBufferScale(1 / dpr);

            const plan: Array<[UikaTailRunName, UikaSortStage, boolean, UikaSortSubmissionPhase]> = [
                ['B-no-sort-reference', 'full', true, 'pre-draw'],
                ['P0-pre-draw', 'distance', false, 'pre-draw'],
                ['P0-pre-draw-repeat', 'distance', false, 'pre-draw'],
                ['P1-post-draw', 'distance', false, 'post-draw'],
                ['P1-post-draw-repeat', 'distance', false, 'post-draw'],
            ];

            for (const [name, stage, suspended, phase] of plan) {
                if (this.abort) break;
                report.runs.push(await this.measureRun(name, stage, suspended, options, 'immediate', phase));
            }

            report.analysis = this.analysePhase(report);
            this.classifyPhase(report);
        } finally {
            try {
                viewer?.setFrameTickHook?.(null);
                viewer?.setSortLifecycleRecorder?.(null);
                viewer?.setDiagnosticSortStage?.('full');
                viewer?.setDiagnosticSortSubmissionPhase?.('pre-draw');
                viewer?.setSortSuspended?.(false);
                viewer?.setPreRenderHook?.(null);
                viewer?.setExpressionWeightHook?.(null);
                viewer?.setDistanceProvider?.(null);
                viewer?.setPredeformCenterTexture?.(null, 0, 0);
                viewer?.setDrawingBufferScale?.(1);
                viewer?.setGpuTimer?.(null);
            } catch { /* noop */ }
            this.pass?.setDistanceLifecycleRecorder(null);
            this.pass?.setFencePollStrategy('immediate');
            this.pass?.dispose();
            this.pass = null;
            this.replay.stop();
            this.runtime.setExpressionSource(null);
            this.runtime.setNeutral();
            this.live.phase = 'idle';
            this.live.step = '';
            this.running = false;
            report.finishedAt = new Date().toISOString();
        }

        return report;
    }

    private analysePhase(report: UikaPhaseReport): UikaPhaseReport['analysis'] {
        const usable = (name: UikaTailRunName) => {
            const run = report.runs.find((x) => x.name === name);
            if (!run || !run.valid || run.exactFrameInterval.count === 0) return null;
            if (run.completionPathExercised === false) return null;
            return run.exactFrameInterval.p95;
        };
        const noSort = usable('B-no-sort-reference');
        const pre = [usable('P0-pre-draw'), usable('P0-pre-draw-repeat')]
            .filter((v): v is number => v !== null);
        const post = [usable('P1-post-draw'), usable('P1-post-draw-repeat')]
            .filter((v): v is number => v !== null);
        const mean = (xs: number[]) => (xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
        const spread = (xs: number[]) => (xs.length === 2 ? Math.abs(xs[0] - xs[1]) : null);

        const preMean = mean(pre);
        const postMean = mean(post);
        const improvement = preMean !== null && postMean !== null ? preMean - postMean : null;
        const gap = preMean !== null && noSort !== null ? preMean - noSort : null;

        return {
            noSortP95: noSort,
            preDrawP95: pre,
            postDrawP95: post,
            preDrawMeanP95: preMean,
            postDrawMeanP95: postMean,
            preDrawSpreadMs: spread(pre),
            postDrawSpreadMs: spread(post),
            phaseImprovementMs: improvement,
            originalGapMs: gap,
            closedShare: improvement !== null && gap !== null && gap > 0 ? improvement / gap : null,
            phaseStateMismatches: report.runs.reduce((sum, x) => sum + x.phaseStateMismatches, 0),
        };
    }

    /** §13. From the measurements only; the thresholds are PHASE_RULES. */
    private classifyPhase(report: UikaPhaseReport): void {
        const a = report.analysis!;
        const basis: string[] = [];

        for (const run of report.runs) {
            basis.push(`${run.name}: phase ${run.sortSubmissionPhase}, exact p95 `
                + `${run.exactFrameInterval.p95.toFixed(2)} ms, fps ${run.effectiveFPS.toFixed(2)}, `
                + `submitted ${run.sortCounters.sortSubmittedCount}, completed `
                + `${run.sortCounters.sortCompletedCount}, pendingSkip `
                + `${run.sortCounters.sortPendingSkipCount}, idle at open `
                + `${run.idleBeforeMeasurement}, state mismatches ${run.phaseStateMismatches}`
                + (run.valid ? '' : ` — INVALID: ${run.invalidReason}`));
        }

        const invalid = report.runs.filter((x) => !x.valid);
        const invariantFailures = report.runs.reduce(
            (sum, x) => sum + x.sortLifecycle.lifecycleInvariantFailures, 0);
        if (invariantFailures > 0) {
            basis.push(`${invariantFailures} lifecycle invariant failures: the lifecycle timing is `
                + 'not trustworthy in this run');
        }

        if (a.preDrawMeanP95 === null || a.postDrawMeanP95 === null || a.noSortP95 === null
            || a.phaseImprovementMs === null || invalid.length > 0 || invariantFailures > 0) {
            report.classification = 'UNRESOLVED';
            basis.push('a run needed for the comparison is missing or invalid');
            report.classificationBasis = basis;
            return;
        }

        basis.push(`pre-draw mean p95 ${a.preDrawMeanP95.toFixed(2)} ms (spread `
            + `${a.preDrawSpreadMs?.toFixed(2)} ms), post-draw mean p95 `
            + `${a.postDrawMeanP95.toFixed(2)} ms (spread ${a.postDrawSpreadMs?.toFixed(2)} ms), `
            + `no-sort ${a.noSortP95.toFixed(2)} ms`);
        basis.push(`phase improvement ${a.phaseImprovementMs.toFixed(2)} ms against a gap of `
            + `${a.originalGapMs?.toFixed(2)} ms`);

        // The noise test is on the MAGNITUDE of the effect. Testing the signed value made
        // a clearly negative effect — post-draw measurably slower — come out as "below the
        // noise floor", which conflates "too small to tell" with "worse in the other
        // direction". A regression is a measured result, not an absence of one.
        const noise = Math.max(a.preDrawSpreadMs ?? 0, a.postDrawSpreadMs ?? 0);
        if (Math.abs(a.phaseImprovementMs) < noise * PHASE_RULES.noiseFactor) {
            report.classification = 'UNRESOLVED';
            basis.push(`the effect magnitude ${Math.abs(a.phaseImprovementMs).toFixed(2)} ms is `
                + `below ${PHASE_RULES.noiseFactor}x the larger repeat spread `
                + `(${noise.toFixed(2)} ms), so it is not separable from the run-to-run variation`);
            report.classificationBasis = basis;
            return;
        }
        if (a.phaseImprovementMs < 0) {
            report.phaseRegressionMs = -a.phaseImprovementMs;
            basis.push(`post-draw is SLOWER than pre-draw by `
                + `${(-a.phaseImprovementMs).toFixed(2)} ms at p95, which is `
                + `${(Math.abs(a.phaseImprovementMs) / Math.max(noise, 1e-9)).toFixed(1)}x the `
                + 'larger repeat spread — a measured regression, not an absent effect');
        }

        const share = a.closedShare;
        if (share === null) {
            report.classification = 'UNRESOLVED';
            basis.push('the no-sort reference is not below the pre-draw mean, so there is no gap '
                + 'to attribute');
        } else if (share >= PHASE_RULES.effectiveClosedShare) {
            report.classification = 'POST_DRAW_PHASE_EFFECTIVE';
            basis.push(`submitting the distance pass after the draw closes `
                + `${(share * 100).toFixed(1)}% of the gap to the no-sort reference`);
        } else if (share <= PHASE_RULES.notPrimaryClosedShare) {
            report.classification = 'POST_DRAW_PHASE_NOT_PRIMARY';
            basis.push(`the submission phase closes only ${(share * 100).toFixed(1)}% of the gap`);
        } else {
            report.classification = 'POST_DRAW_PHASE_PARTIAL';
            basis.push(`the submission phase closes ${(share * 100).toFixed(1)}% of the gap and the `
                + 'rest survives it');
        }
        report.classificationBasis = basis;
    }

    private analyseFence(report: UikaFenceReport): UikaFenceReport['analysis'] {
        // A run only contributes a p95 when it is valid, has samples, and — for the
        // poll-strategy variants — actually submitted and completed a sort. A window where
        // a warm-up sort was still pending throughout submits nothing, so its p95 is a
        // no-sort measurement wearing a variant's name.
        const p95 = (name: UikaTailRunName) => {
            const run = report.runs.find((x) => x.name === name);
            if (!run || !run.valid || run.exactFrameInterval.count === 0) return null;
            if (run.completionPathExercised === false) return null;
            return run.exactFrameInterval.p95;
        };
        const noSort = p95('B-no-sort-reference');
        const c0 = p95('C0-immediate-poll');
        const c0Repeat = p95('C0-immediate-poll-repeat');
        const c1 = p95('C1-frame-poll');
        const c2 = p95('C2-timer-8ms');
        const c3 = p95('C3-timer-16ms');

        const candidates: Array<[UikaTailRunName, number]> = [];
        if (c1 !== null) candidates.push(['C1-frame-poll', c1]);
        if (c2 !== null) candidates.push(['C2-timer-8ms', c2]);
        if (c3 !== null) candidates.push(['C3-timer-16ms', c3]);
        candidates.sort((a, b) => a[1] - b[1]);
        const best = candidates.length > 0 ? candidates[0] : null;

        const originalGap = c0 !== null && noSort !== null ? c0 - noSort : null;
        const closed = c0 !== null && best !== null ? c0 - best[1] : null;
        const residual = best !== null && noSort !== null ? best[1] - noSort : null;

        return {
            noSortP95: noSort,
            c0P95: c0,
            c0RepeatP95: c0Repeat,
            c0RepeatabilityMs: c0 !== null && c0Repeat !== null ? Math.abs(c0 - c0Repeat) : null,
            c1P95: c1,
            c2P95: c2,
            c3P95: c3,
            bestPollP95: best ? best[1] : null,
            bestPollRun: best ? best[0] : null,
            originalGapMs: originalGap,
            closedByPollingMs: closed,
            residualGapMs: residual,
            closedShare: closed !== null && originalGap !== null && originalGap > 0
                ? closed / originalGap : null,
        };
    }

    /**
     * §8. From the measurements only. The 0.7 / 0.2 shares and the "the effect must be at
     * least twice the measured run-to-run spread" rule are decision rules for this gate,
     * not measured quantities.
     */
    private classifyFence(report: UikaFenceReport): void {
        const a = report.analysis!;
        const basis: string[] = [];

        const invalid = report.runs.filter((x) => !x.valid);
        for (const run of invalid) basis.push(`${run.name}: ${run.invalidReason}`);
        const notExercised = report.runs.filter((x) => x.completionPathExercised === false);
        for (const run of notExercised) {
            basis.push(`${run.name}: no sort was submitted and completed in the measured window `
                + `(requested ${run.sortCounters.sortRequestedCount}, submitted `
                + `${run.sortCounters.sortSubmittedCount}, completed `
                + `${run.sortCounters.sortCompletedCount}, pendingSkip `
                + `${run.sortCounters.sortPendingSkipCount}) — it measures nothing about the `
                + 'completion path and is excluded from the comparison');
        }
        const invariantFailures = report.runs.reduce(
            (sum, x) => sum + x.sortLifecycle.lifecycleInvariantFailures, 0);
        if (invariantFailures > 0) {
            basis.push(`${invariantFailures} lifecycle invariant failures: the lifecycle timing in `
                + 'this run is not trustworthy');
        }

        for (const run of report.runs) {
            basis.push(`${run.name}: exact p95 ${run.exactFrameInterval.p95.toFixed(2)} ms, `
                + `fps ${run.effectiveFPS.toFixed(2)}, fence p95 `
                + `${run.sortLifecycle.fenceWaitMs.p95.toFixed(2)} ms, polls per sort p50 `
                + `${run.sortLifecycle.fencePolls.p50}, submitted `
                + `${run.sortCounters.sortSubmittedCount}, completed `
                + `${run.sortCounters.sortCompletedCount}, pendingSkip `
                + `${run.sortCounters.sortPendingSkipCount}`);
        }

        if (a.c0P95 === null || a.noSortP95 === null || a.bestPollP95 === null) {
            report.classification = 'UNRESOLVED';
            basis.push('a run needed for the comparison produced no usable exact-interval p95 '
                + '(no valid samples, or the completion path was never exercised)');
            report.classificationBasis = basis;
            return;
        }
        if (invariantFailures > 0 || invalid.length > 0 || notExercised.length > 0) {
            report.classification = 'UNRESOLVED';
            report.classificationBasis = basis;
            return;
        }

        basis.push(`no-sort ${a.noSortP95.toFixed(2)} ms, C0 ${a.c0P95.toFixed(2)} ms, best poll `
            + `${a.bestPollRun} ${a.bestPollP95.toFixed(2)} ms; gap ${a.originalGapMs?.toFixed(2)} ms, `
            + `closed ${a.closedByPollingMs?.toFixed(2)} ms, residual ${a.residualGapMs?.toFixed(2)} ms`);

        const spread = a.c0RepeatabilityMs;
        const effect = a.closedByPollingMs ?? 0;
        if (spread !== null) {
            basis.push(`C0 measured twice differs by ${spread.toFixed(2)} ms, against an effect of `
                + `${effect.toFixed(2)} ms`);
            if (effect < spread * 2) {
                report.classification = 'UNRESOLVED';
                basis.push('the poll-strategy effect is not at least twice the measured run-to-run '
                    + 'spread, so it is not separable from it in this run');
                report.classificationBasis = basis;
                return;
            }
        } else {
            basis.push('C0 was measured once, so the run-to-run spread is not known for this run');
        }

        const share = a.closedShare;
        if (share === null) {
            report.classification = 'UNRESOLVED';
            basis.push('the no-sort reference is not below C0, so there is no gap to attribute');
        } else if (share >= 0.7) {
            report.classification = 'POLLING_OVERHEAD_CONFIRMED';
            basis.push(`changing only the poll scheduling closes ${(share * 100).toFixed(1)}% of the `
                + 'gap to the no-sort reference, with the distance pass and the readback identical');
        } else if (share <= 0.2) {
            report.classification = 'GPU_COMPLETION_PATH_DOMINANT';
            basis.push(`changing the poll scheduling closes only ${(share * 100).toFixed(1)}% of the `
                + 'gap, which stays wide open against the no-sort reference');
        } else {
            report.classification = 'MIXED_COMPLETION_PATH';
            basis.push(`the poll scheduling closes ${(share * 100).toFixed(1)}% of the gap and the `
                + 'rest survives it');
        }
        report.classificationBasis = basis;
    }

    private async measureRun(
        name: UikaTailRunName,
        stage: UikaSortStage,
        suspended: boolean,
        options: UikaTailOptions,
        pollStrategy: UikaFencePollStrategy = 'immediate',
        phase: UikaSortSubmissionPhase = 'pre-draw',
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
        this.pass!.setFencePollStrategy(pollStrategy);
        viewer.setDiagnosticSortSubmissionPhase(phase);

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
            'B-no-sort-reference': 'no sort at all, kept as the reference for the poll-strategy runs',
            'C0-immediate-poll': 'Run C conditions with the current fence polling: '
                + 'setTimeout(checkSync) with no delay',
            'C0-immediate-poll-repeat': 'C0 measured a second time, to put a number on the '
                + 'run-to-run spread of the p95 the classification rests on',
            'C1-frame-poll': 'Run C conditions, at most one clientWaitSync per rendered frame',
            'C2-timer-8ms': 'Run C conditions, setTimeout(checkSync, 8)',
            'C3-timer-16ms': 'Run C conditions, setTimeout(checkSync, 16)',
            'P0-pre-draw': 'Run C conditions, the distance pass submitted before this '
                + "frame's draw — the production order",
            'P0-pre-draw-repeat': 'P0 again, to size the run-to-run spread',
            'P1-post-draw': 'Run C conditions, the same frame drawn first and the distance '
                + 'pass submitted after it, inside the same render() call',
            'P1-post-draw-repeat': 'P1 again, to size the run-to-run spread',
        };

        this.live.step = name;
        this.live.phase = 'warmup';
        const warmupStart = performance.now();
        await this.waitFor(() => performance.now() - warmupStart >= options.warmupMs);
        const warmupMs = performance.now() - warmupStart;

        // Gate 4B-2B-2 §8: a sort submitted during warm-up must not complete inside the
        // measured window, or the window reports a completion it never paid for — which
        // is how Gate 4B-2B-1's C1 came back with 317 submitted and 318 completed.
        this.live.phase = 'draining warm-up';
        const idleWaitStart = performance.now();
        const idleBeforeMeasurement = await this.waitForSortIdle(viewer, options.idleTimeoutMs);
        const idleWaitMs = performance.now() - idleWaitStart;

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
            // Gate 4B-2B-1 'frame' strategy: this is the one poll per rendered frame.
            if (pollStrategy === 'frame') this.pass?.pollFenceOnFrame();
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
        const phaseMismatches0 = viewer.stats.phaseStateMismatches;
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
        // §8: let the last in-flight sort finish before the counters are read, so
        // submitted == completed can be a real assertion.
        this.live.phase = 'draining';
        const drainStart = performance.now();
        const drained = await this.waitForSortIdle(viewer, options.idleTimeoutMs);
        const drainMs = performance.now() - drainStart;
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
            fencePollStrategy: pollStrategy,
            sortSubmissionPhase: phase,
            phaseStateMismatches: viewer.stats.phaseStateMismatches - phaseMismatches0,
            submittedEqualsCompleted:
                collector.sortSubmittedCount === collector.sortCompletedCount,
            idleBeforeMeasurement,
            idleWaitMs,
            drainedAfterMeasurement: drained,
            drainWaitMs: drainMs,
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
            completionPathExercised: suspended
                ? null
                : collector.sortSubmittedCount > 0 && collector.sortCompletedCount > 0,
            meetsTarget: name === 'A-normal'
                ? effectiveFPS >= TAIL_TARGET.minFps && exact.p95 <= TAIL_TARGET.maxExactWallP95Ms
                  && viewer.stats.glErrorCount - glErrors0 === 0 && this.pageErrors - pageErrors0 === 0
                : null,
            frameRecords,
        };

        if (run.valid && !suspended && !run.submittedEqualsCompleted) {
            run.valid = false;
            run.invalidReason = `the measured window submitted ${collector.sortSubmittedCount} `
                + `sorts and completed ${collector.sortCompletedCount}: a sort crossed the window `
                + 'boundary, so the completions and the submissions do not describe the same work';
        }
        if (run.valid && !idleBeforeMeasurement) {
            run.valid = false;
            run.invalidReason = `a sort was still in flight when the measured window opened `
                + `(waited ${Math.round(idleWaitMs)} ms of a ${options.idleTimeoutMs} ms cap)`;
        }
        if (run.valid && !drained) {
            run.valid = false;
            run.invalidReason = `the in-flight sort did not finish within `
                + `${options.idleTimeoutMs} ms after the window closed, so the counters do not `
                + 'describe a completed set of work';
        }
        if (run.valid && run.phaseStateMismatches > 0) {
            run.valid = false;
            run.invalidReason = `${run.phaseStateMismatches} frames changed the state the distance `
                + 'pass reads between the draw and the post-draw submission';
        }

        timers?.dispose();
        viewer.setGpuTimer?.(null);
        this.pass!.setGpuTimer(null);
        viewer.setSortSuspended(false);
        viewer.setDiagnosticSortStage('full');
        viewer.setDiagnosticSortSubmissionPhase('pre-draw');
        this.pass!.setFencePollStrategy('immediate');
        return run;
    }

    /**
     * §8. Wait until no sort is in flight. Returns false on timeout, which makes the run
     * invalid rather than silently measuring a window a warm-up sort spills into.
     *
     * Sorting is suspended for the duration, then put back as it was. Without that the
     * wait cannot succeed: the weights change on nearly every frame, so render() submits a
     * new sort in the same frame the previous one completed, and a once-per-frame poll of
     * `sortPending` samples at exactly the wrong moment and reads `true` for ever. The
     * self-test hit precisely that — 43 s of waiting against a 40 s cap on a renderer
     * where sorts were in fact completing six times per window.
     */
    private async waitForSortIdle(viewer: any, timeoutMs: number): Promise<boolean> {
        const wasSuspended: boolean = viewer.isSortSuspended?.() ?? false;
        viewer.setSortSuspended?.(true);
        try {
            const deadline = performance.now() + timeoutMs;
            while (viewer.isSortPending?.()) {
                if (this.abort || performance.now() > deadline) return false;
                await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
            }
            return true;
        } finally {
            viewer.setSortSuspended?.(wasSuspended);
        }
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
