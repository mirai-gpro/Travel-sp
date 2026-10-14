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
    private sortPending = false;
    private sortDirty = true;
    private lastTiming: UikaFrameTiming = { sortMs: 0, drawMs: 0, totalMs: 0 };
    private glErrorCount = 0;
    private renderedFrames = 0;

    constructor(
        private readonly container: HTMLElement,
        private readonly meta: UikaCameraMeta,
    ) {}

    /** Diagnostic only: the raw depth keys produced by the last GPU distance pass. */
    getDebugDistances(): Float32Array | null {
        return this.distances;
    }

    /** Diagnostic only: flip the draw order to confirm which direction composites correctly. */
    setSortFarthestFirst(value: boolean): void {
        this.sortFarthestFirst = value;
        this.sortDirty = true;
    }

    get stats() {
        return {
            splatCount: this.splatCount,
            renderedFrames: this.renderedFrames,
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
    }

    /** Recompute view depths on the GPU, then order the splats back to front. */
    private runSort(): void {
        if (!this.splatMesh || !this.renderer || !this.camera) return;
        if (this.sortPending) return;

        this.mvpMatrix.copy(this.camera.matrixWorld).invert();
        this.mvpMatrix.premultiply(this.camera.projectionMatrix);
        this.mvpMatrix.multiply(this.splatMesh.matrixWorld);

        this.sortPending = true;
        this.sortDirty = false;
        const distances = this.distances!;
        this.splatMesh.computeDistancesOnGPU(this.mvpMatrix, distances)
            .then(() => {
                this.sorter.sort(distances, this.splatCount, this.sortedIndexes!, this.sortFarthestFirst);
                this.splatMesh.updateRenderIndexes(this.sortedIndexes!, this.splatCount);
                this.sortPending = false;
            })
            .catch((error: any) => {
                this.sortPending = false;
                throw error;
            });
    }

    render(): void {
        if (!this.renderer || !this.camera || !this.scene || !this.splatMesh) return;
        const started = performance.now();

        const renderDimensions = new THREE.Vector2();
        this.renderer.getSize(renderDimensions);
        const fovRadians = this.camera.fov * Math.PI / 180;
        const focalLengthY = renderDimensions.y / (2 * Math.tan(fovRadians / 2));
        const focalLengthX = focalLengthY * this.camera.aspect;
        this.splatMesh.updateUniforms(renderDimensions, focalLengthX, focalLengthY, false, 1.0, 1.0);

        const sortStarted = performance.now();
        if (this.sortDirty) this.runSort();
        const sortMs = performance.now() - sortStarted;

        const drawStarted = performance.now();
        this.renderer.render(this.scene, this.camera);
        const drawMs = performance.now() - drawStarted;

        const gl = this.renderer.getContext();
        const err = gl.getError();
        if (err !== gl.NO_ERROR) this.glErrorCount++;

        this.renderedFrames++;
        this.lastTiming = { sortMs, drawMs, totalMs: performance.now() - started };
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
