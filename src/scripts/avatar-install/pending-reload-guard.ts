/**
 * pending version の renderer load に失敗したときの reload guard。
 *
 * pending (v4) のロードに失敗した場合、同じ session で renderer を作り直さず
 * reload して通常の active (v3) 起動に戻す。その際 **無限 reload を防ぐ**ため、
 * 「どの avatar のどの version で既に reload したか」を sessionStorage に持つ。
 *
 * ここは判断だけを持つ純関数にしてある (DOM / location に触らない)。
 */

export const PENDING_RELOAD_GUARD_PREFIX = 'avatarInstall.pendingReload.';

export interface GuardStore {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
}

export type GuardDecision =
    /** まだ reload していない version。reload してよい。 */
    | 'RELOAD'
    /** この version では既に reload 済み。もう reload しない。 */
    | 'ALREADY_RELOADED'
    /** guard を保持できない (sessionStorage 不可)。reload しない。 */
    | 'GUARD_UNAVAILABLE';

export function guardKey(avatarId: string): string {
    return PENDING_RELOAD_GUARD_PREFIX + avatarId;
}

/**
 * reload してよいかを判断し、よい場合は guard を立てる。
 * guard が立たなかったときは必ず `RELOAD` を返さない。
 */
export function markPendingReload(
    store: GuardStore | null | undefined,
    avatarId: string,
    version: string,
): GuardDecision {
    if (!store) return 'GUARD_UNAVAILABLE';
    const key = guardKey(avatarId);
    try {
        if (store.getItem(key) === version) return 'ALREADY_RELOADED';
    } catch (e) {
        return 'GUARD_UNAVAILABLE';
    }
    try {
        store.setItem(key, version);
    } catch (e) {
        return 'GUARD_UNAVAILABLE';
    }
    return 'RELOAD';
}

/** 正常に起動できたら guard を落とす (次の更新で再び 1 回 reload できる)。 */
export function clearPendingReload(
    store: GuardStore | null | undefined,
    avatarId: string,
): void {
    if (!store) return;
    try {
        store.removeItem(guardKey(avatarId));
    } catch (e) {
        // guard が消せなくても起動には影響しない。
    }
}

/** sessionStorage が使える環境ならそれを返す。使えなければ null。 */
export function defaultGuardStore(): GuardStore | null {
    try {
        if (typeof sessionStorage === 'undefined') return null;
        return sessionStorage;
    } catch (e) {
        return null;
    }
}
