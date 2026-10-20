// tools/poc-tests/avatar-config-runtime.spec.cjs
//
// 実 public/avatar/avatar-config.json を読み、FULL133 runtime のキーが
// **FULL133 だけ**に付いていることを固定する。
// 通常 LAM avatar / B80 / 20K avatar に波及していないことの回帰テスト。
//
// 実行: node tools/poc-tests/avatar-config-runtime.spec.cjs
const fs = require('fs');
const path = require('path');

let failures = 0;
const ok = (cond, name, extra) => {
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
    if (!cond) failures++;
};

const FULL133 = 'uika-full133-skin';
const file = path.join(__dirname, '..', '..', 'public', 'avatar', 'avatar-config.json');
const avatars = JSON.parse(fs.readFileSync(file, 'utf-8'));

ok(Array.isArray(avatars) && avatars.length > 0, 'avatar-config.json が配列として読める',
   'entries=' + avatars.length);

const full = avatars.find(a => a.id === FULL133);
ok(!!full, `${FULL133} エントリがある`);
ok(full.morphPath === 'steady-state',
   '★ FULL133 の morphPath = steady-state', 'morphPath=' + full.morphPath);
ok(full.sortPolicy === 'adaptive-cpu',
   '★ FULL133 の sortPolicy = adaptive-cpu', 'sortPolicy=' + full.sortPolicy);

const others = avatars.filter(a => a.id !== FULL133);
const strayMorph = others.filter(a => a.morphPath !== undefined || a.morphFast !== undefined);
const straySort = others.filter(a => a.sortPolicy !== undefined);
ok(strayMorph.length === 0,
   '★ FULL133 以外に morphPath / morphFast が付いていない',
   strayMorph.map(a => a.id).join(',') || '(none)');
ok(straySort.length === 0,
   '★ FULL133 以外に sortPolicy が付いていない',
   straySort.map(a => a.id).join(',') || '(none)');

// 既存キーを壊していないこと
ok(full.modelUrl === '/avatar/uika-full133-skin.zip', 'modelUrl は変えていない');
ok(full.camera && full.camera.posY === 1.704 && full.camera.offsetX === 0.045,
   'camera パラメータは変えていない', JSON.stringify(full.camera));
ok(others.length === 21, '他の avatar 定義は 21 件のまま', 'others=' + others.length);

console.log(failures === 0 ? '\n=== 全テスト PASS ===' : `\n=== ${failures} 件 FAIL ===`);
process.exit(failures === 0 ? 0 : 1);
