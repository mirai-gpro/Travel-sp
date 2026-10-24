// UIKA Native Runtime v1.1 — LAM Reference Runtime sort PoC
//
// Replaces, for the duration of this PoC only, the sort pipeline
//
//   animated centre -> GPU distance transform feedback -> fenceSync -> clientWaitSync
//   -> getBufferSubData -> CPU counting sort
//
// with the LAM reference runtime's own
//
//   canonical Gaussian centres -> Web Worker -> WebAssembly depth sort -> sorted indexes
//   -> updateRenderIndexes
//
// Kept exactly as it is (§1): the 133,541 canonical Gaussians, D_UIKA, the pre-deformation
// pass, the animated-centre texture, the 51 ARKit basis channels, UikaExpressionMapper,
// the JP mouth correction, the real-A2E fixture, the render shader and the Gaussian
// appearance. The draw position stays `canonical + D_UIKA x weights`.
//
// Removed from the PoC path, not deleted (§2): the GPU distance pass, the fence, the
// readback and every explicit sort cadence. `UikaPredeformPass` is still used for the
// deformation itself; only its `computeDistances` is left uncalled in the LAM mode, and
// the exact-sort baseline run still exercises the whole existing path for comparison.
//
// §4: the centres the worker sorts by are the CANONICAL centres. Only the draw uses the
// animated ones. The two orders therefore genuinely differ, which is why §8 forbids
// judging this gate on performance alone and gives it its own correctness contract.

import type { UikaNativeRuntime } from './uika-native-runtime';
import type { UikaNativeReplay } from './uika-native-replay';
import type { UikaDrawingBufferHash, UikaExternalSortDriver } from './renderer';
import {
    GpuTimerPool,
    collectGpuInfo,
    type UikaGpuInfo,
} from './uika-native-benchmark';
import { summariseStage, type UikaStageStats } from './uika-tail-isolation';
import { UikaPredeformPass } from './predeform/uika-predeform-pass';
import {
    UikaLamSortHost,
    LAM_SORT_DEFAULTS,
    type UikaLamSortStats,
    type UikaLamSortCentreInfo,
    type UikaLamSortOrderProbe,
} from './lam-sort/uika-lam-sort-host';
import {
    evaluateStructural,
    LAM_SORT_ACCEPTANCE_VERSION,
    LAM_SORT_STRUCTURAL,
    type UikaLamStructuralResult,
    type UikaLamVisualVerdict,
} from './lam-sort/uika-lam-sort-contract';

/** §10: the target is the one the tail gates have been measured against throughout. */
export const LAM_SORT_TARGET = { minFps: 30, maxExactWallP95Ms: 33.3 } as const;

export type UikaLamRunName =
    | 'A-no-sort'
    | 'B-exact-animated-centre-sort'
    | 'D-lam-exact-distance-worker-sort'
    | 'C-lam-canonical-centre-worker-sort';

/**
 * Round-robin, in this order, so session drift lands on all four runs equally. D sits
 * between B and C because it is the bridge between them: it shares B's depth keys and C's
 * sort implementation.
 */
export const RUN_ORDER: UikaLamRunName[] = [
    'A-no-sort',
    'B-exact-animated-centre-sort',
    'D-lam-exact-distance-worker-sort',
    'C-lam-canonical-centre-worker-sort',
];

export interface UikaLamRunSample {
    name: UikaLamRunName;
    repeat: number;
    warmupMs: number;
    measuredMs: number;
    renderedFrames: number;
    /** Rendered after the window closed, while the last sort drained. Excluded from FPS. */
    framesDuringDrain: number;
    effectiveFPS: number;
    exactFrameInterval: UikaStageStats;
    gpuDraw: UikaStageStats;
    gpuSortSubmission: UikaStageStats;
    predeform: UikaStageStats;
    invalidGpuTimerSamples: number;
    /** §6. Null for the runs where no worker sort was installed. */
    worker: {
        sortRequested: number;
        sortSubmitted: number;
        sortCompleted: number;
        sortSkippedWhileRunning: number;
        sortSkippedBeforeReady: number;
        workerSortMs: UikaStageStats;
        indexUpdateMs: UikaStageStats;
        submitMs: UikaStageStats;
        roundTripMs: UikaStageStats;
        /** Variant D only: the whole GPU distance pass + fence + readback, per submission. */
        distanceStageMs: UikaStageStats;
        usePrecomputedDistances: boolean;
        workerErrors: number;
        distanceErrors: number;
        effectiveSortHz: number;
    } | null;
    /** The exact path's own counters, for the B run. */
    exactPath: {
        sortRuns: number;
        effectiveSortHz: number;
        predeformPasses: number;
    } | null;
    /**
     * §"D validity": the GPU distance pass counters, read straight off the pre-deformation
     * pass. Non-zero in B and D, zero in C — which is what makes C the no-readback run.
     */
    gpuDistance: {
        submitted: number;
        cpuCompletions: number;
        readbacks: number;
        fencePolls: number;
        gpuOnlySubmitted: number;
    };
    glErrors: number;
    pageErrors: number;
    weightUploads: number;
    visibilityLostMs: number;
    /**
     * The warm-up drain and the post-window drain, each with the wall time it took. A run
     * whose warm-up drain timed out can count a completion it never submitted — which is
     * what the container self-test produced: variant D reported 1 submitted and 2
     * completed after a 9.3 s GPU distance pass outran a 10 s drain.
     */
    idleBeforeMeasurement: boolean;
    idleWaitMs: number;
    drainedAfterMeasurement: boolean;
    drainWaitMs: number;
    /** Worker runs only; true for runs with no worker. */
    submittedEqualsCompleted: boolean;
}

/**
 * The minimum number of measured per-`render()` intervals a run needs before its p95 may
 * be compared against another run's. The container self-test produced run A with ONE
 * rendered frame — zero intervals, so p95 read 0.00 ms — and the analysis then reported
 * "100 % of the tail closed" from it. A p95 over fewer samples than this is not a tail.
 */
export const MIN_INTERVALS_FOR_COMPARISON = 30;

export interface UikaLamRunRollUp {
    name: UikaLamRunName;
    repeats: number;
    /** Total measured intervals across this run's repeats. */
    intervalSamples: number;
    meanEffectiveFPS: number;
    meanExactP95Ms: number;
    spreadExactP95Ms: number;
    meanGpuDrawP50Ms: number;
    meanWorkerSortP50Ms: number | null;
    meanIndexUpdateP50Ms: number | null;
    meanDistanceStageP50Ms: number | null;
    meanEffectiveSortHz: number | null;
}

/** §8 / §9: everything measured for one fixture frame, both modes. */
export interface UikaLamFrameComparison {
    frame: number;
    nonZeroWeights: number;
    /** Sort submission succeeded in both modes for this frame. */
    bothSorted: boolean;
    exactHash: string;
    lamHash: string;
    pixelIdentical: boolean;
    differentPixels: number;
    differentPixelRatio: number;
    maxRgbaByteDelta: number;
    /** Alpha reported separately: an order change can move coverage, not only colour. */
    maxAlphaByteDelta: number;
    differentAlphaPixels: number;
    alphaPlaneIdentical: boolean;
    alphaSumExact: number;
    alphaSumLam: number;
    nonZeroPixelsExact: number;
    nonZeroPixelsLam: number;
    /** The byte-delta histogram, so the shape of the difference is visible. */
    deltaHistogram: Record<string, number>;
    boundingBox: { minX: number; minY: number; maxX: number; maxY: number } | null;
    /**
     * §9 support. The drawing buffer split into a fixed 8 x 8 grid, each tile carrying
     * its share of the differing pixels. Which tile holds the mouth, the eyes or the
     * silhouette is for the viewer of the captures to say; the harness only localises.
     */
    tileDifferentPixels: number[];
    worstTile: { index: number; x: number; y: number; differentPixels: number } | null;
}

/**
 * The B vs D check. Both runs feed the SAME depth keys — the animated-centre GPU distance
 * pass, fence and readback — to two different sorts: the project-owned main-thread
 * counting sort, and the vendored LAM worker with `usePrecomputedDistances = true`. If the
 * two sorts agree, the index arrays match element for element and the framebuffers are
 * identical. Both are measured; neither is assumed.
 */
export interface UikaLamBvsDComparison {
    frame: number;
    /** Element-for-element equality of the two emitted index arrays. */
    identicalIndexOrder: boolean;
    indexPositionsCompared: number;
    differingIndexPositions: number;
    firstDifferingIndexPosition: number | null;
    /** What each sort put at the first position they disagree on. */
    firstDifferingPair: { exact: number; lam: number } | null;
    /** Whether the two orders are at least permutations of the same set. */
    sameIndexMultiset: boolean;
    /**
     * The decisive measurement when the index arrays differ. If the SEQUENCE OF DEPTH KEYS
     * under each order is identical, the two sorts put the same key at every position and
     * differ only in which tied splat they chose — the orders are the same sort, resolved
     * differently. If the key sequences differ, the two sorts ordered by different criteria.
     */
    identicalKeySequence: boolean;
    firstDifferingKeyPosition: number | null;
    maxKeySequenceAbsDifference: number;
    /** Both sequences checked for monotonicity in the key, back to front. */
    exactOrderMonotonic: boolean;
    lamOrderMonotonic: boolean;
    /** Largest key increase between consecutive emitted positions; 0 when monotonic. */
    exactMaxInversion: number;
    lamMaxInversion: number;
    /** How much tie-breaking room there is: distinct float keys among the splats. */
    distinctKeys: number;
    /** The span of the depth keys, so an inversion magnitude can be read as a fraction. */
    keyMin: number;
    keyMax: number;
    /**
     * Each order's worst local inversion as a fraction of the key range. Both sorts are
     * bucketed counting sorts, so neither is exactly monotonic in the raw float key; this
     * is what each one's bucket granularity actually costs at this key range.
     */
    exactMaxInversionRelative: number;
    lamMaxInversionRelative: number;
    /** The depth keys the two sorts were given, compared as arrays. */
    identicalDepthKeys: boolean;
    maxDepthKeyAbsDifference: number;
    pixelIdentical: boolean;
    differentPixels: number;
    differentPixelRatio: number;
    maxRgbaByteDelta: number;
    maxAlphaByteDelta: number;
    exactHash: string;
    lamHash: string;
}

/** §9: side-by-side captures for the frames with the largest difference. */
export interface UikaLamFrameCapture {
    frame: number;
    differentPixels: number;
    exactPng: string;
    lamPng: string;
    /** Differing pixels painted white on black, at full scale. */
    diffPng: string;
}

export interface UikaLamSortReport {
    spec: string;
    acceptanceVersion: string;
    startedAt: string;
    finishedAt: string | null;
    gpu: UikaGpuInfo;
    realGpu: boolean;
    fixture: unknown;
    buffer: { width: number; height: number; pixelRatio: number } | null;
    /** The LAM option values this PoC ran with, and where each one came from. */
    sortConfiguration: {
        source: string;
        integerBasedSort: boolean;
        enableSIMDInSort: boolean;
        splatSortDistanceMapPrecision: number;
        distanceMapRange: number;
        useSharedMemory: boolean;
        dynamicMode: boolean;
        usePrecomputedDistances: boolean;
        deviationsFromLamDefaults: string[];
    } | null;
    centres: UikaLamSortCentreInfo | null;
    orderProbe: UikaLamSortOrderProbe | null;
    correctness: {
        framesRequested: number;
        frames: UikaLamFrameComparison[];
        captures: UikaLamFrameCapture[];
        summary: {
            framesCompared: number;
            framesPixelIdentical: number;
            framesWithDifference: number;
            worstDifferentPixels: { value: number; frame: number };
            worstDifferentPixelRatio: { value: number; frame: number };
            worstMaxRgbaByteDelta: { value: number; frame: number };
            worstMaxAlphaByteDelta: { value: number; frame: number };
            framesWithAlphaDifference: number;
            meanDifferentPixelRatio: number;
            tileDifferentPixelsTotal: number[];
        } | null;
        structural: UikaLamStructuralResult | null;
        visualVerdict: UikaLamVisualVerdict;
        visualNotes: string[];
        /**
         * B vs D. Unlike the C comparison this one has an expected answer — the same keys
         * sorted two ways — so it carries an automatic verdict. It is still measured, and a
         * mismatch is reported as a mismatch, not explained away.
         */
        bVsD: {
            frames: UikaLamBvsDComparison[];
            framesCompared: number;
            framesWithIdenticalIndexOrder: number;
            framesPixelIdentical: number;
            worstDifferingIndexPositions: { value: number; frame: number } | null;
            worstDifferentPixels: { value: number; frame: number } | null;
            worstMaxRgbaByteDelta: { value: number; frame: number } | null;
            allDepthKeysIdentical: boolean;
            /** Every frame's emitted key sequence matched, i.e. only tie order differs. */
            allKeySequencesIdentical: boolean;
            framesWithBothOrdersMonotonic: number;
            /**
             * IDENTICAL          the index arrays and the framebuffers all match
             * TIE_ORDER_DIFFERS  the key sequences match everywhere; only tied splats
             *                    were placed differently
             * ORDER_DIFFERS      the key sequences themselves differ
             */
            verdict: 'IDENTICAL' | 'TIE_ORDER_DIFFERS' | 'ORDER_DIFFERS' | 'NOT_RUN';
        };
    };
    performance: {
        target: typeof LAM_SORT_TARGET;
        samples: UikaLamRunSample[];
        rollUps: UikaLamRunRollUp[];
        analysis: {
            /**
             * false when any run carries fewer than MIN_INTERVALS_FOR_COMPARISON measured
             * intervals. The comparative fields are then null, not estimated — a tail
             * comparison between runs that barely rendered is not a measurement.
             */
            valid: boolean;
            invalidReasons: string[];
            /**
             * B vs D: the same depth keys, the same readback, only the sort implementation
             * differs. This is the LAM Worker/WASM migration effect on its own.
             */
            workerMigrationP95DeltaMs: number | null;
            workerMigrationFpsDelta: number | null;
            /**
             * D vs C: the same worker, the same back-pressure, the same index update. The
             * difference is the animated-centre GPU distance pass plus its readback against
             * a worker-computed canonical-centre key with no readback at all.
             */
            distanceReadbackP95DeltaMs: number | null;
            distanceReadbackFpsDelta: number | null;
            /** A vs C: what the canonical-centre worker sort still costs over no sort. */
            canonicalSortResidualP95Ms: number | null;
            canonicalSortResidualFps: number | null;
            /** C vs B, the end-to-end difference. */
            exactP95DeltaMs: number | null;
            effectiveFpsDelta: number | null;
            /** How much of the B-over-A tail each LAM path closes. */
            tailGapAboveNoSortB: number | null;
            tailGapAboveNoSortC: number | null;
            tailGapAboveNoSortD: number | null;
            tailGapClosedShare: number | null;
            tailGapClosedShareD: number | null;
            /** Reported whatever the validity: a contaminated run C is a fact on its own. */
            readbackPathExercisedInC: boolean;
            /** D is invalid without it: the GPU distance pass must have run. */
            readbackPathExercisedInD: boolean;
            dUsedPrecomputedDistances: boolean;
            cMeetsTarget: boolean | null;
            bMeetsTarget: boolean | null;
            dMeetsTarget: boolean | null;
        } | null;
    };
    glErrors: number;
    pageErrors: number;
    notes: string[];
}

export interface UikaLamSortOptions {
    /** Which fixture frames to compare. null = every frame, once each (§8). */
    frames: number[] | null;
    repeats: number;
    warmupMs: number;
    measureMs: number;
    /** How many worst-difference frames to keep PNG captures for (§9). */
    captureCount: number;
    /** How long a drain may take before it is recorded as having timed out. */
    idleTimeoutMs: number;
    allowSoftware: boolean;
    /** Off by default: UIKA's SplatMesh uses float centres, see LAM_SORT_DEFAULTS. */
    integerBasedSort: boolean;
    skipCorrectness: boolean;
    skipPerformance: boolean;
}

export const DEFAULT_LAM_SORT_OPTIONS: UikaLamSortOptions = {
    frames: null,
    repeats: 3,
    warmupMs: 2000,
    measureMs: 8000,
    captureCount: 4,
    idleTimeoutMs: 30000,
    allowSoftware: false,
    integerBasedSort: LAM_SORT_DEFAULTS.integerBasedSort,
    skipCorrectness: false,
    skipPerformance: false,
};

/**
 * Every parameter is parsed only when its query key is PRESENT. An absent list must not
 * become `[0]` — the defect that made Gate 4B-1's Diagnostic 3 run with basisCounts=[0]
 * and Gate 4B-2B-0's frameRecords come back empty.
 */
export function lamSortOptionsFromUrl(): UikaLamSortOptions {
    const o: UikaLamSortOptions = { ...DEFAULT_LAM_SORT_OPTIONS };
    try {
        const q = new URLSearchParams(window.location.search);
        const num = (key: string, min: number): number | null => {
            if (!q.has(key)) return null;
            const v = Number(q.get(key));
            return Number.isFinite(v) && v >= min ? v : null;
        };
        if (q.has('lamFrames')) {
            const frames = q.get('lamFrames')!.split(',').map(Number)
                .filter((v) => Number.isInteger(v) && v >= 0);
            if (frames.length > 0) o.frames = frames;
        }
        const repeats = num('lamRepeats', 1);
        if (repeats !== null) o.repeats = Math.floor(repeats);
        const warmup = num('lamWarmupMs', 0);
        if (warmup !== null) o.warmupMs = warmup;
        const measure = num('lamMeasureMs', 500);
        if (measure !== null) o.measureMs = measure;
        const captures = num('lamCaptures', 0);
        if (captures !== null) o.captureCount = Math.floor(captures);
        const idle = num('lamIdleTimeoutMs', 1000);
        if (idle !== null) o.idleTimeoutMs = idle;
        if (q.has('allowSoftware')) o.allowSoftware = q.get('allowSoftware') === '1';
        if (q.has('lamIntSort')) o.integerBasedSort = q.get('lamIntSort') === '1';
        if (q.has('lamSkipCorrectness')) o.skipCorrectness = q.get('lamSkipCorrectness') === '1';
        if (q.has('lamSkipPerformance')) o.skipPerformance = q.get('lamSkipPerformance') === '1';
    } catch { /* noop */ }
    return o;
}

const TILE_GRID = 8;

/**
 * The deadline for one sort. Sized well above the slowest completion any gate has
 * measured — Gate 4B-2B-0's fence wait reached 6,033 ms on the real GPU, and this
 * container's software rasteriser renders at roughly 3.4 s per frame — so it only ever
 * fires on a path that has genuinely stopped answering.
 */
const SORT_TIMEOUT_MS = 60000;

function mean(values: number[]): number {
    if (values.length === 0) return 0;
    let sum = 0;
    for (const v of values) sum += v;
    return sum / values.length;
}

export class UikaLamSortPoC {
    private report: UikaLamSortReport | null = null;
    private pass: UikaPredeformPass | null = null;
    private host: UikaLamSortHost | null = null;
    private running = false;
    private abort = false;
    private pageErrors = 0;
    private live = { step: '', phase: 'idle', frame: 0, fps: 0, exactP95: 0 };

    constructor(
        private readonly runtime: UikaNativeRuntime,
        private readonly replay: UikaNativeReplay,
    ) {
        window.addEventListener('error', () => { this.pageErrors++; });
        window.addEventListener('unhandledrejection', () => { this.pageErrors++; });
    }

    getLive() { return { ...this.live }; }
    getReport(): UikaLamSortReport | null { return this.report; }
    isRunning(): boolean { return this.running; }
    stop(): void { this.abort = true; }

    private viewer(): any { return this.runtime.getViewer(); }

    async run(options: UikaLamSortOptions = DEFAULT_LAM_SORT_OPTIONS): Promise<UikaLamSortReport> {
        if (this.running) throw new Error('UIKA LAM sort PoC: already running');
        this.running = true;
        this.abort = false;

        const viewer = this.viewer();
        const gpu = collectGpuInfo(viewer?.renderer?.domElement ?? null);
        const fixture: any = this.replay.getFixture();
        const frameCount: number = fixture?.frameCount ?? 0;
        const frames = options.frames ?? Array.from({ length: frameCount }, (_, i) => i);

        this.report = {
            spec: 'UIKA Native Runtime v1.1 — LAM reference runtime sort PoC',
            acceptanceVersion: LAM_SORT_ACCEPTANCE_VERSION,
            startedAt: new Date().toISOString(),
            finishedAt: null,
            gpu,
            realGpu: !gpu.isSoftware && gpu.unmaskedAvailable,
            fixture,
            buffer: null,
            sortConfiguration: null,
            centres: null,
            orderProbe: null,
            correctness: {
                framesRequested: frames.length,
                frames: [],
                captures: [],
                summary: null,
                structural: null,
                visualVerdict: 'REQUIRES_HUMAN_INSPECTION',
                bVsD: {
                    frames: [],
                    framesCompared: 0,
                    framesWithIdenticalIndexOrder: 0,
                    framesPixelIdentical: 0,
                    worstDifferingIndexPositions: null,
                    worstDifferentPixels: null,
                    worstMaxRgbaByteDelta: null,
                    allDepthKeysIdentical: true,
                    allKeySequencesIdentical: true,
                    framesWithBothOrdersMonotonic: 0,
                    verdict: 'NOT_RUN',
                },
                visualNotes: [
                    'The LAM-reference order is the canonical-centre depth order, not the '
                    + 'exact depth order of the animated geometry being drawn, so a '
                    + 'difference here is an alpha-compositing difference from a different '
                    + 'draw order — not float rounding. The Gate 4B-2A tolerances do not '
                    + 'apply and are not reused.',
                    'The captures below are the frames with the largest measured difference. '
                    + '§9 asks for the mouth interior, lips, teeth, nose, eyes and face '
                    + 'silhouette to be inspected; the harness localises the difference to a '
                    + '64-tile grid but does not label face parts, and returns no visual PASS.',
                ],
            },
            performance: {
                target: LAM_SORT_TARGET,
                samples: [],
                rollUps: [],
                analysis: null,
            },
            glErrors: 0,
            pageErrors: 0,
            notes: [
                'pixelRatio 1.0 (§10), pre-deformed, real A2E fixture, 133,541 Gaussians, '
                + '51 basis channels',
                'the sort worker and its four .wasm payloads are vendored verbatim from '
                + 'gaussian-splat-renderer-for-lam@0.0.9-alpha.1; no sort algorithm is '
                + 'project-written',
                'no cadence gate, no timer, no deadline: the only back-pressure is LAM\'s '
                + 'own one-sort-in-flight rule',
            ],
        };
        const r = this.report;

        try {
            if (gpu.isSoftware && !options.allowSoftware) {
                r.notes.push(`software renderer (${gpu.softwareMatches.join(', ')}): correctness `
                    + 'is measurable here, performance is not. Re-run on the real GPU.');
            }

            const handles = viewer.getPoCHandles();
            if (!handles) throw new Error('the viewer has no renderer or splat mesh yet');
            if (frames.length === 0) throw new Error('the fixture reports no frames');

            // §1: the pre-deformation pass and the animated-centre texture stay.
            this.pass = new UikaPredeformPass();
            const layout = this.pass.init(handles);
            viewer.setPredeformCenterTexture(this.pass.getTexture(), layout.textureWidth, layout.textureHeight);
            viewer.setPreRenderHook(() => { this.pass?.runIfDirty(); });
            viewer.setExpressionWeightHook(() => { this.pass?.markDirty(); });
            const dpr = window.devicePixelRatio || 1;
            viewer.setDrawingBufferScale(1 / dpr);
            const bufferInfo = viewer.getDrawingBufferInfo();
            r.buffer = {
                width: bufferInfo.drawingBufferWidth,
                height: bufferInfo.drawingBufferHeight,
                pixelRatio: bufferInfo.rendererPixelRatio,
            };

            // §3 / §6: the LAM worker, created once for the whole PoC.
            this.live.phase = 'initialising sort worker';
            this.host = new UikaLamSortHost();
            await this.host.init(handles.splatMesh, {
                integerBasedSort: options.integerBasedSort,
                enableSIMDInSort: LAM_SORT_DEFAULTS.enableSIMDInSort,
                splatSortDistanceMapPrecision: LAM_SORT_DEFAULTS.splatSortDistanceMapPrecision,
            });
            const hostOptions = this.host.getOptions();
            r.centres = this.host.getCentreInfo();
            r.sortConfiguration = {
                source: 'gaussian-splat-renderer-for-lam@0.0.9-alpha.1 Viewer.js option defaults',
                integerBasedSort: hostOptions.integerBasedSort,
                enableSIMDInSort: hostOptions.enableSIMDInSort,
                splatSortDistanceMapPrecision: hostOptions.splatSortDistanceMapPrecision,
                distanceMapRange: 1 << hostOptions.splatSortDistanceMapPrecision,
                useSharedMemory: LAM_SORT_DEFAULTS.useSharedMemory,
                dynamicMode: LAM_SORT_DEFAULTS.dynamicMode,
                usePrecomputedDistances: LAM_SORT_DEFAULTS.usePrecomputedDistances,
                deviationsFromLamDefaults: [
                    'integerBasedSort: LAM\'s Viewer.js default is TRUE. This PoC runs float '
                    + 'throughout, including variant D\'s precomputed distances, because UIKA\'s '
                    + 'SplatMesh is built with integerBasedDistancesComputation=false and this '
                    + 'gate does not change the numeric representation of the splat data. An '
                    + 'integer variant is a separate decision, to be taken only if these '
                    + 'results call for it.',
                    'gpuAcceleratedSort: LAM render.ts passes true, which routes the depth keys '
                    + 'through SplatMesh.computeDistancesOnGPU + fenceSync + getBufferSubData. '
                    + '§2 removes that path, so this PoC runs the same unmodified worker with '
                    + 'usePrecomputedDistances=false, where the WebAssembly module computes the '
                    + 'keys from the uploaded centres. That is the upstream default.',
                    hostOptions.integerBasedSort === LAM_SORT_DEFAULTS.integerBasedSort
                        ? 'integerBasedSort: LAM\'s Viewer.js default is true, and it passes the '
                          + 'same flag to the SplatMesh constructor as '
                          + 'integerBasedDistancesComputation. UIKA\'s SplatMesh is built with '
                          + 'false and §1 keeps it that way, so float centres are uploaded and '
                          + 'the worker is told to read float centres.'
                        : 'integerBasedSort: forced to true by ?lamIntSort=1. UIKA\'s SplatMesh '
                          + 'is built with integerBasedDistancesComputation=false, so the centres '
                          + 'are taken from getIntegerCenters() explicitly for this run.',
                ],
            };

            if (!options.skipCorrectness) {
                await this.runCorrectness(frames, options, handles);
            } else {
                r.notes.push('correctness comparison skipped by request (?lamSkipCorrectness=1)');
            }

            if (!options.skipPerformance && !this.abort) {
                await this.runPerformance(options);
            } else if (options.skipPerformance) {
                r.notes.push('performance runs skipped by request (?lamSkipPerformance=1)');
            }

            r.orderProbe = this.host.getOrderProbe();
            r.glErrors = viewer.stats.glErrorCount;
            r.pageErrors = this.pageErrors;
        } finally {
            try {
                viewer?.setDiagnosticExternalSortDriver?.(null);
                viewer?.setFrameTickHook?.(null);
                viewer?.setSortLifecycleRecorder?.(null);
                viewer?.setSortSuspended?.(false);
                viewer?.setPreRenderHook?.(null);
                viewer?.setExpressionWeightHook?.(null);
                viewer?.setDistanceProvider?.(null);
                viewer?.setPredeformCenterTexture?.(null, 0, 0);
                viewer?.setDrawingBufferScale?.(1);
                viewer?.setGpuTimer?.(null);
            } catch { /* noop */ }
            this.host?.dispose();
            this.host = null;
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

    // ---------------------------------------------------------------- correctness

    /**
     * §8. One fixture frame at a time, with the replay held, sorting suspended and each
     * mode's sort driven to completion before the frame it is judged on is drawn. Both
     * modes see the same weights, the same pre-deformed animated-centre texture and the
     * same camera; the only difference is which order the Gaussians are drawn in.
     */
    private async runCorrectness(
        frames: number[],
        options: UikaLamSortOptions,
        handles: any,
    ): Promise<void> {
        const r = this.report!;
        const viewer = this.viewer();
        const host = this.host!;

        this.replay.stop();
        this.runtime.setExpressionSource(null);

        const glErrors0 = viewer.stats.glErrorCount;
        const pageErrors0 = this.pageErrors;
        host.resetStats();

        // Sorting is suspended so that render() cannot submit anything of its own; every
        // sort in this phase is one explicit runDiagnosticSortOnce().
        viewer.setSortSuspended(true);

        // The MINIMUM over the sweep, not the last frame's value: a mid-sweep drop in the
        // render count would otherwise be invisible to the structural check.
        let renderSplatCountExact = Infinity;
        let renderSplatCountLam = Infinity;
        let framesCompared = 0;
        const comparisons: UikaLamFrameComparison[] = [];

        this.live.phase = 'correctness';
        for (let i = 0; i < frames.length; i++) {
            if (this.abort) break;
            const frame = frames[i];
            this.live.frame = frame;
            this.live.step = `frame ${frame} (${i + 1}/${frames.length})`;

            const held = this.replay.holdFrame(frame);
            const weights = new Float32Array(held.weights);
            this.runtime.applyWeights(weights);
            this.pass!.markDirty();
            this.pass!.run();

            // --- exact animated-centre sort (the existing path) ------------
            viewer.setDiagnosticExternalSortDriver(null);
            viewer.setDistanceProvider((m: any, out: Float32Array) => this.pass!.computeDistances(m, out));
            const exactSorted = await this.sortOnce(viewer, 'the exact animated-centre sort');
            renderSplatCountExact = Math.min(
                renderSplatCountExact, handles.splatMesh.geometry.instanceCount);
            const exactFrame = await this.nextFramePixels();

            // --- LAM reference canonical-centre worker sort ----------------
            viewer.setDistanceProvider(null);
            viewer.setDiagnosticExternalSortDriver(this.driver());
            const lamSorted = await this.sortOnce(viewer, 'the LAM canonical-centre sort');
            renderSplatCountLam = Math.min(
                renderSplatCountLam, handles.splatMesh.geometry.instanceCount);
            const lamFrame = await this.nextFramePixels();

            comparisons.push(this.compareFrame(
                frame,
                Array.from(weights).filter((w) => w !== 0).length,
                exactSorted && lamSorted,
                exactFrame,
                lamFrame,
            ));
            framesCompared++;
        }

        viewer.setDiagnosticExternalSortDriver(null);
        viewer.setDistanceProvider(null);
        viewer.setSortSuspended(false);

        r.correctness.frames = comparisons;
        r.correctness.summary = this.summariseCorrectness(comparisons);
        await this.runBvsD(frames, handles);
        r.correctness.captures = await this.captureWorst(
            frames, comparisons, options, handles, viewer,
        );

        const hostStats = host.getStats();
        r.correctness.structural = evaluateStructural({
            framesRequested: frames.length,
            framesCompared,
            glErrors: viewer.stats.glErrorCount - glErrors0,
            pageErrors: this.pageErrors - pageErrors0,
            workerErrors: hostStats.workerErrors,
            sortsSubmitted: hostStats.sortSubmitted,
            sortsCompleted: hostStats.sortCompleted,
            renderSplatCountExact: Number.isFinite(renderSplatCountExact) ? renderSplatCountExact : 0,
            renderSplatCountLam: Number.isFinite(renderSplatCountLam) ? renderSplatCountLam : 0,
        });
    }

    /**
     * B vs D. Both sorts are given the SAME depth keys: the animated-centre GPU distance
     * pass, its fence and its getBufferSubData, which is the only distance pass in this
     * PoC and the one variant B already uses. The keys are captured once per frame and
     * compared too, so "the keys were the same" is a measurement rather than an argument.
     */
    private async runBvsD(frames: number[], handles: any): Promise<void> {
        const r = this.report!;
        const viewer = this.viewer();
        const host = this.host!;
        const out = r.correctness.bVsD;

        const splatCount = handles.splatMesh.getSplatCount();
        const keysFromB = new Float32Array(splatCount);
        const keysFromD = new Float32Array(splatCount);

        viewer.setSortSuspended(true);
        this.live.phase = 'B vs D';
        try {
            for (let i = 0; i < frames.length; i++) {
                if (this.abort) break;
                const frame = frames[i];
                this.live.frame = frame;
                this.live.step = `B vs D frame ${frame} (${i + 1}/${frames.length})`;

                const held = this.replay.holdFrame(frame);
                this.runtime.applyWeights(new Float32Array(held.weights));
                this.pass!.markDirty();
                this.pass!.run();

                // --- B: the same GPU distance pass, then the main-thread counting sort.
                viewer.setDiagnosticExternalSortDriver(null);
                host.setDistanceSource(null);
                viewer.setDistanceProvider((m: any, o: Float32Array) => this.pass!
                    .computeDistances(m, o)
                    .then(() => { keysFromB.set(o); }));
                await this.sortOnce(viewer, 'the exact animated-centre sort');
                const exactIndexes: Uint32Array | null = viewer.getDiagnosticSortedIndexes();
                const exactFrame = await this.nextFramePixels();

                // --- D: the same GPU distance pass, then the vendored LAM worker.
                viewer.setDistanceProvider(null);
                host.setDistanceSource((m: any, o: Float32Array) => this.pass!
                    .computeDistances(m, o)
                    .then(() => { keysFromD.set(o); }));
                viewer.setDiagnosticExternalSortDriver(this.driver());
                await this.sortOnce(viewer, 'the LAM exact-distance sort');
                const lamIndexes = host.getSortedIndexes();
                const lamFrame = await this.nextFramePixels();

                out.frames.push(this.compareBvsD(
                    frame, exactIndexes, lamIndexes, keysFromB, keysFromD,
                    splatCount, exactFrame, lamFrame,
                ));
                out.framesCompared++;
            }
        } finally {
            viewer.setDiagnosticExternalSortDriver(null);
            viewer.setDistanceProvider(null);
            host.setDistanceSource(null);
            viewer.setSortSuspended(false);
        }

        out.framesWithIdenticalIndexOrder = out.frames.filter((f) => f.identicalIndexOrder).length;
        out.framesPixelIdentical = out.frames.filter((f) => f.pixelIdentical).length;
        out.allDepthKeysIdentical = out.frames.every((f) => f.identicalDepthKeys);
        out.allKeySequencesIdentical = out.frames.length > 0
            && out.frames.every((f) => f.identicalKeySequence);
        out.framesWithBothOrdersMonotonic = out.frames
            .filter((f) => f.exactOrderMonotonic && f.lamOrderMonotonic).length;
        const worst = (pick: (f: UikaLamBvsDComparison) => number) => {
            if (out.frames.length === 0) return null;
            let value = -Infinity;
            let frame = -1;
            for (const f of out.frames) {
                const v = pick(f);
                if (v > value) { value = v; frame = f.frame; }
            }
            return { value, frame };
        };
        out.worstDifferingIndexPositions = worst((f) => f.differingIndexPositions);
        out.worstDifferentPixels = worst((f) => f.differentPixels);
        out.worstMaxRgbaByteDelta = worst((f) => f.maxRgbaByteDelta);
        out.verdict = out.framesCompared === 0
            ? 'NOT_RUN'
            : (out.framesWithIdenticalIndexOrder === out.framesCompared
                && out.framesPixelIdentical === out.framesCompared
                ? 'IDENTICAL'
                : (out.allKeySequencesIdentical ? 'TIE_ORDER_DIFFERS' : 'ORDER_DIFFERS'));
    }

    private compareBvsD(
        frame: number,
        exactIndexes: Uint32Array | null,
        lamIndexes: Uint32Array | null,
        keysFromB: Float32Array,
        keysFromD: Float32Array,
        splatCount: number,
        exact: UikaDrawingBufferHash,
        lam: UikaDrawingBufferHash,
    ): UikaLamBvsDComparison {
        let differingIndexPositions = 0;
        let firstDifferingIndexPosition: number | null = null;
        let firstDifferingPair: { exact: number; lam: number } | null = null;
        let sameIndexMultiset = false;
        const compared = exactIndexes && lamIndexes
            ? Math.min(exactIndexes.length, lamIndexes.length) : 0;
        if (exactIndexes && lamIndexes) {
            for (let i = 0; i < compared; i++) {
                if (exactIndexes[i] === lamIndexes[i]) continue;
                differingIndexPositions++;
                if (firstDifferingIndexPosition === null) {
                    firstDifferingIndexPosition = i;
                    firstDifferingPair = { exact: exactIndexes[i], lam: lamIndexes[i] };
                }
            }
            // Both must at least draw the same set of splats; a difference there would be a
            // defect, not a tie-break.
            const seen = new Uint8Array(splatCount);
            let ok = exactIndexes.length === lamIndexes.length;
            if (ok) {
                for (let i = 0; i < compared; i++) seen[exactIndexes[i]]++;
                for (let i = 0; i < compared && ok; i++) {
                    if (seen[lamIndexes[i]] === 0) ok = false; else seen[lamIndexes[i]]--;
                }
                if (ok) for (let i = 0; i < splatCount; i++) if (seen[i] !== 0) { ok = false; break; }
            }
            sameIndexMultiset = ok;
        }

        let maxDepthKeyAbsDifference = 0;
        for (let i = 0; i < splatCount; i++) {
            const d = Math.abs(keysFromB[i] - keysFromD[i]);
            if (d > maxDepthKeyAbsDifference) maxDepthKeyAbsDifference = d;
        }

        // The key sequence each order produces, and whether each order is monotonic in it.
        let identicalKeySequence = compared > 0;
        let firstDifferingKeyPosition: number | null = null;
        let maxKeySequenceAbsDifference = 0;
        let exactMaxInversion = 0;
        let lamMaxInversion = 0;
        if (exactIndexes && lamIndexes) {
            for (let i = 0; i < compared; i++) {
                const ke = keysFromB[exactIndexes[i]];
                const kl = keysFromD[lamIndexes[i]];
                const d = Math.abs(ke - kl);
                if (d > maxKeySequenceAbsDifference) maxKeySequenceAbsDifference = d;
                if (d !== 0) {
                    identicalKeySequence = false;
                    if (firstDifferingKeyPosition === null) firstDifferingKeyPosition = i;
                }
                if (i > 0) {
                    // Back to front means the key must not increase along the draw order.
                    const re = ke - keysFromB[exactIndexes[i - 1]];
                    const rl = kl - keysFromD[lamIndexes[i - 1]];
                    if (re > exactMaxInversion) exactMaxInversion = re;
                    if (rl > lamMaxInversion) lamMaxInversion = rl;
                }
            }
        }
        const distinctKeys = new Set(Array.from(keysFromB.subarray(0, splatCount))).size;
        let keyMin = Infinity;
        let keyMax = -Infinity;
        for (let i = 0; i < splatCount; i++) {
            const k = keysFromB[i];
            if (k < keyMin) keyMin = k;
            if (k > keyMax) keyMax = k;
        }
        const keySpan = keyMax - keyMin;

        const pixels = this.compareFrame(frame, 0, true, exact, lam);
        return {
            frame,
            identicalIndexOrder: compared > 0 && differingIndexPositions === 0,
            indexPositionsCompared: compared,
            differingIndexPositions,
            firstDifferingIndexPosition,
            firstDifferingPair,
            sameIndexMultiset,
            identicalDepthKeys: maxDepthKeyAbsDifference === 0,
            maxDepthKeyAbsDifference,
            identicalKeySequence,
            firstDifferingKeyPosition,
            maxKeySequenceAbsDifference,
            exactOrderMonotonic: exactMaxInversion === 0,
            lamOrderMonotonic: lamMaxInversion === 0,
            exactMaxInversion,
            lamMaxInversion,
            distinctKeys,
            keyMin,
            keyMax,
            exactMaxInversionRelative: keySpan > 0 ? exactMaxInversion / keySpan : 0,
            lamMaxInversionRelative: keySpan > 0 ? lamMaxInversion / keySpan : 0,
            pixelIdentical: pixels.pixelIdentical,
            differentPixels: pixels.differentPixels,
            differentPixelRatio: pixels.differentPixelRatio,
            maxRgbaByteDelta: pixels.maxRgbaByteDelta,
            maxAlphaByteDelta: pixels.maxAlphaByteDelta,
            exactHash: exact.hash,
            lamHash: lam.hash,
        };
    }

    private driver(): UikaExternalSortDriver {
        const host = this.host!;
        return {
            request: (mvp: any) => host.request(mvp),
            isRunning: () => host.isRunning(),
        };
    }

    private compareFrame(
        frame: number,
        nonZeroWeights: number,
        bothSorted: boolean,
        exact: UikaDrawingBufferHash,
        lam: UikaDrawingBufferHash,
    ): UikaLamFrameComparison {
        const pa = exact.pixels!;
        const pb = lam.pixels!;
        if (pa.length !== pb.length) throw new Error('the two frames have different sizes');
        const width = exact.width;
        const height = exact.height;
        const totalPixels = width * height;

        const tileW = Math.ceil(width / TILE_GRID);
        const tileH = Math.ceil(height / TILE_GRID);
        const tileDifferentPixels = new Array<number>(TILE_GRID * TILE_GRID).fill(0);

        let differentPixels = 0;
        let maxRgbaByteDelta = 0;
        let maxAlphaByteDelta = 0;
        let differentAlphaPixels = 0;
        let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
        const deltaHistogram: Record<string, number> = {};

        for (let p = 0; p < totalPixels; p++) {
            const i = p * 4;
            let pixelDiffers = false;
            for (let c = 0; c < 4; c++) {
                const d = Math.abs(pa[i + c] - pb[i + c]);
                if (d === 0) continue;
                pixelDiffers = true;
                if (d > maxRgbaByteDelta) maxRgbaByteDelta = d;
                if (c === 3) {
                    if (d > maxAlphaByteDelta) maxAlphaByteDelta = d;
                }
                const key = String(d);
                deltaHistogram[key] = (deltaHistogram[key] ?? 0) + 1;
            }
            if (pa[i + 3] !== pb[i + 3]) differentAlphaPixels++;
            if (pixelDiffers) {
                differentPixels++;
                const x = p % width;
                // gl.readPixels returns rows bottom-up. Both the bounding box and the tile
                // grid are reported in top-down image space, so they line up with the PNG
                // captures instead of being vertically mirrored against them.
                const y = height - 1 - Math.floor(p / width);
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
                const tx = Math.min(TILE_GRID - 1, Math.floor(x / tileW));
                const ty = Math.min(TILE_GRID - 1, Math.floor(y / tileH));
                tileDifferentPixels[ty * TILE_GRID + tx]++;
            }
        }

        let worstTile: UikaLamFrameComparison['worstTile'] = null;
        for (let t = 0; t < tileDifferentPixels.length; t++) {
            if (tileDifferentPixels[t] === 0) continue;
            if (!worstTile || tileDifferentPixels[t] > worstTile.differentPixels) {
                worstTile = {
                    index: t,
                    x: t % TILE_GRID,
                    y: Math.floor(t / TILE_GRID),
                    differentPixels: tileDifferentPixels[t],
                };
            }
        }

        return {
            frame,
            nonZeroWeights,
            bothSorted,
            exactHash: exact.hash,
            lamHash: lam.hash,
            pixelIdentical: differentPixels === 0,
            differentPixels,
            differentPixelRatio: totalPixels > 0 ? differentPixels / totalPixels : 0,
            maxRgbaByteDelta,
            maxAlphaByteDelta,
            differentAlphaPixels,
            alphaPlaneIdentical: exact.aHash === lam.aHash,
            alphaSumExact: exact.alphaSum,
            alphaSumLam: lam.alphaSum,
            nonZeroPixelsExact: exact.nonZeroPixels,
            nonZeroPixelsLam: lam.nonZeroPixels,
            deltaHistogram,
            boundingBox: differentPixels > 0 ? { minX, minY, maxX, maxY } : null,
            tileDifferentPixels,
            worstTile,
        };
    }

    private summariseCorrectness(
        frames: UikaLamFrameComparison[],
    ): UikaLamSortReport['correctness']['summary'] {
        if (frames.length === 0) return null;
        const worst = (pick: (f: UikaLamFrameComparison) => number) => {
            let value = -Infinity;
            let frame = -1;
            for (const f of frames) {
                const v = pick(f);
                if (v > value) { value = v; frame = f.frame; }
            }
            return { value, frame };
        };
        const tileTotals = new Array<number>(TILE_GRID * TILE_GRID).fill(0);
        for (const f of frames) {
            for (let t = 0; t < tileTotals.length; t++) tileTotals[t] += f.tileDifferentPixels[t];
        }
        return {
            framesCompared: frames.length,
            framesPixelIdentical: frames.filter((f) => f.pixelIdentical).length,
            framesWithDifference: frames.filter((f) => !f.pixelIdentical).length,
            worstDifferentPixels: worst((f) => f.differentPixels),
            worstDifferentPixelRatio: worst((f) => f.differentPixelRatio),
            worstMaxRgbaByteDelta: worst((f) => f.maxRgbaByteDelta),
            worstMaxAlphaByteDelta: worst((f) => f.maxAlphaByteDelta),
            framesWithAlphaDifference: frames.filter((f) => !f.alphaPlaneIdentical).length,
            meanDifferentPixelRatio: mean(frames.map((f) => f.differentPixelRatio)),
            tileDifferentPixelsTotal: tileTotals,
        };
    }

    /**
     * §9. Re-render the worst frames and keep both framebuffers plus a difference mask as
     * PNGs, so the mouth interior, lips, teeth, nose, eyes and face silhouette can be
     * looked at rather than inferred from a pixel count.
     */
    private async captureWorst(
        _frames: number[],
        comparisons: UikaLamFrameComparison[],
        options: UikaLamSortOptions,
        handles: any,
        viewer: any,
    ): Promise<UikaLamFrameCapture[]> {
        if (options.captureCount <= 0) return [];
        const worst = comparisons
            .filter((c) => c.differentPixels > 0)
            .sort((a, b) => b.differentPixels - a.differentPixels)
            .slice(0, options.captureCount);
        if (worst.length === 0) return [];

        const captures: UikaLamFrameCapture[] = [];
        viewer.setSortSuspended(true);
        this.live.phase = 'capturing';
        for (const c of worst) {
            if (this.abort) break;
            this.live.step = `capture frame ${c.frame}`;
            const held = this.replay.holdFrame(c.frame);
            this.runtime.applyWeights(new Float32Array(held.weights));
            this.pass!.markDirty();
            this.pass!.run();

            viewer.setDiagnosticExternalSortDriver(null);
            viewer.setDistanceProvider((m: any, out: Float32Array) => this.pass!.computeDistances(m, out));
            await this.sortOnce(viewer, 'the exact animated-centre sort');
            const exact = await this.nextFramePixels();

            viewer.setDistanceProvider(null);
            viewer.setDiagnosticExternalSortDriver(this.driver());
            await this.sortOnce(viewer, 'the LAM canonical-centre sort');
            const lam = await this.nextFramePixels();

            captures.push({
                frame: c.frame,
                differentPixels: c.differentPixels,
                exactPng: this.toPng(exact.pixels!, exact.width, exact.height, null),
                lamPng: this.toPng(lam.pixels!, lam.width, lam.height, null),
                diffPng: this.toPng(exact.pixels!, exact.width, exact.height, lam.pixels!),
            });
        }
        viewer.setDiagnosticExternalSortDriver(null);
        viewer.setDistanceProvider(null);
        viewer.setSortSuspended(false);
        return captures;
    }

    /**
     * `gl.readPixels` returns rows bottom-up, so the rows are flipped on the way into the
     * canvas. With `other` supplied the output is a difference mask: white where any RGBA
     * channel differs, black elsewhere.
     */
    private toPng(
        pixels: Uint8Array,
        width: number,
        height: number,
        other: Uint8Array | null,
    ): string {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d')!;
        const image = ctx.createImageData(width, height);
        const out = image.data;
        for (let y = 0; y < height; y++) {
            const src = (height - 1 - y) * width * 4;
            const dst = y * width * 4;
            for (let x = 0; x < width; x++) {
                const s = src + x * 4;
                const d = dst + x * 4;
                if (other) {
                    const differs = pixels[s] !== other[s] || pixels[s + 1] !== other[s + 1]
                        || pixels[s + 2] !== other[s + 2] || pixels[s + 3] !== other[s + 3];
                    const v = differs ? 255 : 0;
                    out[d] = v; out[d + 1] = v; out[d + 2] = v; out[d + 3] = 255;
                } else {
                    out[d] = pixels[s];
                    out[d + 1] = pixels[s + 1];
                    out[d + 2] = pixels[s + 2];
                    // Opaque, so the avatar is visible against the page.
                    out[d + 3] = 255;
                }
            }
        }
        ctx.putImageData(image, 0, 0);
        return canvas.toDataURL('image/png');
    }

    // ---------------------------------------------------------------- performance

    /**
     * §7 / §10. A, B and C measured round-robin so that session drift lands on all three
     * equally, each with `repeats` samples.
     */
    private async runPerformance(options: UikaLamSortOptions): Promise<void> {
        const r = this.report!;
        const order = RUN_ORDER;
        for (let repeat = 1; repeat <= options.repeats; repeat++) {
            for (const name of order) {
                if (this.abort) break;
                r.performance.samples.push(await this.measureRun(name, repeat, options));
            }
            if (this.abort) break;
        }
        r.performance.rollUps = order.map((name) => this.rollUp(name, r.performance.samples));
        r.performance.analysis = this.analyse(r.performance.rollUps, r.performance.samples);
    }

    private async measureRun(
        name: UikaLamRunName,
        repeat: number,
        options: UikaLamSortOptions,
    ): Promise<UikaLamRunSample> {
        const viewer = this.viewer();
        const host = this.host!;
        // Before anything is rewired: the previous run's sort must be finished. Installing
        // a distance source while one is in flight is refused, by design.
        await this.waitForSortIdle(viewer, options.idleTimeoutMs);
        const gl: WebGL2RenderingContext | null = viewer?.renderer?.getContext?.() ?? null;
        const ext = gl ? gl.getExtension('EXT_disjoint_timer_query_webgl2') : null;
        const timers = gl && ext ? new GpuTimerPool(gl, ext) : null;
        viewer.setGpuTimer?.(timers);
        this.pass!.setGpuTimer(timers as any);

        // Mode wiring. Only the sort differs between the three runs.
        const distanceProvider = (m: any, out: Float32Array) => this.pass!.computeDistances(m, out);
        if (name === 'A-no-sort') {
            viewer.setDiagnosticExternalSortDriver(null);
            host.setDistanceSource(null);
            viewer.setDistanceProvider(distanceProvider);
            viewer.setSortSuspended(true);
        } else if (name === 'B-exact-animated-centre-sort') {
            // Animated-centre GPU distance + fence + readback, then the main-thread sort.
            viewer.setDiagnosticExternalSortDriver(null);
            host.setDistanceSource(null);
            viewer.setDistanceProvider(distanceProvider);
            viewer.setSortSuspended(false);
        } else if (name === 'D-lam-exact-distance-worker-sort') {
            // The SAME distance provider as B — no second distance shader exists — with the
            // keys handed to the vendored worker as precomputedDistances.
            viewer.setDistanceProvider(null);
            host.setDistanceSource(distanceProvider);
            viewer.setDiagnosticExternalSortDriver(this.driver());
            viewer.setSortSuspended(false);
        } else {
            // Canonical centres, keys computed inside the worker, no GPU distance pass.
            viewer.setDistanceProvider(null);
            host.setDistanceSource(null);
            viewer.setDiagnosticExternalSortDriver(this.driver());
            viewer.setSortSuspended(false);
        }

        this.replay.stop();
        this.runtime.setExpressionSource(null);
        this.replay.start_();
        this.runtime.setExpressionSource(() => this.replay.tick());

        this.live.step = `${name} (repeat ${repeat})`;
        this.live.phase = 'warmup';
        const warmupStart = performance.now();
        await this.waitFor(() => performance.now() - warmupStart >= options.warmupMs);
        const warmupMs = performance.now() - warmupStart;

        // Let anything submitted during warm-up finish, so the measured window does not
        // report a completion it never paid for.
        this.live.phase = 'draining warm-up';
        const idleWaitStart = performance.now();
        const idleBeforeMeasurement = await this.waitForSortIdle(viewer, options.idleTimeoutMs);
        const idleWaitMs = performance.now() - idleWaitStart;

        const exactIntervals: number[] = [];
        let previousStart: number | null = null;
        let collecting = false;
        viewer.setFrameTickHook((tick: { startedAt: number }) => {
            if (!collecting) { previousStart = tick.startedAt; return; }
            if (previousStart !== null) exactIntervals.push(tick.startedAt - previousStart);
            previousStart = tick.startedAt;
        });

        timers?.reset();
        if (timers) timers.maxValidMs = options.measureMs;
        timers?.setCollecting(true);
        this.replay.resetInstrumentation();
        this.pass!.resetStats();
        host.resetStats();

        const frames0 = viewer.stats.renderedFrames;
        const glErrors0 = viewer.stats.glErrorCount;
        const sortRuns0 = viewer.stats.sortRuns;
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
                if (exactIntervals.length > 0) this.live.exactP95 = summariseStage(exactIntervals).p95;
            },
        );
        collecting = false;
        const measuredMs = performance.now() - measureStart;
        // Snapshot BEFORE the drain. The drain renders frames too, and on a slow renderer
        // it can render more of them than the measured window did; counting those against
        // `measuredMs` inflates effectiveFPS. The container self-test showed exactly that:
        // run C reported 3 rendered frames with 0 measured frame intervals.
        const framesAtWindowEnd = viewer.stats.renderedFrames;

        this.live.phase = 'draining';
        const drainStart = performance.now();
        const drainedAfterMeasurement = await this.waitForSortIdle(viewer, options.idleTimeoutMs);
        const drainWaitMs = performance.now() - drainStart;
        document.removeEventListener('visibilitychange', onVis);
        if (hiddenSince !== null) visibilityLostMs += performance.now() - hiddenSince;
        timers?.setCollecting(false);
        viewer.setFrameTickHook(null);

        const renderedFrames = framesAtWindowEnd - frames0;
        const framesDuringDrain = viewer.stats.renderedFrames - framesAtWindowEnd;
        const effectiveFPS = measuredMs > 0 ? renderedFrames / (measuredMs / 1000) : 0;
        this.live.fps = effectiveFPS;
        const hostStats: UikaLamSortStats = host.getStats();
        const passStats = this.pass!.getStats();
        const seconds = measuredMs / 1000;

        const sample: UikaLamRunSample = {
            name,
            repeat,
            warmupMs,
            measuredMs,
            renderedFrames,
            framesDuringDrain,
            effectiveFPS,
            exactFrameInterval: summariseStage(exactIntervals),
            gpuDraw: summariseStage(timers?.drawMs ?? []),
            gpuSortSubmission: summariseStage(timers?.sortMs ?? []),
            predeform: summariseStage(timers?.predeformMs ?? []),
            invalidGpuTimerSamples: timers?.invalidMs.length ?? 0,
            worker: (name === 'C-lam-canonical-centre-worker-sort'
                || name === 'D-lam-exact-distance-worker-sort')
                ? {
                    sortRequested: hostStats.sortRequested,
                    sortSubmitted: hostStats.sortSubmitted,
                    sortCompleted: hostStats.sortCompleted,
                    sortSkippedWhileRunning: hostStats.sortSkippedWhileRunning,
                    sortSkippedBeforeReady: hostStats.sortSkippedBeforeReady,
                    workerSortMs: summariseStage(hostStats.workerSortMsSamples),
                    indexUpdateMs: summariseStage(hostStats.indexUpdateMsSamples),
                    submitMs: summariseStage(hostStats.submitMsSamples),
                    roundTripMs: summariseStage(hostStats.roundTripMsSamples),
                    distanceStageMs: summariseStage(hostStats.distanceStageMsSamples),
                    usePrecomputedDistances: name === 'D-lam-exact-distance-worker-sort',
                    workerErrors: hostStats.workerErrors,
                    distanceErrors: hostStats.distanceErrors,
                    effectiveSortHz: seconds > 0 ? hostStats.sortCompleted / seconds : 0,
                }
                : null,
            exactPath: name === 'B-exact-animated-centre-sort'
                ? {
                    sortRuns: viewer.stats.sortRuns - sortRuns0,
                    effectiveSortHz: seconds > 0 ? (viewer.stats.sortRuns - sortRuns0) / seconds : 0,
                    predeformPasses: passStats.passCount,
                }
                : null,
            gpuDistance: {
                submitted: passStats.gpuDistanceSubmittedCount,
                cpuCompletions: passStats.cpuCompletionCount,
                readbacks: passStats.cpuReadbackCount,
                fencePolls: passStats.fencePollCount,
                gpuOnlySubmitted: passStats.gpuOnlyDistanceSubmittedCount,
            },
            glErrors: viewer.stats.glErrorCount - glErrors0,
            pageErrors: this.pageErrors - pageErrors0,
            weightUploads: this.replay.getStats().weightUploadCount,
            visibilityLostMs,
            idleBeforeMeasurement,
            idleWaitMs,
            drainedAfterMeasurement,
            drainWaitMs,
            submittedEqualsCompleted: (name === 'C-lam-canonical-centre-worker-sort'
                || name === 'D-lam-exact-distance-worker-sort')
                ? hostStats.sortSubmitted === hostStats.sortCompleted
                : true,
        };

        viewer.setDiagnosticExternalSortDriver(null);
        host.setDistanceSource(null);
        viewer.setSortSuspended(false);
        viewer.setGpuTimer?.(null);
        this.pass!.setGpuTimer(null as any);
        return sample;
    }

    private rollUp(name: UikaLamRunName, samples: UikaLamRunSample[]): UikaLamRunRollUp {
        const mine = samples.filter((s) => s.name === name);
        const p95s = mine.map((s) => s.exactFrameInterval.p95);
        const workerP50s = mine.map((s) => s.worker?.workerSortMs.p50).filter((v): v is number => v !== undefined);
        const indexP50s = mine.map((s) => s.worker?.indexUpdateMs.p50).filter((v): v is number => v !== undefined);
        const hz = mine.map((s) => s.worker?.effectiveSortHz).filter((v): v is number => v !== undefined);
        const distP50s = mine.map((s) => s.worker?.distanceStageMs.p50)
            .filter((v): v is number => v !== undefined && v > 0);
        return {
            name,
            repeats: mine.length,
            intervalSamples: mine.reduce((n, s) => n + s.exactFrameInterval.count, 0),
            meanEffectiveFPS: mean(mine.map((s) => s.effectiveFPS)),
            meanExactP95Ms: mean(p95s),
            spreadExactP95Ms: p95s.length > 1 ? Math.max(...p95s) - Math.min(...p95s) : 0,
            meanGpuDrawP50Ms: mean(mine.map((s) => s.gpuDraw.p50)),
            meanWorkerSortP50Ms: workerP50s.length > 0 ? mean(workerP50s) : null,
            meanIndexUpdateP50Ms: indexP50s.length > 0 ? mean(indexP50s) : null,
            meanDistanceStageP50Ms: distP50s.length > 0 ? mean(distP50s) : null,
            meanEffectiveSortHz: hz.length > 0 ? mean(hz) : null,
        };
    }

    /**
     * §10. The comparison is between means, not first runs, and the run-to-run spread is
     * reported next to every difference so that a difference inside the spread can be
     * seen for what it is.
     */
    private analyse(
        rollUps: UikaLamRunRollUp[],
        samples: UikaLamRunSample[],
    ): UikaLamSortReport['performance']['analysis'] {
        const a = rollUps.find((x) => x.name === 'A-no-sort');
        const b = rollUps.find((x) => x.name === 'B-exact-animated-centre-sort');
        const c = rollUps.find((x) => x.name === 'C-lam-canonical-centre-worker-sort');
        const d = rollUps.find((x) => x.name === 'D-lam-exact-distance-worker-sort');
        if (!a || !b || !c || !d) return null;
        if (a.repeats === 0 || b.repeats === 0 || c.repeats === 0 || d.repeats === 0) return null;

        const of = (name: UikaLamRunName) => samples.filter((s) => s.name === name);
        const cSamples = of('C-lam-canonical-centre-worker-sort');
        const dSamples = of('D-lam-exact-distance-worker-sort');
        // Read off the pre-deformation pass's own counters, not inferred from timings:
        // C must have run no GPU distance pass, D must have run one on every submission.
        const readbackPathExercisedInC = cSamples.some((s) => s.gpuDistance.submitted > 0
            || s.gpuDistance.readbacks > 0);
        const readbackPathExercisedInD = dSamples.some((s) => s.gpuDistance.submitted > 0
            && s.gpuDistance.readbacks > 0);
        const dUsedPrecomputedDistances = dSamples.length > 0
            && dSamples.every((s) => s.worker?.usePrecomputedDistances === true);

        const invalidReasons: string[] = [];
        for (const run of [a, b, c, d]) {
            if (run.intervalSamples < MIN_INTERVALS_FOR_COMPARISON) {
                invalidReasons.push(`${run.name} measured only ${run.intervalSamples} frame `
                    + `intervals over ${run.repeats} repeat(s); `
                    + `${MIN_INTERVALS_FOR_COMPARISON} are required before its p95 is `
                    + 'comparable');
            }
        }
        // D without its distance pass is not D, and the gate says so explicitly.
        if (!readbackPathExercisedInD) {
            invalidReasons.push('D-lam-exact-distance-worker-sort ran no GPU distance pass '
                + 'with a readback; it is not the exact-distance variant and cannot be '
                + 'compared against B or C');
        }
        if (!dUsedPrecomputedDistances) {
            invalidReasons.push('D-lam-exact-distance-worker-sort did not submit with '
                + 'usePrecomputedDistances = true');
        }
        if (dSamples.some((s) => (s.worker?.distanceErrors ?? 0) > 0)) {
            invalidReasons.push('D-lam-exact-distance-worker-sort recorded GPU distance '
                + 'errors');
        }
        for (const sample of samples) {
            if (!sample.idleBeforeMeasurement) {
                invalidReasons.push(`${sample.name} r${sample.repeat}: the warm-up drain `
                    + `timed out after ${sample.idleWaitMs.toFixed(0)} ms, so a sort from `
                    + 'warm-up could complete inside the measured window');
            }
            if (!sample.drainedAfterMeasurement) {
                invalidReasons.push(`${sample.name} r${sample.repeat}: the post-window drain `
                    + `timed out after ${sample.drainWaitMs.toFixed(0)} ms`);
            }
            if (!sample.submittedEqualsCompleted) {
                invalidReasons.push(`${sample.name} r${sample.repeat}: submitted `
                    + `${sample.worker?.sortSubmitted} sorts but completed `
                    + `${sample.worker?.sortCompleted}`);
            }
        }

        if (invalidReasons.length > 0) {
            return {
                valid: false,
                invalidReasons,
                workerMigrationP95DeltaMs: null,
                workerMigrationFpsDelta: null,
                distanceReadbackP95DeltaMs: null,
                distanceReadbackFpsDelta: null,
                canonicalSortResidualP95Ms: null,
                canonicalSortResidualFps: null,
                exactP95DeltaMs: null,
                effectiveFpsDelta: null,
                tailGapAboveNoSortB: null,
                tailGapAboveNoSortC: null,
                tailGapAboveNoSortD: null,
                tailGapClosedShare: null,
                tailGapClosedShareD: null,
                readbackPathExercisedInC,
                readbackPathExercisedInD,
                dUsedPrecomputedDistances,
                cMeetsTarget: null,
                bMeetsTarget: null,
                dMeetsTarget: null,
            };
        }

        const tailGapAboveNoSortB = b.meanExactP95Ms - a.meanExactP95Ms;
        const tailGapAboveNoSortC = c.meanExactP95Ms - a.meanExactP95Ms;
        const tailGapAboveNoSortD = d.meanExactP95Ms - a.meanExactP95Ms;
        const meets = (x: UikaLamRunRollUp) => x.meanEffectiveFPS >= LAM_SORT_TARGET.minFps
            && x.meanExactP95Ms <= LAM_SORT_TARGET.maxExactWallP95Ms;
        return {
            valid: true,
            invalidReasons,
            // B vs D: same keys, same readback, different sort.
            workerMigrationP95DeltaMs: d.meanExactP95Ms - b.meanExactP95Ms,
            workerMigrationFpsDelta: d.meanEffectiveFPS - b.meanEffectiveFPS,
            // D vs C: same worker, same back-pressure, different distance source.
            distanceReadbackP95DeltaMs: c.meanExactP95Ms - d.meanExactP95Ms,
            distanceReadbackFpsDelta: c.meanEffectiveFPS - d.meanEffectiveFPS,
            // A vs C: what the canonical worker sort still costs over no sort at all.
            canonicalSortResidualP95Ms: c.meanExactP95Ms - a.meanExactP95Ms,
            canonicalSortResidualFps: a.meanEffectiveFPS - c.meanEffectiveFPS,
            exactP95DeltaMs: c.meanExactP95Ms - b.meanExactP95Ms,
            effectiveFpsDelta: c.meanEffectiveFPS - b.meanEffectiveFPS,
            tailGapAboveNoSortB,
            tailGapAboveNoSortC,
            tailGapAboveNoSortD,
            tailGapClosedShare: tailGapAboveNoSortB > 0
                ? (tailGapAboveNoSortB - tailGapAboveNoSortC) / tailGapAboveNoSortB
                : null,
            tailGapClosedShareD: tailGapAboveNoSortB > 0
                ? (tailGapAboveNoSortB - tailGapAboveNoSortD) / tailGapAboveNoSortB
                : null,
            readbackPathExercisedInC,
            readbackPathExercisedInD,
            dUsedPrecomputedDistances,
            cMeetsTarget: meets(c),
            bMeetsTarget: meets(b),
            dMeetsTarget: meets(d),
        };
    }

    // ---------------------------------------------------------------- utilities

    /**
     * One sort through whichever path is installed, with a deadline. A worker that never
     * answers, or a fence that never signals, must fail the run rather than hang it — a
     * 192-frame sweep has 384 of these.
     */
    private async sortOnce(viewer: any, label: string): Promise<boolean> {
        let timer = 0;
        try {
            return await Promise.race([
                viewer.runDiagnosticSortOnce() as Promise<boolean>,
                new Promise<boolean>((_, reject) => {
                    timer = window.setTimeout(
                        () => reject(new Error(`UIKA LAM sort PoC: ${label} did not complete `
                            + `within ${SORT_TIMEOUT_MS} ms`)), SORT_TIMEOUT_MS);
                }),
            ]);
        } finally {
            window.clearTimeout(timer);
        }
    }

    private async nextFramePixels(): Promise<UikaDrawingBufferHash> {
        const viewer = this.viewer();
        let timer = 0;
        try {
            return await Promise.race([
                viewer.requestDrawingBufferPixels() as Promise<UikaDrawingBufferHash>,
                new Promise<UikaDrawingBufferHash>((_, reject) => {
                    timer = window.setTimeout(
                        () => reject(new Error('UIKA LAM sort PoC: no frame within 30000 ms')), 30000);
                }),
            ]);
        } finally {
            window.clearTimeout(timer);
            viewer.clearPendingDrawingBufferHash?.();
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

    /**
     * The weights move on nearly every frame, so a sort completing is immediately followed
     * by the next submission. Waiting for idle therefore has to suspend sorting first, then
     * put it back exactly as it was — the lesson from Gate 4B-2B-2 §8.
     */
    private async waitForSortIdle(viewer: any, timeoutMs: number): Promise<boolean> {
        const wasSuspended = viewer.isSortSuspended?.() ?? false;
        viewer.setSortSuspended?.(true);
        const start = performance.now();
        try {
            while (viewer.isSortPending?.()) {
                if (performance.now() - start >= timeoutMs) return false;
                await new Promise<void>((resolve) => { requestAnimationFrame(() => resolve()); });
            }
            return true;
        } finally {
            viewer.setSortSuspended?.(wasSuspended);
        }
    }
}
