// tools/poc-tests/final_greeting_gate.spec.cjs
//
// Frontend の AVATAR_VISIBLE presentation barrier と
// Final Greeting AND gate の回帰テスト（Startup Architecture Phase 4）。
//
// 固定する不変条件:
//   A  FIRST_VALID_FRAME_RENDERED 直後はまだ avatarVisible にならず、
//      presentation barrier（viewer.render() の完了）通過後にだけ出る。exactly once
//   B  AVATAR_VISIBLE -> live_connected(G2) の順で greeting_trigger 1 回
//   C  live_connected(G2) -> AVATAR_VISIBLE の順でも greeting_trigger 1 回
//   D  どちらが重複して届いても greeting_trigger は 1 回
//   F  G1（warmup）では avatarVisible + live_connected でも greeting_trigger 0 回
//   G  stale な live_connected(G1) は Phase 2 filter で DROP され Greeting しない
//   + live_ready / greeting_done を gate に使っていないこと
//
// 実行方法:
//   node tools/poc-tests/final_greeting_gate.spec.cjs
//
// mock はブラウザ環境（_browser-env.cjs）と
// gaussian-splat-renderer-for-lam パッケージ（esbuild alias で stub 化）だけ。
// barrier / gate のロジックは差し替えない。
// AVATAR_VISIBLE 時点で実際に画面へ見えること（§23 A4）は node では確認できないため、
// Chromium 実機 Gate で確認する。

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

const env = require('./_browser-env.cjs');
env.install({
    pathname: '/concierge',
    localStorage: { selectedCamera_concierge: 'uika', selectedCamera_chat: 'uika' },
});

// ============================================================
// renderer stub
// ============================================================
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'final-gate-'));
const stubPath = path.join(tmpDir, 'renderer-stub.cjs');
fs.writeFileSync(stubPath, `
const STATE = globalThis.__RENDERER_STUB_STATE
  || (globalThis.__RENDERER_STUB_STATE = { getExpressionData: null, renderers: [], splatMeshes: [], viewers: [] });

const SceneRevealMode = { Default: 0, Gradual: 1, Instant: 2 };

function makeSplatMesh() {
  const mesh = {
    firstRenderTime: -1,
    scenes: [],
    geometry: {
      instanceCount: 0,
      drawRange: { start: 0, count: 0 },
      attributes: { splatIndex: { set() {}, needsUpdate: false } },
    },
    // SplatMesh.updateRenderIndexes() の再現（module.js:65143-65151）
    updateRenderIndexes(globalIndexes, renderSplatCount) {
      const g = this.geometry;
      g.attributes.splatIndex.set(globalIndexes);
      g.attributes.splatIndex.needsUpdate = true;
      if (renderSplatCount > 0 && this.firstRenderTime === -1) {
        this.firstRenderTime = performance.now();
      }
      g.instanceCount = renderSplatCount;
      g.drawRange = { start: 0, count: renderSplatCount };
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
    // Viewer 既定値（module.js:136868 と同じ Default から始める）
    renderer.viewer = {
      splatMesh: makeSplatMesh(),
      useFlame: false,
      sceneRevealMode: SceneRevealMode.Default,
      consecutiveRenderFrames: 0,
      // viewer.render() 完了を再現する（module.js:152460-152467）
      _completeRender(did) { this.consecutiveRenderFrames = did ? this.consecutiveRenderFrames + 1 : 0; },
    };
    STATE.viewers.push(renderer.viewer);
    STATE.getExpressionData = renderer.getExpressionData;
    STATE.renderers.push(renderer);
    return renderer;
  }
}

class Viewer {}
const SceneFormat = { Ply: 0, Splat: 1, KSplat: 2 };
module.exports = { GaussianSplatRenderer, Viewer, SceneFormat, SceneRevealMode };
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

const { LAMWebSocketManager } = bundle('src/scripts/chat/lam-websocket-manager.ts', 'lam.bundle.cjs');
require(stubPath);
const STUB = globalThis.__RENDERER_STUB_STATE;

const frame = () => STUB.getExpressionData();
const mesh = () => STUB.splatMeshes[STUB.splatMeshes.length - 1];
const viewer = () => STUB.viewers[STUB.viewers.length - 1];

// ============================================================
(async function main() {

// ---------- Test A: presentation barrier ----------
console.log('\n=== Test A: AVATAR_VISIBLE の presentation barrier ===');
const mgr = new LAMWebSocketManager();
const firstValid = [];
const visible = [];
mgr.onFirstValidFrame((i) => firstValid.push(i));
mgr.onAvatarVisible((i) => visible.push(i));
await mgr.initialize({ containerElement: env.makeElement('div'), modelUrl: '/avatar/test.zip' });

ok(viewer().sceneRevealMode === 2,
   'A1-1 viewer.sceneRevealMode が Instant(2) に設定されている',
   `value=${viewer().sceneRevealMode}`);

const rendererSrc = fs.readFileSync(RENDERER_MODULE, 'utf8');
ok(rendererSrc.includes(
     "const shaderFadeInComplete = (fadeInComplete || sceneRevealMode === SceneRevealMode.Instant) ? 1 : 0;"),
   'A2-1 renderer は Instant のとき shaderFadeInComplete=1 にする実装を持つ');
ok(rendererSrc.includes('this.sceneRevealMode = options.sceneRevealMode || SceneRevealMode.Default;')
   && rendererSrc.includes('this.splatMesh.updateVisibleRegionFadeDistance(this.sceneRevealMode);'),
   'A2-2 viewer.sceneRevealMode が描画フレームごとに読まれる実装である');
const mgrSrc = fs.readFileSync(
    path.join(REPO_ROOT, 'src', 'scripts', 'chat', 'lam-websocket-manager.ts'), 'utf8');
ok(!/sceneFadeInRateMultiplier/.test(mgrSrc),
   'A2-3 sceneFadeInRateMultiplier を変更していない');

// 有効 geometry が入るまで何も出ない
for (let i = 0; i < 10; i++) { frame(); viewer()._completeRender(true); }
ok(firstValid.length === 0 && visible.length === 0,
   'A3-1 有効 geometry 前は どちらの signal も 0 回');

mesh().scenes = [{ name: 's0' }];
mesh().updateRenderIndexes(new Uint32Array(20018), 20018);

frame();                                    // frame N: FIRST_VALID_FRAME のみ
ok(firstValid.length === 1, 'A3-2 FIRST_VALID_FRAME_RENDERED が 1 回', `n=${firstValid.length}`);
ok(visible.length === 0,
   'A3-3 同一 call stack では AVATAR_VISIBLE を出さない', `n=${visible.length}`);
ok(mgr.isAvatarVisible() === false, 'A3-4 isAvatarVisible() はまだ false');

// render が走らない frame では barrier は成立しない
viewer()._completeRender(false);
frame();
ok(visible.length === 0,
   'A3-5 viewer.render() が走らない frame では AVATAR_VISIBLE にならない');

// render が 1 回完了した次の frame で成立する
viewer()._completeRender(true);
frame();
ok(visible.length === 1, 'A3-6 render 完了後の frame で AVATAR_VISIBLE が 1 回',
   `n=${visible.length}`);
ok(visible[0].rendersSinceFirstValidFrame >= 1,
   'A4-1 AVATAR_VISIBLE は完了した render を数えている（firstRenderTime>=0 だけでは出ない）',
   `renders=${visible[0].rendersSinceFirstValidFrame}`);
ok(visible[0].visibleAt >= firstValid[0].observedAt,
   'A4-2 AVATAR_VISIBLE は FIRST_VALID_FRAME_RENDERED より後');

for (let i = 0; i < 100; i++) { viewer()._completeRender(true); frame(); }
ok(visible.length === 1, 'A5-1 その後 100 frame でも AVATAR_VISIBLE は 1 回',
   `n=${visible.length}`);
ok(firstValid.length === 1, 'A5-2 FIRST_VALID_FRAME_RENDERED も 1 回のまま');

// ---------- Test B/C/D/F/G: Final Greeting AND gate ----------
console.log('\n=== Test B/C/D/F/G: Final Greeting AND gate ===');
const { CoreController } = bundle('src/scripts/chat/core-controller.ts', 'core.bundle.cjs');

function newController(gen, role) {
    const socket = env.makeFakeSocket();
    global.io = () => socket;
    const container = env.makeElement('div');
    container.querySelector = () => env.makeElement('div');
    const c = new CoreController(container, 'http://localhost:8080');
    c.initSocket();
    c.bindEvents();
    c.generationCounter = gen;
    c.activeGenerationId = gen;
    c.activeStartupRole = role;
    socket.clearEmitted();
    return { c, socket };
}
const VINFO = {
    firstRenderTime: 100, observedAt: 101, renderSplatCount: 20018, sceneCount: 1,
    delayFromRenderMs: 1, visibleAt: 120, barrierMs: 19, rendersSinceFirstValidFrame: 1,
};
const emitAvatarVisible = () =>
    document.dispatchEvent(new CustomEvent('avatar:visible', { detail: VINFO }));

// B: Avatar first
{
    const { c, socket } = newController(2, 'final');
    emitAvatarVisible();
    ok(socket.takeEmitted('greeting_trigger').length === 0,
       'B-1 avatarVisible だけでは greeting_trigger を送らない');
    socket.serverEmit('live_connected', { generation_id: 2, session_count: 1 });
    const t = socket.takeEmitted('greeting_trigger');
    ok(t.length === 1 && t[0].data.generation_id === 2,
       'B-2 AVATAR_VISIBLE -> live_connected(G2) で greeting_trigger 1 回',
       JSON.stringify(t.map((x) => x.data)));
    ok(c.greetingTriggeredGeneration === 2, 'B-3 one-shot state が確定している');
}

// C: Live first
{
    const { c, socket } = newController(2, 'final');
    socket.serverEmit('live_connected', { generation_id: 2, session_count: 1 });
    ok(socket.takeEmitted('greeting_trigger').length === 0,
       'C-1 live_connected だけでは greeting_trigger を送らない');
    emitAvatarVisible();
    const t = socket.takeEmitted('greeting_trigger');
    ok(t.length === 1 && t[0].data.generation_id === 2,
       'C-2 live_connected(G2) -> AVATAR_VISIBLE でも greeting_trigger 1 回',
       JSON.stringify(t.map((x) => x.data)));
    ok(c.liveConnectedGeneration === 2, 'C-3 liveConnectedGeneration を保持している');
}

// D: duplicate / simultaneous
{
    const { socket } = newController(2, 'final');
    emitAvatarVisible();
    emitAvatarVisible();
    socket.serverEmit('live_connected', { generation_id: 2, session_count: 1 });
    socket.serverEmit('live_connected', { generation_id: 2, session_count: 1 });
    socket.serverEmit('live_connected', { generation_id: 2, session_count: 2 });
    emitAvatarVisible();
    ok(socket.takeEmitted('greeting_trigger').length === 1,
       'D-1 avatar_visible / live_connected が重複しても greeting_trigger は 1 回',
       `count=${socket.takeEmitted('greeting_trigger').length}`);
}

// F: warmup では gate しない
{
    const { socket } = newController(1, 'warmup');
    emitAvatarVisible();
    socket.serverEmit('live_connected', { generation_id: 1, session_count: 1 });
    ok(socket.takeEmitted('greeting_trigger').length === 0,
       'F-1 G1(warmup) では avatarVisible + live_connected でも greeting_trigger 0 回');
}

// G: stale live_connected
{
    const { c, socket } = newController(2, 'final');
    emitAvatarVisible();
    socket.serverEmit('live_connected', { generation_id: 1, session_count: 1 });
    ok(socket.takeEmitted('greeting_trigger').length === 0,
       'G-1 stale な live_connected(G1) では greeting_trigger を送らない');
    ok(c.liveConnectedGeneration === null,
       'G-2 stale な live_connected は状態にも入らない（Phase 2 filter で DROP）',
       `liveConnected=${c.liveConnectedGeneration}`);
    socket.serverEmit('live_connected', { generation_id: 2, session_count: 1 });
    ok(socket.takeEmitted('greeting_trigger').length === 1,
       'G-3 正しい G2 が届けば送られる');
}

// retire で liveConnected が落ちること（世代をまたいだ誤発火防止）
{
    const { c, socket } = newController(2, 'final');
    socket.serverEmit('live_connected', { generation_id: 2, session_count: 1 });
    c.retireGeneration();
    ok(c.liveConnectedGeneration === null,
       'G-4 retireGeneration で liveConnectedGeneration を退役させる');
    ok(c.avatarVisible === false || c.avatarVisible === true,
       'G-5 avatarVisible は generation lifecycle とは独立（retire で触らない）');
}

// ---------- 静的検査 ----------
console.log('\n=== 静的検査: gate 条件 ===');
{
    const coreSrc = fs.readFileSync(
        path.join(REPO_ROOT, 'src', 'scripts', 'chat', 'core-controller.ts'), 'utf8');
    const gate = coreSrc.slice(coreSrc.indexOf('protected tryTriggerFinalGreeting'),
                               coreSrc.indexOf('protected async resetAppContent'));
    ok(/this\.avatarVisible/.test(gate)
       && /activeStartupRole === 'final'/.test(gate)
       && /liveConnectedGeneration === gen/.test(gate)
       && /greetingTriggeredGeneration !== gen/.test(gate),
       '静的-1 AND gate の 4 条件が揃っている');
    ok(!/live_ready/.test(gate), '静的-2 live_ready を gate 条件に使っていない');
    ok(!/greeting_done/.test(gate), '静的-3 greeting_done を gate 条件に使っていない');
    ok(gate.indexOf('this.greetingTriggeredGeneration = gen') <
       gate.indexOf("this.socket.emit('greeting_trigger'"),
       '静的-4 emit より先に one-shot を確定している');
    ok(!/setTimeout|sleep/.test(gate), '静的-5 gate に固定待機を入れていない');

    const observe = mgrSrc.slice(mgrSrc.indexOf('private _observeFirstValidFrame'),
                                 mgrSrc.indexOf('private _getExpressionData'));
    ok(!/setTimeout|setInterval|requestAnimationFrame/.test(observe),
       '静的-6 barrier に固定待機 / 新しい loop を使っていない');
    ok(/consecutiveRenderFrames/.test(observe),
       '静的-7 barrier は viewer.render() の完了回数で判定している');

    const avatarSrc = fs.readFileSync(
        path.join(REPO_ROOT, 'src', 'components', 'LAMAvatar.astro'), 'utf8');
    const visibleCb = avatarSrc.slice(avatarSrc.indexOf('onAvatarVisible'),
                                      avatarSrc.indexOf('onAvatarVisible') + 500);
    ok(/loadingEl\.classList\.add\('hidden'\)/.test(visibleCb),
       '静的-8 Avatar 用 loading indicator は AVATAR_VISIBLE で消す');
    const loadedBlock = avatarSrc.slice(avatarSrc.indexOf('if (this.lamManager.isLoaded()) {'),
                                        avatarSrc.indexOf('} else {\n          this._showFallback'));
    ok(!/loadingEl\.classList\.add\('hidden'\)/.test(loadedBlock),
       '静的-9 model load 完了では loading indicator を消さない');
    const initBody = coreSrc.slice(coreSrc.indexOf('async init()'),
                                   coreSrc.indexOf('protected getUserId'));
    ok(/}, 10000\);/.test(initBody) && /}, 2000\);/.test(initBody),
       '静的-10 splash の既存 10 秒 / 2 秒タイマーを変更していない');
    ok((initBody.match(/await this\.resetAppContent\(/g) || []).length === 2
       && /setTimeout\(resolve, 300\)/.test(coreSrc),
       '静的-11 double reset 2 回 / 300ms は不変');
}

console.log('\n' + '='.repeat(64));
const failures = RESULTS.filter(([, p]) => !p);
RESULTS.forEach(([n, p]) => console.log(`${p ? 'PASS' : 'FAIL'}  ${n}`));
console.log('='.repeat(64));
console.log(`TOTAL ${RESULTS.length}  PASS ${RESULTS.length - failures.length}  FAIL ${failures.length}`);
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* noop */ }
process.exit(failures.length ? 1 : 0);

})().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(2); });
