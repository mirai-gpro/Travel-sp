// UIKA Native Runtime Architecture Correction v1.0
// Direct Gaussian Viewer adapter. No LAM OAC loader, skeleton, animation or bind-space.

import { SceneFormat, Viewer } from 'gaussian-splat-renderer-for-lam';
import type { UikaNativeRuntimeStatus } from './uika-native-types';

const UIKA_META = {
    radius: 0.7826237921249264,
    lookAt: [0, 0, 0] as const,
    up: [0, 1, 0] as const,
    fy: 2590.80322265625,
    renderHeight: 1024,
    near: 0.01,
    far: 100.0,
};

function verticalFovDegrees(): number {
    return 2 * Math.atan(UIKA_META.renderHeight / (2 * UIKA_META.fy)) * 180 / Math.PI;
}

export class UikaRenderAdapter {
    private viewer: any = null;
    private objectUrl: string | null = null;
    private rafId: number | null = null;
    private running = false;

    constructor(
        private readonly container: HTMLElement,
        private readonly status: UikaNativeRuntimeStatus,
    ) {}

    async loadNeutralPly(ply: Blob): Promise<void> {
        if (this.viewer) throw new Error('UIKA Native Renderer: already initialized');

        this.status.phase = 'loading-renderer';
        this.objectUrl = URL.createObjectURL(ply);

        // Public Viewer boundary verified by Gate 0 compile probe.
        // selfDrivenMode=false keeps the update/render clock owned by UikaNativeDriver.
        this.viewer = new (Viewer as any)({
            rootElement: this.container,
            cameraUp: [...UIKA_META.up],
            initialCameraPosition: [0, 0, UIKA_META.radius],
            initialCameraLookAt: [...UIKA_META.lookAt],
            useBuiltInControls: false,
            selfDrivenMode: false,
            sharedMemoryForWorkers: false,
            dynamicScene: true,
            sphericalHarmonicsDegree: 0,
        });

        await this.viewer.addSplatScene(this.objectUrl, {
            format: (SceneFormat as any).Ply,
            showLoadingUI: false,
            progressiveLoad: false,
            splatAlphaRemovalThreshold: 1,
            position: [0, 0, 0],
            rotation: [0, 0, 0, 1],
            scale: [1, 1, 1],
        });

        this.applyUikaCamera();
        this.renderOnce();
        this.status.phase = 'neutral-ready';
        this.status.ready = true;
    }

    private applyUikaCamera(): void {
        const camera = this.viewer?.camera;
        if (!camera) throw new Error('UIKA Native Renderer: Viewer camera is unavailable');

        camera.near = UIKA_META.near;
        camera.far = UIKA_META.far;
        if ('fov' in camera) camera.fov = verticalFovDegrees();
        camera.up?.set?.(...UIKA_META.up);
        camera.position?.set?.(0, 0, UIKA_META.radius);
        camera.lookAt?.(...UIKA_META.lookAt);
        camera.updateProjectionMatrix?.();
        camera.updateMatrixWorld?.(true);
    }

    renderOnce(): void {
        const start = performance.now();
        this.viewer?.update?.();
        this.viewer?.render?.();
        this.status.lastFrameMs = performance.now() - start;
        this.status.renderedFrames++;

        const renderer = this.viewer?.renderer;
        const gl = renderer?.getContext?.();
        if (gl) {
            const err = gl.getError();
            if (err !== gl.NO_ERROR) this.status.glErrorCount++;
        }
    }

    start(): void {
        if (this.running) return;
        this.running = true;
        const tick = () => {
            if (!this.running) return;
            this.renderOnce();
            this.rafId = requestAnimationFrame(tick);
        };
        this.rafId = requestAnimationFrame(tick);
    }

    getRenderedSplatCount(): number | null {
        const mesh = this.viewer?.splatMesh;
        if (!mesh) return null;
        if (typeof mesh.getSplatCount === 'function') return mesh.getSplatCount();
        if (typeof mesh.getMaxSplatCount === 'function') return mesh.getMaxSplatCount();
        return null;
    }

    stop(): void {
        this.running = false;
        if (this.rafId !== null) cancelAnimationFrame(this.rafId);
        this.rafId = null;
    }

    dispose(): void {
        this.stop();
        try { this.viewer?.dispose?.(); } catch { /* diagnostic cleanup only */ }
        this.viewer = null;
        if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
        this.objectUrl = null;
    }
}
