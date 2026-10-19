// src/scripts/chat/poc/render-perf.ts
//
// 【PoC 限定】FULL133 (133,541 Gaussian) の renderer cadence 回復 A/B。
//
// 実機 §25 の測定で、FULL133 は p50 50.13ms (≈19.9fps)、meruru (20,018) は
// p50 8.35ms (≈119.8fps)。A2E は 30fps なので budget = 33.33ms。
// Gaussian 数を減らさずに budget 内へ戻せるかを、renderer 側の
// **2 つの無駄**だけ切り替えて測る。
//
//   A. morphFast … runMorphUpdate() の毎フレーム全量再構築をやめる
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
// 【なぜ center 再構築が無駄になりうるか】
//   centers[i] = sceneTransform * splatBuffer.center[i] + morphedMesh[i]
//   - `splatBuffer.center` は offset.ply 由来で静的
//   - `morphedMesh` は `avatarMesh.geometry.attributes.position.array` のコピー。
//     three.js は morph / skinning の結果を position attribute へ書き戻さない
//     (どちらも shader 側)
//   - A2E morph は `flameModelTexture` + `bsWeight` から shader で加算される経路
//   つまり毎フレーム同じ結果を作り直して送り直している**可能性がある**。
//   ただし通常 avatar 経路でそれが成り立つかは**実測する** (?centersProbe=1)。
//   成り立たなければ morphFast は使わない。推測で強行しない。
//
// 【毎フレーム残すもの】
//   - `skeleton.update()` / `boneRoot.updateMatrixWorld(true)`
//       animation.glb の idle head/neck モーションが boneTexture0 へ反映される
//   - `splatMesh.updateBoneMatrixTexture(useFlame)` (`SplatMesh.js:979`)
//       A2E の `bsWeight` を小さな boneMatrix texture (4×32) へ書くのはここだけ。
//       center/color texture には触らない。
//
// 【介入範囲】
// `viewer.runMorphUpdate` / `viewer.runSplatSort` を instance レベルで差し替えるだけ。
// node_modules (production dependency) は書き換えない。
// フラグ未指定なら**何もしない** (出荷版の挙動のまま)。

import { loadAvatarConfig } from '../../../config/avatar-config';

export type MorphFastMode = 'off' | 'on';
export type SortModeFlag = 'full' | '10fps';

/** 10fps モードで sort を通す最小間隔。指示書 §14 の「100ms 未満ならskip」。 */
const SORT_MIN_INTERVAL_MS = 100;

/** 初期化が揃うまで完全実行する最小フレーム数 (起動時のみのコスト)。
 *  ただしこれ単独では判定しない。実 ready 条件と AND で見る (§11)。 */
const MIN_FULL_RUNS = 30;

function param(name: string): string | null {
    try {
        return new URLSearchParams(window.location.search).get(name);
    } catch (e) {
        return null;
    }
}

/** `?morphFast=` の値を読む。指定が無ければ `null` (= 既定に任せる)。
 *
 * `0` / `off` / `false` は **明示的な off** として扱う。avatar-config 側で
 * on にした後も URL で切り戻せるようにするため、「未指定」と区別する。 */
function parseMorphFast(v: string | null | undefined): MorphFastMode | null {
    if (v === '1' || v === 'on' || v === 'true') return 'on';
    if (v === '0' || v === 'off' || v === 'false') return 'off';
    return null;
}

/** `?morphFast=` の指定だけを見る。無ければ `null`。 */
export function getMorphFastOverride(): MorphFastMode | null {
    return parseMorphFast(param('morphFast'));
}

/** 既定は出荷挙動 (off)。`?morphFast=1` のときだけ有効。
 *
 * **URL だけを見る同期版。** avatar-config を含めた実効値は
 * `resolveMorphFast()` / `window.__renderPerf.morphFast.mode` を見ること。 */
export function getMorphFastMode(): MorphFastMode {
    return getMorphFastOverride() ?? 'off';
}

/**
 * 実際に使う morphFast モードを決める。優先順位は adaptive sort の
 * `resolveSortPolicy()` と同じ:
 *
 *   1. `?morphFast=` (debug / override)
 *   2. avatar-config.json のアバター定義の `morphFast`
 *   3. 'off' (出荷挙動)
 *
 * avatar-config のキーは avatar ごとなので、FULL133 で on にしても
 * 他の avatar には一切効かない。
 */
export async function resolveMorphFast(): Promise<{ mode: MorphFastMode; source: string }> {
    const override = getMorphFastOverride();
    if (override) return { mode: override, source: 'url' };
    try {
        const avatars = await loadAvatarConfig();
        const id = getAvatarIdForDiag();
        const def = avatars.find((a: { id: string }) => a.id === id);
        if (typeof def?.morphFast === 'boolean') {
            return { mode: def.morphFast ? 'on' : 'off', source: 'avatar-config' };
        }
    } catch (e) {
        console.warn('[PoC morphFast] avatar-config の読み込みに失敗。off を使います:', e);
    }
    return { mode: 'off', source: 'default' };
}

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
    morphFast: {
        mode: MorphFastMode;
        /** mode の決定元: 'url' | 'avatar-config' | 'default' */
        source: string;
        applied: boolean;
        reason: string;
        fullRuns: number;
        fastFrames: number;
        fallbackCount: number;
        lastError: string | null;
    };
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
    // avatar-config を読むので await する。URL 指定があればそこで即決まる。
    const { mode: morphMode, source: morphSource } = await resolveMorphFast();
    const sortMode = getSortModeFlag();
    const probe = isCentersProbeMode();

    const stats: RenderPerfStats = {
        avatarId: getAvatarIdForDiag(),
        morphFast: {
            mode: morphMode, source: morphSource, applied: false, reason: '', fullRuns: 0,
            fastFrames: 0, fallbackCount: 0, lastError: null,
        },
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
            const nothingToDo = morphMode === 'off' && sortMode === 'full' && !probe;
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
        stats.morphFast.reason = 'viewer が見つからない';
        stats.sort.reason = 'viewer が見つからない';
        return;
    }
    if (v.__renderPerfHooked) {
        stats.morphFast.reason = 'すでに適用済み';
        stats.sort.reason = 'すでに適用済み';
        return;
    }
    v.__renderPerfHooked = true;

    // 順序が重要: probe を **最外側** に置く。
    // 先に probe を入れると fast-path が probe をラップする形になり、
    // fast 中は probe が呼ばれなくなって「morph 更新が止まっていないか」を
    // 観測できない (§28 の判定ができない)。
    installMorphFast(v, stats);
    installSortMode(v, stats);
    installCentersProbe(v, stats);
}

/**
 * `baseData.centers` が時間変化するかを実測する (§8 / §10)。
 * **runMorphUpdate を素通しした直後**の centers を見るので、morphFast=off で測ること。
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

/** A. runMorphUpdate fast-path (§7 / §9 / §11 / §12)。 */
function installMorphFast(v: any, stats: RenderPerfStats): void {
    const s = stats.morphFast;
    if (s.mode === 'off') { s.reason = 'morphFast 未指定のため出荷版のまま'; return; }
    if (typeof v.runMorphUpdate !== 'function') { s.reason = 'runMorphUpdate が無い'; return; }

    const orig = v.runMorphUpdate.bind(v);
    let fullRuns = 0;
    let ready = false;

    (window as any).__renderPerfForceFullMorph = () => { ready = false; fullRuns = 0; return 'ok'; };

    v.runMorphUpdate = function (...a: any[]) {
        if (!ready) {
            const r = orig(...a);
            fullRuns++;
            s.fullRuns = fullRuns;
            // §11: マジック値だけに頼らず実 ready 条件と AND で判定する
            const sm = v.splatMesh;
            const initDone = v.setSkinAttibutes === true
                && sm?.splatDataTextures?.['flameModel'] !== undefined
                && sm?.splatDataTextures?.['boneMatrix'] !== undefined
                && !!sm?.morphedMesh
                && (sm?.bonesNum ?? 0) > 0
                && (sm?.getSplatCount?.() ?? 0) > 0;
            if (initDone && fullRuns >= MIN_FULL_RUNS) ready = true;
            return r;
        }
        // centers は作り直さない。skeleton と bsWeight だけ更新する。
        try {
            if (v.useFlame === false) {
                v.skinModel?.skeleton?.update?.();
                v.boneRoot?.updateMatrixWorld?.(true);
            }
            v.splatMesh?.updateBoneMatrixTexture?.(v.useFlame === true);
            s.fastFrames++;
        } catch (e: any) {
            // §12: 黙って壊れた状態で継続しない。完全実行へ戻す。
            s.fallbackCount++;
            s.lastError = String(e?.message ?? e);
            ready = false;
            fullRuns = 0;
            console.warn('[PoC morphFast] fast-path で例外。完全実行へ戻します:', e);
        }
        return undefined;
    };
    s.applied = true;
    s.reason = 'runMorphUpdate を fast-path へ差し替えた (初期化完了までは完全実行)';
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
