// UIKA Native Runtime Architecture Correction v1.1 — Gate 3B
//
// Project-owned minimal Gaussian viewer. This file contains NO third-party code:
// upstream `Viewer.js` is deliberately not forked (see
// docs/UIKA_NATIVE_RUNTIME_GATE3B_FORK_BOUNDARY.md §4.3).
//
// It owns exactly four things:
//   1. a THREE.WebGLRenderer / camera / scene,
//   2. loading one canonical UIKA PLY into one SplatMesh,
//   3. the depth sort, driven by the SAME animated centres the render shader uses,
//   4. the draw call.
//
// It contains no skeleton, no animation clip, no bind space, no head bone, no chat
// state and no OAC lifecycle.

import * as THREE from 'three';
import { PlyLoader } from './vendor/loaders/ply/PlyLoader.js';
import { SplatMesh } from './vendor/splatmesh/SplatMesh.js';
import { SplatRenderMode } from './vendor/SplatRenderMode.js';
import { LogLevel } from './vendor/LogLevel.js';

export interface UikaCameraMeta {
    /** Distance from the look-at point along +Z. */
    radius: number;
    lookAt: readonly [number, number, number];
    up: readonly [number, number, number];
    /** Focal length in pixels for `renderHeight` pixels of vertical resolution. */
    fy: number;
    renderHeight: number;
    near: number;
    far: number;
}

export interface UikaBasisLayout {
    basisCount: number;
    gaussianCount: number;
    requiredTexels: number;
    basisTexture: { width: number; height: number; texels: number; bytes: number };
    weightTexture: { width: number; height: number; texels: number };
    maxTextureSize: number;
}

export interface UikaFrameTiming {
    sortMs: number;
    drawMs: number;
    totalMs: number;
}

/** Gate 4B-1 diagnostic: what the render vertex shader actually contains right now. */
export interface UikaDiagnosticShaderInfo {
    /** null = the production source (loop bounded by the uikaBasisCount uniform). */
    bound: number | null;
    /** Gate 4B-2A: the PoC variant that fetches one pre-deformed centre is installed. */
    predeformActive: boolean;
    predeformFetches: number;
    basisLoopPresent: boolean;
    /** The loop bound as it appears in the source: 'uikaBasisCount', '8', ... */
    basisLoopBound: string | null;
    basisDeltaCalls: number;
    vertexShaderChars: number;
    vertexShaderHash: string;
    uikaBasisCountUniform: number;
}

/** Gate 4B-1 diagnostic: CSS size vs drawing-buffer size, measured from GL. */
export interface UikaDrawingBufferInfo {
    requestedScale: number;
    devicePixelRatio: number;
    rendererPixelRatio: number;
    cssWidth: number;
    cssHeight: number;
    rendererWidth: number;
    rendererHeight: number;
    drawingBufferWidth: number;
    drawingBufferHeight: number;
    viewportUniform: [number, number] | null;
    focalUniform: [number, number] | null;
}

/**
 * Gate 4B-2B-0 diagnostic. Every callback is optional and the recorder itself is null on
 * every production route, so none of this runs unless a diagnostic installs it.
 *
 * The phases follow one sort through its life: requested -> submitted -> the GPU distance
 * pass and its fence and readback (recorded by the pre-deformation pass, which owns them)
 * -> the CPU counting sort -> the render-index update -> completed.
 */
export interface UikaSortLifecycleRecorder {
    /** A counter only: runSort() is entered even while a sort is in flight. */
    requested?(): void;
    pendingSkip?(at: number): void;
    submitStart?(at: number): void;
    submitEnd?(at: number): void;
    cpuSortStart?(at: number): void;
    cpuSortEnd?(at: number): void;
    indexUpdateStart?(at: number): void;
    indexUpdateEnd?(at: number): void;
    completed?(at: number): void;
    failed?(at: number, error: unknown): void;
}

/** Gate 4B-2B-0 diagnostic: one entry per actual render() call. */
export interface UikaFrameTick {
    startedAt: number;
    endedAt: number;
    sortSubmitted: boolean;
}

/**
 * Gate 4B-2B-0 diagnostic: how far the sort pipeline is allowed to run.
 *
 *   full                 everything, exactly as production does it
 *   distance             the GPU distance pass, its fence and its readback only
 *   distance+cpuSort     the above plus the CPU counting sort, no render-index update
 *
 * Only `full` is ever used outside a diagnostic; the truncated stages exist to separate
 * readback from CPU sort from index upload and are not valid for any visual judgement.
 */
export type UikaSortStage = 'full' | 'distance' | 'distance+cpuSort';

/** Gate 4B-1 / 4B-2A diagnostic: a fingerprint of one rendered frame. */
export interface UikaDrawingBufferHash {
    width: number;
    height: number;
    hash: string;
    nonZeroPixels: number;
    alphaSum: number;
    /** Per-channel hashes. An RGB-only difference leaves aHash equal. */
    rHash: string;
    gHash: string;
    bHash: string;
    aHash: string;
    /** Only present when the caller asked for the pixels (Gate 4B-2A Diagnostic B). */
    pixels?: Uint8Array;
}

/**
 * Instrumentation only (Gate 4A). The benchmark owns the GL query objects; the viewer
 * just marks where the distance/sort submission and the draw submission begin and end.
 * It changes no rendering behaviour and is null outside the benchmark.
 */
export interface UikaGpuTimer {
    beginSort(): void;
    endSort(): void;
    beginDraw(): void;
    endDraw(): void;
    frameDone(): void;
}

export interface UikaGaussianRenderer {
    loadCanonicalPly(ply: Blob): Promise<void>;
    setExpressionBasis(deltas: Float32Array[], basisNames: readonly string[]): UikaBasisLayout;
    setExpressionWeights(weights: Float32Array): void;
    render(): void;
    dispose(): void;
}

function fail(message: string): never {
    throw new Error(`UIKA Gaussian Viewer: ${message}`);
}

/**
 * Counting sort over quantised view depths, back to front.
 *
 * The upstream package does this inside a WebAssembly worker. UIKA Native owns a plain
 * JS implementation instead so that no third-party worker or .wasm blob has to be forked.
 * The distances come from the GPU transform-feedback pass, which evaluates the animated
 * centre, so this function never sees a canonical centre.
 */
class DepthSorter {
    private readonly buckets: Uint32Array;
    private readonly bucketCount: number;
    private keys: Uint32Array = new Uint32Array(0);

    constructor(bucketCount = 65536) {
        this.bucketCount = bucketCount;
        this.buckets = new Uint32Array(bucketCount + 1);
    }

    /**
     * @param distances Per-splat depth key from the GPU pass.
     * @param count Number of splats.
     * @param out Receives splat indices in draw order.
     * @param farthestFirst true emits descending keys first (back to front).
     */
    sort(distances: Float32Array, count: number, out: Uint32Array, farthestFirst: boolean): void {
        if (out.length < count) fail(`sort output too small: ${out.length} < ${count}`);

        let min = Infinity;
        let max = -Infinity;
        for (let i = 0; i < count; i++) {
            const d = distances[i];
            if (d < min) min = d;
            if (d > max) max = d;
        }
        if (!Number.isFinite(min) || !Number.isFinite(max)) {
            fail(`non-finite splat distance (min=${min}, max=${max})`);
        }

        const range = max - min;
        const scale = range > 0 ? (this.bucketCount - 1) / range : 0;

        this.buckets.fill(0);
        const keys = this.keys.length >= count ? this.keys : (this.keys = new Uint32Array(count));
        const top = this.bucketCount - 1;
        for (let i = 0; i < count; i++) {
            let k = scale > 0 ? ((distances[i] - min) * scale) | 0 : 0;
            if (k > top) k = top;
            // Alpha compositing needs back-to-front order, so when a larger key means
            // "farther from the camera" the buckets are walked in reverse.
            if (farthestFirst) k = top - k;
            keys[i] = k;
            this.buckets[k + 1]++;
        }
        for (let b = 1; b <= this.bucketCount; b++) this.buckets[b] += this.buckets[b - 1];
        for (let i = 0; i < count; i++) out[this.buckets[keys[i]]++] = i;
    }
}

export class UikaGaussianViewer implements UikaGaussianRenderer {
    // `three` is untyped in this project (see three-ambient.d.ts), so these stay `any`.
    private renderer: any = null;
    private camera: any = null;
    private scene: any = null;
    private splatMesh: any = null;

    private splatCount = 0;
    private sortedIndexes: Uint32Array | null = null;
    private distances: Float32Array | null = null;
    private readonly sorter = new DepthSorter();
    private readonly mvpMatrix = new THREE.Matrix4();

    // A larger depth key from the distance shader means farther from the camera; see
    // uika-native-v1.astro's reported `sortKeyProbe` for the measurement that fixes this.
    private sortFarthestFirst = true;
    private gpuTimer: UikaGpuTimer | null = null;
    private sortRuns = 0;
    private sortPending = false;
    private sortDirty = true;
    private lastTiming: UikaFrameTiming = { sortMs: 0, drawMs: 0, totalMs: 0 };
    private glErrorCount = 0;
    private renderedFrames = 0;

    constructor(
        private readonly container: HTMLElement,
        private readonly meta: UikaCameraMeta,
    ) {}

    /** Instrumentation only (Gate 4A): install or clear the GPU timer hooks. */
    setGpuTimer(timer: UikaGpuTimer | null): void {
        this.gpuTimer = timer;
    }

    /** Instrumentation only: how many times the depth sort has actually been submitted. */
    getSortRuns(): number {
        return this.sortRuns;
    }

    /** Diagnostic only: the raw depth keys produced by the last GPU distance pass. */
    getDebugDistances(): Float32Array | null {
        return this.distances;
    }

    /** Diagnostic only: flip the draw order to confirm which direction composites correctly. */
    setSortFarthestFirst(value: boolean): void {
        this.sortFarthestFirst = value;
        this.sortDirty = true;
    }

    // ------------------------------------------------------------------------
    // Gate 4B-1 draw-isolation diagnostics.
    //
    // Everything in this block is opt-in and inert until a benchmark calls it.
    // The production path (/uika-native-replay) calls none of it, so with no call
    // the generated shader source, every uniform and the drawing-buffer size stay
    // exactly what Gate 3 and the Gate 4A rerun measured.
    // ------------------------------------------------------------------------

    private productionVertexShader: string | null = null;
    private diagnosticBasisBound: number | null = null;
    private drawingBufferScale = 1;
    private pendingReadback: {
        wantPixels: boolean;
        resolve: (hash: UikaDrawingBufferHash) => void;
    } | null = null;
    private sortSuspended = false;
    private sortLifecycle: UikaSortLifecycleRecorder | null = null;
    private frameTickHook: ((tick: UikaFrameTick) => void) | null = null;
    private sortStage: UikaSortStage = 'full';

    /**
     * The production basis loop, exactly as SplatMaterial.js emits it. Matching this
     * and nothing else is what makes the diagnostic variants honest: the rest of the
     * vertex shader — centres, covariance, opacity, scale, rotation, SH/RGB, the
     * projection — is carried over byte for byte.
     */
    private static readonly BASIS_LOOP_RE =
        /[ \t]*for \(int k = 0; k < uikaBasisCount; \+\+k\) \{\s*splatCenter \+= uikaWeight\(k\) \* uikaBasisDelta\(k, splatIndex\);\s*\}/;

    /**
     * Gate 4B-1 §4 / §7. Rebuild the render shader with a different basis loop:
     *
     *   null  the production source, loop bounded by the `uikaBasisCount` uniform
     *   0     no loop at all — the statement is gone from the shader source, so the
     *         GPU issues zero basis texture fetches. This is NOT the same as setting
     *         the weights to zero, which still runs 51 iterations and 51 fetches.
     *   N>0   the loop with a literal bound of N, for basis-count scaling
     *
     * Diagnostic only. The production renderer is never switched to a variant.
     */
    setDiagnosticBasisBound(bound: number | null): UikaDiagnosticShaderInfo {
        if (!this.splatMesh) fail('loadCanonicalPly() has not run');
        const material = this.splatMesh.material;
        if (this.productionVertexShader === null) {
            this.productionVertexShader = material.vertexShader;
        }
        const production = this.productionVertexShader!;
        if (!UikaGaussianViewer.BASIS_LOOP_RE.test(production)) {
            fail('the production basis loop was not found in the vertex shader source');
        }

        let next: string;
        if (bound === null) {
            next = production;
        } else if (!Number.isInteger(bound) || bound < 0) {
            fail(`diagnostic basis bound must be null or a non-negative integer, got ${bound}`);
        } else if (bound === 0) {
            next = production.replace(
                UikaGaussianViewer.BASIS_LOOP_RE,
                '            // UIKA Gate 4B-1 diagnostic variant: the basis loop is absent from\n'
                + '            // this shader source. No uikaBasisDelta / uikaWeight fetch is issued.',
            );
        } else {
            next = production.replace(
                UikaGaussianViewer.BASIS_LOOP_RE,
                `            for (int k = 0; k < ${bound}; ++k) {\n`
                + '                splatCenter += uikaWeight(k) * uikaBasisDelta(k, splatIndex);\n'
                + '            }',
            );
        }

        material.vertexShader = next;
        material.needsUpdate = true;
        this.diagnosticBasisBound = bound;
        this.sortDirty = true;
        return this.getDiagnosticShaderInfo();
    }

    /**
     * Gate 4B-1 §4 verification only. Hold the draw order still so that comparing two
     * rendered frames compares the shader and nothing else: a weight change moves the
     * animated centres, which would otherwise re-sort the splats, and alpha compositing
     * is order dependent. Measurements run with sorting in its normal state.
     */
    setSortSuspended(suspended: boolean): void {
        this.sortSuspended = suspended;
    }

    /** What the render shader currently contains. Measured from the source, not assumed. */
    getDiagnosticShaderInfo(): UikaDiagnosticShaderInfo {
        if (!this.splatMesh) fail('loadCanonicalPly() has not run');
        const source: string = this.splatMesh.material.vertexShader;
        const loop = source.match(/for \(int k = 0; k < ([A-Za-z0-9_]+); \+\+k\) \{/);
        const calls = source.split('uikaBasisDelta(k, splatIndex)').length - 1;
        let hash = 0x811c9dc5;
        for (let i = 0; i < source.length; i++) {
            hash ^= source.charCodeAt(i) & 0xff;
            hash = Math.imul(hash, 0x01000193);
        }
        return {
            bound: this.diagnosticBasisBound,
            predeformActive: this.predeformActive,
            predeformFetches: source.split('uikaPredeformedCenter(splatIndex)').length - 1,
            basisLoopPresent: loop !== null,
            basisLoopBound: loop ? loop[1] : null,
            basisDeltaCalls: calls,
            vertexShaderChars: source.length,
            vertexShaderHash: (hash >>> 0).toString(16).padStart(8, '0'),
            uikaBasisCountUniform: this.splatMesh.material.uniforms.uikaBasisCount.value,
        };
    }

    /**
     * Gate 4B-1 §3. Scale the drawing buffer while the CSS size stays put.
     *
     * Only `WebGLRenderer.setPixelRatio` moves. `renderer.getSize()` keeps reporting
     * the CSS size, so the focal length this viewer computes per frame does not move,
     * and `SplatMesh.updateUniforms` derives `viewport` / `basisViewport` from the
     * mesh's own devicePixelRatio, which is also left alone. The vertex shader
     * therefore produces identical clip-space geometry at every scale and only the
     * number of rasterised samples changes.
     */
    setDrawingBufferScale(scale: number): UikaDrawingBufferInfo {
        if (!this.renderer) fail('the renderer has not been created');
        if (!(scale > 0)) fail(`drawing-buffer scale must be positive, got ${scale}`);
        const width = this.container.clientWidth || 512;
        const height = this.container.clientHeight || 512;
        this.drawingBufferScale = scale;
        this.renderer.setPixelRatio((window.devicePixelRatio || 1) * scale);
        this.renderer.setSize(width, height, false);
        return this.getDrawingBufferInfo();
    }

    getDrawingBufferInfo(): UikaDrawingBufferInfo {
        if (!this.renderer) fail('the renderer has not been created');
        const gl = this.renderer.getContext();
        const canvas: HTMLCanvasElement = this.renderer.domElement;
        const size = new THREE.Vector2();
        this.renderer.getSize(size);
        return {
            requestedScale: this.drawingBufferScale,
            devicePixelRatio: window.devicePixelRatio || 1,
            rendererPixelRatio: this.renderer.getPixelRatio(),
            cssWidth: canvas.clientWidth,
            cssHeight: canvas.clientHeight,
            rendererWidth: size.x,
            rendererHeight: size.y,
            drawingBufferWidth: gl.drawingBufferWidth,
            drawingBufferHeight: gl.drawingBufferHeight,
            viewportUniform: this.splatMesh
                ? [this.splatMesh.material.uniforms.viewport.value.x,
                   this.splatMesh.material.uniforms.viewport.value.y]
                : null,
            focalUniform: this.splatMesh
                ? [this.splatMesh.material.uniforms.focal.value.x,
                   this.splatMesh.material.uniforms.focal.value.y]
                : null,
        };
    }

    /**
     * Hash the next rendered frame's drawing buffer. This is how a shader variant is
     * proved to be real rather than merely requested: a no-basis variant must render
     * the canonical pose even while non-zero weights are resident.
     *
     * readPixels stalls the pipeline, so this is only ever called in the verification
     * step, never inside a measurement window.
     */
    requestDrawingBufferHash(): Promise<UikaDrawingBufferHash> {
        if (!this.renderer) fail('the renderer has not been created');
        if (this.pendingReadback) fail('a drawing-buffer readback is already pending');
        return new Promise<UikaDrawingBufferHash>((resolve) => {
            this.pendingReadback = { wantPixels: false, resolve };
        });
    }

    /**
     * The same readback, keeping the RGBA bytes. Gate 4B-2A Diagnostic B compares two
     * frames pixel by pixel, which a hash cannot do.
     */
    requestDrawingBufferPixels(): Promise<UikaDrawingBufferHash> {
        if (!this.renderer) fail('the renderer has not been created');
        if (this.pendingReadback) fail('a drawing-buffer readback is already pending');
        return new Promise<UikaDrawingBufferHash>((resolve) => {
            this.pendingReadback = { wantPixels: true, resolve };
        });
    }


    // ------------------------------------------------------------------------
    // Gate 4B-2A pre-deformation PoC hooks.
    //
    // Opt-in and inert until the PoC calls them. /uika-native-replay,
    // /uika-native-benchmark and /uika-native-draw-isolation call none of these, so
    // with no call the shader source, the uniforms, the sort path and the draw path
    // are exactly what Gate 3, Gate 4A and Gate 4B-1 measured.
    // ------------------------------------------------------------------------

    private preRenderHook: (() => void) | null = null;
    private expressionWeightHook: (() => void) | null = null;
    private distanceProvider: ((mvp: any, out: Float32Array) => Promise<void>) | null = null;
    private predeformActive = false;

    /** Production basis loop replacement: one fetch from the pre-deformed centre texture. */
    private static readonly PREDEFORM_CENTER_FETCH = `
        // UIKA Gate 4B-2A PoC variant: the 51-channel basis loop is replaced by one
        // fetch of the pre-deformed animated centre. The pass that writes that texture
        // evaluates the identical expression once per expression frame.
        uniform highp sampler2D uikaAnimatedCenterTexture;
        uniform vec2 uikaAnimatedCenterTextureSize;

        vec3 uikaPredeformedCenter(in uint sIndex) {
            int i = int(sIndex);
            int w = int(uikaAnimatedCenterTextureSize.x);
            return texelFetch(uikaAnimatedCenterTexture, ivec2(i % w, i / w), 0).xyz;
        }
`;

    /** Borrowed by the PoC pass, which needs the same renderer and the same textures. */
    getPoCHandles(): { renderer: any; splatMesh: any; camera: any } | null {
        if (!this.renderer || !this.splatMesh) return null;
        return { renderer: this.renderer, splatMesh: this.splatMesh, camera: this.camera };
    }

    /** Run before anything else in render(). The PoC uses it for its deformation pass. */
    setPreRenderHook(hook: (() => void) | null): void {
        this.preRenderHook = hook;
    }

    /**
     * Called after every weight upload. The PoC uses it to mark its deformation pass
     * dirty, which is what keeps that pass to one run per changed expression frame
     * instead of one per animation frame.
     */
    setExpressionWeightHook(hook: (() => void) | null): void {
        this.expressionWeightHook = hook;
    }

    /**
     * Replace the depth-key source. null is the production path
     * (`SplatMesh.computeDistancesOnGPU`, which re-evaluates all 51 channels); the PoC
     * installs a pass that reads the same pre-deformed centres the render shader reads,
     * so render order and draw order still come from one animated centre.
     */
    setDistanceProvider(provider: ((mvp: any, out: Float32Array) => Promise<void>) | null): void {
        this.distanceProvider = provider;
        this.sortDirty = true;
    }

    /**
     * Gate 4B-2A §7. Swap the render vertex shader between the production 51-channel
     * loop (`texture = null`) and the PoC variant that fetches one pre-deformed centre.
     * Opacity, scale, rotation, SH/RGB, covariance and the projection are untouched in
     * both: only the statement that produces `splatCenter` differs.
     */
    setPredeformCenterTexture(texture: any | null, width: number, height: number): UikaDiagnosticShaderInfo {
        if (!this.splatMesh) fail('loadCanonicalPly() has not run');
        const material = this.splatMesh.material;
        if (this.productionVertexShader === null) {
            this.productionVertexShader = material.vertexShader;
        }
        const production = this.productionVertexShader!;
        if (!UikaGaussianViewer.BASIS_LOOP_RE.test(production)) {
            fail('the production basis loop was not found in the vertex shader source');
        }

        if (texture === null) {
            material.vertexShader = production;
            material.needsUpdate = true;
            this.predeformActive = false;
            this.diagnosticBasisBound = null;
            this.sortDirty = true;
            return this.getDiagnosticShaderInfo();
        }

        const anchor = '        const float SH_C1 = 0.4886025119029199f;';
        if (production.split(anchor).length - 1 !== 1) {
            fail('the shader anchor for the PoC uniform block is not unique');
        }
        let next = production.replace(
            anchor,
            UikaGaussianViewer.PREDEFORM_CENTER_FETCH + anchor,
        );
        next = next.replace(
            UikaGaussianViewer.BASIS_LOOP_RE,
            '            splatCenter = uikaPredeformedCenter(splatIndex);',
        );

        material.uniforms.uikaAnimatedCenterTexture = { value: texture };
        material.uniforms.uikaAnimatedCenterTextureSize = { value: new THREE.Vector2(width, height) };
        material.vertexShader = next;
        material.needsUpdate = true;
        material.uniformsNeedUpdate = true;
        this.predeformActive = true;
        this.diagnosticBasisBound = null;
        this.sortDirty = true;
        return this.getDiagnosticShaderInfo();
    }

    /**
     * Gate 4B-2B-0 §3. Called once per actual render() with that frame's own timestamps,
     * so a diagnostic can measure exact frame intervals instead of polling a counter from
     * a second requestAnimationFrame and splitting the elapsed time evenly.
     */
    setFrameTickHook(hook: ((tick: UikaFrameTick) => void) | null): void {
        this.frameTickHook = hook;
    }

    /** Gate 4B-2B-0 §4 / §5. Install or clear the sort lifecycle recorder. */
    setSortLifecycleRecorder(recorder: UikaSortLifecycleRecorder | null): void {
        this.sortLifecycle = recorder;
    }

    /** Gate 4B-2B-0 §8. Diagnostic only; `full` is the production pipeline. */
    setDiagnosticSortStage(stage: UikaSortStage): void {
        this.sortStage = stage;
        this.sortDirty = true;
    }

    getDiagnosticSortStage(): UikaSortStage {
        return this.sortStage;
    }

    /** True while the PoC render variant is installed. */
    isPredeformActive(): boolean {
        return this.predeformActive;
    }

    /** Drop a readback request that was abandoned, so the next one can be made. */
    clearPendingDrawingBufferHash(): void {
        this.pendingReadback = null;
    }

    private hashDrawingBuffer(keepPixels = false): UikaDrawingBufferHash {
        const gl = this.renderer.getContext();
        const width = gl.drawingBufferWidth;
        const height = gl.drawingBufferHeight;
        const pixels = new Uint8Array(width * height * 4);
        gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        const FNV_PRIME = 0x01000193;
        let hash = 0x811c9dc5;
        let rHash = 0x811c9dc5;
        let gHash = 0x811c9dc5;
        let bHash = 0x811c9dc5;
        let aHash = 0x811c9dc5;
        let nonZero = 0;
        let alphaSum = 0;
        for (let i = 0; i < pixels.length; i += 4) {
            const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2], a = pixels[i + 3];
            if (r !== 0 || g !== 0 || b !== 0 || a !== 0) nonZero++;
            alphaSum += a;
            hash ^= r; hash = Math.imul(hash, FNV_PRIME);
            hash ^= g; hash = Math.imul(hash, FNV_PRIME);
            hash ^= b; hash = Math.imul(hash, FNV_PRIME);
            hash ^= a; hash = Math.imul(hash, FNV_PRIME);
            rHash ^= r; rHash = Math.imul(rHash, FNV_PRIME);
            gHash ^= g; gHash = Math.imul(gHash, FNV_PRIME);
            bHash ^= b; bHash = Math.imul(bHash, FNV_PRIME);
            aHash ^= a; aHash = Math.imul(aHash, FNV_PRIME);
        }
        const hex = (v: number) => (v >>> 0).toString(16).padStart(8, '0');
        return {
            width, height,
            hash: hex(hash),
            nonZeroPixels: nonZero,
            alphaSum,
            rHash: hex(rHash),
            gHash: hex(gHash),
            bHash: hex(bHash),
            aHash: hex(aHash),
            ...(keepPixels ? { pixels } : {}),
        };
    }

    get stats() {
        return {
            splatCount: this.splatCount,
            renderedFrames: this.renderedFrames,
            sortRuns: this.sortRuns,
            basisCount: this.splatMesh ? this.splatMesh.uikaBasisCount : 0,
            glErrorCount: this.glErrorCount,
            timing: { ...this.lastTiming },
            hasFlameModel: this.splatMesh ? this.splatMesh.flameModel !== undefined : null,
            hasSkeleton: this.splatMesh ? this.splatMesh.skeleton !== undefined : null,
            hasAvatarMesh: (this as any).avatarMesh !== undefined,
        };
    }

    private initRenderer(): void {
        if (this.renderer) return;

        const width = this.container.clientWidth || 512;
        const height = this.container.clientHeight || 512;

        this.renderer = new THREE.WebGLRenderer({
            antialias: false,
            alpha: true,
            premultipliedAlpha: false,
        });
        this.renderer.setPixelRatio(window.devicePixelRatio || 1);
        this.renderer.setSize(width, height, false);
        this.renderer.setClearColor(0x000000, 0);
        this.container.appendChild(this.renderer.domElement);
        this.renderer.domElement.style.width = '100%';
        this.renderer.domElement.style.height = '100%';
        this.renderer.domElement.style.display = 'block';

        const fovDegrees = 2 * Math.atan(this.meta.renderHeight / (2 * this.meta.fy)) * 180 / Math.PI;
        this.camera = new THREE.PerspectiveCamera(fovDegrees, width / height, this.meta.near, this.meta.far);
        this.camera.up.set(...(this.meta.up as [number, number, number]));
        this.camera.position.set(
            this.meta.lookAt[0],
            this.meta.lookAt[1],
            this.meta.lookAt[2] + this.meta.radius,
        );
        this.camera.lookAt(...(this.meta.lookAt as [number, number, number]));
        this.camera.updateProjectionMatrix();
        this.camera.updateMatrixWorld(true);

        this.scene = new THREE.Scene();
    }

    async loadCanonicalPly(ply: Blob): Promise<void> {
        if (this.splatMesh) fail('a canonical PLY is already loaded');
        this.initRenderer();

        const plyBytes = await ply.arrayBuffer();
        // minimumAlpha must be 0. The UIKA asset stores opacity in logit space and 64,153
        // of its 133,541 Gaussians sit below sigmoid(x)*255 < 1 (threshold x < -5.5373).
        // The upstream default of 1 silently drops exactly those, leaving 69,388 splats.
        const splatBuffer = await PlyLoader.loadFromFileData(
            plyBytes,
            /* minimumAlpha      */ 0,
            /* compressionLevel  */ 0,
            /* optimizeSplatData */ false,
            /* outSHDegree       */ 0,
        );

        this.splatMesh = new SplatMesh(
            SplatRenderMode.ThreeD,
            /* dynamicMode                     */ false,
            /* enableOptionalEffects           */ false,
            /* halfPrecisionCovariancesOnGPU   */ false,
            /* devicePixelRatio                */ window.devicePixelRatio || 1,
            /* enableDistancesComputationOnGPU */ true,
            // Float distances only: the integer path quantises the centre and would not
            // match the render shader's animated centre bit for bit.
            /* integerBasedDistancesComputation*/ false,
            /* antialiased                     */ false,
            /* maxScreenSpaceSplatSize         */ 1024,
            /* logLevel                        */ LogLevel.None,
            /* sphericalHarmonicsDegree        */ 0,
        );
        this.splatMesh.frustumCulled = false;
        this.splatMesh.setRenderer(this.renderer);
        this.splatMesh.build(
            [splatBuffer],
            [{ splatAlphaRemovalThreshold: 0, position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }],
            /* keepSceneTransforms */ true,
            /* finalBuild          */ true,
        );
        this.splatMesh.setRenderer(this.renderer);

        this.splatCount = this.splatMesh.getSplatCount();
        if (this.splatCount <= 0) fail(`splatCount=${this.splatCount}`);

        this.sortedIndexes = new Uint32Array(this.splatCount);
        this.distances = new Float32Array(this.splatCount);

        // No progressive reveal: the whole avatar is present from the first frame.
        this.splatMesh.material.uniforms.fadeInComplete.value = 1;
        this.splatMesh.material.uniformsNeedUpdate = true;

        this.scene!.add(this.splatMesh);

        // Draw everything until the first sort lands, in splat-buffer order.
        for (let i = 0; i < this.splatCount; i++) this.sortedIndexes[i] = i;
        this.splatMesh.updateRenderIndexes(this.sortedIndexes, this.splatCount);
        this.sortDirty = true;
    }

    /**
     * Upload D_UIKA once. After this the per-frame cost of an expression change is
     * `basisNames.length` floats, nothing else.
     */
    setExpressionBasis(deltas: Float32Array[], basisNames: readonly string[]): UikaBasisLayout {
        if (!this.splatMesh) fail('loadCanonicalPly() has not run');
        if (deltas.length !== basisNames.length) {
            fail(`deltas=${deltas.length} names=${basisNames.length}`);
        }
        const layout = this.splatMesh.setUikaBasis(deltas, this.splatCount) as UikaBasisLayout;
        this.setExpressionWeights(new Float32Array(basisNames.length));
        return layout;
    }

    /** Per-frame expression update. No PLY, no Blob, no scene rebuild, no viewer reload. */
    setExpressionWeights(weights: Float32Array): void {
        if (!this.splatMesh) fail('loadCanonicalPly() has not run');
        this.splatMesh.setUikaWeights(weights);
        this.sortDirty = true;
        // Gate 4B-2A PoC only; null on every production route.
        this.expressionWeightHook?.();
    }

    /** Recompute view depths on the GPU, then order the splats back to front. */
    private runSort(): void {
        if (!this.splatMesh || !this.renderer || !this.camera) return;
        this.sortLifecycle?.requested?.();
        if (this.sortPending) {
            this.sortLifecycle?.pendingSkip?.(performance.now());
            return;
        }
        if (this.sortSuspended) return;

        this.mvpMatrix.copy(this.camera.matrixWorld).invert();
        this.mvpMatrix.premultiply(this.camera.projectionMatrix);
        this.mvpMatrix.multiply(this.splatMesh.matrixWorld);

        this.sortPending = true;
        this.sortDirty = false;
        this.sortRuns++;
        const distances = this.distances!;
        this.sortLifecycle?.submitStart?.(performance.now());
        this.gpuTimer?.beginSort();
        const sortPromise = this.distanceProvider
            ? this.distanceProvider(this.mvpMatrix, distances)
            : this.splatMesh.computeDistancesOnGPU(this.mvpMatrix, distances);
        this.gpuTimer?.endSort();
        this.sortLifecycle?.submitEnd?.(performance.now());
        const stage = this.sortStage;
        sortPromise
            .then(() => {
                if (stage !== 'distance') {
                    this.sortLifecycle?.cpuSortStart?.(performance.now());
                    this.sorter.sort(distances, this.splatCount, this.sortedIndexes!, this.sortFarthestFirst);
                    this.sortLifecycle?.cpuSortEnd?.(performance.now());
                }
                if (stage === 'full') {
                    this.sortLifecycle?.indexUpdateStart?.(performance.now());
                    this.splatMesh.updateRenderIndexes(this.sortedIndexes!, this.splatCount);
                    this.sortLifecycle?.indexUpdateEnd?.(performance.now());
                }
                this.sortPending = false;
                this.sortLifecycle?.completed?.(performance.now());
            })
            .catch((error: any) => {
                this.sortPending = false;
                this.sortLifecycle?.failed?.(performance.now(), error);
                throw error;
            });
    }

    render(): void {
        if (!this.renderer || !this.camera || !this.scene || !this.splatMesh) return;
        const started = performance.now();

        // Gate 4B-2A PoC only; null on every production route.
        this.preRenderHook?.();

        const renderDimensions = new THREE.Vector2();
        this.renderer.getSize(renderDimensions);
        const fovRadians = this.camera.fov * Math.PI / 180;
        const focalLengthY = renderDimensions.y / (2 * Math.tan(fovRadians / 2));
        const focalLengthX = focalLengthY * this.camera.aspect;
        this.splatMesh.updateUniforms(renderDimensions, focalLengthX, focalLengthY, false, 1.0, 1.0);

        const sortStarted = performance.now();
        const sortRunsBefore = this.sortRuns;
        if (this.sortDirty) this.runSort();
        const sortMs = performance.now() - sortStarted;
        const sortSubmitted = this.sortRuns !== sortRunsBefore;

        const drawStarted = performance.now();
        this.gpuTimer?.beginDraw();
        this.renderer.render(this.scene, this.camera);
        this.gpuTimer?.endDraw();
        const drawMs = performance.now() - drawStarted;

        // Gate 4B-1 verification only, and never inside a measurement window: the
        // readback stalls the pipeline. Inert when nothing requested a hash.
        if (this.pendingReadback) {
            const request = this.pendingReadback;
            this.pendingReadback = null;
            request.resolve(this.hashDrawingBuffer(request.wantPixels));
        }

        const gl = this.renderer.getContext();
        const err = gl.getError();
        if (err !== gl.NO_ERROR) this.glErrorCount++;

        this.renderedFrames++;
        const endedAt = performance.now();
        this.lastTiming = { sortMs, drawMs, totalMs: endedAt - started };
        this.gpuTimer?.frameDone();
        // Gate 4B-2B-0 PoC diagnostic only; null on every production route.
        this.frameTickHook?.({ startedAt: started, endedAt, sortSubmitted });
    }

    dispose(): void {
        if (this.splatMesh) {
            this.scene?.remove(this.splatMesh);
            this.splatMesh.dispose?.();
            this.splatMesh = null;
        }
        if (this.renderer) {
            this.renderer.domElement.remove();
            this.renderer.dispose();
            this.renderer = null;
        }
        this.camera = null;
        this.scene = null;
        this.sortedIndexes = null;
        this.distances = null;
        this.splatCount = 0;
    }
}
