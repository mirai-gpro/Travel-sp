// tools/poc-tests/skin-mode-resolve.spec.cjs
//
// skinMode の実効値の決まり方を固定する。
// 通常起動 (URL パラメータなし) で FULL133 が aligned になることが要点。
//
// 実行:
//   npx esbuild src/scripts/chat/poc/multibone-skinning.ts --bundle --format=cjs \
//     --platform=node --outfile=tools/poc-tests/.multibone.cjs
//   node tools/poc-tests/skin-mode-resolve.spec.cjs
let failures = 0;
const ok = (cond, name, extra) => {
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
    if (!cond) failures++;
};

function makeEnv(search, opts = {}) {
    const id = opts.avatarId ?? 'uika-full133-skin';
    global.window = {
        location: { search, pathname: '/concierge' },
        devicePixelRatio: 1.5, innerWidth: 1152, innerHeight: 898,
        __lamAvatarConfig: { modelUrl: `/avatar/${id}.zip` },
        addEventListener: () => {},
        localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    };
    global.document = { addEventListener: () => {}, visibilityState: 'visible' };
    global.performance = { now: () => Date.now() };
    global.navigator = { userAgent: 'test' };
    global.requestAnimationFrame = (f) => setTimeout(() => f(Date.now()), 0);
    const full = { id: 'uika-full133-skin', name: 'UIKA FULL 133K',
                   modelUrl: '/avatar/uika-full133-skin.zip', voiceModel: 'x' };
    if (opts.skinMode !== undefined) full.skinMode = opts.skinMode;
    global.fetch = async () => ({ ok: true, json: async () => ([full,
        { id: 'meruru', name: 'メルル', modelUrl: '/avatar/meruru.zip', voiceModel: 'x' }]) });
}
function load() {
    delete require.cache[require.resolve('./.multibone.cjs')];
    return require('./.multibone.cjs');
}

(async () => {
    makeEnv('', { skinMode: 'aligned' });
    let m = load();
    let r = await m.resolveSkinMode();
    ok(r.mode === 'aligned' && r.source === 'avatar-config',
       '★ URL なしで avatar-config から aligned が選ばれる', JSON.stringify(r));

    makeEnv('?skinMode=head', { skinMode: 'aligned' });
    m = load();
    r = await m.resolveSkinMode();
    ok(r.mode === 'head' && r.source === 'url',
       '★ ?skinMode=head で出荷版へ切り戻せる', JSON.stringify(r));

    makeEnv('?skinMode=aligned');
    m = load();
    r = await m.resolveSkinMode();
    ok(r.mode === 'aligned' && r.source === 'url', 'URL 指定が最優先', JSON.stringify(r));

    makeEnv('?skinMode=multi', { skinMode: 'aligned' });
    m = load();
    r = await m.resolveSkinMode();
    ok(r.mode === 'multi' && r.source === 'url', 'multi も URL で指定できる');

    makeEnv('');
    m = load();
    r = await m.resolveSkinMode();
    ok(r.mode === 'head' && r.source === 'default',
       'キーが無ければ出荷既定 head', JSON.stringify(r));

    makeEnv('', { avatarId: 'meruru', skinMode: 'aligned' });
    m = load();
    r = await m.resolveSkinMode();
    ok(r.mode === 'head' && r.source === 'default',
       '★ 別 avatar には FULL133 の skinMode が効かない', JSON.stringify(r));

    makeEnv('?skinMode=bogus', { skinMode: 'aligned' });
    m = load();
    r = await m.resolveSkinMode();
    ok(r.mode === 'aligned' && r.source === 'avatar-config',
       '不正な URL 値は無視して avatar-config を使う', JSON.stringify(r));

    makeEnv('', { skinMode: 'aligned' });
    global.fetch = async () => { throw new Error('network down'); };
    m = load();
    r = await m.resolveSkinMode();
    ok(r.mode === 'head' && r.source === 'default',
       'avatar-config が読めなくても例外を投げずに head', JSON.stringify(r));

    makeEnv('');
    m = load();
    ok(m.getSkinMode() === 'head', '同期版 getSkinMode() の既定は head');
    makeEnv('?skinMode=aligned');
    m = load();
    ok(m.getSkinMode() === 'aligned', '同期版 getSkinMode() は URL を読む');

    console.log(failures === 0 ? '\n=== 全テスト PASS ===' : `\n=== ${failures} 件 FAIL ===`);
    process.exit(failures === 0 ? 0 : 1);
})();
