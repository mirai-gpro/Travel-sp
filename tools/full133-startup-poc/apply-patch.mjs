// renderer パッケージにパッチを当てる（Vercel の install の後に実行。patch コマンドに頼らない）
// 元のファイルとパッチ後のファイルの SHA-256 を確認し、違えば失敗にする（確認できないものはビルドに入れない）
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const FILE = path.join(ROOT, 'node_modules/gaussian-splat-renderer-for-lam/build/gaussian-splat-renderer-for-lam.module.js');
const PATCH = path.join(HERE, 'patches/gaussian-splat-renderer-for-lam+0.0.9-alpha.1.patch');
const SHA_ORIGINAL = '7eb00f12081a82a9ff5f5fe6112309667e47a744a41ba594701198154f1c49fb';
const SHA_PATCHED = '90b1d01f5dc5e67474ebdbe5944599b2f511d49cddd046e850baa5494bf43599';
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
let src = fs.readFileSync(FILE);
const now = sha(src);
if (now === SHA_PATCHED) { console.log('[full133 patch] 適用済み'); process.exit(0); }
if (now !== SHA_ORIGINAL) { console.error(`[full133 patch] 元のファイルが想定と違う: ${now}`); process.exit(1); }
let text = src.toString('utf8');
const lines = fs.readFileSync(PATCH, 'utf8').split('\n');
let i = 0, hunks = 0;
while (i < lines.length && !lines[i].startsWith('@@')) i++;
while (i < lines.length) {
  if (!lines[i].startsWith('@@')) { i++; continue; }
  i++;
  const oldL = [], newL = [];
  while (i < lines.length && !lines[i].startsWith('@@')) {
    const l = lines[i];
    if (l.startsWith(' ')) { oldL.push(l.slice(1)); newL.push(l.slice(1)); }
    else if (l.startsWith('-')) oldL.push(l.slice(1));
    else if (l.startsWith('+')) newL.push(l.slice(1));
    else if (l.startsWith('\\')) { /* no newline marker */ }
    else if (l === '' && i === lines.length - 1) { /* 末尾 */ }
    i++;
  }
  const oldB = oldL.join('\n'), newB = newL.join('\n');
  const at = text.indexOf(oldB);
  if (at < 0 || text.indexOf(oldB, at + 1) >= 0) { console.error(`[full133 patch] hunk ${hunks + 1} の位置が一意に決まらない`); process.exit(1); }
  text = text.slice(0, at) + newB + text.slice(at + oldB.length);
  hunks++;
}
const out = Buffer.from(text, 'utf8');
if (sha(out) !== SHA_PATCHED) { console.error(`[full133 patch] パッチ後の SHA-256 が想定と違う: ${sha(out)}`); process.exit(1); }
fs.writeFileSync(FILE, out);
console.log(`[full133 patch] 適用しました（${hunks} 箇所・SHA-256 ${SHA_PATCHED.slice(0, 12)}）`);
