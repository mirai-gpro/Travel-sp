// UIKA Native Runtime v1.1 — Gate 4B-2A Pre-Deformation PoC harness
//
// Correctness first, performance second. Nothing here is integrated into production:
// the PoC render variant and the PoC distance pass are installed on the viewer for the
// duration of a run and removed again at the end.

import type { UikaNativeRuntime } from './uika-native-runtime';
import type { UikaNativeReplay } from './uika-native-replay';
import type { UikaDiagnosticShaderInfo, UikaDrawingBufferInfo, UikaDrawingBufferHash } from './renderer';
import { applyUikaBasisWeightsCpu, singleUikaBasisWeight } from './uika-deformation';
import {
    GpuTimerPool,
    collectGpuInfo,
    summariseIntervals,
    type UikaGpuInfo,
    type UikaIntervalStats,
} from './uika-native-benchmark';
import {
    UikaPredeformPass,
    type UikaPredeformCapabilities,
    type UikaPredeformLayout,
} from './predeform/uika-predeform-pass';

/** Decision rules for this gate, not measured quantities. */
export const CORRECTNESS_MAX_ABS_XYZ_ERROR = 1e-6;
export const CORRECTNESS_MAX_ABS_DISTANCE_DIFF = 1e-6;
/** The figure Gate 3B measured for the production GPU path against the same CPU reference. */
export const GATE3B_REFERENCE_MAX_ABS_ERROR = 9.80e-9;

export const A2E_CORRECTNESS_FRAMES = [20, 63, 123, 132, 191];
export const MORPH_CORRECTNESS_CHANNELS = [
    'jawOpen', 'eyeBlinkLeft', 'eyeBlinkRight', 'mouthSmileLeft', 'mouthSmileRight',
];
/** The pose every performance test holds, as in Gate 4A Test B and Gate 4B-1. */
export const PREDEFORM_POSE_FRAME = 20;

export interface UikaCorrectnessCase {
    name: string;
    kind: 'neutral' | 'morph' | 'a2e-frame';
    detail: string;
    nonZeroWeights: number;
    gaussiansCompared: number;
    /** Pre-deformed centres against the CPU reference, over every Gaussian. */
    maxAbsXyzError: number;
    meanAbsXyzError: number;
    maxAbsXyzErrorIndex: number;
    nonFiniteCenters: number;
    /** The production 51-channel GPU distance pass against the PoC distance pass. */
    maxAbsDistanceDiff: number;
    maxAbsDistanceDiffIndex: number;
    productionDistanceMin: number;
    productionDistanceMax: number;
    /** Rendered frames, same camera, same suspended sort order, same resolution. */
    productionFrame: UikaDrawingBufferHash | null;
    predeformFrame: UikaDrawingBufferHash | null;
    framesIdentical: boolean | null;
    pass: boolean;
    failures: string[];
}

export interface UikaPredeformMeasurement {
    label: string;
    mode: 'production-51-basis' | 'predeform';
    test: 'fixed-pose' | 'real-a2e';
    pixelRatio: number;
    buffer: UikaDrawingBufferInfo;
    shader: UikaDiagnosticShaderInfo;
    warmupMs: number;
    measuredMs: number;
    renderedFrames: number;
    effectiveFPS: number;
    frameInterval: UikaIntervalStats;
    gpuAvailable: boolean;
    gpuPredeformMs: UikaIntervalStats | null;
    gpuDrawMs: UikaIntervalStats | null;
    gpuSortMs: UikaIntervalStats | null;
    gpuInvalidSamples: number;
    gpuInvalidValuesMs: number[];
    gpuDisjointDiscarded: number;
    sortRuns: number;
    /** Gate 4B-2A §13: must not exceed the number of expression frames that changed. */
    predeformPassCount: number;
    weightChangeCount: number;
    weightUploadCount: number | null;
    predeformPassesWithinChanges: boolean | null;
    glErrors: number;
    pageErrors: number;
    visibilityLostMs: number;
    valid: boolean;
    invalidReason: string | null;
}

export interface UikaPredeformReport {
    spec: 'UIKA Native Runtime v1.1 Gate 4B-2A';
    startedAt: string;
    finishedAt: string | null;
    gpu: UikaGpuInfo;
    realGpu: boolean;
    capabilities: UikaPredeformCapabilities | null;
    layout: UikaPredeformLayout | null;
    runtime: {
        gaussianCount: number;
        basisCount: number;
        basisResident: boolean;
        oacFreeCheck: Record<string, boolean>;
    };
    correctness: UikaCorrectnessCase[];
    correctnessVerdict: 'PASS' | 'FAIL' | 'NOT_RUN';
    measurements: UikaPredeformMeasurement[];
    analysis: {
        dpr: number;
        production: { fixedPoseDrawP50: number | null; realA2eFps: number | null;
                      realA2eDrawP50: number | null; realA2eSortP50: number | null } | null;
        predeform: { fixedPoseDrawP50: number | null; realA2eFps: number | null;
                     realA2eDrawP50: number | null; realA2eSortP50: number | null;
                     realA2ePredeformP50: number | null } | null;
        dpr1: { productionFps: number | null; predeformFps: number | null } | null;
        drawSavedMs: number | null;
        sortSavedMs: number | null;
    } | null;
    fullDprPerf: 'PASS' | 'FAIL' | 'NOT_RUN';
    dpr1Perf: 'PASS' | 'FAIL' | 'NOT_RUN';
    decision: string[];
    reasons: string[];
    restoredShader: UikaDiagnosticShaderInfo | null;
}

export interface UikaPredeformOptions {
    warmupMs: number;
    measureMs: number;
    /** Run the DPR 1.0 diagnostic. null = only when full DPR misses 30 fps. */
    forceDpr1: boolean | null;
    allowSoftware: boolean;
    /** Correctness only, for a quick check on a machine that cannot measure. */
    correctnessOnly: boolean;
}

export const DEFAULT_PREDEFORM_OPTIONS: UikaPredeformOptions = {
    warmupMs: 6000,
    measureMs: 30000,
    forceDpr1: null,
    allowSoftware: false,
    correctnessOnly: false,
};

/** `?warmupMs=`, `?measureMs=`, `?dpr1=1|0`, `?allowSoftware=1`, `?correctnessOnly=1`. */
export function predeformOptionsFromUrl(): UikaPredeformOptions {
    const o = { ...DEFAULT_PREDEFORM_OPTIONS };
    try {
        const q = new URLSearchParams(window.location.search);
        const warm = Number(q.get('warmupMs'));
        const meas = Number(q.get('measureMs'));
        if (Number.isFinite(warm) && warm > 0) o.warmupMs = warm;
        if (Number.isFinite(meas) && meas > 0) o.measureMs = meas;
        if (q.get('dpr1') === '1') o.forceDpr1 = true;
        if (q.get('dpr1') === '0') o.forceDpr1 = false;
        if (q.get('allowSoftware') === '1') o.allowSoftware = true;
        if (q.get('correctnessOnly') === '1') o.correctnessOnly = true;
    } catch { /* noop */ }
    return o;
}

export class UikaPredeformBenchmark {
    private report: UikaPredeformReport | null = null;
    private pass: UikaPredeformPass | null = null;
    private running = false;
    private abort = false;
    private pageErrors = 0;
    private live = {
        step: '', phase: 'idle', elapsedMs: 0, mode: '', effectiveFPS: 0,
        drawP50: 0, predeformP50: 0, visible: true,
    };

    constructor(
        private readonly runtime: UikaNativeRuntime,
        private readonly replay: UikaNativeReplay,
    ) {
        window.addEventListener('error', () => { this.pageErrors++; });
        window.addEventListener('unhandledrejection', () => { this.pageErrors++; });
    }

    getLive() { return { ...this.live }; }
    getReport(): UikaPredeformReport | null { return this.report; }
    isRunning(): boolean { return this.running; }
    stop(): void { this.abort = true; }
    getPass(): UikaPredeformPass | null { return this.pass; }

    private viewer(): any { return this.runtime.getViewer(); }
    private gl(): WebGL2RenderingContext | null { return this.viewer()?.renderer?.getContext?.() ?? null; }
    private canvas(): HTMLCanvasElement | null { return this.viewer()?.renderer?.domElement ?? null; }

    async run(options: UikaPredeformOptions = DEFAULT_PREDEFORM_OPTIONS): Promise<UikaPredeformReport> {
        if (this.running) throw new Error('UIKA Gate 4B-2A: already running');
        this.running = true;
        this.abort = false;

        const gpu = collectGpuInfo(this.canvas());
        const realGpu = !gpu.isSoftware && gpu.unmaskedAvailable;
        const rt: any = this.runtime.report;
        const viewer = this.viewer();

        this.report = {
            spec: 'UIKA Native Runtime v1.1 Gate 4B-2A',
            startedAt: new Date().toISOString(),
            finishedAt: null,
            gpu,
            realGpu,
            capabilities: null,
            layout: null,
            runtime: {
                gaussianCount: rt.gaussianCount,
                basisCount: rt.basisCount,
                basisResident: rt.basisResident,
                oacFreeCheck: rt.oacFreeCheck,
            },
            correctness: [],
            correctnessVerdict: 'NOT_RUN',
            measurements: [],
            analysis: null,
            fullDprPerf: 'NOT_RUN',
            dpr1Perf: 'NOT_RUN',
            decision: [],
            reasons: [],
            restoredShader: null,
        };
        const r = this.report;

        try {
            const caps = UikaPredeformPass.capabilities(this.gl());
            r.capabilities = caps;
            if (caps.blockers.length > 0) {
                r.decision = ['PREDEFORM_BLOCKED'];
                r.reasons.push(...caps.blockers);
                return r;
            }

            const handles = viewer.getPoCHandles();
            if (!handles) {
                r.decision = ['PREDEFORM_BLOCKED'];
                r.reasons.push('the viewer has no renderer or no splat mesh yet');
                return r;
            }

            this.pass = new UikaPredeformPass();
            r.layout = this.pass.init(handles);

            // The deformation pass runs at the top of every frame, but only when the
            // weights actually changed; the viewer's weight setter is what marks it dirty.
            viewer.setPreRenderHook(() => { this.pass?.runIfDirty(); });
            const weightHook = () => { this.pass?.markDirty(); };
            viewer.setExpressionWeightHook?.(weightHook);

            r.correctness = await this.runCorrectness(handles);
            r.correctnessVerdict = r.correctness.length > 0 && r.correctness.every((c) => c.pass)
                ? 'PASS' : 'FAIL';

            if (r.correctnessVerdict === 'FAIL') {
                r.decision = ['PREDEFORM_CORRECTNESS_FAIL'];
                r.reasons.push('no performance number is reported: the PoC must be correct first');
                for (const c of r.correctness) for (const f of c.failures) r.reasons.push(`${c.name}: ${f}`);
                return r;
            }
            if (options.correctnessOnly) {
                r.decision = ['PREDEFORM_CORRECTNESS_PASS', 'PERF_NOT_RUN'];
                r.reasons.push('correctnessOnly=1: no performance measurement was taken');
                return r;
            }

            // --- performance, full DPR -----------------------------------------
            const dpr = window.devicePixelRatio || 1;
            for (const test of ['fixed-pose', 'real-a2e'] as const) {
                for (const mode of ['production-51-basis', 'predeform'] as const) {
                    if (this.abort) break;
                    r.measurements.push(await this.measure(mode, test, 1, options));
                }
            }

            r.analysis = this.analyse(dpr);
            this.decideFullDpr();

            const needDpr1 = options.forceDpr1 ?? (r.fullDprPerf !== 'PASS' && dpr !== 1);
            if (needDpr1 && !this.abort) {
                const scale = 1 / dpr;
                for (const mode of ['production-51-basis', 'predeform'] as const) {
                    if (this.abort) break;
                    r.measurements.push(await this.measure(mode, 'real-a2e', scale, options));
                }
                r.analysis = this.analyse(dpr);
                this.decideDpr1();
            } else if (dpr === 1) {
                r.reasons.push('devicePixelRatio is already 1, so the DPR 1.0 diagnostic is the same run');
            }
        } finally {
            try {
                viewer?.setPreRenderHook?.(null);
                viewer?.setExpressionWeightHook?.(null);
                viewer?.setDistanceProvider?.(null);
                viewer?.setPredeformCenterTexture?.(null, 0, 0);
                viewer?.setSortSuspended?.(false);
                viewer?.setDrawingBufferScale?.(1);
                viewer?.setGpuTimer?.(null);
                r.restoredShader = viewer?.getDiagnosticShaderInfo?.() ?? null;
            } catch { /* reported by restoredShader being null */ }
            this.pass?.dispose();
            this.pass = null;
            this.replay.stop();
            this.runtime.setExpressionSource(null);
            this.runtime.setNeutral();
            this.live.phase = 'idle';
            this.live.step = '';
            this.running = false;
        }

        this.finishDecision();
        r.finishedAt = new Date().toISOString();
        return r;
    }

    // -----------------------------------------------------------------------
    // Correctness
    // -----------------------------------------------------------------------

    private async hashNextFrame(): Promise<UikaDrawingBufferHash> {
        const viewer = this.viewer();
        let timer = 0;
        try {
            return await Promise.race([
                viewer.requestDrawingBufferHash() as Promise<UikaDrawingBufferHash>,
                new Promise<UikaDrawingBufferHash>((_, reject) => {
                    timer = window.setTimeout(
                        () => reject(new Error('UIKA Gate 4B-2A: no frame was rendered within 20000 ms')),
                        20000,
                    );
                }),
            ]);
        } finally {
            window.clearTimeout(timer);
            viewer.clearPendingDrawingBufferHash?.();
        }
    }

    private async runCorrectness(handles: any): Promise<UikaCorrectnessCase[]> {
        const viewer = this.viewer();
        const asset = this.runtime.getAsset();
        if (!asset) throw new Error('UIKA Gate 4B-2A: the asset is not loaded');
        const cases: UikaCorrectnessCase[] = [];
        const names = asset.basis.names;

        this.live.phase = 'correctness';
        this.replay.stop();
        this.runtime.setExpressionSource(null);
        viewer.setDrawingBufferScale(1);
        // One draw order for every comparison, so a pixel difference can only come from
        // the centres and never from the compositing order.
        viewer.setSortSuspended(true);

        const todo: Array<{ name: string; kind: UikaCorrectnessCase['kind']; detail: string;
                            weights: Float32Array }> = [];

        todo.push({
            name: 'A-neutral', kind: 'neutral', detail: 'all 51 weights zero',
            weights: new Float32Array(names.length),
        });

        for (const channel of MORPH_CORRECTNESS_CHANNELS) {
            if (!names.includes(channel)) {
                cases.push(this.missingChannelCase(channel, names.length));
                continue;
            }
            todo.push({
                name: `B-${channel}`, kind: 'morph', detail: `${channel} = 1.0`,
                weights: singleUikaBasisWeight(names, channel, 1.0),
            });
        }

        for (const frame of A2E_CORRECTNESS_FRAMES) {
            const held = this.replay.holdFrame(frame);
            todo.push({
                name: `C-a2e-frame-${frame}`, kind: 'a2e-frame',
                detail: `fixture frame ${frame} through the production mapper`,
                weights: new Float32Array(held.weights),
            });
        }

        for (const item of todo) {
            if (this.abort) break;
            this.live.step = item.name;
            cases.push(await this.oneCorrectnessCase(item, handles, asset));
        }

        viewer.setSortSuspended(false);
        return cases;
    }

    private missingChannelCase(channel: string, basisCount: number): UikaCorrectnessCase {
        return {
            name: `B-${channel}`, kind: 'morph', detail: `${channel} is not in the basis`,
            nonZeroWeights: 0, gaussiansCompared: 0,
            maxAbsXyzError: Number.NaN, meanAbsXyzError: Number.NaN, maxAbsXyzErrorIndex: -1,
            nonFiniteCenters: 0,
            maxAbsDistanceDiff: Number.NaN, maxAbsDistanceDiffIndex: -1,
            productionDistanceMin: Number.NaN, productionDistanceMax: Number.NaN,
            productionFrame: null, predeformFrame: null, framesIdentical: null,
            pass: false,
            failures: [`the basis has ${basisCount} channels and none of them is ${channel}`],
        };
    }

    private async oneCorrectnessCase(
        item: { name: string; kind: UikaCorrectnessCase['kind']; detail: string; weights: Float32Array },
        handles: any,
        asset: any,
    ): Promise<UikaCorrectnessCase> {
        const viewer = this.viewer();
        const failures: string[] = [];

        // --- production render, production distance pass ----------------------
        viewer.setPredeformCenterTexture(null, 0, 0);
        viewer.setDistanceProvider(null);
        this.runtime.applyWeights(item.weights);
        this.pass!.markDirty();
        const productionFrame = await this.hashNextFrame();

        const mvp = this.mvpMatrix(handles);
        const gaussianCount = handles.splatMesh.getSplatCount();
        const productionDistances = new Float32Array(gaussianCount);
        await handles.splatMesh.computeDistancesOnGPU(mvp, productionDistances);

        // --- pre-deformation: one pass, then the PoC render and distance paths --
        this.pass!.run();
        const centers = this.pass!.readAnimatedCenters();
        const predeformDistances = new Float32Array(gaussianCount);
        await this.pass!.computeDistances(mvp, predeformDistances);

        viewer.setPredeformCenterTexture(
            this.pass!.getTexture(), this.pass!.getLayout()!.textureWidth, this.pass!.getLayout()!.textureHeight);
        viewer.setDistanceProvider((m: any, out: Float32Array) => this.pass!.computeDistances(m, out));
        const predeformFrame = await this.hashNextFrame();

        // --- numbers ----------------------------------------------------------
        const reference = applyUikaBasisWeightsCpu(asset.canonicalPositions, asset.basis, item.weights);
        const width = this.pass!.getLayout()!.textureWidth;
        let maxAbsXyzError = 0;
        let sumAbs = 0;
        let maxIndex = -1;
        let nonFinite = 0;
        for (let i = 0; i < gaussianCount; i++) {
            const t = (Math.floor(i / width) * width + (i % width)) * 4;
            const p = i * 3;
            for (let c = 0; c < 3; c++) {
                const got = centers[t + c];
                const want = reference.positions[p + c];
                if (!Number.isFinite(got)) { nonFinite++; continue; }
                const d = Math.abs(got - want);
                sumAbs += d;
                if (d > maxAbsXyzError) { maxAbsXyzError = d; maxIndex = i; }
            }
        }

        let maxAbsDistanceDiff = 0;
        let distanceIndex = -1;
        let pMin = Infinity;
        let pMax = -Infinity;
        for (let i = 0; i < gaussianCount; i++) {
            const a = productionDistances[i];
            const b = predeformDistances[i];
            if (a < pMin) pMin = a;
            if (a > pMax) pMax = a;
            const d = Math.abs(a - b);
            if (d > maxAbsDistanceDiff) { maxAbsDistanceDiff = d; distanceIndex = i; }
        }

        const framesIdentical = productionFrame.hash === predeformFrame.hash;
        if (nonFinite > 0) failures.push(`${nonFinite} non-finite centre components`);
        if (!(maxAbsXyzError <= CORRECTNESS_MAX_ABS_XYZ_ERROR)) {
            failures.push(`max |pre-deformed - CPU reference| = ${maxAbsXyzError} > ${CORRECTNESS_MAX_ABS_XYZ_ERROR}`);
        }
        if (!(maxAbsDistanceDiff <= CORRECTNESS_MAX_ABS_DISTANCE_DIFF)) {
            failures.push(`max |production distance - PoC distance| = ${maxAbsDistanceDiff} `
                + `> ${CORRECTNESS_MAX_ABS_DISTANCE_DIFF}`);
        }
        if (!framesIdentical) {
            failures.push(`the rendered frames differ (production ${productionFrame.hash}, `
                + `pre-deformed ${predeformFrame.hash}) with the same camera, the same suspended `
                + 'sort order and the same resolution');
        }
        if (productionFrame.nonZeroPixels === 0) failures.push('the production frame is empty');

        return {
            name: item.name,
            kind: item.kind,
            detail: item.detail,
            nonZeroWeights: Array.from(item.weights).filter((w) => w !== 0).length,
            gaussiansCompared: gaussianCount,
            maxAbsXyzError,
            meanAbsXyzError: sumAbs / (gaussianCount * 3),
            maxAbsXyzErrorIndex: maxIndex,
            nonFiniteCenters: nonFinite,
            maxAbsDistanceDiff,
            maxAbsDistanceDiffIndex: distanceIndex,
            productionDistanceMin: pMin,
            productionDistanceMax: pMax,
            productionFrame,
            predeformFrame,
            framesIdentical,
            pass: failures.length === 0,
            failures,
        };
    }

    /** The same product the viewer's sort builds: projection * view * mesh world. */
    private mvpMatrix(handles: any): any {
        const m = handles.camera.projectionMatrix.clone();
        const inverse = handles.camera.matrixWorld.clone().invert();
        m.multiply(inverse);
        m.multiply(handles.splatMesh.matrixWorld);
        return m;
    }

    // -----------------------------------------------------------------------
    // Performance
    // -----------------------------------------------------------------------

    private async measure(
        mode: UikaPredeformMeasurement['mode'],
        test: UikaPredeformMeasurement['test'],
        bufferScale: number,
        options: UikaPredeformOptions,
    ): Promise<UikaPredeformMeasurement> {
        const viewer = this.viewer();
        const gl = this.gl();
        const ext = gl ? gl.getExtension('EXT_disjoint_timer_query_webgl2') : null;
        const timers = gl && ext ? new GpuTimerPool(gl, ext) : null;
        viewer?.setGpuTimer?.(timers);
        this.pass?.setGpuTimer(timers as any);

        const layout = this.pass!.getLayout()!;
        if (mode === 'predeform') {
            viewer.setPredeformCenterTexture(this.pass!.getTexture(), layout.textureWidth, layout.textureHeight);
            viewer.setDistanceProvider((m: any, out: Float32Array) => this.pass!.computeDistances(m, out));
        } else {
            viewer.setPredeformCenterTexture(null, 0, 0);
            viewer.setDistanceProvider(null);
        }
        viewer.setDrawingBufferScale(bufferScale);

        this.replay.stop();
        this.runtime.setExpressionSource(null);
        if (test === 'fixed-pose') {
            this.replay.holdFrame(PREDEFORM_POSE_FRAME);
            this.pass!.markDirty();
            this.pass!.run();
        } else {
            this.replay.start_();
            this.runtime.setExpressionSource(() => this.replay.tick());
        }

        const label = `${mode}/${test}/pr${viewer.getDrawingBufferInfo().rendererPixelRatio.toFixed(2)}`;
        this.live.step = label;
        this.live.mode = mode;

        this.live.phase = 'warmup';
        const warmupStart = performance.now();
        await this.waitFor(() => performance.now() - warmupStart >= options.warmupMs);
        const warmupMs = performance.now() - warmupStart;

        timers?.reset();
        if (timers) timers.maxValidMs = options.measureMs;
        timers?.setCollecting(true);
        this.replay.resetInstrumentation();
        this.pass!.resetStats();

        const intervals: number[] = [];
        let lastFrames = viewer.stats.renderedFrames;
        let lastAt = performance.now();
        const frames0 = viewer.stats.renderedFrames;
        const glErrors0 = viewer.stats.glErrorCount;
        const sortRuns0 = viewer.getSortRuns?.() ?? 0;
        const pageErrors0 = this.pageErrors;

        let visibilityLostMs = 0;
        let hiddenSince: number | null = document.visibilityState === 'hidden' ? performance.now() : null;
        const onVis = () => {
            if (document.visibilityState === 'hidden') hiddenSince = performance.now();
            else if (hiddenSince !== null) { visibilityLostMs += performance.now() - hiddenSince; hiddenSince = null; }
            this.live.visible = document.visibilityState === 'visible';
        };
        document.addEventListener('visibilitychange', onVis);

        this.live.phase = 'measuring';
        const measureStart = performance.now();
        await this.waitFor(
            () => performance.now() - measureStart >= options.measureMs,
            () => {
                const frames = viewer.stats.renderedFrames;
                if (frames > lastFrames) {
                    const now = performance.now();
                    const advanced = frames - lastFrames;
                    const dt = (now - lastAt) / advanced;
                    for (let i = 0; i < advanced; i++) intervals.push(dt);
                    lastFrames = frames;
                    lastAt = now;
                }
                if (timers) {
                    if (timers.drawMs.length > 0) this.live.drawP50 = summariseIntervals(timers.drawMs).p50;
                    if (timers.predeformMs.length > 0) {
                        this.live.predeformP50 = summariseIntervals(timers.predeformMs).p50;
                    }
                }
            },
        );
        const measuredMs = performance.now() - measureStart;
        document.removeEventListener('visibilitychange', onVis);
        if (hiddenSince !== null) visibilityLostMs += performance.now() - hiddenSince;
        timers?.setCollecting(false);

        const renderedFrames = viewer.stats.renderedFrames - frames0;
        const effectiveFPS = measuredMs > 0 ? renderedFrames / (measuredMs / 1000) : 0;
        this.live.effectiveFPS = effectiveFPS;
        const passStats = this.pass!.getStats();
        const replayStats = this.replay.getStats();
        const weightUploadCount = test === 'real-a2e' ? replayStats.weightUploadCount : null;

        const result: UikaPredeformMeasurement = {
            label,
            mode,
            test,
            pixelRatio: viewer.getDrawingBufferInfo().rendererPixelRatio,
            buffer: viewer.getDrawingBufferInfo(),
            shader: viewer.getDiagnosticShaderInfo(),
            warmupMs,
            measuredMs,
            renderedFrames,
            effectiveFPS,
            frameInterval: summariseIntervals(intervals),
            gpuAvailable: timers !== null,
            gpuPredeformMs: timers ? summariseIntervals(timers.predeformMs) : null,
            gpuDrawMs: timers ? summariseIntervals(timers.drawMs) : null,
            gpuSortMs: timers ? summariseIntervals(timers.sortMs) : null,
            gpuInvalidSamples: timers?.invalidMs.length ?? 0,
            gpuInvalidValuesMs: timers ? timers.invalidMs.slice(0, 16) : [],
            gpuDisjointDiscarded: timers?.disjointDiscarded ?? 0,
            sortRuns: (viewer.getSortRuns?.() ?? 0) - sortRuns0,
            predeformPassCount: passStats.passCount,
            weightChangeCount: passStats.weightChangeCount,
            weightUploadCount,
            predeformPassesWithinChanges: mode === 'predeform' && weightUploadCount !== null
                ? passStats.passCount <= weightUploadCount
                : null,
            glErrors: viewer.stats.glErrorCount - glErrors0,
            pageErrors: this.pageErrors - pageErrors0,
            visibilityLostMs,
            valid: visibilityLostMs === 0,
            invalidReason: visibilityLostMs > 0
                ? `the tab was hidden for ${Math.round(visibilityLostMs)} ms during measurement`
                : null,
        };

        timers?.dispose();
        viewer?.setGpuTimer?.(null);
        this.pass?.setGpuTimer(null);
        return result;
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

    // -----------------------------------------------------------------------
    // Analysis and decision
    // -----------------------------------------------------------------------

    private find(mode: string, test: string, fullDpr: boolean): UikaPredeformMeasurement | null {
        const dpr = window.devicePixelRatio || 1;
        return this.report!.measurements.find((m) => m.mode === mode && m.test === test
            && (fullDpr ? Math.abs(m.pixelRatio - dpr) < 1e-6 : Math.abs(m.pixelRatio - 1) < 1e-6)) ?? null;
    }

    private analyse(dpr: number): UikaPredeformReport['analysis'] {
        const p50 = (m: UikaPredeformMeasurement | null, key: 'gpuDrawMs' | 'gpuSortMs' | 'gpuPredeformMs') => {
            const s = m?.[key];
            return m && m.valid && s && s.count > 0 ? s.p50 : null;
        };
        const prodFixed = this.find('production-51-basis', 'fixed-pose', true);
        const prodA2e = this.find('production-51-basis', 'real-a2e', true);
        const preFixed = this.find('predeform', 'fixed-pose', true);
        const preA2e = this.find('predeform', 'real-a2e', true);
        const prodDpr1 = this.find('production-51-basis', 'real-a2e', false);
        const preDpr1 = this.find('predeform', 'real-a2e', false);

        const prodDraw = p50(prodA2e, 'gpuDrawMs');
        const preDraw = p50(preA2e, 'gpuDrawMs');
        const prodSort = p50(prodA2e, 'gpuSortMs');
        const preSort = p50(preA2e, 'gpuSortMs');

        return {
            dpr,
            production: {
                fixedPoseDrawP50: p50(prodFixed, 'gpuDrawMs'),
                realA2eFps: prodA2e && prodA2e.valid ? prodA2e.effectiveFPS : null,
                realA2eDrawP50: prodDraw,
                realA2eSortP50: prodSort,
            },
            predeform: {
                fixedPoseDrawP50: p50(preFixed, 'gpuDrawMs'),
                realA2eFps: preA2e && preA2e.valid ? preA2e.effectiveFPS : null,
                realA2eDrawP50: preDraw,
                realA2eSortP50: preSort,
                realA2ePredeformP50: p50(preA2e, 'gpuPredeformMs'),
            },
            dpr1: (prodDpr1 || preDpr1) ? {
                productionFps: prodDpr1 && prodDpr1.valid ? prodDpr1.effectiveFPS : null,
                predeformFps: preDpr1 && preDpr1.valid ? preDpr1.effectiveFPS : null,
            } : null,
            drawSavedMs: prodDraw !== null && preDraw !== null ? prodDraw - preDraw : null,
            sortSavedMs: prodSort !== null && preSort !== null ? prodSort - preSort : null,
        };
    }

    /** §16: real A2E at full DPR, 30 fps, wall p95 <= 33.3 ms, no GL or page errors. */
    private meets30fps(m: UikaPredeformMeasurement | null): { ok: boolean; why: string[] } {
        const why: string[] = [];
        if (!m) return { ok: false, why: ['the measurement is missing'] };
        if (!m.valid) return { ok: false, why: [m.invalidReason ?? 'the measurement is invalid'] };
        if (!(m.effectiveFPS >= 30)) why.push(`effectiveFPS ${m.effectiveFPS.toFixed(2)} < 30`);
        if (!(m.frameInterval.p95 <= 33.3)) why.push(`wall p95 ${m.frameInterval.p95.toFixed(2)} ms > 33.3 ms`);
        if (m.glErrors !== 0) why.push(`${m.glErrors} GL errors`);
        if (m.pageErrors !== 0) why.push(`${m.pageErrors} page errors`);
        if (m.predeformPassesWithinChanges === false) {
            why.push(`${m.predeformPassCount} deformation passes for ${m.weightUploadCount} changed `
                + 'expression frames: the pass is running when the weights did not change');
        }
        return { ok: why.length === 0, why };
    }

    private decideFullDpr(): void {
        const r = this.report!;
        const m = this.find('predeform', 'real-a2e', true);
        const check = this.meets30fps(m);
        r.fullDprPerf = check.ok ? 'PASS' : 'FAIL';
        for (const why of check.why) r.reasons.push(`full DPR: ${why}`);
    }

    private decideDpr1(): void {
        const r = this.report!;
        const m = this.find('predeform', 'real-a2e', false);
        const check = this.meets30fps(m);
        r.dpr1Perf = check.ok ? 'PASS' : 'FAIL';
        for (const why of check.why) r.reasons.push(`DPR 1.0: ${why}`);
    }

    private finishDecision(): void {
        const r = this.report!;
        const decision: string[] = [];
        if (r.correctnessVerdict === 'PASS') decision.push('PREDEFORM_CORRECTNESS_PASS');
        else decision.push('PREDEFORM_CORRECTNESS_FAIL');

        if (!r.realGpu) {
            decision.push('PERF_BLOCKED_SOFTWARE_RENDERER');
            r.reasons.push('performance was measured on a software renderer, so no PASS or FAIL '
                + 'may be derived from it (v1.1 Gate 4A §7)');
        } else {
            if (r.fullDprPerf === 'PASS') decision.push('PREDEFORM_PASS', 'FULL_DPR_PERF_PASS');
            else if (r.fullDprPerf === 'FAIL') decision.push('FULL_DPR_PERF_FAIL');
            if (r.dpr1Perf === 'PASS') decision.push('DPR1_PERF_PASS');
            else if (r.dpr1Perf === 'FAIL') decision.push('DPR1_PERF_FAIL');
            if (r.correctnessVerdict === 'PASS' && (r.fullDprPerf === 'PASS' || r.dpr1Perf === 'PASS')) {
                if (!decision.includes('PREDEFORM_PASS')) decision.push('PREDEFORM_PASS');
            }
        }
        r.decision = decision;

        const a = r.analysis;
        if (a?.drawSavedMs !== null && a?.drawSavedMs !== undefined) {
            r.reasons.push(`real A2E GPU draw p50: ${a.production?.realA2eDrawP50?.toFixed(2)} ms with the `
                + `51-channel loop, ${a.predeform?.realA2eDrawP50?.toFixed(2)} ms from the pre-deformed `
                + `texture (${a.drawSavedMs >= 0 ? '-' : '+'}${Math.abs(a.drawSavedMs).toFixed(2)} ms)`);
        }
        if (a?.sortSavedMs !== null && a?.sortSavedMs !== undefined) {
            r.reasons.push(`real A2E GPU sort p50: ${a.production?.realA2eSortP50?.toFixed(2)} ms -> `
                + `${a.predeform?.realA2eSortP50?.toFixed(2)} ms`);
        }
        if (a?.predeform?.realA2ePredeformP50 !== null && a?.predeform?.realA2ePredeformP50 !== undefined) {
            r.reasons.push(`the deformation pass itself is ${a.predeform.realA2ePredeformP50.toFixed(2)} ms p50, `
                + 'once per changed expression frame');
        }
    }
}
