/**
 * PoC: FULL133 adaptive splat sort
 *
 * 【何を変えるか】
 * 「sort の頻度を時間で間引く」のではなく、**sort が必要かどうかを判定する**。
 *
 * installed renderer の `Viewer.update()` は毎フレーム
 * `runSplatSort(true, true)` を呼ぶ (`Viewer.js:2124`)。
 * `runSplatSort` 自身はカメラ変化の閾値判定を持っているが
 * (`Viewer.js:2419-2427`: angleDiff <= 0.99 / positionDiff >= 1.0)、
 * **`force = true` のときはその判定を丸ごとスキップする**。
 * つまり talking-head のようにカメラが静止していても sort が回り続ける。
 *
 * ここでは `runSplatSort` を instance 単位でラップし、
 *
 *   初回 / camera・projection が変化したときだけ sort
 *   A2E morph (jawOpen / blink / 52 coefficients) や boneMatrix 更新では sort しない
 *
 * に変える。morph で再 sort しないのは意図的 (指示書 §9)。
 * それで depth artifact が出るかは目視テストで判定する。
 *
 * 【single-flight + latest-state coalescing】(指示書 §6 / §11 / §33)
 * sort 実行中に camera が動いたら、新しい sort を queue せず `dirty` だけ立てる。
 * 完了後、次の呼び出しで**最新の camera 状態について 1 回だけ**再 sort する。
 * camera event が 100 回来ても sort が 100 個並ぶことは無い。
 *
 * 【介入範囲】
 * `renderer.viewer.runSplatSort` の差し替えのみ。node_modules は書き換えない。
 * FULL133 以外の avatar には一切適用しない (指示書 §4 / §28)。
 *
 * 【`adaptive-cpu` が使えない理由 — 実機で外見が劣化した原因】
 * 以前の実装はロード後に `viewer.gpuAcceleratedSort = false` を代入していた。
 * これは**壊れる**。理由は installed renderer 側の初期化順:
 *
 *   `Viewer.js:1489-1500` (splat buffer のビルド時、ロード中に 1 回だけ実行)
 *       // If we aren't calculating the splat distances from the center on the GPU,
 *       // the sorting worker needs splat centers ...
 *       if (!this.gpuAcceleratedSort) {
 *           this.preSortMessages.push({ centers, sceneIndexes, range })
 *       }
 *
 * sort worker へ **splat centers を送るかどうかはロード時の
 * `gpuAcceleratedSort` で決まる**。本アプリはロード時 true なので centers は
 * 送られない。その後でフラグだけ false にすると:
 *
 *   - `Viewer.js:2440-2447` … `computeDistancesOnGPU` を呼ばなくなる
 *   - `Viewer.js:2480`      … `usePrecomputedDistances: false` を送る
 *   - `SortWorker.js:85-98` … centers を書く唯一の経路が一度も走っていないので
 *                             WASM の centers 領域はゼロのまま
 *                             (`uploadedSplatCount` は 0 のまま)
 *   - `SortWorker.js:59`    … `sortIndexes(..., centersOffset, ...,
 *                             usePrecomputedDistances=false, ...)` が
 *                             **ゼロ埋めの centers から深度を計算する**
 *
 * 結果、全 splat の距離が同値になり、並び順が深度と無関係になる。
 * Gaussian splat は順序依存の alpha 合成なので、重なりの多い部分
 * (口元 / 歯 / 唇の縁 / 髪) が最も崩れる。
 *
 * `render.ts:104` が `gpuAcceleratedSort: true` をハードコードしているため
 * 構築時オプションでは渡せない。そこで **renderer がロード時に送るはずだった
 * のと同じメッセージを、こちらから送ってから** フラグを倒す:
 *
 *   `SplatMesh.getDataForDistancesComputation(0, count - 1)`
 *       (`SplatMesh.js:589-598`。renderer 自身が `buildResults` を作るのと同じ API。
 *        `integerBasedDistancesComputation` を見て int/float を選び `padFour=true`)
 *   → `viewer.preSortMessages.push({ centers, sceneIndexes, range })`
 *   → `viewer.gpuAcceleratedSort = false`
 *
 * `preSortMessages` は次の sort の直前に worker へ送られてから空にされる
 * (`Viewer.js:2497-2504`)。worker はメッセージを順に処理するので、centers が
 * WASM へ書かれた後に最初の cpu sort が走る。
 *
 * int/float の食い違いが起きないことも確認済み:
 * `Viewer.js:361-375` が `new SplatMesh(..., this.gpuAcceleratedSort,
 * this.integerBasedSort, ...)` と渡し、`SplatMesh.js:49-52` の引数 7 が
 * `integerBasedDistancesComputation` なので、両者は構築時に必ず一致する。
 * それでも実行時に一致を検証し、違えば適用しない。
 */

import { getAvatarIdForDiag, getSortModeFlag } from './render-perf';
import { loadAvatarConfig } from '../../../config/avatar-config';

export type SortPolicy = 'stock' | 'adaptive-gpu' | 'adaptive-cpu';

/** 適用対象。これ以外の avatar では何もしない (指示書 §4 / §28)。 */
const FULL133_AVATAR_ID = 'uika-full133-skin';
const FULL133_SPLAT_COUNT = 133541;

/** camera signature の一致判定に使う epsilon (指示書 §7)。 */
const EPS_POSITION = 1e-5;
const EPS_QUATERNION = 1e-5;
const EPS_PROJECTION = 1e-6;
const EPS_TARGET = 1e-5;

function parsePolicy(v: string | null | undefined): SortPolicy | null {
    if (v === 'adaptive' || v === 'adaptive-gpu') return 'adaptive-gpu';
    if (v === 'adaptive-cpu') return 'adaptive-cpu';
    if (v === 'stock') return 'stock';
    return null;
}

/** `?sortPolicy=` の値。無ければ `null`。`adaptive` は gpu backend の別名。 */
export function getSortPolicyOverride(): SortPolicy | null {
    try {
        return parsePolicy(new URLSearchParams(window.location.search).get('sortPolicy'));
    } catch (e) {
        return null;
    }
}

/** 同期版。URL の指定だけを見る (run-guard の表示用)。 */
export function getSortPolicy(): SortPolicy {
    return getSortPolicyOverride() ?? 'stock';
}

/**
 * 実際に使う policy を決める。優先順位:
 *
 *   1. `?sortPolicy=` (debug / override。指示書 §27)
 *   2. avatar-config.json のアバター定義の `sortPolicy`
 *   3. 'stock' (出荷挙動)
 *
 * これにより、実測で backend が決まった後は **avatar-config.json を 1 行
 * 書き換えるだけ**で本番適用でき、通常利用時に URL パラメータが不要になる。
 */
export async function resolveSortPolicy(): Promise<{ policy: SortPolicy; source: string }> {
    const override = getSortPolicyOverride();
    if (override) return { policy: override, source: 'url' };
    try {
        const avatars = await loadAvatarConfig();
        const id = getAvatarIdForDiag();
        const def = avatars.find((a: { id: string }) => a.id === id);
        const fromConfig = parsePolicy(def?.sortPolicy);
        if (fromConfig) return { policy: fromConfig, source: 'avatar-config' };
    } catch (e) {
        console.warn('[PoC adaptiveSort] avatar-config の読み込みに失敗。stock を使います:', e);
    }
    return { policy: 'stock', source: 'default' };
}

/**
 * sort worker へ splat centers を渡す。cpu backend で深度を自前計算させるために
 * 必須。renderer がロード時に行う処理 (`Viewer.js:1489-1500`) と同じ内容を、
 * 同じ API (`SplatMesh.getDataForDistancesComputation`) で作って送る。
 *
 * 送れない条件が 1 つでもあれば **false を返して適用しない**。
 * 中途半端に倒すと並び順が壊れるため、推測で続行しない。
 */
function primeSortWorkerCenters(v: any, s: AdaptiveSortStats): boolean {
    const sm = v?.splatMesh;
    if (typeof sm?.getDataForDistancesComputation !== 'function') {
        s.reason = 'splatMesh.getDataForDistancesComputation が無いため '
            + 'sort worker へ centers を渡せない';
        return false;
    }
    if (!Array.isArray(v.preSortMessages)) {
        s.reason = 'viewer.preSortMessages が配列でないため centers を渡せない';
        return false;
    }
    // worker が centers を int として読むか float として読むかは
    // `integerBasedSort`、centers を int/float どちらで作るかは
    // `integerBasedDistancesComputation`。食い違うとビット列を取り違える。
    if (sm.integerBasedDistancesComputation !== v.integerBasedSort) {
        s.reason = `integerBasedSort=${v.integerBasedSort} と `
            + `integerBasedDistancesComputation=${sm.integerBasedDistancesComputation} `
            + 'が食い違うため centers を渡せない';
        return false;
    }
    const count = Number(sm.getSplatCount?.() ?? 0);
    if (count <= 0) {
        s.reason = 'splatCount=0 のため centers を渡せない';
        return false;
    }
    try {
        const { centers, sceneIndexes } = sm.getDataForDistancesComputation(0, count - 1);
        if (!centers?.buffer || !sceneIndexes?.buffer) {
            s.reason = 'getDataForDistancesComputation が centers / sceneIndexes を返さない';
            return false;
        }
        v.preSortMessages.push({
            centers: centers.buffer,
            sceneIndexes: sceneIndexes.buffer,
            range: { from: 0, to: count - 1, count },
        });
        s.centersPrimed = count;
        return true;
    } catch (e: any) {
        s.reason = 'centers の取得で例外: ' + String(e?.message ?? e);
        return false;
    }
}

export interface AdaptiveSortStats {
    mode: SortPolicy;
    /** policy の決定元: 'url' | 'avatar-config' | 'default' */
    source: string;
    applied: boolean;
    reason: string;
    backend: 'gpu' | 'cpu' | null;
    /** cpu backend へ切り替える前に sort worker へ渡した splat 数。0 なら未実施。 */
    centersPrimed: number;
    avatarId: string;
    splatCount: number;

    calls: number;
    initialSorts: number;
    cameraChangeEvents: number;
    projectionChangeEvents: number;

    started: number;
    completed: number;

    skippedUnchanged: number;
    coalescedWhileRunning: number;
    dirtyResorts: number;

    /** `runSplatSort` の戻り promise が解決するまで。= GPU 距離計算 + readback。
     *  `sortRunning` が false に戻るまでの時間ではない (`Viewer.js:1636` で戻る)。 */
    distanceReadbackP50Ms: number | null;
    distanceReadbackP95Ms: number | null;
    /** `sortRunning` が true → false になるまで。worker の sort 完了を含む。 */
    completionP50Ms: number | null;
    completionP95Ms: number | null;

    /** 直近 1 秒あたりの started (steady state では 0 に近いことが目的。§14) */
    startedPerSec: number | null;

    fallbackCount: number;
    lastError: string | null;
}

function pct(sorted: number[], p: number): number | null {
    if (!sorted.length) return null;
    const i = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
    return +sorted[i].toFixed(2);
}

/** `viewer` が生えるまで rAF で待ってから当てる。結果は `window.__adaptiveSort`。 */
export async function installAdaptiveSort(renderer: any, maxTries = 600): Promise<AdaptiveSortStats> {
    const { policy: mode, source } = await resolveSortPolicy();
    const stats: AdaptiveSortStats = {
        mode, source, applied: false, reason: '', backend: null,
        centersPrimed: 0,
        avatarId: '', splatCount: 0,
        calls: 0, initialSorts: 0, cameraChangeEvents: 0, projectionChangeEvents: 0,
        started: 0, completed: 0,
        skippedUnchanged: 0, coalescedWhileRunning: 0, dirtyResorts: 0,
        distanceReadbackP50Ms: null, distanceReadbackP95Ms: null,
        completionP50Ms: null, completionP95Ms: null,
        startedPerSec: null,
        fallbackCount: 0, lastError: null,
    };
    (window as any).__adaptiveSort = stats;

    return new Promise((resolve) => {
        let tries = 0;
        const tick = () => {
            const v = renderer?.viewer;
            const ready = v
                && typeof v.runSplatSort === 'function'
                && (v.splatMesh?.getSplatCount?.() ?? 0) > 0;
            if (ready || mode === 'stock' || ++tries >= maxTries) {
                apply(renderer, stats);
                resolve(stats);
                return;
            }
            requestAnimationFrame(tick);
        };
        tick();
    });
}

function apply(renderer: any, s: AdaptiveSortStats): void {
    const v = renderer?.viewer;
    // 診断用。stock で early-return する場合も埋めておく
    // (実機ログで avatarId="" / splatCount=0 のまま出て紛らわしかった)。
    s.avatarId = getAvatarIdForDiag();
    s.splatCount = Number(v?.splatMesh?.getSplatCount?.() ?? 0);

    if (s.mode === 'stock') { s.reason = 'sortPolicy 未指定のため出荷版のまま'; return; }

    if (!v || typeof v.runSplatSort !== 'function') {
        s.reason = 'viewer.runSplatSort が見つからない';
        return;
    }
    if (v.__adaptiveSortHooked) { s.reason = 'すでに適用済み'; return; }

    // 旧 PoC の sort throttle と二重にラップすると、どちらの効果か分からなくなる。
    if (getSortModeFlag() === '10fps') {
        s.reason = 'sortMode=10fps と同時指定は禁止 (どちらの効果か切り分け不能)';
        console.error('[PoC adaptiveSort] ' + s.reason);
        return;
    }

    // FULL133 だけに適用する (指示書 §4 / §28)。
    if (s.avatarId !== FULL133_AVATAR_ID || s.splatCount !== FULL133_SPLAT_COUNT) {
        s.reason = `FULL133 専用。avatarId=${s.avatarId} splatCount=${s.splatCount} のため適用しない`;
        return;
    }

    // cpu backend へ切り替えるなら、**先に** sort worker へ splat centers を
    // 渡す。渡さずにフラグだけ倒すと worker がゼロ埋めの centers で深度を
    // 計算して並び順が壊れる (冒頭コメント参照)。
    if (s.mode === 'adaptive-cpu' && v.gpuAcceleratedSort !== false) {
        const primed = primeSortWorkerCenters(v, s);
        if (!primed) {
            console.error('[PoC adaptiveSort] ' + s.reason);
            return;
        }
        v.gpuAcceleratedSort = false;
    }
    // backend は宣言ではなく renderer の実値から決める。
    // `?gpuSort=0` が併用されていても取り違えないようにする。
    s.backend = v.gpuAcceleratedSort === false ? 'cpu' : 'gpu';

    const orig = v.runSplatSort;            // arrow property なので bind 不要
    v.__adaptiveSortHooked = true;

    let initialDone = false;
    let dirty = false;
    let wasRunning = false;
    let startedAt = 0;
    /** 最後に sort を発行したときの camera signature。 */
    let lastSig: Float64Array | null = null;
    const readbacks: number[] = [];
    const completions: number[] = [];
    const startedTimes: number[] = [];

    /** position(3) + quaternion(4) + projection(16) + controls.target(3) = 26 */
    const sigBuf = new Float64Array(26);
    const readSignature = (): Float64Array => {
        const cam = v.camera;
        const projCam = v.perspectiveCamera || v.camera;   // Viewer.js:2435 と同じ
        const b = sigBuf;
        b[0] = cam.position.x; b[1] = cam.position.y; b[2] = cam.position.z;
        b[3] = cam.quaternion.x; b[4] = cam.quaternion.y;
        b[5] = cam.quaternion.z; b[6] = cam.quaternion.w;
        const e = projCam.projectionMatrix.elements;
        for (let i = 0; i < 16; i++) b[7 + i] = e[i];
        const t = v.controls?.target;
        b[23] = t ? t.x : 0; b[24] = t ? t.y : 0; b[25] = t ? t.z : 0;
        return b;
    };

    /** 変化の種類を返す。`null` なら変化なし。JSON.stringify のような重い処理はしない。 */
    const diffKind = (sig: Float64Array): 'camera' | 'projection' | null => {
        if (!lastSig) return 'camera';
        let projChanged = false;
        for (let i = 7; i < 23; i++) {
            if (Math.abs(sig[i] - lastSig[i]) > EPS_PROJECTION) { projChanged = true; break; }
        }
        if (projChanged) return 'projection';
        for (let i = 0; i < 3; i++) {
            if (Math.abs(sig[i] - lastSig[i]) > EPS_POSITION) return 'camera';
        }
        for (let i = 3; i < 7; i++) {
            if (Math.abs(sig[i] - lastSig[i]) > EPS_QUATERNION) return 'camera';
        }
        for (let i = 23; i < 26; i++) {
            if (Math.abs(sig[i] - lastSig[i]) > EPS_TARGET) return 'camera';
        }
        return null;
    };

    const refresh = () => {
        s.distanceReadbackP50Ms = pct(readbacks.slice().sort((a, b) => a - b), 0.5);
        s.distanceReadbackP95Ms = pct(readbacks.slice().sort((a, b) => a - b), 0.95);
        s.completionP50Ms = pct(completions.slice().sort((a, b) => a - b), 0.5);
        s.completionP95Ms = pct(completions.slice().sort((a, b) => a - b), 0.95);
        if (startedTimes.length > 1) {
            const span = (startedTimes[startedTimes.length - 1] - startedTimes[0]) / 1000;
            s.startedPerSec = span > 0 ? +((startedTimes.length - 1) / span).toFixed(3) : null;
        }
    };

    /** 実際に sort を発行する。`force = true` で渡すのは、必要判定を既にこちらで
     *  済ませているため (renderer 側の閾値で二重に弾かれないようにする)。 */
    const enter = (sig: Float64Array): Promise<any> => {
        if (!lastSig) lastSig = new Float64Array(26);
        lastSig.set(sig);
        dirty = false;
        const t0 = performance.now();
        const p = orig(true, true);
        if (v.sortRunning === true) {
            s.started++;
            startedAt = t0;
            wasRunning = true;
            if (startedTimes.length > 500) startedTimes.shift();
            startedTimes.push(t0);
            try {
                Promise.resolve(p).then(() => {
                    readbacks.push(performance.now() - t0);
                    if (readbacks.length > 2000) readbacks.shift();
                    refresh();
                });
            } catch (e) { /* noop */ }
        }
        refresh();
        return p;
    };

    v.runSplatSort = function (force?: any, forceSortAll?: any) {
        try {
            s.calls++;

            // sortRunning が true → false に落ちた瞬間を検出する。
            // 戻り promise は GPU 距離 readback の完了であって sort 完了ではない
            // (`Viewer.js:1636` で sortRunning が false に戻る)。
            if (wasRunning && v.sortRunning !== true) {
                wasRunning = false;
                s.completed++;
                completions.push(performance.now() - startedAt);
                if (completions.length > 2000) completions.shift();
                refresh();
            }

            const sig = readSignature();
            const kind = diffKind(sig);
            if (kind === 'camera') s.cameraChangeEvents++;
            if (kind === 'projection') s.projectionChangeEvents++;

            // 1) 初期ロード時の sort は必ず通す (指示書 §10)。
            if (!initialDone) {
                initialDone = true;
                s.initialSorts++;
                return enter(sig);
            }

            // 2) sort 実行中。新しい sort を queue せず dirty だけ残す (§6 / §11 / §33)。
            if (v.sortRunning) {
                if (kind !== null) { dirty = true; s.coalescedWhileRunning++; }
                return orig(force, forceSortAll);   // 出荷版と同じ戻り値 (resolve(true))
            }

            // 3) camera が動いていない & 持ち越しも無い → sort しない。これが本題。
            if (kind === null && !dirty) {
                s.skippedUnchanged++;
                return Promise.resolve(false);
            }

            // 4) 変化あり、または sort 中に動いた分の最終 sort (§24)。
            if (kind === null && dirty) s.dirtyResorts++;
            return enter(sig);
        } catch (e: any) {
            // silent failure 禁止 (指示書 §12)。出荷版へ戻す。
            s.fallbackCount++;
            s.lastError = String(e?.message ?? e);
            v.runSplatSort = orig;
            v.__adaptiveSortHooked = false;
            console.error('[PoC adaptiveSort] 例外。出荷版の runSplatSort へ戻しました:', e);
            return orig(force, forceSortAll);
        }
    };

    s.applied = true;
    s.reason = s.mode === 'adaptive-cpu'
        ? 'camera/projection 変化時のみ sort。距離計算は worker 側 (GPU readback なし)'
        : 'camera/projection 変化時のみ sort。距離計算は GPU のまま';
}
