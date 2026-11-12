const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage();
  const logs = [];
  p.on('console', m => { const t = m.text(); if (t.includes('ShopTiming') || t.includes('updateLinks')) logs.push(t); });
  await p.goto('http://127.0.0.1:4398/concierge/', { waitUntil: 'domcontentloaded' });
  const snaps = [];
  for (let i = 0; i < 40; i++) {
    await p.waitForTimeout(250);
    snaps.push(await p.evaluate(() => Array.from(document.querySelectorAll('.shop-card')).map(c => ({
      pid: c.dataset.placeId, name: c.querySelector('.shop-name')?.textContent,
      hp: c.querySelector('.link-btn.hotpepper')?.getAttribute('href') || null }))));
  }
  const seen = new Set(snaps.map(s => JSON.stringify(s)));
  console.log('DISTINCT CARD STATES:'); for (const s of seen) console.log(' ', s);
  console.log('LOGS:'); for (const l of logs) console.log(' ', l);
  await b.close();
})();
