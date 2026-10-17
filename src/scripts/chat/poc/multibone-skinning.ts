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

export type SkinMode = 'head' | 'multi';

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

export function getSkinMode(): SkinMode {
    try {
        return new URLSearchParams(window.location.search).get('skinMode') === 'multi'
            ? 'multi' : 'head';
    } catch (e) {
        return 'head';
    }
}

export interface SkinPatchResult {
    mode: SkinMode;
    applied: boolean;
    reason: string;
    /** 差し替え後の shader に 4 influence 行が「有効な形で」入っているか */
    activeInfluenceLines: number;
    headOnlyLineActive: boolean;
}

/**
 * `material` が生える前に呼ばれることがあるので、現れるまで rAF で待ってから当てる。
 * 結果は `window.__multiBoneSkinPatch` に入る。
 */
export function installMultiBoneSkinning(renderer: any, mode: SkinMode,
                                         maxTries = 600): Promise<SkinPatchResult> {
    return new Promise((resolve) => {
        let tries = 0;
        const tick = () => {
            const hasMaterial =
                typeof renderer?.viewer?.splatMesh?.material?.vertexShader === 'string';
            if (hasMaterial || mode !== 'multi' || ++tries >= maxTries) {
                const r = applyMultiBoneSkinning(renderer, mode);
                (window as any).__multiBoneSkinPatch = r;
                resolve(r);
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
export function applyMultiBoneSkinning(renderer: any, mode: SkinMode): SkinPatchResult {
    const fail = (reason: string): SkinPatchResult => ({
        mode, applied: false, reason,
        activeInfluenceLines: 0, headOnlyLineActive: true,
    });
    if (mode !== 'multi') return fail('skinMode=head のため出荷版のまま');

    const material = renderer?.viewer?.splatMesh?.material;
    if (!material || typeof material.vertexShader !== 'string') {
        return fail('splatMesh.material.vertexShader が見つからない');
    }
    const src: string = material.vertexShader;
    if (!src.includes('USE_SKINNING')) return fail('shader に USE_SKINNING が無い');
    if (src.indexOf(HEAD_ONLY_BLOCK) < 0) {
        return fail('出荷版の head ボーン駆動ブロックが見つからない (renderer 版が違う)');
    }

    const patched = src.replace(HEAD_ONLY_BLOCK, MULTI_BONE_BLOCK);
    material.vertexShader = patched;
    material.needsUpdate = true;

    const active = (patched.match(/^\s*skinned\s*\+=\s*boneMat[XYZW]\s*\*\s*skinVertex\s*\*\s*skinWeight\.[xyzw];/gm) || []).length;
    const headActive = /^\s*skinned\s*\+=\s*boneMat\s*\*\s*skinVertex\s*\*\s*1\.0;/m.test(
        patched.replace(/} else if \(headBoneIndex[\s\S]*?\n {16}}/, ''));
    return {
        mode, applied: true,
        reason: 'vertexShader を 4 influence LBS へ差し替えた',
        activeInfluenceLines: active,
        headOnlyLineActive: headActive,
    };
}
