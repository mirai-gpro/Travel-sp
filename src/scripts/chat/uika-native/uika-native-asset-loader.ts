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
    type UikaNativeBounds,
} from './uika-native-types';

// Verified source asset introduced by commit 993c35d1... and still present at baseline e86f066...
const EXPECTED_SOURCE_BYTES = 24_707_432;
const EXPECTED_SOURCE_SHA256 = 'efe206d7ce164f4cde52642bdd454aa1fbfba3d0ab2d36234ffb8a3c0cb6d421';

// Previously measured runtime neutral centers for the same cano_nose90 asset.
const EXPECTED_CANONICAL_BOUNDS: UikaNativeBounds = {
    min: [-0.20702186226844788, -0.17729105055332184, -0.20733742415905],
    max: [ 0.11540722101926804,  0.13352105021476746,  0.060738399624824524],
};
const BOUNDS_TOLERANCE = 2e-6;

function fail(message: string): never {
    throw new Error(`UIKA Native Asset: ${message}`);
}

function assertFiniteArray(values: Float32Array, label: string): void {
    for (let i = 0; i < values.length; i++) {
        if (!Number.isFinite(values[i])) fail(`${label}: non-finite value at ${i}`);
    }
}

function toHex(bytes: Uint8Array): string {
    return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
    if (!globalThis.crypto?.subtle) fail('Web Crypto SHA-256 is unavailable');
    const digest = await globalThis.crypto.subtle.digest('SHA-256', buffer);
    return toHex(new Uint8Array(digest));
}

function measureBounds(positions: Float32Array): UikaNativeBounds {
    if (positions.length === 0 || positions.length % 3 !== 0) {
        fail(`invalid position array length ${positions.length}`);
    }
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < positions.length; i += 3) {
        const x = positions[i];
        const y = positions[i + 1];
        const z = positions[i + 2];
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (z < minZ) minZ = z;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
        if (z > maxZ) maxZ = z;
    }
    return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}

function assertBounds(actual: UikaNativeBounds): void {
    for (const edge of ['min', 'max'] as const) {
        for (let axis = 0; axis < 3; axis++) {
            const got = actual[edge][axis];
            const expected = EXPECTED_CANONICAL_BOUNDS[edge][axis];
            const diff = Math.abs(got - expected);
            if (diff > BOUNDS_TOLERANCE) {
                fail(`canonical bbox ${edge}[${axis}] diff=${diff} got=${got} expected=${expected}`);
            }
        }
    }
}

export async function loadUikaNativeMigrationAsset(sourceUrl: string): Promise<UikaNativeAsset> {
    const response = await fetch(sourceUrl, { cache: 'force-cache' });
    if (!response.ok) fail(`fetch failed ${response.status} ${response.statusText}: ${sourceUrl}`);

    const archive = await response.arrayBuffer();
    if (archive.byteLength !== EXPECTED_SOURCE_BYTES) {
        fail(`source byteLength=${archive.byteLength}, expected=${EXPECTED_SOURCE_BYTES}`);
    }
    const sourceSha256 = await sha256Hex(archive);
    if (sourceSha256 !== EXPECTED_SOURCE_SHA256) {
        fail(`source SHA-256=${sourceSha256}, expected=${EXPECTED_SOURCE_SHA256}`);
    }

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
    const canonicalBounds = measureBounds(canonical.canonicalPositions);
    assertBounds(canonicalBounds);

    return {
        sourceUrl,
        sourceByteLength: archive.byteLength,
        sourceSha256,
        gaussianCount: UIKA_NATIVE_V1_GAUSSIAN_COUNT,
        canonicalPly: new Blob([canonical.bytes], { type: 'application/octet-stream' }),
        canonicalPositions: canonical.canonicalPositions,
        canonicalBounds,
        basis: skin.basis,
        ignoredCompatibilityEntries,
    };
}
