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
            && r.launchUrl === '/avatar/local/uika-full133-skin/v3.zip',
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
        ok(k.startsWith('/avatar/local/'),
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

    // ================= 最終修正 5 点のテスト =================

    const POSTER = '/avatar/posters/uika-full133.webp';
    const entryWithPoster = (version, payload) =>
        ({ ...entryFor(version, payload), posterUrl: POSTER });

    // ---- A. Local-first 起動でも Registry だけで実 Poster が取れる ----
    {
        const payload = makePayload(11);
        const h = build({ payload });
        await h.manager.install(FULL133.id, entryWithPoster('v3', payload));
        const r = await h.manager.resolveInstalled(FULL133.id);
        ok(r.kind === 'LOCAL_READY' && r.posterUrl === POSTER,
           '★ 1-A. LOCAL_READY が Registry 保存の posterUrl を返す', r.posterUrl);
        const rec = await h.manager.getRecord(FULL133.id);
        ok(rec.posterUrl === POSTER && rec.versions.v3.posterUrl === POSTER,
           '★ 1-A. posterUrl が record と version meta の両方に残る');
    }

    // ---- B. avatar-config / manifest が取れない状態でも Poster が解決できる ----
    {
        const payload = makePayload(12);
        const h = build({ payload });
        await h.manager.install(FULL133.id, entryWithPoster('v3', payload));
        // 以後は完全 offline (fetch も manifest も死んでいる) を模す
        const offline = {
            ...h.deps,
            fetchImpl: async () => { throw new Error('offline'); },
            manifestLoader: async () => { throw new Error('offline'); },
        };
        const { AvatarInstallManager: M } = require('./.avatar-install.cjs');
        const r = await new M(offline).resolveInstalled(FULL133.id);
        ok(r.kind === 'LOCAL_READY' && r.posterUrl === POSTER && h.fetchCalls.length === 1,
           '★ 1-B. offline (config / manifest 不通) でも posterUrl が解決できる',
           `fetch=${h.fetchCalls.length}`);
    }

    // ---- C. dispose で object URL を解放する ----
    {
        const src = require('fs').readFileSync(
            require('path').join(__dirname, '../../src/components/LAMAvatar.astro'), 'utf8');
        const body = src.slice(src.indexOf('    dispose(): void {'));
        const end = body.indexOf('\n    }');
        ok(end > 0 && body.slice(0, end).includes('this._revokeObjectUrl();'),
           '★ 2. LAMAvatarController.dispose() が blob URL を revoke する');
        ok(src.includes('this._revokeObjectUrl();\n        void this.initialize(')
            || /retryInitialize[\s\S]{0,160}_revokeObjectUrl/.test(src),
           '★ 2. retry 経路でも revoke する');
        ok(/_showFallback\(\): void \{\s*\n[^}]*_revokeObjectUrl\(\)/.test(src),
           '★ 2. fallback 経路でも revoke する');
    }

    // ---- D. pending load 失敗 → v3 へ戻り、reload guard は 1 回だけ ----
    {
        const p3 = makePayload(13);
        const p4 = makePayload(14);
        const e3 = entryWithPoster('v3', p3);
        const e4 = entryWithPoster('v4', p4);
        const h = build({ payloadFor: (u) => (String(u).includes('v4') ? p4 : p3) });
        await h.manager.install(FULL133.id, e3);
        await h.manager.install(FULL133.id, e4);
        let rec = await h.manager.getRecord(FULL133.id);
        ok(rec.activeVersion === 'v3' && rec.pendingVersion === 'v4',
           '★ 3. update は active=v3 / pending=v4 のまま');

        await h.manager.markLoadFailed(FULL133.id, 'v4', 'renderer がロードできなかった');
        rec = await h.manager.getRecord(FULL133.id);
        ok(rec.activeVersion === 'v3' && !rec.pendingVersion,
           '★ 3. pending v4 の load 失敗で pending を破棄し active=v3 を維持');
        ok(!h.cache.map.has('/avatar/local/uika-full133-skin/v4.zip'),
           '★ 3. 失敗した v4 の cache 実体を破棄する');
        const after = await h.manager.resolveInstalled(FULL133.id);
        ok(after.kind === 'LOCAL_READY' && after.version === 'v3' && after.isPending === false,
           '★ 3. 次の起動は通常の v3 起動になる', after.version);
    }
    {
        const g = require('./.pending-reload-guard.cjs');
        const mem = new Map();
        const store = {
            getItem: (k) => (mem.has(k) ? mem.get(k) : null),
            setItem: (k, v) => mem.set(k, v),
            removeItem: (k) => mem.delete(k),
        };
        const d1 = g.markPendingReload(store, FULL133.id, 'v4');
        const d2 = g.markPendingReload(store, FULL133.id, 'v4');
        ok(d1 === 'RELOAD' && d2 === 'ALREADY_RELOADED',
           '★ 3. reload guard は同じ version で 1 回だけ RELOAD を返す', `${d1}/${d2}`);
        g.clearPendingReload(store, FULL133.id);
        ok(g.markPendingReload(store, FULL133.id, 'v5') === 'RELOAD',
           '★ 3. 正常起動で guard が落ち、次の更新では再び 1 回 reload できる');
        ok(g.markPendingReload(null, FULL133.id, 'v6') === 'GUARD_UNAVAILABLE',
           '★ 3. guard を持てない環境では RELOAD を返さない (無限 reload 防止)');
        const broken = { getItem: () => null, setItem: () => { throw new Error('full'); },
                         removeItem: () => {} };
        ok(g.markPendingReload(broken, FULL133.id, 'v7') === 'GUARD_UNAVAILABLE',
           '★ 3. guard を保存できなければ RELOAD を返さない');
    }

    // ---- E. 非対応 runtimeSchema は download 開始前に除外する ----
    {
        const payload = makePayload(15);
        const bad = { ...entryFor('v9', payload), runtimeSchema: 'lam-full133-v2' };
        const h = build({ payload });
        let threw = false;
        try { await h.manager.install(FULL133.id, bad); } catch (e) { threw = true; }
        ok(threw && h.fetchCalls.length === 0,
           '★ 4. 非対応 runtimeSchema は download を始める前に install を拒否する',
           `fetch=${h.fetchCalls.length}`);
        ok((await h.manager.getRecord(FULL133.id)) === undefined,
           '★ 4. 非対応 package は Registry にも残らない');
    }
    {
        const m = require('./.avatar-manifest.cjs');
        const payload = makePayload(16);
        const good = entryFor('v3', payload);
        const bad = { ...entryFor('v9', payload), runtimeSchema: 'lam-full133-v2' };
        const parsed = m.parseManifest({ schemaVersion: 1, avatars: [good, bad] });
        ok(parsed !== null && parsed.avatars.length === 1
            && parsed.avatars[0].version === 'v3',
           '★ 4. manifest 検証の段階で非対応 entry を落とす');
        ok(m.parseManifest({ schemaVersion: 1, avatars: [bad] }) === null,
           '★ 4. 対応 entry が 1 件も無ければ manifest は無効');
        ok(m.isSupportedRuntimeSchema('lam-full133-v1') === true
            && m.isSupportedRuntimeSchema('lam-full133-v2') === false
            && m.isSupportedRuntimeSchema(undefined) === false,
           '★ 4. SUPPORTED_RUNTIME_SCHEMAS が互換性 gate になっている');
    }
    {
        // 非対応 schema の update は提案しない
        const payload = makePayload(17);
        const e3 = entryFor('v3', payload);
        const bad = { ...entryFor('v9', payload), runtimeSchema: 'lam-full133-v2' };
        const h = build({ payload, manifestLoader: async () =>
            ({ schemaVersion: 1, avatars: [bad] }) });
        await h.manager.install(FULL133.id, e3);
        const r = await h.manager.checkForUpdate(FULL133.id);
        ok(r.updateAvailable === false && r.entry === null,
           '★ 4. 非対応 runtimeSchema は update 候補にしない');
    }
    {
        // 保存済み version が非対応になったら renderer へ渡さない
        const payload = makePayload(18);
        const h = build({ payload });
        await h.manager.install(FULL133.id, entryFor('v3', payload));
        const raw = h.store.map.get(FULL133.id);
        raw.runtimeSchema = 'lam-full133-v2';
        raw.versions.v3.runtimeSchema = 'lam-full133-v2';
        h.store.map.set(FULL133.id, raw);
        const r = await h.manager.resolveInstalled(FULL133.id);
        ok(r.kind === 'RECOVERY_REQUIRED',
           '★ 4. 保存済みでも非対応 schema の package は renderer へ渡さない', r.kind);
    }

    // ---- F. 更新完了通知に「0.0MB」を出さない ----
    {
        const ui = require('./.install-ui.cjs');
        const made = [];
        const el = () => {
            const node = {
                style: {}, dataset: {}, className: '', textContent: '',
                _html: '', children: [],
                set innerHTML(v) { this._html = v; },
                get innerHTML() { return this._html; },
                appendChild(c) { this.children.push(c); return c; },
                remove() {}, addEventListener() {},
                querySelector() { return { addEventListener() {}, remove() {} }; },
                setAttribute() {}, classList: { add() {}, remove() {} },
            };
            made.push(node);
            return node;
        };
        global.document = {
            getElementById: () => ({}),
            createElement: () => el(),
            head: { appendChild() {} },
        };
        const host = el();
        ui.renderUpdateReadyNotice(host);
        const html = host.children.map((c) => c.innerHTML).join('');
        ok(html.includes('更新準備が完了しました。次回起動から新しいアバターを使用します。'),
           '★ 5. 更新完了通知は専用の文面だけを出す');
        ok(!/MB/.test(html) && !/ダウンロードが必要/.test(html),
           '★ 5. 更新完了通知に「約0.0MB のダウンロードが必要です」を出さない', html);

        const host2 = el();
        ui.renderUpdateNotice(host2, { label: '新しいアバターデータがあります',
            sizeBytes: 25532519, onUpdate() {}, onDismiss() {} });
        const html2 = host2.children.map((c) => c.innerHTML).join('');
        ok(/24\.3MB/.test(html2),
           '★ 5. download 案内 UI 自体は従来どおり実サイズを出す', html2.match(/約[\d.]+MB/)?.[0]);
        delete global.document;
    }

    // ================= 受け渡し契約 (cache-only SW route) =================

    // ---- G. 起動 URL が renderer の必須チェックを通る ----
    {
        const { localPackageUrl, cacheKeyFor, LOCAL_PACKAGE_PATH_PREFIX }
            = require('./.avatar-cache.cjs');
        // renderer 実コードの検査式 (gaussian-splat-renderer-for-lam):
        //   const { pathname } = urlParse(assetPath);
        //   const matches = pathname.match(/\/([^/]+?)\.zip/);
        //   if (!matches[1]) throw new Error('character model is not found');
        const RENDERER_RE = /\/([^/]+?)\.zip/;
        const url = localPackageUrl(FULL133.id, '2026.10.23.1');
        const m = url.match(RENDERER_RE);
        ok(!!m && m[1] === '2026.10.23.1',
           '★ A. 起動 URL が renderer の /<name>.zip 検査を通る', url);
        ok(url === cacheKeyFor(FULL133.id, '2026.10.23.1'),
           '★ A. 起動 URL と cache key が同一文字列 (SW は path を解釈しない)');
        ok(url.startsWith(LOCAL_PACKAGE_PATH_PREFIX) && url.startsWith('/'),
           '★ A. SW route prefix 配下の絶対 path');
        ok(!'blob:https://h/3f2b8c10-1d4e-4a7b-9f33-9a1c2d3e4f55'.match(RENDERER_RE),
           '★ A. (回帰) blob URL は renderer 検査を通らない');
        const manifestUrl = require('fs').readFileSync(
            require('path').join(__dirname, '../../public/avatar/avatars-manifest.json'),
            'utf8');
        ok(!JSON.parse(manifestUrl).avatars.some((a) => a.assetUrl === url),
           '★ A. 起動 path はサーバー実体 (manifest assetUrl) と別 (暗黙 download を作らない)');
    }

    // ---- H. SW script と avatar-cache.ts の定数が一致する ----
    {
        const fs = require('fs'), path = require('path');
        const sw = fs.readFileSync(
            path.join(__dirname, '../../public/sw-avatar-local.js'), 'utf8');
        const ts = fs.readFileSync(
            path.join(__dirname, '../../src/scripts/avatar-install/avatar-cache.ts'), 'utf8');
        const swPrefix = sw.match(/PREFIX\s*=\s*'([^']+)'/);
        const swCache = sw.match(/CACHE_NAME\s*=\s*'([^']+)'/);
        const tsPrefix = ts.match(/LOCAL_PACKAGE_PATH_PREFIX\s*=\s*'([^']+)'/);
        const tsCache = ts.match(/AVATAR_CACHE_NAME\s*=\s*'([^']+)'/);
        ok(!!swPrefix && !!tsPrefix && swPrefix[1] === tsPrefix[1],
           '★ A. SW の PREFIX が LOCAL_PACKAGE_PATH_PREFIX と一致',
           `${swPrefix && swPrefix[1]} / ${tsPrefix && tsPrefix[1]}`);
        ok(!!swCache && !!tsCache && swCache[1] === tsCache[1],
           '★ A. SW の CACHE_NAME が AVATAR_CACHE_NAME と一致',
           `${swCache && swCache[1]} / ${tsCache && tsCache[1]}`);
        ok(!/fetch\s*\(/.test(sw.replace(/addEventListener\('fetch'/g, '')),
           '★ A. SW script は network fetch を 1 箇所も持たない');

        // 生成 SW へ importScripts されているか (build 設定側)
        const cfg = fs.readFileSync(
            path.join(__dirname, '../../astro.config.mjs'), 'utf8');
        ok(/importScripts:\s*\['\/sw-avatar-local\.js'\]/.test(cfg),
           '★ A. astro.config.mjs が SW script を importScripts する');
        ok(/globIgnores:[^\]]*sw-avatar-local\.js/.test(cfg),
           '★ A. SW script 自身は precache しない');
    }

    // ---- I. SW handler の挙動 (hit / miss / 無関係 path) ----
    {
        const fs = require('fs'), path = require('path');
        const src = fs.readFileSync(
            path.join(__dirname, '../../public/sw-avatar-local.js'), 'utf8');
        const KEY = '/avatar/local/uika-full133-skin/v3.zip';
        const cached = { __key: KEY, body: 'ZIPBYTES' };
        const makeSelf = () => {
            const listeners = [];
            return {
                listeners,
                addEventListener: (t, cb) => { if (t === 'fetch') listeners.push(cb); },
                caches: {
                    open: async () => ({
                        match: async (k) => (k === KEY ? cached : undefined),
                    }),
                },
            };
        };
        const run = async (self, url, method = 'GET') => {
            let responded = null;
            const event = {
                request: { url, method },
                respondWith: (p) => { responded = p; },
            };
            self.listeners.forEach((cb) => cb(event));
            return responded === null ? 'NOT_INTERCEPTED' : await responded;
        };
        const self1 = makeSelf();
        new Function('self', src)(self1);
        ok(self1.listeners.length === 1, '★ A. SW script は fetch listener を 1 本だけ足す');

        const hit = await run(self1, 'https://h.test' + KEY);
        ok(hit === cached, '★ A. cache HIT では保存済み Response を返す');

        const miss = await run(self1, 'https://h.test/avatar/local/uika-full133-skin/v9.zip');
        ok(miss && miss.status === 504,
           '★ A. cache MISS では network へ出ず 504 を返す (25MB を暗黙 download しない)',
           miss && String(miss.status));

        const other = await run(self1, 'https://h.test/avatar/uika-full133-skin.zip');
        ok(other === 'NOT_INTERCEPTED',
           '★ A. prefix 外 (サーバー実体の URL) には干渉しない', String(other));
        const nav = await run(self1, 'https://h.test/concierge');
        ok(nav === 'NOT_INTERCEPTED', '★ A. 通常 navigation には干渉しない');
        const post = await run(self1, 'https://h.test' + KEY, 'POST');
        ok(post === 'NOT_INTERCEPTED', '★ A. GET 以外には干渉しない');
    }

    // ---- J. SW 制御が無いときは renderer へ渡さない ----
    {
        const { waitForServiceWorkerControl } = require('./.sw-control.cjs');
        const immediate = (cb) => cb();
        ok(await waitForServiceWorkerControl(
            { isControlled: () => true, ready: async () => {}, onControllerChange: () => () => {} },
            10, immediate) === true,
           '★ A. 既に制御されていれば待たずに true');

        let controlled = false;
        let fire = () => {};
        const deps = {
            isControlled: () => controlled,
            ready: async () => { controlled = false; },
            onControllerChange: (cb) => { fire = cb; return () => { fire = () => {}; }; },
        };
        const p = waitForServiceWorkerControl(deps, 1000, (cb, ms) => setTimeout(cb, ms));
        setTimeout(() => { controlled = true; fire(); }, 5);
        ok(await p === true, '★ A. controllerchange で制御が付けば true');

        ok(await waitForServiceWorkerControl(
            { isControlled: () => false, ready: async () => {},
              onControllerChange: () => () => {} }, 10, immediate) === false,
           '★ A. 制御が付かなければ false (自動 reload しない)');
        ok(await waitForServiceWorkerControl(null, 10, immediate) === false,
           '★ A. SW 非対応環境でも throw せず false');
    }

    // ---- L. (回帰) ready() が解決しなくても起動処理を止めない ----
    {
        const { waitForServiceWorkerControl } = require('./.sw-control.cjs');
        // install に失敗した SW が居ると navigator.serviceWorker.ready は
        // 永久に解決しない。これを await すると起動が無言で停止する。
        const t0 = Date.now();
        const r = await waitForServiceWorkerControl({
            isControlled: () => false,
            ready: () => new Promise(() => {}),      // 永久に解決しない
            onControllerChange: () => () => {},
        }, 30, (cb, ms) => setTimeout(cb, ms));
        ok(r === false && Date.now() - t0 < 2000,
           '★ A. ready() が永久に解決しなくても timeout で false を返す',
           `${Date.now() - t0}ms`);

        // ready() が解決しないまま controllerchange で制御が付く場合も拾う
        let controlled = false; let fire = () => {};
        const p2 = waitForServiceWorkerControl({
            isControlled: () => controlled,
            ready: () => new Promise(() => {}),
            onControllerChange: (cb) => { fire = cb; return () => { fire = () => {}; }; },
        }, 1000, (cb, ms) => setTimeout(cb, ms));
        setTimeout(() => { controlled = true; fire(); }, 5);
        ok(await p2 === true,
           '★ A. ready() 未解決でも controllerchange で制御が付けば true');
    }

    // ---- M. 生成 SW が install できる設定になっている ----
    {
        const fs = require('fs'), path = require('path');
        const swPath = path.join(__dirname, '../../dist/sw.js');
        if (!fs.existsSync(swPath)) {
            console.log('SKIP  ★ A. dist/sw.js が無い (npx astro build 後に検証)');
        } else {
            const sw = fs.readFileSync(swPath, 'utf8');
            const urls = [...sw.matchAll(/url:"([^"]+)"/g)].map((m) => m[1]);
            const fb = sw.match(/createHandlerBoundToURL\("([^"]+)"\)/);
            ok(!!fb && urls.includes(fb[1]),
               '★ A. navigateFallback が precache manifest に実在する (non-precached-url 回帰)',
               fb && fb[1]);
            ok(!urls.includes('404'),
               '★ A. 404 を precache しない (bad-precaching-response 回帰)');
            ok(sw.includes('importScripts("/sw-avatar-local.js")'),
               '★ A. 生成 SW が cache-only route を importScripts する');
            ok(sw.indexOf('importScripts("/sw-avatar-local.js")') < sw.indexOf('registerRoute'),
               '★ A. cache-only route の listener が Workbox より先に登録される');
            ok(!urls.includes('sw-avatar-local.js') && !urls.some((u) => u.endsWith('.zip')),
               '★ A. ZIP と SW script は precache に入らない');
        }
    }

    // ---- K. LAMAvatar は制御が無い場合に renderer を起動しない ----
    {
        const src = require('fs').readFileSync(
            require('path').join(__dirname, '../../src/components/LAMAvatar.astro'), 'utf8');
        ok((src.match(/if \(!\(await this\._ensureLocalDelivery\(\)\)\) return null;/g) || [])
            .length === 2,
           '★ A. LOCAL_READY の 2 経路とも配送可否を確認してから renderer へ渡す');
        ok(/renderReloadRequiredPrompt\(host, \{ onReload/.test(src),
           '★ A. 制御が無いときは再読み込みを案内する (自動 reload しない)');
        ok(!/_ownObjectUrl\((local|resolution)\./.test(src),
           '★ A. 起動 URL を blob URL として所有しない');
    }

    console.log(failures === 0 ? '\n=== 全テスト PASS ===' : `\n=== ${failures} 件 FAIL ===`);
    process.exit(failures === 0 ? 0 : 1);
})();
