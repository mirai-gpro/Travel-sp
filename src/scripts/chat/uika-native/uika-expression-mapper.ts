// UIKA Native Runtime Architecture Correction v1.0
// Pure A2E -> UIKA basis mapping. No audio clock, renderer, camera or skeleton code.

import type {
    UikaNativeExpressionInput,
    UikaNativeMappedExpression,
} from './uika-native-types';

const JP_SCALING: Readonly<Record<string, number>> = {
    mouthStretchLeft: 1.3,
    mouthStretchRight: 1.3,
    jawOpen: 0.85,
    mouthFunnel: 1.1,
    mouthPucker: 1.1,
};

function fail(message: string): never {
    throw new Error(`UIKA Native Expression: ${message}`);
}

/**
 * Applies exactly the active Japanese mouth-shape post-processing from the
 * e86f066 LAMWebSocketManager path. The disabled smoothing block is not added.
 */
export function buildProductionExpressionMap(input: UikaNativeExpressionInput): Record<string, number> {
    if (input.names.length !== input.values.length) {
        fail(`names=${input.names.length} values=${input.values.length}`);
    }
    if (new Set(input.names).size !== input.names.length) fail('input names contain duplicates');

    const result: Record<string, number> = {};
    for (let i = 0; i < input.names.length; i++) {
        const value = input.values[i];
        if (!Number.isFinite(value)) fail(`non-finite value for ${input.names[i]} at ${i}`);
        result[input.names[i]] = value;
    }

    // STEP1-B: static JP scaling.
    for (const [name, scale] of Object.entries(JP_SCALING)) {
        if (result[name] !== undefined) {
            result[name] = Math.min(1.0, result[name] * scale);
        }
    }

    // STEP1-A: suppress additional jaw opening for イ/エ-like stretched shapes.
    const stretchL = result.mouthStretchLeft ?? 0;
    const stretchR = result.mouthStretchRight ?? 0;
    const avgStretch = (stretchL + stretchR) / 2;
    if (avgStretch > 0.2) {
        if (result.jawOpen === undefined) fail('jawOpen is missing while stretch suppression is active');
        const suppressionFactor = 1.0 - avgStretch * 0.5;
        result.jawOpen *= Math.max(0.3, suppressionFactor);
    }

    // STEP2: preserve the existing anti-mumbling jawOpen floor.
    const jawOpen = result.jawOpen ?? 0;
    if (jawOpen >= 0.015 && jawOpen < 0.05) {
        result.jawOpen = 0.05;
    }

    return result;
}

export function mapA2eToUikaBasis(
    input: UikaNativeExpressionInput,
    basisNames: readonly string[],
): UikaNativeMappedExpression {
    if (new Set(basisNames).size !== basisNames.length) fail('basis names contain duplicates');

    const expression = buildProductionExpressionMap(input);
    const basisSet = new Set(basisNames);
    const droppedNames = input.names.filter((name) => !basisSet.has(name));
    const weights = new Float32Array(basisNames.length);

    for (let i = 0; i < basisNames.length; i++) {
        const name = basisNames[i];
        const value = expression[name] ?? 0;
        if (!Number.isFinite(value)) fail(`mapped non-finite value for ${name}`);
        weights[i] = value;
    }

    return { weights, droppedNames };
}
