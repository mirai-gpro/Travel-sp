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

/**
 * version まで含めた cache key。version が変われば別エントリになる。
 *
 * **必ず origin root からの絶対 pathname にする。** 相対 key にすると
 * `/` と `/concierge` で別 URL へ解決され、Registry は共通なのに Cache だけが
 * route 依存になってしまう (同じ端末で 2 回 download する)。
 */
export function cacheKeyFor(avatarId: string, version: string): string {
    return `/__avatar-package__/${encodeURIComponent(avatarId)}/${encodeURIComponent(version)}`;
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

/**
 * blob URL の所有権を 1 箇所に持つ。
 *
 * `URL.createObjectURL()` したものを永久に保持しない。差し替え / retry /
 * 破棄のたびに前のものを必ず `revokeObjectURL()` する。
 *
 * ロード完了直後の即時 revoke は採っていない。installed renderer の
 * progressive load 経路が、返した promise の解決後に同じ URL を
 * 再度読まないことを build 済み bundle から断定できなかったため。
 */
export class ObjectUrlOwner {
    private current: string | null = null;
    /** 解放した URL (テスト / 診断用) */
    readonly revoked: string[] = [];

    constructor(private readonly revoke: (url: string) => void =
        (u) => URL.revokeObjectURL(u)) {}

    /** 新しい URL を所有する。前のものは解放する。 */
    own(url: string): string {
        this.release();
        this.current = url;
        return url;
    }

    get value(): string | null {
        return this.current;
    }

    /** 現在の URL を解放する。二重解放しない。 */
    release(): void {
        if (this.current === null) return;
        const url = this.current;
        this.current = null;
        try {
            this.revoke(url);
            this.revoked.push(url);
        } catch (e) {
            // 解放できなくても起動は続ける。
        }
    }
}
