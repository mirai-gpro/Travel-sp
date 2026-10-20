// tools/poc-tests/full133-predeform.spec.cjs
//
// GPU pre-deformation runtime のテスト。実 GPU は不要。
//
//   1. shader patch が morph loop **だけ** を外し、center 読み出しと
//      aligned skinning block を壊さないこと
//   2. 固定 51 weight に対して legacy の式と predeform の式が一致すること
//      (指示書 §27。代表 index を eye / mouth / nose / hairline / random で固定)
//   3. weights が morphTargetDictionary 順で取れること
//   4. FULL133 以外には適用しないこと
//   5. 初期化に失敗したら main shader を一切書き換えないこと
//
// 実行:
//   npx esbuild src/scripts/chat/full133-predeform.ts --bundle --format=cjs \
//     --platform=node --outfile=tools/poc-tests/.full133-predeform.cjs
//   node tools/poc-tests/full133-predeform.spec.cjs
let failures = 0;
const ok = (cond, name, extra) => {
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
    if (!cond) failures++;
};

const FULL133 = 133541;
const BS = 51;

// ---- 実 SplatMaterial.js:213-245 の該当部分を写したもの ----
const REAL_SHADER = `
            uvec3 sampledCenter = texture(centersColorsTexture, getDataUV(1, 0, centersColorsTextureSize)).gba;
            vec3 splatCenter = uintBitsToFloat(uvec3(sampledCenter));

            vec2 flameTextureUV = getBSFlameDataUV(bsCount, 1, 0, flameModelTextureSize);
            uvec3 sampledflamePos = texture(flameModelTexture, flameTextureUV).rgb;

            for(int i = 0; i < bsCount; ++i) {
                vec2 flameBSTextureUV = getBSFlameDataUV(i, 1, 0, flameModelTextureSize);
                uvec3 sampledBSPos = texture(flameModelTexture, flameBSTextureUV).rgb;
                vec2 samplerUV = vec2(0.0, 0.0);
                float d = float(i / 4 + 5 * 4) / boneTextureSize.x;
                samplerUV.y = float(floor(d)) / boneTextureSize.y;
                samplerUV.x = fract(d);
                vec4 bsWeight = uintBitsToFloat(texture(boneTexture, samplerUV));
                float weight = bsWeight.r;
                if(i % 4 == 1) { weight = bsWeight.g; }
                if(i % 4 == 2) { weight = bsWeight.b; }
                if(i % 4 == 3) { weight = bsWeight.a; }
                splatCenter = splatCenter + weight * uintBitsToFloat(sampledBSPos);
            }

            #ifdef USE_SKINNING
                mat4 aMX = getBoneMatrix0( aIdx.x );
                skinned += aMX * skinVertex * aW.x;
            #endif
            splatCenter = transformed.xyz;
`;

function makeEnv(search, opts = {}) {
    global.window = {
        location: { search, pathname: '/concierge' },
        __lamAvatarConfig: { modelUrl: `/avatar/${opts.avatarId ?? 'uika-full133-skin'}.zip` },
        localStorage: { getItem: () => null },
    };
    global.performance = { now: () => Date.now() };
    global.requestAnimationFrame = (f) => setTimeout(() => f(0), 0);
    global.navigator = { userAgent: 'test' };
}

/** 必要なだけの偽 WebGL2 context */
function makeGl(opts = {}) {
    let id = 1;
    const calls = { drawArrays: 0, framebufferTexture2D: 0, uniform1fv: 0 };
    return {
        calls,
        FRAMEBUFFER: 1, COLOR_ATTACHMENT0: 2, TEXTURE_2D: 3, FRAMEBUFFER_COMPLETE: 0x8cd5,
        VERTEX_SHADER: 10, FRAGMENT_SHADER: 11, COMPILE_STATUS: 12, LINK_STATUS: 13,
        FRAMEBUFFER_BINDING: 20, VIEWPORT: 21, CURRENT_PROGRAM: 22, VERTEX_ARRAY_BINDING: 23,
        SCISSOR_TEST: 24, DEPTH_TEST: 25, BLEND: 26, TRIANGLES: 27, TEXTURE0: 100, TEXTURE1: 101,
        createVertexArray: () => ({ vao: id++ }),
        bindVertexArray: () => {},
        deleteVertexArray: () => {},
        createShader: () => ({ sh: id++ }),
        shaderSource: () => {}, compileShader: () => {},
        getShaderParameter: () => opts.compileFails !== true,
        getShaderInfoLog: () => 'compile error',
        deleteShader: () => {},
        createProgram: () => ({ prog: id++ }),
        attachShader: () => {}, linkProgram: () => {},
        getProgramParameter: () => true, getProgramInfoLog: () => '', deleteProgram: () => {},
        getUniformLocation: (p, n) => ({ loc: n }),
        createFramebuffer: () => ({ fbo: id++ }),
        bindFramebuffer: () => {},
        framebufferTexture2D: () => { calls.framebufferTexture2D++; },
        checkFramebufferStatus: () => (opts.fbIncomplete ? 0x8cd6 : 0x8cd5),
        deleteFramebuffer: () => {},
        getParameter: (p) => (p === 21 ? new Int32Array([0, 0, 800, 600]) : null),
        viewport: () => {}, enable: () => {}, disable: () => {},
        useProgram: () => {}, activeTexture: () => {}, bindTexture: () => {},
        uniform1i: () => {}, uniform1fv: () => { calls.uniform1fv++; },
        drawArrays: () => { calls.drawArrays++; },
    };
}

function makeTex(w, h, tag) {
    const t = {
        image: { data: new Uint32Array(8), width: w, height: h },
        format: 'RGBAIntegerFormat', type: 'UnsignedIntType',
        internalFormat: 'RGBA32UI', minFilter: 1, magFilter: 1, wrapS: 1, wrapT: 1,
        needsUpdate: false, tag,
    };
    t.constructor = function (data, width, height, format, type) {
        return { image: { data, width, height }, format, type, tag: tag + ':clone' };
    };
    return t;
}

function makeRenderer(opts = {}) {
    const glTextures = new Map();
    const canonical = makeTex(4096, 1024, 'canonical');
    const basis = makeTex(4096, 2048, 'basis');
    const dict = {};
    for (let k = 0; k < BS; k++) dict['bs' + k] = k;
    const bsWeight = {};
    for (let k = 0; k < BS; k++) bsWeight['bs' + k] = 0;
    const material = {
        vertexShader: opts.shader !== undefined ? opts.shader : REAL_SHADER,
        uniforms: {
            bsCount: { value: BS },
            centersColorsTexture: { value: canonical },
        },
        uniformsNeedUpdate: false, needsUpdate: false,
    };
    const splatMesh = {
        material, bsWeight, morphTargetDictionary: dict,
        getSplatCount: () => opts.splatCount ?? FULL133,
        splatDataTextures: {
            centerColors: { texture: canonical },
            flameModel: { texture: basis },
        },
    };
    let n = 1;
    const props = {
        get: (t) => {
            if (!glTextures.has(t)) glTextures.set(t, { __webglTexture: { gl: n++, tag: t.tag } });
            return glTextures.get(t);
        },
    };
    return {
        viewer: {
            splatMesh, setSkinAttibutes: true,
            renderer: {
                getContext: () => opts.gl ?? makeGl(opts),
                properties: props,
                initTexture: () => {},
                resetState: () => {},
            },
        },
    };
}

function loadMod() {
    delete require.cache[require.resolve('./.full133-predeform.cjs')];
    return require('./.full133-predeform.cjs');
}

(async () => {
    makeEnv('');
    const m = loadMod();

    // ================= 1. shader patch =================
    const { patched, removed } = m.stripMorphLoop(REAL_SHADER);
    ok(removed === true, '★ morph loop を検出して外せる');
    ok(patched.indexOf('for(int i = 0; i < bsCount; ++i)') < 0,
       '★ main shader から 51 morph loop が消えている');
    ok(patched.indexOf('splatCenter = splatCenter + weight * uintBitsToFloat(sampledBSPos);') < 0,
       '★ loop 本体の加算も残っていない');
    ok(patched.indexOf('uvec3 sampledCenter = texture(centersColorsTexture') >= 0,
       '★ center の読み出しは残す (uniform 差し替えで deformed を読む)');
    ok(patched.indexOf('aMX * skinVertex * aW.x') >= 0,
       '★ aligned 4-influence skinning は壊さない');
    ok(patched.indexOf('uint(bsCount)') < 0 && patched.indexOf('bsCount') >= 0,
       'bsCount は 0 に潰さず残す (texture layout にも使われるため)');
    const twice = m.stripMorphLoop(patched);
    ok(twice.removed === false && twice.patched === patched,
       '2 回目は何もしない (多重パッチにならない)');
    const none = m.stripMorphLoop('void main() {}');
    ok(none.removed === false, 'anchor が無ければ false を返す');

    // ================= 2. 固定 weight での数値一致 =================
    // legacy main shader の式を独立に書いたもの。
    // splatCenter = canonical; for k: splatCenter += w[k] * delta[k][i]
    const legacy = (i, canonical, basis, weights) => {
        let c = [canonical[0], canonical[1], canonical[2]];
        for (let k = 0; k < weights.length; k++) {
            const d = basis(k, i);
            c = [c[0] + weights[k] * d[0], c[1] + weights[k] * d[1], c[2] + weights[k] * d[2]];
        }
        return c;
    };
    // 再現可能な擬似データ
    const h = (a, b) => {
        let x = (a * 374761393 + b * 668265263) >>> 0;
        x = ((x ^ (x >>> 13)) * 1274126177) >>> 0;
        return ((x >>> 8) / 16777216) * 2 - 1;
    };
    const basisFn = (k, i) => [h(i, k), h(i + 7919, k), h(i + 15485863, k)];
    const canonicalFn = (i) => [h(i, 1000), h(i, 2000), h(i, 3000)];
    const weights = new Float32Array(BS);
    for (let k = 0; k < BS; k++) weights[k] = k === 24 ? 0.237 : (k % 5 === 0 ? 0.013 * k : 0);

    // eye / mouth / nose / hairline / random を固定 index で代表させる
    const samples = { eye: 1234, mouth: 66770, nose: 42000, hairline: 120000, random: 98765 };
    let maxDiff = 0;
    for (const [label, i] of Object.entries(samples)) {
        const c = canonicalFn(i);
        const a = legacy(i, c, basisFn, weights);
        const b = m.deformCenterReference(i, c, basisFn, weights);
        const d = Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
        maxDiff = Math.max(maxDiff, d);
        ok(d === 0, `★ ${label} (index ${i}) で legacy と predeform が一致`, 'diff=' + d);
    }
    ok(maxDiff === 0, '★ 代表 5 点すべてで誤差 0 (float 演算の差すら無い)');

    // weight が全 0 なら canonical と一致する
    const zero = new Float32Array(BS);
    const cz = canonicalFn(555);
    const bz = m.deformCenterReference(555, cz, basisFn, zero);
    ok(bz[0] === cz[0] && bz[1] === cz[1] && bz[2] === cz[2],
       '★ 全 weight 0 なら canonical と完全一致 (累積しない)');

    // ================= 3. gate =================
    makeEnv('', { avatarId: 'meruru' });
    const m3 = loadMod();
    const r3 = makeRenderer({ splatCount: 20018 });
    const before3 = r3.viewer.splatMesh.material.vertexShader;
    const s3 = await m3.installFull133Predeform(r3, 3);
    ok(s3.applied === false && r3.viewer.splatMesh.material.vertexShader === before3,
       '★ FULL133 以外には適用せず shader も触らない', s3.reason);

    makeEnv('');
    const m3b = loadMod();
    const r3b = makeRenderer({ splatCount: 80000 });
    const s3b = await m3b.installFull133Predeform(r3b, 3);
    ok(s3b.applied === false, '★ splatCount が 133541 でなければ適用しない', s3b.reason);

    // ================= 4. 正常系 =================
    makeEnv('');
    const m4 = loadMod();
    const gl4 = makeGl();
    const r4 = makeRenderer({ gl: gl4 });
    const s4 = await m4.installFull133Predeform(r4, 3);
    ok(s4.applied === true, '★ FULL133 で適用される', s4.reason);
    ok(s4.framebufferComplete === true, 'framebuffer が complete');
    ok(s4.morphLoopRemoved === true, '★ main shader の morph loop を外した');
    ok(r4.viewer.splatMesh.material.vertexShader.indexOf('for(int i = 0; i < bsCount') < 0,
       '★ 実際の material.vertexShader からも消えている');
    ok(r4.viewer.splatMesh.material.uniforms.centersColorsTexture.value.tag === 'canonical:clone',
       '★ uniform が deformed texture へ差し替わっている',
       r4.viewer.splatMesh.material.uniforms.centersColorsTexture.value.tag);
    ok(r4.viewer.splatMesh.splatDataTextures.centerColors.texture.tag === 'canonical',
       '★ canonical texture は差し替えていない (source of truth を保持)');
    ok(s4.passes === 1, '★ shader 切り替え前に 1 回 prepass 済み (未初期化を描かない)',
       'passes=' + s4.passes);
    ok(s4.textureWidth === 4096 && s4.textureHeight === 1024,
       'texture 寸法を canonical から取っている',
       `${s4.textureWidth}x${s4.textureHeight}`);
    ok(s4.bsCount === BS, 'bsCount を uniform から取っている');

    // ---- dirty 判定 ----
    const d0 = gl4.calls.drawArrays;
    m4.updateFull133Predeform(r4);
    ok(gl4.calls.drawArrays === d0 && s4.skipped === 1,
       '★ expression が変わらなければ GPU を触らない', 'skipped=' + s4.skipped);
    r4.viewer.splatMesh.bsWeight['bs24'] = 0.5;
    m4.updateFull133Predeform(r4);
    ok(gl4.calls.drawArrays === d0 + 1 && s4.passes === 2,
       '★ expression が変わったら 1 回だけ prepass', 'passes=' + s4.passes);
    m4.updateFull133Predeform(r4);
    m4.updateFull133Predeform(r4);
    ok(gl4.calls.drawArrays === d0 + 1 && s4.passes === 2,
       '★ 同じ expression が続けば再実行しない');
    ok(s4.fallbackCount === 0 && s4.lastError === null, '例外なし');

    // ================= 5. 失敗時は legacy のまま =================
    makeEnv('');
    const m5 = loadMod();
    const r5 = makeRenderer({ gl: makeGl({ fbIncomplete: true }) });
    const before5 = r5.viewer.splatMesh.material.vertexShader;
    const s5 = await m5.installFull133Predeform(r5, 3);
    ok(s5.applied === false && s5.framebufferComplete === false
        && r5.viewer.splatMesh.material.vertexShader === before5
        && r5.viewer.splatMesh.material.uniforms.centersColorsTexture.value.tag === 'canonical',
       '★ framebuffer 不完全なら shader も uniform も触らない (二重変形にしない)', s5.reason);

    makeEnv('');
    const m5b = loadMod();
    const r5b = makeRenderer({ gl: makeGl({ compileFails: true }) });
    const before5b = r5b.viewer.splatMesh.material.vertexShader;
    const s5b = await m5b.installFull133Predeform(r5b, 3);
    ok(s5b.applied === false && r5b.viewer.splatMesh.material.vertexShader === before5b,
       '★ prepass shader の compile 失敗でも legacy のまま', s5b.reason);

    makeEnv('');
    const m5c = loadMod();
    const r5c = makeRenderer({ shader: 'void main() { /* morph loop が無い */ }' });
    const s5c = await m5c.installFull133Predeform(r5c, 3);
    ok(s5c.applied === false
        && r5c.viewer.splatMesh.material.uniforms.centersColorsTexture.value.tag === 'canonical',
       '★ morph loop が見つからなければ uniform も差し替えない', s5c.reason);

    console.log(failures === 0 ? '\n=== 全テスト PASS ===' : `\n=== ${failures} 件 FAIL ===`);
    process.exit(failures === 0 ? 0 : 1);
})();
