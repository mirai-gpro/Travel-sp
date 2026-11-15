// ページのスクリプトより前に入る計測（記録だけ。ページの動作は変えない）
(() => {
  const T = () => performance.now();
  const ev = window.__probe = { logs: [], audio: [], xhr: [], vis: [], splat: [], heapMax: 0, errors: [] };
  for (const lv of ['log', 'warn', 'error']) {
    const o = console[lv].bind(console);
    console[lv] = (...a) => { try { ev.logs.push({ t: T(), lv, m: a.map(x => typeof x === 'string' ? x : (() => { try { return JSON.stringify(x); } catch (e) { return String(x); } })()).join(' ').slice(0, 300) }); } catch (e) {} o(...a); };
  }
  window.addEventListener('error', e => ev.errors.push({ t: T(), m: String(e.message) }));
  window.addEventListener('unhandledrejection', e => ev.errors.push({ t: T(), m: String(e.reason && (e.reason.stack || e.reason)) }));
  const st = AudioBufferSourceNode.prototype.start;
  AudioBufferSourceNode.prototype.start = function (...a) { try { if (ev.audio.length < 50) ev.audio.push({ t: T(), dur: this.buffer && this.buffer.duration }); } catch (e) {} return st.apply(this, a); };
  const op = XMLHttpRequest.prototype.open, sd = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u, ...r) { this.__u = String(u); return op.call(this, m, u, ...r); };
  XMLHttpRequest.prototype.send = function (...a) {
    if (/\.zip/.test(this.__u || '')) { const rec = { u: this.__u, send: T(), load: null, status: null }; ev.xhr.push(rec); this.addEventListener('loadend', () => { rec.load = T(); rec.status = this.status; }); }
    return sd.apply(this, a);
  };
  let lastVis = null, lastSplat = '';
  const tick = () => {
    try {
      const c = document.getElementById('lamAvatarContainer');
      if (c) { const v = getComputedStyle(c).visibility; if (v !== lastVis) { lastVis = v; ev.vis.push({ t: T(), v }); } }
      const m = window.__lamAvatarController && window.__lamAvatarController.lamManager;
      const vw = m && m.renderer && m.renderer.viewer, sm = vw && vw.splatMesh;
      if (sm) { const k = [sm.finalBuild === true, sm.getSplatCount ? sm.getSplatCount() : -1].join('|'); if (k !== lastSplat) { lastSplat = k; ev.splat.push({ t: T(), fb: sm.finalBuild === true, cnt: sm.getSplatCount ? sm.getSplatCount() : -1 }); } }
      if (performance.memory && performance.memory.usedJSHeapSize > ev.heapMax) ev.heapMax = performance.memory.usedJSHeapSize;
    } catch (e) {}
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})();
