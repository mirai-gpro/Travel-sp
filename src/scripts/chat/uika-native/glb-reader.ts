// UIKA Native Runtime Architecture Correction v1.0
// Strict reader for the verified 133K migration skin.glb.
// It reads data only; it does NOT instantiate glTF skin/skeleton/animation semantics.

import {
    UIKA_NATIVE_V1_BASIS_COUNT,
    UIKA_NATIVE_V1_GAUSSIAN_COUNT,
    type UikaNativeBasis,
} from './uika-native-types';

const GLB_MAGIC = 0x46546c67; // "glTF"
const JSON_CHUNK = 0x4e4f534a; // JSON
const BIN_CHUNK = 0x004e4942; // BIN\0
const FLOAT = 5126;

interface GltfAccessor {
    bufferView?: number;
    byteOffset?: number;
    componentType: number;
    count: number;
    type: string;
    sparse?: unknown;
}

interface GltfBufferView {
    buffer: number;
    byteOffset?: number;
    byteLength: number;
    byteStride?: number;
}

interface GltfPrimitive {
    attributes?: Record<string, number>;
    targets?: Array<Record<string, number>>;
    extras?: { targetNames?: string[] };
}

interface GltfMesh {
    primitives?: GltfPrimitive[];
    extras?: { targetNames?: string[] };
}

interface GltfJson {
    meshes?: GltfMesh[];
    accessors?: GltfAccessor[];
    bufferViews?: GltfBufferView[];
}

export interface ParsedUikaSkinGlb {
    gaussianCount: number;
    basePositions: Float32Array;
    basis: UikaNativeBasis;
}

function fail(message: string): never {
    throw new Error(`UIKA Native GLB: ${message}`);
}

function parseGlbChunks(bytes: Uint8Array): { json: GltfJson; binStart: number; binLength: number } {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.byteLength < 20) fail('file is too small');
    if (view.getUint32(0, true) !== GLB_MAGIC) fail('invalid magic');
    if (view.getUint32(4, true) !== 2) fail(`unsupported GLB version ${view.getUint32(4, true)}`);
    if (view.getUint32(8, true) !== view.byteLength) {
        fail(`declared length ${view.getUint32(8, true)} != actual ${view.byteLength}`);
    }

    let json: GltfJson | null = null;
    let binStart = -1;
    let binLength = 0;
    let off = 12;
    const decoder = new TextDecoder('utf-8', { fatal: true });

    while (off + 8 <= view.byteLength) {
        const chunkLength = view.getUint32(off, true);
        const chunkType = view.getUint32(off + 4, true);
        const payloadStart = off + 8;
        const payloadEnd = payloadStart + chunkLength;
        if (payloadEnd > view.byteLength) fail('chunk exceeds file length');

        if (chunkType === JSON_CHUNK) {
            if (json) fail('multiple JSON chunks');
            try {
                json = JSON.parse(decoder.decode(bytes.subarray(payloadStart, payloadEnd))) as GltfJson;
            } catch (error: any) {
                fail(`invalid JSON chunk: ${error?.message || String(error)}`);
            }
        } else if (chunkType === BIN_CHUNK) {
            if (binStart >= 0) fail('multiple BIN chunks are not supported');
            binStart = payloadStart;
            binLength = chunkLength;
        }
        off = payloadEnd;
    }

    if (!json) fail('JSON chunk not found');
    if (binStart < 0) fail('BIN chunk not found');
    return { json, binStart, binLength };
}

function readFloatVec3Accessor(
    bytes: Uint8Array,
    gltf: GltfJson,
    binStart: number,
    binLength: number,
    accessorIndex: number,
    label: string,
): Float32Array {
    const accessors = gltf.accessors ?? [];
    const bufferViews = gltf.bufferViews ?? [];
    const accessor = accessors[accessorIndex];
    if (!accessor) fail(`${label}: accessor ${accessorIndex} not found`);
    if (accessor.sparse) fail(`${label}: sparse accessor is not accepted by Native v1 migration reader`);
    if (accessor.componentType !== FLOAT) fail(`${label}: componentType=${accessor.componentType}, expected FLOAT`);
    if (accessor.type !== 'VEC3') fail(`${label}: type=${accessor.type}, expected VEC3`);
    if (accessor.bufferView === undefined) fail(`${label}: bufferView is missing`);

    const bufferView = bufferViews[accessor.bufferView];
    if (!bufferView) fail(`${label}: bufferView ${accessor.bufferView} not found`);
    if (bufferView.buffer !== 0) fail(`${label}: external/nonzero glTF buffer is not supported`);

    const stride = bufferView.byteStride ?? 12;
    if (stride < 12 || stride % 4 !== 0) fail(`${label}: unsupported byteStride ${stride}`);

    const accessorByteOffset = accessor.byteOffset ?? 0;
    const viewByteOffset = bufferView.byteOffset ?? 0;
    const dataOffsetInBin = viewByteOffset + accessorByteOffset;
    const requiredBytes = accessor.count === 0 ? 0 : (accessor.count - 1) * stride + 12;
    if (dataOffsetInBin < 0 || dataOffsetInBin + requiredBytes > binLength) {
        fail(`${label}: accessor data is outside BIN chunk`);
    }

    const absolute = bytes.byteOffset + binStart + dataOffsetInBin;
    if (stride === 12 && absolute % 4 === 0) {
        return new Float32Array(bytes.buffer, absolute, accessor.count * 3);
    }

    const out = new Float32Array(accessor.count * 3);
    const view = new DataView(bytes.buffer, bytes.byteOffset + binStart, binLength);
    for (let i = 0; i < accessor.count; i++) {
        const p = dataOffsetInBin + i * stride;
        out[i * 3] = view.getFloat32(p, true);
        out[i * 3 + 1] = view.getFloat32(p + 4, true);
        out[i * 3 + 2] = view.getFloat32(p + 8, true);
    }
    return out;
}

function findUikaPrimitive(gltf: GltfJson): { mesh: GltfMesh; primitive: GltfPrimitive } {
    const candidates: Array<{ mesh: GltfMesh; primitive: GltfPrimitive }> = [];
    for (const mesh of gltf.meshes ?? []) {
        for (const primitive of mesh.primitives ?? []) {
            const positionAccessorIndex = primitive.attributes?.POSITION;
            if (positionAccessorIndex === undefined) continue;
            const positionAccessor = gltf.accessors?.[positionAccessorIndex];
            if (!positionAccessor || positionAccessor.count !== UIKA_NATIVE_V1_GAUSSIAN_COUNT) continue;
            if ((primitive.targets?.length ?? 0) !== UIKA_NATIVE_V1_BASIS_COUNT) continue;
            candidates.push({ mesh, primitive });
        }
    }
    if (candidates.length !== 1) {
        fail(`expected one ${UIKA_NATIVE_V1_GAUSSIAN_COUNT}-point/${UIKA_NATIVE_V1_BASIS_COUNT}-morph primitive, found ${candidates.length}`);
    }
    return candidates[0];
}

export function parseUikaSkinGlb(bytes: Uint8Array): ParsedUikaSkinGlb {
    const { json: gltf, binStart, binLength } = parseGlbChunks(bytes);
    const { mesh, primitive } = findUikaPrimitive(gltf);

    const positionAccessor = primitive.attributes?.POSITION;
    if (positionAccessor === undefined) fail('POSITION accessor missing after candidate selection');
    const basePositions = readFloatVec3Accessor(bytes, gltf, binStart, binLength, positionAccessor, 'POSITION');

    const targetNames = mesh.extras?.targetNames ?? primitive.extras?.targetNames;
    if (!Array.isArray(targetNames)) fail('extras.targetNames is missing');
    if (targetNames.length !== UIKA_NATIVE_V1_BASIS_COUNT) {
        fail(`targetNames count=${targetNames.length}, expected ${UIKA_NATIVE_V1_BASIS_COUNT}`);
    }
    if (new Set(targetNames).size !== targetNames.length) fail('targetNames contains duplicates');

    const targets = primitive.targets ?? [];
    const deltas: Float32Array[] = targets.map((target, index) => {
        const accessorIndex = target.POSITION;
        if (accessorIndex === undefined) fail(`morph ${index} (${targetNames[index]}): POSITION missing`);
        const values = readFloatVec3Accessor(
            bytes,
            gltf,
            binStart,
            binLength,
            accessorIndex,
            `morph ${index} (${targetNames[index]})`,
        );
        if (values.length !== UIKA_NATIVE_V1_GAUSSIAN_COUNT * 3) {
            fail(`morph ${index} (${targetNames[index]}): length=${values.length}`);
        }
        return values;
    });

    return {
        gaussianCount: UIKA_NATIVE_V1_GAUSSIAN_COUNT,
        basePositions,
        basis: { names: [...targetNames], deltas },
    };
}
