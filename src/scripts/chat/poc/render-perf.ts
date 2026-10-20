// src/scripts/chat/poc/render-perf.ts
//
// 【PoC 限定】FULL133 (133,541 Gaussian) の renderer cadence 回復 A/B。
//
// 実機 §25 の測定で、FULL133 は p50 50.13ms (≈19.9fps)、meruru (20,018) は
// p50 8.35ms (≈119.8fps)。A2E は 30fps なので budget = 33.33ms。
// Gaussian 数を減らさずに budget 内へ戻せるかを、renderer 側の
// **2 つの無駄**だけ切り替えて測る。
//
//   A. (移設済み) runMorphUpdate() の steady-state 化は FULL133 の正式 runtime
//      `src/scripts/chat/full133-runtime.ts` が持つ。ここには残っていない。
//   B. sortMode  … runSplatSort() を 10Hz へ間引く
//
// どちらも `uika-133k-mode.ts` (UIKA hidden mode 専用) に既にある実装の
// 考え方をそのまま持ち込む。新方式は発明しない。
// 違いは **通常 avatar 経路 (avatar-config の uika-full133-skin) で効く**こと。
//
// 【毎フレーム何が走っているか (installed renderer の実コード)】
// `Viewer.update()` (`Viewer.js:2123-2124`) が毎フレーム:
//   1. `runMorphUpdate()` (`Viewer.js:2775`)
//        - `new Float32Array(position.array)`            … N×3 float を新規確保
//        - `updateTetureAfterBSAndSkeleton(0, N-1)`      … 下記
//            - `fillSplatCenterArray(...)`               … 全点ループ (1 点ごとに new DataView)
//            - `updateCenterColorsPaddedData(0, N-1)`    … 全点もう 1 周
//            - `updateDataTexture(..., 0, N-1)`          … center/color texture を全量再アップロード
//            - `updateBoneMatrixTexture(useFlame)`       … ← **これだけが毎フレーム必要**
//   2. `runSplatSort(true, true)`                        … force=true なので
//        ライブラリ自身の「視線がほとんど変わっていなければ sort しない」早期 return
//        (`Viewer.js:2420-2427`) が**毎回バイパスされる**
//
// 【介入範囲】
// `viewer.runSplatSort` を instance レベルで差し替えるだけ。
// node_modules (production dependency) は書き換えない。
// フラグ未指定なら**何もしない** (出荷版の挙動のまま)。
//
// center 再構築が steady-state で冗長である根拠と、それを止める実装は
// `src/scripts/chat/full133-runtime.ts` の冒頭コメントにまとめてある。

export type SortModeFlag = 'full' | '10fps';

/** 10fps モードで sort を通す最小間隔。指示書 §14 の「100ms 未満ならskip」。 */
const SORT_MIN_INTERVAL_MS = 100;

function param(name: string): string | null {
    try {
        return new URLSearchParams(window.location.search).get(name);
    } catch (e) {
        return null;
    }
}

/* morphFast (runMorphUpdate の steady-state 化) はこの PoC から外し、
 * FULL133 の正式 runtime へ移した: `src/scripts/chat/full133-runtime.ts`。
 * `?morphPath=` / 旧 `?morphFast=` の解釈もそちらが持つ。 */

/** 既定は出荷挙動 (full)。`?sortMode=10fps` のときだけ間引く。 */
export function getSortModeFlag(): SortModeFlag {
    return param('sortMode') === '10fps' ? '10fps' : 'full';
}

/** `?centersProbe=1` — baseData.centers が時間変化するかを実測する (§8)。 */
export function isCentersProbeMode(): boolean {
    return param('centersProbe') === '1';
}

/** 診断ログ用。挙動は変えない (§19)。
 *
 * **localStorage の `selectedAvatar_*` は使わない。** `initialize()` の
 * `ensureDefaultAvatarInStorage(mode)` が後から既定値で上書きすることがあり、
 * 実際にロードされたモデルと食い違う (実測: FULL133 をロードしているのに
 * `elf` と表示された)。`__lamAvatarConfig.modelUrl` は
 * `LAMAvatar.astro:124` でロード前に確定する値なので、こちらを正本にする。 */
export function getAvatarIdForDiag(): string {
    try {
        const url = (window as any).__lamAvatarConfig?.modelUrl;
        if (typeof url === 'string' && url) {
            const base = url.split('/').pop() || url;
            return base.replace(/\.zip$/i, '');
        }
    } catch (e) { /* fallthrough */ }
    try {
        const mode = window.location.pathname.includes('concierge') ? 'concierge' : 'lesson';
        return (window.localStorage.getItem('selectedAvatar_' + mode) || '(unset)') + '?';
    } catch (e) {
        return '(unavailable)';
    }
}

export interface RenderPerfStats {
    avatarId: string;
    sort: {
        mode: SortModeFlag;
        applied: boolean;
        reason: string;
        /** wrapper が呼ばれた総数 */
        calls: number;
        /** **実際に新しい sort が始まった**回数 (orig 呼び出し前後で sortRunning が
         *  false -> true に変わったもの)。throttle clock はこれだけで進む。 */
        started: number;
        /** 100ms 制限で飛ばした回数 */
        throttled: number;
        /** 呼ばれた時点で既に前の sort が走っていた回数。
         *  renderer 本体 (`Viewer.js:2401`) が `Promise.resolve(true)` で弾くので
         *  素通しし、**throttle clock は進めない**。 */
        overlapSkipped: number;
        /** throttle を通して orig へ入れたのに sort が始まらなかった回数
         *  (`!initialized` / `getSplatCount() <= 0` 等)。通常は 0。 */
        enteredButNotStarted: number;
        /** started / calls */
        startRate: number | null;
        /** 実効 sort 周波数 [Hz] = started / (最後の start - 最初の start) */
        effectiveSortHz: number | null;
        /** 実際に始まった sort の promise 解決までの時間 ms */
        completionP50Ms: number | null;
        completionP95Ms: number | null;
    };
    centersProbe: {
        enabled: boolean;
        samples: number;
        /** 最初に観測した hash */
        firstHash: number | null;
        /** hash が前フレームと変わった回数 */
        changes: number;
        /** 観測した相異なる hash の個数 */
        distinctHashes: number;
        /** jawOpen が 0 でないフレームでのサンプル数 / hash 変化数 */
        speakingSamples: number;
        speakingChanges: number;
        verdict: 'INVARIANT' | 'VARIES' | 'INSUFFICIENT';
        /** A2E の bsWeight が書かれる boneMatrix texture。
         *  こちらは**変化していないといけない** (§28: morph 更新が止まったら FAIL)。 */
        boneMatrixChanges: number;
        boneMatrixDistinct: number;
        boneMatrixVerdict: 'UPDATING' | 'FROZEN' | 'INSUFFICIENT';
    };
}

function pct(sorted: number[], p: number): number | null {
    if (sorted.length < 3) return null;
    return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

/** FNV-1a 32bit。Float32Array を間引いて走査する (全点を毎フレーム見ない)。 */
function hashStrided(arr: Float32Array, stride: number): number {
    let h = 0x811c9dc5;
    const u = new Uint32Array(arr.buffer, arr.byteOffset, arr.length);
    for (let i = 0; i < u.length; i += stride) {
        h ^= u[i];
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}

export async function installRenderPerf(renderer: any, maxTries = 600): Promise<RenderPerfStats> {
    const sortMode = getSortModeFlag();
    const probe = isCentersProbeMode();

    const stats: RenderPerfStats = {
        avatarId: getAvatarIdForDiag(),
        sort: {
            mode: sortMode, applied: false, reason: '', calls: 0, started: 0,
            throttled: 0, overlapSkipped: 0, enteredButNotStarted: 0,
            startRate: null, effectiveSortHz: null,
            completionP50Ms: null, completionP95Ms: null,
        },
        centersProbe: {
            enabled: probe, samples: 0, firstHash: null, changes: 0,
            distinctHashes: 0, speakingSamples: 0, speakingChanges: 0,
            verdict: 'INSUFFICIENT',
            boneMatrixChanges: 0, boneMatrixDistinct: 0,
            boneMatrixVerdict: 'INSUFFICIENT',
        },
    };
    (window as any).__renderPerf = stats;

    return await new Promise<RenderPerfStats>((resolve) => {
        let tries = 0;
        const tick = () => {
            const v = renderer?.viewer;
            const ready = v && typeof v.runMorphUpdate === 'function'
                && typeof v.runSplatSort === 'function';
            const nothingToDo = sortMode === 'full' && !probe;
            if (ready || nothingToDo || ++tries >= maxTries) {
                applyRenderPerf(renderer, stats);
                resolve(stats);
                return;
            }
            requestAnimationFrame(tick);
        };
        tick();
    });
}

function applyRenderPerf(renderer: any, stats: RenderPerfStats): void {
    const v = renderer?.viewer;
    if (!v) {
        stats.sort.reason = 'viewer が見つからない';
        return;
    }
    if (v.__renderPerfHooked) {
        stats.sort.reason = 'すでに適用済み';
        return;
    }
    v.__renderPerfHooked = true;

    installSortMode(v, stats);
    installCentersProbe(v, stats);
}

/**
 * `baseData.centers` が時間変化するかを実測する (§8 / §10)。
 * **runMorphUpdate を素通しした直後**の centers を見るので、
 * `?morphPath=stock` (= steady-state 化を切った状態) で測ること。
 * ハッシュは Uint32 ビューを間引いて取る (全点を毎フレーム走査しない)。
 */
function installCentersProbe(v: any, stats: RenderPerfStats): void {
    if (!stats.centersProbe.enabled) return;
    const orig = v.runMorphUpdate.bind(v);
    const seen = new Set<number>();
    let prev: number | null = null;
    const seenBone = new Set<number>();
    let prevBone: number | null = null;

    v.runMorphUpdate = function (...a: any[]) {
        const r = orig(...a);
        try {
            const centers = v.splatMesh?.splatDataTextures?.baseData?.centers;
            if (centers && centers.length) {
                // 約 4,000 サンプルになる stride (点数に依らず一定コスト)
                const stride = Math.max(1, Math.floor(centers.length / 4000));
                const h = hashStrided(centers, stride);
                const p = stats.centersProbe;
                p.samples++;
                if (p.firstHash === null) p.firstHash = h;
                seen.add(h);
                p.distinctHashes = seen.size;
                const bs = v.splatMesh?.bsWeight;
                const jaw = bs && typeof bs === 'object' ? Number(bs['jawOpen'] ?? 0) : 0;
                const speaking = jaw > 0.001;
                if (speaking) p.speakingSamples++;
                if (prev !== null && h !== prev) {
                    p.changes++;
                    if (speaking) p.speakingChanges++;
                }
                prev = h;
                p.verdict = p.samples < 60 ? 'INSUFFICIENT'
                    : (p.changes === 0 ? 'INVARIANT' : 'VARIES');

                // boneMatrix (bsWeight の行き先) は **変化していないといけない**
                const bm = v.splatMesh?.splatDataTextures?.baseData?.['boneMatrix'];
                if (bm && bm.length) {
                    let bh = 0x811c9dc5;
                    for (let i = 0; i < bm.length; i++) {
                        bh ^= bm[i];
                        bh = Math.imul(bh, 0x01000193);
                    }
                    bh = bh >>> 0;
                    seenBone.add(bh);
                    p.boneMatrixDistinct = seenBone.size;
                    if (prevBone !== null && bh !== prevBone) p.boneMatrixChanges++;
                    prevBone = bh;
                    p.boneMatrixVerdict = p.samples < 60 ? 'INSUFFICIENT'
                        : (p.boneMatrixChanges > 0 ? 'UPDATING' : 'FROZEN');
                }
            }
        } catch (e) { /* 観測だけなので黙って無視 */ }
        return r;
    };
}

/** B. runSplatSort を 10Hz へ間引く (§13 / §14 / §16)。camera モードは作らない (§15)。
 *
 * ## throttle clock を進める条件 (重要)
 * 元の `runSplatSort` には早期 return が 3 つある (`Viewer.js:2400-2404`):
 *
 *     if (!this.initialized)              return Promise.resolve(false)
 *     if (this.sortRunning)               return Promise.resolve(true)
 *     if (getSplatCount() <= 0)           return Promise.resolve(false)
 *
 * このうち `sortRunning` は実測で頻発する (出荷状態で 74 回中 37 回)。
 * wrapper 側で「通した」と数えて clock を進めてしまうと、
 * **実際には新しい sort が始まっていないのに次の 100ms を抑制**してしまい、
 * 実効 sort rate が意図より低くなる。計測値 (accepted) も
 * 「sort を開始した回数」を意味しなくなる。
 *
 * そこで:
 *   - `sortRunning` が true の呼び出しは **orig を素通し**して本体に
 *     `Promise.resolve(true)` を返させる (出荷版と戻り値を変えない)。
 *     `overlapSkipped` に数え、**clock は進めない**。
 *   - orig へ入れた場合も、`sortRunning` が false -> true に変わったときだけ
 *     「実際に始まった」と見なして `started++` し、**そのときだけ clock を進める**。
 *     (`sortRunning = true` は `Viewer.js:2428` で同期的に立つ。
 *      false へ戻すのは worker の onmessage なので非同期。)
 */
function installSortMode(v: any, stats: RenderPerfStats): void {
    const s = stats.sort;
    if (s.mode === 'full') { s.reason = 'sortMode 未指定のため出荷版のまま'; return; }
    if (typeof v.runSplatSort !== 'function') { s.reason = 'runSplatSort が無い'; return; }

    const orig = v.runSplatSort;            // arrow property なので bind 不要
    let firstDone = false;
    let lastStartedAt = -Infinity;
    let firstStartAt: number | null = null;
    const completions: number[] = [];

    const refresh = () => {
        s.startRate = s.calls > 0 ? s.started / s.calls : null;
        if (firstStartAt !== null && s.started > 1 && lastStartedAt > firstStartAt) {
            s.effectiveSortHz = (s.started - 1) / ((lastStartedAt - firstStartAt) / 1000);
        }
    };

    /** orig へ入れる。**実際に始まったときだけ** clock を進める。 */
    const enter = (force: any, forceSortAll: any) => {
        const t0 = performance.now();
        const p = orig(force, forceSortAll);
        if (v.sortRunning === true) {
            // 新しい sort が始まった
            s.started++;
            lastStartedAt = t0;
            if (firstStartAt === null) firstStartAt = t0;
            try {
                Promise.resolve(p).then(() => {
                    completions.push(performance.now() - t0);
                    if (completions.length > 2000) completions.shift();
                    const sorted = completions.slice().sort((x, y) => x - y);
                    s.completionP50Ms = pct(sorted, 0.5);
                    s.completionP95Ms = pct(sorted, 0.95);
                });
            } catch (e) { /* noop */ }
        } else {
            // initialized / splatCount 等の別の早期 return。clock は進めない。
            s.enteredButNotStarted++;
        }
        refresh();
        return p;
    };

    v.runSplatSort = function (force?: any, forceSortAll?: any) {
        s.calls++;
        // 1) 本体が sortRunning で弾く呼び出し。素通しして clock は進めない。
        if (v.sortRunning) {
            s.overlapSkipped++;
            refresh();
            return orig(force, forceSortAll);
        }
        // 2) 初回は必ず通す
        if (!firstDone) {
            firstDone = true;
            return enter(force, forceSortAll);
        }
        // 3) 10Hz 制限
        if (performance.now() - lastStartedAt < SORT_MIN_INTERVAL_MS) {
            s.throttled++;
            refresh();
            // 元の実装が早期 return で返すのと同じ値 (`Viewer.js:2400` / `2402`)
            return Promise.resolve(false);
        }
        return enter(force, forceSortAll);
    };
    s.applied = true;
    s.reason = `runSplatSort を最大 ${1000 / SORT_MIN_INTERVAL_MS}Hz へ間引いた`;
}
