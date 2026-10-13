// UIKA Native Runtime Architecture Correction v1.0 — Gate 2 reference validation

import type { UikaNativeBasis } from './uika-native-types';

const MAX_DISPLACEMENT_REFERENCE: Readonly<Record<string, number>> = {
    jawOpen: 0.050257,
    mouthSmileLeft: 0.006105,
    mouthSmileRight: 0.006103,
    eyeBlinkLeft: 0.010183,
    eyeBlinkRight: 0.008810,
    noseSneerLeft: 0.006122,
    noseSneerRight: 0.005884,
    browOuterUpLeft: 0.008139,
    browOuterUpRight: 0.008056,
};

const MAX_DISPLACEMENT_TOLERANCE = 1e-6;

export interface UikaBasisChannelStats {
    name: string;
    maxDisplacement: number;
    expectedMaxDisplacement?: number;
    maxDiff?: number;
    nonZeroCount: number;
    weightedCanonicalCentroidX: number | null;
}

export interface UikaBasisValidationResult {
    pass: boolean;
    channels: UikaBasisChannelStats[];
    pairSigns: Array<{
        left: string;
        right: string;
        leftX: number;
        rightX: number;
        pass: boolean;
    }>;
}

function fail(message: string): never {
    throw new Error(`UIKA Native Basis: ${message}`);
}

function channelStats(
    name: string,
    delta: Float32Array,
    canonicalPositions: Float32Array,
): UikaBasisChannelStats {
    if (delta.length !== canonicalPositions.length || delta.length % 3 !== 0) {
        fail(`${name}: delta length=${delta.length}, canonical=${canonicalPositions.length}`);
    }

    let maxDisplacement = 0;
    let nonZeroCount = 0;
    let weightedX = 0;
    let totalWeight = 0;

    for (let i = 0; i < delta.length; i += 3) {
        const dx = delta[i];
        const dy = delta[i + 1];
        const dz = delta[i + 2];
        const displacement = Math.hypot(dx, dy, dz);
        if (!Number.isFinite(displacement)) fail(`${name}: non-finite displacement at ${i / 3}`);
        if (displacement > maxDisplacement) maxDisplacement = displacement;
        if (displacement !== 0) {
            nonZeroCount++;
            weightedX += canonicalPositions[i] * displacement;
            totalWeight += displacement;
        }
    }

    const expected = MAX_DISPLACEMENT_REFERENCE[name];
    return {
        name,
        maxDisplacement,
        expectedMaxDisplacement: expected,
        maxDiff: expected === undefined ? undefined : Math.abs(maxDisplacement - expected),
        nonZeroCount,
        weightedCanonicalCentroidX: totalWeight > 0 ? weightedX / totalWeight : null,
    };
}

export function validateUikaBasis(
    basis: UikaNativeBasis,
    canonicalPositions: Float32Array,
): UikaBasisValidationResult {
    if (basis.names.length !== basis.deltas.length) {
        fail(`names=${basis.names.length}, deltas=${basis.deltas.length}`);
    }

    const channels = basis.names.map((name, index) => channelStats(name, basis.deltas[index], canonicalPositions));
    const byName = new Map(channels.map((stats) => [stats.name, stats]));

    for (const [name, expected] of Object.entries(MAX_DISPLACEMENT_REFERENCE)) {
        const stats = byName.get(name);
        if (!stats) fail(`required reference channel is missing: ${name}`);
        const diff = Math.abs(stats.maxDisplacement - expected);
        if (diff > MAX_DISPLACEMENT_TOLERANCE) {
            fail(`${name}: max displacement=${stats.maxDisplacement}, expected=${expected}, diff=${diff}`);
        }
    }

    const pairs: Array<[string, string]> = [
        ['mouthSmileLeft', 'mouthSmileRight'],
        ['eyeBlinkLeft', 'eyeBlinkRight'],
        ['noseSneerLeft', 'noseSneerRight'],
        ['browOuterUpLeft', 'browOuterUpRight'],
    ];

    const pairSigns = pairs.map(([left, right]) => {
        const leftStats = byName.get(left);
        const rightStats = byName.get(right);
        if (!leftStats || !rightStats) fail(`pair missing: ${left}/${right}`);
        const leftX = leftStats.weightedCanonicalCentroidX;
        const rightX = rightStats.weightedCanonicalCentroidX;
        if (leftX === null || rightX === null) fail(`pair has zero deformation: ${left}/${right}`);
        const pass = leftX > 0 && rightX < 0;
        if (!pass) fail(`pair side check failed: ${left} x=${leftX}, ${right} x=${rightX}`);
        return { left, right, leftX, rightX, pass };
    });

    return { pass: true, channels, pairSigns };
}
