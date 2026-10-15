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
    | 'C-lam-canonical-centre-worker-sort';

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
        workerErrors: number;
        effectiveSortHz: number;
    } | null;
    /** The exact path's own counters, for the B run. */
    exactPath: {
        sortRuns: number;
        effectiveSortHz: number;
        predeformPasses: number;
    } | null;
    glErrors: number;
    pageErrors: number;
    weightUploads: number;
    visibilityLostMs: number;
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
            /** C vs B on the metric this gate exists for. */
            exactP95DeltaMs: number | null;
            effectiveFpsDelta: number | null;
            /** How much of the B-over-A tail the LAM path closes. */
            tailGapAboveNoSortB: number | null;
            tailGapAboveNoSortC: number | null;
            tailGapClosedShare: number | null;
            /** Reported whatever the validity: a contaminated run C is a fact on its own. */
            readbackPathExercisedInC: boolean;
            cMeetsTarget: boolean | null;
            bMeetsTarget: boolean | null;
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
    allowSoftware: boolean;
    /** Off by default: UIKA's SplatMesh uses float centres, see LAM_SORT_DEFAULTS. */
    integerBasedSort: boolean;
    skipCorrectness: boolean;
    skipPerformance: boolean;
}

export const DEFAULT_LAM_SORT_OPTIONS: UikaLamSortOptions = {
    frames: null,
    repeats: 2,
    warmupMs: 2000,
    measureMs: 8000,
    captureCount: 4,
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

    private driver(): UikaExternalSortDriver {
        const host = this.host!;
        return {
            request: (mvp: ArrayLike<number>) => host.request(mvp),
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
        const order: UikaLamRunName[] = [
            'A-no-sort',
            'B-exact-animated-centre-sort',
            'C-lam-canonical-centre-worker-sort',
        ];
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
        const gl: WebGL2RenderingContext | null = viewer?.renderer?.getContext?.() ?? null;
        const ext = gl ? gl.getExtension('EXT_disjoint_timer_query_webgl2') : null;
        const timers = gl && ext ? new GpuTimerPool(gl, ext) : null;
        viewer.setGpuTimer?.(timers);
        this.pass!.setGpuTimer(timers as any);

        // Mode wiring. Only the sort differs between the three runs.
        if (name === 'A-no-sort') {
            viewer.setDiagnosticExternalSortDriver(null);
            viewer.setDistanceProvider((m: any, out: Float32Array) => this.pass!.computeDistances(m, out));
            viewer.setSortSuspended(true);
        } else if (name === 'B-exact-animated-centre-sort') {
            viewer.setDiagnosticExternalSortDriver(null);
            viewer.setDistanceProvider((m: any, out: Float32Array) => this.pass!.computeDistances(m, out));
            viewer.setSortSuspended(false);
        } else {
            viewer.setDistanceProvider(null);
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
        await this.waitForSortIdle(viewer, 10000);

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
        await this.waitForSortIdle(viewer, 10000);
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
            worker: name === 'C-lam-canonical-centre-worker-sort'
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
                    workerErrors: hostStats.workerErrors,
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
            glErrors: viewer.stats.glErrorCount - glErrors0,
            pageErrors: this.pageErrors - pageErrors0,
            weightUploads: this.replay.getStats().weightUploadCount,
            visibilityLostMs,
        };

        viewer.setDiagnosticExternalSortDriver(null);
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
        if (!a || !b || !c || a.repeats === 0 || b.repeats === 0 || c.repeats === 0) return null;

        const cSamples = samples.filter((s) => s.name === 'C-lam-canonical-centre-worker-sort');
        // Reported whether or not the comparison is valid: if any GPU sort-submission timer
        // sample appears in run C then the GPU distance pass ran, and run C is not the
        // readback-free path it is supposed to be.
        const readbackPathExercisedInC = cSamples.some((s) => s.gpuSortSubmission.count > 0);

        const invalidReasons: string[] = [];
        for (const run of [a, b, c]) {
            if (run.intervalSamples < MIN_INTERVALS_FOR_COMPARISON) {
                invalidReasons.push(`${run.name} measured only ${run.intervalSamples} frame `
                    + `intervals over ${run.repeats} repeat(s); `
                    + `${MIN_INTERVALS_FOR_COMPARISON} are required before its p95 is `
                    + 'comparable');
            }
        }
        if (invalidReasons.length > 0) {
            return {
                valid: false,
                invalidReasons,
                exactP95DeltaMs: null,
                effectiveFpsDelta: null,
                tailGapAboveNoSortB: null,
                tailGapAboveNoSortC: null,
                tailGapClosedShare: null,
                readbackPathExercisedInC,
                cMeetsTarget: null,
                bMeetsTarget: null,
            };
        }

        const tailGapAboveNoSortB = b.meanExactP95Ms - a.meanExactP95Ms;
        const tailGapAboveNoSortC = c.meanExactP95Ms - a.meanExactP95Ms;
        return {
            valid: true,
            invalidReasons,
            exactP95DeltaMs: c.meanExactP95Ms - b.meanExactP95Ms,
            effectiveFpsDelta: c.meanEffectiveFPS - b.meanEffectiveFPS,
            tailGapAboveNoSortB,
            tailGapAboveNoSortC,
            tailGapClosedShare: tailGapAboveNoSortB > 0
                ? (tailGapAboveNoSortB - tailGapAboveNoSortC) / tailGapAboveNoSortB
                : null,
            readbackPathExercisedInC,
            cMeetsTarget: c.meanEffectiveFPS >= LAM_SORT_TARGET.minFps
                && c.meanExactP95Ms <= LAM_SORT_TARGET.maxExactWallP95Ms,
            bMeetsTarget: b.meanEffectiveFPS >= LAM_SORT_TARGET.minFps
                && b.meanExactP95Ms <= LAM_SORT_TARGET.maxExactWallP95Ms,
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
