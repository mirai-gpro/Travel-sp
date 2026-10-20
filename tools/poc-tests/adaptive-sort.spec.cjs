// tools/poc-tests/adaptive-sort.spec.cjs
//
// adaptive sort スケジューラのロジックテスト (偽 viewer)。
// 実 renderer / 実 GPU は不要。single-flight / latest-state coalescing /
// camera 静止時の skip / 初期 sort / 停止後の最終 sort / FULL133 ゲート /
// 例外時の出荷版フォールバックを検証する。
//
// 実行:
//   npx esbuild src/scripts/chat/poc/adaptive-sort.ts --bundle --format=cjs \
//     --platform=node --outfile=tools/poc-tests/.adaptive-sort.cjs
//   node tools/poc-tests/adaptive-sort.spec.cjs
//
// bundle 先は .gitignore 済み (.adaptive-sort.cjs)。
let failures = 0;
const ok = (cond, name, extra) => {
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
    if (!cond) failures++;
};

function makeEnv(search) {
    const listeners = {};
    global.window = {
        location: { search },
        devicePixelRatio: 1.5,
        innerWidth: 1152, innerHeight: 898,
        __lamAvatarConfig: { modelUrl: '/avatar/uika-full133-skin.zip' },
        addEventListener: () => {},
    };
    global.document = { addEventListener: () => {}, visibilityState: 'visible' };
    global.performance = { now: () => Date.now() };
    // avatar-config.json は URL override が無いときだけ読まれる。
    // ここでは FULL133 に sortPolicy を持たせない (= 出荷既定) 状態を模す。
    global.fetch = async () => ({
        ok: true,
        json: async () => ([
            { id: 'uika-full133-skin', name: 'UIKA FULL 133K',
              modelUrl: '/avatar/uika-full133-skin.zip', voiceModel: 'x' },
            { id: 'meruru', name: 'メルル', modelUrl: '/avatar/meruru.zip', voiceModel: 'x' },
        ]),
    });
    global.requestAnimationFrame = (f) => setTimeout(() => f(Date.now()), 0);
    return listeners;
}

function makeViewer() {
    const mk = (n) => { const a = new Array(n).fill(0); return a; };
    const proj = mk(16); proj[0] = 1; proj[5] = 1; proj[10] = -1; proj[15] = 1;
    const v = {
        sortRunning: false,
        gpuAcceleratedSort: true,
        camera: {
            position: { x: 0, y: 1.75, z: 0.44 },
            quaternion: { x: 0, y: 0, z: 0, w: 1 },
            projectionMatrix: { elements: proj },
        },
        controls: { target: { x: 0, y: 1.64, z: 0 } },
        splatMesh: { getSplatCount: () => 133541 },
        origCalls: 0,
        _resolve: null,
        runSplatSort(force, forceSortAll) {
            v.origCalls++;
            if (v.sortRunning) return Promise.resolve(true);
            v.sortRunning = true;           // 実 renderer と同じ: 同期的に true
            return new Promise((res) => { v._resolve = res; });
        },
        // sort 完了をテストから起こす
        finishSort() { v.sortRunning = false; const r = v._resolve; v._resolve = null; if (r) r(true); },
    };
    return v;
}

(async () => {
    const path = require('path');
    const modPath = path.join(__dirname, '.adaptive-sort.cjs');

    // ========== case 1: adaptive-gpu の基本動作 ==========
    makeEnv('?sortPolicy=adaptive-gpu');
    delete require.cache[modPath];
    const m = require(modPath);
    const v = makeViewer();
    const stats = await m.installAdaptiveSort({ viewer: v });
    ok(stats.applied === true, 'applied', JSON.stringify({reason: stats.reason, backend: stats.backend}));
    ok(stats.backend === 'gpu', 'backend=gpu');

    // 初回 = 必ず sort
    v.runSplatSort(true, true);
    ok(stats.initialSorts === 1 && stats.started === 1, '初回は必ず sort',
       `initialSorts=${stats.initialSorts} started=${stats.started}`);

    // sort 中にカメラ静止のまま 30 フレーム → queue しない
    for (let i = 0; i < 30; i++) v.runSplatSort(true, true);
    ok(stats.started === 1, 'sort 中は新しい sort を発行しない', `started=${stats.started}`);
    ok(stats.coalescedWhileRunning === 0, 'カメラ静止なら coalesce もしない');

    v.finishSort();
    await new Promise(r => setTimeout(r, 5));

    // ★ 本題: カメラ静止で 600 フレーム → sort 0 回
    const before = stats.started;
    for (let i = 0; i < 600; i++) v.runSplatSort(true, true);
    ok(stats.started === before, '★ カメラ静止 600 フレームで sort 0 回',
       `started=${stats.started} skippedUnchanged=${stats.skippedUnchanged}`);
    ok(stats.completed === 1, 'sortRunning の立ち下がりを検出', `completed=${stats.completed}`);

    // カメラを動かす → 1 回 sort
    v.camera.position.x += 0.01;
    v.runSplatSort(true, true);
    ok(stats.started === before + 1, 'カメラ変化で 1 回 sort', `started=${stats.started}`);
    ok(stats.cameraChangeEvents >= 1, 'cameraChangeEvents を数えている');

    // sort 中に 100 回カメラ移動 → queue せず dirty だけ
    for (let i = 0; i < 100; i++) { v.camera.position.x += 0.001; v.runSplatSort(true, true); }
    ok(stats.started === before + 1, '★ sort 中の 100 回 camera event で sort は増えない',
       `started=${stats.started} coalesced=${stats.coalescedWhileRunning}`);
    ok(stats.coalescedWhileRunning === 100, 'coalescedWhileRunning=100',
       `=${stats.coalescedWhileRunning}`);

    // 完了 → カメラ停止。次フレームで最終 sort が 1 回だけ走る
    v.finishSort();
    await new Promise(r => setTimeout(r, 5));
    v.runSplatSort(true, true);
    ok(stats.started === before + 2, '★ 停止後の最終 sort が 1 回走る', `started=${stats.started}`);
    v.finishSort();
    await new Promise(r => setTimeout(r, 5));
    const afterFinal = stats.started;
    for (let i = 0; i < 300; i++) v.runSplatSort(true, true);
    ok(stats.started === afterFinal, '★ 最終 sort 後は再び 0 回', `started=${stats.started}`);

    // projection (resize) 変化 → sort
    v.camera.projectionMatrix.elements[0] = 1.5;
    v.runSplatSort(true, true);
    ok(stats.projectionChangeEvents === 1 && stats.started === afterFinal + 1,
       'projection 変化 (resize) で sort', `projEvents=${stats.projectionChangeEvents}`);
    v.finishSort(); await new Promise(r => setTimeout(r, 5));

    // epsilon 未満の揺れは無視
    const s2 = stats.started;
    v.camera.position.x += 1e-9;
    for (let i = 0; i < 50; i++) v.runSplatSort(true, true);
    ok(stats.started === s2, 'epsilon 未満の変化は sort しない', `started=${stats.started}`);

    console.log('');
    console.log('  stats:', JSON.stringify({
        calls: stats.calls, started: stats.started, completed: stats.completed,
        skippedUnchanged: stats.skippedUnchanged,
        coalescedWhileRunning: stats.coalescedWhileRunning,
        dirtyResorts: stats.dirtyResorts,
        cameraChangeEvents: stats.cameraChangeEvents,
        projectionChangeEvents: stats.projectionChangeEvents,
        fallbackCount: stats.fallbackCount,
    }));
    const skipRate = 100 * stats.skippedUnchanged / stats.calls;
    console.log(`  skip 率 = ${skipRate.toFixed(1)}%  (出荷版は 0%、呼び出しのほぼ全部が sort 要求)`);
    console.log('');

    // ========== case 2: adaptive-cpu は後付けでは適用しない ==========
    // 実機の外見劣化 (口元の depth order 崩れ) の原因になった回帰。
    // sort worker への centers 送信は Viewer.js:1490 でロード時の
    // gpuAcceleratedSort により決まるので、後から false にすると
    // worker がゼロ埋め centers で深度を計算して並び順が壊れる。
    makeEnv('?sortPolicy=adaptive-cpu');
    delete require.cache[modPath];
    const m2 = require(modPath);
    const v2 = makeViewer();              // gpuAcceleratedSort = true でロード済み
    const orig2 = v2.runSplatSort;
    const st2 = await m2.installAdaptiveSort({ viewer: v2 });
    ok(st2.applied === false && v2.runSplatSort === orig2,
       '★ adaptive-cpu はロード後には適用しない', st2.reason);
    ok(v2.gpuAcceleratedSort === true,
       '★ gpuAcceleratedSort を書き換えない (worker の centers と不整合になる)',
       'gpuAcceleratedSort=' + v2.gpuAcceleratedSort);

    // ロード時点で既に cpu だった renderer では使える
    makeEnv('?sortPolicy=adaptive-cpu');
    delete require.cache[modPath];
    const m2b = require(modPath);
    const v2b = makeViewer();
    v2b.gpuAcceleratedSort = false;       // = ロード時から cpu だった renderer
    const st2b = await m2b.installAdaptiveSort({ viewer: v2b });
    ok(st2b.applied === true && st2b.backend === 'cpu',
       'ロード時から gpuAcceleratedSort=false なら adaptive-cpu を受け付ける',
       `backend=${st2b.backend}`);

    // ========== case 3: stock は何もしない ==========
    makeEnv('');
    delete require.cache[modPath];
    const m3 = require(modPath);
    const v3 = makeViewer();
    const orig3 = v3.runSplatSort;
    const st3 = await m3.installAdaptiveSort({ viewer: v3 });
    ok(st3.applied === false && v3.runSplatSort === orig3,
       'stock は runSplatSort を差し替えない', st3.reason);

    // ========== case 4: FULL133 以外は適用しない ==========
    makeEnv('?sortPolicy=adaptive-gpu');
    global.window.__lamAvatarConfig = { modelUrl: '/avatar/meruru.zip' };
    delete require.cache[modPath];
    const m4 = require(modPath);
    const v4 = makeViewer();
    v4.splatMesh.getSplatCount = () => 20018;
    const orig4 = v4.runSplatSort;
    const st4 = await m4.installAdaptiveSort({ viewer: v4 });
    ok(st4.applied === false && v4.runSplatSort === orig4,
       '★ FULL133 以外には適用しない', st4.reason);

    // ========== case 5: sortMode=10fps との同時指定は拒否 ==========
    makeEnv('?sortPolicy=adaptive-gpu&sortMode=10fps');
    delete require.cache[modPath];
    const m5 = require(modPath);
    const v5 = makeViewer();
    const orig5 = v5.runSplatSort;
    const st5 = await m5.installAdaptiveSort({ viewer: v5 });
    ok(st5.applied === false && v5.runSplatSort === orig5,
       'sortMode=10fps と同時指定は拒否', st5.reason);

    // ========== case 6: 例外で出荷版へ戻る ==========
    makeEnv('?sortPolicy=adaptive-gpu');
    delete require.cache[modPath];
    const m6 = require(modPath);
    const v6 = makeViewer();
    const orig6 = v6.runSplatSort;
    const st6 = await m6.installAdaptiveSort({ viewer: v6 });
    v6.runSplatSort(true, true); v6.finishSort();
    await new Promise(r => setTimeout(r, 5));
    v6.camera = null;                       // signature 読みで例外を起こす
    v6.runSplatSort(true, true);
    ok(st6.fallbackCount === 1 && st6.lastError !== null && v6.runSplatSort === orig6,
       '例外で出荷版へ戻し fallbackCount を記録',
       `fallbackCount=${st6.fallbackCount} lastError=${st6.lastError}`);

    // ========== case 7: avatar-config 由来の policy (URL パラメータ不要) ==========
    // 実測で backend が決まった後の本番適用経路。
    makeEnv('');
    global.fetch = async () => ({
        ok: true,
        json: async () => ([
            { id: 'uika-full133-skin', name: 'UIKA FULL 133K',
              modelUrl: '/avatar/uika-full133-skin.zip', voiceModel: 'x',
              sortPolicy: 'adaptive-cpu' },
        ]),
    });
    delete require.cache[modPath];
    const m7 = require(modPath);
    const v7 = makeViewer();
    const st7 = await m7.installAdaptiveSort({ viewer: v7 });
    ok(st7.mode === 'adaptive-cpu' && st7.source === 'avatar-config',
       '★ URL なしで avatar-config から policy が読まれる',
       `mode=${st7.mode} source=${st7.source}`);
    ok(st7.applied === false && v7.gpuAcceleratedSort === true,
       '★ avatar-config 経由でも adaptive-cpu は後付け適用しない', st7.reason);

    // adaptive-gpu は avatar-config から有効になる (backend を触らないため)
    makeEnv('');
    global.fetch = async () => ({
        ok: true,
        json: async () => ([
            { id: 'uika-full133-skin', name: 'UIKA FULL 133K',
              modelUrl: '/avatar/uika-full133-skin.zip', voiceModel: 'x',
              sortPolicy: 'adaptive-gpu' },
        ]),
    });
    delete require.cache[modPath];
    const m7b = require(modPath);
    const v7b = makeViewer();
    const st7b = await m7b.installAdaptiveSort({ viewer: v7b });
    ok(st7b.applied === true && st7b.backend === 'gpu'
        && st7b.source === 'avatar-config' && v7b.gpuAcceleratedSort === true,
       '★ adaptive-gpu は avatar-config から有効になり backend を触らない',
       `backend=${st7b.backend}`);

    // URL override が avatar-config より優先される
    makeEnv('?sortPolicy=stock');
    global.fetch = async () => ({
        ok: true,
        json: async () => ([
            { id: 'uika-full133-skin', name: 'x',
              modelUrl: '/avatar/uika-full133-skin.zip', voiceModel: 'x',
              sortPolicy: 'adaptive-cpu' },
        ]),
    });
    delete require.cache[modPath];
    const m8 = require(modPath);
    const v8 = makeViewer();
    const orig8 = v8.runSplatSort;
    const st8 = await m8.installAdaptiveSort({ viewer: v8 });
    ok(st8.applied === false && st8.source === 'url' && v8.runSplatSort === orig8,
       '?sortPolicy=stock が avatar-config を上書きする', `source=${st8.source}`);

    console.log('');
    console.log(failures === 0 ? '=== 全テスト PASS ===' : `=== ${failures} 件 FAIL ===`);
    process.exit(failures === 0 ? 0 : 1);
})();
