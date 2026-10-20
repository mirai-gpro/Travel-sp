/**
 * FULL133 GPU Pre-Deformation runtime
 *
 * ===================================================================
 * 1. 直している構造上の無駄 (実ソースで確認済み)
 * ===================================================================
 * `SplatGeometry.build()` (`SplatGeometry.js:12-37`) は
 *
 *     baseGeometry: quad 4 頂点 (index [0,1,2, 0,2,3])
 *     splatIndex  : InstancedBufferAttribute (1 Gaussian = 1 instance)
 *
 * の **InstancedBufferGeometry**。したがって vertex shader は
 * **1 Gaussian につき 4 回** (quad の 4 頂点) 実行される。
 *
 * その vertex shader (`SplatMaterial.js:213-243`) は毎回
 *
 *     splatCenter = uintBitsToFloat(texture(centersColorsTexture, ...).gba);
 *     for (int i = 0; i < bsCount; ++i) {
 *         sampledBSPos = texture(flameModelTexture, getBSFlameDataUV(i, ...)).rgb;
 *         weight       = uintBitsToFloat(texture(boneTexture, ...))[i % 4];
 *         splatCenter += weight * uintBitsToFloat(sampledBSPos);
 *     }
 *
 * を評価する。同じ Gaussian の 4 頂点はすべて同じ `splatIndex` (instanced
 * attribute) を持つので、**まったく同じ 51 回の加算を 4 回繰り返している**。
 *
 *     FULL133 : 133,541 × 4 × 51 ≈ 27.2 M morph iteration / frame
 *     LAM 20K :  20,018 × 4 × 51 ≈  4.08 M                  (同一設計で 6.67 倍)
 *
 * ===================================================================
 * 2. 新方式
 * ===================================================================
 * 51 blendshape の合成を main shader から分離し、**1 Gaussian 1 回**だけ
 * GPU で計算して source-order の texture に置く。
 *
 *     GPU prepass (expression が変わったときだけ)
 *         deformedCenter[i] = canonicalCenter[i] + Σ_k w[k] * morphDelta[k][i]
 *     main shader
 *         deformedCentersColorsTexture[splatIndex] を 1 回読む → aligned 4-bone LBS
 *
 *     morph 計算回数: 4 × N × 51  →  1 × N × 51
 *
 * 数式は現行とまったく同じ。表情モデルも morph delta も weight も変えない。
 *
 * ===================================================================
 * 3. texture layout (実ソースから)
 * ===================================================================
 * - `centersColorsTexture` : RGBA32UI / `computeDataTextureSize(4, 4)`
 *   (`SplatMesh.js:660-664, 704-712`)。texel index = splat index。
 *   成分は `SplatMesh.js:1388-1398` のとおり
 *       r = rgbaArrayToInteger(color)
 *       g = uintEncodedFloat(center.x)
 *       b = uintEncodedFloat(center.y)
 *       a = uintEncodedFloat(center.z)
 *   shader 側も `.r` を色、`.gba` を center として読む。この意味は変えない。
 *
 * - `flameModelTexture` : RGBA32UI / 4096x2048 (`SplatMesh.js:1057-1100`)。
 *   `getBSFlameDataUV(k, 1, 0, size)` (`SplatMaterial.js:168-174`) が示すとおり
 *   blendshape k・Gaussian i の delta は flat index `i + gaussianSplatCount * k`。
 *   `i + gaussianSplatCount * bsCount` には canonical shaped mesh が入る。
 *
 * - `internal` は shader 内の定数 1 (`SplatMaterial.js:125`)。
 *   `getRealIndex(x, 1) === x` なので `splatIndex` がそのまま source Gaussian
 *   index になる。sort 順は instance の並びで表現され、attribute の **値** は
 *   source index のまま。よって predeform texture を source index で引けばよい
 *   (aligned skin texture と同じ思想。CPU で並べ替えない)。
 *
 * ===================================================================
 * 4. weights の正本
 * ===================================================================
 * 新しい ARKit 変換も新しい 51 配列も作らない。
 * `SplatMesh.updateBoneMatrixTexture()` (`SplatMesh.js:980-1013`) が
 *
 *     for (const key in this.bsWeight)
 *         baseData['boneMatrix'][ morphTargetDictionary[key] + bonesNum*16 ]
 *             = uintEncodedFloat(this.bsWeight[key]);
 *
 * として shader へ渡しているものと**同一の値・同一の順序**を使う。
 * prepass へは 51 個の float uniform として送る (指示書 §13 の許容範囲)。
 * GPU の boneTexture を読まないのは、`needsUpdate` の反映が three.js の
 * 描画時なので prepass の時点では 1 フレーム古くなり得るため。
 *
 * ===================================================================
 * 5. 介入範囲
 * ===================================================================
 * - 既存 renderer の WebGL2 context と既存 three.js instance だけを使う。
 *   three.js を新規 import しない (`Multiple instances of Three.js` を増やさない)。
 *   出力 texture は canonical texture の `constructor` から作る。
 * - canonical texture には**書き込まない**。別 texture を render target にする。
 * - FULL133 (`uika-full133-skin` / splatCount 133541) 以外には一切適用しない。
 * - 初期化に失敗したら main shader には一切手を付けず legacy のまま返す。
 */

import { getAvatarIdForDiag } from './poc/render-perf';

const FULL133_AVATAR_ID = 'uika-full133-skin';
const FULL133_SPLAT_COUNT = 133541;

/** main shader の morph accumulation ループの開始行 (`SplatMaterial.js:222`)。 */
const MORPH_LOOP_ANCHOR = 'for(int i = 0; i < bsCount; ++i) {';

/** 除去したことが後から判るように残す印。 */
const MORPH_LOOP_REMOVED = `            // [FULL133 predeform] 51 blendshape の合成は GPU prepass で
            // 1 Gaussian 1 回だけ済ませ、centersColorsTexture を
            // deformed center texture に差し替えてある。
            // ここで 4 頂点ぶん繰り返していた morph loop は除去した。`;

export interface Full133PredeformStats {
    enabled: boolean;
    applied: boolean;
    reason: string;
    avatarId: string;
    splatCount: number;
    bsCount: number;
    /** deformed center texture の寸法 */
    textureWidth: number;
    textureHeight: number;
    /** prepass で実際に処理する行数。Gaussian が収まる最小行数だけを走らせる。 */
    activeRows: number;
    /** prepass を実行した回数 (= expression が変化した回数) */
    passes: number;
    /** expression が変わらずスキップした回数 */
    skipped: number;
    /** main shader から morph loop を外せたか */
    morphLoopRemoved: boolean;
    framebufferComplete: boolean;
    fallbackCount: number;
    lastError: string | null;
}

/**
 * prepass の数式の TS 参照実装。**実行時には使わない** (テスト専用)。
 * GLSL 側と 1 対 1 に対応させてあり、legacy main shader の式と同値であることを
 * 固定するために `tools/poc-tests` から呼ぶ。
 *
 * @param i            source Gaussian index
 * @param canonical    canonical center (x, y, z)
 * @param basis        `(k, i) => [dx, dy, dz]` — flameModelTexture の中身
 * @param weights      51 要素。`morphTargetDictionary` の順
 */
export function deformCenterReference(
    i: number,
    canonical: readonly [number, number, number],
    basis: (k: number, i: number) => readonly [number, number, number],
    weights: ArrayLike<number>,
): [number, number, number] {
    let x = canonical[0];
    let y = canonical[1];
    let z = canonical[2];
    for (let k = 0; k < weights.length; k++) {
        const d = basis(k, i);
        const w = weights[k];
        x += w * d[0];
        y += w * d[1];
        z += w * d[2];
    }
    return [x, y, z];
}

/**
 * main shader から morph accumulation ループだけを取り除く。
 * 中括弧を数えて対応する `}` まで削るので、ループ本体の中身には依存しない。
 * `bsCount = 0` のような雑な止め方はしない (bsCount は他でも使われる)。
 */
export function stripMorphLoop(src: string): { patched: string; removed: boolean } {
    const start = src.indexOf(MORPH_LOOP_ANCHOR);
    if (start < 0) return { patched: src, removed: false };
    let depth = 0;
    let i = src.indexOf('{', start);
    if (i < 0) return { patched: src, removed: false };
    for (; i < src.length; i++) {
        const c = src[i];
        if (c === '{') depth++;
        else if (c === '}') {
            depth--;
            if (depth === 0) {
                const patched = src.slice(0, start) + MORPH_LOOP_REMOVED + src.slice(i + 1);
                return { patched, removed: true };
            }
        }
    }
    return { patched: src, removed: false };
}

// ===================================================================
// GLSL
// ===================================================================

/** 画面全体を覆う三角形を gl_VertexID から作る。attribute は使わない。 */
const PREPASS_VS = `#version 300 es
precision highp float;
void main() {
    vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

/**
 * 1 texel = 1 Gaussian。51 blendshape をここで 1 回だけ合成する。
 * 成分の意味は `SplatMesh.updateCenterColorsPaddedData` と同じ
 * (r = color, gba = center xyz)。
 */
const PREPASS_FS = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;

uniform usampler2D canonicalTex;
uniform usampler2D basisTex;
uniform int canonicalWidth;
uniform int basisWidth;
uniform int splatCount;
uniform int bsCount;
uniform float weights[MAX_BS];

out uvec4 outCenterColor;

void main() {
    ivec2 tc = ivec2(gl_FragCoord.xy);
    uvec4 cc = texelFetch(canonicalTex, tc, 0);
    int i = tc.y * canonicalWidth + tc.x;
    if (i >= splatCount) {
        // 最終行の padding texel。viewport で行数は絞ってあるので、ここに来るのは
        // 最終行の余りだけ。canonical をそのまま通す (未初期化を描かない)。
        outCenterColor = cc;
        return;
    }
    vec3 center = uintBitsToFloat(cc.gba);
    for (int k = 0; k < bsCount; ++k) {
        float w = weights[k];
        if (w != 0.0) {
            int fi = i + splatCount * k;
            ivec2 ftc = ivec2(fi % basisWidth, fi / basisWidth);
            center += w * uintBitsToFloat(texelFetch(basisTex, ftc, 0).rgb);
        }
    }
    outCenterColor = uvec4(cc.r,
                           floatBitsToUint(center.x),
                           floatBitsToUint(center.y),
                           floatBitsToUint(center.z));
}`;

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
    const sh = gl.createShader(type);
    if (!sh) throw new Error('createShader failed');
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(sh);
        gl.deleteShader(sh);
        throw new Error('shader compile failed: ' + log);
    }
    return sh;
}

function link(gl: WebGL2RenderingContext, vsSrc: string, fsSrc: string): WebGLProgram {
    const vs = compile(gl, gl.VERTEX_SHADER, vsSrc);
    const fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc);
    const prog = gl.createProgram();
    if (!prog) throw new Error('createProgram failed');
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        const log = gl.getProgramInfoLog(prog);
        gl.deleteProgram(prog);
        throw new Error('program link failed: ' + log);
    }
    return prog;
}

// ===================================================================
// install
// ===================================================================

interface Ctx {
    gl: WebGL2RenderingContext;
    prog: WebGLProgram;
    fbo: WebGLFramebuffer;
    vao: WebGLVertexArrayObject | null;
    deformedTex: any;              // three.js DataTexture (既存 three instance 由来)
    canonicalGl: WebGLTexture;
    basisGl: WebGLTexture;
    width: number;
    height: number;
    /** 有効 Gaussian が収まる行数。prepass の viewport 高さ。 */
    activeRows: number;
    splatCount: number;
    bsCount: number;
    basisWidth: number;
    loc: Record<string, WebGLUniformLocation | null>;
    weights: Float32Array;         // 現在値。1 回だけ確保する
    prevWeights: Float32Array;     // 直前値。1 回だけ確保する
    names: string[];               // morphTargetDictionary 順の名前
}

export async function installFull133Predeform(
    renderer: any, maxTries = 900,
): Promise<Full133PredeformStats> {
    const stats: Full133PredeformStats = {
        enabled: true, applied: false, reason: '',
        avatarId: '', splatCount: 0, bsCount: 0,
        textureWidth: 0, textureHeight: 0, activeRows: 0,
        passes: 0, skipped: 0,
        morphLoopRemoved: false, framebufferComplete: false,
        fallbackCount: 0, lastError: null,
    };
    (window as any).__full133Predeform = stats;

    return await new Promise<Full133PredeformStats>((resolve) => {
        let tries = 0;
        const tick = () => {
            if (ready(renderer) || ++tries >= maxTries) {
                try {
                    apply(renderer, stats);
                } catch (e: any) {
                    stats.applied = false;
                    stats.lastError = String(e?.message ?? e);
                    stats.reason = 'predeform の初期化で例外。legacy のまま: ' + stats.lastError;
                    console.error('[FULL133 predeform] ' + stats.reason, e);
                }
                resolve(stats);
                return;
            }
            requestAnimationFrame(tick);
        };
        tick();
    });
}

function ready(renderer: any): boolean {
    const v = renderer?.viewer;
    const sm = v?.splatMesh;
    return !!sm?.splatDataTextures?.['centerColors']?.texture
        && !!sm?.splatDataTextures?.['flameModel']?.texture
        && !!sm?.material?.uniforms?.bsCount
        && Number(sm?.material?.uniforms?.bsCount?.value ?? 0) > 0
        && typeof sm?.material?.vertexShader === 'string'
        && (sm?.getSplatCount?.() ?? 0) > 0
        && v?.setSkinAttibutes === true
        && !!sm?.bsWeight
        && !!sm?.morphTargetDictionary;
}

function apply(renderer: any, stats: Full133PredeformStats): void {
    const v = renderer?.viewer;
    const sm = v?.splatMesh;
    stats.avatarId = getAvatarIdForDiag();
    stats.splatCount = Number(sm?.getSplatCount?.() ?? 0);

    // ---- FULL133 以外には絶対に適用しない (指示書 §28) ----
    if (stats.avatarId !== FULL133_AVATAR_ID) {
        stats.reason = `FULL133 専用。avatarId=${stats.avatarId} のため適用しない`;
        return;
    }
    if (stats.splatCount !== FULL133_SPLAT_COUNT) {
        stats.reason = `FULL133 専用。splatCount=${stats.splatCount} `
            + `(期待 ${FULL133_SPLAT_COUNT}) のため適用しない`;
        return;
    }
    if (!ready(renderer)) {
        stats.reason = 'canonical / flameModel / skin / bsCount が揃わないまま打ち切った';
        return;
    }
    if (v.__full133PredeformHooked) {
        stats.reason = 'すでに適用済み';
        return;
    }

    const material = sm.material;
    const gl: WebGL2RenderingContext | null = v.renderer?.getContext?.() ?? null;
    if (!gl || typeof (gl as any).createVertexArray !== 'function') {
        stats.reason = 'WebGL2 context が取れない';
        return;
    }

    const canonicalTex = sm.splatDataTextures['centerColors'].texture;
    const basisTex = sm.splatDataTextures['flameModel'].texture;
    const bsCount = Number(material.uniforms.bsCount.value);
    stats.bsCount = bsCount;

    const props = v.renderer?.properties;
    // three.js が canonical / basis を GPU へ上げ終わっていないと __webglTexture が無い。
    v.renderer?.initTexture?.(canonicalTex);
    v.renderer?.initTexture?.(basisTex);
    const canonicalGl: WebGLTexture | undefined = props?.get?.(canonicalTex)?.__webglTexture;
    const basisGl: WebGLTexture | undefined = props?.get?.(basisTex)?.__webglTexture;
    if (!canonicalGl || !basisGl) {
        stats.reason = 'canonical / flameModel の WebGLTexture が取得できない';
        return;
    }

    const width = Number(canonicalTex.image?.width ?? 0);
    const height = Number(canonicalTex.image?.height ?? 0);
    const basisWidth = Number(basisTex.image?.width ?? 0);
    if (width <= 0 || height <= 0 || basisWidth <= 0) {
        stats.reason = 'texture の寸法が取れない';
        return;
    }
    stats.textureWidth = width;
    stats.textureHeight = height;
    stats.activeRows = Math.ceil(stats.splatCount / width);

    // ---- 出力 texture。canonical とは別オブジェクトにする (指示書 §8) ----
    // three.js を新規 import せず、canonical texture の constructor を使う。
    // データ配列は canonical のものを**共有**する: 初期内容が canonical と
    // 同一になり、かつ O(133K) の新規確保をしない (指示書 §13)。
    const Ctor = canonicalTex.constructor as any;
    const img = canonicalTex.image;
    const deformedTex = new Ctor(img.data, width, height, canonicalTex.format, canonicalTex.type);
    deformedTex.internalFormat = canonicalTex.internalFormat;
    deformedTex.minFilter = canonicalTex.minFilter;
    deformedTex.magFilter = canonicalTex.magFilter;
    deformedTex.wrapS = canonicalTex.wrapS;
    deformedTex.wrapT = canonicalTex.wrapT;
    deformedTex.generateMipmaps = false;
    deformedTex.needsUpdate = true;
    v.renderer?.initTexture?.(deformedTex);
    const deformedGl: WebGLTexture | undefined = props?.get?.(deformedTex)?.__webglTexture;
    if (!deformedGl || deformedGl === canonicalGl) {
        stats.reason = deformedGl
            ? 'deformed texture が canonical と同じ WebGLTexture になった (source 共有)'
            : 'deformed texture の WebGLTexture が取得できない';
        return;
    }

    // ---- FBO ----
    const prevFbo = gl.getParameter(gl.FRAMEBUFFER_BINDING);
    const fbo = gl.createFramebuffer();
    if (!fbo) { stats.reason = 'createFramebuffer failed'; return; }
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, deformedGl, 0);
    const fbStatus = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, prevFbo);
    stats.framebufferComplete = fbStatus === gl.FRAMEBUFFER_COMPLETE;
    if (!stats.framebufferComplete) {
        gl.deleteFramebuffer(fbo);
        stats.reason = `framebuffer が不完全 (status=0x${fbStatus.toString(16)})`;
        return;
    }

    // ---- program ----
    let prog: WebGLProgram;
    try {
        prog = link(gl, PREPASS_VS, PREPASS_FS.replace('MAX_BS', String(bsCount)));
    } catch (e: any) {
        gl.deleteFramebuffer(fbo);
        stats.reason = 'prepass program のビルドに失敗: ' + String(e?.message ?? e);
        return;
    }

    const names = orderedMorphNames(sm, bsCount);
    const ctx: Ctx = {
        gl, prog, fbo,
        vao: gl.createVertexArray(),
        deformedTex, canonicalGl, basisGl,
        width, height,
        activeRows: Math.ceil(stats.splatCount / width),
        splatCount: stats.splatCount, bsCount, basisWidth,
        loc: {
            canonicalTex: gl.getUniformLocation(prog, 'canonicalTex'),
            basisTex: gl.getUniformLocation(prog, 'basisTex'),
            canonicalWidth: gl.getUniformLocation(prog, 'canonicalWidth'),
            basisWidth: gl.getUniformLocation(prog, 'basisWidth'),
            splatCount: gl.getUniformLocation(prog, 'splatCount'),
            bsCount: gl.getUniformLocation(prog, 'bsCount'),
            weights: gl.getUniformLocation(prog, 'weights[0]'),
        },
        weights: new Float32Array(bsCount),
        prevWeights: new Float32Array(bsCount),
        names,
    };

    // ---- main shader から morph loop を外す ----
    const { patched, removed } = stripMorphLoop(material.vertexShader);
    if (!removed) {
        gl.deleteFramebuffer(fbo);
        gl.deleteProgram(prog);
        stats.reason = 'main shader の morph loop が見つからない (legacy のまま)';
        return;
    }

    // ---- 未初期化 texture を 1 フレームでも描かない (指示書 §20) ----
    // main shader を切り替える **前に** 現在の weights で 1 回走らせる。
    readWeights(sm, ctx);
    runPass(ctx, renderer, stats);
    if (!stats.applied) {
        gl.deleteFramebuffer(fbo);
        gl.deleteProgram(prog);
        if (ctx.vao) gl.deleteVertexArray(ctx.vao);
        return;
    }

    material.vertexShader = patched;
    material.uniforms.centersColorsTexture.value = deformedTex;
    material.uniformsNeedUpdate = true;
    material.needsUpdate = true;
    stats.morphLoopRemoved = true;
    v.__full133PredeformHooked = true;
    v.__full133PredeformCtx = ctx;

    stats.reason = '51 blendshape を GPU prepass へ移し、main shader の morph loop を除去した';
    (window as any).__full133PredeformForce = () => {
        ctx.prevWeights.fill(NaN);
        return 'ok';
    };
}

/** `morphTargetDictionary` のインデックス順に名前を並べる (weights の正本順)。 */
function orderedMorphNames(sm: any, bsCount: number): string[] {
    const dict = sm.morphTargetDictionary ?? {};
    const names: string[] = new Array(bsCount).fill('');
    for (const key of Object.keys(dict)) {
        const idx = Number(dict[key]);
        if (Number.isInteger(idx) && idx >= 0 && idx < bsCount) names[idx] = key;
    }
    return names;
}

/** 現在の 51 weights を読む。TypedArray は使い回す (指示書 §11)。 */
function readWeights(sm: any, ctx: Ctx): void {
    const bs = sm.bsWeight ?? {};
    for (let k = 0; k < ctx.bsCount; k++) {
        const name = ctx.names[k];
        const val = name ? bs[name] : undefined;
        ctx.weights[k] = typeof val === 'number' ? val : 0;
    }
}

function weightsChanged(ctx: Ctx): boolean {
    for (let k = 0; k < ctx.bsCount; k++) {
        if (ctx.weights[k] !== ctx.prevWeights[k]) return true;
    }
    return false;
}

/** GPU pre-deformation pass を 1 回実行する。 */
function runPass(ctx: Ctx, renderer: any, stats: Full133PredeformStats): void {
    const gl = ctx.gl;
    const prevFbo = gl.getParameter(gl.FRAMEBUFFER_BINDING);
    const prevVp = gl.getParameter(gl.VIEWPORT) as Int32Array;
    const prevProg = gl.getParameter(gl.CURRENT_PROGRAM);
    const prevVao = gl.getParameter(gl.VERTEX_ARRAY_BINDING);
    const scissor = gl.getParameter(gl.SCISSOR_TEST);
    const depth = gl.getParameter(gl.DEPTH_TEST);
    const blend = gl.getParameter(gl.BLEND);
    try {
        gl.bindFramebuffer(gl.FRAMEBUFFER, ctx.fbo);
        // texture 全体 (4096x1024 = 4.19M texel) を走らせない。
        // Gaussian は 133,541 個しか無いので、収まる最小行数だけを処理する。
        //     activeRows = ceil(133541 / 4096) = 33
        //     4096 x 33 = 135,168 fragment  (全面の約 1/31)
        // 33 行目以降の texel は main shader から一度も参照されないので、
        // 初回 upload 時の canonical 内容のまま放置してよい。
        // texture の寸法そのものは変えない (`centersColorsTextureSize` も不変)。
        gl.viewport(0, 0, ctx.width, ctx.activeRows);
        gl.disable(gl.SCISSOR_TEST);
        gl.disable(gl.DEPTH_TEST);
        gl.disable(gl.BLEND);
        gl.bindVertexArray(ctx.vao);
        gl.useProgram(ctx.prog);

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, ctx.canonicalGl);
        gl.uniform1i(ctx.loc.canonicalTex!, 0);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, ctx.basisGl);
        gl.uniform1i(ctx.loc.basisTex!, 1);

        gl.uniform1i(ctx.loc.canonicalWidth!, ctx.width);
        gl.uniform1i(ctx.loc.basisWidth!, ctx.basisWidth);
        gl.uniform1i(ctx.loc.splatCount!, ctx.splatCount);
        gl.uniform1i(ctx.loc.bsCount!, ctx.bsCount);
        gl.uniform1fv(ctx.loc.weights!, ctx.weights);

        gl.drawArrays(gl.TRIANGLES, 0, 3);

        ctx.prevWeights.set(ctx.weights);
        stats.passes++;
        stats.applied = true;
    } catch (e: any) {
        stats.fallbackCount++;
        stats.lastError = String(e?.message ?? e);
        console.error('[FULL133 predeform] prepass で例外:', e);
    } finally {
        gl.bindVertexArray(prevVao);
        gl.useProgram(prevProg);
        gl.bindFramebuffer(gl.FRAMEBUFFER, prevFbo);
        gl.viewport(prevVp[0], prevVp[1], prevVp[2], prevVp[3]);
        if (scissor) gl.enable(gl.SCISSOR_TEST);
        if (depth) gl.enable(gl.DEPTH_TEST);
        if (blend) gl.enable(gl.BLEND);
        // three.js の内部ステートキャッシュと食い違わないようにする。
        renderer?.viewer?.renderer?.resetState?.();
    }
}

/**
 * steady-state から毎フレーム呼ぶ。expression が変化したときだけ prepass する。
 * 変化が無ければ GPU は一切触らない。
 */
export function updateFull133Predeform(renderer: any): void {
    const v = renderer?.viewer;
    const ctx: Ctx | undefined = v?.__full133PredeformCtx;
    const stats: Full133PredeformStats | undefined = (window as any).__full133Predeform;
    if (!ctx || !stats || !stats.applied) return;
    try {
        readWeights(v.splatMesh, ctx);
        if (!weightsChanged(ctx)) { stats.skipped++; return; }
        runPass(ctx, renderer, stats);
    } catch (e: any) {
        stats.fallbackCount++;
        stats.lastError = String(e?.message ?? e);
    }
}
