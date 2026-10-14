// UIKA Native Runtime Architecture Correction v1.1 — Gate 3B
//
// Drives the project-owned Gaussian renderer. Nothing here touches the LAM OAC
// lifecycle, a skeleton, animation.glb, a head bone or a bind space, and nothing here
// talks to Live, A2E, Socket.IO or an AudioContext.

import { loadUikaNativeMigrationAsset } from './uika-native-asset-loader';
import { applyUikaBasisWeightsCpu, singleUikaBasisWeight } from './uika-deformation';
import { UikaGaussianViewer, type UikaBasisLayout, type UikaCameraMeta } from './renderer';
import {
    UIKA_NATIVE_V1_BASIS_COUNT,
    UIKA_NATIVE_V1_GAUSSIAN_COUNT,
    type UikaNativeAsset,
} from './uika-native-types';

/**
 * Camera intrinsics from the UIKA asset metadata. These are the same values the Gate 1
 * adapter used; they are avatar framing, not LAM runtime state.
 */
export const UIKA_NATIVE_CAMERA: UikaCameraMeta = {
    radius: 0.7826237921249264,
    lookAt: [0, 0, 0],
    up: [0, 1, 0],
    fy: 2590.80322265625,
    renderHeight: 1024,
    near: 0.01,
    far: 100.0,
};

export interface UikaNativeRuntimeReport {
    ready: boolean;
    phase: 'idle' | 'loading-asset' | 'loading-renderer' | 'neutral-ready' | 'error';
    gaussianCount: number;
    basisCount: number;
    viewerSplatCount: number | null;
    basisResident: boolean;
    basisLayout: UikaBasisLayout | null;
    activeWeights: Record<string, number>;
    renderedFrames: number;
    glErrorCount: number;
    frameMs: { sort: number; draw: number; total: number };
    renderInterval: {
        count: number; p50: number; p95: number; p99: number; max: number;
        over33: number; over50: number; over100: number;
    };
    /** Proof that no LAM OAC object exists on the native path. */
    oacFreeCheck: Record<string, boolean>;
    errors: string[];
}

export class UikaNativeRuntime {
    readonly report: UikaNativeRuntimeReport = {
        ready: false,
        phase: 'idle',
        gaussianCount: 0,
        basisCount: 0,
        viewerSplatCount: null,
        basisResident: false,
        basisLayout: null,
        activeWeights: {},
        renderedFrames: 0,
        glErrorCount: 0,
        frameMs: { sort: 0, draw: 0, total: 0 },
        renderInterval: { count: 0, p50: 0, p95: 0, p99: 0, max: 0, over33: 0, over50: 0, over100: 0 },
        oacFreeCheck: {},
        errors: [],
    };

    private asset: UikaNativeAsset | null = null;
    private viewer: UikaGaussianViewer | null = null;
    private rafId: number | null = null;
    /**
     * Optional per-frame hook, called just before the draw. Gate 3 uses it to advance a
     * fixed A2E replay. It owns no renderer state; all it may do is push weights.
     */
    private expressionSource: (() => void) | null = null;

    constructor(private readonly container: HTMLElement) {}

    getAsset(): UikaNativeAsset | null {
        return this.asset;
    }

    getViewer(): UikaGaussianViewer | null {
        return this.viewer;
    }

    async initializeNeutral(sourceUrl = '/avatar/uika-gakki-133k.zip'): Promise<void> {
        if (this.report.phase !== 'idle') {
            throw new Error(`UIKA Native: invalid phase ${this.report.phase}`);
        }
        try {
            this.report.phase = 'loading-asset';
            this.asset = await loadUikaNativeMigrationAsset(sourceUrl);
            this.report.gaussianCount = this.asset.gaussianCount;
            this.report.basisCount = this.asset.basis.names.length;
            if (this.report.gaussianCount !== UIKA_NATIVE_V1_GAUSSIAN_COUNT) {
                throw new Error(`gaussianCount=${this.report.gaussianCount}`);
            }
            if (this.report.basisCount !== UIKA_NATIVE_V1_BASIS_COUNT) {
                throw new Error(`basisCount=${this.report.basisCount}`);
            }

            this.report.phase = 'loading-renderer';
            this.viewer = new UikaGaussianViewer(this.container, UIKA_NATIVE_CAMERA);
            await this.viewer.loadCanonicalPly(this.asset.canonicalPly);

            const stats = this.viewer.stats;
            this.report.viewerSplatCount = stats.splatCount;
            if (stats.splatCount !== UIKA_NATIVE_V1_GAUSSIAN_COUNT) {
                throw new Error(`viewer splatCount=${stats.splatCount}`);
            }

            // GPU-resident D_UIKA. From here on an expression change costs 51 floats.
            this.report.basisLayout = this.viewer.setExpressionBasis(
                this.asset.basis.deltas,
                this.asset.basis.names,
            );
            this.report.basisResident = true;

            this.report.oacFreeCheck = this.collectOacFreeCheck();
            this.startRenderLoop();
            this.report.phase = 'neutral-ready';
            this.report.ready = true;

            console.log('[UIKA NATIVE V1] neutral READY (project-owned renderer)', {
                gaussianCount: this.report.gaussianCount,
                viewerSplatCount: this.report.viewerSplatCount,
                basisCount: this.report.basisCount,
                sourceSha256: this.asset.sourceSha256,
                canonicalBounds: this.asset.canonicalBounds,
                oacFreeCheck: this.report.oacFreeCheck,
            });
        } catch (error: any) {
            const message = error?.message || String(error);
            this.report.errors.push(message);
            this.report.phase = 'error';
            this.report.ready = false;
            console.error('[UIKA NATIVE V1] Gate 3B failed:', error);
            throw error;
        }
    }

    /**
     * Every entry must be false. These are the LAM OAC members whose absence is the whole
     * point of the native renderer, read off the live SplatMesh instance.
     */
    private collectOacFreeCheck(): Record<string, boolean> {
        const mesh: any = (this.viewer as any)?.splatMesh;
        const has = (key: string) => mesh ? mesh[key] !== undefined && mesh[key] !== null : false;
        return {
            flameModel: has('flameModel'),
            skeleton: has('skeleton'),
            bonesMatrix: has('bonesMatrix'),
            bonesWeight: has('bonesWeight'),
            morphTargetDictionary: has('morphTargetDictionary'),
            boneTextureUniform: !!mesh?.material?.uniforms?.boneTexture,
            boneWeightTextureUniform: !!mesh?.material?.uniforms?.boneWeightTexture,
            headBoneIndexUniform: !!mesh?.material?.uniforms?.headBoneIndex,
            flameModelTextureUniform: !!mesh?.material?.uniforms?.flameModelTexture,
            avatarMeshOnViewer: (this.viewer as any)?.avatarMesh !== undefined,
            splatTree: !!mesh?.splatTree,
        };
    }

    /** Render-to-render wall clock, for v1.1 Gate 3 §11. */
    private readonly renderIntervals: number[] = [];
    private lastRenderAt = 0;

    private recordRenderInterval(): void {
        const now = performance.now();
        if (this.lastRenderAt > 0) {
            const dt = now - this.lastRenderAt;
            this.renderIntervals.push(dt);
            if (this.renderIntervals.length > 4000) this.renderIntervals.shift();
            const r = this.report.renderInterval;
            r.count++;
            if (dt > 33) r.over33++;
            if (dt > 50) r.over50++;
            if (dt > 100) r.over100++;
            if (dt > r.max) r.max = dt;
            const sorted = [...this.renderIntervals].sort((a, b) => a - b);
            const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
            r.p50 = at(0.5);
            r.p95 = at(0.95);
            r.p99 = at(0.99);
        }
        this.lastRenderAt = now;
    }

    private startRenderLoop(): void {
        if (this.rafId !== null) return;
        const tick = () => {
            if (!this.viewer) return;
            if (this.expressionSource) {
                try {
                    this.expressionSource();
                } catch (error: any) {
                    this.report.errors.push(`expressionSource: ${error?.message || error}`);
                    this.expressionSource = null;
                }
            }
            this.viewer.render();
            this.recordRenderInterval();
            const stats = this.viewer.stats;
            this.report.renderedFrames = stats.renderedFrames;
            this.report.glErrorCount = stats.glErrorCount;
            this.report.frameMs = {
                sort: stats.timing.sortMs,
                draw: stats.timing.drawMs,
                total: stats.timing.totalMs,
            };
            this.rafId = requestAnimationFrame(tick);
        };
        this.rafId = requestAnimationFrame(tick);
    }

    /** Install (or clear) the per-frame expression source. */
    setExpressionSource(source: (() => void) | null): void {
        this.expressionSource = source;
    }

    /** Push weights straight to the GPU. The renderer is never recreated. */
    applyWeights(weights: Float32Array): void {
        if (!this.viewer) throw new Error('UIKA Native: not initialized');
        this.viewer.setExpressionWeights(weights);
    }

    /**
     * Gate 2 (GPU): drive a single basis channel and leave everything else at zero.
     * The renderer is never reloaded; only the weight texture changes.
     */
    setSingleBasis(name: string, weight = 1.0): { name: string; weight: number } {
        if (!this.asset || !this.viewer) throw new Error('UIKA Native: not initialized');
        const weights = singleUikaBasisWeight(this.asset.basis.names, name, weight);
        this.viewer.setExpressionWeights(weights);
        this.report.activeWeights = weight === 0 ? {} : { [name]: weight };
        return { name, weight };
    }

    /** Back to the canonical pose, again without touching the renderer. */
    setNeutral(): void {
        if (!this.asset || !this.viewer) throw new Error('UIKA Native: not initialized');
        this.viewer.setExpressionWeights(new Float32Array(this.asset.basis.names.length));
        this.report.activeWeights = {};
    }

    /**
     * CPU reference for the same weights, used to check the GPU result. This is the
     * Gate 2 reference implementation from uika-deformation.ts; it is never part of the
     * per-frame path.
     */
    cpuReference(name: string, weight = 1.0) {
        if (!this.asset) throw new Error('UIKA Native: not initialized');
        const weights = singleUikaBasisWeight(this.asset.basis.names, name, weight);
        const result = applyUikaBasisWeightsCpu(this.asset.canonicalPositions, this.asset.basis, weights);
        return { name, weight, positions: result.positions, stats: result.stats };
    }

    dispose(): void {
        if (this.rafId !== null) cancelAnimationFrame(this.rafId);
        this.rafId = null;
        this.viewer?.dispose();
        this.viewer = null;
        this.asset = null;
        this.report.ready = false;
        this.report.phase = 'idle';
    }
}
