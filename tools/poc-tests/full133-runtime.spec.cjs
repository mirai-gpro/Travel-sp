// tools/poc-tests/full133-runtime.spec.cjs
//
// FULL133 steady-state runtime のテスト (偽 viewer)。実 renderer / 実 GPU 不要。
//
// 偽 runMorphUpdate は実物 (Viewer.js:2775-2822 -> SplatMesh.js:1105-1127) と
// 同じ内訳でカウンタを進めるので、「O(133K) の処理が steady-state で 0 になるか」を
// 実際に検証できる。
//
// 実行:
//   npx esbuild src/scripts/chat/full133-runtime.ts --bundle --format=cjs \
//     --platform=node --outfile=tools/poc-tests/.full133-runtime.cjs
//   npx esbuild src/scripts/chat/uika-133k-mode.ts --bundle --format=cjs \
//     --platform=node --outfile=tools/poc-tests/.uika-133k.cjs
//   node tools/poc-tests/full133-runtime.spec.cjs
let failures = 0;
const ok = (cond, name, extra) => {
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
    if (!cond) failures++;
};

const FULL133 = 133541;

function makeEnv(search, opts = {}) {
    const id = opts.avatarId ?? 'uika-full133-skin';
    global.window = {
        location: { search, pathname: '/concierge' },
        devicePixelRatio: 1.5,
        innerWidth: 1152, innerHeight: 898,
        __lamAvatarConfig: { modelUrl: `/avatar/${id}.zip` },
        addEventListener: () => {},
        localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    };
    global.document = { addEventListener: () => {}, visibilityState: 'visible',
                        getElementById: () => null, createElement: () => ({ style: {} }),
                        body: { appendChild: () => {} } };
    global.performance = { now: () => Date.now() };
    global.navigator = { userAgent: 'test' };
    global.requestAnimationFrame = (f) => setTimeout(() => f(Date.now()), 0);
    const full = { id: 'uika-full133-skin', name: 'UIKA FULL 133K',
                   modelUrl: '/avatar/uika-full133-skin.zip', voiceModel: 'x' };
    if (opts.morphPath !== undefined) full.morphPath = opts.morphPath;
    if (opts.morphFast !== undefined) full.morphFast = opts.morphFast;
    global.fetch = async () => ({ ok: true, json: async () => ([full,
        { id: 'meruru', name: 'メルル', modelUrl: '/avatar/meruru.zip', voiceModel: 'x' }]) });
}

/**
 * 偽 viewer。`runMorphUpdate` は出荷版と同じ内訳でカウンタを進める。
 * `c.alloc` / `c.fillCenters` / `c.centerColors` / `c.centerUpload` が O(133K)、
 * `c.skeletonUpdate` / `c.matrixWorld` / `c.boneTexture` が小規模。
 */
function makeViewer(opts = {}) {
    const c = {
        alloc: 0, fillCenters: 0, centerColors: 0, centerUpload: 0,
        skeletonUpdate: 0, matrixWorld: 0, boneTexture: 0,
        boneTextureArgs: [],
    };
    const mat = (tx = 0) => ({ elements: [1,0,0,0, 0,1,0,0, 0,0,1,0, tx,0,0,1] });
    const v = {
        useFlame: opts.useFlame ?? false,
        setSkinAttibutes: opts.setSkinAttibutes ?? true,
        counters: c,
        sceneMatrix: mat(0),
        avatarMesh: {
            geometry: { attributes: { position: {
                array: new Float32Array(FULL133 * 3), count: FULL133, version: 0,
            } } },
        },
        skinModel: { skeleton: { update() { c.skeletonUpdate++; } } },
        boneRoot: { updateMatrixWorld() { c.matrixWorld++; } },
        splatMesh: {
            bonesNum: 5,
            morphedMesh: opts.morphedMesh === undefined ? new Float32Array(3) : opts.morphedMesh,
            splatDataTextures: opts.splatDataTextures ?? { flameModel: {}, boneMatrix: {} },
            getSplatCount: () => opts.splatCount ?? FULL133,
            getSceneTransform(_i, out) { out.copy(v.sceneMatrix); },
            updateBoneMatrixTexture(flag) { c.boneTexture++; c.boneTextureArgs.push(flag); },
        },
        // 出荷版と同じ順序・同じ内訳
        runMorphUpdate() {
            c.alloc++;                                   // new Float32Array(position.array)
            if (v.useFlame === false) {
                c.skeletonUpdate++;
                c.matrixWorld++;
            }
            c.fillCenters++;                             // fillSplatCenterArray    O(133K)
            c.centerColors++;                            // updateCenterColorsPaddedData
            c.centerUpload++;                            // updateDataTexture
            v.splatMesh.updateBoneMatrixTexture(v.useFlame === true);
        },
    };
    return v;
}
const snap = (c) => JSON.parse(JSON.stringify({
    alloc: c.alloc, fillCenters: c.fillCenters, centerColors: c.centerColors,
    centerUpload: c.centerUpload, skeletonUpdate: c.skeletonUpdate,
    matrixWorld: c.matrixWorld, boneTexture: c.boneTexture,
}));

function loadRt() {
    delete require.cache[require.resolve('./.full133-runtime.cjs')];
    return require('./.full133-runtime.cjs');
}
function loadUika() {
    delete require.cache[require.resolve('./.uika-133k.cjs')];
    return require('./.uika-133k.cjs');
}
/** 初期化を抜けるまで回す (MIN_FULL_RUNS = 30 + ready 判定の 1 フレーム) */
const spin = (v, n) => { for (let i = 0; i < n; i++) v.runMorphUpdate(); };

(async () => {
    // ================= 解決順位 =================
    makeEnv('?morphPath=steady-state');
    let m = loadRt();
    let r = await m.resolveMorphPath();
    ok(r.path === 'steady-state' && r.source === 'url', 'URL ?morphPath= が最優先',
       JSON.stringify(r));

    makeEnv('?morphFast=1');
    m = loadRt();
    r = await m.resolveMorphPath();
    ok(r.path === 'steady-state' && r.source === 'url-legacy',
       '旧 ?morphFast=1 も steady-state として受ける', JSON.stringify(r));

    makeEnv('?morphFast=0', { morphPath: 'steady-state' });
    m = loadRt();
    r = await m.resolveMorphPath();
    ok(r.path === 'stock' && r.source === 'url-legacy',
       '★ 旧 ?morphFast=0 が avatar-config の steady-state を上書きする', JSON.stringify(r));

    makeEnv('', { morphPath: 'steady-state' });
    m = loadRt();
    r = await m.resolveMorphPath();
    ok(r.path === 'steady-state' && r.source === 'avatar-config',
       '★ URL なしで avatar-config から steady-state が選ばれる', JSON.stringify(r));

    makeEnv('?morphPath=stock', { morphPath: 'steady-state' });
    m = loadRt();
    r = await m.resolveMorphPath();
    ok(r.path === 'stock' && r.source === 'url', '?morphPath=stock で切り戻せる');

    makeEnv('', { morphFast: true });
    m = loadRt();
    r = await m.resolveMorphPath();
    ok(r.path === 'steady-state' && r.source === 'avatar-config-legacy',
       '旧 avatar-config キー morphFast:true も読む', JSON.stringify(r));

    makeEnv('');
    m = loadRt();
    r = await m.resolveMorphPath();
    ok(r.path === 'stock' && r.source === 'default', 'キーが無ければ出荷既定 stock');

    makeEnv('');
    global.fetch = async () => { throw new Error('network down'); };
    m = loadRt();
    r = await m.resolveMorphPath();
    ok(r.path === 'stock' && r.source === 'default',
       'avatar-config が読めなくても例外を投げずに stock');

    // ================= stock は差し替えない =================
    makeEnv('');
    m = loadRt();
    let v = makeViewer();
    const origFn = v.runMorphUpdate;
    let st = await m.installFull133Runtime(v && { viewer: v }, 5);
    ok(st.applied === false && v.runMorphUpdate === origFn,
       'stock では runMorphUpdate を差し替えない', st.reason);

    // ================= FULL133 ゲート =================
    makeEnv('?morphPath=steady-state', { avatarId: 'meruru' });
    m = loadRt();
    v = makeViewer({ splatCount: 20018 });
    const origFn2 = v.runMorphUpdate;
    st = await m.installFull133Runtime({ viewer: v }, 5);
    ok(st.applied === false && v.runMorphUpdate === origFn2,
       '★ FULL133 以外には適用しない (通常 LAM avatar は無改変)', st.reason);

    makeEnv('?morphPath=steady-state');
    m = loadRt();
    v = makeViewer({ splatCount: 80000 });
    st = await m.installFull133Runtime({ viewer: v }, 5);
    ok(st.applied === false, '★ splatCount が 133541 でなければ適用しない', st.reason);

    // ================= useFlame === true では使わない =================
    makeEnv('?morphPath=steady-state');
    m = loadRt();
    v = makeViewer({ useFlame: true });
    st = await m.installFull133Runtime({ viewer: v }, 5);
    spin(v, 60);
    ok(st.applied === true, 'hook は入る', st.reason);
    ok(st.steadyFrames === 0 && st.ready.useFlameIsFalse === false,
       '★ useFlame=true では steady-state へ入らない (flame 経路を止めない)',
       `steadyFrames=${st.steadyFrames}`);
    ok(v.counters.fillCenters === 60, 'useFlame=true は完全実行のまま',
       'fillCenters=' + v.counters.fillCenters);

    // ================= 本体: O(133K) が 0 になる =================
    makeEnv('?morphPath=steady-state');
    m = loadRt();
    v = makeViewer();
    st = await m.installFull133Runtime({ viewer: v }, 5);
    ok(st.applied === true, 'FULL133 + steady-state で適用される', st.reason);

    // ready 判定は runFull の **後** に走るので、30 回目で ready になり 31 回目は steady。
    spin(v, 31);
    const afterInit = snap(v.counters);
    ok(st.fullRuns === 30 && st.steadyFrames === 1,
       '初期化の 30 フレームは完全実行、31 フレーム目から steady-state',
       `fullRuns=${st.fullRuns} steady=${st.steadyFrames}`);

    spin(v, 600);                      // steady-state をさらに 600 フレーム
    const after = snap(v.counters);
    ok(st.steadyFrames === 601, 'steady-state を 601 フレーム通った',
       'steadyFrames=' + st.steadyFrames);
    ok(after.alloc === afterInit.alloc,
       '★ new Float32Array(position.array) が 0 回', `${afterInit.alloc} -> ${after.alloc}`);
    ok(after.fillCenters === afterInit.fillCenters,
       '★ fillSplatCenterArray が 0 回', `${afterInit.fillCenters} -> ${after.fillCenters}`);
    ok(after.centerColors === afterInit.centerColors,
       '★ updateCenterColorsPaddedData が 0 回',
       `${afterInit.centerColors} -> ${after.centerColors}`);
    ok(after.centerUpload === afterInit.centerUpload,
       '★ center/color texture upload が 0 回',
       `${afterInit.centerUpload} -> ${after.centerUpload}`);
    ok(after.skeletonUpdate === afterInit.skeletonUpdate + 600,
       '★ skeleton.update() は毎フレーム継続',
       `+${after.skeletonUpdate - afterInit.skeletonUpdate}`);
    ok(after.matrixWorld === afterInit.matrixWorld + 600,
       '★ boneRoot.updateMatrixWorld() は毎フレーム継続',
       `+${after.matrixWorld - afterInit.matrixWorld}`);
    ok(after.boneTexture === afterInit.boneTexture + 600,
       '★ updateBoneMatrixTexture() は毎フレーム継続 (bsWeight)',
       `+${after.boneTexture - afterInit.boneTexture}`);
    ok(v.counters.boneTextureArgs.slice(-600).every(x => x === false),
       '★ updateBoneMatrixTexture(false) で呼ぶ (bone matrix 行は書かない)');

    // ================= scene transform 変化で 1 回だけ完全実行 =================
    const beforeInval = snap(v.counters);
    v.sceneMatrix = { elements: [1,0,0,0, 0,1,0,0, 0,0,1,0, 0.5,0,0,1] };
    spin(v, 1);
    ok(st.sceneTransformInvalidations === 1
       && v.counters.fillCenters === beforeInval.fillCenters + 1,
       '★ scene transform が動いたら centers を 1 回作り直す',
       `inval=${st.sceneTransformInvalidations} fill=+1`);
    spin(v, 100);
    ok(v.counters.fillCenters === beforeInval.fillCenters + 1,
       '★ その後は再び 0 回 (毎フレームには戻らない)',
       'fillCenters=' + v.counters.fillCenters);

    // ================= position buffer 差し替えで 1 回だけ完全実行 =================
    const beforePos = snap(v.counters);
    v.avatarMesh.geometry.attributes.position.version = 1;
    spin(v, 1);
    ok(st.positionBufferInvalidations === 1
       && v.counters.fillCenters === beforePos.fillCenters + 1,
       '★ position attribute が差し替わったら centers を作り直す',
       `inval=${st.positionBufferInvalidations}`);
    spin(v, 50);
    ok(v.counters.fillCenters === beforePos.fillCenters + 1,
       'その後は再び 0 回', 'fillCenters=' + v.counters.fillCenters);

    // ================= ready 条件が欠けていれば切り替えない =================
    makeEnv('?morphPath=steady-state');
    m = loadRt();
    v = makeViewer({ splatDataTextures: { flameModel: {} } });   // boneMatrix が無い
    st = await m.installFull133Runtime({ viewer: v }, 5);
    spin(v, 60);
    ok(st.steadyFrames === 0 && st.ready.boneMatrixTexture === false,
       '★ boneMatrix texture が未生成なら切り替えない',
       JSON.stringify(st.ready));

    makeEnv('?morphPath=steady-state');
    m = loadRt();
    v = makeViewer({ setSkinAttibutes: false });
    st = await m.installFull133Runtime({ viewer: v }, 5);
    spin(v, 60);
    ok(st.steadyFrames === 0 && st.ready.setSkinAttibutes === false,
       '★ skin attribute 未設定なら切り替えない', JSON.stringify(st.ready));

    // ================= 例外で完全実行へ戻る =================
    makeEnv('?morphPath=steady-state');
    m = loadRt();
    v = makeViewer();
    st = await m.installFull133Runtime({ viewer: v }, 5);
    spin(v, 31);
    spin(v, 5);
    ok(st.steadyFrames === 6, 'steady-state に入っている',
       'steadyFrames=' + st.steadyFrames);
    v.splatMesh.updateBoneMatrixTexture = () => { throw new Error('boom'); };
    const beforeFb = v.counters.fillCenters;
    spin(v, 1);
    ok(st.fallbackCount === 1 && st.lastError === 'boom',
       '★ 例外は黙殺せず fallbackCount / lastError に残す',
       `fallback=${st.fallbackCount} err=${st.lastError}`);
    ok(v.counters.fillCenters === beforeFb + 1,
       '★ 例外時は出荷版の完全実行で描き続ける', 'fillCenters=+1');
    v.splatMesh.updateBoneMatrixTexture = (f) => { v.counters.boneTexture++; };
    spin(v, 31);
    ok(st.steadyFrames > 5, '復旧後に再び steady-state へ戻る',
       'steadyFrames=' + st.steadyFrames);

    // ================= uika133k 側 (別経路) の ?morphFast 互換 =================
    makeEnv('?morphFast=0');
    let u = loadUika();
    ok(u.getUikaMorphFast() === false,
       'uika133k debug 経路でも ?morphFast=0 は off');
    makeEnv('');
    u = loadUika();
    ok(u.getUikaMorphFast() === true, 'uika133k debug 経路の既定は従来どおり on');

    console.log(failures === 0 ? '\n=== 全テスト PASS ===' : `\n=== ${failures} 件 FAIL ===`);
    process.exit(failures === 0 ? 0 : 1);
})();
