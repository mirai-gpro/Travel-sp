/**
 * Avatar ZIP 本体の保存先 (指示書 §5-1)。
 *
 * **Cache Storage だけ**を使う。IndexedDB には binary を入れない。
 * Workbox の precache (`globPatterns`) には一切触らない。25MB の ZIP を
 * 通常の precache へ入れてはいけない (指示書 §2)。ここはユーザーが
 * install を承認したときだけ書き込む専用 cache。
 *
 * renderer への受け渡しは **cache-only の Service Worker route** 経由にする。
 * renderer (`GaussianSplatRenderer.getInstance`) は asset URL の pathname が
 * `/<name>.zip` に一致することを要求するため (bundle 実コードの
 * `pathname.match(/\/([^/]+?)\.zip/)`)、blob URL では起動できない。
 *
 * ただし Workbox の `runtimeCaching` CacheFirst は使わない。cache miss のときに
 * 25MB を勝手に download してしまい指示書 §8 に反する。代わりに
 * `public/sw-avatar-local.js` が `/avatar/local/` だけを **cache からのみ**返し、
 * miss では network へ出さずエラーにする。この合成 path はサーバー上に実体が
 * 無いので、SW が居ない場合でも 25MB の暗黙 download は起こらない
 * (404 になり、通常の RECOVERY 経路へ落ちる)。
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
 * local package を renderer へ渡すための合成 URL。
 *
 * 条件:
 *   - pathname が `/<name>.zip` に一致すること (renderer の必須チェック)
 *   - サーバー上に実体が無い path であること (暗黙 download を作らない)
 *   - origin root からの絶対 pathname であること。相対にすると `/` と
 *     `/concierge` で別 URL へ解決され、Registry は共通なのに Cache だけが
 *     route 依存になる (同じ端末で 2 回 download する)
 *   - version を含むこと。version が変われば別エントリになる
 *
 * `sw-avatar-local.js` の `PREFIX` と必ず一致させる (spec で検証)。
 */
export const LOCAL_PACKAGE_PATH_PREFIX = '/avatar/local/';

export function localPackageUrl(avatarId: string, version: string): string {
    return `${LOCAL_PACKAGE_PATH_PREFIX}${encodeURIComponent(avatarId)}`
        + `/${encodeURIComponent(version)}.zip`;
}

/**
 * cache key。**起動 URL と同一文字列**にしてある。
 *
 * こうすると Service Worker 側は path を解釈せず `cache.match(pathname)` を
 * 引くだけでよく、「key の作り方」が 2 箇所に分かれない。
 */
export function cacheKeyFor(avatarId: string, version: string): string {
    return localPackageUrl(avatarId, version);
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
 * cache の Response から blob URL を作る。
 *
 * **現在、起動経路では使っていない。** renderer が asset URL の pathname に
 * `.zip` を要求するため、起動には `localPackageUrl()` + cache-only SW route を
 * 使う。削除はユーザー承認待ちのため残している。
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
