// src/scripts/chat/poc/multibone-skinning.ts
//
// PoC 限定。`?skinMode=multi` のときだけ、splat の vertex shader を
// head ボーン 1 本駆動から **4 influence の LBS** へ差し替える。
//
// 【背景 (実測)】
// 出荷版 `gaussian-splat-renderer-for-lam` の splat vertex shader は、
// `skinIndex` / `skinWeight` を attribute として GPU へ渡しているのに、
// 最終 position には使っていない:
//
//     if (headBoneIndex >= 0.0) {
//         mat4 boneMat = getBoneMatrix0( headBoneIndex );
//         skinned += boneMat * skinVertex * 1.0;
//     }
//     // skinned += boneMatX * skinVertex * skinWeight.x;   <- 4 行ともコメントアウト
//     ...
//
// `headBoneIndex` の実測値は 110 (= `head`)。通常 LAM アバターも B80 も、
// 全 splat がこの 1 本で動いている。
//
// 【skinVertex が何か (shader のコードで確定させたもの、推測ではない)】
//
//     splatCenter = centersColorsTexture の値            // = offset.ply.xyz + POSITION
//     splatCenter += Σ (bsWeight * flameModelTexture)    // = Σ w_k * morph_k
//     transformed  = splatCenter
//     skinVertex   = vec4(transformed, 1.0)
//
// つまり `skinVertex` は **mesh 頂点ではなく Gaussian の中心そのもの** で、
// offset.ply と morph を既に含んでいる。したがって指示書 §10 が言う
// 「V だけ skin して O を素のまま足す」状態にはなっておらず、
// Stage A は中心に対する素直な 4-weight LBS でよい。
//
// 【Runtime への介入範囲】
// `material.vertexShader` の文字列を差し替えて `needsUpdate` を立てるだけ。
// uniform / attribute / bone texture / asset には触らない。
// `?skinMode=multi` が無ければ **何もしない** (既定は出荷版のまま)。

// `three` は **`aligned` のときだけ** 動的 import する。
// static import にすると、既定 (`?skinMode` なし = head) でも renderer が束ねている
// three とは別の three がバンドルへ入り、
// "WARNING: Multiple instances of Three.js being imported." を出したうえに
// 本番利用者に不要な three をダウンロード・パースさせてしまう。
// PoC のために本番経路へコストを足さないため遅延させる。

import { loadAvatarConfig } from '../../../config/avatar-config';
import { getAvatarIdForDiag } from './render-perf';

export type SkinMode = 'head' | 'multi' | 'aligned';

// ---------------------------------------------------------------------------
// index domain の実測 (shader と renderer のコードで確定したもの)
//
//   center:  getDataUV() が `getRealIndex(int(splatIndex), internal)` を使う
//            → **splatIndex attribute の「値」** が source splat を指す
//   skin:    `attribute vec4 skinIndex / skinWeight` を素で読む
//            → **draw slot (instance 番号)** がそのまま index になる
//
//   SplatMesh.updateRenderIndexes(globalIndexes) が毎 sort で
//   `geometry.attributes.splatIndex.set(globalIndexes)` を実行する一方、
//   skinIndex / skinWeight は `setSkinAttibutes === false` のガードで
//   **一度だけ**書かれ、以後並べ替えられない。
//
//   つまり sort 後は
//       center source = splatIndex[i]
//       skin   source = i
//   となり対応が壊れる。`aligned` モードはこれを texture 経由に直して
//   center と同じ splatIndex で skin を引く。
// ---------------------------------------------------------------------------

/** 出荷版 shader の該当ブロック。ここが見つからなければ何もしない。 */
const HEAD_ONLY_BLOCK = `                if (headBoneIndex >= 0.0)
                {
                    mat4 boneMat = getBoneMatrix0( headBoneIndex );
                    skinned += boneMat * skinVertex * 1.0;
                }`;

/** Stage A: 素直な 4 influence LBS。weight 合計が 0 の点だけ head へ退避する。 */
const MULTI_BONE_BLOCK = `                // [PoC multibone] 出荷版の head ボーン 1 本駆動を 4 influence LBS へ置換
                float wSum = skinWeight.x + skinWeight.y + skinWeight.z + skinWeight.w;
                if (wSum > 0.0) {
                    skinned += boneMatX * skinVertex * skinWeight.x;
                    skinned += boneMatY * skinVertex * skinWeight.y;
                    skinned += boneMatZ * skinVertex * skinWeight.z;
                    skinned += boneMatW * skinVertex * skinWeight.w;
                    skinned /= wSum;
                } else if (headBoneIndex >= 0.0) {
                    mat4 boneMat = getBoneMatrix0( headBoneIndex );
                    skinned += boneMat * skinVertex * 1.0;
                }`;

/** center と同じ splatIndex で skin を引く版。 */
const ALIGNED_BLOCK = `                // [PoC aligned] center と同じ splatIndex で JOINTS/WEIGHTS を引く
                ivec2 _skSize = textureSize(skinIndexTexture, 0);
                int _skI = int(splatIndex);
                ivec2 _skUV = ivec2(_skI % _skSize.x, _skI / _skSize.x);
                vec4 aIdx = texelFetch(skinIndexTexture, _skUV, 0);
                vec4 aW   = texelFetch(skinWeightTexture, _skUV, 0);
                mat4 aMX = getBoneMatrix0( aIdx.x );
                mat4 aMY = getBoneMatrix0( aIdx.y );
                mat4 aMZ = getBoneMatrix0( aIdx.z );
                mat4 aMW = getBoneMatrix0( aIdx.w );
                float aSum = aW.x + aW.y + aW.z + aW.w;
                if (aSum > 0.0) {
                    skinned += aMX * skinVertex * aW.x;
                    skinned += aMY * skinVertex * aW.y;
                    skinned += aMZ * skinVertex * aW.z;
                    skinned += aMW * skinVertex * aW.w;
                    skinned /= aSum;
                } else if (headBoneIndex >= 0.0) {
                    mat4 boneMat = getBoneMatrix0( headBoneIndex );
                    skinned += boneMat * skinVertex * 1.0;
                }`;

function parseSkinMode(v: string | null | undefined): SkinMode | null {
    return v === 'multi' || v === 'aligned' || v === 'head' ? v : null;
}

/** `?skinMode=` の指定だけを見る。無ければ `null`。 */
export function getSkinModeOverride(): SkinMode | null {
    try {
        return parseSkinMode(new URLSearchParams(window.location.search).get('skinMode'));
    } catch (e) {
        return null;
    }
}

/** 既定は出荷挙動 ('head')。
 *
 * **URL だけを見る同期版。** avatar-config を含めた実効値は
 * `resolveSkinMode()` / `window.__multiBoneSkinPatch.mode` を見ること。 */
export function getSkinMode(): SkinMode {
    return getSkinModeOverride() ?? 'head';
}

/**
 * 実際に使う skin mode を決める。優先順位:
 *
 *   1. `?skinMode=` (debug / override)
 *   2. avatar-config.json のアバター定義の `skinMode`
 *   3. 'head' (出荷挙動)
 *
 * avatar-config のキーは avatar ごとなので、FULL133 で aligned にしても
 * 通常 LAM avatar / B80 / 20K avatar には一切効かない。
 */
export async function resolveSkinMode(): Promise<{ mode: SkinMode; source: string }> {
    const override = getSkinModeOverride();
    if (override) return { mode: override, source: 'url' };
    try {
        const avatars = await loadAvatarConfig();
        const id = getAvatarIdForDiag();
        const def = avatars.find((a: { id: string }) => a.id === id);
        const fromConfig = parseSkinMode(def?.skinMode);
        if (fromConfig) return { mode: fromConfig, source: 'avatar-config' };
    } catch (e) {
        console.warn('[PoC skinMode] avatar-config の読み込みに失敗。head を使います:', e);
    }
    return { mode: 'head', source: 'default' };
}

export interface SkinPatchResult {
    mode: SkinMode;
    /** mode の決定元: 'url' | 'avatar-config' | 'default' */
    source: string;
    applied: boolean;
    reason: string;
    /** 差し替え後の shader に 4 influence 行が「有効な形で」入っているか */
    activeInfluenceLines: number;
    headOnlyLineActive: boolean;
    /** `aligned` のとき、splatIndex 基準の skin lookup が本当に有効になっているか。
     *  shader 側の texelFetch と material 側の uniform が **両方** 揃って true。 */
    alignedLookupActive: boolean;
}

/**
 * `material` が生える前に呼ばれることがあるので、現れるまで rAF で待ってから当てる。
 * 結果は `window.__multiBoneSkinPatch` に入る。
 */
/** `skinIndex`/`skinWeight` を splatIndex で引ける texture にして uniform へ入れる。
 *
 * renderer が束ねている three ではなく、依存として入っている `three` を直接使う。
 * three の texture は `isTexture` などで duck-typing されるので、
 * 別インスタンスでも WebGLRenderer 側は受け付ける。
 * (renderer 内部の遅延生成オブジェクトに依存しないための措置) */
async function buildSkinTextures(material: any, geometry: any): Promise<{ w: number; h: number } | null> {
    const si = geometry.getAttribute('skinIndex');
    const sw = geometry.getAttribute('skinWeight');
    if (!si || !sw) return null;

    const { DataTexture, FloatType, NearestFilter, RGBAFormat } = await import('three');

    const n = si.count;
    const w = Math.ceil(Math.sqrt(n));
    const h = Math.ceil(n / w);
    const idx = new Float32Array(w * h * 4);
    const wt = new Float32Array(w * h * 4);
    for (let i = 0; i < n; i++) {
        idx[i * 4] = si.getX(i); idx[i * 4 + 1] = si.getY(i);
        idx[i * 4 + 2] = si.getZ(i); idx[i * 4 + 3] = si.getW(i);
        wt[i * 4] = sw.getX(i); wt[i * 4 + 1] = sw.getY(i);
        wt[i * 4 + 2] = sw.getZ(i); wt[i * 4 + 3] = sw.getW(i);
    }
    const mk = (data: Float32Array) => {
        const t = new DataTexture(data, w, h, RGBAFormat, FloatType);
        t.minFilter = NearestFilter;
        t.magFilter = NearestFilter;
        t.generateMipmaps = false;
        t.needsUpdate = true;
        return t;
    };
    material.uniforms = material.uniforms || {};
    material.uniforms.skinIndexTexture = { value: mk(idx) };
    material.uniforms.skinWeightTexture = { value: mk(wt) };
    return { w, h };
}

export async function installMultiBoneSkinning(renderer: any,
                                               maxTries = 600): Promise<SkinPatchResult> {
    // avatar-config を読むので await する。URL 指定があればそこで即決まる。
    const { mode, source } = await resolveSkinMode();
    return await new Promise<SkinPatchResult>((resolve) => {
        let tries = 0;
        const tick = () => {
            const hasMaterial =
                typeof renderer?.viewer?.splatMesh?.material?.vertexShader === 'string';
            const hasSkinAttrs =
                !!renderer?.viewer?.splatMesh?.geometry?.getAttribute?.('skinIndex');
            const ready = hasMaterial && (mode !== 'aligned' || hasSkinAttrs);
            if (ready || mode === 'head' || ++tries >= maxTries) {
                applyMultiBoneSkinning(renderer, mode, source).then((r) => {
                    (window as any).__multiBoneSkinPatch = r;
                    resolve(r);
                });
                return;
            }
            requestAnimationFrame(tick);
        };
        tick();
    });
}

/**
 * renderer の splat material の vertex shader を差し替える。
 * `mode === 'head'` のときは何もしない (出荷版のまま)。
 */
export async function applyMultiBoneSkinning(
    renderer: any, mode: SkinMode, source = 'url',
): Promise<SkinPatchResult> {
    const fail = (reason: string): SkinPatchResult => ({
        mode, source, applied: false, reason,
        activeInfluenceLines: 0, headOnlyLineActive: true,
        alignedLookupActive: false,
    });
    if (mode === 'head') return fail('skinMode=head のため出荷版のまま');

    const material = renderer?.viewer?.splatMesh?.material;
    if (!material || typeof material.vertexShader !== 'string') {
        return fail('splatMesh.material.vertexShader が見つからない');
    }
    const src: string = material.vertexShader;
    if (!src.includes('USE_SKINNING')) return fail('shader に USE_SKINNING が無い');
    if (src.indexOf(HEAD_ONLY_BLOCK) < 0) {
        return fail('出荷版の head ボーン駆動ブロックが見つからない (renderer 版が違う)');
    }

    let patched: string;
    if (mode === 'aligned') {
        const size = await buildSkinTextures(material, renderer.viewer.splatMesh.geometry);
        if (!size) return fail('skinIndex / skinWeight attribute が無い');
        const UNIFORM_ANCHOR = '        #ifdef USE_SKINNING\n            uniform mat4 bindMatrix;';
        if (src.indexOf(UNIFORM_ANCHOR) < 0) return fail('uniform 挿入位置が見つからない');
        patched = src
            .replace(UNIFORM_ANCHOR,
                '        uniform highp sampler2D skinIndexTexture;\n'
                + '        uniform highp sampler2D skinWeightTexture;\n' + UNIFORM_ANCHOR)
            .replace(HEAD_ONLY_BLOCK, ALIGNED_BLOCK);
        if (patched === src) return fail('aligned 用の置換点が見つからない');
    } else {
        patched = src.replace(HEAD_ONLY_BLOCK, MULTI_BONE_BLOCK);
    }
    material.vertexShader = patched;
    material.needsUpdate = true;

    // MULTI_BONE_BLOCK は `boneMatX * skinVertex * skinWeight.x`、
    // ALIGNED_BLOCK は `aMX * skinVertex * aW.x`。両方を数える。
    const active = (patched.match(
        /^\s*skinned\s*\+=\s*(?:boneMat[XYZW]\s*\*\s*skinVertex\s*\*\s*skinWeight\.[xyzw]|aM[XYZW]\s*\*\s*skinVertex\s*\*\s*aW\.[xyzw]);/gm,
    ) || []).length;
    const headActive = /^\s*skinned\s*\+=\s*boneMat\s*\*\s*skinVertex\s*\*\s*1\.0;/m.test(
        patched.replace(/} else if \(headBoneIndex[\s\S]*?\n {16}}/, ''));
    // aligned は shader の texelFetch と uniform の両方が揃って初めて有効。
    const alignedLookupActive = mode === 'aligned'
        && patched.includes('texelFetch(skinIndexTexture')
        && patched.includes('texelFetch(skinWeightTexture')
        && !!material.uniforms?.skinIndexTexture?.value
        && !!material.uniforms?.skinWeightTexture?.value;

    return {
        mode, source, applied: true,
        reason: 'vertexShader を 4 influence LBS へ差し替えた',
        activeInfluenceLines: active,
        headOnlyLineActive: headActive,
        alignedLookupActive,
    };
}
