// UIKA Native Runtime Architecture Correction v1.0
// CPU reference deformation for Gate 2 correctness only.
// This is NOT the Gate 3 real-time implementation.

import type { UikaNativeBasis } from './uika-native-types';

function fail(message: string): never {
    throw new Error(`UIKA Native Deformation: ${message}`);
}

export interface UikaDeformationStats {
    maxDisplacement: number;
    meanDisplacement: number;
    nonZeroCount: number;
}

export function applyUikaBasisWeightsCpu(
    canonicalPositions: Float32Array,
    basis: UikaNativeBasis,
    weights: Float32Array,
): { positions: Float32Array; stats: UikaDeformationStats } {
    if (basis.names.length !== basis.deltas.length) fail('basis name/delta count mismatch');
    if (weights.length !== basis.names.length) fail(`weight count=${weights.length}, basis=${basis.names.length}`);
    if (canonicalPositions.length % 3 !== 0) fail('canonical position length is not VEC3-aligned');

    const out = new Float32Array(canonicalPositions);
    const pointCount = canonicalPositions.length / 3;
    let maxDisplacement = 0;
    let displacementSum = 0;
    let nonZeroCount = 0;

    for (let point = 0; point < pointCount; point++) {
        const p = point * 3;
        let dx = 0;
        let dy = 0;
        let dz = 0;

        for (let channel = 0; channel < weights.length; channel++) {
            const weight = weights[channel];
            if (weight === 0) continue;
            if (!Number.isFinite(weight)) fail(`non-finite weight at ${channel}`);
            const delta = basis.deltas[channel];
            if (delta.length !== canonicalPositions.length) {
                fail(`${basis.names[channel]} delta length=${delta.length}, expected=${canonicalPositions.length}`);
            }
            dx += weight * delta[p];
            dy += weight * delta[p + 1];
            dz += weight * delta[p + 2];
        }

        const displacement = Math.hypot(dx, dy, dz);
        if (!Number.isFinite(displacement)) fail(`non-finite displacement at point ${point}`);
        if (displacement !== 0) nonZeroCount++;
        if (displacement > maxDisplacement) maxDisplacement = displacement;
        displacementSum += displacement;

        const x = canonicalPositions[p] + dx;
        const y = canonicalPositions[p + 1] + dy;
        const z = canonicalPositions[p + 2] + dz;
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
            fail(`non-finite output at point ${point}`);
        }
        out[p] = x;
        out[p + 1] = y;
        out[p + 2] = z;
    }

    return {
        positions: out,
        stats: {
            maxDisplacement,
            meanDisplacement: displacementSum / pointCount,
            nonZeroCount,
        },
    };
}

export function singleUikaBasisWeight(
    basisNames: readonly string[],
    name: string,
    weight = 1.0,
): Float32Array {
    if (!Number.isFinite(weight)) fail(`non-finite weight for ${name}`);
    const index = basisNames.indexOf(name);
    if (index < 0) fail(`basis channel not found: ${name}`);
    const weights = new Float32Array(basisNames.length);
    weights[index] = weight;
    return weights;
}
