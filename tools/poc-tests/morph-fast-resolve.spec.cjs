// tools/poc-tests/morph-fast-resolve.spec.cjs
//
// morphFast の実効値の決まり方を検証する。
//
// 同じ `?morphFast=` を読む実装が 2 つある:
//   - poc/render-perf.ts     既定 off / `1`|`on` で有効
//   - uika-133k-mode.ts      既定 on  / off を意味する綴りで無効
// 既定が逆なので、`?morphFast=0` が両方で「off」になることを固定する。
//
// あわせて優先順位 (URL > avatar-config > 既定) を検証する。
//
// 実行:
//   npx esbuild src/scripts/chat/poc/render-perf.ts --bundle --format=cjs \
//     --platform=node --outfile=tools/poc-tests/.render-perf.cjs
//   npx esbuild src/scripts/chat/uika-133k-mode.ts --bundle --format=cjs \
//     --platform=node --outfile=tools/poc-tests/.uika-133k.cjs
//   node tools/poc-tests/morph-fast-resolve.spec.cjs
let failures = 0;
const ok = (cond, name, extra) => {
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
    if (!cond) failures++;
};

/** avatar-config.json の中身を差し替えられる偽環境 */
function makeEnv(search, full133MorphFast) {
    global.window = {
        location: { search, pathname: '/concierge' },
        devicePixelRatio: 1.5,
        innerWidth: 1152, innerHeight: 898,
        __lamAvatarConfig: { modelUrl: '/avatar/uika-full133-skin.zip' },
        addEventListener: () => {},
        localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    };
    global.document = { addEventListener: () => {}, visibilityState: 'visible',
                        getElementById: () => null, createElement: () => ({ style: {} }),
                        body: { appendChild: () => {} }, querySelectorAll: () => [] };
    global.performance = { now: () => Date.now() };
    global.navigator = { userAgent: 'test' };
    global.requestAnimationFrame = (f) => setTimeout(() => f(Date.now()), 0);
    const full = { id: 'uika-full133-skin', name: 'UIKA FULL 133K',
                   modelUrl: '/avatar/uika-full133-skin.zip', voiceModel: 'x' };
    if (full133MorphFast !== undefined) full.morphFast = full133MorphFast;
    global.fetch = async () => ({ ok: true, json: async () => ([full,
        { id: 'meruru', name: 'メルル', modelUrl: '/avatar/meruru.zip', voiceModel: 'x' }]) });
}

function loadPoc() {
    delete require.cache[require.resolve('./.render-perf.cjs')];
    return require('./.render-perf.cjs');
}
function loadUika() {
    delete require.cache[require.resolve('./.uika-133k.cjs')];
    return require('./.uika-133k.cjs');
}

(async () => {
    // ---------- PoC 側: URL ----------
    makeEnv('?morphFast=1');
    let m = loadPoc();
    ok(m.getMorphFastOverride() === 'on', 'PoC: ?morphFast=1 -> on');
    let r = await m.resolveMorphFast();
    ok(r.mode === 'on' && r.source === 'url', 'PoC: URL が最優先', JSON.stringify(r));

    makeEnv('?morphFast=0');
    m = loadPoc();
    ok(m.getMorphFastOverride() === 'off', '★ PoC: ?morphFast=0 -> off (明示的 off)');
    r = await m.resolveMorphFast();
    ok(r.mode === 'off' && r.source === 'url', 'PoC: ?morphFast=0 は url 由来の off',
       JSON.stringify(r));

    makeEnv('?morphFast=off');
    m = loadPoc();
    ok(m.getMorphFastOverride() === 'off', 'PoC: ?morphFast=off -> off');

    makeEnv('');
    m = loadPoc();
    ok(m.getMorphFastOverride() === null, 'PoC: 未指定は null (= 既定に任せる)');
    ok(m.getMorphFastMode() === 'off', 'PoC: 同期版の既定は出荷挙動 off');

    // ---------- PoC 側: avatar-config ----------
    makeEnv('', true);
    m = loadPoc();
    r = await m.resolveMorphFast();
    ok(r.mode === 'on' && r.source === 'avatar-config',
       '★ URL なしで avatar-config から on になる', JSON.stringify(r));

    makeEnv('?morphFast=0', true);
    m = loadPoc();
    r = await m.resolveMorphFast();
    ok(r.mode === 'off' && r.source === 'url',
       '★ ?morphFast=0 が avatar-config の on を上書きする', JSON.stringify(r));

    makeEnv('', false);
    m = loadPoc();
    r = await m.resolveMorphFast();
    ok(r.mode === 'off' && r.source === 'avatar-config',
       'avatar-config の false も尊重する', JSON.stringify(r));

    makeEnv('');
    m = loadPoc();
    r = await m.resolveMorphFast();
    ok(r.mode === 'off' && r.source === 'default',
       'キーが無ければ既定 off', JSON.stringify(r));

    // avatar-config が読めないときに落ちないこと
    makeEnv('');
    global.fetch = async () => { throw new Error('network down'); };
    m = loadPoc();
    r = await m.resolveMorphFast();
    ok(r.mode === 'off' && r.source === 'default',
       'avatar-config が読めなくても例外を投げずに off', JSON.stringify(r));

    // ---------- uika-133k 側: 既定が逆でも 0 は off ----------
    makeEnv('');
    let u = loadUika();
    ok(u.getUikaMorphFast() === true, 'uika: 未指定の既定は on (従来どおり)');

    makeEnv('?morphFast=off');
    u = loadUika();
    ok(u.getUikaMorphFast() === false, 'uika: ?morphFast=off -> off (従来どおり)');

    makeEnv('?morphFast=0');
    u = loadUika();
    ok(u.getUikaMorphFast() === false,
       '★ uika: ?morphFast=0 も off (PoC 側と意味が揃う)');

    makeEnv('?morphFast=false');
    u = loadUika();
    ok(u.getUikaMorphFast() === false, 'uika: ?morphFast=false -> off');

    makeEnv('?morphFast=1');
    u = loadUika();
    ok(u.getUikaMorphFast() === true, 'uika: ?morphFast=1 -> on');

    console.log(failures === 0 ? '\n=== 全テスト PASS ===' : `\n=== ${failures} 件 FAIL ===`);
    process.exit(failures === 0 ? 0 : 1);
})();
