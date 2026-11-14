// M4 F7/F8 のブラウザ確認（npm run build && npx astro preview --port 4329 の後に node で実行。API・バックエンド不要）
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage();
  const logs = [];
  p.on('console', m => { if (m.text().startsWith('[M4]')) logs.push(m.text()); });
  await p.goto('http://localhost:4329/concierge/', { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => !!window.shopCardManager, null, { timeout: 15000 });
  const card = (i, extra={}) => ({ name: `店${i}`, place_id: `P${i}`, llm_name: `店${i}`, area: '関内', recommend_rank: i,
    maps_url: `https://maps.google.com/?cid=${i}`, maps_attribution: { title: 'Google Maps', url: 'https://maps.google.com' },
    detail_pending: true, highlights: [], description: '', ...extra });
  const r = await p.evaluate(async (args) => {
    const [c2p, finals] = args;
    const fire = (n, d) => document.dispatchEvent(new CustomEvent(n, { detail: d }));
    const root = document.getElementById('shopCardList');
    fire('shopStage', { stage: 'preview', rid: 'R1', cards: [c2p], language: 'ja' });
    const pv = root.querySelector('.shop-card');
    const out = { pvBadge: !!pv.querySelector('.stage-badge'), pvPending: !!pv.querySelector('.detail-pending'),
                  attr: pv.querySelector('.maps-attribution a')?.getAttribute('href'), attrText: pv.querySelector('.maps-attribution')?.textContent.trim() };
    fire('shopStage', { stage: 'final', rid: 'R1', cards: finals, language: 'ja' });
    const ids = [...root.querySelectorAll('.shop-card')].map(e => e.dataset.placeId);
    out.order = ids; out.sameNode = root.querySelector('.shop-card[data-place-id="P2"]') === pv;
    out.badgeAfter = root.querySelectorAll('.stage-badge').length;
    fire('shopDetail', { request_id: 'R1', place_id: 'P3', specialty: '名物 <b>ねぎま</b>', reason: '理由<script>x</script>3' });
    const c3 = root.querySelector('.shop-card[data-place-id="P3"]');
    out.desc3 = c3.querySelector('p.description').textContent; out.pending3 = c3.querySelector('p.description').classList.contains('detail-pending');
    out.hl3 = c3.querySelector('.highlights')?.innerHTML.includes('&lt;b&gt;');
    out.scriptInjected = !!c3.querySelector('script');
    fire('shopDetail', { request_id: 'OLD', place_id: 'P4', specialty: 'x', reason: 'old' });
    out.oldIgnored = root.querySelector('.shop-card[data-place-id="P4"] p.description').textContent !== 'old';
    fire('shopStage', { stage: 'preview', rid: 'R2', cards: [finals[0]], language: 'ja' });
    out.newSearchCount = root.querySelectorAll('.shop-card').length;
    await new Promise(r => setTimeout(r, 100));
    return out;
  }, [card(2, { stage: 'preview' }), [1,2,3,4,5].map(i => card(i, { stage: 'final' }))]);
  console.log(JSON.stringify(r, null, 1));
  console.log(logs.join('\n'));
  await p.screenshot({ path: 'm4_ui_check.png', fullPage: false });
  await b.close();
})();
