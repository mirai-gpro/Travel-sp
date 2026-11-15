// A〜D の起動の比較（Playwright・ソフトウェア GPU）。本番には接続しない（ローカルのフロントとバックエンドの代わりだけ）
import { chromium, devices } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const [FRONT, OUT] = process.argv.slice(2);
const PROFILES = (process.env.FULL133_PROFILES || 'pc,mobile').split(',');
const CONFIGS = (process.env.FULL133_CONFIGS || 'A,B,C,D').split(',');
const REPS = Number(process.env.FULL133_E2E_REPS || 3);
const REP_FROM = Number(process.env.FULL133_REP_FROM || 1) - 1;
const REP_TO = Number(process.env.FULL133_REP_TO || REPS) - 1;
const TOTAL = PROFILES.length * CONFIGS.length * (REP_TO - REP_FROM + 1) * 2;
const PROFILE_DEF = {
  pc: { label: 'PC 想定（下り 50Mbps・上り 10Mbps・RTT 20ms・CPU 等倍）', down: 50e6, up: 10e6, rtt: 20, cpu: 1, ctx: { viewport: { width: 1440, height: 900 } }, timeout: 120000 },
  mobile: { label: 'スマホ想定（Pixel 7 の画面・下り 20Mbps・上り 5Mbps・RTT 40ms・CPU 4 倍遅く）', down: 20e6, up: 5e6, rtt: 40, cpu: 4, ctx: { ...devices['Pixel 7'] }, timeout: 240000 },
};
const results = { startedAt: new Date().toISOString(), front: FRONT, host: { cpus: os.cpus().length, cpuModel: os.cpus()[0]?.model, memGB: Math.round(os.totalmem() / 2 ** 30) }, profiles: {}, runs: [], versionCheck: [], errors: [] };
const save = () => fs.writeFileSync(OUT, JSON.stringify(results, null, 1));

function treeRssMB(rootPid) {
  try {
    const rows = execSync('ps -eo pid=,ppid=,rss=', { encoding: 'utf8' }).trim().split('\n').map(l => l.trim().split(/\s+/).map(Number));
    const kids = new Map(); for (const [pid, ppid] of rows) { if (!kids.has(ppid)) kids.set(ppid, []); kids.get(ppid).push(pid); }
    const rss = new Map(rows.map(([pid, , r]) => [pid, r]));
    let sum = 0; const st = [rootPid];
    while (st.length) { const p = st.pop(); sum += rss.get(p) || 0; for (const k of kids.get(p) || []) st.push(k); }
    return sum / 1024;
  } catch (e) { return null; }
}
function browserPid(userDir) {
  try { return Number(execSync(`pgrep -f -o -- "--user-data-dir=${userDir}"`, { encoding: 'utf8' }).trim().split('\n')[0]) || null; } catch (e) { return null; }
}

async function oneLoad(ctx, prof, cfg, userDir) {
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  const net = new Map();
  const failed = [];
  page.on('requestfailed', q => { if (failed.length < 20) failed.push(`${q.url().slice(0, 120)} ${q.failure() && q.failure().errorText}`); });
  await cdp.send('Network.enable');
  cdp.on('Network.requestWillBeSent', e => { if (/\.zip(\?|$)/.test(e.request.url)) net.set(e.requestId, { url: e.request.url.replace(FRONT, ''), type: e.type, t: e.timestamp }); });
  cdp.on('Network.responseReceived', e => { const r = net.get(e.requestId); if (r) Object.assign(r, { status: e.response.status, fromDiskCache: !!e.response.fromDiskCache, fromServiceWorker: !!e.response.fromServiceWorker, fromPrefetchCache: !!e.response.fromPrefetchCache }); });
  cdp.on('Network.loadingFinished', e => { const r = net.get(e.requestId); if (r) r.encodedBytes = e.encodedDataLength; });
  cdp.on('Network.loadingFailed', e => { const r = net.get(e.requestId); if (r) r.failed = e.errorText; });
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: prof.rtt, downloadThroughput: prof.down / 8, uploadThroughput: prof.up / 8 });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: prof.cpu });
  const pid = browserPid(userDir);
  let rssPeak = 0;
  const memTimer = setInterval(() => { const m = pid && treeRssMB(pid); if (m && m > rssPeak) rssPeak = m; }, 300);
  const url = `${FRONT}/concierge/?pocStartup=${cfg}&pocTrace=1`;
  const t0 = Date.now();
  let timedOut = false;
  let startFailed = false;
  try {
    await page.goto(url, { waitUntil: 'commit', timeout: 60000 });
    const deadline = Date.now() + prof.timeout;
    let audioSeen = null;
    const startedBy = Date.now() + 30000;
    let started = false;
    while (Date.now() < deadline) {
      await page.waitForTimeout(500);
      const s = await page.evaluate(() => ({ core: !!(window.__probe && window.__probe.logs.some(l => /\[Core\] Starting initialization/.test(l.m))), a: (window.__probe && window.__probe.audio.length) || 0, fb: !!(window.__probe && window.__probe.splat.some(x => x.fb)), err: (window.__probe && window.__probe.errors.length) || 0 })).catch(() => null);
      if (!s) continue;
      if (s.core) started = true;
      if (!started && Date.now() > startedBy) { startFailed = true; break; }
      if (s.a > 0 && s.fb && audioSeen === null) audioSeen = Date.now();
      if (audioSeen && Date.now() - audioSeen > 2500) break;
    }
    if (!audioSeen && !startFailed) timedOut = true;
  } catch (e) { results.errors.push({ cfg, err: String(e) }); }
  clearInterval(memTimer);
  const data = await page.evaluate(async () => {
    const marks = {}; for (const m of performance.getEntriesByType('mark')) { (marks[m.name] = marks[m.name] || []).push(m.startTime); }
    let texSha = null;
    try {
      const sm = window.__lamAvatarController.lamManager.renderer.viewer.splatMesh;
      const d = sm.splatDataTextures && sm.splatDataTextures.flameModel && sm.splatDataTextures.flameModel.data;
      if (d) { const h = await crypto.subtle.digest('SHA-256', d); texSha = Array.from(new Uint8Array(h)).map(b => b.toString(16).padStart(2, '0')).join(''); }
    } catch (e) {}
    const n = performance.getEntriesByType('navigation')[0];
    const nav = n ? { workerStart: n.workerStart, fetchStart: n.fetchStart, responseStart: n.responseStart, responseEnd: n.responseEnd, domInteractive: n.domInteractive, dcl: n.domContentLoadedEventEnd, transferSize: n.transferSize } : null;
    return { nav, marks, probe: window.__probe, visibleState: window.__FULL133_POC_VISIBLE_STATE || null, texSha, mode: window.__FULL133_POC_MODE || null, ua: navigator.userAgent,
      gl: (() => { try { const c = document.createElement('canvas').getContext('webgl2'); const e = c.getExtension('WEBGL_debug_renderer_info'); return c.getParameter(e.UNMASKED_RENDERER_WEBGL); } catch (e) { return 'n/a'; } })() };
  }).catch(e => ({ error: String(e) }));
  await page.close();
  return { wallMs: Date.now() - t0, timedOut, startFailed, failedRequests: failed, rssPeakMB: rssPeak || null, zipRequests: [...net.values()], ...data };
}

(async () => {
  for (const pname of PROFILES) {
    const prof = PROFILE_DEF[pname];
    results.profiles[pname] = prof.label;
    for (let rep = REP_FROM; rep <= REP_TO; rep++) {
      for (const cfg of CONFIGS) {
        const userDir = fs.mkdtempSync(path.join(os.tmpdir(), `f133-${pname}-${cfg}-`));
        let ctx;
        try {
          ctx = await chromium.launchPersistentContext(userDir, { headless: true, ...prof.ctx,
            args: ['--autoplay-policy=no-user-gesture-required', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
          await ctx.addInitScript({ path: path.join(HERE, 'seed_full133.js') });
          await ctx.addInitScript({ path: path.join(HERE, 'probe.js') });
          for (const cache of ['cold', 'warm']) {
            const r = await oneLoad(ctx, prof, cfg, userDir);
            results.runs.push({ profile: pname, config: cfg, rep, cache, ...r });
            process.stderr.write(`[e2e] ${results.runs.length}/${TOTAL} 件 ${pname} ${cfg} ${cache === 'cold' ? '初回' : '2回目'} rep${rep + 1}: ${r.startFailed ? '起動失敗' : r.timedOut ? '時間切れ' : '完了'}（${(r.wallMs / 1000).toFixed(0)} 秒）\n`);
            save();
          }
          // ZIP の版が変わったときに、保存分を使わないか（B・D の rep0 だけ）
          if (process.env.FULL133_VERSION_CHECK !== '0' && rep === 0 && (cfg === 'B' || cfg === 'D')) {
            await fetch(`${FRONT}/__poc/zip-version`, { method: 'POST' });
            const r = await oneLoad(ctx, prof, cfg, userDir);
            results.versionCheck.push({ profile: pname, config: cfg, zipRequests: r.zipRequests, marks: Object.keys(r.marks || {}).filter(k => k.startsWith('poc:prefetch')), texSha: r.texSha });
            save();
          }
        } catch (e) {
          results.errors.push({ profile: pname, config: cfg, rep, err: String(e && e.stack || e) });
          save();
        } finally {
          if (ctx) await ctx.close().catch(() => {});
          fs.rmSync(userDir, { recursive: true, force: true });
        }
      }
    }
  }
  results.finishedAt = new Date().toISOString();
  save();
  process.stderr.write('[e2e] done\n');
})();
