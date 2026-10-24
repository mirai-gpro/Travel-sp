// tools/poc-tests/av-scheduler.spec.cjs
//
// PR #48 (f49f294d / b0b7709) の Audio/Expression coordinated scheduler の
// invariant テスト (指示書 §18)。実 AudioContext は使わず fake を注入する。
//
// 実行:
//   npx esbuild src/scripts/chat/live-audio-manager.ts --bundle \
//     --format=cjs --platform=node --outfile=tools/poc-tests/.live-audio.cjs
//   node tools/poc-tests/av-scheduler.spec.cjs

let failures = 0;
const ok = (cond, name, extra) => {
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
    if (!cond) failures++;
};

const NAMES = Array.from({ length: 52 }, (_, i) => (i === 24 ? 'jawOpen' : `bs${i}`));
const JAW = 24;

/** 24kHz 16bit mono の無音 PCM を base64 で作る。durationSec 秒ぶん。 */
function pcmBase64(durationSec) {
    const samples = Math.round(24000 * durationSec);
    return Buffer.alloc(samples * 2).toString('base64');
}

function makeCtx() {
    const ctx = {
        currentTime: 0,
        destination: {},
        started: [],
        createBuffer(ch, len, rate) {
            return { duration: len / rate, copyToChannel() {} };
        },
        createBufferSource() {
            const src = {
                buffer: null, onended: null, startTime: null, stopped: false,
                connect() {},
                start(t) { src.startTime = t; ctx.started.push(src); },
                stop() { src.stopped = true; },
            };
            return src;
        },
    };
    return ctx;
}

/** jawOpen だけ値を持つ frame を n 枚。 */
function frames(n, jawFn) {
    const out = [];
    for (let i = 0; i < n; i++) {
        const v = new Array(52).fill(0);
        v[JAW] = jawFn ? jawFn(i) : 0.5;
        out.push(v);
    }
    return out;
}

(async () => {
    const mod = require('./.live-audio.cjs');
    const { LiveAudioManager, A2E_LEAD_SEC } = mod;

    const build = () => {
        const m = new LiveAudioManager();
        const ctx = makeCtx();
        m.audioContext = ctx;              // initialize() を通さずに注入 (テスト専用)
        m.expressionNames = NAMES.slice();
        return { m, ctx };
    };
    const sendExpr = (m, n, chunkIndex, jawFn) => m.onExpressionReceived({
        expressions: frames(n, jawFn), expression_names: NAMES, frame_rate: 30,
        chunk_index: chunkIndex,
    });
    /** scheduledAudioEnd <= expressionCoverage を検査する。 */
    const invariantViolation = (m) => {
        const st = m.getAvDebugState();
        const coverage = st.currentSegmentFrames / 30;
        return st.currentSegmentContentSec > coverage + 1e-6
            ? `contentSec=${st.currentSegmentContentSec} > coverage=${coverage}` : null;
    };

    // ---- 0. 旧 clamp 実装が残っていないこと ----
    {
        const src = require('fs').readFileSync(
            require('path').join(__dirname, '../../src/scripts/chat/live-audio-manager.ts'),
            'utf8');
        ok(!/Math\.min\(\s*frameIndex/.test(src)
            && !/this\.expressionFrameBuffer/.test(src),
           '★ 18-3. clamp-to-last-frame 実装 (Math.min(frameIndex, length-1)) が無い');
        ok(!/A2E_WAIT_TIMEOUT/.test(src) && !/stalled/.test(src),
           '★ 11. timeout bypass (A2E_WAIT_TIMEOUT_SEC / stalled) が復活していない');
        ok(typeof A2E_LEAD_SEC === 'number' && A2E_LEAD_SEC === 0.20,
           '★ pre-roll 定数 A2E_LEAD_SEC が PR #48 の値', String(A2E_LEAD_SEC));
    }

    // ---- 18-2. Expression 未到着では AudioContext へ schedule しない ----
    {
        const { m, ctx } = build();
        m.onAiResponseStarted();
        m.playPcmAudio(pcmBase64(0.2));
        m.playPcmAudio(pcmBase64(0.2));
        ok(ctx.started.length === 0,
           '★ 18-2. Expression が無い間は AudioBufferSourceNode.start() を呼ばない',
           `started=${ctx.started.length}`);
        ok(m.getAvDebugState().pendingChunks === 2,
           '★ 18-2. 音声は pending queue に留まる (Audio-only fallback しない)');
        ok(m.getCurrentPlaybackOffset() === 0 && m.getCurrentExpressionFrame() === null,
           '★ 18-2. playhead は進まない');
    }

    // ---- 18-4. segment 先頭は coverage 到着後に開始し、pre-roll を置く ----
    {
        const { m, ctx } = build();
        m.onAiResponseStarted();
        m.playPcmAudio(pcmBase64(0.2));
        ctx.currentTime = 1.0;
        sendExpr(m, 6, 0);                       // 6 frames = 0.2s coverage
        ok(ctx.started.length === 1,
           '★ 18-4. coverage が来た時点で初めて schedule される');
        ok(ctx.started[0].startTime >= 1.0 + A2E_LEAD_SEC - 1e-9,
           '★ 18-4. segment 先頭に pre-roll (A2E_LEAD_SEC) を置く',
           `startTime=${ctx.started[0].startTime}`);
        ok(m.getAvDebugState().timelineStart === ctx.started[0].startTime,
           '★ 7-3. master clock は start() に渡した startTime');
        ok(invariantViolation(m) === null, '★ 18-1. invariant 維持');
    }

    // ---- 18-1. 連続供給でも scheduledAudioEnd <= expressionCoverage ----
    {
        const { m, ctx } = build();
        m.onAiResponseStarted();
        let violations = 0;
        const check = () => { if (invariantViolation(m)) violations++; };
        // Audio を先行させ、Expression を遅れて不均等に供給する
        for (let i = 0; i < 10; i++) { m.playPcmAudio(pcmBase64(0.2)); check(); }
        sendExpr(m, 5, 0);  check();             // 0.167s
        sendExpr(m, 1, 1);  check();             // 0.20s  -> 1 本解放
        sendExpr(m, 60, 2); check();             // 2.20s  -> さらに解放
        ctx.currentTime = 0.5;
        sendExpr(m, 30, 3); check();             // 3.20s
        for (let i = 0; i < 5; i++) { m.playPcmAudio(pcmBase64(0.2)); check(); }
        sendExpr(m, 1, 4);  check();
        ok(violations === 0,
           '★ 18-1. scheduledAudioEnd <= expressionCoverage 違反 0', `violations=${violations}`);
        const st = m.getAvDebugState();
        ok(st.currentSegmentContentSec <= st.currentSegmentFrames / 30 + 1e-6,
           '★ 18-1. 最終状態でも Audio が Expression を追い越していない',
           `scheduled=${st.currentSegmentContentSec.toFixed(3)}s coverage=${(st.currentSegmentFrames / 30).toFixed(3)}s`);
        // coverage (3.233s) を超える音声を足すと、超えた分だけ pending に残る
        const startedBefore = ctx.started.length;
        for (let i = 0; i < 3; i++) { m.playPcmAudio(pcmBase64(0.2)); check(); }
        const st2 = m.getAvDebugState();
        ok(ctx.started.length === startedBefore + 1 && st2.pendingChunks === 2,
           '★ 18-1. coverage を超える分は pending に残る',
           `started=${startedBefore}->${ctx.started.length} pending=${st2.pendingChunks}`);
        ok(violations === 0, '★ 18-1. 追加後も invariant 違反 0');
    }

    // ---- 18-3. underrun では最後の frame を返さない ----
    {
        const { m, ctx } = build();
        m.onAiResponseStarted();
        m.playPcmAudio(pcmBase64(1.0));
        sendExpr(m, 30, 0, (i) => 0.3 + i * 0.01);   // 1.0s coverage
        ok(ctx.started.length === 1, '前提: 1 本 schedule 済み');
        const t0 = ctx.started[0].startTime;
        ctx.currentTime = t0 + 0.5;
        const mid = m.getCurrentExpressionFrame();
        ok(mid !== null && mid.values[JAW] > 0,
           '★ 正常時は expression が返る', mid && mid.values[JAW].toFixed(3));

        // 強制的に underrun を作る (正常設計では起きない状態)
        m.segments[m.segments.length - 1].frames.length = 5;
        const under = m.getCurrentExpressionFrame();
        ok(under === null,
           '★ 18-3. requestedFrame >= availableFrames で last frame を返さず null',
           String(under));
        ok(m.getAvDebugState().underrunCount >= 1,
           '★ 18-3. underrun としてカウントされる');
        const dbg = m.getExpressionSyncDebugState();
        ok(dbg.selectedFrame === dbg.requestedFrame,
           '★ 18-3. selectedFrame は clamp されない (requestedFrame と一致)',
           `requested=${dbg.requestedFrame} selected=${dbg.selectedFrame}`);
    }

    // ---- 8. 隣接 2 frame の線形補間 (独自 smoothing を足さない) ----
    {
        const { m, ctx } = build();
        m.onAiResponseStarted();
        m.playPcmAudio(pcmBase64(1.0));
        sendExpr(m, 30, 0, (i) => i / 29);
        const t0 = ctx.started[0].startTime;
        // frame 10 と 11 の中間 (framePos = 10.5)
        ctx.currentTime = t0 + 10.5 / 30;
        const f = m.getCurrentExpressionFrame();
        const expect = ((10 / 29) + (11 / 29)) / 2;
        ok(f !== null && Math.abs(f.values[JAW] - expect) < 1e-6,
           '★ 8. fractional frame position で隣接 2 frame を線形補間する',
           `got=${f && f.values[JAW].toFixed(6)} expect=${expect.toFixed(6)}`);
        ok(f.values.length === 52, '★ 8. 52 係数すべてを補間対象にする', String(f.values.length));
        ok(m.getAvDebugState().interpCount >= 1 && m.getAvDebugState().lastSample.i1 === 11,
           '★ 8. 補間した 2 frame を read-only で確認できる');
    }

    // ---- 18-5. turn_complete と実再生終了の分離 ----
    {
        const { m, ctx } = build();
        m.onAiResponseStarted();
        m.playPcmAudio(pcmBase64(0.2));
        m.playPcmAudio(pcmBase64(0.2));
        sendExpr(m, 6, 0);                        // 1 本目だけ解放 (coverage 0.2s)
        ok(ctx.started.length === 1 && m.getAvDebugState().pendingChunks === 1,
           '前提: active 1 / pending 1');
        m.onAiResponseEnded();                    // server turn_complete
        ok(m.isAiSpeaking === true,
           '★ 18-5. pending が残っていれば turn_complete でも isAiSpeaking=true');
        ctx.started[0].onended();                 // 1 本目が鳴り終わる
        ok(m.isAiSpeaking === true,
           '★ 18-5. pending が残る限り false にしない',
           `pending=${m.getAvDebugState().pendingChunks}`);
        sendExpr(m, 6, 1);                        // coverage 0.4s -> 2 本目を解放
        ok(ctx.started.length === 2 && m.getAvDebugState().pendingChunks === 0,
           '前提: 2 本目が schedule された');
        ok(m.isAiSpeaking === true, '★ 18-5. active source が残れば true のまま');
        ctx.started[1].onended();
        ok(m.isAiSpeaking === false,
           '★ 18-5. serverEnded && pending=0 && activeSources=0 で初めて false');
    }

    // ---- 9. segment lifecycle: reset は schedule 済み音声を止めない ----
    {
        const { m, ctx } = build();
        m.onAiResponseStarted();
        m.playPcmAudio(pcmBase64(0.2));
        sendExpr(m, 6, 0);
        const first = ctx.started[0];
        m.resetForNewSegment();                   // live_expression_reset 相当
        ok(first.stopped === false,
           '★ 9. live_expression_reset では schedule 済み音声を stop しない');
        ok(m.isAiSpeaking === true && m.getAvDebugState().segments === 2,
           '★ 9. 新 segment が開始される', `segments=${m.getAvDebugState().segments}`);
        ok(m.getAvDebugState().pendingChunks === 0, '★ 9. pending は新 segment で空から');
    }

    // ---- 18-6. interruption ----
    {
        const { m, ctx } = build();
        m.onAiResponseStarted();
        m.playPcmAudio(pcmBase64(0.2));
        m.playPcmAudio(pcmBase64(0.2));
        sendExpr(m, 6, 0);
        ok(ctx.started.length === 1, '前提: 1 本 schedule 済み');
        m.clearPlaybackQueue();                   // = interrupt()
        const st = m.getAvDebugState();
        ok(ctx.started[0].stopped === true,
           '★ 18-6. 割り込みで schedule 済み source を stop する');
        ok(st.pendingChunks === 0, '★ 18-6. pending をクリアする');
        ok(st.segments === 0 && st.timelineStart === null,
           '★ 18-6. timeline を reset する');
        ok(m.isAiSpeaking === false, '★ 18-6. isAiSpeaking=false');
        ok(m.getCurrentExpressionFrame() === null, '★ 18-6. expression も返らない');
    }

    // ---- 10. 無音区間 (schedule 済み末尾より後) では口を閉じる ----
    {
        const { m, ctx } = build();
        m.onAiResponseStarted();
        m.playPcmAudio(pcmBase64(0.2));
        sendExpr(m, 6, 0, () => 0.4);
        const end = ctx.started[0].startTime + 0.2;
        ctx.currentTime = end + 0.5;              // 鳴り終わった後
        ok(m.getCurrentExpressionFrame() === null,
           '★ 10. 再生済み末尾より後は null (最後の口形を保持しない)');
        ok(m.getCurrentPlaybackOffset() === 0,
           '★ 10. playhead も進まない');
    }

    console.log(failures === 0 ? '\n=== 全テスト PASS ===' : `\n=== ${failures} 件 FAIL ===`);
    process.exit(failures === 0 ? 0 : 1);
})();
