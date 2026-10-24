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
            console.error('[Startup] Avatar prepare エラー:', e);
        });
    return preparePromise;
}

/** 既に開始済みの prepare Promise (未開始なら null)。 */
export function getAvatarPreparePromise(): Promise<void> | null {
    return preparePromise;
}
