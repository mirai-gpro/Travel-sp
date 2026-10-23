/**
 * local package の配送に Service Worker の制御が必要かを扱う。
 *
 * local package は cache-only の SW route (`/avatar/local/`) 経由で renderer へ
 * 渡すため、**その page が SW に制御されていること**が前提になる。初回訪問直後は
 * 登録直後で controller がまだ付いていないことがあるので、少しだけ待つ。
 *
 * 生成 SW は `clientsClaim` / `skipWaiting` 入りなので、active 化したら既存
 * client を claim し `controllerchange` が飛ぶ。待っても付かない場合は
 * **自動 reload せず**、呼び出し側が再読み込みを案内する。
 */

/** 制御が付くのを待つ上限。計測値ではなく UI の待ち時間予算。 */
export const SW_CONTROL_WAIT_MS = 3000;

export interface SwControlDeps {
    isControlled: () => boolean;
    /** registration の active を待つ (失敗しても無視する) */
    ready: () => Promise<unknown>;
    /** controllerchange 購読。解除関数を返す。 */
    onControllerChange: (cb: () => void) => () => void;
}

export function defaultSwControlDeps(): SwControlDeps | null {
    try {
        if (typeof navigator === 'undefined') return null;
        const sw = (navigator as any).serviceWorker;
        if (!sw) return null;
        return {
            isControlled: () => !!sw.controller,
            ready: () => sw.ready,
            onControllerChange: (cb: () => void) => {
                sw.addEventListener('controllerchange', cb);
                return () => sw.removeEventListener('controllerchange', cb);
            },
        };
    } catch (e) {
        return null;
    }
}

/**
 * SW の制御が得られたら true。得られなければ false (reload 案内へ回す)。
 * SW が使えない環境でも throw しない。
 */
export async function waitForServiceWorkerControl(
    deps: SwControlDeps | null = defaultSwControlDeps(),
    timeoutMs: number = SW_CONTROL_WAIT_MS,
    schedule: (cb: () => void, ms: number) => unknown =
        (cb, ms) => setTimeout(cb, ms),
): Promise<boolean> {
    if (!deps) return false;
    if (deps.isControlled()) return true;

    let off: () => void = () => {};
    const changed = new Promise<boolean>((resolve) => {
        off = deps.onControllerChange(() => resolve(deps.isControlled()));
    });
    const timedOut = new Promise<boolean>((resolve) => {
        schedule(() => resolve(false), timeoutMs);
    });
    try {
        await deps.ready().catch(() => undefined);
        if (deps.isControlled()) return true;
        return await Promise.race([changed, timedOut]);
    } catch (e) {
        return deps.isControlled();
    } finally {
        try { off(); } catch (e) { /* noop */ }
    }
}
