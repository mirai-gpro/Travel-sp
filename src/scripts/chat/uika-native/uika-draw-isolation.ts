// UIKA Native Runtime v1.1 — Gate 4B-1 GPU Draw Bottleneck Isolation
//
// Gate 4A is FAIL: ~74 ms of GPU draw per frame, with CPU, mapper, weight upload,
// JS submission and the sort each ruled out. This module does not optimise anything.
// It splits that 74 ms into
//
//   A  raster / pixel fill         — Diagnostic 1, a drawing-buffer resolution sweep
//   B  base Gaussian rendering     — what survives with the basis loop gone
//   C  133541 x 51 basis evaluation — Diagnostic 2, loop present vs absent in source
//
// and, when C turns out to dominate, measures how the draw time scales with the number
// of basis fetches (Diagnostic 3).
//
// Nothing here touches the production path. /uika-native-replay, the production shader
// source emitted by SplatMaterial.js, SplatMesh behaviour, LAMAvatar, LiveAudioManager,
// the backend, A2E and the normal LAM path are all unchanged; the shader variants exist
// only while this harness is running and the production source is restored at the end.

import type { UikaNativeRuntime } from './uika-native-runtime';
import type { UikaNativeReplay } from './uika-native-replay';
import type {
    UikaDiagnosticShaderInfo,
    UikaDrawingBufferInfo,
    UikaDrawingBufferHash,
} from './renderer';
import {
    GpuTimerPool,
    collectGpuInfo,
    summariseIntervals,
    type UikaGpuInfo,
    type UikaIntervalStats,
} from './uika-native-benchmark';

/** The pose every measurement holds: fixture frame 20, the widest jaw/stretch of the take. */
export const ISOLATION_POSE_FRAME = 20;

export interface UikaIsolationMeasurement {
    label: string;
    diagnostic: 1 | 2 | 3;
    /** What this measurement varies. Everything else is held constant. */
    variable: 'drawing-buffer-scale' | 'shader-variant' | 'basis-count';
    poseFrame: number;
    shader: UikaDiagnosticShaderInfo;
    buffer: UikaDrawingBufferInfo;
    warmupMs: number;
    warmupFrames: number;
    measuredMs: number;
    renderedFrames: number;
    effectiveFPS: number;
    frameInterval: UikaIntervalStats;
    gpuAvailable: boolean;
    gpuDrawMs: UikaIntervalStats | null;
    gpuSortMs: UikaIntervalStats | null;
    gpuDisjointDiscarded: number;
    /** Gate 4B-1 §8: excluded, counted and listed — never averaged in, never hidden. */
    gpuInvalidSamples: number;
    gpuInvalidValuesMs: number[];
    gpuInvalidRuleMs: number;
    sortRuns: number;
    glErrors: number;
    pageErrors: number;
    visibilityLostMs: number;
    valid: boolean;
    invalidReason: string | null;
}

/**
 * Evidence that the no-basis variant is a real shader change and not a weight-zero
 * imitation. Gate 4B-1 §4 rules weight = 0 out explicitly, because the Gate 4A Test A
 * shader still ran 51 iterations and 51 texture fetches with every weight at zero.
 */
export interface UikaVariantProof {
    productionNeutral: { shader: UikaDiagnosticShaderInfo; frame: UikaDrawingBufferHash };
    productionPosed: { shader: UikaDiagnosticShaderInfo; frame: UikaDrawingBufferHash };
    noBasisPosed: { shader: UikaDiagnosticShaderInfo; frame: UikaDrawingBufferHash };
    /** The production shader must move the avatar when the pose weights are resident. */
    productionDeforms: boolean;
    /** With the loop gone the same resident weights must produce the canonical pose. */
    noBasisIsCanonical: boolean;
    /** The loop statement is in the production source and absent from the variant. */
    loopPresentInProduction: boolean;
    loopAbsentInVariant: boolean;
    basisDeltaCallsProduction: number;
    basisDeltaCallsVariant: number;
    ok: boolean;
    notes: string[];
}

export interface UikaDrawIsolationAnalysis {
    drawP50At100: number | null;
    drawP50At50: number | null;
    drawP50At25: number | null;
    drawP50Production: number | null;
    drawP50NoBasis: number | null;
    /** (draw@100% - draw@25%) / draw@100%: how much of the draw time the raster owns. */
    rasterShare: number | null;
    /** (production - no basis) / production: how much the 51-channel loop owns. */
    basisShare: number | null;
    /** What survives with no basis loop at all, as a share of the production draw. */
    baseRenderShare: number | null;
    noBasisEffectiveFPS: number | null;
    noBasisReaches30fps: boolean | null;
    /** The per-frame draw budget 30 fps leaves. A decision reference, not a measurement. */
    drawBudgetFor30fpsMs: 33.3;
    /**
     * Diagnostic 1 at 100% and Diagnostic 2's production point are the same
     * configuration measured twice, so this difference is the measurement noise floor.
     * A large value means the shares below are not worth more than their noise.
     */
    repeatabilityDeltaMs: number | null;
    /**
     * A literal bound of 51 (Diagnostic 3) against the uniform-bounded production loop
     * (Diagnostic 2) is the same work. A large difference would mean the loop bound is
     * being compiled into something materially different, which the shares assume it is not.
     */
    literal51MinusUniform51Ms: number | null;
    basisScaling: Array<{ basisCount: number; drawP50: number; drawP95: number; fps: number }> | null;
    /** Least-squares fit of drawP50 against basis count, from Diagnostic 3 only. */
    basisScalingFit: { interceptMs: number; msPerBasis: number; points: number } | null;
}

export type UikaDrawIsolationConclusion =
    | 'RASTER_DOMINANT'
    | 'BASE_RENDER_DOMINANT'
    | 'BASIS_LOOP_DOMINANT'
    | 'MIXED'
    | 'BLOCKED'
    | 'INCOMPLETE';

export interface UikaDrawIsolationReport {
    spec: 'UIKA Native Runtime v1.1 Gate 4B-1';
    startedAt: string;
    finishedAt: string | null;
    gpu: UikaGpuInfo;
    realGpu: boolean;
    runtime: {
        gaussianCount: number;
        basisCount: number;
        basisResident: boolean;
        oacFreeCheck: Record<string, boolean>;
    };
    poseFrame: number;
    poseWeights: number[] | null;
    variantProof: UikaVariantProof | null;
    diagnostic1: UikaIsolationMeasurement[];
    diagnostic2: UikaIsolationMeasurement[];
    diagnostic3: UikaIsolationMeasurement[] | null;
    diagnostic3Skipped: string | null;
    analysis: UikaDrawIsolationAnalysis | null;
    conclusion: UikaDrawIsolationConclusion;
    basisLoopDominant: 'YES' | 'NO' | 'UNDETERMINED';
    reasons: string[];
    /** The shader the renderer is left with. Must be the production source. */
    restoredShader: UikaDiagnosticShaderInfo | null;
}

export interface UikaDrawIsolationOptions {
    warmupMs: number;
    measureMs: number;
    scales: number[];
    basisCounts: number[];
    /** null = run Diagnostic 3 only when Diagnostic 2 shows the basis loop dominant. */
    forceDiagnostic3: boolean | null;
    allowSoftware: boolean;
}

export const DEFAULT_ISOLATION_OPTIONS: UikaDrawIsolationOptions = {
    warmupMs: 6000,
    // Gate 4B-1 §3 asks for 20-30 s or more per point. At ~13 fps, 30 s is ~390 frames,
    // which is enough for a p95 and p99 that are not single-sample artefacts.
    measureMs: 30000,
    scales: [1, 0.5, 0.25],
    basisCounts: [0, 8, 16, 32, 51],
    forceDiagnostic3: null,
    allowSoftware: false,
};

/** `?warmupMs=`, `?measureMs=`, `?scales=1,0.5,0.25`, `?basisCounts=0,8,16,32,51`, `?d3=1|0`, `?allowSoftware=1`. */
export function isolationOptionsFromUrl(): UikaDrawIsolationOptions {
    const o: UikaDrawIsolationOptions = { ...DEFAULT_ISOLATION_OPTIONS };
    try {
        const q = new URLSearchParams(window.location.search);
        const warm = Number(q.get('warmupMs'));
        const meas = Number(q.get('measureMs'));
        if (Number.isFinite(warm) && warm > 0) o.warmupMs = warm;
        if (Number.isFinite(meas) && meas > 0) o.measureMs = meas;
        const scales = (q.get('scales') || '').split(',').map(Number).filter((v) => v > 0);
        if (scales.length > 0) o.scales = scales;
        const counts = (q.get('basisCounts') || '').split(',').map(Number)
            .filter((v) => Number.isInteger(v) && v >= 0);
        if (counts.length > 0) o.basisCounts = counts;
        if (q.get('d3') === '1') o.forceDiagnostic3 = true;
        if (q.get('d3') === '0') o.forceDiagnostic3 = false;
        if (q.get('allowSoftware') === '1') o.allowSoftware = true;
    } catch { /* noop */ }
    return o;
}

export class UikaDrawIsolation {
    private report: UikaDrawIsolationReport | null = null;
    private running = false;
    private abort = false;
    private pageErrors = 0;
    private live = {
        step: '', phase: 'idle', elapsedMs: 0, renderedFrames: 0,
        effectiveFPS: 0, drawP50: 0, visible: true,
    };

    constructor(
        private readonly runtime: UikaNativeRuntime,
        private readonly replay: UikaNativeReplay,
    ) {
        window.addEventListener('error', () => { this.pageErrors++; });
        window.addEventListener('unhandledrejection', () => { this.pageErrors++; });
    }

    getLive() { return { ...this.live }; }
    getReport(): UikaDrawIsolationReport | null { return this.report; }
    isRunning(): boolean { return this.running; }
    stop(): void { this.abort = true; }

    private viewer(): any { return this.runtime.getViewer(); }
    private canvas(): HTMLCanvasElement | null { return this.viewer()?.renderer?.domElement ?? null; }
    private gl(): WebGL2RenderingContext | null { return this.viewer()?.renderer?.getContext?.() ?? null; }

    async run(options: UikaDrawIsolationOptions = DEFAULT_ISOLATION_OPTIONS): Promise<UikaDrawIsolationReport> {
        if (this.running) throw new Error('UIKA Gate 4B-1: already running');
        this.running = true;
        this.abort = false;

        const gpu = collectGpuInfo(this.canvas());
        const realGpu = !gpu.isSoftware && gpu.unmaskedAvailable;
        const rt: any = this.runtime.report;

        this.report = {
            spec: 'UIKA Native Runtime v1.1 Gate 4B-1',
            startedAt: new Date().toISOString(),
            finishedAt: null,
            gpu,
            realGpu,
            runtime: {
                gaussianCount: rt.gaussianCount,
                basisCount: rt.basisCount,
                basisResident: rt.basisResident,
                oacFreeCheck: rt.oacFreeCheck,
            },
            poseFrame: ISOLATION_POSE_FRAME,
            poseWeights: null,
            variantProof: null,
            diagnostic1: [],
            diagnostic2: [],
            diagnostic3: null,
            diagnostic3Skipped: null,
            analysis: null,
            conclusion: 'INCOMPLETE',
            basisLoopDominant: 'UNDETERMINED',
            reasons: [],
            restoredShader: null,
        };

        const blockers: string[] = [];
        if (gpu.isSoftware) {
            blockers.push(`software renderer detected (${gpu.softwareMatches.join(', ')}): ${gpu.renderer}`);
        }
        if (!gpu.unmaskedAvailable) {
            blockers.push('WEBGL_debug_renderer_info is unavailable, so hardware acceleration cannot be confirmed');
        }
        if (blockers.length > 0 && !options.allowSoftware) {
            this.report.conclusion = 'BLOCKED';
            this.report.reasons.push(...blockers);
            this.report.finishedAt = new Date().toISOString();
            this.running = false;
            return this.report;
        }
        const forcedBlocked = blockers.length > 0 ? blockers : null;

        const viewer = this.viewer();
        try {
            // One fixed pose for every measurement, set once and left resident.
            this.replay.stop();
            this.runtime.setExpressionSource(null);
            const held = this.replay.holdFrame(ISOLATION_POSE_FRAME);
            this.report.poseWeights = held.weights;

            this.report.variantProof = await this.proveVariants();
            if (!this.report.variantProof.ok) {
                this.report.conclusion = 'INCOMPLETE';
                this.report.reasons.push(
                    'the no-basis shader variant could not be proved real; no measurement was taken',
                    ...this.report.variantProof.notes,
                );
                this.report.finishedAt = new Date().toISOString();
                return this.report;
            }

            // --- Diagnostic 1: resolution sweep, production shader -------------
            viewer.setDiagnosticBasisBound(null);
            for (const scale of options.scales) {
                if (this.abort) break;
                viewer.setDrawingBufferScale(scale);
                this.report.diagnostic1.push(await this.measure(
                    `d1-scale-${Math.round(scale * 100)}pct`, 1, 'drawing-buffer-scale', options,
                ));
            }

            // --- Diagnostic 2: 51-basis vs canonical no-basis, full resolution --
            if (!this.abort) {
                viewer.setDrawingBufferScale(1);
                viewer.setDiagnosticBasisBound(null);
                this.report.diagnostic2.push(await this.measure(
                    'd2-production-51-basis', 2, 'shader-variant', options,
                ));
            }
            if (!this.abort) {
                viewer.setDiagnosticBasisBound(0);
                this.report.diagnostic2.push(await this.measure(
                    'd2-canonical-no-basis', 2, 'shader-variant', options,
                ));
            }

            // --- Diagnostic 3: basis-count scaling, only if the loop dominates --
            const interim = this.analyse(options);
            const dominant = interim.basisShare !== null && interim.basisShare >= 0.5;
            const runD3 = options.forceDiagnostic3 ?? dominant;
            if (!runD3) {
                this.report.diagnostic3Skipped = options.forceDiagnostic3 === false
                    ? 'skipped by request (?d3=0)'
                    : 'Diagnostic 2 did not show the basis loop dominant, so §7 does not apply';
            } else if (!this.abort) {
                this.report.diagnostic3 = [];
                viewer.setDrawingBufferScale(1);
                for (const count of options.basisCounts) {
                    if (this.abort) break;
                    viewer.setDiagnosticBasisBound(count);
                    this.report.diagnostic3.push(await this.measure(
                        `d3-basis-${count}`, 3, 'basis-count', options,
                    ));
                }
            }
        } finally {
            // Leave the renderer exactly as the production path expects it.
            try {
                viewer?.setSortSuspended?.(false);
                viewer?.setDiagnosticBasisBound?.(null);
                viewer?.setDrawingBufferScale?.(1);
                this.report.restoredShader = viewer?.getDiagnosticShaderInfo?.() ?? null;
            } catch { /* reported through restoredShader being null */ }
            this.replay.stop();
            this.runtime.setExpressionSource(null);
            this.runtime.setNeutral();
            viewer?.setGpuTimer?.(null);
            this.live.phase = 'idle';
            this.live.step = '';
            this.running = false;
        }

        this.report.analysis = this.analyse(options);
        this.decide(forcedBlocked);
        this.report.finishedAt = new Date().toISOString();
        return this.report;
    }

    /**
     * Gate 4B-1 §4. Render three frames and hash them:
     *
     *   production shader + neutral weights   -> the canonical pose
     *   production shader + frame 20 weights  -> must differ (the loop is doing work)
     *   no-basis shader   + frame 20 weights  -> must equal the canonical pose
     *
     * The third frame is taken with the pose weights still resident on the GPU, so a
     * match can only mean the loop is gone from the source, not that the weights are zero.
     * All three frames share one draw order (sorting is suspended for the proof), so the
     * only thing that differs between them is the vertex shader.
     */
    private async proveVariants(): Promise<UikaVariantProof> {
        const viewer = this.viewer();
        const notes: string[] = [];
        this.live.step = 'variant proof';
        this.live.phase = 'verifying';

        viewer.setDrawingBufferScale(1);

        // One draw order for all three frames, so the shader is the only variable.
        viewer.setSortSuspended(true);
        viewer.setDiagnosticBasisBound(null);
        this.runtime.setNeutral();
        const neutralShader = viewer.getDiagnosticShaderInfo();
        const neutralFrame = await this.hashNextFrame();

        const held = this.replay.holdFrame(ISOLATION_POSE_FRAME);
        const posedShader = viewer.getDiagnosticShaderInfo();
        const posedFrame = await this.hashNextFrame();

        viewer.setDiagnosticBasisBound(0);
        const variantShader = viewer.getDiagnosticShaderInfo();
        // The weights from holdFrame are still resident; nothing re-uploads them here.
        const variantFrame = await this.hashNextFrame();

        const productionDeforms = posedFrame.hash !== neutralFrame.hash;
        const noBasisIsCanonical = variantFrame.hash === neutralFrame.hash;
        const loopPresentInProduction = posedShader.basisLoopPresent && posedShader.basisDeltaCalls === 1;
        const loopAbsentInVariant = !variantShader.basisLoopPresent && variantShader.basisDeltaCalls === 0;

        if (!productionDeforms) {
            notes.push('the production shader rendered frame 20 identically to neutral, so the '
                + 'pose weights are not reaching the render shader');
        }
        if (!noBasisIsCanonical) {
            notes.push('the no-basis variant did not render the canonical pose while the frame 20 '
                + 'weights were resident');
        }
        if (!loopPresentInProduction) notes.push('the production source does not carry exactly one basis loop');
        if (!loopAbsentInVariant) notes.push('the variant source still carries a basis loop or fetch');
        if (held.weights.every((w) => w === 0)) {
            notes.push(`fixture frame ${ISOLATION_POSE_FRAME} mapped to all-zero weights, which would make `
                + 'the comparison meaningless');
        }

        // Back to the production shader and to normal sorting; the measurements set
        // their own variant and sort exactly as the production path does.
        viewer.setDiagnosticBasisBound(null);
        viewer.setSortSuspended(false);

        return {
            productionNeutral: { shader: neutralShader, frame: neutralFrame },
            productionPosed: { shader: posedShader, frame: posedFrame },
            noBasisPosed: { shader: variantShader, frame: variantFrame },
            productionDeforms,
            noBasisIsCanonical,
            loopPresentInProduction,
            loopAbsentInVariant,
            basisDeltaCallsProduction: posedShader.basisDeltaCalls,
            basisDeltaCallsVariant: variantShader.basisDeltaCalls,
            ok: productionDeforms && noBasisIsCanonical && loopPresentInProduction
                && loopAbsentInVariant && notes.length === 0,
            notes,
        };
    }

    /**
     * Hash the next rendered frame. The runtime's own rAF loop is what renders it, so a
     * missing frame means the loop stopped — which is a failure to report, not to wait on.
     */
    private async hashNextFrame(): Promise<UikaDrawingBufferHash> {
        const viewer = this.viewer();
        let timer = 0;
        try {
            return await Promise.race([
                viewer.requestDrawingBufferHash() as Promise<UikaDrawingBufferHash>,
                new Promise<UikaDrawingBufferHash>((_, reject) => {
                    timer = window.setTimeout(
                        () => reject(new Error('UIKA Gate 4B-1: no frame was rendered within 5000 ms')),
                        5000,
                    );
                }),
            ]);
        } finally {
            window.clearTimeout(timer);
            viewer.clearPendingDrawingBufferHash?.();
        }
    }

    /** Warm up, then measure. The pose and the shader variant are already set by the caller. */
    private async measure(
        label: string,
        diagnostic: 1 | 2 | 3,
        variable: UikaIsolationMeasurement['variable'],
        options: UikaDrawIsolationOptions,
    ): Promise<UikaIsolationMeasurement> {
        const viewer = this.viewer();
        const gl = this.gl();
        const ext = gl ? gl.getExtension('EXT_disjoint_timer_query_webgl2') : null;
        const timers = gl && ext ? new GpuTimerPool(gl, ext) : null;
        viewer?.setGpuTimer?.(timers);

        this.live.step = label;

        this.live.phase = 'warmup';
        const warmupStart = performance.now();
        const warmupFrames0 = viewer.stats.renderedFrames;
        await this.waitFor(() => performance.now() - warmupStart >= options.warmupMs);
        const warmupMs = performance.now() - warmupStart;
        const warmupFrames = viewer.stats.renderedFrames - warmupFrames0;

        timers?.reset();
        if (timers) timers.maxValidMs = options.measureMs;
        timers?.setCollecting(true);

        const intervals: number[] = [];
        let lastFrames = viewer.stats.renderedFrames;
        let lastAt = performance.now();
        const glErrors0 = viewer.stats.glErrorCount;
        const sortRuns0 = viewer.getSortRuns?.() ?? 0;
        const frames0 = viewer.stats.renderedFrames;
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
                if (timers && timers.drawMs.length > 0) {
                    this.live.drawP50 = summariseIntervals(timers.drawMs).p50;
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

        const result: UikaIsolationMeasurement = {
            label,
            diagnostic,
            variable,
            poseFrame: ISOLATION_POSE_FRAME,
            shader: viewer.getDiagnosticShaderInfo(),
            buffer: viewer.getDrawingBufferInfo(),
            warmupMs,
            warmupFrames,
            measuredMs,
            renderedFrames,
            effectiveFPS,
            frameInterval: summariseIntervals(intervals),
            gpuAvailable: timers !== null,
            gpuDrawMs: timers ? summariseIntervals(timers.drawMs) : null,
            gpuSortMs: timers ? summariseIntervals(timers.sortMs) : null,
            gpuDisjointDiscarded: timers?.disjointDiscarded ?? 0,
            gpuInvalidSamples: timers?.invalidMs.length ?? 0,
            gpuInvalidValuesMs: timers ? timers.invalidMs.slice(0, 16) : [],
            gpuInvalidRuleMs: timers?.maxValidMs ?? 0,
            sortRuns: (viewer.getSortRuns?.() ?? 0) - sortRuns0,
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
        return result;
    }

    private waitFor(done: () => boolean, each?: () => void): Promise<void> {
        return new Promise((resolve) => {
            const started = performance.now();
            const step = () => {
                if (this.abort || done()) { resolve(); return; }
                each?.();
                this.live.elapsedMs = performance.now() - started;
                this.live.renderedFrames = this.viewer()?.stats?.renderedFrames ?? 0;
                requestAnimationFrame(step);
            };
            requestAnimationFrame(step);
        });
    }

    private drawP50(list: UikaIsolationMeasurement[], label: string): number | null {
        const m = list.find((x) => x.label === label);
        if (!m || !m.valid || !m.gpuDrawMs || m.gpuDrawMs.count === 0) return null;
        return m.gpuDrawMs.p50;
    }

    private analyse(options: UikaDrawIsolationOptions): UikaDrawIsolationAnalysis {
        const r = this.report!;
        const d1 = r.diagnostic1;
        const at = (pct: number) => this.drawP50(d1, `d1-scale-${pct}pct`);
        const drawP50At100 = at(100);
        const drawP50At50 = at(50);
        const drawP50At25 = at(25);
        const drawP50Production = this.drawP50(r.diagnostic2, 'd2-production-51-basis');
        const drawP50NoBasis = this.drawP50(r.diagnostic2, 'd2-canonical-no-basis');

        const rasterShare = drawP50At100 !== null && drawP50At25 !== null && drawP50At100 > 0
            ? (drawP50At100 - drawP50At25) / drawP50At100
            : null;
        const basisShare = drawP50Production !== null && drawP50NoBasis !== null && drawP50Production > 0
            ? (drawP50Production - drawP50NoBasis) / drawP50Production
            : null;
        const baseRenderShare = basisShare !== null ? 1 - basisShare : null;

        const noBasis = r.diagnostic2.find((x) => x.label === 'd2-canonical-no-basis');
        const noBasisEffectiveFPS = noBasis && noBasis.valid ? noBasis.effectiveFPS : null;

        let basisScaling: UikaDrawIsolationAnalysis['basisScaling'] = null;
        let basisScalingFit: UikaDrawIsolationAnalysis['basisScalingFit'] = null;
        if (r.diagnostic3 && r.diagnostic3.length > 0) {
            basisScaling = [];
            for (const m of r.diagnostic3) {
                if (!m.valid || !m.gpuDrawMs || m.gpuDrawMs.count === 0) continue;
                const count = Number(m.label.replace('d3-basis-', ''));
                if (!Number.isFinite(count)) continue;
                basisScaling.push({
                    basisCount: count,
                    drawP50: m.gpuDrawMs.p50,
                    drawP95: m.gpuDrawMs.p95,
                    fps: m.effectiveFPS,
                });
            }
            if (basisScaling.length >= 2) {
                const n = basisScaling.length;
                let sx = 0, sy = 0, sxx = 0, sxy = 0;
                for (const p of basisScaling) {
                    sx += p.basisCount; sy += p.drawP50;
                    sxx += p.basisCount * p.basisCount; sxy += p.basisCount * p.drawP50;
                }
                const denom = n * sxx - sx * sx;
                if (denom !== 0) {
                    const slope = (n * sxy - sx * sy) / denom;
                    basisScalingFit = {
                        interceptMs: (sy - slope * sx) / n,
                        msPerBasis: slope,
                        points: n,
                    };
                }
            }
        }

        const literal51 = r.diagnostic3 ? this.drawP50(r.diagnostic3, 'd3-basis-51') : null;

        return {
            drawP50At100, drawP50At50, drawP50At25,
            drawP50Production, drawP50NoBasis,
            rasterShare, basisShare, baseRenderShare,
            repeatabilityDeltaMs: drawP50At100 !== null && drawP50Production !== null
                ? Math.abs(drawP50At100 - drawP50Production) : null,
            literal51MinusUniform51Ms: literal51 !== null && drawP50Production !== null
                ? literal51 - drawP50Production : null,
            noBasisEffectiveFPS,
            noBasisReaches30fps: noBasisEffectiveFPS === null ? null : noBasisEffectiveFPS >= 30,
            drawBudgetFor30fpsMs: 33.3,
            basisScaling,
            basisScalingFit,
        };
    }

    /**
     * Gate 4B-1 §6 / §10. The share thresholds below are decision rules chosen for this
     * gate, not measured quantities: a component is "dominant" when removing it takes at
     * least half of the draw time away, and "not a factor" when it takes less than 30%.
     */
    private decide(forcedBlocked: string[] | null): void {
        const r = this.report!;
        const a = r.analysis!;
        const reasons: string[] = [];

        if (forcedBlocked) {
            r.conclusion = 'BLOCKED';
            r.basisLoopDominant = 'UNDETERMINED';
            r.reasons = [
                ...forcedBlocked,
                'the diagnostics ran only to exercise the harness; these numbers are NOT a Gate 4B-1 result',
            ];
            return;
        }

        const invalid = [...r.diagnostic1, ...r.diagnostic2, ...(r.diagnostic3 ?? [])]
            .filter((m) => !m.valid);
        for (const m of invalid) reasons.push(`${m.label}: ${m.invalidReason}`);

        if (a.rasterShare === null || a.basisShare === null) {
            r.conclusion = 'INCOMPLETE';
            r.basisLoopDominant = 'UNDETERMINED';
            reasons.push('a measurement needed for the split is missing or invalid');
            r.reasons = reasons;
            return;
        }

        r.basisLoopDominant = a.basisShare >= 0.5 ? 'YES' : 'NO';

        if (a.basisShare >= 0.5 && a.rasterShare < 0.3) r.conclusion = 'BASIS_LOOP_DOMINANT';
        else if (a.rasterShare >= 0.5 && a.basisShare < 0.3) r.conclusion = 'RASTER_DOMINANT';
        else if (a.basisShare < 0.3 && a.rasterShare < 0.3) r.conclusion = 'BASE_RENDER_DOMINANT';
        else r.conclusion = 'MIXED';

        reasons.push(
            `raster share ${(a.rasterShare * 100).toFixed(1)}% `
            + `(draw p50 ${a.drawP50At100?.toFixed(2)} ms at 100% vs ${a.drawP50At25?.toFixed(2)} ms at 25%)`,
            `basis share ${(a.basisShare * 100).toFixed(1)}% `
            + `(draw p50 ${a.drawP50Production?.toFixed(2)} ms with the 51-channel loop vs `
            + `${a.drawP50NoBasis?.toFixed(2)} ms with no loop in the source)`,
        );
        if (a.noBasisEffectiveFPS !== null) {
            reasons.push(`with no basis loop at all the renderer runs at ${a.noBasisEffectiveFPS.toFixed(2)} fps, `
                + `${a.noBasisReaches30fps ? 'which reaches' : 'which still does not reach'} 30 fps`);
        }
        if (a.repeatabilityDeltaMs !== null) {
            reasons.push(`the same configuration measured twice (Diagnostic 1 at 100% and the `
                + `Diagnostic 2 production point) differed by ${a.repeatabilityDeltaMs.toFixed(2)} ms`);
        }
        if (r.diagnostic3Skipped) reasons.push(`Diagnostic 3: ${r.diagnostic3Skipped}`);
        if (a.basisScalingFit) {
            reasons.push(`basis-count scaling: ${a.basisScalingFit.interceptMs.toFixed(2)} ms + `
                + `${a.basisScalingFit.msPerBasis.toFixed(3)} ms per basis channel `
                + `(least squares over ${a.basisScalingFit.points} points)`);
        }
        r.reasons = reasons;
    }
}
