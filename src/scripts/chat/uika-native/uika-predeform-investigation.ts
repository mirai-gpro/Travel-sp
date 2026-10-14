// UIKA Native Runtime v1.1 — Gate 4B-2A real-GPU correctness difference investigation
//
// On the real GPU, one of the eleven correctness cases failed: C-a2e-frame-20 produced a
// different framebuffer hash from the production render, while its non-zero pixel count
// and alpha sum matched exactly and frames 63, 123, 132 and 191 matched completely. This
// measures what that difference actually is, before anything is concluded and before any
// acceptance threshold is touched.
//
//   Diagnostic A   repeatability: 20+ renders per mode, every framebuffer hash kept
//   Diagnostic B   pixel-level diff of the two RGBA buffers, with a byte-delta histogram
//   Diagnostic C   animated centre XYZ compared GPU-to-GPU, in ULP as well as absolute
//   Diagnostic D   the same three for a failing frame and two passing frames
//
// No performance measurement. No threshold change. No cause asserted.

import type { UikaNativeRuntime } from './uika-native-runtime';
import type { UikaNativeReplay } from './uika-native-replay';
import type { UikaDrawingBufferHash } from './renderer';
import { collectGpuInfo, type UikaGpuInfo } from './uika-native-benchmark';
import { UikaPredeformPass } from './predeform/uika-predeform-pass';
import { UikaCenterProbe, type UikaCenterProbeRoute } from './predeform/uika-center-probe';

export const INVESTIGATION_FRAMES = [20, 63, 132];
export const DEFAULT_REPEATS = 20;

export interface UikaHashRun {
    mode: 'production' | 'predeform';
    hashes: string[];
    uniqueHashes: string[];
    frequency: Record<string, number>;
    stable: boolean;
}

export interface UikaRepeatability {
    repeats: number;
    production: UikaHashRun;
    predeform: UikaHashRun;
    /** Both modes internally stable but different from each other. */
    deterministicDifference: boolean;
    /** At least one mode disagreed with itself. */
    nondeterministicRender: boolean;
}

export interface UikaChannelDiff {
    differingCount: number;
    maxAbsByteDiff: number;
    meanAbsDiff: number;
    sumAbsDiff: number;
}

export interface UikaPixelDiff {
    width: number;
    height: number;
    totalPixels: number;
    differentPixels: number;
    differentPixelRatio: number;
    differentChannels: number;
    r: UikaChannelDiff;
    g: UikaChannelDiff;
    b: UikaChannelDiff;
    a: UikaChannelDiff;
    maxRgbaByteDelta: number;
    sumAbsoluteDifference: number;
    boundingBox: { minX: number; minY: number; maxX: number; maxY: number } | null;
    /** |delta| -> how many channel values differ by exactly that much. */
    deltaHistogram: Record<string, number>;
    channelHashes: {
        production: { r: string; g: string; b: string; a: string };
        predeform: { r: string; g: string; b: string; a: string };
        alphaPlaneIdentical: boolean;
        rgbOnlyDifference: boolean;
    };
    nonZeroPixels: { production: number; predeform: number };
    alphaSum: { production: number; predeform: number };
    hashes: { production: string; predeform: string; identical: boolean };
}

export interface UikaCenterDiff
{
    left: string;
    right: string;
    components: number;
    maxAbsX: number;
    maxAbsY: number;
    maxAbsZ: number;
    maxAbsXYZ: number;
    meanAbsXYZ: number;
    maxAbsXYZIndex: number;
    differentComponents: number;
    bitExactComponents: number;
    maxUlpDifference: number;
    /** ULP distance -> component count. '0', '1', '2', '3', '4', '>4'. */
    ulpHistogram: Record<string, number>;
    nonFinite: number;
}

export interface UikaFrameInvestigation {
    frame: number;
    nonZeroWeights: number;
    repeatability: UikaRepeatability;
    pixelDiff: UikaPixelDiff;
    centerDiffs: UikaCenterDiff[];
    cpuReferenceMaxAbs: { route: string; maxAbs: number }[];
}

export interface UikaInvestigationReport {
    spec: 'UIKA Native Runtime v1.1 Gate 4B-2A difference investigation';
    startedAt: string;
    finishedAt: string | null;
    gpu: UikaGpuInfo;
    realGpu: boolean;
    buffer: { width: number; height: number; pixelRatio: number };
    repeats: number;
    frames: UikaFrameInvestigation[];
    classification: 'A-real-correctness-defect'
        | 'B-deterministic-float-level-difference'
        | 'C-measurement-nondeterminism'
        /** Nothing differed at all on this machine, so none of A, B or C applies. */
        | 'NO-DIFFERENCE-REPRODUCED'
        | 'UNDETERMINED';
    classificationBasis: string[];
    /** Hypotheses, explicitly not conclusions. */
    hypothesesNotTested: string[];
    notes: string[];
}

export interface UikaInvestigationOptions {
    repeats: number;
    frames: number[];
}

export const DEFAULT_INVESTIGATION_OPTIONS: UikaInvestigationOptions = {
    repeats: DEFAULT_REPEATS,
    frames: INVESTIGATION_FRAMES,
};

/** `?repeats=20`, `?frames=20,63,132`. Parsed only when the parameter is present. */
export function investigationOptionsFromUrl(): UikaInvestigationOptions {
    const o = { ...DEFAULT_INVESTIGATION_OPTIONS };
    try {
        const q = new URLSearchParams(window.location.search);
        const repeats = Number(q.get('repeats'));
        if (Number.isFinite(repeats) && repeats >= 2) o.repeats = Math.floor(repeats);
        const rawFrames = q.get('frames');
        if (rawFrames !== null) {
            const frames = rawFrames.split(',').map(Number)
                .filter((v) => Number.isInteger(v) && v >= 0 && v <= 191);
            if (frames.length > 0) o.frames = frames;
        }
    } catch { /* noop */ }
    return o;
}

/** Ordered integer form of a float32, so that a difference of 1 means one ULP. */
function orderedBits(view: Int32Array, index: number): number {
    const bits = view[index];
    return bits < 0 ? -2147483648 - bits : bits;
}

export class UikaPredeformInvestigation {
    private report: UikaInvestigationReport | null = null;
    private pass: UikaPredeformPass | null = null;
    private probe: UikaCenterProbe | null = null;
    private running = false;
    private abort = false;
    private live = { step: '', phase: 'idle', frame: 0, repeat: 0 };

    constructor(
        private readonly runtime: UikaNativeRuntime,
        private readonly replay: UikaNativeReplay,
    ) {}

    getLive() { return { ...this.live }; }
    getReport(): UikaInvestigationReport | null { return this.report; }
    isRunning(): boolean { return this.running; }
    stop(): void { this.abort = true; }

    private viewer(): any { return this.runtime.getViewer(); }

    async run(options: UikaInvestigationOptions = DEFAULT_INVESTIGATION_OPTIONS): Promise<UikaInvestigationReport> {
        if (this.running) throw new Error('UIKA Gate 4B-2A investigation: already running');
        this.running = true;
        this.abort = false;

        const viewer = this.viewer();
        const gpu = collectGpuInfo(viewer?.renderer?.domElement ?? null);
        const bufferInfo = viewer.getDrawingBufferInfo();

        this.report = {
            spec: 'UIKA Native Runtime v1.1 Gate 4B-2A difference investigation',
            startedAt: new Date().toISOString(),
            finishedAt: null,
            gpu,
            realGpu: !gpu.isSoftware && gpu.unmaskedAvailable,
            buffer: {
                width: bufferInfo.drawingBufferWidth,
                height: bufferInfo.drawingBufferHeight,
                pixelRatio: bufferInfo.rendererPixelRatio,
            },
            repeats: options.repeats,
            frames: [],
            classification: 'UNDETERMINED',
            classificationBasis: [],
            hypothesesNotTested: [
                'the AMD shader compiler may contract a multiply-add into an FMA in one '
                + 'shader stage and not the other',
                'rounding, instruction ordering or stage-specific optimisation may differ '
                + 'between the production vertex shader and the pre-deformation fragment shader',
                'none of the above was tested in this investigation, so none of it is a finding',
            ],
            notes: [],
        };
        const r = this.report;

        try {
            const handles = viewer.getPoCHandles();
            if (!handles) throw new Error('the viewer has no renderer or splat mesh yet');

            this.pass = new UikaPredeformPass();
            this.pass.init(handles);
            this.probe = new UikaCenterProbe(handles.renderer, handles.splatMesh);

            viewer.setPreRenderHook(() => { this.pass?.runIfDirty(); });
            viewer.setExpressionWeightHook(() => { this.pass?.markDirty(); });

            this.replay.stop();
            this.runtime.setExpressionSource(null);
            viewer.setDrawingBufferScale(1);
            // One draw order throughout, so a pixel difference cannot come from the sort.
            viewer.setSortSuspended(true);

            for (const frame of options.frames) {
                if (this.abort) break;
                this.live.frame = frame;
                r.frames.push(await this.investigateFrame(frame, options, handles));
            }

            this.classify();
        } finally {
            try {
                viewer?.setPreRenderHook?.(null);
                viewer?.setExpressionWeightHook?.(null);
                viewer?.setDistanceProvider?.(null);
                viewer?.setPredeformCenterTexture?.(null, 0, 0);
                viewer?.setSortSuspended?.(false);
            } catch { /* noop */ }
            this.probe?.dispose();
            this.probe = null;
            this.pass?.dispose();
            this.pass = null;
            this.replay.stop();
            this.runtime.setExpressionSource(null);
            this.runtime.setNeutral();
            this.live.phase = 'idle';
            this.live.step = '';
            this.running = false;
            // Gate 4B-2A §10: an early stop still gets a finish time.
            r.finishedAt = new Date().toISOString();
        }

        return r;
    }

    private async nextFramePixels(): Promise<UikaDrawingBufferHash> {
        const viewer = this.viewer();
        let timer = 0;
        try {
            return await Promise.race([
                viewer.requestDrawingBufferPixels() as Promise<UikaDrawingBufferHash>,
                new Promise<UikaDrawingBufferHash>((_, reject) => {
                    timer = window.setTimeout(
                        () => reject(new Error('UIKA investigation: no frame within 30000 ms')), 30000);
                }),
            ]);
        } finally {
            window.clearTimeout(timer);
            viewer.clearPendingDrawingBufferHash?.();
        }
    }

    private async nextFrameHash(): Promise<UikaDrawingBufferHash> {
        const viewer = this.viewer();
        let timer = 0;
        try {
            return await Promise.race([
                viewer.requestDrawingBufferHash() as Promise<UikaDrawingBufferHash>,
                new Promise<UikaDrawingBufferHash>((_, reject) => {
                    timer = window.setTimeout(
                        () => reject(new Error('UIKA investigation: no frame within 30000 ms')), 30000);
                }),
            ]);
        } finally {
            window.clearTimeout(timer);
            viewer.clearPendingDrawingBufferHash?.();
        }
    }

    private async investigateFrame(
        frame: number,
        options: UikaInvestigationOptions,
        handles: any,
    ): Promise<UikaFrameInvestigation> {
        const viewer = this.viewer();
        const layout = this.pass!.getLayout()!;
        const held = this.replay.holdFrame(frame);
        const weights = new Float32Array(held.weights);

        // --- Diagnostic A: repeatability ----------------------------------
        this.live.phase = 'repeatability';
        const collect = async (mode: 'production' | 'predeform'): Promise<UikaHashRun> => {
            if (mode === 'production') {
                viewer.setPredeformCenterTexture(null, 0, 0);
                viewer.setDistanceProvider(null);
            } else {
                viewer.setPredeformCenterTexture(this.pass!.getTexture(),
                                                 layout.textureWidth, layout.textureHeight);
                viewer.setDistanceProvider((m: any, out: Float32Array) => this.pass!.computeDistances(m, out));
            }
            this.runtime.applyWeights(weights);
            this.pass!.markDirty();
            const hashes: string[] = [];
            for (let i = 0; i < options.repeats; i++) {
                if (this.abort) break;
                this.live.step = `frame ${frame} ${mode} ${i + 1}/${options.repeats}`;
                this.live.repeat = i + 1;
                hashes.push((await this.nextFrameHash()).hash);
            }
            const frequency: Record<string, number> = {};
            for (const h of hashes) frequency[h] = (frequency[h] ?? 0) + 1;
            const uniqueHashes = Object.keys(frequency);
            return { mode, hashes, uniqueHashes, frequency, stable: uniqueHashes.length === 1 };
        };

        const production = await collect('production');
        const predeform = await collect('predeform');
        const repeatability: UikaRepeatability = {
            repeats: options.repeats,
            production,
            predeform,
            deterministicDifference: production.stable && predeform.stable
                && production.uniqueHashes[0] !== predeform.uniqueHashes[0],
            nondeterministicRender: !production.stable || !predeform.stable,
        };

        // --- Diagnostic B: pixel-level diff -------------------------------
        this.live.phase = 'pixel diff';
        this.live.step = `frame ${frame} pixel diff`;
        viewer.setPredeformCenterTexture(null, 0, 0);
        viewer.setDistanceProvider(null);
        this.runtime.applyWeights(weights);
        this.pass!.markDirty();
        const productionFrame = await this.nextFramePixels();

        viewer.setPredeformCenterTexture(this.pass!.getTexture(),
                                         layout.textureWidth, layout.textureHeight);
        viewer.setDistanceProvider((m: any, out: Float32Array) => this.pass!.computeDistances(m, out));
        const predeformFrame = await this.nextFramePixels();

        const pixelDiff = this.comparePixels(productionFrame, predeformFrame);

        // --- Diagnostic C: GPU centre comparison --------------------------
        this.live.phase = 'centre diff';
        this.live.step = `frame ${frame} centre diff`;
        // The production attribute route needs SplatMesh's centres buffer, which exists
        // because the production distance pass ran during Diagnostic A.
        const gaussianCount = handles.splatMesh.getSplatCount();
        const routes: UikaCenterProbeRoute[] = ['production-attribute', 'production-texture'];
        const gpuCenters = new Map<string, Float32Array>();
        for (const route of routes) gpuCenters.set(route, this.probe!.read(route));

        this.pass!.run();
        const texture = this.pass!.readAnimatedCenters();
        const predeformCenters = new Float32Array(gaussianCount * 3);
        for (let i = 0; i < gaussianCount; i++) {
            const t = (Math.floor(i / layout.textureWidth) * layout.textureWidth
                       + (i % layout.textureWidth)) * 4;
            predeformCenters[i * 3] = texture[t];
            predeformCenters[i * 3 + 1] = texture[t + 1];
            predeformCenters[i * 3 + 2] = texture[t + 2];
        }
        gpuCenters.set('predeform', predeformCenters);

        const centerDiffs: UikaCenterDiff[] = [
            this.compareCenters('production-attribute', 'predeform', gpuCenters),
            this.compareCenters('production-texture', 'predeform', gpuCenters),
            this.compareCenters('production-attribute', 'production-texture', gpuCenters),
        ];

        const asset = this.runtime.getAsset()!;
        const cpuReferenceMaxAbs: { route: string; maxAbs: number }[] = [];
        const { applyUikaBasisWeightsCpu } = await import('./uika-deformation');
        const reference = applyUikaBasisWeightsCpu(asset.canonicalPositions, asset.basis, weights);
        for (const [route, values] of gpuCenters) {
            let maxAbs = 0;
            for (let i = 0; i < values.length; i++) {
                const d = Math.abs(values[i] - reference.positions[i]);
                if (d > maxAbs) maxAbs = d;
            }
            cpuReferenceMaxAbs.push({ route, maxAbs });
        }

        return {
            frame,
            nonZeroWeights: Array.from(weights).filter((w) => w !== 0).length,
            repeatability,
            pixelDiff,
            centerDiffs,
            cpuReferenceMaxAbs,
        };
    }

    private comparePixels(a: UikaDrawingBufferHash, b: UikaDrawingBufferHash): UikaPixelDiff {
        const pa = a.pixels!;
        const pb = b.pixels!;
        if (pa.length !== pb.length) throw new Error('the two frames have different sizes');
        const width = a.width;
        const height = a.height;
        const totalPixels = width * height;

        const channel = (): UikaChannelDiff =>
            ({ differingCount: 0, maxAbsByteDiff: 0, meanAbsDiff: 0, sumAbsDiff: 0 });
        const r = channel(); const g = channel(); const bb = channel(); const al = channel();
        const buckets = [r, g, bb, al];
        const histogram: Record<string, number> = {};

        let differentPixels = 0;
        let differentChannels = 0;
        let maxRgbaByteDelta = 0;
        let sumAbsoluteDifference = 0;
        let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;

        for (let p = 0; p < totalPixels; p++) {
            const i = p * 4;
            let pixelDiffers = false;
            for (let c = 0; c < 4; c++) {
                const d = Math.abs(pa[i + c] - pb[i + c]);
                if (d === 0) continue;
                pixelDiffers = true;
                differentChannels++;
                sumAbsoluteDifference += d;
                const bucket = buckets[c];
                bucket.differingCount++;
                bucket.sumAbsDiff += d;
                if (d > bucket.maxAbsByteDiff) bucket.maxAbsByteDiff = d;
                if (d > maxRgbaByteDelta) maxRgbaByteDelta = d;
                const key = String(d);
                histogram[key] = (histogram[key] ?? 0) + 1;
            }
            if (pixelDiffers) {
                differentPixels++;
                const x = p % width;
                const y = Math.floor(p / width);
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
            }
        }
        for (const bucket of buckets) {
            bucket.meanAbsDiff = bucket.differingCount > 0
                ? bucket.sumAbsDiff / bucket.differingCount : 0;
        }

        return {
            width, height, totalPixels,
            differentPixels,
            differentPixelRatio: differentPixels / totalPixels,
            differentChannels,
            r, g, b: bb, a: al,
            maxRgbaByteDelta,
            sumAbsoluteDifference,
            boundingBox: differentPixels > 0 ? { minX, minY, maxX, maxY } : null,
            deltaHistogram: histogram,
            channelHashes: {
                production: { r: a.rHash, g: a.gHash, b: a.bHash, a: a.aHash },
                predeform: { r: b.rHash, g: b.gHash, b: b.bHash, a: b.aHash },
                alphaPlaneIdentical: a.aHash === b.aHash,
                rgbOnlyDifference: a.aHash === b.aHash
                    && (a.rHash !== b.rHash || a.gHash !== b.gHash || a.bHash !== b.bHash),
            },
            nonZeroPixels: { production: a.nonZeroPixels, predeform: b.nonZeroPixels },
            alphaSum: { production: a.alphaSum, predeform: b.alphaSum },
            hashes: { production: a.hash, predeform: b.hash, identical: a.hash === b.hash },
        };
    }

    private compareCenters(
        leftName: string,
        rightName: string,
        centers: Map<string, Float32Array>,
    ): UikaCenterDiff {
        const left = centers.get(leftName)!;
        const right = centers.get(rightName)!;
        const components = Math.min(left.length, right.length);
        const leftBits = new Int32Array(left.buffer, left.byteOffset, left.length);
        const rightBits = new Int32Array(right.buffer, right.byteOffset, right.length);

        let maxAbs = [0, 0, 0];
        let maxAbsXYZ = 0;
        let maxIndex = -1;
        let sumAbs = 0;
        let different = 0;
        let bitExact = 0;
        let maxUlp = 0;
        let nonFinite = 0;
        const ulpHistogram: Record<string, number> = { '0': 0, '1': 0, '2': 0, '3': 0, '4': 0, '>4': 0 };

        for (let i = 0; i < components; i++) {
            const a = left[i];
            const b = right[i];
            if (!Number.isFinite(a) || !Number.isFinite(b)) { nonFinite++; continue; }
            const d = Math.abs(a - b);
            sumAbs += d;
            const axis = i % 3;
            if (d > maxAbs[axis]) maxAbs[axis] = d;
            if (d > maxAbsXYZ) { maxAbsXYZ = d; maxIndex = Math.floor(i / 3); }
            if (leftBits[i] === rightBits[i]) {
                bitExact++;
                ulpHistogram['0']++;
                continue;
            }
            different++;
            const ulp = Math.abs(orderedBits(leftBits, i) - orderedBits(rightBits, i));
            if (ulp > maxUlp) maxUlp = ulp;
            ulpHistogram[ulp <= 4 ? String(ulp) : '>4']++;
        }

        return {
            left: leftName,
            right: rightName,
            components,
            maxAbsX: maxAbs[0],
            maxAbsY: maxAbs[1],
            maxAbsZ: maxAbs[2],
            maxAbsXYZ,
            meanAbsXYZ: components > 0 ? sumAbs / components : 0,
            maxAbsXYZIndex: maxIndex,
            differentComponents: different,
            bitExactComponents: bitExact,
            maxUlpDifference: maxUlp,
            ulpHistogram,
            nonFinite,
        };
    }

    /**
     * Picks between the three outcomes the gate defined, from the measurements alone.
     * It does not choose a cause, and option B explicitly does not mean "acceptable":
     * whether a deterministic float-level difference is acceptable is a separate decision,
     * to be taken on these numbers.
     */
    private classify(): void {
        const r = this.report!;
        const basis: string[] = [];
        if (r.frames.length === 0) {
            r.classification = 'UNDETERMINED';
            r.classificationBasis = ['no frame was investigated'];
            return;
        }

        const anyNondeterministic = r.frames.some((f) => f.repeatability.nondeterministicRender);
        const anyPixelDifference = r.frames.some((f) => !f.pixelDiff.hashes.identical);
        const anyCenterDifference = r.frames.some((f) => f.centerDiffs.some(
            (d) => (d.left.startsWith('production') && d.right === 'predeform') && d.differentComponents > 0));
        const maxUlp = Math.max(...r.frames.flatMap((f) => f.centerDiffs
            .filter((d) => d.right === 'predeform').map((d) => d.maxUlpDifference)), 0);
        const maxByteDelta = Math.max(...r.frames.map((f) => f.pixelDiff.maxRgbaByteDelta), 0);
        const maxRatio = Math.max(...r.frames.map((f) => f.pixelDiff.differentPixelRatio), 0);

        for (const f of r.frames) {
            basis.push(`frame ${f.frame}: production ${f.repeatability.production.uniqueHashes.length} `
                + `unique hash(es) over ${f.repeatability.repeats} renders, predeform `
                + `${f.repeatability.predeform.uniqueHashes.length}; `
                + `${f.pixelDiff.differentPixels}/${f.pixelDiff.totalPixels} pixels differ, `
                + `max byte delta ${f.pixelDiff.maxRgbaByteDelta}, alpha plane `
                + `${f.pixelDiff.channelHashes.alphaPlaneIdentical ? 'identical' : 'different'}`);
        }
        basis.push(`largest centre ULP difference against the pre-deformed texture: ${maxUlp}`);

        if (anyNondeterministic) {
            r.classification = 'C-measurement-nondeterminism';
            basis.push('at least one mode disagreed with itself across repeated renders of the '
                + 'same pose, so the hash comparison is not a stable measurement');
        } else if (!anyPixelDifference && !anyCenterDifference) {
            r.classification = 'NO-DIFFERENCE-REPRODUCED';
            basis.push('no pixel difference and no centre difference was reproduced on this '
                + 'machine, so none of A, B or C applies to it');
        } else if (maxUlp <= 4 && maxByteDelta <= 2) {
            r.classification = 'B-deterministic-float-level-difference';
            basis.push('every mode is self-consistent, the centre difference is within a few ULP '
                + 'and the pixel difference is within a couple of byte levels');
        } else {
            r.classification = 'A-real-correctness-defect';
            basis.push(`the difference exceeds the float-level band (max ULP ${maxUlp}, max byte `
                + `delta ${maxByteDelta}, ${(maxRatio * 100).toFixed(4)}% of pixels)`);
        }
        r.classificationBasis = basis;
        r.notes.push('classification B does not by itself mean the PoC passes: the acceptance '
            + 'threshold is unchanged and any change to it is a separate decision based on these '
            + 'numbers.');
    }
}
