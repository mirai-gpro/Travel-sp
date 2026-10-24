// UIKA Native Runtime Architecture Correction v1.0
// Reconstruct canonical UIKA Gaussian positions from the verified migration equation:
// canonical_xyz = skin.glb POSITION + offset.ply xyz
// All non-xyz PLY bytes are preserved unchanged.

interface PlyVertexLayout {
    count: number;
    dataOffset: number;
    stride: number;
    xOffset: number;
    yOffset: number;
    zOffset: number;
}

export interface ReconstructedPly {
    bytes: Uint8Array;
    canonicalPositions: Float32Array;
}

function fail(message: string): never {
    throw new Error(`UIKA Native PLY: ${message}`);
}

const TYPE_SIZE: Record<string, number> = {
    char: 1,
    int8: 1,
    uchar: 1,
    uint8: 1,
    short: 2,
    int16: 2,
    ushort: 2,
    uint16: 2,
    int: 4,
    int32: 4,
    uint: 4,
    uint32: 4,
    float: 4,
    float32: 4,
    double: 8,
    float64: 8,
};

function findHeaderEnd(bytes: Uint8Array): number {
    const marker = new TextEncoder().encode('end_header\n');
    const markerCrLf = new TextEncoder().encode('end_header\r\n');
    const limit = Math.min(bytes.length, 1024 * 1024);

    const find = (needle: Uint8Array): number => {
        outer: for (let i = 0; i <= limit - needle.length; i++) {
            for (let j = 0; j < needle.length; j++) {
                if (bytes[i + j] !== needle[j]) continue outer;
            }
            return i + needle.length;
        }
        return -1;
    };

    const lf = find(marker);
    const crlf = find(markerCrLf);
    if (lf < 0 && crlf < 0) fail('end_header not found in first 1 MiB');
    if (lf < 0) return crlf;
    if (crlf < 0) return lf;
    return Math.min(lf, crlf);
}

function parseVertexLayout(bytes: Uint8Array): PlyVertexLayout {
    const dataOffset = findHeaderEnd(bytes);
    const header = new TextDecoder('ascii', { fatal: true })
        .decode(bytes.subarray(0, dataOffset))
        .replace(/\r\n/g, '\n');
    const lines = header.split('\n').map((line) => line.trim()).filter(Boolean);

    if (lines[0] !== 'ply') fail('missing ply magic');
    if (!lines.includes('format binary_little_endian 1.0')) {
        fail('only binary_little_endian 1.0 is accepted');
    }

    let inVertex = false;
    let vertexCount = -1;
    let stride = 0;
    let xOffset = -1;
    let yOffset = -1;
    let zOffset = -1;

    for (const line of lines) {
        const parts = line.split(/\s+/);
        if (parts[0] === 'element') {
            inVertex = parts[1] === 'vertex';
            if (inVertex) {
                vertexCount = Number(parts[2]);
                if (!Number.isSafeInteger(vertexCount) || vertexCount < 0) fail(`invalid vertex count: ${parts[2]}`);
                stride = 0;
            }
            continue;
        }
        if (!inVertex || parts[0] !== 'property') continue;
        if (parts[1] === 'list') fail('list property inside vertex element is not supported');
        if (parts.length !== 3) fail(`invalid vertex property: ${line}`);

        const type = parts[1];
        const name = parts[2];
        const size = TYPE_SIZE[type];
        if (!size) fail(`unsupported vertex property type: ${type}`);

        if (name === 'x') xOffset = stride;
        if (name === 'y') yOffset = stride;
        if (name === 'z') zOffset = stride;

        if ((name === 'x' || name === 'y' || name === 'z') && type !== 'float' && type !== 'float32') {
            fail(`${name} must be float32, got ${type}`);
        }
        stride += size;
    }

    if (vertexCount < 0) fail('vertex element not found');
    if (stride <= 0) fail('vertex stride is zero');
    if (xOffset < 0 || yOffset < 0 || zOffset < 0) fail('x/y/z properties are missing');
    if (dataOffset + vertexCount * stride > bytes.byteLength) {
        fail('vertex body exceeds PLY length');
    }

    return { count: vertexCount, dataOffset, stride, xOffset, yOffset, zOffset };
}

/**
 * Returns a byte-for-byte copy of the source PLY except for the x/y/z fields.
 * This is used by Gate 2 to render deterministic single-basis deformations while
 * keeping color/opacity/scale/rotation and every other property unchanged.
 */
export function rewritePlyPositions(sourcePly: Uint8Array, positions: Float32Array): Uint8Array {
    const layout = parseVertexLayout(sourcePly);
    if (positions.length !== layout.count * 3) {
        fail(`position length=${positions.length}, expected=${layout.count * 3}`);
    }

    const out = new Uint8Array(sourcePly);
    const outView = new DataView(out.buffer, out.byteOffset, out.byteLength);
    for (let i = 0; i < layout.count; i++) {
        const x = positions[i * 3];
        const y = positions[i * 3 + 1];
        const z = positions[i * 3 + 2];
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
            fail(`non-finite replacement position at vertex ${i}`);
        }
        const p = layout.dataOffset + i * layout.stride;
        outView.setFloat32(p + layout.xOffset, x, true);
        outView.setFloat32(p + layout.yOffset, y, true);
        outView.setFloat32(p + layout.zOffset, z, true);
    }
    return out;
}

export function reconstructCanonicalPly(offsetPly: Uint8Array, basePositions: Float32Array): ReconstructedPly {
    const layout = parseVertexLayout(offsetPly);
    if (basePositions.length !== layout.count * 3) {
        fail(`base position length=${basePositions.length}, expected=${layout.count * 3}`);
    }

    const inView = new DataView(offsetPly.buffer, offsetPly.byteOffset, offsetPly.byteLength);
    const canonicalPositions = new Float32Array(layout.count * 3);

    for (let i = 0; i < layout.count; i++) {
        const p = layout.dataOffset + i * layout.stride;
        const ox = inView.getFloat32(p + layout.xOffset, true);
        const oy = inView.getFloat32(p + layout.yOffset, true);
        const oz = inView.getFloat32(p + layout.zOffset, true);

        const x = basePositions[i * 3] + ox;
        const y = basePositions[i * 3 + 1] + oy;
        const z = basePositions[i * 3 + 2] + oz;

        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
            fail(`non-finite canonical position at vertex ${i}`);
        }

        canonicalPositions[i * 3] = x;
        canonicalPositions[i * 3 + 1] = y;
        canonicalPositions[i * 3 + 2] = z;
    }

    return {
        bytes: rewritePlyPositions(offsetPly, canonicalPositions),
        canonicalPositions,
    };
}
