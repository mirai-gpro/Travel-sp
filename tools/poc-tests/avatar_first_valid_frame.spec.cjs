// tools/poc-tests/avatar_first_valid_frame.spec.cjs
//
// FIRST_VALID_FRAME_RENDERED / AVATAR_VISIBLE の回帰テスト
// （Startup Architecture Phase 3）。
//
// 固定する不変条件:
//   A  表示準備完了（renderer 構築 / model load / scene 登録 / loop 開始）だけでは
//      signal が出ない
//   B  firstRenderTime が未設定(-1)から有効値へ変化した瞬間に 1 回だけ出る
//   C  その後 100 frame 相当観測しても 1 回のまま
//   D  同じ firstRenderTime を何度観測しても 1 回のまま
//   E  Avatar lifecycle（dispose -> initialize）ごとに 1 回
//   F  Live generation とは独立（generation ごとに再発火しない）
//   G  signal 発火が Greeting / live_start / audio playback を開始しない
//   H  Phase 2 の起動挙動（double reset / 300ms / 自動 Greeting / A2E）が不変
//
// ------------------------------------------------------------------
// 実行方法
// ------------------------------------------------------------------
//   node tools/poc-tests/avatar_first_valid_frame.spec.cjs
//
// ------------------------------------------------------------------
// mock する範囲
// ------------------------------------------------------------------
// 実 LAMWebSocketManager / 実 CoreController を esbuild でバンドルして読み込む。
// signal の判定ロジック（_observeFirstValidFrame）は差し替えない。
// 差し替えるのは以下だけ:
//   * ブラウザ環境（_browser-env.cjs）
//   * gaussian-splat-renderer-for-lam パッケージ（esbuild alias で stub に差し替え）
//     → WebGL を node で動かせないため。node_modules は読むだけで変更しない。
//
// stub の splatMesh は、実 renderer の SplatMesh.updateRenderIndexes()
// （node_modules/.../gaussian-splat-renderer-for-lam.module.js:65143-65151）
// と同じ処理を再現する。実装が変わったら検知できるよう、
// 静的検査で実 module の該当行の存在も確認する。

const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const RENDERER_MODULE = path.join(
    REPO_ROOT, 'node_modules', 'gaussian-splat-renderer-for-lam',
    'build', 'gaussian-splat-renderer-for-lam.module.js');

const RESULTS = [];
function ok(cond, name, extra) {
    cond = !!cond;
    RESULTS.push([name, cond]);
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
}

// ============================================================
// ブラウザ環境
// ============================================================
const env = require('./_browser-env.cjs');
env.install({
    pathname: '/concierge',
    localStorage: { selectedCamera_concierge: 'uika', selectedCamera_chat: 'uika' },
});

// ============================================================
// renderer パッケージの stub
// ============================================================
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avatar-ffvr-'));
const stubPath = path.join(tmpDir, 'renderer-stub.cjs');
fs.writeFileSync(stubPath, `
// gaussian-splat-renderer-for-lam の stub（WebGL は node で動かせない）
// esbuild の alias は stub を bundle に inline するため、spec 側が直接 require した
// copy とは別インスタンスになる。状態は globalThis で共有する。
const STATE = globalThis.__RENDERER_STUB_STATE
  || (globalThis.__RENDERER_STUB_STATE = { getExpressionData: null, renderers: [], splatMeshes: [] });

function makeSplatMesh() {
  const mesh = {
    firstRenderTime: -1,                 // 実装と同じ初期値
    scenes: [],
    geometry: {
      instanceCount: 0,
      drawRange: { start: 0, count: 0 },
      attributes: { splatIndex: { set() {}, needsUpdate: false } },
    },
    // SplatMesh.updateRenderIndexes() の再現（module.js:65143-65151）
    updateRenderIndexes(globalIndexes, renderSplatCount) {
      const geometry = this.geometry;
      geometry.attributes.splatIndex.set(globalIndexes);
      geometry.attributes.splatIndex.needsUpdate = true;
      if (renderSplatCount > 0 && this.firstRenderTime === -1) {
        this.firstRenderTime = performance.now();
      }
      geometry.instanceCount = renderSplatCount;
      geometry.drawRange = { start: 0, count: renderSplatCount };
    },
  };
  STATE.splatMeshes.push(mesh);
  return mesh;
}

class GaussianSplatRenderer {
  static async getInstance(container, assetPath, options) {
    const renderer = new GaussianSplatRenderer();
    renderer.getChatState = options && options.getChatState;
    renderer.getExpressionData = options && options.getExpressionData;
    // Viewer 構造: renderer.viewer.splatMesh（camera は付けない＝camera 調整を通さない）
    renderer.viewer = { splatMesh: makeSplatMesh(), useFlame: false };
    STATE.getExpressionData = renderer.getExpressionData;
    STATE.renderers.push(renderer);
    return renderer;
  }
}

class Viewer {}
const SceneFormat = { Ply: 0, Splat: 1, KSplat: 2 };

module.exports = { GaussianSplatRenderer, Viewer, SceneFormat, __STATE: STATE };
`, 'utf8');

const esbuild = require(path.join(REPO_ROOT, 'node_modules', 'esbuild'));
function bundle(entryRel, outName) {
    const outfile = path.join(tmpDir, outName);
    esbuild.buildSync({
        entryPoints: [path.join(REPO_ROOT, entryRel)],
        outfile,
        bundle: true,
        format: 'cjs',
        platform: 'neutral',
        target: 'es2020',
        logLevel: 'silent',
        mainFields: ['module', 'main'],
        alias: { 'gaussian-splat-renderer-for-lam': stubPath },
    });
    return require(outfile);
}

const lamBundle = bundle('src/scripts/chat/lam-websocket-manager.ts', 'lam.bundle.cjs');
const { LAMWebSocketManager } = lamBundle;
require(stubPath);                              // globalThis に STATE を用意させる
const STUB = globalThis.__RENDERER_STUB_STATE;

// ============================================================
// ヘルパ
// ============================================================
function newManager() {
    STUB.getExpressionData = null;
    STUB.renderers.length = 0;
    STUB.splatMeshes.length = 0;
    return new LAMWebSocketManager();
}

async function initManager(mgr) {
    const signals = [];
    mgr.onFirstValidFrame((info) => signals.push(info));
    await mgr.initialize({
        containerElement: env.makeElement('div'),
        modelUrl: '/avatar/test.zip',
    });
    return signals;
}

/** renderer の render loop の 1 frame 分（getExpressionData の呼び出し）を再現する */
function frame() {
    if (typeof STUB.getExpressionData !== 'function') {
        throw new Error('getExpressionData が renderer へ渡っていない');
    }
    STUB.getExpressionData();
}

const splatMesh = () => STUB.splatMeshes[STUB.splatMeshes.length - 1];

// ============================================================
(async function main() {

// ---------- 静的検査: 依存側の前提が崩れていないこと ----------
console.log('\n=== 静的検査: renderer 側の前提 ===');
{
    const rendererSrc = fs.readFileSync(RENDERER_MODULE, 'utf8');
    ok(rendererSrc.includes(
        'if (renderSplatCount > 0 && this.firstRenderTime === -1) this.firstRenderTime = performance.now();'),
       '静的-1 firstRenderTime を立てる実装行が renderer に存在する');
    ok(rendererSrc.includes('this.firstRenderTime = -1;'),
       '静的-2 firstRenderTime の初期値 -1 が renderer に存在する');
    ok(/renderer\.getExpressionData = options/.test(rendererSrc)
       && /if \(this\.getExpressionData\) \{/.test(rendererSrc),
       '静的-3 render loop が getExpressionData を毎フレーム呼ぶ実装が存在する');

    const mgrSrc = fs.readFileSync(
        path.join(REPO_ROOT, 'src', 'scripts', 'chat', 'lam-websocket-manager.ts'), 'utf8');
    const observeBody = mgrSrc.slice(mgrSrc.indexOf('private _observeFirstValidFrame'),
                                     mgrSrc.indexOf('private _getExpressionData'));
    ok(!/setInterval/.test(observeBody),
       '静的-4 観測処理に setInterval の常時 polling を使っていない');
    ok(!/requestAnimationFrame|setTimeout/.test(observeBody),
       '静的-5 観測処理に新しい loop / 固定待機を作っていない');
    ok(/firstRenderTime < 0\) return/.test(observeBody)
       && /instanceCount/.test(observeBody)
       && /drawRange/.test(observeBody)
       && /scenes\.length === 0\) return/.test(observeBody),
       '静的-6 判定条件 4 つ（scene / splat数 / drawRange / firstRenderTime）が揃っている');

    // node_modules を変更していないこと（git 管理外なので mtime ではなく内容で見る）
    ok(!/__travelSpPatched|FIRST_VALID_FRAME/.test(rendererSrc),
       '静的-7 node_modules の renderer にアプリ側の変更が入っていない');
}

// ---------- Test A: early false-positive prevention ----------
console.log('\n=== Test A: 表示準備完了だけでは signal を出さない ===');
const mgr = newManager();
const signals = await initManager(mgr);

ok(STUB.renderers.length === 1,
   'A-1 renderer が構築され getInstance が resolve した', `count=${STUB.renderers.length}`);
ok(typeof STUB.getExpressionData === 'function',
   'A-2 render loop の callback（getExpressionData）が renderer へ渡っている');
ok(!!splatMesh(), 'A-3 viewer.splatMesh へ到達できる');
ok(splatMesh().firstRenderTime === -1,
   'A-4 この時点の firstRenderTime は未設定値 -1', `value=${splatMesh().firstRenderTime}`);
ok(signals.length === 0,
   'A-5 renderer 構築 / model load / scene 登録の時点では signal 0 回',
   `count=${signals.length}`);

// animation loop が回り始めただけでは出ない
for (let i = 0; i < 30; i++) frame();
ok(signals.length === 0,
   'A-6 animation loop が 30 frame 回っても signal 0 回（splat 未描画）',
   `count=${signals.length}`);

// scene 登録だけ済んで描画対象が 0 のケース
splatMesh().scenes = [{ name: 'scene0' }];
for (let i = 0; i < 10; i++) frame();
ok(signals.length === 0,
   'A-7 scene 登録済みでも描画対象 splat が 0 なら signal 0 回',
   `count=${signals.length}`);

// firstRenderTime だけ有効でも、描画対象が 0 なら出ない
splatMesh().firstRenderTime = performance.now();
for (let i = 0; i < 10; i++) frame();
ok(signals.length === 0,
   'A-8 firstRenderTime が有効でも instanceCount=0 なら signal 0 回',
   `count=${signals.length}`);
splatMesh().firstRenderTime = -1;   // 実際の初期状態へ戻す

ok(mgr.hasRenderedFirstValidFrame() === false,
   'A-9 hasRenderedFirstValidFrame() も false のまま');

// ---------- Test B: 最初の実描画 ----------
console.log('\n=== Test B: firstRenderTime が有効値になった瞬間 ===');
// 実 renderer と同じ経路（sort 完了 -> updateRenderIndexes）を再現する
const beforeUpdate = splatMesh().firstRenderTime;
splatMesh().updateRenderIndexes(new Uint32Array(133541), 133541);
ok(beforeUpdate === -1 && splatMesh().firstRenderTime >= 0,
   'B-1 updateRenderIndexes(count>0) で firstRenderTime が -1 から有効値へ',
   `${beforeUpdate} -> ${splatMesh().firstRenderTime.toFixed(1)}`);
ok(splatMesh().geometry.instanceCount === 133541
   && splatMesh().geometry.drawRange.count === 133541,
   'B-2 同時に instanceCount / drawRange が設定されている',
   `instanceCount=${splatMesh().geometry.instanceCount} drawRange=${splatMesh().geometry.drawRange.count}`);

frame();   // 次の frame で観測される
ok(signals.length === 1, 'B-3 signal は exactly 1 回', `count=${signals.length}`);
ok(signals[0].firstRenderTime === splatMesh().firstRenderTime,
   'B-4 signal の firstRenderTime が renderer の値と一致',
   `signal=${signals[0].firstRenderTime.toFixed(1)}`);
ok(signals[0].renderSplatCount === 133541 && signals[0].sceneCount === 1,
   'B-5 signal に splat 数 / scene 数が入っている',
   `splats=${signals[0].renderSplatCount} scenes=${signals[0].sceneCount}`);
ok(signals[0].delayFromRenderMs >= 0,
   'B-6 firstRenderTime から観測までの遅れが記録されている',
   `delay=${signals[0].delayFromRenderMs.toFixed(2)}ms`);
ok(mgr.hasRenderedFirstValidFrame() === true, 'B-7 hasRenderedFirstValidFrame() が true');

// ---------- Test C / D: 繰り返し ----------
console.log('\n=== Test C/D: 繰り返し frame / 繰り返し観測 ===');
for (let i = 0; i < 100; i++) frame();
ok(signals.length === 1, 'C-1 その後 100 frame 観測しても signal は 1 回',
   `count=${signals.length}`);

// 同じ firstRenderTime を何度観測しても増えない
const held = splatMesh().firstRenderTime;
for (let i = 0; i < 50; i++) { splatMesh().firstRenderTime = held; frame(); }
ok(signals.length === 1, 'D-1 同じ firstRenderTime を 50 回観測しても signal は 1 回',
   `count=${signals.length}`);

// updateRenderIndexes が再度呼ばれても firstRenderTime は変わらず signal も増えない
splatMesh().updateRenderIndexes(new Uint32Array(133541), 133541);
frame();
ok(splatMesh().firstRenderTime === held && signals.length === 1,
   'D-2 updateRenderIndexes 再実行でも firstRenderTime / signal は不変');

// 後から登録したリスナには即座に通知される（登録順に依存しない）
const late = [];
mgr.onFirstValidFrame((info) => late.push(info));
ok(late.length === 1 && late[0].firstRenderTime === held,
   'D-3 成立後に登録したリスナへは即座に 1 回通知される', `count=${late.length}`);

// ---------- Test E: 新しい Avatar lifecycle ----------
console.log('\n=== Test E: Avatar lifecycle ごとに 1 回 ===');
mgr.dispose();
ok(mgr.hasRenderedFirstValidFrame() === false,
   'E-1 dispose() で未発火状態に戻る（lifecycle の終端）');

const signals2 = await initManager(mgr);   // 新しい lifecycle
ok(signals2.length === 0, 'E-2 新 lifecycle の初期状態では signal 0 回',
   `count=${signals2.length}`);
for (let i = 0; i < 20; i++) frame();
ok(signals2.length === 0, 'E-3 新 lifecycle でも描画前は signal 0 回');
splatMesh().scenes = [{ name: 'scene0' }];
splatMesh().updateRenderIndexes(new Uint32Array(1000), 1000);
frame();
ok(signals2.length === 1, 'E-4 新 lifecycle の最初の実描画で改めて 1 回',
   `count=${signals2.length}`);
for (let i = 0; i < 50; i++) frame();
ok(signals2.length === 1, 'E-5 新 lifecycle でもその後は増えない',
   `count=${signals2.length}`);

// ---------- Test F / G / H: 上位 controller との関係 ----------
console.log('\n=== Test F/G/H: generation 独立 / Greeting 非干渉 ===');
{
    const coreBundle = bundle('src/scripts/chat/core-controller.ts', 'core.bundle.cjs');
    const { CoreController } = coreBundle;
    const socket = env.makeFakeSocket();
    global.io = () => socket;
    const container = env.makeElement('div');
    container.querySelector = () => env.makeElement('div');
    const c = new CoreController(container, 'http://localhost:8080');
    c.initSocket();
    c.bindEvents();          // avatar:first-valid-frame のリスナを登録する

    ok(c.avatarVisible === false, 'G-1 初期状態では avatarVisible = false');

    // Phase 2 の generation 状態を用意する
    c.generationCounter = 1;
    c.activeGenerationId = 1;
    c.activeStartupRole = 'warmup';
    socket.clearEmitted();

    // Avatar subsystem からの signal を中継する（LAMAvatar.astro と同じ CustomEvent）
    const detail = {
        firstRenderTime: 1234.5, observedAt: 1240.0, renderSplatCount: 133541,
        sceneCount: 1, delayFromRenderMs: 5.5,
    };
    document.dispatchEvent(new CustomEvent('avatar:first-valid-frame', { detail }));

    ok(c.avatarVisible === true, 'G-2 signal を受けて avatarVisible = true');
    ok(c.avatarFirstValidFrame && c.avatarFirstValidFrame.firstRenderTime === 1234.5,
       'G-3 診断値を保持している');
    ok(socket.emitted.length === 0,
       'G-4 signal 発火で live_start / greeting_trigger 等を送っていない',
       `emitted=${JSON.stringify(socket.emitted.map((e) => e.event))}`);

    // F: generation を切り替えても avatarVisible は変わらない（別 lifecycle）
    c.retireGeneration();
    ok(c.avatarVisible === true,
       'F-1 generation retire で avatarVisible を落とさない');
    c.allocateGeneration('final');
    ok(c.avatarVisible === true && c.activeGenerationId === 2,
       'F-2 新 generation 発行でも avatarVisible は維持される',
       `active=${c.activeGenerationId}`);

    // 同じ Avatar instance を共有しているので generation ごとに再発火しない
    document.dispatchEvent(new CustomEvent('avatar:first-valid-frame', { detail }));
    ok(c.avatarFirstValidFrame.firstRenderTime === 1234.5,
       'F-3 2 回目の通知が来ても状態は 1 回目のまま（generation 再発火なし）');

    const coreSrc = fs.readFileSync(
        path.join(REPO_ROOT, 'src', 'scripts', 'chat', 'core-controller.ts'), 'utf8');
    const retireBody = coreSrc.slice(coreSrc.indexOf('protected retireGeneration'),
                                     coreSrc.indexOf('protected allocateGeneration'));
    const allocBody = coreSrc.slice(coreSrc.indexOf('protected allocateGeneration'),
                                    coreSrc.indexOf('protected acceptGeneration'));
    ok(!/avatarVisible/.test(retireBody) && !/avatarVisible/.test(allocBody),
       'F-4 generation の retire / allocate は avatarVisible を触らない');

    const avatarListener = coreSrc.slice(
        coreSrc.indexOf("document.addEventListener('avatar:first-valid-frame'"),
        coreSrc.indexOf('const resetHandler'));
    ok(!/live_start|greeting_trigger|startLiveMode|playPcmAudio|startStreaming/.test(avatarListener),
       'G-5 signal の受け口に Greeting / audio 開始処理が入っていない');
    ok(!/live_connected/.test(avatarListener),
       'G-6 live_connected との AND を Phase 3 では結合していない');

    // H: Phase 2 の起動挙動
    const initBody = coreSrc.slice(coreSrc.indexOf('async init()'),
                                   coreSrc.indexOf('protected getUserId'));
    ok((initBody.match(/await this\.resetAppContent\(/g) || []).length === 2,
       'H-1 double reset は 2 回のまま');
    ok(/resetAppContent\('warmup'\)/.test(initBody) && /resetAppContent\('final'\)/.test(initBody),
       'H-2 G1 = warmup / G2 = final が維持されている');
    ok(/setTimeout\(resolve, 300\)/.test(coreSrc), 'H-3 300ms 待機が維持されている');
    ok(/}, 10000\);/.test(initBody) && /}, 2000\);/.test(initBody),
       'H-4 splash の 10 秒 / 2 秒タイマーを変更していない');

    const avatarSrc = fs.readFileSync(
        path.join(REPO_ROOT, 'src', 'components', 'LAMAvatar.astro'), 'utf8');
    ok(/this\.loadingEl\.classList\.add\('hidden'\)/.test(avatarSrc)
       && !/first-valid-frame[\s\S]{0,200}loadingEl/.test(avatarSrc),
       'H-5 waiting / loading UI の表示タイミングを signal に連動させていない');

    const handlerSrc = fs.readFileSync(
        path.join(REPO_ROOT, 'support-base', 'live_api_handler.py'), 'utf8');
    ok(/if self\.session_count == 1:/.test(handlerSrc)
       && /INITIAL_GREETING_TRIGGERS/.test(handlerSrc)
       && /A2E_FIRST_FLUSH_BYTES = 4800/.test(handlerSrc)
       && /A2E_AUTO_FLUSH_BYTES = 240000/.test(handlerSrc),
       'H-6 現行自動 Greeting / A2E 閾値が不変');
}

// ============================================================
console.log('\n' + '='.repeat(64));
const failures = RESULTS.filter(([, p]) => !p);
RESULTS.forEach(([name, p]) => console.log(`${p ? 'PASS' : 'FAIL'}  ${name}`));
console.log('='.repeat(64));
console.log(`TOTAL ${RESULTS.length}  PASS ${RESULTS.length - failures.length}  FAIL ${failures.length}`);

try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* noop */ }
process.exit(failures.length ? 1 : 0);

})().catch((e) => {
    console.error('HARNESS ERROR:', e);
    process.exit(2);
});
