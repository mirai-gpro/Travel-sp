// UIKA Native Runtime Architecture Correction v1.1 — Gate 4A
//
// Real-GPU baseline benchmark. MEASURE FIRST, OPTIMIZE LATER: this file adds
// instrumentation and a test driver only. It changes no shader, no basis layout, no
// sort policy, no resolution policy and drops no Gaussian or expression channel.
//
// It never touches Gemini Live, Socket.IO, the A2E backend, LiveAudioManager or the
// normal LAM path.

import type { UikaNativeRuntime } from './uika-native-runtime';
import type { UikaNativeReplay } from './uika-native-replay';

export interface UikaGpuInfo {
    vendor: string | null;
    renderer: string | null;
    unmaskedAvailable: boolean;
    isSoftware: boolean;
    softwareMatches: string[];
    maxTextureSize: number;
    maxVertexTextureImageUnits: number;
    maxCombinedTextureImageUnits: number;
    maxTextureImageUnits: number;
    timerQueryExtension: boolean;
    userAgent: string;
    platform: string;
    visibilityState: string;
    devicePixelRatio: number;
    canvasCssWidth: number;
    canvasCssHeight: number;
    drawingBufferWidth: number;
    drawingBufferHeight: number;
}

export interface UikaIntervalStats {
    count: number;
    mean: number;
    p50: number;
    p90: number;
    p95: number;
    p99: number;
    max: number;
    over16_7: number;
    over33_3: number;
    over50: number;
    over100: number;
}

export interface UikaTestResult {
    name: 'A-neutral' | 'B-fixed-pose' | 'C-real-a2e-replay';
    description: string;
    warmupMs: number;
    warmupFrames: number;
    measuredMs: number;
    renderedFrames: number;
    effectiveFPS: number;
    frameInterval: UikaIntervalStats;
    cpu: {
        /** Replay-side stages. Only Test C drives these. */
        selectMs: { count: number; p50: number; p95: number; max: number } | null;
        mapMs: { count: number; p50: number; p95: number; max: number } | null;
        uploadMs: { count: number; p50: number; p95: number; max: number } | null;
        /** Viewer-side stages, sampled per rendered frame. */
        sortSubmitMs: UikaIntervalStats;
        renderSubmitMs: UikaIntervalStats;
    };
    gpu: {
        available: boolean;
        note: string;
        sortPassMs: UikaIntervalStats | null;
        drawPassMs: UikaIntervalStats | null;
        totalMs: UikaIntervalStats | null;
        disjointDiscarded: number;
        /** Gate 4B-1 §8: samples longer than the measurement window, excluded and listed. */
        invalidSamples: number;
        invalidValuesMs: number[];
        invalidRuleMs: number;
    };
    expression: Record<string, number | boolean> | null;
    sortRuns: number;
    glErrors: number;
    pageErrors: number;
    visibilityLostMs: number;
    valid: boolean;
    invalidReason: string | null;
}

export interface UikaBenchmarkReport {
    spec: 'UIKA Native Runtime v1.1 Gate 4A';
    startedAt: string;
    finishedAt: string | null;
    gpu: UikaGpuInfo;
    realGpu: boolean;
    fixture: unknown;
    runtime: {
        gaussianCount: number;
        basisCount: number;
        basisResident: boolean;
        basisLayout: unknown;
        oacFreeCheck: Record<string, boolean>;
    };
    lifecycle: {
        rendererRecreations: number;
        plyRewrites: number;
        blobRecreations: number;
        basisTextureRebuilds: number;
        note: string;
    };
    tests: UikaTestResult[];
    verdict: 'PASS' | 'BORDERLINE' | 'FAIL' | 'BLOCKED' | 'INCOMPLETE';
    verdictReasons: string[];
}

const SOFTWARE_MARKERS = [
    'swiftshader',
    'llvmpipe',
    'software',
    'microsoft basic render driver',
    'softpipe',
    'mesa offscreen',
];

function emptyIntervalStats(): UikaIntervalStats {
    return { count: 0, mean: 0, p50: 0, p90: 0, p95: 0, p99: 0, max: 0,
             over16_7: 0, over33_3: 0, over50: 0, over100: 0 };
}

export function summariseIntervals(samples: number[]): UikaIntervalStats {
    if (samples.length === 0) return emptyIntervalStats();
    const sorted = [...samples].sort((a, b) => a - b);
    const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
    let sum = 0;
    let over16 = 0, over33 = 0, over50 = 0, over100 = 0;
    for (const v of samples) {
        sum += v;
        if (v > 16.7) over16++;
        if (v > 33.3) over33++;
        if (v > 50) over50++;
        if (v > 100) over100++;
    }
    return {
        count: samples.length,
        mean: sum / samples.length,
        p50: at(0.5), p90: at(0.9), p95: at(0.95), p99: at(0.99),
        max: sorted[sorted.length - 1],
        over16_7: over16, over33_3: over33, over50: over50, over100: over100,
    };
}

export function collectGpuInfo(canvas: HTMLCanvasElement | null): UikaGpuInfo {
    const probe = document.createElement('canvas');
    const gl = (canvas?.getContext('webgl2') as WebGL2RenderingContext | null)
        || (probe.getContext('webgl2') as WebGL2RenderingContext | null);

    let vendor: string | null = null;
    let renderer: string | null = null;
    let unmaskedAvailable = false;
    let maxTextureSize = 0, maxVtu = 0, maxCombined = 0, maxTiu = 0;
    let timerQuery = false;

    if (gl) {
        const dbg = gl.getExtension('WEBGL_debug_renderer_info');
        if (dbg) {
            unmaskedAvailable = true;
            vendor = gl.getParameter((dbg as any).UNMASKED_VENDOR_WEBGL);
            renderer = gl.getParameter((dbg as any).UNMASKED_RENDERER_WEBGL);
        } else {
            vendor = gl.getParameter(gl.VENDOR);
            renderer = gl.getParameter(gl.RENDERER);
        }
        maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
        maxVtu = gl.getParameter(gl.MAX_VERTEX_TEXTURE_IMAGE_UNITS);
        maxCombined = gl.getParameter(gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS);
        maxTiu = gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS);
        timerQuery = !!gl.getExtension('EXT_disjoint_timer_query_webgl2');
    }

    const haystack = `${vendor || ''} ${renderer || ''}`.toLowerCase();
    const softwareMatches = SOFTWARE_MARKERS.filter((m) => haystack.includes(m));

    const rect = canvas?.getBoundingClientRect();
    return {
        vendor, renderer, unmaskedAvailable,
        isSoftware: softwareMatches.length > 0,
        softwareMatches,
        maxTextureSize, maxVertexTextureImageUnits: maxVtu,
        maxCombinedTextureImageUnits: maxCombined, maxTextureImageUnits: maxTiu,
        timerQueryExtension: timerQuery,
        userAgent: navigator.userAgent,
        platform: (navigator as any).platform ?? 'unknown',
        visibilityState: document.visibilityState,
        devicePixelRatio: window.devicePixelRatio || 1,
        canvasCssWidth: rect ? Math.round(rect.width) : 0,
        canvasCssHeight: rect ? Math.round(rect.height) : 0,
        drawingBufferWidth: canvas ? (canvas as any).width : 0,
        drawingBufferHeight: canvas ? (canvas as any).height : 0,
    };
}

/**
 * GPU TIME_ELAPSED queries for the distance/sort submission and the draw submission.
 * Results are polled several frames later so the benchmark never stalls on the GPU, and
 * any sample flagged disjoint is discarded.
 */
export class GpuTimerPool {
    private readonly pending: Array<{ q: WebGLQuery; kind: 'sort' | 'draw'; frame: number; counted: boolean }> = [];
    readonly sortMs: number[] = [];
    readonly drawMs: number[] = [];
    disjointDiscarded = 0;
    /**
     * v1.1 Gate 4B-1 §8. A single GL command cannot take longer than the whole
     * measurement window it was issued in, so a sample above `maxValidMs` is
     * physically impossible and is excluded from the percentiles instead of being
     * averaged in. The excluded values are kept and reported, never hidden.
     *
     * The Gate 4A rerun carried one such sample (184467.440737 ms) in Test A and one
     * in Test B. Samples that were already plausible are untouched by this rule, so
     * the Test B / Test C percentiles already reported do not move.
     */
    readonly invalidMs: number[] = [];
    maxValidMs = 0;
    private frame = 0;
    private active: WebGLQuery | null = null;
    private collecting = false;

    constructor(private readonly gl: WebGL2RenderingContext, private readonly ext: any) {}

    setCollecting(on: boolean): void { this.collecting = on; }

    private begin(kind: 'sort' | 'draw'): void {
        if (this.active || this.pending.length > 24) return;
        const q = this.gl.createQuery();
        if (!q) return;
        this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
        this.active = q;
        // Whether a sample counts is decided when it is submitted, not when it is polled:
        // a query issued during warm-up must not land in the measured window just because
        // its result arrives after measurement started.
        this.pending.push({ q, kind, frame: this.frame, counted: this.collecting });
    }

    private end(): void {
        if (!this.active) return;
        this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
        this.active = null;
    }

    beginSort(): void { this.begin('sort'); }
    endSort(): void { this.end(); }
    beginDraw(): void { this.begin('draw'); }
    endDraw(): void { this.end(); }

    frameDone(): void {
        this.frame++;
        // Poll only queries submitted at least 4 frames ago.
        for (let i = this.pending.length - 1; i >= 0; i--) {
            const e = this.pending[i];
            if (this.frame - e.frame < 4) continue;
            const ready = this.gl.getQueryParameter(e.q, this.gl.QUERY_RESULT_AVAILABLE);
            if (!ready) continue;
            const disjoint = this.gl.getParameter(this.ext.GPU_DISJOINT_EXT);
            const ns = this.gl.getQueryParameter(e.q, this.gl.QUERY_RESULT) as number;
            this.gl.deleteQuery(e.q);
            this.pending.splice(i, 1);
            if (!e.counted) continue;
            if (disjoint) { this.disjointDiscarded++; continue; }
            const ms = ns / 1e6;
            if (this.maxValidMs > 0 && ms > this.maxValidMs) { this.invalidMs.push(ms); continue; }
            (e.kind === 'sort' ? this.sortMs : this.drawMs).push(ms);
        }
    }

    reset(): void {
        this.sortMs.length = 0;
        this.drawMs.length = 0;
        this.invalidMs.length = 0;
        this.disjointDiscarded = 0;
        // Drop anything still in flight from the previous phase.
        for (const e of this.pending) this.gl.deleteQuery(e.q);
        this.pending.length = 0;
        this.active = null;
    }

    dispose(): void {
        for (const e of this.pending) this.gl.deleteQuery(e.q);
        this.pending.length = 0;
    }
}

export interface UikaBenchmarkOptions {
    warmupMs: number;
    measureMs: number;
    /**
     * Self-test escape hatch. With a software renderer the harness normally returns
     * BLOCKED without running anything, which leaves the test driver itself unexercised.
     * This runs A/B/C anyway so the driver can be verified on any machine — and the
     * verdict is then forced to BLOCKED, never PASS, BORDERLINE or FAIL, because v1.1
     * Gate 4A §7 forbids judging performance on a software renderer.
     */
    allowSoftware: boolean;
}

export const DEFAULT_BENCHMARK_OPTIONS: UikaBenchmarkOptions = {
    warmupMs: 6000,
    measureMs: 60000,
    allowSoftware: false,
};

/**
 * Reads `?warmupMs=`, `?measureMs=` and `?allowSoftware=1`. The defaults are what a real
 * measurement uses; the overrides exist so the harness can be smoke-tested quickly.
 */
export function benchmarkOptionsFromUrl(): UikaBenchmarkOptions {
    const o = { ...DEFAULT_BENCHMARK_OPTIONS };
    try {
        const q = new URLSearchParams(window.location.search);
        const warm = Number(q.get('warmupMs'));
        const meas = Number(q.get('measureMs'));
        if (Number.isFinite(warm) && warm > 0) o.warmupMs = warm;
        if (Number.isFinite(meas) && meas > 0) o.measureMs = meas;
        if (q.get('allowSoftware') === '1') o.allowSoftware = true;
    } catch { /* noop */ }
    return o;
}

export class UikaNativeBenchmark {
    private report: UikaBenchmarkReport | null = null;
    private running = false;
    private abort = false;
    private pageErrors = 0;
    private forcedBlocked: string[] | null = null;
    private live = {
        test: '', phase: 'idle', elapsedMs: 0, renderedFrames: 0,
        effectiveFPS: 0, p95: 0, glErrors: 0, visible: true,
    };

    constructor(
        private readonly runtime: UikaNativeRuntime,
        private readonly replay: UikaNativeReplay,
    ) {
        window.addEventListener('error', () => { this.pageErrors++; });
        window.addEventListener('unhandledrejection', () => { this.pageErrors++; });
    }

    getLive() { return { ...this.live }; }
    getReport(): UikaBenchmarkReport | null { return this.report; }
    isRunning(): boolean { return this.running; }
    stop(): void { this.abort = true; }

    private canvas(): HTMLCanvasElement | null {
        const v: any = this.runtime.getViewer();
        return v?.renderer?.domElement ?? null;
    }

    private gl(): WebGL2RenderingContext | null {
        const v: any = this.runtime.getViewer();
        return v?.renderer?.getContext?.() ?? null;
    }

    async run(options: UikaBenchmarkOptions = DEFAULT_BENCHMARK_OPTIONS): Promise<UikaBenchmarkReport> {
        if (this.running) throw new Error('UIKA benchmark: already running');
        this.running = true;
        this.abort = false;

        const gpu = collectGpuInfo(this.canvas());
        const realGpu = !gpu.isSoftware && gpu.unmaskedAvailable;
        const rt: any = this.runtime.report;

        this.report = {
            spec: 'UIKA Native Runtime v1.1 Gate 4A',
            startedAt: new Date().toISOString(),
            finishedAt: null,
            gpu,
            realGpu,
            fixture: this.replay.getFixture(),
            runtime: {
                gaussianCount: rt.gaussianCount,
                basisCount: rt.basisCount,
                basisResident: rt.basisResident,
                basisLayout: rt.basisLayout,
                oacFreeCheck: rt.oacFreeCheck,
            },
            lifecycle: {
                rendererRecreations: 0, plyRewrites: 0, blobRecreations: 0, basisTextureRebuilds: 0,
                note: 'The benchmark never reloads the renderer; it only changes the 51 weights.',
            },
            tests: [],
            verdict: 'INCOMPLETE',
            verdictReasons: [],
        };

        const blockers: string[] = [];
        if (gpu.isSoftware) {
            blockers.push(`software renderer detected (${gpu.softwareMatches.join(', ')}): ${gpu.renderer}`);
        }
        if (!gpu.unmaskedAvailable) {
            blockers.push('WEBGL_debug_renderer_info is unavailable, so hardware acceleration cannot be confirmed');
        }
        if (blockers.length > 0 && !options.allowSoftware) {
            this.report.verdict = 'BLOCKED';
            this.report.verdictReasons.push(...blockers);
            this.report.finishedAt = new Date().toISOString();
            this.running = false;
            return this.report;
        }
        this.forcedBlocked = blockers.length > 0 ? blockers : null;

        try {
            this.report.tests.push(await this.runTest('A-neutral', options));
            if (!this.abort) this.report.tests.push(await this.runTest('B-fixed-pose', options));
            if (!this.abort) this.report.tests.push(await this.runTest('C-real-a2e-replay', options));
        } finally {
            this.replay.stop();
            this.runtime.setExpressionSource(null);
            this.runtime.setNeutral();
            const v: any = this.runtime.getViewer();
            v?.setGpuTimer?.(null);
            this.live.phase = 'idle';
            this.running = false;
        }

        this.report.finishedAt = new Date().toISOString();
        this.decide();
        return this.report;
    }

    private async runTest(
        name: UikaTestResult['name'],
        options: UikaBenchmarkOptions,
    ): Promise<UikaTestResult> {
        const viewer: any = this.runtime.getViewer();
        const gl = this.gl();
        const ext = gl ? gl.getExtension('EXT_disjoint_timer_query_webgl2') : null;
        const timers = gl && ext ? new GpuTimerPool(gl, ext) : null;
        viewer?.setGpuTimer?.(timers);

        const descriptions: Record<UikaTestResult['name'], string> = {
            'A-neutral': 'all 51 weights zero; the shader still evaluates every basis channel',
            'B-fixed-pose': 'fixture frame 20 held (the widest jaw/stretch pose of the take)',
            'C-real-a2e-replay': 'the 192-frame 30 fps real A2E capture, time-based replay',
        };

        // --- arrange the expression source for this test -------------------------
        this.replay.stop();
        this.runtime.setExpressionSource(null);
        if (name === 'A-neutral') {
            this.runtime.setNeutral();
        } else if (name === 'B-fixed-pose') {
            this.replay.holdFrame(20);
        } else {
            this.replay.start_();
            this.runtime.setExpressionSource(() => this.replay.tick());
        }

        const sampler = this.makeSampler(viewer);
        this.live.test = name;

        // --- warm-up -------------------------------------------------------------
        this.live.phase = 'warmup';
        const warmupStart = performance.now();
        const warmupFrames0 = viewer.stats.renderedFrames;
        await this.waitFor(() => performance.now() - warmupStart >= options.warmupMs);
        const warmupMs = performance.now() - warmupStart;
        const warmupFrames = viewer.stats.renderedFrames - warmupFrames0;

        // --- measure -------------------------------------------------------------
        timers?.reset();
        if (timers) timers.maxValidMs = options.measureMs;
        timers?.setCollecting(true);
        this.replay.resetInstrumentation();
        sampler.reset();
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
        await this.waitFor(() => performance.now() - measureStart >= options.measureMs, sampler.tick);
        const measuredMs = performance.now() - measureStart;
        document.removeEventListener('visibilitychange', onVis);
        if (hiddenSince !== null) visibilityLostMs += performance.now() - hiddenSince;
        timers?.setCollecting(false);

        const renderedFrames = viewer.stats.renderedFrames - frames0;
        const replayStats = this.replay.getStats();
        const expression = name === 'C-real-a2e-replay' ? {
            requestedFrame: replayStats.requestedFrame,
            selectedFrame: replayStats.selectedFrame,
            loops: replayStats.loop,
            mappedFrameCount: replayStats.mappedFrameCount,
            weightUploadCount: replayStats.weightUploadCount,
            skippedExpressionFrames: replayStats.skippedExpressionFrames,
            duplicateFrameRenders: replayStats.duplicateFrameRenders,
            maxFrameJump: replayStats.maxFrameJump,
            maxHoldMs: replayStats.maxHoldMs,
            clampViolations: sampler.clampViolations,
            rangeViolations: sampler.rangeViolations,
        } : null;

        const result: UikaTestResult = {
            name,
            description: descriptions[name],
            warmupMs, warmupFrames,
            measuredMs, renderedFrames,
            effectiveFPS: measuredMs > 0 ? renderedFrames / (measuredMs / 1000) : 0,
            frameInterval: summariseIntervals(sampler.intervals),
            cpu: {
                selectMs: name === 'C-real-a2e-replay' ? replayStats.selectMs : null,
                mapMs: name === 'C-real-a2e-replay' ? replayStats.mapMs : null,
                uploadMs: name === 'C-real-a2e-replay' ? replayStats.uploadMs : null,
                sortSubmitMs: summariseIntervals(sampler.sortSubmit),
                renderSubmitMs: summariseIntervals(sampler.renderSubmit),
            },
            gpu: timers ? {
                available: true,
                note: 'EXT_disjoint_timer_query_webgl2, polled 4+ frames later; disjoint samples discarded, '
                      + 'and samples longer than the measurement window excluded as invalid (Gate 4B-1 §8)',
                sortPassMs: summariseIntervals(timers.sortMs),
                drawPassMs: summariseIntervals(timers.drawMs),
                totalMs: summariseIntervals(timers.sortMs.concat(timers.drawMs)),
                disjointDiscarded: timers.disjointDiscarded,
                invalidSamples: timers.invalidMs.length,
                invalidValuesMs: timers.invalidMs.slice(0, 16),
                invalidRuleMs: timers.maxValidMs,
            } : {
                available: false,
                note: 'GPU_TIMER_QUERY = UNAVAILABLE (EXT_disjoint_timer_query_webgl2 not exposed)',
                sortPassMs: null, drawPassMs: null, totalMs: null, disjointDiscarded: 0,
                invalidSamples: 0, invalidValuesMs: [], invalidRuleMs: 0,
            },
            expression,
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

    /** Samples the per-frame wall clock and the viewer's own submit timings. */
    private makeSampler(viewer: any) {
        const intervals: number[] = [];
        const sortSubmit: number[] = [];
        const renderSubmit: number[] = [];
        let lastFrames = viewer.stats.renderedFrames;
        let lastAt = performance.now();
        const state = {
            intervals, sortSubmit, renderSubmit,
            clampViolations: 0, rangeViolations: 0,
            reset: () => {
                intervals.length = 0; sortSubmit.length = 0; renderSubmit.length = 0;
                state.clampViolations = 0; state.rangeViolations = 0;
                lastFrames = viewer.stats.renderedFrames;
                lastAt = performance.now();
            },
            tick: () => {
                const frames = viewer.stats.renderedFrames;
                if (frames > lastFrames) {
                    const now = performance.now();
                    const advanced = frames - lastFrames;
                    const dt = (now - lastAt) / advanced;
                    for (let i = 0; i < advanced; i++) intervals.push(dt);
                    const t = viewer.stats.timing;
                    sortSubmit.push(t.sortMs);
                    renderSubmit.push(t.drawMs);
                    lastFrames = frames;
                    lastAt = now;
                }
                const s = this.replay.getStats();
                if (s.running && !s.inGap && s.selectedFrame >= 0) {
                    if (s.requestedFrame <= 191 && s.selectedFrame !== s.requestedFrame) state.clampViolations++;
                    if (s.selectedFrame < 0 || s.selectedFrame > 191) state.rangeViolations++;
                }
                this.live.elapsedMs = performance.now() - lastAt;
                this.live.renderedFrames = frames;
                this.live.glErrors = viewer.stats.glErrorCount;
            },
        };
        return state;
    }

    private waitFor(done: () => boolean, each?: () => void): Promise<void> {
        return new Promise((resolve) => {
            const started = performance.now();
            const step = () => {
                if (this.abort || done()) { resolve(); return; }
                each?.();
                const elapsed = performance.now() - started;
                this.live.elapsedMs = elapsed;
                const v: any = this.runtime.getViewer();
                this.live.renderedFrames = v?.stats?.renderedFrames ?? 0;
                requestAnimationFrame(step);
            };
            requestAnimationFrame(step);
        });
    }

    /** v1.1 Gate 4A §21 / §22. */
    private decide(): void {
        const r = this.report!;
        if (this.forcedBlocked) {
            // Tests ran only to exercise the driver. Performance on a software renderer is
            // not evidence, so no PASS/BORDERLINE/FAIL may be derived from it.
            r.verdict = 'BLOCKED';
            r.verdictReasons = [
                ...this.forcedBlocked,
                'tests were executed with allowSoftware=1 to self-test the harness; '
                + 'these numbers are NOT a Gate 4A result',
            ];
            return;
        }
        const reasons: string[] = [];
        const c = r.tests.find((t) => t.name === 'C-real-a2e-replay');

        if (!c) { r.verdict = 'INCOMPLETE'; r.verdictReasons.push('Test C did not run'); return; }
        if (r.tests.some((t) => !t.valid)) {
            r.verdict = 'INCOMPLETE';
            r.verdictReasons.push(...r.tests.filter((t) => !t.valid).map((t) => `${t.name}: ${t.invalidReason}`));
            return;
        }

        const hard: Array<[string, boolean, string]> = [
            ['hardware GPU', r.realGpu, `${r.gpu.renderer}`],
            ['133541 splats', r.runtime.gaussianCount === 133541, `${r.runtime.gaussianCount}`],
            ['51 basis resident', r.runtime.basisCount === 51 && r.runtime.basisResident, `${r.runtime.basisCount}`],
            ['clamp violations 0', (c.expression?.clampViolations ?? 1) === 0, `${c.expression?.clampViolations}`],
            ['range violations 0', (c.expression?.rangeViolations ?? 1) === 0, `${c.expression?.rangeViolations}`],
            ['GL errors 0', r.tests.every((t) => t.glErrors === 0), r.tests.map((t) => t.glErrors).join('/')],
            ['page errors 0', r.tests.every((t) => t.pageErrors === 0), r.tests.map((t) => t.pageErrors).join('/')],
            ['OAC dependency 0', Object.values(r.runtime.oacFreeCheck).every((v) => v === false), ''],
        ];
        for (const [label, ok, detail] of hard) {
            if (!ok) reasons.push(`${label} FAILED (${detail})`);
        }

        const fpsOk = c.effectiveFPS >= 30;
        const p95Ok = c.frameInterval.p95 <= 33.3;
        const p99Ok = c.frameInterval.p99 <= 50;

        if (reasons.length > 0) {
            r.verdict = 'FAIL';
            r.verdictReasons = reasons;
            return;
        }
        if (fpsOk && p95Ok && p99Ok) {
            r.verdict = 'PASS';
            r.verdictReasons = [
                `Test C effectiveFPS ${c.effectiveFPS.toFixed(2)} >= 30`,
                `p95 ${c.frameInterval.p95.toFixed(2)} ms <= 33.3`,
                `p99 ${c.frameInterval.p99.toFixed(2)} ms <= 50`,
            ];
            return;
        }
        if (fpsOk && (!p95Ok || !p99Ok)) {
            r.verdict = 'BORDERLINE';
            r.verdictReasons = [
                `Test C effectiveFPS ${c.effectiveFPS.toFixed(2)} >= 30 but the frame interval is uneven`,
                `p95 ${c.frameInterval.p95.toFixed(2)} ms (limit 33.3)`,
                `p99 ${c.frameInterval.p99.toFixed(2)} ms (limit 50)`,
            ];
            return;
        }
        r.verdict = 'FAIL';
        r.verdictReasons = [
            `Test C effectiveFPS ${c.effectiveFPS.toFixed(2)} < 30`,
            `p95 ${c.frameInterval.p95.toFixed(2)} ms, p99 ${c.frameInterval.p99.toFixed(2)} ms`,
        ];
    }
}
