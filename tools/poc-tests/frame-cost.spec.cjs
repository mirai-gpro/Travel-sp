// tools/poc-tests/frame-cost.spec.cjs
//
// frame cost 分解のロジックテスト (偽 renderer / 偽 viewer)。実 GPU 不要。
//
// 検証するのは「数字が正しく割り振られるか」だけ:
//   - exclusive time の合計が total に一致する (入れ子の二重計上が無い)
//   - updateBoneMatrixTexture の時間が runMorphUpdate から差し引かれる
//   - viewer.render の中の THREE renderer.render は nested 参考値として別建て
//   - long frame だけが集計の long 側に入る
//   - ?frameCost 未指定なら 1 つも hook しない
//
// 実行:
//   npx esbuild src/scripts/chat/poc/frame-cost.ts --bundle --format=cjs \
//     --platform=node --outfile=tools/poc-tests/.frame-cost.cjs
//   node tools/poc-tests/frame-cost.spec.cjs
let failures = 0;
const ok = (cond, name, extra) => {
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
    if (!cond) failures++;
};

// performance.now() を手で進める。実時間に依存させない。
let clock = 0;
function makeEnv(search) {
    global.window = { location: { search }, innerWidth: 1152, innerHeight: 898 };
    global.performance = { now: () => clock };
    global.requestAnimationFrame = (f) => setTimeout(() => f(clock), 0);
}
/** 指定 ms だけ「仕事をした」ことにする */
const burn = (ms) => { clock += ms; };

/**
 * 偽 renderer。実 renderer (`rsrc/src/render.ts:271-330`) と同じ順序で呼ぶ。
 * 各ステップのコストはテストから与える。
 */
function makeRenderer(cost) {
    const v = {
        update() {
            burn(cost.vUpdate);
            v.runMorphUpdate();
            v.runSplatSort(true, true);
        },
        runMorphUpdate() {
            burn(cost.morph);
            v.splatMesh.updateBoneMatrixTexture(false);
        },
        runSplatSort() { burn(cost.sort); return Promise.resolve(false); },
        render() {
            burn(cost.viewerRenderSelf);
            v.renderer.render('scene', 'cam');
            v.renderer.render('splat', 'cam');
        },
        shouldRender: () => true,
        splatMesh: {
            getSplatCount: () => 133541,
            updateBoneMatrixTexture() { burn(cost.bone); },
        },
        renderer: {
            render() { burn(cost.gl); },
            getContext: () => null,
        },
    };
    const r = {
        viewer: v,
        getExpressionData() { burn(cost.expr); return {}; },
        updateBS(d) { burn(cost.updateBS); return d; },
        setExpression() { burn(cost.setExpr); },
        mixer: { update() { burn(cost.mixer); } },
        animManager: { update() { burn(cost.anim); } },
        render() {
            // rAF の再登録相当 + frame index 計算 = 未計測 (other) になる部分
            burn(cost.rootSelf);
            r.animManager.update('idle');
            r.expressionData = r.updateBS(r.getExpressionData());
            r.mixer.update(0.016);
            r.setExpression();
            r.viewer.update(r.viewer.renderer, r.viewer.camera);
            if (r.viewer.shouldRender()) r.viewer.render();
        },
    };
    return r;
}

const sum = (o, keys) => keys.reduce((a, k) => a + o[k], 0);

(async () => {
    // ---------- 1. 未指定なら何もしない ----------
    makeEnv('');
    delete require.cache[require.resolve('./.frame-cost.cjs')];
    let mod = require('./.frame-cost.cjs');
    let r = makeRenderer({ rootSelf: 1, anim: 1, expr: 1, updateBS: 1, mixer: 1,
        setExpr: 1, vUpdate: 1, morph: 1, bone: 1, sort: 1, viewerRenderSelf: 1, gl: 1 });
    const origRender = r.render;
    let st = await mod.installFrameCost(r, 5);
    ok(st.applied === false, '?frameCost 未指定なら適用しない', st.reason);
    ok(r.render === origRender, 'renderer.render を差し替えていない');
    ok(Object.keys(st.hooked).length === 0, 'hook が 1 つも無い');

    // ---------- 2. 分解が total に一致する ----------
    makeEnv('?frameCost=1');
    delete require.cache[require.resolve('./.frame-cost.cjs')];
    mod = require('./.frame-cost.cjs');
    const cost = {
        rootSelf: 2, anim: 3, expr: 4, updateBS: 1, mixer: 5, setExpr: 2,
        vUpdate: 6, morph: 20, bone: 7, sort: 8, viewerRenderSelf: 9, gl: 11,
    };
    r = makeRenderer(cost);
    st = await mod.installFrameCost(r, 5);
    ok(st.applied === true, 'frameCost=1 で適用される', st.reason);
    ok(st.hooked['viewer.runMorphUpdate'] === true, 'runMorphUpdate を hook した');
    ok(st.hooked['renderer.mixer.update'] === true, 'mixer.update を hook した');
    ok(st.hooked['splatMesh.updateBoneMatrixTexture'] === true,
       'updateBoneMatrixTexture を hook した');

    clock = 1000;
    r.render();
    const s = global.window.__frameCost();
    const b = s.all.buckets;
    const expectTotal = sum(cost, Object.keys(cost)) + cost.gl;  // gl は 2 回呼ぶ
    ok(Math.abs(s.all.totalP50Ms - expectTotal) < 0.001,
       `total が仕込んだ総和と一致  期待 ${expectTotal}`, 'total=' + s.all.totalP50Ms);

    const parts = ['anim', 'expr', 'updateBS', 'mixer', 'setExpr',
                   'vUpdate', 'morph', 'bone', 'sort', 'render', 'other'];
    const partSum = parts.reduce((a, k) => a + b[k].p50Ms, 0);
    ok(Math.abs(partSum - expectTotal) < 0.001,
       '★ exclusive time の合計 === total (二重計上が無い)',
       `sum=${partSum.toFixed(2)} total=${expectTotal}`);

    // ---------- 3. 入れ子が親から差し引かれている ----------
    ok(Math.abs(b.morph.p50Ms - cost.morph) < 0.001,
       '★ morph から bone の時間が差し引かれている',
       `morph=${b.morph.p50Ms} (仕込み morph=${cost.morph} bone=${cost.bone})`);
    ok(Math.abs(b.bone.p50Ms - cost.bone) < 0.001,
       'bone が独立したバケットになっている', 'bone=' + b.bone.p50Ms);
    ok(Math.abs(b.vUpdate.p50Ms - cost.vUpdate) < 0.001,
       '★ vUpdate から morph / sort が差し引かれている', 'vUpdate=' + b.vUpdate.p50Ms);
    ok(Math.abs(b.render.p50Ms - (cost.viewerRenderSelf + 2 * cost.gl)) < 0.001,
       'render は中の THREE render を含む (inclusive)', 'render=' + b.render.p50Ms);
    ok(Math.abs(s.all.nestedMeanMs.gl - 2 * cost.gl) < 0.001,
       'gl は nested 参考値として別建て', 'gl=' + s.all.nestedMeanMs.gl);
    ok(Math.abs(b.other.p50Ms - cost.rootSelf) < 0.001,
       'other = 未計測部分のみ', 'other=' + b.other.p50Ms);

    // ---------- 4. ranking の先頭が最大の寄与 ----------
    // 仕込みでは render (9 + gl 11*2 = 31) が morph (20) より大きい。
    // ranking は exclusive time の大きい順になる。
    ok(s.all.ranking[0].bucket === 'render' && s.all.ranking[1].bucket === 'morph',
       '★ ranking が exclusive time の大きい順',
       JSON.stringify(s.all.ranking.slice(0, 3)));

    // ---------- 5. long frame の切り分け ----------
    ok(s.long && s.long.frames === 1, 'total >= 33.33ms なので long に入る',
       'longSharePct=' + s.longSharePct);

    // 軽いフレームを 1 つ混ぜる
    const cheap = { rootSelf: 0, anim: 0, expr: 0, updateBS: 0, mixer: 0, setExpr: 0,
        vUpdate: 0, morph: 1, bone: 0, sort: 0, viewerRenderSelf: 1, gl: 0 };
    for (const k of Object.keys(cost)) cost[k] = cheap[k];
    r.render();
    const s2 = global.window.__frameCost();
    ok(s2.all.frames === 2 && s2.long.frames === 1,
       '★ 軽いフレームは long に入らない',
       `all=${s2.all.frames} long=${s2.long.frames} longSharePct=${s2.longSharePct}`);
    ok(s2.long.buckets.morph.p50Ms === 20,
       'long 側の集計は long frame だけを見ている', 'morph=' + s2.long.buckets.morph.p50Ms);

    // ---------- 6. reset ----------
    global.window.__frameCostReset();
    ok(global.window.__frameCost().all === null, '__frameCostReset() で空になる');

    console.log(failures === 0 ? '\n=== 全テスト PASS ===' : `\n=== ${failures} 件 FAIL ===`);
    process.exit(failures === 0 ? 0 : 1);
})();
