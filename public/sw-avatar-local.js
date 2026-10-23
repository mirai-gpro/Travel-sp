/**
 * Avatar local package の cache-only route。
 *
 * 生成 Service Worker (Workbox generateSW) の先頭で `importScripts` される。
 * Workbox 側の route 定義には触らない加算だけの拡張。
 *
 * 役割はひとつだけ:
 *   `/avatar/local/<avatarId>/<version>.zip` への GET を
 *   Cache Storage `travel-avatar-assets-v1` からのみ返す。
 *
 * **network へは絶対に出ない。** miss のときは 504 を返す。
 * 未インストール状態で 25MB を暗黙に download する経路を作らないため
 * (指示書 §8)。実体の取得は必ず Install Manager の承認済み download だけ。
 *
 * ここで使う定数は `src/scripts/avatar-install/avatar-cache.ts` と一致させる
 * (tools/poc-tests/avatar-install.spec.cjs が両ファイルを読んで検証する)。
 */
(function () {
    var CACHE_NAME = 'travel-avatar-assets-v1';
    var PREFIX = '/avatar/local/';

    self.addEventListener('fetch', function (event) {
        var req = event && event.request;
        if (!req || req.method !== 'GET') return;

        var path;
        try {
            path = new URL(req.url).pathname;
        } catch (e) {
            return;
        }
        if (path.indexOf(PREFIX) !== 0) return;   // 他の route には一切干渉しない

        event.respondWith((async function () {
            try {
                var cache = await self.caches.open(CACHE_NAME);
                var hit = await cache.match(path);
                if (hit) return hit;
            } catch (e) {
                // cache が読めない場合も network へは出ない。
            }
            return new Response(null, {
                status: 504,
                statusText: 'avatar package not cached',
            });
        })());
    });
})();
