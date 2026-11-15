// buildModelTexture() の旧実装と TypedArray 版を、同じ入力で比べる（Node・CPU のみ）
//   親: node bench_bmt.mjs <patched module.js> <zip...>  → 1 体ずつ・1 回ずつ子プロセスで実行し JSON を出す
//   子: node --expose-gc bench_bmt.mjs --child <patched module.js> <zip> <old|new>
// 旧・新の関数は、パッチを当てた renderer の module.js から**そのまま**取り出して使う（書き写さない）
import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPS = Number(process.env.FULL133_BMT_REPS || 3);

function extractMethod(src, header) {
  const at = src.indexOf(header);
  if (at < 0 || src.indexOf(header, at + 1) >= 0) throw new Error('method not unique: ' + header);
  let i = src.indexOf('{', at), depth = 0;
  for (let j = i; j < src.length; j++) {
    const ch = src[j];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return src.slice(i, j + 1); }
  }
  throw new Error('unbalanced: ' + header);
}

async function child(modPath, zipPath, impl) {
  const THREE = await import('three');
  const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
  const JSZip = (await import('jszip')).default;
  const src = fs.readFileSync(modPath, 'utf8');
  const ufIdx = src.indexOf('const uintEncodedFloat = function() {');
  const uintEncodedFloat = new Function(src.slice(ufIdx, src.indexOf('}();', ufIdx) + 4).replace('const uintEncodedFloat =', 'return'))();
  const scope = ['Vector2', 'DataTexture', 'RGBAIntegerFormat', 'UnsignedIntType'];
  const mk = (header, name) => new Function(...scope, 'uintEncodedFloat', `return function ${name}(flameModel) ${extractMethod(src, header)};`)(
    THREE.Vector2, THREE.DataTexture, THREE.RGBAIntegerFormat, THREE.UnsignedIntType, uintEncodedFloat);
  const buildModelTexture = mk('    buildModelTexture(flameModel) {', 'buildModelTexture');
  const optImpl = mk('    __full133OptBuildModelTexture(flameModel) {', '__full133OptBuildModelTexture');

  const t0 = performance.now();
  const zipBuf = fs.readFileSync(zipPath);
  const zip = await JSZip.loadAsync(zipBuf);
  const tZipDir = performance.now();
  const glbName = Object.keys(zip.files).find(n => n.endsWith('/skin.glb'));
  const glb = await zip.file(glbName).async('arraybuffer');
  const tInflate = performance.now();
  const gltf = await new Promise((res, rej) => new GLTFLoader().parse(glb, '', res, rej));
  const tGltf = performance.now();
  let mesh = null;
  gltf.scene.traverse(o => { if (o.isSkinnedMesh) mesh = o; });
  if (!mesh) throw new Error('SkinnedMesh not found');

  const stub = {
    material: { uniforms: { flameModelTexture: { value: null }, flameModelTextureSize: { value: new THREE.Vector2() }, gaussianSplatCount: { value: 0 } }, uniformsNeedUpdate: false },
    gaussianSplatCount: mesh.geometry.attributes.position.count,
    splatDataTextures: { baseData: {} },
    __full133OptBuildModelTexture: optImpl,
  };
  globalThis.__FULL133_POC_OPT_BUILD = impl === 'new';
  global.gc && global.gc();
  const rssBefore = process.memoryUsage().rss;
  const maxBefore = process.resourceUsage().maxRSS * 1024;
  const cpu0 = process.cpuUsage();
  const w0 = performance.now();
  buildModelTexture.call(stub, mesh);           // 実際の呼び出しと同じく buildModelTexture() を呼ぶ（中でフラグにより分岐）
  const wall = performance.now() - w0;
  const cpu = process.cpuUsage(cpu0);
  const maxAfter = process.resourceUsage().maxRSS * 1024;
  const intData = stub.splatDataTextures.flameModel.data;
  const fData = stub.splatDataTextures.baseData.flameModelPos;
  const h = a => crypto.createHash('sha256').update(Buffer.from(a.buffer, a.byteOffset, a.byteLength)).digest('hex');
  return {
    impl, zip: zipPath.split('/').pop(), vertices: mesh.geometry.attributes.position.count,
    blendshapes: mesh.geometry.morphAttributes.position.length,
    textureType: stub.material.uniforms.flameModelTexture.value?.internalFormat,
    sha256Int: h(intData), sha256Float: h(fData), intLength: intData.length,
    wallMs: wall, cpuMs: (cpu.user + cpu.system) / 1000,
    rssBeforeMB: rssBefore / 2 ** 20, peakRssMB: maxAfter / 2 ** 20, peakIncreaseMB: Math.max(0, maxAfter - Math.max(maxBefore, rssBefore)) / 2 ** 20,
    nodeZipDirMs: tZipDir - t0, nodeInflateSkinMs: tInflate - tZipDir, nodeGltfParseMs: tGltf - tInflate,
  };
}

if (process.argv[2] === '--child') {
  child(process.argv[3], process.argv[4], process.argv[5])
    .then(r => { process.stdout.write(JSON.stringify(r)); })
    .catch(e => { process.stdout.write(JSON.stringify({ error: String(e && e.stack || e) })); process.exitCode = 1; });
} else {
  const [modPath, ...zips] = process.argv.slice(2);
  const self = fileURLToPath(import.meta.url);
  const out = [];
  for (const zip of zips) {
    for (let r = 0; r < REPS; r++) {
      for (const impl of (r % 2 === 0 ? ['old', 'new'] : ['new', 'old'])) {   // 順番の偏りを避ける
        const p = spawnSync(process.execPath, ['--expose-gc', '--max-old-space-size=6144', self, '--child', modPath, zip, impl],
          { encoding: 'utf8', maxBuffer: 1 << 24, env: { ...process.env } });
        let rec;
        try { rec = JSON.parse(p.stdout); } catch (e) { rec = { error: `child failed (status ${p.status}, signal ${p.signal}): ${(p.stderr || '').slice(-400)}` }; }
        rec.zip = rec.zip || zip.split('/').pop(); rec.impl = rec.impl || impl; rec.rep = r;
        out.push(rec);
        process.stderr.write(`[bmt] ${rec.zip} ${impl} rep${r}: ${rec.error ? 'ERROR ' + rec.error.slice(0, 160) : rec.wallMs.toFixed(0) + 'ms sha=' + rec.sha256Int.slice(0, 12)}\n`);
      }
    }
  }
  process.stdout.write(JSON.stringify(out));
}
