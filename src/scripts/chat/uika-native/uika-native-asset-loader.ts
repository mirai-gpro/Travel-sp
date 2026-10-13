// UIKA Native Runtime Architecture Correction v1.0
// Migration loader: reads the existing verified 133K compatibility ZIP as DATA ONLY.
// It never instantiates skin/skeleton/animation semantics.

import { parseUikaSkinGlb } from './glb-reader';
import { reconstructCanonicalPly } from './ply-reconstruct';
import {
    extractZipEntry,
    findUniqueEntryBySuffix,
    listZipEntries,
} from './zip-reader';
import {
    UIKA_NATIVE_V1_BASIS_COUNT,
    UIKA_NATIVE_V1_GAUSSIAN_COUNT,
    type UikaNativeAsset,
} from './uika-native-types';

function fail(message: string): never {
    throw new Error(`UIKA Native Asset: ${message}`);
}

function assertFiniteArray(values: Float32Array, label: string): void {
    for (let i = 0; i < values.length; i++) {
        if (!Number.isFinite(values[i])) fail(`${label}: non-finite value at ${i}`);
    }
}

export async function loadUikaNativeMigrationAsset(sourceUrl: string): Promise<UikaNativeAsset> {
    const response = await fetch(sourceUrl, { cache: 'force-cache' });
    if (!response.ok) fail(`fetch failed ${response.status} ${response.statusText}: ${sourceUrl}`);

    const archive = await response.arrayBuffer();
    const entries = listZipEntries(archive);
    const skinEntry = findUniqueEntryBySuffix(entries, 'skin.glb');
    const offsetEntry = findUniqueEntryBySuffix(entries, 'offset.ply');

    // The files below may exist in the migration container but are intentionally not read.
    const ignoredCompatibilityEntries = entries
        .map((entry) => entry.name)
        .filter((name) =>
            name.endsWith('/animation.glb') || name === 'animation.glb'
            || name.endsWith('/vertex_order.json') || name === 'vertex_order.json'
        );

    const [skinGlb, offsetPly] = await Promise.all([
        extractZipEntry(archive, skinEntry),
        extractZipEntry(archive, offsetEntry),
    ]);

    const skin = parseUikaSkinGlb(skinGlb);
    if (skin.gaussianCount !== UIKA_NATIVE_V1_GAUSSIAN_COUNT) {
        fail(`gaussianCount=${skin.gaussianCount}, expected=${UIKA_NATIVE_V1_GAUSSIAN_COUNT}`);
    }
    if (skin.basis.names.length !== UIKA_NATIVE_V1_BASIS_COUNT) {
        fail(`basis count=${skin.basis.names.length}, expected=${UIKA_NATIVE_V1_BASIS_COUNT}`);
    }

    assertFiniteArray(skin.basePositions, 'basePositions');
    for (let i = 0; i < skin.basis.deltas.length; i++) {
        assertFiniteArray(skin.basis.deltas[i], `basis ${i} (${skin.basis.names[i]})`);
    }

    const canonical = reconstructCanonicalPly(offsetPly, skin.basePositions);
    if (canonical.canonicalPositions.length !== UIKA_NATIVE_V1_GAUSSIAN_COUNT * 3) {
        fail(`canonical position count mismatch`);
    }

    return {
        sourceUrl,
        gaussianCount: UIKA_NATIVE_V1_GAUSSIAN_COUNT,
        canonicalPly: new Blob([canonical.bytes], { type: 'application/octet-stream' }),
        canonicalPositions: canonical.canonicalPositions,
        basis: skin.basis,
        ignoredCompatibilityEntries,
    };
}
