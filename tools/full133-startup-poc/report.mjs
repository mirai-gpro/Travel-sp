// 結果の集計: JSON（全データ）と TXT（表）を書く。測れなかったものは「未測定」と書き、数値を補わない
import fs from 'node:fs';
const [ENV_JSON, BMT_JSON, E2E_JSON, OUT_JSON, OUT_TXT] = process.argv.slice(2);
const rd = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } };
const env = rd(ENV_JSON) || {}, bmt = rd(BMT_JSON), e2e = rd(E2E_JSON);
const med = a => { const b = a.filter(x => typeof x === 'number' && isFinite(x)).sort((x, y) => x - y); if (!b.length) return null; const m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };
const s = (x, d = 2) => x == null ? '未測定' : (x / 1000).toFixed(d);
const n = (x, d = 0) => x == null ? '未測定' : Number(x).toFixed(d);
const L = [];
const P = (...a) => L.push(a.join(''));

P('UIKA FULL133 起動の比較 PoC（Cloud Shell）'); P('='.repeat(60));
P(`実行: ${env.startedAt || '?'}  コミット: ${env.sha || '?'}`);
P(`環境: ${env.os || '?'} / CPU ${env.cpus || '?'} 個 (${env.cpuModel || '?'}) / メモリ ${env.memGB || '?'} GB / Node ${env.node || '?'}`);
P(`renderer パッケージ: 元ファイル SHA-256 ${env.pkgShaBefore || '?'}（期待値 ${env.pkgShaExpected || '?'}）→ パッチ後 ${env.pkgShaAfter || '?'}`);
if (env.steps) { P('手順の結果:'); for (const [k, v] of Object.entries(env.steps)) P(`  - ${k}: ${v}`); }
P('');

// ---------- 1. buildModelTexture（Node・CPU）----------
const bmtOut = { perAvatar: [], allIdentical: null };
P('1. buildModelTexture() 旧実装と TypedArray 版（Node・CPU のみ。ソフトウェア GPU の影響なし）'); P('-'.repeat(60));
if (!Array.isArray(bmt)) { P('未測定（ベンチマークが実行できませんでした。手順の結果を参照）'); }
else {
  const zips = [...new Set(bmt.map(r => r.zip))];
  P('アバター                         旧(ms)   新(ms)  短縮率  CPU旧(ms) CPU新(ms) ピーク増 旧/新(MB)  出力 SHA-256 一致');
  let allOk = true;
  for (const z of zips) {
    const o = bmt.filter(r => r.zip === z && r.impl === 'old' && !r.error), w = bmt.filter(r => r.zip === z && r.impl === 'new' && !r.error);
    const errs = bmt.filter(r => r.zip === z && r.error);
    const hashes = new Set([...o, ...w].map(r => r.sha256Int)), fh = new Set([...o, ...w].map(r => r.sha256Float));
    const ok = o.length > 0 && w.length > 0 && hashes.size === 1 && fh.size === 1 && errs.length === 0;
    if (!ok) allOk = false;
    const mo = med(o.map(r => r.wallMs)), mw = med(w.map(r => r.wallMs));
    const rec = { zip: z, runsOld: o.length, runsNew: w.length, errors: errs.map(r => r.error), oldMs: mo, newMs: mw, reductionPct: mo && mw ? (1 - mw / mo) * 100 : null,
      oldCpuMs: med(o.map(r => r.cpuMs)), newCpuMs: med(w.map(r => r.cpuMs)), oldPeakIncMB: med(o.map(r => r.peakIncreaseMB)), newPeakIncMB: med(w.map(r => r.peakIncreaseMB)),
      oldPeakRssMB: med(o.map(r => r.peakRssMB)), newPeakRssMB: med(w.map(r => r.peakRssMB)),
      sha256Int: [...hashes], sha256Float: [...fh], identical: ok, vertices: (o[0] || w[0] || {}).vertices, blendshapes: (o[0] || w[0] || {}).blendshapes,
      nodeInflateSkinMs: med([...o, ...w].map(r => r.nodeInflateSkinMs)), nodeGltfParseMs: med([...o, ...w].map(r => r.nodeGltfParseMs)) };
    bmtOut.perAvatar.push(rec);
    P(`${z.padEnd(32)} ${n(mo).padStart(6)}  ${n(mw).padStart(6)}  ${rec.reductionPct == null ? '未測定' : rec.reductionPct.toFixed(1) + '%'}  ${n(rec.oldCpuMs).padStart(8)} ${n(rec.newCpuMs).padStart(8)}   ${n(rec.oldPeakIncMB)}/${n(rec.newPeakIncMB)}      ${ok ? '一致' : '不一致または失敗'} ${[...hashes].map(h => h.slice(0, 12)).join(',')}${errs.length ? ' エラー: ' + errs[0].error.slice(0, 80) : ''}`);
  }
  bmtOut.allIdentical = allOk;
  P(`全 ${zips.length} 体の判定: ${allOk ? 'すべて旧実装とビット単位で一致（flameModelDataInt と flameModelPos の SHA-256）' : '一致しないもの・失敗があります（不採用）'}`);
  P(`回数: 各アバター 旧・新 それぞれ ${med(bmtOut.perAvatar.map(x => x.runsOld))} 回（中央値を表示）`);
}
P('');

// ---------- 2. 起動の比較（ブラウザ）----------
const rows = [];
const e2eOut = { profiles: e2e?.profiles || {}, groups: [], versionCheck: e2e?.versionCheck || [], errors: e2e?.errors || [] };
if (e2e && Array.isArray(e2e.runs)) {
  for (const r of e2e.runs) {
    const logT = re => { const x = (r.probe?.logs || []).find(l => re.test(l.m)); return x ? x.t : null; };
    const mk = k => (r.marks || {})[k]?.[0] ?? null;
    const initStart = logT(/\[AVATAR\] initialization_start/);
    const isPre = r.config === 'B' || r.config === 'D';
    const xhr = (r.probe?.xhr || [])[0];
    const zipFetch = isPre ? (mk('poc:prefetch:done') != null && mk('poc:prefetch:start') != null ? mk('poc:prefetch:done') - mk('poc:prefetch:start') : null) : (xhr && xhr.load ? xhr.load - xhr.send : null);
    const bmtSum = ((r.marks || {})['poc:bmt:end'] || []).reduce((a, e, i) => a + (e - ((r.marks || {})['poc:bmt:start'] || [])[i]), 0) || null;
    const finalBuild = mk('poc:build:final'), patches = mk('poc:patches:done');
    const complete = finalBuild != null && patches != null ? Math.max(finalBuild, patches) : null;
    const visible = mk('poc:visible'), reveal = mk('poc:reveal');
    const shownComplete = r.config === 'D' ? reveal : (complete != null && visible != null ? Math.max(complete, visible) : null);
    const release = logT(/\[PlaybackHold\] release/), audio = r.probe?.audio?.[0]?.t ?? null;
    const zr = r.zipRequests || [];
    const sel = zr.filter(z => /uika-meruru02-full133\.zip/.test(z.url));
    if (r.startFailed) { e2eOut.startFailures = (e2eOut.startFailures || []).concat([{ profile: r.profile, config: r.config, cache: r.cache, rep: r.rep, failedRequests: r.failedRequests }]); continue; }
    rows.push({ profile: r.profile, config: r.config, cache: r.cache, rep: r.rep, timedOut: r.timedOut,
      navResponseStart: r.nav?.responseStart ?? null, scriptStart: mk(`poc:mode:${r.config}`), initStart, zipFetch, zipDone: mk('poc:zip:done'),
      zipWaitAfterInit: mk('poc:zip:done') != null && initStart != null ? Math.max(0, mk('poc:zip:done') - initStart) : null,
      jszip: mk('poc:jszip:done') != null && mk('poc:zip:done') != null ? mk('poc:jszip:done') - mk('poc:zip:done') : null,
      loadModel: mk('poc:loadModel:done') != null && mk('poc:jszip:done') != null ? mk('poc:loadModel:done') - mk('poc:jszip:done') : null,
      bmt: bmtSum, finalBuild, patches, complete, visible, reveal, shownComplete, release, audio,
      visibleBeforeComplete: r.visibleState ? !r.visibleState.ok : null, audioBeforeComplete: audio != null && complete != null ? audio < complete : null,
      releaseAfterShown: release != null && shownComplete != null ? release >= shownComplete : null,
      rssPeakMB: r.rssPeakMB, heapMaxMB: r.probe?.heapMax ? r.probe.heapMax / 2 ** 20 : null,
      zipCount: zr.length, zipSelectedCount: sel.length, zipOtherCount: zr.length - sel.length, zipBytes: zr.reduce((a, z) => a + (z.encodedBytes || 0), 0),
      zipStatuses: zr.map(z => `${z.type}:${z.status}${z.fromDiskCache ? '(disk)' : ''}${z.fromServiceWorker ? '(sw)' : ''}`).join(' '),
      texSha: r.texSha, gl: r.gl, errors: (r.probe?.errors || []).map(e => e.m).slice(0, 3) });
  }
}
e2eOut.rows = rows;
P('2. 起動の比較（Playwright の Chromium・ローカルのフロント・バックエンドの代わり）'); P('-'.repeat(60));
if (!rows.length) { P('未測定（ブラウザの計測が実行できませんでした。手順の結果とエラーを参照）'); (e2eOut.startFailures || []).slice(0, 5).forEach(x => P(`  ページが起動しない: ${x.profile} ${x.config} ${x.cache} rep${x.rep}: ${(x.failedRequests || []).slice(0, 2).join(' / ')}`)); }
else {
  const gl = [...new Set(rows.map(r => r.gl))].join(' / ');
  P(`GPU: ${gl}`);
  P('※ ソフトウェア GPU。最初の描画・完成表示・VISIBLE の時刻は実機の GPU の値ではありません。');
  P('※ 音声はバックエンドの代わり（無音・決め打ちの時刻）。「初回音声」は再生の順番の確認用で、実際の挨拶の時刻ではありません。');
  P('※ 数値はページの開始（navigation）からの秒。各組は 3 回の中央値（括弧内は最小〜最大）。');
  P('');
  const fields = [['initStart', 'ページ開始→アバター初期化開始'], ['zipFetch', 'ZIP 取得時間'], ['zipWaitAfterInit', '初期化開始→ZIP が使えるまで'], ['jszip', 'ZIP 読み込み（JSZip）'], ['loadModel', 'GLB の展開・解析'], ['bmt', 'buildModelTexture'], ['finalBuild', 'Splat 最終構築（時刻）'], ['patches', 'FULL133 初期化完了（時刻）'], ['shownComplete', '完成アバター表示（時刻）※GPU'], ['visible', 'AVATAR_VISIBLE（時刻）※GPU'], ['release', 'PlaybackHold 解除（時刻）'], ['audio', '初回音声 start()（時刻）※代わり'], ['rssPeakMB', 'ブラウザ最大メモリ（MB）'], ['heapMaxMB', 'JS ヒープ最大（MB）'], ['zipBytes', 'ZIP 転送量（MB）']];
  for (const prof of Object.keys(e2eOut.profiles)) {
    P(`■ ${e2eOut.profiles[prof]}`);
    for (const cache of ['cold', 'warm']) {
      P(`  [${cache === 'cold' ? 'キャッシュなし（初回）' : 'キャッシュあり（2 回目）'}]`);
      P('  項目'.padEnd(34) + ['A 現行', 'B 先読み', 'C CPU最適化', 'D 統合'].map(x => x.padStart(18)).join(''));
      for (const [f, label] of fields) {
        const cells = ['A', 'B', 'C', 'D'].map(cfg => {
          const v = rows.filter(r => r.profile === prof && r.cache === cache && r.config === cfg).map(r => r[f]).filter(x => x != null);
          if (!v.length) return '未測定';
          const isMB = f.endsWith('MB'), isB = f === 'zipBytes';
          const fmt = x => isB ? (x / 1e6).toFixed(1) : isMB ? x.toFixed(0) : (x / 1000).toFixed(2);
          return `${fmt(med(v))} (${fmt(Math.min(...v))}〜${fmt(Math.max(...v))})`;
        });
        P('  ' + label.padEnd(32) + cells.map(c => c.padStart(18)).join(''));
      }
      const flags = ['A', 'B', 'C', 'D'].map(cfg => {
        const g = rows.filter(r => r.profile === prof && r.cache === cache && r.config === cfg);
        const cnt = (k) => g.filter(r => r[k] === true).length;
        return `${cfg}: 完成前に表示 ${cnt('visibleBeforeComplete')}/${g.length}・完成前に音声 ${cnt('audioBeforeComplete')}/${g.length}・解除が完成表示の後 ${cnt('releaseAfterShown')}/${g.length}・タイムアウト ${cnt('timedOut')}・ZIP 要求 ${[...new Set(g.map(r => r.zipCount))].join('/')} 件（選択中以外 ${g.reduce((a, r) => a + r.zipOtherCount, 0)}）・${[...new Set(g.map(r => r.zipStatuses))].join(' | ')}`;
      });
      flags.forEach(x => P('    ' + x));
      for (const cfg of ['B', 'C', 'D']) {
        const a = med(rows.filter(r => r.profile === prof && r.cache === cache && r.config === 'A').map(r => r.shownComplete));
        const b = med(rows.filter(r => r.profile === prof && r.cache === cache && r.config === cfg).map(r => r.shownComplete));
        e2eOut.groups.push({ profile: prof, cache, config: cfg, medianShownCompleteA: a, medianShownComplete: b, deltaVsA: a != null && b != null ? b - a : null });
        P(`    完成アバター表示の差（${cfg} − A、中央値）: ${a != null && b != null ? ((b - a) / 1000).toFixed(2) + ' 秒' : '未測定'}`);
      }
      P('');
    }
  }
  if (e2eOut.startFailures && e2eOut.startFailures.length) { P(`ページが起動しなかった読み込み（集計から除外）: ${e2eOut.startFailures.length} 件`); e2eOut.startFailures.slice(0, 5).forEach(x => P(`  ${x.profile} ${x.config} ${x.cache} rep${x.rep}: ${(x.failedRequests || []).slice(0, 2).join(' / ')}`)); }
  const tex = [...new Set(rows.map(r => r.texSha).filter(Boolean))];
  P(`ブラウザ内で作られたテクスチャ（flameModelDataInt）の SHA-256: ${tex.length === 1 ? 'A〜D の全試行で同一 ' + tex[0] : tex.length ? '一致しない: ' + tex.join(', ') : '未測定'}`);
  P('ZIP の版の変更（ETag を変えた後の読み込み）:');
  for (const v of e2eOut.versionCheck) P(`  ${v.profile} ${v.config}: ZIP 要求 ${v.zipRequests.map(z => `${z.type}:${z.status}`).join(' ')}・${v.marks.join(',')} → ${v.marks.includes('poc:prefetch:200') && !v.marks.includes('poc:prefetch:304') ? '新しい版を取得（保存分は使わない）' : '要確認'}`);
  if (e2eOut.errors.length) { P('エラー:'); e2eOut.errors.forEach(x => P('  ' + JSON.stringify(x).slice(0, 300))); }
}
P('');
P('3. この環境で測れないもの（未測定）'); P('-'.repeat(60));
['実機 GPU での最初の描画・完成表示までの時間（この計測はソフトウェア GPU）', '本物の Gemini Live の挨拶の音声が届く時刻と、その再生開始', 'リップシンクの品質（A2E・口の動き）', 'iPhone（Safari）・Android 実機の CPU 時間とメモリ', '実機のブラウザが 25MB の ZIP をキャッシュに残すか'].forEach(x => P('  - ' + x));
fs.writeFileSync(OUT_TXT, L.join('\n') + '\n');
fs.writeFileSync(OUT_JSON, JSON.stringify({ env, buildModelTexture: { summary: bmtOut, raw: bmt }, startup: { summary: e2eOut, raw: e2e } }, null, 1));
console.log(L.join('\n'));
