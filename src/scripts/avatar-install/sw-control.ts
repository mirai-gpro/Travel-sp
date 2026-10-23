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

export function isServiceWorkerSupported(): boolean {
    try {
        return typeof navigator !== 'undefined' && !!(navigator as any).serviceWorker;
    } catch (e) {
        return false;
    }
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
 *
 * **`ready()` の解決を待ってはいけない。** `navigator.serviceWorker.ready` は
 * active な registration が出来るまで解決しないので、install に失敗した SW が
 * 居る状態では永久に解決しない。await すると起動処理ごと停止する
 * (実機でアバターが出ないまま無言で止まる症状の原因)。
 * ここでは timeout を必ず効かせ、`ready()` は解決したら再確認するだけに使う。
 */
export async function waitForServiceWorkerControl(
    deps: SwControlDeps | null = defaultSwControlDeps(),
    timeoutMs: number = SW_CONTROL_WAIT_MS,
    schedule: (cb: () => void, ms: number) => unknown =
        (cb, ms) => setTimeout(cb, ms),
): Promise<boolean> {
    if (!deps) return false;
    if (deps.isControlled()) return true;

    return new Promise<boolean>((resolve) => {
        let settled = false;
        let off: () => void = () => {};
        const finish = (value: boolean) => {
            if (settled) return;
            settled = true;
            try { off(); } catch (e) { /* noop */ }
            resolve(value);
        };

        try {
            off = deps.onControllerChange(() => {
                if (deps.isControlled()) finish(true);
            });
        } catch (e) {
            // 購読できなくても timeout で必ず終わる。
        }

        // timeout は常に効かせる (ここだけが唯一の終了保証)。
        schedule(() => finish(deps.isControlled()), timeoutMs);

        // ready() は待たない。解決したときだけ制御を再確認する。
        void Promise.resolve()
            .then(() => deps.ready())
            .then(() => { if (deps.isControlled()) finish(true); })
            .catch(() => undefined);
    });
}
