// UIKA Native Runtime Architecture Correction v1.0
// Shared types only. No runtime side effects.

export const UIKA_NATIVE_V1_GAUSSIAN_COUNT = 133_541;
export const UIKA_NATIVE_V1_BASIS_COUNT = 51;

export interface UikaNativeBasis {
    names: string[];
    /** One VEC3 displacement array per basis channel. Each length = gaussianCount * 3. */
    deltas: Float32Array[];
}

export interface UikaNativeAsset {
    sourceUrl: string;
    gaussianCount: number;
    canonicalPly: Blob;
    canonicalPositions: Float32Array;
    basis: UikaNativeBasis;
    ignoredCompatibilityEntries: string[];
}

export interface UikaNativeExpressionInput {
    names: string[];
    values: number[];
}

export interface UikaNativeMappedExpression {
    weights: Float32Array;
    droppedNames: string[];
}

export interface UikaNativeRuntimeStatus {
    ready: boolean;
    phase: 'idle' | 'loading-asset' | 'loading-renderer' | 'neutral-ready' | 'error';
    gaussianCount: number;
    basisCount: number;
    renderedFrames: number;
    lastFrameMs: number;
    glErrorCount: number;
    errors: string[];
}
