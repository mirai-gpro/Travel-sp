// tools/poc-tests/avatar-install.spec.cjs
//
// Avatar install / update / recovery のロジックテスト (指示書 §28)。
// 実ブラウザ / 実 IndexedDB / 実 Cache Storage は不要。
// Registry と Cache は依存注入した fake を使う。
//
// 実行:
//   npx esbuild src/scripts/avatar-install/avatar-install-manager.ts --bundle \
//     --format=cjs --platform=node --outfile=tools/poc-tests/.avatar-install.cjs
//   node tools/poc-tests/avatar-install.spec.cjs
const nodeCrypto = require('crypto');

let failures = 0;
const ok = (cond, name, extra) => {
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
    if (!cond) failures++;
};

const FULL133 = {
    id: 'uika-full133-skin',
    modelUrl: '/avatar/uika-full133-skin.zip',
    installPolicy: 'local-package',
};
const LEGACY = { id: 'meruru', modelUrl: '/avatar/meruru.zip' };

function makePayload(seed, size = 4096) {
    const b = Buffer.alloc(size);
    for (let i = 0; i < size; i++) b[i] = (i * 31 + seed) & 0xff;
    return b;
}
const sha256hex = (buf) =>
    nodeCrypto.createHash('sha256').update(Buffer.from(buf)).digest('hex');

function entryFor(version, payload, url) {
    return {
        id: FULL133.id, version,
        assetUrl: url ?? `/avatar/uika-full133-skin.zip?v=${version}`,
        size: payload.length, sha256: sha256hex(payload),
        runtimeSchema: 'lam-full133-v1',
    };
}

function makeStore() {
    const m = new Map();
    return {
        map: m,
        async get(k) { return m.get(k); },
        async put(k, v) { m.set(k, JSON.parse(JSON.stringify(v))); },
        async delete(k) { m.delete(k); },
        async keys() { return [...m.keys()]; },
    };
}

function makeCache() {
    const m = new Map();
    return {
        map: m,
        async has(k) { return m.has(k); },
        async match(k) { return m.get(k); },
        async put(k, res) { m.set(k, res); },
        async delete(k) { return m.delete(k); },
        async keys() { return [...m.keys()]; },
    };
}

function makeDeps(opts = {}) {
    const store = opts.store ?? makeStore();
    const cache = opts.cache ?? makeCache();
    const fetchCalls = [];
    return {
        store, cache, fetchCalls,
        deps: {
            registry: null,          // build() が差し込む
            cache,
            fetchImpl: async (url) => {
                fetchCalls.push(url);
                if (opts.fetchFails) throw new Error('offline');
                const payload = opts.payloadFor ? opts.payloadFor(url) : opts.payload;
                if (!payload) return { ok: false, status: 404, headers: { get: () => null } };
                return {
                    ok: true, status: 200,
                    headers: { get: (h) => (h === 'Content-Length' ? String(payload.length) : null) },
                    arrayBuffer: async () =>
                        payload.buffer.slice(payload.byteOffset,
                                             payload.byteOffset + payload.byteLength),
                };
            },
            sha256: async (buf) => sha256hex(buf),
            manifestLoader: opts.manifestLoader
                ?? (async () => ({ schemaVersion: 1, avatars: opts.manifestAvatars ?? [] })),
            toUrl: async (res) => 'blob:fake/' + (res.__key ?? 'x'),
            storage: {
                query: async () => ({
                    supported: true, usage: 0, quota: 1e10, available: 1e10,
                    persistGranted: true, likelyInsufficient: false,
                }),
                persist: async () => true,
            },
            now: () => 1700000000000,
        },
    };
}

(async () => {
    const { AvatarInstallManager } = require('./.avatar-install.cjs');
    const { AvatarInstallRegistry: Registry } = require('./.avatar-registry.cjs');

    const build = (opts = {}) => {
        const h = makeDeps(opts);
        h.deps.registry = new Registry(h.store);
        return { ...h, manager: new AvatarInstallManager(h.deps) };
    };

    // ---- 9. 非 local-package avatar は従来経路 ----
    {
        const { manager } = build();
        const r = await manager.resolveAvatarAsset(LEGACY);
        ok(r.kind === 'LEGACY_REMOTE' && r.assetUrl === '/avatar/meruru.zip',
           '★ 9. 非 FULL133 avatar は既存 load path のまま', r.kind);
    }

    // ---- 1. install 前: Registry MISS + Cache MISS ----
    {
        const { manager } = build();
        const r = await manager.resolveAvatarAsset(FULL133);
        ok(r.kind === 'INSTALL_REQUIRED', '★ 1. 未インストールなら INSTALL_REQUIRED', r.reason);
    }

    // ---- 2. 正常 install ----
    const payload3 = makePayload(3);
    const entry3 = entryFor('v3', payload3);
    {
        const h = build({ payload: payload3 });
        const seen = [];
        const rec = await h.manager.install(FULL133.id, entry3, (p) => seen.push(p.state));
        ok(rec.state === 'INSTALLED', '★ 2. download → hash → cache → INSTALLED', rec.state);
        ok(rec.activeVersion === 'v3', 'activeVersion = v3');
        ok(seen.includes('DOWNLOADING') && seen.includes('VERIFYING')
            && seen.includes('READY') && seen.indexOf('INSTALLED') === seen.length - 1,
           '★ 状態遷移が DOWNLOADING → VERIFYING → READY → INSTALLED の順',
           seen.join(' > '));
        ok(h.cache.map.size === 1, 'Cache Storage に 1 件だけ保存', 'size=' + h.cache.map.size);
        const stored = [...h.store.map.values()][0];
        ok(typeof stored.sha256 === 'string' && !('data' in stored) && !('blob' in stored),
           '★ Registry には binary を入れていない');

        // ---- 4. 通常起動: manifest を待たない ----
        const h2 = build({ store: h.store, cache: h.cache,
            manifestLoader: async () => { throw new Error('manifest を待ってはいけない'); } });
        const r = await h2.manager.resolveAvatarAsset(FULL133);
        ok(r.kind === 'LOCAL_READY' && r.version === 'v3'
            && String(r.objectUrl).startsWith('blob:'),
           '★ 4. Registry INSTALLED + Cache HIT で LOCAL_READY (manifest を待たない)', r.kind);
        ok(h2.fetchCalls.length === 0, '★ 通常起動では asset を 1 度も fetch しない',
           'fetch=' + h2.fetchCalls.length);

        // ---- 6. remote manifest 失敗は起動に影響しない ----
        const h3 = build({ store: h.store, cache: h.cache,
            manifestLoader: async () => null });
        const r3 = await h3.manager.resolveAvatarAsset(FULL133);
        const upd = await h3.manager.checkForUpdate(FULL133.id);
        ok(r3.kind === 'LOCAL_READY' && upd.updateAvailable === false && upd.entry === null,
           '★ 6. manifest 取得失敗でも installed avatar は起動できる');

        // ---- 5. cache eviction 相当 ----
        const h4 = build({ store: h.store, cache: makeCache() });
        const r4 = await h4.manager.resolveAvatarAsset(FULL133);
        ok(r4.kind === 'RECOVERY_REQUIRED', '★ 5. Registry INSTALLED + Cache MISS → RECOVERY_REQUIRED',
           r4.reason);
        ok(r4.record.state === 'MISSING', 'state を MISSING にする');
        ok(h4.fetchCalls.length === 0, '★ 黙って再 download しない', 'fetch=' + h4.fetchCalls.length);
    }

    // ---- 3. hash 失敗 ----
    {
        const h = build({ payload: makePayload(9) });        // entry3 とは別の中身
        let threw = false;
        try {
            await h.manager.install(FULL133.id, entry3, () => {});
        } catch (e) { threw = true; }
        const rec = await h.manager.getRecord(FULL133.id);
        ok(threw && rec.state === 'FAILED', '★ 3. SHA-256 不一致なら FAILED', rec.state);
        ok(!rec.activeVersion, '★ 失敗した version を active にしない');
        ok(h.cache.map.size === 0, '★ 破損 asset を cache に残さない');
        ok(String(rec.lastError).includes('SHA-256'), 'lastError に理由が残る');
    }

    // ---- 7 / 8. update ----
    {
        const payload4 = makePayload(4, 5000);
        const entry4 = entryFor('v4', payload4);
        const h = build({ payload: payload3 });
        await h.manager.install(FULL133.id, entry3, () => {});

        const h2 = build({ store: h.store, cache: h.cache, payload: payload4,
                           manifestAvatars: [entry4] });
        const upd = await h2.manager.checkForUpdate(FULL133.id);
        ok(upd.updateAvailable === true && upd.entry.version === 'v4',
           '★ 7. manifest の v4 を更新候補として検知');

        const rec = await h2.manager.install(FULL133.id, entry4, () => {});
        ok(rec.activeVersion === 'v3' && rec.pendingVersion === 'v4',
           '★ 7. v3 を壊さず pendingVersion = v4', `active=${rec.activeVersion} pending=${rec.pendingVersion}`);
        ok(h.cache.map.size === 2, '★ v3 の cache を消していない', 'cache=' + h.cache.map.size);

        // 次回起動は pending を試す
        const h3 = build({ store: h.store, cache: h.cache });
        const r = await h3.manager.resolveAvatarAsset(FULL133);
        ok(r.kind === 'LOCAL_READY' && r.version === 'v4',
           '★ 8. 次回起動で v4 をロードしに行く', r.version);

        await h3.manager.markLoadSucceeded(FULL133.id, 'v4');
        const after = await h3.manager.getRecord(FULL133.id);
        ok(after.activeVersion === 'v4' && !after.pendingVersion,
           '★ 8. ロード成功で active = v4', `active=${after.activeVersion}`);
        ok(h.cache.map.size === 1 && !after.versions.v3,
           '★ 8. 旧 v3 を cleanup', 'cache=' + h.cache.map.size);
    }

    // ---- update 版のロードに失敗したら v3 へ戻す ----
    {
        const payload4 = makePayload(5, 6000);
        const entry4 = entryFor('v4b', payload4);
        const h = build({ payload: payload3 });
        await h.manager.install(FULL133.id, entry3, () => {});
        const h2 = build({ store: h.store, cache: h.cache, payload: payload4 });
        await h2.manager.install(FULL133.id, entry4, () => {});
        await h2.manager.markLoadFailed(FULL133.id, 'v4b', 'renderer がロードできなかった');
        const rec = await h2.manager.getRecord(FULL133.id);
        ok(rec.activeVersion === 'v3' && !rec.pendingVersion,
           '★ pending のロードに失敗したら v3 を使い続ける',
           `active=${rec.activeVersion} pending=${rec.pendingVersion}`);
        const r = await h2.manager.resolveAvatarAsset(FULL133);
        ok(r.kind === 'LOCAL_READY' && r.version === 'v3', '★ 次回起動は v3 で復帰', r.version);
    }

    // ================= 修正 1〜6 の回帰 =================

    // ---- 2. cache key が route に依存しない ----
    {
        const { cacheKeyFor } = require('./.avatar-cache.cjs');
        const k = cacheKeyFor(FULL133.id, 'v3');
        ok(k.startsWith('/__avatar-package__/'),
           '★ cache key が origin root からの絶対 pathname', k);
        const atRoot = new URL(k, 'https://example.test/').href;
        const atConcierge = new URL(k, 'https://example.test/concierge').href;
        ok(atRoot === atConcierge,
           '★ / で install した key と /concierge で参照する key が同一',
           `${atRoot} === ${atConcierge}`);
        ok(cacheKeyFor('a/b', 'v 1').indexOf(' ') < 0, 'avatarId / version を escape する');
    }

    // ---- 1. avatar-config が読めなくても Registry + Cache で LOCAL_READY ----
    {
        const h = build({ payload: payload3 });
        await h.manager.install(FULL133.id, entry3, () => {});
        // avatar-config も manifest も取れない状況を模す
        const h2 = build({ store: h.store, cache: h.cache, fetchFails: true,
            manifestLoader: async () => { throw new Error('offline'); } });
        const r = await h2.manager.resolveInstalled(FULL133.id);
        ok(r.kind === 'LOCAL_READY' && r.version === 'v3',
           '★ 1. avatar-config / manifest が取れなくても installed は LOCAL_READY', r.kind);
        ok(h2.fetchCalls.length === 0, '★ 1. network を 1 度も叩かない');
    }

    // ---- 4. v4 DOWNLOADING 中に終了 → 次回は v3 で起動 ----
    {
        const h = build({ payload: payload3 });
        await h.manager.install(FULL133.id, entry3, () => {});
        // download 途中で落ちた状態を直接作る (state を DOWNLOADING のまま残す)
        const rec = [...h.store.map.values()][0];
        rec.state = 'DOWNLOADING';
        rec.version = 'v4';
        rec.versions.v4 = { assetUrl: '/x?v=v4', sha256: 'f'.repeat(64), size: 10 };
        await h.store.put(FULL133.id, rec);

        const h2 = build({ store: h.store, cache: h.cache });
        const r = await h2.manager.resolveInstalled(FULL133.id);
        ok(r.kind === 'LOCAL_READY' && r.version === 'v3' && r.isPending === false,
           '★ 4. v4 DOWNLOADING 状態で再起動しても v3 が LOCAL_READY', `${r.kind}/${r.version}`);
        const after = await h2.manager.getRecord(FULL133.id);
        ok(after.state === 'INSTALLED', '中断状態の state を INSTALLED へ戻す', after.state);
    }

    // ---- 4/5. pending v4 の cache が無ければ v3 へ落ちる (Recovery にしない) ----
    {
        const payload4 = makePayload(7, 7000);
        const entry4 = entryFor('v4c', payload4);
        const h = build({ payload: payload3 });
        await h.manager.install(FULL133.id, entry3, () => {});
        const h2 = build({ store: h.store, cache: h.cache, payload: payload4 });
        await h2.manager.install(FULL133.id, entry4, () => {});
        // pending の実体だけを消す (eviction 相当)
        const { cacheKeyFor } = require('./.avatar-cache.cjs');
        h.cache.map.delete(cacheKeyFor(FULL133.id, 'v4c'));

        const h3 = build({ store: h.store, cache: h.cache });
        const r = await h3.manager.resolveInstalled(FULL133.id);
        ok(r.kind === 'LOCAL_READY' && r.version === 'v3',
           '★ 4. pending v4 の cache MISS なら v3 へ fallback (Recovery にしない)',
           `${r.kind}/${r.version}`);
        const after = await h3.manager.getRecord(FULL133.id);
        ok(!after.pendingVersion, '★ 使えない pending は破棄する');
    }

    // ---- 5. v4 renderer load 失敗後、同じ起動で v3 を解決できる ----
    {
        const payload4 = makePayload(8, 8000);
        const entry4 = entryFor('v4d', payload4);
        const h = build({ payload: payload3 });
        await h.manager.install(FULL133.id, entry3, () => {});
        const h2 = build({ store: h.store, cache: h.cache, payload: payload4 });
        await h2.manager.install(FULL133.id, entry4, () => {});

        const h3 = build({ store: h.store, cache: h.cache });
        const first = await h3.manager.resolveInstalled(FULL133.id);
        ok(first.version === 'v4d' && first.isPending === true,
           '★ 5. まず pending v4 を試す (isPending=true)');
        await h3.manager.markLoadFailed(FULL133.id, 'v4d', 'renderer がロードできなかった');
        const second = await h3.manager.resolveInstalled(FULL133.id);
        ok(second.kind === 'LOCAL_READY' && second.version === 'v3'
            && second.isPending === false,
           '★ 5. 同じ起動のうちに v3 を解決できる', `${second.kind}/${second.version}`);
    }

    // ---- 3. update 完了は pendingVersion までで、active を動かさない ----
    {
        const payload4 = makePayload(11, 9000);
        const entry4 = entryFor('v4e', payload4);
        const h = build({ payload: payload3 });
        await h.manager.install(FULL133.id, entry3, () => {});
        const h2 = build({ store: h.store, cache: h.cache, payload: payload4 });
        const rec = await h2.manager.install(FULL133.id, entry4, () => {});
        ok(rec.activeVersion === 'v3' && rec.pendingVersion === 'v4e',
           '★ 3. update 完了後も activeVersion は v3 のまま',
           `active=${rec.activeVersion} pending=${rec.pendingVersion}`);
        // 現在 session で解決し直しても v4 を active にはしない
        const after = await h2.manager.getRecord(FULL133.id);
        ok(after.activeVersion === 'v3',
           '★ 3. install() 自体は active を書き換えない (再 initialize の材料を作らない)');
    }

    // ---- 6. object URL の dispose / retry cleanup ----
    {
        const { ObjectUrlOwner } = require('./.avatar-cache.cjs');
        const freed = [];
        const o = new ObjectUrlOwner((u) => freed.push(u));
        o.own('blob:a');
        ok(o.value === 'blob:a', 'object URL を所有する');
        o.own('blob:b');
        ok(freed.length === 1 && freed[0] === 'blob:a',
           '★ 6. 差し替え時に前の object URL を revoke する', freed.join(','));
        o.release();
        ok(freed.length === 2 && freed[1] === 'blob:b' && o.value === null,
           '★ 6. dispose / retry で現在の object URL を revoke する');
        o.release();
        ok(freed.length === 2, '★ 6. 二重 revoke しない');
        const bad = new ObjectUrlOwner(() => { throw new Error('revoke 失敗'); });
        bad.own('blob:c');
        bad.release();
        ok(bad.value === null, '★ 6. revoke が失敗しても所有権は手放す');
    }

    // ---- manifest のバリデーション ----
    {
        const m = require('./.avatar-manifest.cjs');
        ok(m.parseManifest({ schemaVersion: 1, avatars: [entry3] }) !== null,
           'manifest を parse できる');
        ok(m.parseManifest({ schemaVersion: 1,
            avatars: [{ ...entry3, sha256: 'xx' }] }) === null,
           '★ sha256 が 64 桁 hex でない entry は弾く');
        ok(m.parseManifest({ avatars: [] }) === null, 'schemaVersion 無しは弾く');
    }

    console.log(failures === 0 ? '\n=== 全テスト PASS ===' : `\n=== ${failures} 件 FAIL ===`);
    process.exit(failures === 0 ? 0 : 1);
})();
