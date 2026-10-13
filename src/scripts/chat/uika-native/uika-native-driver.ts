// UIKA Native Runtime Architecture Correction v1.0
// Gate 1 driver: neutral canonical UIKA render only.
// No A2E, no Live, no skeleton, no LAM animation.

import { loadUikaNativeMigrationAsset } from './uika-native-asset-loader';
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

            this.renderer = new UikaRenderAdapter(this.container, this.status);
            await this.renderer.loadNeutralPly(this.asset.canonicalPly);

            const renderedCount = this.renderer.getRenderedSplatCount();
            if (renderedCount !== null && renderedCount !== UIKA_NATIVE_V1_GAUSSIAN_COUNT) {
                throw new Error(`UIKA Native: Viewer splatCount=${renderedCount}, expected=${UIKA_NATIVE_V1_GAUSSIAN_COUNT}`);
            }

            this.renderer.start();
            console.log('[UIKA NATIVE V1] neutral READY', {
                gaussianCount: this.status.gaussianCount,
                viewerSplatCount: renderedCount,
                basisCount: this.status.basisCount,
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

    getAssetDebugInfo() {
        if (!this.asset) return null;
        return {
            sourceUrl: this.asset.sourceUrl,
            gaussianCount: this.asset.gaussianCount,
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
