// 計測用のローカルサーバー（本番には接続しない）
//   :FRONT_PORT  ビルドしたフロント（dist）。ヘッダーは Vercel 本番と同じ考え方:
//                /avatar/*.zip → Cache-Control: public, max-age=0, must-revalidate ＋ ETag（If-None-Match なら 304）
//                /assets/*     → immutable、HTML → no-cache
//                POST /__poc/zip-version で ZIP の ETag を変える（「ZIP が更新された」を再現。中身は同じ）
//   :BACK_PORT   バックエンドの代わり（REST と Socket.IO）。Live の音声は無音、表情は 0。G1/G2 と同じく live_start ごとに挨拶を流す
//                ※ 本物の Gemini ではないので、音声・表情の届く時刻はこのサーバーの決め打ち（イベントの順番の確認用）
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Server } from 'socket.io';

const [DIST, FRONT_PORT, BACK_PORT, NAMES_SRC] = process.argv.slice(2);
let zipVersion = 1;
const etagCache = new Map();
const etagOf = (file, st) => {
  const k = file + ':' + st.size + ':' + st.mtimeMs;
  if (!etagCache.has(k)) etagCache.set(k, crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex'));
  return `"${etagCache.get(k)}-v${zipVersion}"`;
};
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.zip': 'application/zip', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.mp4': 'video/mp4', '.ico': 'image/x-icon', '.txt': 'text/plain' };
const log = [];

http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (req.method === 'POST' && u.pathname === '/__poc/zip-version') { zipVersion++; res.writeHead(200); res.end(String(zipVersion)); return; }
  if (u.pathname === '/__poc/log') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(log)); log.length = 0; return; }
  let p = decodeURIComponent(u.pathname);
  let file = path.join(DIST, p);
  if (!file.startsWith(DIST)) { res.writeHead(403); res.end(); return; }
  try { if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.html'); } catch (e) {
    if (fs.existsSync(file + '.html')) file += '.html'; else { res.writeHead(404); res.end(); return; }
  }
  if (!fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
  const st = fs.statSync(file);
  const ext = path.extname(file);
  const headers = { 'content-type': TYPES[ext] || 'application/octet-stream' };
  if (ext === '.zip') {
    const etag = etagOf(file, st);
    headers['cache-control'] = 'public, max-age=0, must-revalidate';
    headers['etag'] = etag;
    if (req.headers['if-none-match'] === etag) { log.push({ path: p, status: 304 }); res.writeHead(304, headers); res.end(); return; }
    log.push({ path: p, status: 200, bytes: st.size });
    headers['content-length'] = st.size;
    res.writeHead(200, headers);
    fs.createReadStream(file).pipe(res);
    return;
  }
  headers['cache-control'] = p.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'public, max-age=0, must-revalidate';
  res.writeHead(200, headers);
  fs.createReadStream(file).pipe(res);
}).listen(Number(FRONT_PORT), '127.0.0.1');

// ---- バックエンドの代わり ----
const src = fs.readFileSync(NAMES_SRC, 'utf8');
const block = src.slice(src.indexOf('ARKIT_BLENDSHAPE_NAMES'));
const NAMES = block.slice(block.indexOf('[') + 1, block.indexOf(']')).match(/'([A-Za-z_]+)'/g).map(s => s.slice(1, -1));
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET,POST,OPTIONS' };
const backend = http.createServer((req, res) => {
  if (req.url.startsWith('/socket.io')) return;   // socket.io が処理する
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
  let body = '';
  req.on('data', d => body += d);
  req.on('end', () => {
    res.writeHead(200, { ...cors, 'content-type': 'application/json' });
    if (req.url.startsWith('/api/session/start')) res.end(JSON.stringify({ session_id: 'poc-' + crypto.randomUUID(), status: 'ok' }));
    else if (req.url.startsWith('/health')) res.end(JSON.stringify({ status: 'healthy' }));
    else res.end(JSON.stringify({ status: 'ok' }));
  });
});
const io = new Server(backend, { cors: { origin: '*' } });
const PCM_100MS = Buffer.alloc(2400 * 2).toString('base64');   // 24kHz・16bit・100ms の無音
io.on('connection', (sock) => {
  let timers = [];
  const stopStream = () => { timers.forEach(clearTimeout); timers = []; };
  const at = (ms, ev, data) => timers.push(setTimeout(() => sock.emit(ev, data), ms));
  sock.on('live_start', () => {
    stopStream();
    at(100, 'live_ready', { status: 'connected' });
    at(120, 'greeting_done', {});
    // 挨拶: 0.8 秒後から 4 秒分の音声（100ms ごと）、表情は chunk 0（0.1 秒分）と以後 1 秒ごと
    for (let i = 0; i < 40; i++) at(800 + i * 100, 'live_audio', { data: PCM_100MS });
    const frames = n => Array.from({ length: n }, () => new Array(NAMES.length).fill(0));
    at(850, 'live_expression', { chunk_index: 0, expressions: frames(3), expression_names: NAMES, frame_rate: 30 });
    for (let c = 1; c <= 4; c++) at(850 + c * 1000, 'live_expression', { chunk_index: c, expressions: frames(30), expression_names: NAMES, frame_rate: 30 });
    at(5000, 'turn_complete', {});
  });
  sock.on('live_stop', () => { stopStream(); sock.emit('live_stopped', { status: 'disconnected' }); });
  sock.on('disconnect', stopStream);
});
backend.listen(Number(BACK_PORT), '127.0.0.1');
console.log(`ready front=:${FRONT_PORT} back=:${BACK_PORT} names=${NAMES.length}`);
