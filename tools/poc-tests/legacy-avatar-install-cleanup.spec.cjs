// tools/poc-tests/legacy-avatar-install-cleanup.spec.cjs
//
// 旧 avatar install (PR #85-#87) の端末残骸だけを消すことを固定する。
// 「指定の 1 件だけ消し、他は残す」が要点。
//
// 実行:
//   npx esbuild src/scripts/legacy-avatar-install-cleanup.ts --bundle --format=cjs \
//     --platform=node --outfile=tools/poc-tests/.legacy-cleanup.cjs
//   node tools/poc-tests/legacy-avatar-install-cleanup.spec.cjs

let failures = 0;
const ok = (cond, name, extra) => {
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
    if (!cond) failures++;
};

function load() {
    delete require.cache[require.resolve('./.legacy-cleanup.cjs')];
    return require('./.legacy-cleanup.cjs');
}

// ---- fakes -------------------------------------------------------------
function makeCacheStorage(names) {
    const set = new Set(names);
    return {
        _names: set,
        async keys() { return [...set]; },
        async delete(n) { return set.delete(n); },
    };
}

function makeIndexedDb(opts = {}) {
    const calls = [];
    return {
        _calls: calls,
        deleteDatabase(name) {
            calls.push(name);
            const req = {};
            setTimeout(() => {
                if (opts.mode === 'blocked' && req.onblocked) req.onblocked();
                else if (opts.mode === 'error' && req.onerror) req.onerror();
                else if (req.onsuccess) req.onsuccess();
            }, 0);
            return req;
        },
    };
}

function makeStorage(obj) {
    const map = new Map(Object.entries(obj));
    return {
        _map: map,
        get length() { return map.size; },
        key(i) { return [...map.keys()][i] ?? null; },
        getItem(k) { return map.has(k) ? map.get(k) : null; },
        setItem(k, v) { map.set(k, String(v)); },
        removeItem(k) { map.delete(k); },
    };
}

(async () => {
    const m = load();

    // ---- 名前が実装の Source of Truth と一致していること ----------------
    ok(m.LEGACY_AVATAR_CACHE_NAME === 'travel-avatar-assets-v1',
       'Cache Storage 名は travel-avatar-assets-v1', m.LEGACY_AVATAR_CACHE_NAME);
    ok(m.LEGACY_AVATAR_REGISTRY_DB_NAME === 'travel-avatar-install',
       'IndexedDB 名は travel-avatar-install', m.LEGACY_AVATAR_REGISTRY_DB_NAME);
    ok(m.LEGACY_PENDING_RELOAD_PREFIX === 'avatarInstall.pendingReload.',
       'sessionStorage 接頭辞は avatarInstall.pendingReload.', m.LEGACY_PENDING_RELOAD_PREFIX);

    // ---- Cache Storage: 対象 1 件だけ削除 ------------------------------
    {
        const cs = makeCacheStorage([
            'travel-avatar-assets-v1',
            'workbox-precache-v2-https://travel-sp.vercel.app/',
            'travel-avatar-assets-v2',
            'other-cache',
        ]);
        const ss = makeStorage({});
        const r = await m.cleanupLegacyAvatarInstall({
            cacheStorage: cs, indexedDB: makeIndexedDb(), sessionStorage: ss,
        });
        const left = [...cs._names];
        ok(r.cacheDeleted === true, '★ travel-avatar-assets-v1 を削除した');
        ok(!left.includes('travel-avatar-assets-v1'), '対象 cache が消えている');
        ok(left.includes('workbox-precache-v2-https://travel-sp.vercel.app/'),
           '★ workbox precache は残る');
        ok(left.includes('travel-avatar-assets-v2'),
           '★ 名前が似ているだけの cache (v2) は残る', JSON.stringify(left));
        ok(left.includes('other-cache'), 'その他の cache は残る');
        ok(left.length === 3, '削除されたのは 1 件だけ', `残り=${left.length}`);
    }

    // ---- Cache Storage: 対象が無ければ何も削除しない --------------------
    {
        const cs = makeCacheStorage(['workbox-precache-v2', 'other-cache']);
        const r = await m.cleanupLegacyAvatarInstall({
            cacheStorage: cs, indexedDB: makeIndexedDb(), sessionStorage: makeStorage({}),
        });
        ok(r.cacheDeleted === false, '対象 cache が無いときは削除しない');
        ok([...cs._names].length === 2, '他の cache は 2 件とも残る');
    }

    // ---- IndexedDB: 対象 1 件だけに deleteDatabase ---------------------
    {
        const idb = makeIndexedDb();
        const r = await m.cleanupLegacyAvatarInstall({
            cacheStorage: makeCacheStorage([]), indexedDB: idb, sessionStorage: makeStorage({}),
        });
        ok(idb._calls.length === 1, '★ deleteDatabase の呼び出しは 1 回だけ',
           JSON.stringify(idb._calls));
        ok(idb._calls[0] === 'travel-avatar-install',
           '★ 対象は travel-avatar-install のみ', idb._calls[0]);
        ok(r.dbDeleted === true, 'success で dbDeleted=true');
    }

    // ---- IndexedDB: blocked / error でも必ず settle し例外も投げない -----
    for (const mode of ['blocked', 'error']) {
        const idb = makeIndexedDb({ mode });
        const r = await m.cleanupLegacyAvatarInstall({
            cacheStorage: makeCacheStorage([]), indexedDB: idb, sessionStorage: makeStorage({}),
        });
        ok(r.dbDeleted === false && r.dbDeleteAttempted === true,
           `deleteDatabase ${mode} でも resolve して dbDeleted=false`);
        ok(r.errors.length === 1, `${mode} は errors に記録される`, JSON.stringify(r.errors));
    }

    // ---- sessionStorage: 接頭辞一致のみ削除 ----------------------------
    {
        const ss = makeStorage({
            'avatarInstall.pendingReload.uika-full133-skin': '1',
            'avatarInstall.pendingReload.other': '1',
            'avatarInstall.other': '1',
            'xavatarInstall.pendingReload.y': '1',
            'someAppState': '1',
        });
        const r = await m.cleanupLegacyAvatarInstall({
            cacheStorage: makeCacheStorage([]), indexedDB: makeIndexedDb(), sessionStorage: ss,
        });
        const left = [...ss._map.keys()];
        ok(r.removedSessionKeys.length === 2,
           '★ 接頭辞一致の 2 件だけ削除', JSON.stringify(r.removedSessionKeys));
        ok(left.includes('avatarInstall.other'),
           '★ 接頭辞が違う avatarInstall.other は残る');
        ok(left.includes('xavatarInstall.pendingReload.y'),
           '★ 前方一致でない (途中に含むだけ) キーは残る');
        ok(left.includes('someAppState'), '無関係な sessionStorage は残る');
        ok(left.length === 3, '残りは 3 件', JSON.stringify(left));
    }

    // ---- localStorage は引数にも取らない = 触れない --------------------
    {
        const r = await m.cleanupLegacyAvatarInstall({
            cacheStorage: makeCacheStorage([]), indexedDB: makeIndexedDb(),
            sessionStorage: makeStorage({}),
        });
        ok(!('localStorage' in r), '★ 結果に localStorage の項目が無い');
        const src = require('fs').readFileSync(
            'src/scripts/legacy-avatar-install-cleanup.ts', 'utf8');
        const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
        ok(!/localStorage\.(removeItem|setItem|clear)/.test(code),
           '★ localStorage への書き込み/削除がソースに存在しない');
        ok(!/\.unregister\s*\(/.test(code),
           '★ serviceWorker.unregister() がソースに存在しない');
    }

    // ---- 全 API が無い環境でも例外を投げない --------------------------
    {
        const r = await m.cleanupLegacyAvatarInstall({
            cacheStorage: null, indexedDB: null, sessionStorage: null,
        });
        ok(r.ran === true && r.cacheDeleted === false && r.dbDeleted === false
           && r.removedSessionKeys.length === 0,
           'API 不在でも例外なく no-op で終わる', JSON.stringify(r));
    }

    // ---- gate: UIKA 経路の判定 (LAMAvatar.astro と同じ方法) ------------
    {
        const ls = (url) => makeStorage(url ? { 'selectedAvatarUrl_concierge': url } : {});
        ok(m.isUikaAvatarRoute({ search: '?uika133k=1', pathname: '/' }, ls(null)) === true,
           '★ ?uika133k=1 は UIKA 経路');
        ok(m.isUikaAvatarRoute({ search: '', pathname: '/concierge' },
                               ls('/avatar/uika-full133-skin.zip')) === true,
           '★ selectedAvatarUrl_concierge が uika-full133-skin なら UIKA 経路');
        ok(m.isUikaAvatarRoute({ search: '', pathname: '/concierge' },
                               ls('/avatar/meruru.zip')) === false,
           '★ LAM (meruru) は UIKA 経路ではない');
        ok(m.isUikaAvatarRoute({ search: '', pathname: '/concierge' }, ls(null)) === false,
           '未選択なら UIKA 経路ではない');
        ok(m.isUikaAvatarRoute({ search: '', pathname: '/concierge' }, null) === false,
           'localStorage が無い環境でも例外なく false');
    }

    console.log(failures === 0 ? '\n=== 全テスト PASS ===' : `\n=== ${failures} 件 FAIL ===`);
    process.exit(failures === 0 ? 0 : 1);
})();
