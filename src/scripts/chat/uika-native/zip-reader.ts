// UIKA Native Runtime Architecture Correction v1.0
// Minimal ZIP reader for the migration source asset.
// Supports only the features used by the verified Travel-sp avatar ZIP:
// - single-disk ZIP
// - stored (0) or deflate (8)
// - no encryption
// - no Zip64

export interface ZipDirectoryEntry {
    name: string;
    compressionMethod: number;
    flags: number;
    compressedSize: number;
    uncompressedSize: number;
    localHeaderOffset: number;
}

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

function fail(message: string): never {
    throw new Error(`UIKA Native ZIP: ${message}`);
}

function findEocd(view: DataView): number {
    // EOCD can be followed by at most a 65535-byte comment.
    const min = Math.max(0, view.byteLength - (22 + 0xffff));
    for (let off = view.byteLength - 22; off >= min; off--) {
        if (view.getUint32(off, true) === EOCD_SIG) return off;
    }
    return fail('EOCD not found');
}

export function listZipEntries(buffer: ArrayBuffer): ZipDirectoryEntry[] {
    const view = new DataView(buffer);
    const eocd = findEocd(view);

    const diskNo = view.getUint16(eocd + 4, true);
    const centralDiskNo = view.getUint16(eocd + 6, true);
    const diskEntries = view.getUint16(eocd + 8, true);
    const totalEntries = view.getUint16(eocd + 10, true);
    const centralSize = view.getUint32(eocd + 12, true);
    const centralOffset = view.getUint32(eocd + 16, true);

    if (diskNo !== 0 || centralDiskNo !== 0 || diskEntries !== totalEntries) {
        fail('multi-disk ZIP is not supported');
    }
    if (totalEntries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
        fail('Zip64 is not supported');
    }
    if (centralOffset + centralSize > view.byteLength) {
        fail('central directory is outside the archive');
    }

    const decoder = new TextDecoder('utf-8', { fatal: true });
    const bytes = new Uint8Array(buffer);
    const entries: ZipDirectoryEntry[] = [];
    let off = centralOffset;

    for (let i = 0; i < totalEntries; i++) {
        if (off + 46 > view.byteLength || view.getUint32(off, true) !== CENTRAL_SIG) {
            fail(`invalid central directory header at entry ${i}`);
        }

        const flags = view.getUint16(off + 8, true);
        const compressionMethod = view.getUint16(off + 10, true);
        const compressedSize = view.getUint32(off + 20, true);
        const uncompressedSize = view.getUint32(off + 24, true);
        const fileNameLength = view.getUint16(off + 28, true);
        const extraLength = view.getUint16(off + 30, true);
        const commentLength = view.getUint16(off + 32, true);
        const diskStart = view.getUint16(off + 34, true);
        const localHeaderOffset = view.getUint32(off + 42, true);

        if (flags & 0x0001) fail(`encrypted entry is not supported (entry ${i})`);
        if (diskStart !== 0) fail(`multi-disk entry is not supported (entry ${i})`);
        if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
            fail(`Zip64 entry is not supported (entry ${i})`);
        }
        if (compressionMethod !== 0 && compressionMethod !== 8) {
            fail(`unsupported compression method ${compressionMethod} (entry ${i})`);
        }

        const nameStart = off + 46;
        const nameEnd = nameStart + fileNameLength;
        if (nameEnd > view.byteLength) fail(`filename exceeds archive (entry ${i})`);

        let name: string;
        try {
            name = decoder.decode(bytes.subarray(nameStart, nameEnd));
        } catch {
            fail(`filename is not valid UTF-8 (entry ${i})`);
        }

        entries.push({
            name,
            compressionMethod,
            flags,
            compressedSize,
            uncompressedSize,
            localHeaderOffset,
        });

        off = nameEnd + extraLength + commentLength;
    }

    if (off !== centralOffset + centralSize) {
        // Some writers can pad, but the verified asset does not need that ambiguity.
        fail(`central directory size mismatch: parsed=${off - centralOffset}, declared=${centralSize}`);
    }

    return entries;
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
    if (typeof DecompressionStream === 'undefined') {
        fail('DecompressionStream is unavailable in this browser');
    }
    const stream = new Blob([data]).stream().pipeThrough(
        new DecompressionStream('deflate-raw' as CompressionFormat)
    );
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function extractZipEntry(buffer: ArrayBuffer, entry: ZipDirectoryEntry): Promise<Uint8Array> {
    const view = new DataView(buffer);
    const bytes = new Uint8Array(buffer);
    const off = entry.localHeaderOffset;

    if (off + 30 > view.byteLength || view.getUint32(off, true) !== LOCAL_SIG) {
        fail(`invalid local header for ${entry.name}`);
    }

    const localFlags = view.getUint16(off + 6, true);
    const localMethod = view.getUint16(off + 8, true);
    const fileNameLength = view.getUint16(off + 26, true);
    const extraLength = view.getUint16(off + 28, true);

    if ((localFlags & 0x0001) !== 0) fail(`encrypted local entry: ${entry.name}`);
    if (localMethod !== entry.compressionMethod) fail(`compression method mismatch: ${entry.name}`);

    const dataStart = off + 30 + fileNameLength + extraLength;
    const dataEnd = dataStart + entry.compressedSize;
    if (dataEnd > view.byteLength) fail(`compressed data exceeds archive: ${entry.name}`);

    const compressed = bytes.subarray(dataStart, dataEnd);
    const out = entry.compressionMethod === 0 ? new Uint8Array(compressed) : await inflateRaw(compressed);

    if (out.byteLength !== entry.uncompressedSize) {
        fail(`size mismatch for ${entry.name}: got=${out.byteLength}, expected=${entry.uncompressedSize}`);
    }
    return out;
}

export function findUniqueEntryBySuffix(entries: ZipDirectoryEntry[], suffix: string): ZipDirectoryEntry {
    const normalized = suffix.startsWith('/') ? suffix : `/${suffix}`;
    const matches = entries.filter((entry) => entry.name === suffix || entry.name.endsWith(normalized));
    if (matches.length !== 1) {
        fail(`expected exactly one ${suffix}, found ${matches.length}`);
    }
    return matches[0];
}
