// tools/poc-tests/frontend_generation_isolation.spec.cjs
//
// Frontend の Generation Isolation 回帰テスト（Startup Architecture Phase 2）。
//
// 固定する不変条件:
//   A  起動時の世代割り当て（reset #1 = warmup / reset #2 = final）と単調増加
//   B  reset #2 では live_stop(G1) 送信が G2 active 化より前に起きる
//   C  G1 停止後・新世代発行前に activeGenerationId = null の gap がある
//   D  live_start payload の generation_id / startup_role
//   E  audio stream への generation bind
//      （G2 active 後に G1 の遅延 callback が発火しても live_audio_in は G1）
//   F  stale live_audio(G1) は playback へ渡らない
//   G  stale live_expression(G1) は renderer へ渡らない
//   H  stale な live_stopped / turn_complete / greeting_done は G2 の状態を変えない
//   I  正しい G2 の live_audio / live_expression は ACCEPT される
//   J  generation 不明の Live event は DROP（active が null の legacy 時のみ通す）
//   K  live_connected は filter を通り、Greeting を開始しない
//   L  既存挙動（double reset 2回 / 300ms / 初期挨拶自動発火 / 通常会話）
//
// ------------------------------------------------------------------
// 実行方法
// ------------------------------------------------------------------
//   node tools/poc-tests/frontend_generation_isolation.spec.cjs
//
// node_modules（esbuild）が入っている状態で実行する。
//
// ------------------------------------------------------------------
// mock する範囲（= ブラウザ環境のみ。製品コードは mock しない）
// ------------------------------------------------------------------
// 実際の CoreController / LiveAudioManager を esbuild でバンドルして読み込み、
// 実際の initSocket() が登録した実際の socket handler を実行する。
// generation の発行・bind・filter ロジックは一切差し替えない。
// 差し替えるのは node に存在しないブラウザ環境だけ:
//   document / window / navigator / localStorage / Audio / fetch /
//   AudioContext / AudioWorkletNode / MessagePort / Blob URL / socket.io の io()
//
// ------------------------------------------------------------------
// ハーネス上の注意点
// ------------------------------------------------------------------
// [1] LiveAudioManager.initialize() は AudioWorkletNode の port.onmessage に
//     live_audio_in の emit を仕掛ける。ここを mock すると Test E が
//     検証対象を失うため、initialize() は本物を動かし、その内部が使う
//     AudioContext / AudioWorkletNode だけを差し替える。
//     port.onmessage を直接呼ぶことで「遅延 audio callback」を再現する。
// [2] resetAppContent() には実在の 300ms 待機があるため、各 reset を待つ。
//     待機時間の変更はテストのために行わない（製品側の値がSource of Truth）。
// [3] ensureDefaultAvatarInStorage() は selectedCamera_<mode> が
//     localStorage にあると即 return する。アバター設定の取得を走らせないため
//     ハーネスで事前に設定しておく。

const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..', '..');

// ============================================================
// 判定ヘルパ
// ============================================================
const RESULTS = [];
function ok(cond, name, extra) {
    cond = !!cond;
    RESULTS.push([name, cond]);
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
}

// ============================================================
// ブラウザ環境の mock
// ============================================================
function makeElement(tag) {
    const el = {
        tagName: tag || 'div',
        _classes: new Set(),
        innerHTML: '',
        textContent: '',
        value: '',
        disabled: false,
        loop: false,
        paused: true,
        style: {},
        children: [],
        scrollTop: 0,
        scrollHeight: 0,
        classList: {
            add: (...c) => c.forEach((x) => el._classes.add(x)),
            remove: (...c) => c.forEach((x) => el._classes.delete(x)),
            contains: (c) => el._classes.has(c),
            toggle: (c) => (el._classes.has(c) ? el._classes.delete(c) : el._classes.add(c)),
        },
        addEventListener: () => {},
        removeEventListener: () => {},
        appendChild: (c) => { el.children.push(c); return c; },
        removeChild: () => {},
        remove: () => {},
        querySelector: () => makeElement('div'),
        querySelectorAll: () => [],
        scrollIntoView: () => {},
        focus: () => {},
        blur: () => {},
        play: () => Promise.resolve(),
        pause: () => {},
        load: () => {},
        setAttribute: () => {},
        getAttribute: () => null,
        dispatchEvent: () => true,
        insertAdjacentHTML: () => {},
        closest: () => null,
    };
    return el;
}

const STORE = new Map();
STORE.set('selectedCamera_chat', 'uika');   // 注意点 [3]

global.localStorage = {
    getItem: (k) => (STORE.has(k) ? STORE.get(k) : null),
    setItem: (k, v) => STORE.set(k, String(v)),
    removeItem: (k) => STORE.delete(k),
    clear: () => STORE.clear(),
};

global.document = {
    hidden: false,
    getElementById: () => makeElement('div'),
    querySelector: () => makeElement('div'),
    querySelectorAll: () => [],
    createElement: (t) => makeElement(t),
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
    body: makeElement('body'),
    head: makeElement('head'),
};

global.window = {
    location: { origin: 'http://localhost', search: '', href: 'http://localhost/' },
    innerWidth: 1280,
    innerHeight: 800,
    scrollTo: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    localStorage: global.localStorage,
    document: global.document,
    dispatchEvent: () => true,
    matchMedia: () => ({ matches: false, addEventListener: () => {} }),
};
global.location = global.window.location;
// node は navigator を読み取り専用の global として持つため defineProperty で差し替える
Object.defineProperty(global, 'navigator', {
    value: {
        userAgent: 'node-test',
        mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop: () => {} }] }) },
    },
    writable: true,
    configurable: true,
});
global.window.navigator = global.navigator;
global.CustomEvent = class CustomEvent {
    constructor(type, init) { this.type = type; this.detail = init && init.detail; }
};
global.Event = global.CustomEvent;
global.Audio = class Audio {
    constructor() { this.paused = true; this.src = ''; }
    play() { this.paused = false; return Promise.resolve(); }
    pause() { this.paused = true; }
    addEventListener() {}
    load() {}
};
global.fetch = async () => ({
    ok: true,
    json: async () => ({ session_id: 'test-session-id' }),
    text: async () => '',
});
if (!global.URL.createObjectURL) {
    global.URL.createObjectURL = () => 'blob:test';
    global.URL.revokeObjectURL = () => {};
}

// --- Web Audio（注意点 [1]: initialize() 本体は本物を動かす） ---
const WORKLET_NODES = [];
global.AudioWorkletNode = class AudioWorkletNode {
    constructor() {
        this.port = { onmessage: null, postMessage: () => {} };
        WORKLET_NODES.push(this);
    }
    connect() {}
    disconnect() {}
};
global.AudioContext = class AudioContext {
    constructor() {
        this.state = 'running';
        this.currentTime = 0;
        this.sampleRate = 48000;
        this.destination = {};
        this.audioWorklet = { addModule: async () => {} };
    }
    createMediaStreamSource() { return { connect: () => {}, disconnect: () => {} }; }
    createGain() { return { connect: () => {}, gain: { value: 1 } }; }
    createBuffer(ch, len) {
        return { duration: len / 24000, copyToChannel: () => {}, length: len };
    }
    createBufferSource() {
        return { buffer: null, connect: () => {}, start: () => {}, stop: () => {}, onended: null };
    }
    resume() { return Promise.resolve(); }
    suspend() { return Promise.resolve(); }
    close() { return Promise.resolve(); }
};
global.webkitAudioContext = global.AudioContext;
// LiveAudioManager は window.AudioContext / window.webkitAudioContext を読む
global.window.AudioContext = global.AudioContext;
global.window.webkitAudioContext = global.AudioContext;
global.window.AudioWorkletNode = global.AudioWorkletNode;

// --- fake socket（io() が返す。実 handler はこれに登録される） ---
function makeFakeSocket() {
    const handlers = new Map();
    return {
        connected: true,
        emitted: [],
        on(event, fn) {
            if (!handlers.has(event)) handlers.set(event, []);
            handlers.get(event).push(fn);
        },
        once(event, fn) { this.on(event, fn); },
        off() {},
        emit(event, data) { this.emitted.push({ event, data }); },
        connect() {},
        disconnect() {},
        // サーバからのイベント到着を再現する
        serverEmit(event, data) {
            (handlers.get(event) || []).forEach((fn) => fn(data));
        },
        hasHandler(event) { return (handlers.get(event) || []).length > 0; },
        takeEmitted(event) { return this.emitted.filter((e) => e.event === event); },
        clearEmitted() { this.emitted.length = 0; },
    };
}
let FAKE_SOCKET = makeFakeSocket();
global.io = () => FAKE_SOCKET;

// ============================================================
// 製品コードのバンドル（esbuild）
// ============================================================
const esbuild = require(path.join(REPO_ROOT, 'node_modules', 'esbuild'));
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-iso-'));
const bundlePath = path.join(tmpDir, 'core-controller.bundle.cjs');
esbuild.buildSync({
    entryPoints: [path.join(REPO_ROOT, 'src', 'scripts', 'chat', 'core-controller.ts')],
    outfile: bundlePath,
    bundle: true,
    format: 'cjs',
    platform: 'neutral',
    target: 'es2020',
    logLevel: 'silent',
    mainFields: ['module', 'main'],
});
const { CoreController } = require(bundlePath);

// ============================================================
// セットアップ
// ============================================================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 16bit PCM として解釈できる偶数バイトの base64（4 バイト）。
// 3 バイトになる値を使うと playPcmAudio 内の Int16Array が例外を投げ、
// filter を外した mutation 時にハーネスごと落ちてしまう。
const PCM_B64 = Buffer.from(new Uint8Array([0, 0, 0, 0])).toString('base64');

function newController() {
    FAKE_SOCKET = makeFakeSocket();
    const container = makeElement('div');
    container.querySelector = () => makeElement('div');
    const c = new CoreController(container, 'http://localhost:8080');
    c.initSocket();                 // 実 handler を fake socket に登録
    return c;
}

const PLAYED = [];
const EXPRESSIONS = [];
function instrument(c) {
    // 実メソッドへ委譲しつつ呼び出しを記録する（差し替えではなく観測）
    const mgr = c.liveAudioManager;
    const origPlay = mgr.playPcmAudio.bind(mgr);
    mgr.playPcmAudio = (b64) => { PLAYED.push(b64); return origPlay(b64); };
    const origExpr = mgr.onExpressionReceived.bind(mgr);
    mgr.onExpressionReceived = (d) => { EXPRESSIONS.push(d); return origExpr(d); };
}

// ============================================================
(async function main() {

// ---------- Test A / B / C / D / L: 起動フロー ----------
console.log('\n=== Test A/B/C/D: 起動時の世代割り当てと順序 ===');
const c = newController();
instrument(c);

// reset #1 相当（init() が渡す role を明示して検証する）
const gapSamples = [];
const origAllocate = c.allocateGeneration.bind(c);
const origRetire = c.retireGeneration.bind(c);
const timeline = [];
c.retireGeneration = function () {
    timeline.push({ step: 'retire', before: this.activeGenerationId });
    const r = origRetire();
    gapSamples.push(this.activeGenerationId);     // Test C: gap を観測
    timeline.push({ step: 'retired', active: this.activeGenerationId });
    return r;
};
c.allocateGeneration = function (role) {
    const r = origAllocate(role);
    timeline.push({ step: 'allocate', active: this.activeGenerationId, role: this.activeStartupRole });
    return r;
};
const origTerminate = c.terminateLiveSession.bind(c);
c.terminateLiveSession = function () {
    timeline.push({ step: 'terminate', active: this.activeGenerationId });
    return origTerminate();
};

await c.resetAppContent('warmup');
const afterReset1 = c.activeGenerationId;
const liveStart1 = FAKE_SOCKET.takeEmitted('live_start');

ok(afterReset1 === 1, 'A-1 reset #1 で generation = 1 が発行される', `active=${afterReset1}`);
ok(c.activeStartupRole === 'warmup', 'A-2 reset #1 の startup_role = warmup',
   `role=${c.activeStartupRole}`);
ok(liveStart1.length === 1 && liveStart1[0].data.generation_id === 1,
   'D-1 reset #1 の live_start payload generation_id = 1',
   JSON.stringify(liveStart1[0] && liveStart1[0].data));
ok(liveStart1.length === 1 && liveStart1[0].data.startup_role === 'warmup',
   'D-2 reset #1 の live_start payload startup_role = warmup');

// G1 を live 状態にして reset #2 を行う（init() の 2 回目相当）
c.isLiveMode = true;
FAKE_SOCKET.clearEmitted();
timeline.length = 0;
await c.resetAppContent('final');

const liveStop = FAKE_SOCKET.takeEmitted('live_stop');
const liveStart2 = FAKE_SOCKET.takeEmitted('live_start');
ok(c.activeGenerationId === 2, 'A-3 reset #2 で generation = 2 が発行される',
   `active=${c.activeGenerationId}`);
ok(c.activeStartupRole === 'final', 'A-4 reset #2 の startup_role = final',
   `role=${c.activeStartupRole}`);
ok(c.generationCounter === 2, 'A-5 generation counter が単調増加している',
   `counter=${c.generationCounter}`);
ok(liveStop.length === 1 && liveStop[0].data && liveStop[0].data.generation_id === 1,
   'B-1 live_stop の generation_id = 1（旧世代）',
   JSON.stringify(liveStop[0] && liveStop[0].data));

const stopIdx = FAKE_SOCKET.emitted.findIndex((e) => e.event === 'live_stop');
const startIdx = FAKE_SOCKET.emitted.findIndex((e) => e.event === 'live_start');
ok(stopIdx !== -1 && startIdx !== -1 && stopIdx < startIdx,
   'B-2 live_stop(G1) の送信が live_start(G2) より前',
   `stopIdx=${stopIdx} startIdx=${startIdx}`);

const terminateStep = timeline.find((t) => t.step === 'terminate');
const retireStep = timeline.find((t) => t.step === 'retire');
const allocStep = timeline.find((t) => t.step === 'allocate');
ok(terminateStep && terminateStep.active === 1,
   'B-3 terminateLiveSession の時点で active はまだ G1（G2 を先に active にしていない）',
   `active=${terminateStep && terminateStep.active}`);
ok(timeline.indexOf(terminateStep) < timeline.indexOf(retireStep)
   && timeline.indexOf(retireStep) < timeline.indexOf(allocStep),
   'B-4 terminate -> retire -> allocate の順序',
   timeline.map((t) => t.step).join(' -> '));
ok(gapSamples.length >= 1 && gapSamples.every((v) => v === null),
   'C-1 retire 直後の activeGenerationId は null（gap が存在する）',
   `samples=${JSON.stringify(gapSamples)}`);
ok(liveStart2.length === 1 && liveStart2[0].data.generation_id === 2
   && liveStart2[0].data.startup_role === 'final',
   'D-3 reset #2 の live_start payload generation_id = 2 / startup_role = final',
   JSON.stringify(liveStart2[0] && liveStart2[0].data));

// Test C: gap 中の旧世代イベントは DROP
{
    const saved = c.activeGenerationId;
    c.activeGenerationId = null;
    const before = PLAYED.length;
    c.isLiveMode = true;
    FAKE_SOCKET.serverEmit('live_audio', { data: PCM_B64, generation_id: 1 });
    ok(PLAYED.length === before, 'C-2 gap 中（active=null）の live_audio(G1) は DROP',
       `played ${before} -> ${PLAYED.length}`);
    c.activeGenerationId = saved;
}

// ---------- Test L: 既存挙動 ----------
console.log('\n=== Test L: 既存挙動の回帰 ===');
const coreSrc = fs.readFileSync(
    path.join(REPO_ROOT, 'src', 'scripts', 'chat', 'core-controller.ts'), 'utf8');
const resetCalls = (coreSrc.match(/await this\.resetAppContent\(/g) || []).length;
const initBody = coreSrc.slice(coreSrc.indexOf('async init()'), coreSrc.indexOf('protected getUserId'));
const initResetCalls = (initBody.match(/await this\.resetAppContent\(/g) || []).length;
ok(initResetCalls === 2, 'L-1 init() の resetAppContent() は 2 回のまま',
   `count=${initResetCalls} (file total=${resetCalls})`);
ok(/setTimeout\(resolve, 300\)/.test(coreSrc),
   'L-2 reset の 300ms 待機が変更されていない');
ok(!/setTimeout\(resolve, (?!300)\d+\)/.test(
       coreSrc.slice(coreSrc.indexOf('protected async resetAppContent'),
                     coreSrc.indexOf('protected bindEvents'))),
   'L-3 reset にタイミング調整用の新しい待機を追加していない');
const handlerSrc = fs.readFileSync(
    path.join(REPO_ROOT, 'support-base', 'live_api_handler.py'), 'utf8');
ok(/if self\.session_count == 1:/.test(handlerSrc)
   && /INITIAL_GREETING_TRIGGERS/.test(handlerSrc),
   'L-4 初期挨拶の自動発火（session_count == 1 分岐）が残っている');
ok(/A2E_FIRST_FLUSH_BYTES = 4800/.test(handlerSrc)
   && /A2E_AUTO_FLUSH_BYTES = 240000/.test(handlerSrc),
   'L-5 A2E 閾値が変更されていない');
// Phase 5 で初期あいさつ専用の一括PCMバッファは撤去され、
// 初期あいさつも通常会話と同じ _buffer_for_a2e() の streaming 経路になった。
// ここで固定するのは「通常会話の A2E 経路が残っていること」。
ok(/_buffer_for_a2e/.test(handlerSrc) && /_flush_a2e_buffer/.test(handlerSrc),
   'L-6 通常会話の A2E streaming 経路が残っている');

// ---------- Test E: audio stream への generation bind ----------
console.log('\n=== Test E: audio stream の generation binding ===');
{
    const c2 = newController();
    const mgr = c2.liveAudioManager;
    WORKLET_NODES.length = 0;
    await mgr.initialize(FAKE_SOCKET);          // 注意点 [1]: 本物を動かす
    const node = WORKLET_NODES[WORKLET_NODES.length - 1];
    ok(!!node && typeof node.port.onmessage === 'function',
       'E-1 実 initialize() が port.onmessage を仕掛けている');

    mgr.bindGeneration(1);                       // G1 stream を開始
    mgr.startStreaming();
    mgr.isAiSpeaking = false;

    // active generation だけを G2 へ切り替える（stream は G1 のまま）
    c2.activeGenerationId = 2;
    c2.activeStartupRole = 'final';

    FAKE_SOCKET.clearEmitted();
    node.port.onmessage({ data: { audioChunk: new Int16Array(160) } });  // 遅延 callback
    const audioIn = FAKE_SOCKET.takeEmitted('live_audio_in');
    ok(audioIn.length === 1, 'E-2 遅延 callback から live_audio_in が送信された',
       `count=${audioIn.length}`);
    ok(audioIn.length === 1 && audioIn[0].data.generation_id === 1,
       'E-3 その generation_id は G1（G2 に付け替わっていない）',
       `generation_id=${audioIn.length ? audioIn[0].data.generation_id : 'none'}`);

    // bind 解除後は送らない
    mgr.bindGeneration(null);
    FAKE_SOCKET.clearEmitted();
    node.port.onmessage({ data: { audioChunk: new Int16Array(160) } });
    ok(FAKE_SOCKET.takeEmitted('live_audio_in').length === 0,
       'E-4 generation 未bind の stream からは live_audio_in を送らない');

    // 新しい世代を bind すると以降はその世代で送る
    mgr.bindGeneration(2);
    FAKE_SOCKET.clearEmitted();
    node.port.onmessage({ data: { audioChunk: new Int16Array(160) } });
    const audioIn2 = FAKE_SOCKET.takeEmitted('live_audio_in');
    ok(audioIn2.length === 1 && audioIn2[0].data.generation_id === 2,
       'E-5 G2 を bind した stream からは G2 が送られる',
       `generation_id=${audioIn2.length ? audioIn2[0].data.generation_id : 'none'}`);
}

// ---------- Test F / G / H / I / J / K: server -> client filter ----------
console.log('\n=== Test F/G/H/I/J/K: server -> client の generation filter ===');
{
    const c3 = newController();
    instrument(c3);
    c3.generationCounter = 2;
    c3.activeGenerationId = 2;
    c3.activeStartupRole = 'final';
    c3.isLiveMode = true;

    // F: stale live_audio
    let before = PLAYED.length;
    FAKE_SOCKET.serverEmit('live_audio', { data: PCM_B64, generation_id: 1 });
    ok(PLAYED.length === before, 'F-1 stale live_audio(G1) は playback へ渡らない',
       `played ${before} -> ${PLAYED.length}`);

    // G: stale live_expression
    before = EXPRESSIONS.length;
    FAKE_SOCKET.serverEmit('live_expression', {
        generation_id: 1, chunk_index: 0, expressions: [[0]], expression_names: ['jawOpen'],
        frame_rate: 30,
    });
    ok(EXPRESSIONS.length === before, 'G-1 stale live_expression(G1) は renderer へ渡らない',
       `expr ${before} -> ${EXPRESSIONS.length}`);

    // H: stale lifecycle event
    c3.isLiveMode = true;
    c3.userTranscriptBuffer = 'keep-me';
    FAKE_SOCKET.serverEmit('live_stopped', { generation_id: 1 });
    ok(c3.isLiveMode === true, 'H-1 stale live_stopped(G1) は isLiveMode を落とさない',
       `isLiveMode=${c3.isLiveMode}`);
    FAKE_SOCKET.serverEmit('turn_complete', { generation_id: 1 });
    ok(c3.userTranscriptBuffer === 'keep-me',
       'H-2 stale turn_complete(G1) は transcript buffer を消さない',
       `buffer=${c3.userTranscriptBuffer}`);
    FAKE_SOCKET.serverEmit('greeting_done', { generation_id: 1 });
    ok(c3.isLiveMode === true && c3.activeGenerationId === 2,
       'H-3 stale greeting_done(G1) で G2 の状態は変わらない');

    // I: valid G2 event
    before = PLAYED.length;
    FAKE_SOCKET.serverEmit('live_audio', { data: PCM_B64, generation_id: 2 });
    ok(PLAYED.length === before + 1, 'I-1 live_audio(G2) は ACCEPT される',
       `played ${before} -> ${PLAYED.length}`);
    before = EXPRESSIONS.length;
    FAKE_SOCKET.serverEmit('live_expression', {
        generation_id: 2, chunk_index: 0, expressions: [[0]], expression_names: ['jawOpen'],
        frame_rate: 30,
    });
    ok(EXPRESSIONS.length === before + 1, 'I-2 live_expression(G2) は ACCEPT される',
       `expr ${before} -> ${EXPRESSIONS.length}`);
    c3.isLiveMode = true;
    FAKE_SOCKET.serverEmit('live_stopped', { generation_id: 2 });
    ok(c3.isLiveMode === false, 'I-3 live_stopped(G2) は ACCEPT され isLiveMode が落ちる');

    // J: generation 不明
    c3.isLiveMode = true;
    before = PLAYED.length;
    FAKE_SOCKET.serverEmit('live_audio', { data: PCM_B64 });
    ok(PLAYED.length === before,
       'J-1 active=G2 のとき generation 無しの live_audio は DROP',
       `played ${before} -> ${PLAYED.length}`);
    c3.activeGenerationId = null;
    before = PLAYED.length;
    FAKE_SOCKET.serverEmit('live_audio', { data: PCM_B64 });
    ok(PLAYED.length === before + 1,
       'J-2 active=null（legacy）のとき generation 無しは現行挙動を維持',
       `played ${before} -> ${PLAYED.length}`);
    c3.activeGenerationId = 2;

    // K: live_connected
    ok(FAKE_SOCKET.hasHandler('live_connected'),
       'K-1 live_connected の handler が存在する');
    const beforeStart = FAKE_SOCKET.takeEmitted('live_start').length;
    FAKE_SOCKET.serverEmit('live_connected', { generation_id: 1, session_count: 1 });
    FAKE_SOCKET.serverEmit('live_connected', { generation_id: 2, session_count: 1 });
    ok(FAKE_SOCKET.takeEmitted('live_start').length === beforeStart,
       'K-2 live_connected は Greeting / live_start を開始しない');
}

// ---------- 静的検査: filter が handler の先頭にあること ----------
console.log('\n=== 静的検査: filter の位置と対象 ===');
{
    const GENERATION_SCOPED = [
        'live_ready', 'live_connected', 'greeting_done', 'live_audio', 'live_expression',
        'live_expression_reset', 'user_transcript', 'ai_transcript', 'turn_complete',
        'interrupted', 'live_reconnecting', 'live_reconnected', 'live_stopped',
        'shop_search_start', 'shop_search_result',
    ];
    let allFirst = true;
    const bad = [];
    for (const ev of GENERATION_SCOPED) {
        const at = coreSrc.indexOf(`this.socket.on('${ev}'`);
        if (at === -1) { allFirst = false; bad.push(`${ev}:handler無し`); continue; }
        const body = coreSrc.slice(at, at + 400);
        const guardAt = body.indexOf(`this.acceptGeneration('${ev}'`);
        const braceAt = body.indexOf('{');
        if (guardAt === -1) { allFirst = false; bad.push(`${ev}:filter無し`); continue; }
        // filter より前に出てきてはいけないもの
        const head = body.slice(braceAt, guardAt);
        if (/isLiveMode|console\.log|performance\.now|playPcmAudio|onExpressionReceived/.test(head)) {
            allFirst = false; bad.push(`${ev}:filterが先頭でない`);
        }
    }
    ok(allFirst, '静的-1 generation-scoped な全 handler の先頭に filter がある',
       bad.join(', '));

    // 非 Live 系へは付けない
    const legacyOk = ['transcript', 'error', 'connect'].every((ev) => {
        const at = coreSrc.indexOf(`this.socket.on('${ev}'`);
        if (at === -1) return true;
        return !coreSrc.slice(at, at + 300).includes('acceptGeneration');
    });
    ok(legacyOk, '静的-2 非Live系（transcript / error / connect）には filter を付けていない');

    const mgrSrc = fs.readFileSync(
        path.join(REPO_ROOT, 'src', 'scripts', 'chat', 'live-audio-manager.ts'), 'utf8');
    ok(/generation_id: this\.streamGenerationId/.test(mgrSrc)
       && !/generation_id: this\.activeGenerationId/.test(mgrSrc),
       '静的-3 live_audio_in は stream に bind した generation を送る');

    const appSrc = fs.readFileSync(
        path.join(REPO_ROOT, 'support-base', 'app_customer_support.py'), 'utf8');
    ok(/def _emit\(self, event, data=None\)/.test(handlerSrc)
       && /payload\['generation_id'\] = self\._generation_id/.test(handlerSrc),
       '静的-4 LiveAPISession の emit は必ず self._generation_id を使う');
    const sessionEmits = (handlerSrc.match(/self\.socketio\.emit\(/g) || []).length;
    ok(sessionEmits === 1,
       '静的-5 LiveAPISession の送信口は _emit() の 1 箇所だけ',
       `self.socketio.emit 直接呼び出し=${sessionEmits}（_emit 定義内の1件のみが正常）`);
    ok(/'generation_id': generation_id/.test(appSrc)
       && /'generation_id': stopped_generation/.test(appSrc),
       '静的-6 live_ready / live_stopped にも generation_id が付いている');
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
