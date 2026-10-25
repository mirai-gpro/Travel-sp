// src/scripts/legacy-avatar-install-cleanup.ts
//
// PR #85〜#87 で一度導入し、その後 Git 側を rollback した
// avatar local install 機構 (`src/scripts/avatar-install/**` /
// `public/sw-avatar-local.js`) が **端末側に残した状態だけ** を 1 回消す。
//
// Git の rollback では端末の Cache Storage / IndexedDB / sessionStorage は
// 消えない。旧実装が残っていると、現行 PWA の Service Worker 更新や
// avatar asset の取得に旧状態が混ざり得るため、ここで明示的に掃除する。
//
// やること (これだけ):
//   1. Cache Storage の 'travel-avatar-assets-v1' を削除
//   2. IndexedDB の 'travel-avatar-install' を削除
//   3. sessionStorage の 'avatarInstall.pendingReload.' で始まるキーを削除
//
// やらないこと:
//   - localStorage は読み取りのみ。1 件も削除・変更しない
//     (selectedAvatar_* / selectedAvatarUrl_* / selectedVoiceModel_* /
//      selectedLiveVoice_* / selectedTeacherName_* / selectedCamera_* など
//      既存のユーザー設定は保持する)
//   - Service Worker の unregister は一切しない (Travel-sp 本来の PWA を壊す)
//   - 他の Cache Storage / 他の IndexedDB には触らない
//   - avatar asset の取得方法 / renderer / 音声 / expression には関与しない
//
// 名前の出典 (PR #87 時点の実装を実読):
//   travel-avatar-assets-v1      public/sw-avatar-local.js:19 (CACHE_NAME)
//                                src/scripts/avatar-install/avatar-cache.ts:22
//   travel-avatar-install        src/scripts/avatar-install/avatar-install-registry.ts:68
//   avatarInstall.pendingReload. src/scripts/avatar-install/pending-reload-guard.ts:11
//
// 旧実装に localStorage の使用は無かった (avatar-install/** と
// sw-avatar-local.js を grep して 0 件) ため、localStorage は対象外。

/** 旧 avatar install が使っていた Cache Storage 名。これ以外は削除しない。 */
export const LEGACY_AVATAR_CACHE_NAME = 'travel-avatar-assets-v1';

/** 旧 avatar install registry の IndexedDB 名。これ以外は削除しない。 */
export const LEGACY_AVATAR_REGISTRY_DB_NAME = 'travel-avatar-install';

/** 旧 pending reload guard の sessionStorage キー接頭辞。 */
export const LEGACY_PENDING_RELOAD_PREFIX = 'avatarInstall.pendingReload.';

export interface LegacyCleanupResult {
    /** 実際に掃除処理を走らせたか (gate を通ったか)。 */
    ran: boolean;
    /** Cache Storage を削除したか。 */
    cacheDeleted: boolean;
    /** IndexedDB の deleteDatabase を呼んだか。 */
    dbDeleteAttempted: boolean;
    /** IndexedDB の削除が success で終わったか。 */
    dbDeleted: boolean;
    /** 削除した sessionStorage のキー。 */
    removedSessionKeys: string[];
    /** 例外は投げずここへ積む。呼び出し側はアプリ起動を止めない。 */
    errors: string[];
}

export interface LegacyCleanupDeps {
    cacheStorage?: CacheStorage | null;
    indexedDB?: IDBFactory | null;
    sessionStorage?: Storage | null;
}

function pickDefaultDeps(): LegacyCleanupDeps {
    const w: any = typeof window === 'undefined' ? undefined : (window as any);
    const pick = (get: () => any) => {
        // Safari の private mode などで getter 自体が throw することがある。
        try {
            return get() ?? null;
        } catch {
            return null;
        }
    };
    return {
        cacheStorage: pick(() => w && w.caches),
        indexedDB: pick(() => w && w.indexedDB),
        sessionStorage: pick(() => w && w.sessionStorage),
    };
}

async function deleteLegacyCache(
    cacheStorage: CacheStorage | null | undefined,
    errors: string[],
): Promise<boolean> {
    if (!cacheStorage) return false;
    try {
        const names = await cacheStorage.keys();
        // 完全一致のみ。前方一致・部分一致は使わない。
        if (!names.includes(LEGACY_AVATAR_CACHE_NAME)) return false;
        return (await cacheStorage.delete(LEGACY_AVATAR_CACHE_NAME)) === true;
    } catch (e) {
        errors.push(`cacheStorage: ${String(e)}`);
        return false;
    }
}

/**
 * 旧 registry の IndexedDB を削除する。
 *
 * onblocked でも resolve するので、この Promise は必ず settle する
 * (アプリ起動を無期限に待たせない)。存在しない DB への deleteDatabase は
 * 仕様上 no-op で success になるため、事前の存在確認はしない
 * (`indexedDB.databases()` の可用性に依存させない)。
 */
function deleteLegacyRegistryDb(
    idb: IDBFactory | null | undefined,
    errors: string[],
): Promise<{ attempted: boolean; deleted: boolean }> {
    return new Promise((resolve) => {
        if (!idb) {
            resolve({ attempted: false, deleted: false });
            return;
        }
        let req: IDBOpenDBRequest;
        try {
            req = idb.deleteDatabase(LEGACY_AVATAR_REGISTRY_DB_NAME);
        } catch (e) {
            errors.push(`indexedDB.deleteDatabase: ${String(e)}`);
            resolve({ attempted: false, deleted: false });
            return;
        }
        req.onsuccess = () => resolve({ attempted: true, deleted: true });
        req.onerror = () => {
            errors.push('indexedDB.deleteDatabase: error');
            resolve({ attempted: true, deleted: false });
        };
        req.onblocked = () => {
            errors.push('indexedDB.deleteDatabase: blocked');
            resolve({ attempted: true, deleted: false });
        };
    });
}

function removeLegacySessionKeys(
    ss: Storage | null | undefined,
    errors: string[],
): string[] {
    const removed: string[] = [];
    if (!ss) return removed;
    try {
        const targets: string[] = [];
        for (let i = 0; i < ss.length; i++) {
            const k = ss.key(i);
            if (k && k.indexOf(LEGACY_PENDING_RELOAD_PREFIX) === 0) targets.push(k);
        }
        for (const k of targets) {
            ss.removeItem(k);
            removed.push(k);
        }
    } catch (e) {
        errors.push(`sessionStorage: ${String(e)}`);
    }
    return removed;
}

/**
 * UIKA 系アバターで起動しているかどうか。
 *
 * 判定は `src/components/LAMAvatar.astro` の実装と同じものを使う:
 *   - `?uika133k=1`                     → hidden PoC (`/avatar/uika-gakki-133k.zip`)
 *   - `selectedAvatarUrl_<mode>`        → avatar-config 経路 (`mode` の求め方も同じ)
 * どちらも読み取りのみ。localStorage へは書き込まない。
 */
export function isUikaAvatarRoute(
    loc?: { search: string; pathname: string },
    localStore?: Pick<Storage, 'getItem'> | null,
): boolean {
    const w: any = typeof window === 'undefined' ? undefined : (window as any);
    const location = loc ?? (w ? w.location : undefined);
    if (!location) return false;

    try {
        if (new URLSearchParams(location.search).get('uika133k') === '1') return true;
    } catch {
        /* noop */
    }

    try {
        let store = localStore;
        if (store === undefined) store = w ? w.localStorage : null;
        if (!store) return false;
        // LAMAvatar.astro:122 と同じ mode 判定
        const mode = location.pathname.indexOf('concierge') !== -1 ? 'concierge' : 'lesson';
        const url = store.getItem(`selectedAvatarUrl_${mode}`) || '';
        return /uika/i.test(url);
    } catch {
        return false;
    }
}

/**
 * 掃除本体。gate も once ガードも見ないので、テストからはこちらを直接呼ぶ。
 * 例外は投げない。
 */
export async function cleanupLegacyAvatarInstall(
    deps?: LegacyCleanupDeps,
): Promise<LegacyCleanupResult> {
    const d = deps ?? pickDefaultDeps();
    const errors: string[] = [];

    const cacheDeleted = await deleteLegacyCache(d.cacheStorage, errors);
    const db = await deleteLegacyRegistryDb(d.indexedDB, errors);
    const removedSessionKeys = removeLegacySessionKeys(d.sessionStorage, errors);

    return {
        ran: true,
        cacheDeleted,
        dbDeleteAttempted: db.attempted,
        dbDeleted: db.deleted,
        removedSessionKeys,
        errors,
    };
}

let alreadyRan = false;

/**
 * ページ entry から 1 回だけ呼ぶ入口。
 * UIKA 系で起動していないときは何もしない。例外は投げない。
 */
export async function runLegacyAvatarInstallCleanupIfNeeded(): Promise<LegacyCleanupResult> {
    const skipped: LegacyCleanupResult = {
        ran: false,
        cacheDeleted: false,
        dbDeleteAttempted: false,
        dbDeleted: false,
        removedSessionKeys: [],
        errors: [],
    };
    try {
        if (alreadyRan) return skipped;
        if (!isUikaAvatarRoute()) return skipped;
        alreadyRan = true;
        const r = await cleanupLegacyAvatarInstall();
        if (r.cacheDeleted || r.dbDeleted || r.removedSessionKeys.length > 0 || r.errors.length > 0) {
            console.log(
                '[LegacyAvatarInstallCleanup] '
                + `cache=${r.cacheDeleted} db=${r.dbDeleted} `
                + `session=${r.removedSessionKeys.length}`
                + (r.errors.length ? ` errors=${JSON.stringify(r.errors)}` : ''),
            );
        }
        return r;
    } catch (e) {
        // ここへ来ても起動は止めない。
        console.warn('[LegacyAvatarInstallCleanup] skipped:', e);
        return skipped;
    }
}
