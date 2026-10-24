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
const read = (rel) => fs.readFileSync(path.join(__dirname, '../../', rel), 'utf8');

const lam = read('src/components/LAMAvatar.astro');
const mgr = read('src/scripts/chat/lam-websocket-manager.ts');
const core = read('src/scripts/chat/core-controller.ts');
const ui = read('src/scripts/avatar-install/install-ui.ts');
const lesson = read('src/scripts/chat/lesson-controller.ts');
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

console.log(failures === 0 ? '\n=== 全テスト PASS ===' : `\n=== ${failures} 件 FAIL ===`);
process.exit(failures === 0 ? 0 : 1);
