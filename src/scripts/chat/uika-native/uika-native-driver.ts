// UIKA Native Runtime Architecture Correction v1.0
// Gate 1: neutral canonical UIKA render.
// Gate 2: deterministic single-basis correctness render (CPU reference, not real-time path).
// No A2E clock, no Live, no skeleton, no LAM animation.

import { applyUikaBasisWeightsCpu, singleUikaBasisWeight } from './uika-deformation';
import { loadUikaNativeMigrationAsset } from './uika-native-asset-loader';
import { rewritePlyPositions } from './ply-reconstruct';
import { UikaRenderAdapter } from './uika-render-adapter';
import {
    UIKA_NATIVE_V1_BASIS_COUNT,
    UIKA_NATIVE_V1_GAUSSIAN_COUNT,
    type UikaNativeAsset,
    type UikaNativeRuntimeStatus,
} from './uika-native-types';

export class UikaNativeDriver {
    readonly status: UikaNativeRuntimeStatus = {
        ready: false,
        phase: 'idle',
        gaussianCount: 0,
        basisCount: 0,
        renderedFrames: 0,
        lastFrameMs: 0,
        glErrorCount: 0,
        errors: [],
    };

    private asset: UikaNativeAsset | null = null;
    private renderer: UikaRenderAdapter | null = null;

    constructor(private readonly container: HTMLElement) {}

    private async loadIntoFreshViewer(ply: Blob): Promise<number | null> {
        this.status.ready = false;
        this.renderer?.dispose();
        this.renderer = null;
        this.container.replaceChildren();

        this.renderer = new UikaRenderAdapter(this.container, this.status);
        await this.renderer.loadPly(ply);

        const renderedCount = this.renderer.getRenderedSplatCount();
        if (renderedCount !== null && renderedCount !== UIKA_NATIVE_V1_GAUSSIAN_COUNT) {
            throw new Error(`UIKA Native: Viewer splatCount=${renderedCount}, expected=${UIKA_NATIVE_V1_GAUSSIAN_COUNT}`);
        }
        this.renderer.start();
        return renderedCount;
    }

    async initializeNeutral(sourceUrl = '/avatar/uika-gakki-133k.zip'): Promise<void> {
        if (this.status.phase !== 'idle') throw new Error(`UIKA Native: invalid phase ${this.status.phase}`);
        try {
            this.status.phase = 'loading-asset';
            this.asset = await loadUikaNativeMigrationAsset(sourceUrl);
            this.status.gaussianCount = this.asset.gaussianCount;
            this.status.basisCount = this.asset.basis.names.length;

            if (this.status.gaussianCount !== UIKA_NATIVE_V1_GAUSSIAN_COUNT) {
                throw new Error(`UIKA Native: gaussianCount=${this.status.gaussianCount}`);
            }
            if (this.status.basisCount !== UIKA_NATIVE_V1_BASIS_COUNT) {
                throw new Error(`UIKA Native: basisCount=${this.status.basisCount}`);
            }

            const renderedCount = await this.loadIntoFreshViewer(this.asset.canonicalPly);
            console.log('[UIKA NATIVE V1] neutral READY', {
                gaussianCount: this.status.gaussianCount,
                viewerSplatCount: renderedCount,
                basisCount: this.status.basisCount,
                sourceSha256: this.asset.sourceSha256,
                canonicalBounds: this.asset.canonicalBounds,
                ignoredCompatibilityEntries: this.asset.ignoredCompatibilityEntries,
            });
        } catch (error: any) {
            const message = error?.message || String(error);
            this.status.errors.push(message);
            this.status.phase = 'error';
            this.status.ready = false;
            console.error('[UIKA NATIVE V1] Gate 1 failed:', error);
            throw error;
        }
    }

    /**
     * Gate 2 only: construct one deterministic deformation on CPU and reload it as PLY.
     * This intentionally proves geometry correctness before any real-time/GPU implementation.
     */
    async renderSingleBasis(name: string, weight = 1.0) {
        if (!this.asset) throw new Error('UIKA Native Gate 2: asset is not initialized');

        const weights = singleUikaBasisWeight(this.asset.basis.names, name, weight);
        const result = applyUikaBasisWeightsCpu(
            this.asset.canonicalPositions,
            this.asset.basis,
            weights,
        );

        const canonicalBytes = new Uint8Array(await this.asset.canonicalPly.arrayBuffer());
        const morphedBytes = rewritePlyPositions(canonicalBytes, result.positions);
        const renderedCount = await this.loadIntoFreshViewer(
            new Blob([morphedBytes], { type: 'application/octet-stream' }),
        );

        const report = {
            name,
            weight,
            viewerSplatCount: renderedCount,
            ...result.stats,
        };
        console.log('[UIKA NATIVE V1] Gate 2 single basis READY', report);
        return report;
    }

    async renderNeutralAgain() {
        if (!this.asset) throw new Error('UIKA Native Gate 2: asset is not initialized');
        const renderedCount = await this.loadIntoFreshViewer(this.asset.canonicalPly);
        const report = { name: 'neutral', weight: 0, viewerSplatCount: renderedCount };
        console.log('[UIKA NATIVE V1] Gate 2 neutral restored', report);
        return report;
    }

    getAssetDebugInfo() {
        if (!this.asset) return null;
        return {
            sourceUrl: this.asset.sourceUrl,
            sourceByteLength: this.asset.sourceByteLength,
            sourceSha256: this.asset.sourceSha256,
            gaussianCount: this.asset.gaussianCount,
            canonicalBounds: this.asset.canonicalBounds,
            basisCount: this.asset.basis.names.length,
            basisNames: [...this.asset.basis.names],
            ignoredCompatibilityEntries: [...this.asset.ignoredCompatibilityEntries],
        };
    }

    dispose(): void {
        this.renderer?.dispose();
        this.renderer = null;
        this.asset = null;
        this.status.ready = false;
        this.status.phase = 'idle';
    }
}
