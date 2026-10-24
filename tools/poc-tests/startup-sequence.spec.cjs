// tools/poc-tests/startup-sequence.spec.cjs
//
// 起動シーケンスの不変条件テスト。
//   1. アバターが完全に表示されるまで初期挨拶を始めない
//   2. splat の fade-in reveal を使わない
//   3. 完全表示までは待機アニメを出し続ける
//   4. アバター起動は session 初期化より前に始める (並行化)
// renderer / DOM を起動しないので静的検査で固定する。
const fs = require('fs');
const path = require('path');

let failures = 0;
const ok = (cond, name, extra) => {
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
    if (!cond) failures++;
};
// core-controller.ts は CRLF。改行差で regex が外れないよう正規化して読む。
const read = (rel) => fs.readFileSync(path.join(__dirname, '../../', rel), 'utf8')
    .replace(/\r\n/g, '\n');

const lam = read('src/components/LAMAvatar.astro');
const mgr = read('src/scripts/chat/lam-websocket-manager.ts');
const core = read('src/scripts/chat/core-controller.ts');
const ui = read('src/scripts/avatar-install/install-ui.ts');
const lesson = read('src/scripts/chat/lesson-controller.ts');
const handler = read('support-base/live_api_handler.py');
const concierge = read('src/scripts/chat/concierge-controller.ts');

// ---- 1. 挨拶 gate ----
{
    const waitAt = core.indexOf('await this._waitForAvatarVisible();');
    const emitAt = core.indexOf("this.socket.emit('live_start'");
    ok(waitAt > 0 && emitAt > 0 && waitAt < emitAt,
       '★ 1. live_start (初期挨拶の起点) より前にアバター表示を待つ',
       `wait@${waitAt} < emit@${emitAt}`);
    ok(/await c\.waitUntilVisible\(\)/.test(core),
       '★ 1. 待機条件は LAMAvatarController.waitUntilVisible() に 1 本化');
    ok(/c\.initializeStarted !== true/.test(core),
       '★ 1. アバター初期化が未開始なら待たない (挨拶が永久に始まらないのを防ぐ)');
    ok(!/setTimeout[^)]*_waitForAvatarVisible|Promise\.race/.test(core),
       '★ 1. timeout で勝手に挨拶を先に始めない');

    // gate は「表示」と「2D フォールバック」でだけ開く
    ok((lam.match(/this\._markAvatarVisible\(\);/g) || []).length === 2,
       '★ 1. gate を開くのは 3D 表示完了と 2D フォールバックの 2 箇所だけ',
       String((lam.match(/this\._markAvatarVisible\(\);/g) || []).length));
    const fbAt = lam.indexOf('fallbackEl.classList.remove(\'hidden\')');
    ok(fbAt > 0 && lam.indexOf('this._markAvatarVisible();', fbAt) > fbAt,
       '★ 1. 2D フォールバックでも gate を開ける (挨拶が止まらない)');
    ok(/public initializeStarted: boolean = false;/.test(lam)
        && /this\.initializeStarted = true;/.test(lam),
       '★ 1. initializeStarted を公開して gate 側が参照できる');
}

// ---- 2. fade-in reveal の廃止 ----
{
    const getAt = mgr.indexOf('GaussianSplatRenderer.getInstance(');
    const revealAt = mgr.indexOf('viewer.sceneRevealMode = GaussianSplats3D.SceneRevealMode.Instant;');
    ok(getAt > 0 && revealAt > getAt,
       '★ 2. getInstance 後に sceneRevealMode = Instant を設定する',
       `getInstance@${getAt} < reveal@${revealAt}`);
    ok(!/sceneRevealMode\s*=\s*[\w.]*SceneRevealMode\.(Gradual|Default)/.test(mgr),
       '★ 2. Gradual / Default を代入しない (説明コメント中の言及は可)');
    ok(!/transition: *opacity/.test(ui.slice(ui.indexOf('revealRenderer()'),
                                             ui.indexOf('revealRenderer()') + 400)),
       '★ 2. Poster -> 3D の切替をフェードさせない');
    ok(/revealRenderer\(\) \{[\s\S]{0,260}?destroy\(\);/.test(ui)
        && !/setTimeout\(destroy/.test(ui),
       '★ 2. revealRenderer() は即座に overlay を外す (setTimeout なし)');
    ok(!/\.avatar-install-poster\.is-hidden/.test(ui),
       '★ 2. Poster 側の opacity transition も残っていない');
}

// ---- 3. 完全ロードまで待機アニメ ----
{
    ok(/isSplatLoadComplete\(\): boolean/.test(mgr)
        && /mesh\.finalBuild !== true/.test(mgr),
       '★ 3. 完全ロード判定の Source of Truth は splatMesh.finalBuild');
    ok(/progressiveLoad/.test(mgr),
       '★ 3. isLoaded() が早期 resolve である理由をコードに残している');

    const waitAt = lam.indexOf('await this._waitForSplatLoadComplete();');
    const hideAt = lam.indexOf("this.loadingEl.classList.add('hidden');\n          // 完成した状態で");
    const revealAt = lam.indexOf('this.poster?.revealRenderer();');
    ok(waitAt > 0 && hideAt > waitAt && revealAt > waitAt,
       '★ 3. 最終 build を待ってから待機アニメを消し overlay を外す',
       `wait@${waitAt} < hide@${hideAt} < reveal@${revealAt}`);
    const mount = lam.slice(lam.indexOf('private _mountPoster('),
                            lam.indexOf('private _mountPoster(') + 460);
    ok(!/loadingEl\.classList\.add\('hidden'\)/.test(mount),
       '★ 3. Poster を出しても待機アニメを消さない');
    ok(/\.lam-loading \{[\s\S]{0,200}z-index: 31;/.test(lam),
       '★ 3. 待機アニメを Poster overlay (z-index 30) より前面に置く');
    const body = lam.slice(lam.indexOf('private async _waitForSplatLoadComplete'),
                           lam.indexOf('private async _waitForSplatLoadComplete') + 1200);
    ok(/requestAnimationFrame\(tick\)/.test(body) && !/setTimeout/.test(body),
       '★ 3. 固定 sleep ではなく rAF ポーリングで待つ');
}

// ---- 5. splash 解除のタイミング ----
{
    const hideAt = core.indexOf('void this._hideSplashWhenReady();');
    const resetAt = core.indexOf('await this.resetAppContent();');
    ok(hideAt > 0 && resetAt > 0 && hideAt < resetAt,
       '★ 5. splash 解除を resetAppContent (= 挨拶 gate) より前に開始する',
       `hide@${hideAt} < reset@${resetAt}`);
    ok(!/await this\.resetAppContent\(\);[\s\S]{0,400}?setTimeout\([\s\S]{0,200}?splashOverlay/.test(core),
       '★ 5. splash 解除タイマーを挨拶 gate の後ろに置かない (残留の原因)');
    ok(/setTimeout\(\(\) => \{[\s\S]{0,200}?this\._hideSplash\(\);[\s\S]{0,40}?\}, 10000\);/.test(core),
       '★ 5. 10 秒の安全網は残す (gate が解決しなくても splash を外す)');
    const hideBody = core.slice(core.indexOf('private async _hideSplashWhenReady'),
                                core.indexOf('private async _hideSplashWhenReady') + 1000);
    ok(/await c\.waitUntilSettled\(\)/.test(hideBody),
       '★ 5. splash は「確定」待ちで外す (案内カードを splash で隠さない)');
    ok(!/waitUntilVisible/.test(
        core.slice(core.indexOf('private async _hideSplashWhenReady'),
                   core.indexOf('private async _hideSplashWhenReady') + 1000)),
       '★ 5. splash 解除に「表示」待ちを使わない');
    ok(/waitUntilSettled\(\): Promise<void>/.test(lam)
        && /_markAvatarSettled\(\): void/.test(lam),
       '★ 5. settled gate が LAMAvatar 側にある');
    // 案内 UI を出して待つ経路すべてで settled にする
    const settledCalls = (lam.match(/this\._markAvatarSettled\(\);/g) || []).length;
    ok(settledCalls >= 6,
       '★ 5. install / recovery / 案内 / reload の各待機経路で settled にする',
       `calls=${settledCalls}`);
    ok(/_markAvatarSettled\(\);\n      if \(this\.avatarVisibleResolved\)/.test(lam),
       '★ 5. 表示完了時は settled も同時に満たす');
}

// ---- 6. 待機アニメを二重に出さない ----
{
    ok(/getElementById\('splashOverlay'\)/.test(lam)
        && /private _showWaitingAnimation\(\): void/.test(lam),
       '★ 6. splash が出ている間はアバター側の待機アニメを出さない');
    const init = lam.slice(lam.indexOf('this.initializeStarted = true;'),
                           lam.indexOf('this.initializeStarted = true;') + 200);
    ok(/this\._showWaitingAnimation\(\);/.test(init),
       '★ 6. initialize 開始時に待機アニメの表示を判定する');
    const mount = lam.slice(lam.indexOf('private _mountPoster('),
                            lam.indexOf('private _mountPoster(') + 600);
    ok(/this\._showWaitingAnimation\(\);/.test(mount),
       '★ 6. Poster 表示時も同じ判定を通す');
}

// ---- 4. アバター起動の並行化 ----
for (const [name, src] of [['lesson', lesson], ['concierge', concierge]]) {
    const linkAt = src.indexOf('void this.linkLamAvatar();');
    const superAt = src.indexOf('await super.init();');
    ok(linkAt > 0 && superAt > 0 && linkAt < superAt,
       `★ 4. ${name}: アバター起動を super.init() より前に始める`,
       `link@${linkAt} < super@${superAt}`);
    ok((src.match(/this\.linkLamAvatar\(\)/g) || []).length === 1,
       `★ 4. ${name}: linkLamAvatar の呼び出しは 1 箇所だけ`,
       String((src.match(/this\.linkLamAvatar\(\)/g) || []).length));
    ok(/await this\.waitForLamAvatarController\(\)/.test(src),
       `★ 4. ${name}: global の公開を待てる (評価順に依存しない)`);
}
ok(/protected waitForLamAvatarController\(timeoutMs: number = 3000\)/.test(core),
   '★ 4. waitForLamAvatarController は core 側に 1 本化');

// ---- 7. 初回起動は 1 session / 1 live_start (旧二重 soft-reset の撤去) ----
{
    const initBody = core.slice(
        core.indexOf('protected async init() {'),
        core.indexOf("console.log('[Core] Initialization completed');"));
    ok(initBody.length > 0, '前提: init() 本体を取得できる');

    // A. 初回 startup の呼び出し回数
    const initSessionCalls = (initBody.match(/await this\.initializeSession\(\);/g) || []).length;
    const resetCalls = (initBody.match(/this\.resetAppContent\(\)/g) || []).length;
    ok(initSessionCalls === 1,
       '★ 7-A. 初回起動の initializeSession() は 1 回', `calls=${initSessionCalls}`);
    ok(resetCalls === 0,
       '★ 7-A. 初回起動から resetAppContent() を呼ばない (旧 workaround 撤去)',
       `calls=${resetCalls}`);
    ok(/await this\.initializeSession\(\);\n    this\.updateUILanguage\(\);/.test(initBody),
       '★ 7-A. workaround 導入前の startup semantics (initializeSession + updateUILanguage)');

    // B. live_start は 1 箇所だけ、かつ startLiveMode の中
    const emits = (core.match(/this\.socket\.emit\('live_start'/g) || []).length;
    ok(emits === 1, '★ 7-B. live_start emit は 1 箇所だけ', `emits=${emits}`);
    const liveModeBody = core.slice(core.indexOf('protected async startLiveMode('));
    ok(liveModeBody.indexOf("this.socket.emit('live_start'") > 0,
       '★ 7-B. live_start は startLiveMode の中だけ');

    // C. session start は各 controller で 1 回だけ
    for (const [name, src] of [['core', core], ['lesson', lesson], ['concierge', concierge]]) {
        const n = (src.match(/\/api\/session\/start/g) || []).length;
        ok(n <= 1, `★ 7-C. ${name}: /api/session/start は多重に無い`, `n=${n}`);
    }

    // D. 初回 startup では停止系を一切通らない
    //    コメント行は除いて「実際のコード」だけを見る
    const initCode = initBody.split('\n')
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    for (const token of ['stopAllActivities', 'interrupt(', 'terminateLiveSession',
                         '/api/cancel', '/api/session/end']) {
        ok(initCode.indexOf(token) < 0,
           `★ 7-D. 初回起動で ${token} を呼ばない`);
    }
    // 停止系は reset / session 再開始の経路にだけ存在する
    const resetBody = core.slice(core.indexOf('protected async resetAppContent() {'),
                                 core.indexOf("console.log('[Reset] Completed');"));
    ok(/this\.stopAllActivities\(\);/.test(resetBody),
       '★ 7-D. stopAllActivities は resetAppContent 側に残っている');
    ok(/\/api\/cancel/.test(resetBody),
       '★ 7-D. /api/cancel も resetAppContent 側だけ');
    const sessionBody = core.slice(core.indexOf('protected async initializeSession() {'),
                                   core.indexOf('protected async initializeSession() {') + 1800);
    ok(/if \(this\.sessionId\)/.test(sessionBody),
       '★ 7-D. /api/session/end は既存 session があるときだけ (初回起動では通らない)');

    // E. Avatar gate が live_start の手前にある (再掲: 1 session 化後も維持)
    const waitAt = core.indexOf('await this._waitForAvatarVisible();');
    const emitAt = core.indexOf("this.socket.emit('live_start'");
    ok(waitAt > 0 && waitAt < emitAt,
       '★ 7-E. 1 session 化後も Avatar 表示待ちが live_start の手前にある');

    // F. reset 機能そのものは壊さない
    ok(/protected async resetAppContent\(\)/.test(core),
       '★ 7-F. resetAppContent() は残っている');
    ok(/document\.addEventListener\('gourmet-app:reset'/.test(core),
       '★ 7-F. ユーザー明示 reset から呼べる');
    ok(/backgroundDuration > this\.BACKGROUND_RESET_THRESHOLD[\s\S]{0,120}?this\.resetAppContent\(\)/
        .test(core),
       '★ 7-F. 長時間 background 復帰の soft reset も維持');
    ok(/_hideSplashWhenReady\(\)/.test(initBody)
        && /\}, 10000\);/.test(initBody),
       '★ 7-F. splash 制御 (確定待ち + 10 秒安全網) は維持');
}

// ---- 8. 初期あいさつを通常 A2E streaming 経路へ統一 ----
// 旧 workaround (be0d9ce5 / 7ff62a79) では初期あいさつだけ全 PCM を貯めて
// turn_complete で一括 POST していたため、expression が turn 終了まで 1 件も
// 出ず、クライアントの coordinated scheduler が音声を保持し続けていた。
{
    const code = handler.split('\n')
        .filter((l) => !/^\s*#/.test(l)).join('\n');

    ok(!/_greeting_pcm_buffer/.test(code),
       '★ 8. 初期あいさつ専用 PCM バッファが残っていない');
    ok(!/if self\._is_initial_greeting_phase[\s\S]{0,200}?_send_a2e_ahead/.test(code),
       '★ 8. 初期あいさつから _send_a2e_ahead を呼ばない');

    // 音声蓄積は分岐なしで _buffer_for_a2e
    const bufCalls = (code.match(/self\._buffer_for_a2e\(part\.inline_data\.data\)/g) || []).length;
    ok(bufCalls === 2,
       '★ 8. 通常ターンとショップ説明の 2 経路がともに _buffer_for_a2e を通る',
       `calls=${bufCalls}`);

    // turn_complete は分岐なしで flush + join
    const tc = code.slice(code.indexOf("if hasattr(sc, 'turn_complete') and sc.turn_complete:"),
                          code.indexOf('self._process_turn_complete()'));
    ok(/await self\._flush_a2e_buffer\(force=True, is_final=True\)/.test(tc)
        && /await self\._a2e_send_queue\.join\(\)/.test(tc),
       '★ 8. turn_complete は常に通常フラッシュ経路');
    ok(!/_is_initial_greeting_phase/.test(tc),
       '★ 8. turn_complete の A2E 処理に初期あいさつ分岐が無い');

    // _send_a2e_ahead 自体は残す (ショップ説明 / キャッシュ音声で使用)
    ok(/async def _send_a2e_ahead\(self, pcm_data: bytes\)/.test(code),
       '★ 8. _send_a2e_ahead() 自体は削除しない');
    const aheadCalls = (code.match(/await self\._send_a2e_ahead\(/g) || []).length;
    ok(aheadCalls === 2,
       '★ 8. _send_a2e_ahead の呼び出しはショップ説明 / キャッシュ音声の 2 箇所',
       `calls=${aheadCalls}`);

    // flush 設計そのものは変更しない
    ok(/A2E_FIRST_FLUSH_BYTES = 4800/.test(code)
        && /A2E_AUTO_FLUSH_BYTES = 240000/.test(code),
       '★ 8. flush 閾値は変更しない');
    ok(/flush_triggers = \['。', '？', '！', '\?', '!', '、', '，', ','\]/.test(code),
       '★ 8. 句読点 flush も変更しない');

    // 句読点 flush は初期あいさつでも通る (output_transcription 側に gate が無い)
    const outTr = code.slice(code.indexOf("if (hasattr(sc, 'output_transcription')"),
                             code.indexOf('self._on_output_transcription(text)') + 60);
    ok(!/_is_initial_greeting_phase/.test(outTr),
       '★ 8. 初期あいさつでも句読点 flush が働く (output_transcription に gate 無し)');

    // greeting_done / 初期あいさつフェーズ自体は残す
    ok(/self\._is_initial_greeting_phase = False[\s\S]{0,200}?greeting_done/.test(code),
       '★ 8. greeting_done と初期あいさつフェーズ管理は維持');
}

console.log(failures === 0 ? '\n=== 全テスト PASS ===' : `\n=== ${failures} 件 FAIL ===`);
process.exit(failures === 0 ? 0 : 1);
