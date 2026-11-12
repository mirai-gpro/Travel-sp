const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage();
  p.on('pageerror', e => {});
  await p.goto('http://localhost:4399/concierge/', { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => !!window.shopCardManager, null, { timeout: 15000 });
  const r = await p.evaluate(async () => {
    const shops = [
      { name: 'A店', place_id: 'PA', tabelog_url: 'https://tabelog/a', gnavi_url: 'https://g/a' },
      { name: 'B店', place_id: 'PB', tabelog_url: 'https://tabelog/b' },
    ];
    const hp = (i) => !!document.querySelectorAll('.shop-card')[i].querySelector('.link-btn.hotpepper');
    const href = (i) => document.querySelectorAll('.shop-card')[i].querySelector('.link-btn.hotpepper')?.getAttribute('href');
    document.dispatchEvent(new CustomEvent('displayShops', { detail: { shops, language: 'ja', searchId: 'S1' } }));
    const out = { initial: [hp(0), hp(1)], names0: document.querySelectorAll('.shop-name')[0].textContent };
    // 別検索IDの更新は無視
    const s2 = JSON.parse(JSON.stringify(shops)); s2[0].hotpepper_url = 'https://hp/WRONG';
    document.dispatchEvent(new CustomEvent('updateShopLinks', { detail: { searchId: 'S0', shops: s2, placeIds: ['PA'] } }));
    out.afterWrong = [hp(0), hp(1)];
    // 同じ検索IDの更新は place_id のカードだけに反映
    shops[1].hotpepper_url = 'https://hp/B';
    document.dispatchEvent(new CustomEvent('updateShopLinks', { detail: { searchId: 'S1', shops, placeIds: ['PB'] } }));
    out.afterRight = [hp(0), href(1)];
    out.names = Array.from(document.querySelectorAll('.shop-name')).map(e => e.textContent);
    // 新しい表示（searchId なし = REST 経路）後は S1 の更新も無視
    document.dispatchEvent(new CustomEvent('displayShops', { detail: { shops: [{ name: 'C店', place_id: 'PA' }], language: 'ja' } }));
    shops[0].hotpepper_url = 'https://hp/A';
    document.dispatchEvent(new CustomEvent('updateShopLinks', { detail: { searchId: 'S1', shops, placeIds: ['PA'] } }));
    out.afterOtherDisplay = [hp(0)];
    return out;
  });
  console.log(JSON.stringify(r));
  await b.close();
})();
