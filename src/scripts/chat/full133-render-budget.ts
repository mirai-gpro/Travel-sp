// src/scripts/chat/full133-render-budget.ts
/**
 * FULL133 (`uika-full133-skin`) をスマホ級端末で開いたときだけ、
 * **drawing buffer の pixel density を 1.0 に落とす**。
 *
 * 変えるのはこれだけ。canvas の CSS サイズ / DOM layout / camera /
 * FOV / projection / avatar scale / Gaussian 数 / sort / morph /
 * predeform / skinning / shader / expression / 音声には一切触らない。
 * 画面上のアバターのサイズと構図は変わらず、内部レンダリング解像度だけ下がる。
 *
 * ── なぜ viewer.devicePixelRatio まで書き換えるのか ─────────────────
 * LAM renderer (gaussian-splat-renderer-for-lam@0.0.9-alpha.1) の build を
 * 実読して確認した事実:
 *
 *   Viewer は `options.ignoreDevicePixelRatio` で DPR 1 固定に出来る
 *     :136792-136795  this.ignoreDevicePixelRatio = options.ignoreDevicePixelRatio || false;
 *                     this.devicePixelRatio = this.ignoreDevicePixelRatio ? 1 : window.devicePixelRatio || 1;
 *
 *   ただし GaussianSplatRenderer.getInstance() は Viewer へ **リテラルの
 *   options** を渡しており、呼び出し側の option を転送しない
 *     :152280-152290  renderer.viewer = new Viewer({ rootElement, threejsCanvas, ... });
 *   → `getInstance` 経由では ignoreDevicePixelRatio を渡せないため、
 *     構築後に同じ状態を作る。node_modules は変更しない。
 *
 *   viewer.devicePixelRatio の参照箇所は 5 つだけで、うち 3 つは毎フレーム:
 *     :137068  createSplatMesh() で SplatMesh へ値を渡す     (構築時 1 回)
 *     :137158  this.renderer.setPixelRatio(this.devicePixelRatio)  (構築時 1 回)
 *     :137517  focalLengthX = ... * this.devicePixelRatio * renderDimensions.x
 *     :137522  focalLengthY = ... * this.devicePixelRatio * renderDimensions.y
 *     :137526  inverseFocalAdjustment = 1.0 / this.devicePixelRatio
 *   SplatMesh 側の参照は 1 つだけで、こちらも毎フレーム:
 *     :65171-65172  viewport.set(renderDimensions.x * this.devicePixelRatio, ...)
 *   SplatMesh の構築時に DPR からテクスチャ等を確定する処理は無い (:63746 で
 *   フィールドに保存するだけ)。
 *
 *   したがって buffer density だけ下げて focal/viewport を放置すると splat の
 *   スケールが合わなくなるため、3 箇所を同時に 1 に揃える。これは
 *   `ignoreDevicePixelRatio: true` で構築した場合と同じ状態になる。
 *
 * ── resize について ───────────────────────────────────────────────
 * Viewer の ResizeObserver は `setSize` だけを呼び、`setPixelRatio` を
 * 呼び直さない:
 *     :137164-137169  new ResizeObserver(() => { getRenderDimensions(...);
 *                       this.renderer.setSize(x, y); this.forceRenderNextFrame(); })
 * three.js の WebGLRenderer は pixel ratio を `_pixelRatio` に保持し、
 * `setSize` はそれを使って drawing buffer を計算する (:116185-116193)。
 * つまり resize / orientation change 後も 1.0 が維持されるので、
 * 監視ループ (setInterval / rAF 常時監視 / MutationObserver) は作らない。
 */

import { getAvatarIdForDiag } from './poc/render-perf';

/** この最適化を適用する唯一の avatar。 */
export const FULL133_AVATAR_ID = 'uika-full133-skin';

/** 落とし先の pixel density。今回の変数はこれ 1 つだけ。 */
export const FULL133_MOBILE_DPR = 1;

export interface Full133RenderBudgetStats {
    applied: boolean;
    reason: string;
    avatarId: string;
    mobile: boolean;
    deviceDPR: number;
    effectiveDPR: number;
    cssWidth: number;
    cssHeight: number;
    bufferWidth: number;
    bufferHeight: number;
}

/**
 * スマホ級の touch 端末かどうか。
 *
 * 目的は「スマホ級 touch 端末」と「desktop PC」の区別だけで、
 * この判定を他システムへ展開しない (FULL133 の DPR 制御専用)。
 * UA 文字列だけに依存しないよう、pointer 粒度と touch point 数を見る。
 * 既存の共通 mobile 判定はリポジトリに無かったため局所的に置く
 * (`ShopCardList.astro` のものは .astro 内のローカル関数で import 不可、
 *  かつ UA 正規表現と innerWidth のみ)。
 */
export function isMobileClassDevice(w?: any): boolean {
    const win = w ?? (typeof window === 'undefined' ? undefined : window);
    if (!win) return false;
    try {
        const coarse = typeof win.matchMedia === 'function'
            && win.matchMedia('(any-pointer: coarse)').matches === true;
        const touch = Number(win.navigator?.maxTouchPoints ?? 0) > 0;
        return coarse && touch;
    } catch {
        return false;
    }
}

/** LAMAvatar.astro:180 と同じ判定。hidden PoC 経路は対象外にする。 */
function isUika133kHiddenRoute(w?: any): boolean {
    const win = w ?? (typeof window === 'undefined' ? undefined : window);
    if (!win) return false;
    try {
        return new URLSearchParams(win.location.search).get('uika133k') === '1';
    } catch {
        return false;
    }
}

function readSizes(stats: Full133RenderBudgetStats, three: any): void {
    try {
        const el = three?.domElement;
        stats.cssWidth = Number(el?.clientWidth ?? 0);
        stats.cssHeight = Number(el?.clientHeight ?? 0);
        const gl = typeof three?.getContext === 'function' ? three.getContext() : null;
        stats.bufferWidth = Number(gl?.drawingBufferWidth ?? 0);
        stats.bufferHeight = Number(gl?.drawingBufferHeight ?? 0);
    } catch {
        /* 診断値なので失敗は無視する */
    }
}

function apply(renderer: any, stats: Full133RenderBudgetStats, w?: any): void {
    const win = w ?? (typeof window === 'undefined' ? undefined : window);
    const v = renderer?.viewer;
    const three = v?.renderer;

    stats.avatarId = getAvatarIdForDiag();
    stats.mobile = isMobileClassDevice(win);
    stats.deviceDPR = Number(win?.devicePixelRatio ?? 1) || 1;
    stats.effectiveDPR = Number(v?.devicePixelRatio ?? stats.deviceDPR);
    readSizes(stats, three);

    if (isUika133kHiddenRoute(win)) {
        stats.reason = '?uika133k=1 の hidden PoC 経路は対象外';
        return;
    }
    if (stats.avatarId !== FULL133_AVATAR_ID) {
        stats.reason = `FULL133 専用。avatarId=${stats.avatarId} のため適用しない`;
        return;
    }
    if (!stats.mobile) {
        stats.reason = 'desktop 判定のため適用しない (PC は現状維持)';
        return;
    }
    if (!v || !three || typeof three.setPixelRatio !== 'function') {
        stats.reason = 'viewer / three renderer が見つからない';
        return;
    }
    if (v.__full133RenderBudgetApplied) {
        stats.reason = 'すでに適用済み';
        return;
    }

    // focal length (:137517/:137522/:137526) と viewport (:65171) が
    // 参照する値を揃えてから drawing buffer を縮める。
    v.devicePixelRatio = FULL133_MOBILE_DPR;
    if (v.splatMesh) v.splatMesh.devicePixelRatio = FULL133_MOBILE_DPR;
    three.setPixelRatio(FULL133_MOBILE_DPR);

    v.__full133RenderBudgetApplied = true;
    stats.applied = true;
    stats.reason = `drawing buffer の pixel density を ${FULL133_MOBILE_DPR} に制限した`;
    stats.effectiveDPR = FULL133_MOBILE_DPR;
    readSizes(stats, three);
}

/**
 * FULL133 + スマホのときだけ drawing buffer の DPR を 1.0 にする。
 * それ以外の avatar / 端末では何もしない。例外は投げない。
 */
export async function installFull133RenderBudget(
    renderer: any, maxTries = 600,
): Promise<Full133RenderBudgetStats> {
    const win: any = typeof window === 'undefined' ? undefined : window;
    const stats: Full133RenderBudgetStats = {
        applied: false, reason: '', avatarId: '',
        mobile: false,
        deviceDPR: Number(win?.devicePixelRatio ?? 1) || 1,
        effectiveDPR: Number(win?.devicePixelRatio ?? 1) || 1,
        cssWidth: 0, cssHeight: 0, bufferWidth: 0, bufferHeight: 0,
    };
    if (win) win.__full133RenderBudget = stats;

    // FULL133 でない / desktop のときは待たずに抜ける (他経路を遅らせない)。
    if (getAvatarIdForDiag() !== FULL133_AVATAR_ID
        || !isMobileClassDevice(win)
        || isUika133kHiddenRoute(win)) {
        apply(renderer, stats, win);
        return stats;
    }

    return await new Promise<Full133RenderBudgetStats>((resolve) => {
        let tries = 0;
        const tick = () => {
            const three = renderer?.viewer?.renderer;
            const ready = !!three && typeof three.setPixelRatio === 'function'
                && !!renderer?.viewer?.splatMesh;
            if (ready || ++tries >= maxTries) {
                apply(renderer, stats, win);
                resolve(stats);
                return;
            }
            if (typeof requestAnimationFrame === 'function') requestAnimationFrame(tick);
            else setTimeout(tick, 16);
        };
        tick();
    });
}
