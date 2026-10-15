// UIKA Native Runtime v1.1 — LAM reference sort host (PoC only)
//
// Drives the vendored LAM-lineage sort worker (`renderer/vendor/worker/SortWorker.js`,
// byte-identical to gaussian-splat-renderer-for-lam@0.0.9-alpha.1 except for its import
// lines) the way the LAM reference runtime's Viewer.js drives it:
//
//   canonical centre array -> sort worker -> WebAssembly depth sort -> sorted indexes
//   -> SplatMesh.updateRenderIndexes
//
// What this host deliberately does NOT do:
//   * no GPU distance transform-feedback pass, no fenceSync, no clientWaitSync and no
//     getBufferSubData. `usePrecomputedDistances` is false, so the WebAssembly module
//     computes the depth keys itself from the uploaded centres and the model-view-
//     projection matrix. That is the upstream default path.
//   * no cadence of its own. The only back-pressure is LAM's: one sort in flight at a
//     time, a request that arrives while one is running is dropped (§5).
//   * no sort algorithm, bucket count, memory layout or message field of its own. Every
//     message this file posts is a message shape taken from Viewer.js.
//
// The centres uploaded here are the CANONICAL UIKA centres, not the animated ones. This
// is intentional (§4): only the draw path uses `canonical + D_UIKA x weights`.

import { createSortWorker } from '../renderer/vendor/worker/SortWorker.js';

/**
 * The LAM reference runtime's own option values, read off its Viewer.js:
 *
 *   integerBasedSort              true    (Viewer.js default; render.ts does not override)
 *   sharedMemoryForWorkers        false   (hard-coded `false` in the LAM fork's Viewer.js)
 *   enableSIMDInSort              true    (Viewer.js default)
 *   splatSortDistanceMapPrecision 16      (Constants.DefaultSplatSortDistanceMapPrecision)
 *   dynamicMode                   false   (SplatMesh built with dynamicMode false)
 *   gpuAcceleratedSort            true    (render.ts) -- NOT used here, see above
 *
 * `integerBasedSort` is the one value this PoC does not take from LAM. In LAM the single
 * `integerBasedSort` flag is passed BOTH to createSortWorker and to the SplatMesh
 * constructor as `integerBasedDistancesComputation` (Viewer.js:367-368), so the centre
 * array that is uploaded and the way the WebAssembly module reads it always agree. UIKA's
 * SplatMesh is constructed with `integerBasedDistancesComputation = false`, and §1 keeps
 * that untouched, so this host uploads float centres and tells the worker to read float
 * centres. Mismatching the two would feed float bit patterns to an Int32Array read.
 */
/** WebAssembly.compile + instantiate of a ~2.2 KB module; a miss here means it never ran. */
const WORKER_SETUP_TIMEOUT_MS = 30000;

export const LAM_SORT_DEFAULTS = {
    integerBasedSort: false,
    useSharedMemory: false,
    enableSIMDInSort: true,
    splatSortDistanceMapPrecision: 16,
    dynamicMode: false,
    usePrecomputedDistances: false,
} as const;

export interface UikaLamSortOptions {
    /** false uploads Float32 centres (UIKA's SplatMesh setting). true uploads Int32x1000. */
    integerBasedSort: boolean;
    enableSIMDInSort: boolean;
    /** Counting-sort depth-map precision; the range is 1 << precision buckets. */
    splatSortDistanceMapPrecision: number;
}

/** §6: everything the PoC has to be able to state about the worker sort. */
export interface UikaLamSortStats {
    sortRequested: number;
    sortSubmitted: number;
    sortCompleted: number;
    sortSkippedWhileRunning: number;
    /** Submissions that could not be made because setup had not finished. */
    sortSkippedBeforeReady: number;
    /** `sortTime` as the worker itself measured it, per completed sort. */
    workerSortMsSamples: number[];
    /** updateRenderIndexes wall time on the main thread, per completed sort. */
    indexUpdateMsSamples: number[];
    /** postMessage wall time on the main thread, per submitted sort. */
    submitMsSamples: number[];
    /** submit -> sortDone handled, per completed sort. */
    roundTripMsSamples: number[];
    workerErrors: number;
}

export interface UikaLamSortCentreInfo {
    splatCount: number;
    centreArrayType: 'Float32Array' | 'Int32Array';
    centreBytes: number;
    /** The canonical centre AABB actually uploaded, so the quantisation is inspectable. */
    min: [number, number, number];
    max: [number, number, number];
    /** Only set for the integer path: the AABB after Math.round(x * 1000). */
    integerMin: [number, number, number] | null;
    integerMax: [number, number, number] | null;
}

/**
 * §8 support: which end of the emitted order is farther from the camera, measured rather
 * than assumed. The host recomputes the canonical depth key on the CPU for the first and
 * last emitted index of one completed sort and reports both.
 */
export interface UikaLamSortOrderProbe {
    firstEmittedIndex: number;
    lastEmittedIndex: number;
    firstEmittedDepth: number;
    lastEmittedDepth: number;
    /** true when the first index drawn is the farther one, i.e. back-to-front. */
    farthestFirst: boolean;
}

function emptyStats(): UikaLamSortStats {
    return {
        sortRequested: 0,
        sortSubmitted: 0,
        sortCompleted: 0,
        sortSkippedWhileRunning: 0,
        sortSkippedBeforeReady: 0,
        workerSortMsSamples: [],
        indexUpdateMsSamples: [],
        submitMsSamples: [],
        roundTripMsSamples: [],
        workerErrors: 0,
    };
}

export class UikaLamSortHost {
    private worker: Worker | null = null;
    private splatMesh: any = null;
    private splatCount = 0;
    private ready = false;
    private disposed = false;

    private indexesToSort: Uint32Array | null = null;
    private transforms: Float32Array | null = null;
    private sortedIndexes: Uint32Array | null = null;

    /** LAM's `sortRunning`: exactly one sort may be in flight. */
    private running = false;
    private resolveRunning: (() => void) | null = null;
    private rejectRunning: ((error: any) => void) | null = null;
    private submittedAt = 0;

    private stats = emptyStats();
    private centreInfo: UikaLamSortCentreInfo | null = null;
    private orderProbe: UikaLamSortOrderProbe | null = null;
    private probeMvp: Float32Array | null = null;
    private centresForProbe: Float32Array | null = null;
    private options: UikaLamSortOptions = { ...LAM_SORT_DEFAULTS };

    getStats(): UikaLamSortStats {
        return {
            ...this.stats,
            workerSortMsSamples: this.stats.workerSortMsSamples.slice(),
            indexUpdateMsSamples: this.stats.indexUpdateMsSamples.slice(),
            submitMsSamples: this.stats.submitMsSamples.slice(),
            roundTripMsSamples: this.stats.roundTripMsSamples.slice(),
        };
    }

    resetStats(): void {
        this.stats = emptyStats();
    }

    getCentreInfo(): UikaLamSortCentreInfo | null { return this.centreInfo; }
    getOrderProbe(): UikaLamSortOrderProbe | null { return this.orderProbe; }
    getOptions(): UikaLamSortOptions { return { ...this.options }; }
    isReady(): boolean { return this.ready; }
    isRunning(): boolean { return this.running; }

    /**
     * Create the worker, wait for its WebAssembly setup, then upload the canonical centres
     * once — the same two steps Viewer.js performs in setupSortWorker() plus the
     * `preSortMessages` centre upload it queues when gpuAcceleratedSort is off.
     */
    async init(splatMesh: any, options: Partial<UikaLamSortOptions> = {}): Promise<void> {
        if (this.worker) throw new Error('UIKA LAM sort host: already initialised');
        this.options = {
            integerBasedSort: options.integerBasedSort ?? LAM_SORT_DEFAULTS.integerBasedSort,
            enableSIMDInSort: options.enableSIMDInSort ?? LAM_SORT_DEFAULTS.enableSIMDInSort,
            splatSortDistanceMapPrecision:
                options.splatSortDistanceMapPrecision ?? LAM_SORT_DEFAULTS.splatSortDistanceMapPrecision,
        };
        this.splatMesh = splatMesh;
        this.splatCount = splatMesh.getSplatCount();
        if (!(this.splatCount > 0)) throw new Error(`UIKA LAM sort host: splatCount=${this.splatCount}`);

        this.indexesToSort = new Uint32Array(this.splatCount);
        for (let i = 0; i < this.splatCount; i++) this.indexesToSort[i] = i;
        // dynamicMode is false, so Viewer.js never fills this; the worker still reads its
        // byteLength, so it has to exist. MaxScenes * 16 floats is the LAM allocation.
        this.transforms = new Float32Array(32 * 16);

        const setup = new Promise<void>((resolve, reject) => {
            const worker = createSortWorker(
                this.splatCount,
                LAM_SORT_DEFAULTS.useSharedMemory,
                this.options.enableSIMDInSort,
                this.options.integerBasedSort,
                LAM_SORT_DEFAULTS.dynamicMode,
                this.options.splatSortDistanceMapPrecision,
            ) as Worker;
            this.worker = worker;
            worker.onerror = (event: any) => {
                this.stats.workerErrors++;
                const error = new Error(`UIKA LAM sort worker error: ${event?.message ?? 'unknown'}`);
                if (!this.ready) reject(error);
                this.failRunning(error);
            };
            worker.onmessage = (e: any) => {
                if (e.data.sortSetupPhase1Complete) {
                    this.ready = true;
                    resolve();
                } else if (e.data.sortDone) {
                    this.onSortDone(e.data);
                } else if (e.data.sortCanceled) {
                    this.running = false;
                    this.resolveRunning?.();
                    this.resolveRunning = null;
                    this.rejectRunning = null;
                }
            };
        });
        let setupTimer = 0;
        try {
            await Promise.race([
                setup,
                new Promise<void>((_, reject) => {
                    setupTimer = window.setTimeout(
                        () => reject(new Error('UIKA LAM sort host: the worker did not finish '
                            + `WebAssembly setup within ${WORKER_SETUP_TIMEOUT_MS} ms`)),
                        WORKER_SETUP_TIMEOUT_MS);
                }),
            ]);
        } finally {
            window.clearTimeout(setupTimer);
        }
        if (this.disposed) return;
        this.uploadCanonicalCentres();
    }

    /**
     * §4. The centres the worker sorts by are the canonical UIKA centres straight out of
     * the splat buffer — SplatMesh.getFloatCenters / getIntegerCenters, the same calls
     * Viewer.js's centre upload is built from. No basis, no weights, no animated centre.
     */
    private uploadCanonicalCentres(): void {
        const mesh = this.splatMesh;
        const last = this.splatCount - 1;
        const centres = this.options.integerBasedSort
            ? (mesh.getIntegerCenters(0, last, true) as Int32Array)
            : (mesh.getFloatCenters(0, last, true) as Float32Array);
        const sceneIndexes = mesh.getSceneIndexes(0, last) as Uint32Array;

        // Recorded, not assumed: the extent of what was uploaded, and for the integer path
        // what Math.round(x * 1000) did to it.
        const floats = this.options.integerBasedSort
            ? (mesh.getFloatCenters(0, last, true) as Float32Array)
            : centres as Float32Array;
        const min: [number, number, number] = [Infinity, Infinity, Infinity];
        const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i < this.splatCount; i++) {
            for (let c = 0; c < 3; c++) {
                const v = floats[i * 4 + c];
                if (v < min[c]) min[c] = v;
                if (v > max[c]) max[c] = v;
            }
        }
        let integerMin: [number, number, number] | null = null;
        let integerMax: [number, number, number] | null = null;
        if (this.options.integerBasedSort) {
            integerMin = [Infinity, Infinity, Infinity];
            integerMax = [-Infinity, -Infinity, -Infinity];
            const ints = centres as Int32Array;
            for (let i = 0; i < this.splatCount; i++) {
                for (let c = 0; c < 3; c++) {
                    const v = ints[i * 4 + c];
                    if (v < integerMin[c]) integerMin[c] = v;
                    if (v > integerMax[c]) integerMax[c] = v;
                }
            }
        }
        // Kept for the order probe only; the sort itself reads the worker's own copy.
        this.centresForProbe = floats;

        this.centreInfo = {
            splatCount: this.splatCount,
            centreArrayType: this.options.integerBasedSort ? 'Int32Array' : 'Float32Array',
            centreBytes: centres.byteLength,
            min, max, integerMin, integerMax,
        };

        // The exact message Viewer.js queues in preSortMessages.
        this.worker!.postMessage({
            centers: centres.buffer,
            sceneIndexes: sceneIndexes.buffer,
            range: { from: 0, to: last, count: this.splatCount },
        });
    }

    /**
     * §5, the LAM reference policy verbatim: every render requests a sort; if one is
     * already running the request is dropped; otherwise the latest matrix is submitted.
     *
     * @returns a promise that settles when the render indexes for THIS submission have
     *          been applied, or null when the request was dropped.
     */
    request(modelViewProj: ArrayLike<number>): Promise<void> | null {
        this.stats.sortRequested++;
        if (!this.ready || !this.worker) {
            this.stats.sortSkippedBeforeReady++;
            return null;
        }
        if (this.running) {
            this.stats.sortSkippedWhileRunning++;
            return null;
        }

        this.running = true;
        this.stats.sortSubmitted++;
        const pending = new Promise<void>((resolve, reject) => {
            this.resolveRunning = resolve;
            this.rejectRunning = reject;
        });

        // The probe needs the matrix that produced the order it inspects.
        if (!this.orderProbe) this.probeMvp = Float32Array.from(modelViewProj as any);

        const submitStart = performance.now();
        this.worker.postMessage({
            sort: {
                modelViewProj,
                splatRenderCount: this.splatCount,
                splatSortCount: this.splatCount,
                usePrecomputedDistances: LAM_SORT_DEFAULTS.usePrecomputedDistances,
                indexesToSort: this.indexesToSort,
                transforms: this.transforms,
            },
        });
        const submitEnd = performance.now();
        this.submittedAt = submitEnd;
        this.stats.submitMsSamples.push(submitEnd - submitStart);
        return pending;
    }

    private onSortDone(data: any): void {
        this.running = false;
        this.stats.sortCompleted++;
        this.stats.workerSortMsSamples.push(data.sortTime);

        const sortedIndexes = new Uint32Array(data.sortedIndexes.buffer, 0, data.splatRenderCount);
        const indexUpdateStart = performance.now();
        this.splatMesh.updateRenderIndexes(sortedIndexes, data.splatRenderCount);
        const indexUpdateEnd = performance.now();
        this.stats.indexUpdateMsSamples.push(indexUpdateEnd - indexUpdateStart);
        this.stats.roundTripMsSamples.push(indexUpdateEnd - this.submittedAt);

        if (!this.orderProbe && this.probeMvp && this.centresForProbe && data.splatRenderCount > 1) {
            this.orderProbe = this.probeOrder(sortedIndexes, data.splatRenderCount);
        }
        // Keep a copy: `sortedIndexes` aliases the worker's reusable transfer buffer.
        if (!this.sortedIndexes || this.sortedIndexes.length < data.splatRenderCount) {
            this.sortedIndexes = new Uint32Array(data.splatRenderCount);
        }
        this.sortedIndexes.set(sortedIndexes);

        const resolve = this.resolveRunning;
        this.resolveRunning = null;
        this.rejectRunning = null;
        resolve?.();
    }

    /**
     * The depth key, recomputed on the CPU from the canonical centre and the same matrix,
     * for the first and last emitted index. This is a measurement of the order the
     * WebAssembly module produced; it is not used to change it.
     */
    private probeOrder(sortedIndexes: Uint32Array, count: number): UikaLamSortOrderProbe {
        const m = this.probeMvp!;
        const centres = this.centresForProbe!;
        const depth = (index: number): number => {
            const x = centres[index * 4];
            const y = centres[index * 4 + 1];
            const z = centres[index * 4 + 2];
            // Clip-space z before the perspective divide, from the column-major
            // THREE.Matrix4 elements. This is the host's own depth measure for reporting
            // the emitted order; no claim is made about what the WebAssembly module
            // computes internally.
            return m[2] * x + m[6] * y + m[10] * z + m[14];
        };
        const firstEmittedIndex = sortedIndexes[0];
        const lastEmittedIndex = sortedIndexes[count - 1];
        const firstEmittedDepth = depth(firstEmittedIndex);
        const lastEmittedDepth = depth(lastEmittedIndex);
        return {
            firstEmittedIndex,
            lastEmittedIndex,
            firstEmittedDepth,
            lastEmittedDepth,
            farthestFirst: firstEmittedDepth > lastEmittedDepth,
        };
    }

    /** A copy of the most recent sorted index array, for diagnostics. */
    getSortedIndexes(): Uint32Array | null {
        return this.sortedIndexes;
    }

    private failRunning(error: any): void {
        if (!this.running) return;
        this.running = false;
        const reject = this.rejectRunning;
        this.resolveRunning = null;
        this.rejectRunning = null;
        reject?.(error);
    }

    dispose(): void {
        this.disposed = true;
        this.failRunning(new Error('UIKA LAM sort host: disposed'));
        if (this.worker) {
            this.worker.onmessage = null as any;
            this.worker.onerror = null as any;
            this.worker.terminate();
            this.worker = null;
        }
        this.ready = false;
        this.splatMesh = null;
        this.indexesToSort = null;
        this.transforms = null;
        this.sortedIndexes = null;
        this.centresForProbe = null;
        this.probeMvp = null;
    }
}
