// src/scripts/chat/startup/avatar-prepare.ts
/**
 * Avatar prepare の **唯一の所有者** (指示書 §5 / §6)。
 *
 * - LAMAvatarController の生成を固定 sleep / ポーリングで待たない。
 *   生成側が `registerAvatarController()` を呼び、ここで resolve する (§6)。
 * - prepare は single-flight。何度呼ばれても同じ Promise を返す (§4 / §5)。
 *   reset #1 / reset #2 / Lesson / Concierge は新しく initialize せず、
 *   この Promise を await するだけにする。
 *
 * ここでは session / A2E / audio の制御を一切行わない。
 */

import { mark } from './startup-metrics';

let registered: any = null;
let resolveController: ((c: any) => void) | null = null;
const controllerReady: Promise<any> = new Promise<any>((resolve) => {
    resolveController = resolve;
});

/** LAMAvatarController の生成時に 1 度だけ呼ぶ。 */
export function registerAvatarController(controller: any): void {
    if (registered) return;
    registered = controller;
    resolveController?.(controller);
}

/** 生成済みなら即、未生成なら生成時に resolve する Promise。 */
export function waitForAvatarController(): Promise<any> {
    return controllerReady;
}

/** 同期的に取得する (無ければ null)。待ちたい場合は waitForAvatarController()。 */
export function getAvatarController(): any | null {
    return registered;
}

let preparePromise: Promise<void> | null = null;

/**
 * Avatar の download / renderer 初期化を先行開始する。
 * 2 回目以降の呼び出しは同じ Promise を返す (二重初期化を作らない)。
 */
export function startAvatarPrepare(liveAudioManager: any): Promise<void> {
    if (preparePromise) return preparePromise;
    mark('AVATAR_PREPARE_START');
    preparePromise = waitForAvatarController()
        .then((controller) => controller.initialize(liveAudioManager))
        .catch((e) => {
            // 失敗を resolve 扱いにしない。呼び出し側が「連携完了」と
            // 誤認しないよう上位へ伝える (指示書 修正 2)。
            // LAMAvatarController.doInitialize() 内の 2D fallback 処理は
            // 従来どおりで、ここでは何も変えない。
            console.error('[Startup] Avatar prepare エラー:', e);
            throw e;
        });
    return preparePromise;
}

// ===== Avatar の状態通知 (指示書 §7) =====
// renderer 初期化完了 (READY) か 2D フォールバック (FALLBACK) のどちらかで
// 必ず settle する。StartupCoordinator はこれを待ってから実描画 frame を見る。

export type AvatarSettleKind = 'READY' | 'FALLBACK';

let settled: AvatarSettleKind | null = null;
let resolveSettled: ((k: AvatarSettleKind) => void) | null = null;
const avatarSettled: Promise<AvatarSettleKind> = new Promise<AvatarSettleKind>((r) => {
    resolveSettled = r;
});

/** renderer 初期化が完了した (3D が出せる状態)。LAMAvatar から 1 度だけ呼ぶ。 */
export function notifyAvatarReady(): void {
    if (settled) return;
    settled = 'READY';
    resolveSettled?.('READY');
}

/** 3D を諦めて 2D フォールバックに切り替えた。LAMAvatar から 1 度だけ呼ぶ。 */
export function notifyAvatarFallback(): void {
    if (settled) return;
    settled = 'FALLBACK';
    resolveSettled?.('FALLBACK');
}

/** READY / FALLBACK のどちらかで settle する Promise。 */
export function waitAvatarSettled(): Promise<AvatarSettleKind> {
    return avatarSettled;
}

/** 同期取得 (未 settle なら null)。 */
export function getAvatarSettleKind(): AvatarSettleKind | null {
    return settled;
}

/** 既に開始済みの prepare Promise (未開始なら null)。 */
export function getAvatarPreparePromise(): Promise<void> | null {
    return preparePromise;
}
