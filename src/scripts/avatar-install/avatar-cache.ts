/**
 * Avatar ZIP 本体の保存先 (指示書 §5-1)。
 *
 * **Cache Storage だけ**を使う。IndexedDB には binary を入れない。
 * Workbox の precache (`globPatterns`) には一切触らない。25MB の ZIP を
 * 通常の precache へ入れてはいけない (指示書 §2)。ここはユーザーが
 * install を承認したときだけ書き込む専用 cache。
 *
 * Service Worker にも手を入れていない。Workbox の `runtimeCaching` で
 * CacheFirst を張ると **cache miss のときに 25MB を勝手に download** して
 * しまい指示書 §8 に反するので、取得は必ず Install Manager 経由にし、
 * renderer へは cache から作った blob URL を渡す。
 */

export const AVATAR_CACHE_NAME = 'travel-avatar-assets-v1';

export interface AvatarCache {
    /** 保存済みか */
    has(key: string): Promise<boolean>;
    /** 保存済み Response を取り出す */
    match(key: string): Promise<Response | undefined>;
    put(key: string, res: Response): Promise<void>;
    delete(key: string): Promise<boolean>;
    keys(): Promise<string[]>;
}

/** version まで含めた cache key。version が変われば別エントリになる。 */
export function cacheKeyFor(avatarId: string, version: string): string {
    return `avatar-package/${encodeURIComponent(avatarId)}/${encodeURIComponent(version)}`;
}

class CacheStorageAvatarCache implements AvatarCache {
    constructor(private readonly name: string) {}

    private open(): Promise<Cache> {
        return caches.open(this.name);
    }

    async has(key: string): Promise<boolean> {
        const c = await this.open();
        return (await c.match(key)) !== undefined;
    }

    async match(key: string): Promise<Response | undefined> {
        const c = await this.open();
        return c.match(key);
    }

    async put(key: string, res: Response): Promise<void> {
        const c = await this.open();
        await c.put(key, res);
    }

    async delete(key: string): Promise<boolean> {
        const c = await this.open();
        return c.delete(key);
    }

    async keys(): Promise<string[]> {
        const c = await this.open();
        return (await c.keys()).map((r) => r.url);
    }
}

export function createAvatarCache(name = AVATAR_CACHE_NAME): AvatarCache {
    return new CacheStorageAvatarCache(name);
}

/**
 * cache の Response から renderer へ渡せる URL を作る。
 *
 * 既存 renderer は `GaussianSplatRenderer.getInstance(div, assetUrl, ...)` という
 * URL ベースの contract を持つ。blob URL ならその contract を変えずに
 * ローカルの実体を渡せる。Service Worker の route を増やさずに済むので、
 * 「未インストールなのに勝手に 25MB を取りに行く」経路が原理的に作れない。
 */
export async function toObjectUrl(res: Response): Promise<string> {
    const blob = await res.blob();
    return URL.createObjectURL(blob);
}
