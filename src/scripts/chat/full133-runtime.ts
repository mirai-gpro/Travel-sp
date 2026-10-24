/**
 * FULL133 steady-state runtime
 *
 * FULL133 (`uika-full133-skin` / 133,541 Gaussians) 専用の正式 morph path。
 * avatar-config.json から自動で選ばれる。通常利用で URL パラメータは不要。
 *
 * ===================================================================
 * 1. 出荷版 `runMorphUpdate()` が毎フレームやっていること (実ソース確認済み)
 * ===================================================================
 * `Viewer.js:2775-2822` (sourcemap から復元した installed renderer の正本):
 *
 *     runMorphUpdate() {
 *       gaussianSplatCount = avatarMesh.geometry.attributes.position.count   // 定数
 *       morphedMesh = new Float32Array(position.array)                       // O(133K) 確保 + copy
 *       splatMesh.bonesNum = 5                                               // 定数
 *       useFlame === false:
 *         skinModel.skeleton.update()                                        // 必要
 *         boneRoot.updateMatrixWorld(true)                                   // 必要
 *         if (splatIndex attribute && setSkinAttibutes === false) { ... }     // 初回のみ
 *       splatMesh.morphedMesh = morphedMesh
 *       if (splatDataTextures['flameModel'] !== undefined)
 *         splatMesh.updateTetureAfterBSAndSkeleton(0, splatNum - 1, useFlame)
 *     }
 *
 * `SplatMesh.js:1105-1127`:
 *
 *     updateTetureAfterBSAndSkeleton(from, to, useFlameModel) {
 *       getSceneTransform(0, sceneTransform)
 *       splatBuffer.fillSplatCenterArray(morphedMesh, baseData.centers,
 *                                        sceneTransform, from, to, 0)        // O(133K)
 *       SplatMesh.updateCenterColorsPaddedData(from, to, centers, colors,
 *                                              paddedCenterColors)           // O(133K)
 *       updateDataTexture(paddedCenterColors, ... from, to)                   // O(133K) upload
 *       updateBoneMatrixTexture(useFlameModel)                               // O(bsCount)
 *     }
 *
 * ===================================================================
 * 2. なぜ steady-state では O(133K) が全部不要なのか
 * ===================================================================
 * `fillSplatCenterArray` (`SplatBuffer.js:313-356`) の出力は
 *
 *     outCenter[i] = (splatBuffer の center[i] に transform を適用したもの)
 *                    + morphedMesh[i]
 *
 * の 3 入力だけで決まる。このうち
 *
 *   - `splatBuffer` の center       … ロード済みバッファ。ロード後不変
 *   - `morphedMesh`                 … `avatarMesh.geometry.attributes.position.array`
 *   - `transform`                   … `getSceneTransform(0, ...)`
 *
 * で、**`position.array` は renderer 内のどこからも書き換えられていない**。
 * 書き込み箇所を全探索した結果、`setAttribute('position', ...)` は
 * `SplatGeometry.js:19` (splat 描画用の quad geometry) の 1 箇所だけで、
 * `avatarMesh` の position attribute を触るコードは存在しない。
 * three.js は morph target も skinning も **shader で適用する**ので、
 * position attribute は bind pose のまま変化しない。
 *
 * したがって毎フレームの `fillSplatCenterArray` →
 * `updateCenterColorsPaddedData` → texture upload は、
 * **毎回まったく同じ値を作り直して同じ内容を上げ直している**。
 *
 * 唯一変化し得るのは `getSceneTransform(0, ...)` = `SplatScene.matrix`
 * (`SplatScene.js:28-36`、`dynamicMode === false` なので local matrix)。
 * ここが動いたときだけ centers は作り直す必要がある。本 runtime は
 * その signature を毎フレーム比較し、変わったら 1 回だけ完全実行する。
 *
 * ===================================================================
 * 3. では表情と skinning はどこで適用されているのか (shader)
 * ===================================================================
 * `SplatMaterial.js:213-285` の vertex shader:
 *
 *     splatCenter = uintBitsToFloat(texture(centersColorsTexture, ...).gba)   // canonical
 *     for (i = 0; i < bsCount; ++i) {
 *         sampledBSPos = texture(flameModelTexture, ...)                      // 基底 (静的)
 *         bsWeight     = uintBitsToFloat(texture(boneTexture, ...))           // 毎フレーム
 *         splatCenter += weight * uintBitsToFloat(sampledBSPos)
 *     }
 *     #ifdef USE_SKINNING
 *         boneMat = getBoneMatrix0(...)        // boneTexture0 = skeleton.boneTexture
 *         skinned += boneMat * skinVertex * w  // 毎フレーム
 *     #endif
 *
 * つまり:
 *   - `centersColorsTexture` は **canonical (bind pose) center 専用**
 *   - 表情変形   = `flameModelTexture` (静的基底) × `bsWeight` (毎フレーム) — shader
 *   - skinning   = `boneTexture0` (= `skeleton.boneTexture`、毎フレーム) — shader
 *
 * ===================================================================
 * 4. steady-state で毎フレーム必要なもの
 * ===================================================================
 *   - `skinModel.skeleton.update()`        … skeleton.boneTexture を更新する
 *   - `boneRoot.updateMatrixWorld(true)`   … bone の world matrix
 *   - `splatMesh.updateBoneMatrixTexture(false)`
 *       `SplatMesh.js:980-1013`。`updateFlameBoneMatrix === false` なので
 *       bone matrix 行は書かず、**bsWeight (51/52 係数) だけ**を
 *       `baseData['boneMatrix']` の `bonesNum * 16` 以降へ書いて needsUpdate。
 *       加えて `boneTexture0` / `bindMatrix` / `bindMatrixInverse` uniform を
 *       `flameModel.skeleton` の現在値へ張り替える。O(bsCount)。
 *
 * これだけ。既存 PoC `morphFast` と**同じ処理内容**であり、新しい morph 方式は
 * 作っていない。本 module は PoC wrapper を正式 runtime として整理し、
 * 不変条件の検証 (scene transform / position buffer / useFlame) と
 * FULL133 ゲートと fallback を責務として持たせたもの。
 *
 * ===================================================================
 * 適用範囲
 * ===================================================================
 * `uika-full133-skin` かつ splatCount 133541 かつ `useFlame === false` のみ。
 * 通常 LAM avatar / B80 / 20K avatar には一切適用しない。
 * `node_modules` は書き換えない (instance の `runMorphUpdate` 差し替えのみ)。
 */

import { loadAvatarConfig } from '../../config/avatar-config';
import { getAvatarIdForDiag } from './poc/render-perf';
import { updateFull133Predeform } from './full133-predeform';

/** 適用対象。これ以外では何もしない。 */
const FULL133_AVATAR_ID = 'uika-full133-skin';
const FULL133_SPLAT_COUNT = 133541;

/** 初期化が揃うまで完全実行する最小フレーム数 (起動時のみのコスト)。
 *  マジック値だけに頼らず、実 ready 条件と AND で判定する。 */
const MIN_FULL_RUNS = 30;

/** scene transform の一致判定に使う epsilon。 */
const EPS_SCENE_TRANSFORM = 1e-7;

export type Full133MorphPath = 'stock' | 'steady-state';

export interface Full133RuntimeStats {
    mode: Full133MorphPath;
    /** mode の決定元: 'url' | 'url-legacy' | 'avatar-config' | 'avatar-config-legacy' | 'default' */
    source: string;
    applied: boolean;
    reason: string;
    avatarId: string;
    splatCount: number;
    /** 完全実行した回数 (初期化 + 不変条件が崩れた回数) */
    fullRuns: number;
    /** steady-state path を通ったフレーム数 */
    steadyFrames: number;
    /** scene transform が変わって完全実行へ戻した回数 */
    sceneTransformInvalidations: number;
    /** position attribute が差し替わって完全実行へ戻した回数 */
    positionBufferInvalidations: number;
    /** 例外で完全実行へ戻した回数 */
    fallbackCount: number;
    lastError: string | null;
    /** ready 判定の内訳 (どれが揃っていないかが判る) */
    ready: Record<string, boolean>;
}

function param(name: string): string | null {
    try {
        return new URLSearchParams(window.location.search).get(name);
    } catch (e) {
        return null;
    }
}

function parseMorphPath(v: string | null | undefined): Full133MorphPath | null {
    if (v === 'steady-state' || v === 'steady') return 'steady-state';
    if (v === 'stock') return 'stock';
    return null;
}

/** 旧 PoC フラグ `?morphFast=1` / `=0`。URL 互換のために残す。 */
function parseLegacyMorphFast(v: string | null | undefined): Full133MorphPath | null {
    if (v === '1' || v === 'on' || v === 'true') return 'steady-state';
    if (v === '0' || v === 'off' || v === 'false') return 'stock';
    return null;
}

/** URL の override。無ければ `null`。debug 用で、通常利用では指定しない。 */
export function getMorphPathOverride(): { path: Full133MorphPath; source: string } | null {
    const fromNew = parseMorphPath(param('morphPath'));
    if (fromNew) return { path: fromNew, source: 'url' };
    const fromLegacy = parseLegacyMorphFast(param('morphFast'));
    if (fromLegacy) return { path: fromLegacy, source: 'url-legacy' };
    return null;
}

/** 同期版。URL の指定だけを見る (診断表示用)。 */
export function getMorphPath(): Full133MorphPath {
    return getMorphPathOverride()?.path ?? 'stock';
}

/**
 * 実際に使う morph path を決める。優先順位:
 *
 *   1. `?morphPath=` / 旧 `?morphFast=` (debug override)
 *   2. avatar-config.json のアバター定義の `morphPath` (旧 `morphFast` も読む)
 *   3. 'stock' (出荷挙動)
 *
 * avatar-config のキーは avatar ごとなので、FULL133 で有効にしても
 * 他の avatar には一切効かない。
 */
export async function resolveMorphPath(): Promise<{ path: Full133MorphPath; source: string }> {
    const override = getMorphPathOverride();
    if (override) return { path: override.path, source: override.source };
    try {
        const avatars = await loadAvatarConfig();
        const id = getAvatarIdForDiag();
        const def = avatars.find((a: { id: string }) => a.id === id);
        const fromConfig = parseMorphPath(def?.morphPath);
        if (fromConfig) return { path: fromConfig, source: 'avatar-config' };
        if (typeof def?.morphFast === 'boolean') {
            return {
                path: def.morphFast ? 'steady-state' : 'stock',
                source: 'avatar-config-legacy',
            };
        }
    } catch (e) {
        console.warn('[FULL133] avatar-config の読み込みに失敗。stock を使います:', e);
    }
    return { path: 'stock', source: 'default' };
}

/**
 * `getSceneTransform(0, out)` の受け皿。`out.copy(scene.transform)` しか
 * 呼ばれないので、THREE.Matrix4 を import せずに duck typing で受ける。
 */
function makeTransformSink(): { elements: number[]; copy: (m: any) => any } {
    return {
        elements: new Array(16).fill(0),
        copy(m: any) {
            const src = m?.elements;
            if (src) for (let i = 0; i < 16; i++) this.elements[i] = src[i];
            return this;
        },
    };
}

export async function installFull133Runtime(
    renderer: any, maxTries = 600,
): Promise<Full133RuntimeStats> {
    const { path: mode, source } = await resolveMorphPath();
    const stats: Full133RuntimeStats = {
        mode, source, applied: false, reason: '',
        avatarId: '', splatCount: 0,
        fullRuns: 0, steadyFrames: 0,
        sceneTransformInvalidations: 0, positionBufferInvalidations: 0,
        fallbackCount: 0, lastError: null,
        ready: {},
    };
    (window as any).__full133Runtime = stats;

    return await new Promise<Full133RuntimeStats>((resolve) => {
        let tries = 0;
        const tick = () => {
            const v = renderer?.viewer;
            const ready = v && typeof v.runMorphUpdate === 'function';
            if (ready || mode === 'stock' || ++tries >= maxTries) {
                apply(renderer, stats);
                resolve(stats);
                return;
            }
            requestAnimationFrame(tick);
        };
        tick();
    });
}

function apply(renderer: any, stats: Full133RuntimeStats): void {
    const v = renderer?.viewer;

    // stock でも診断値は埋める (どの avatar でこの判断になったかを残すため)。
    stats.avatarId = getAvatarIdForDiag();
    stats.splatCount = Number(v?.splatMesh?.getSplatCount?.() ?? 0);

    if (stats.mode === 'stock') {
        stats.reason = 'morphPath=stock のため出荷版の runMorphUpdate のまま';
        return;
    }
    if (!v || typeof v.runMorphUpdate !== 'function') {
        stats.reason = 'viewer / runMorphUpdate が見つからない';
        return;
    }
    if (v.__full133RuntimeHooked) {
        stats.reason = 'すでに適用済み';
        return;
    }
    // FULL133 以外には絶対に適用しない。
    if (stats.avatarId !== FULL133_AVATAR_ID) {
        stats.reason = `FULL133 専用。avatarId=${stats.avatarId} のため適用しない`;
        return;
    }
    if (stats.splatCount !== 0 && stats.splatCount !== FULL133_SPLAT_COUNT) {
        stats.reason = `FULL133 専用。splatCount=${stats.splatCount} `
            + `(期待 ${FULL133_SPLAT_COUNT}) のため適用しない`;
        return;
    }
    v.__full133RuntimeHooked = true;

    const orig = v.runMorphUpdate.bind(v);
    const sink = makeTransformSink();
    let sceneSig: number[] | null = null;
    let posArray: any = null;
    let posVersion = -1;
    let isReady = false;

    /** scene transform が前フレームから変わったか。変わっていたら signature を更新する。 */
    const sceneTransformChanged = (): boolean => {
        const sm = v.splatMesh;
        if (!sm || typeof sm.getSceneTransform !== 'function') return false;
        sm.getSceneTransform(0, sink);
        const e = sink.elements;
        if (sceneSig === null) {
            sceneSig = e.slice();
            return false;
        }
        let changed = false;
        for (let i = 0; i < 16; i++) {
            if (Math.abs(sceneSig[i] - e[i]) > EPS_SCENE_TRANSFORM) { changed = true; break; }
        }
        if (changed) sceneSig = e.slice();
        return changed;
    };

    /** canonical position buffer が差し替わったか (モデル差し替え等)。 */
    const positionBufferChanged = (): boolean => {
        const pa = v.avatarMesh?.geometry?.attributes?.position;
        if (!pa) return false;
        const ver = Number(pa.version ?? 0);
        if (posArray === null) {
            posArray = pa.array;
            posVersion = ver;
            return false;
        }
        if (posArray !== pa.array || posVersion !== ver) {
            posArray = pa.array;
            posVersion = ver;
            return true;
        }
        return false;
    };

    /** 初期化が完了したか。マジック値だけに頼らず実条件と AND で見る。 */
    const checkReady = (): boolean => {
        const sm = v.splatMesh;
        const r: Record<string, boolean> = {
            setSkinAttibutes: v.setSkinAttibutes === true,
            flameModelTexture: sm?.splatDataTextures?.['flameModel'] !== undefined,
            boneMatrixTexture: sm?.splatDataTextures?.['boneMatrix'] !== undefined,
            morphedMesh: !!sm?.morphedMesh,
            bonesNum: (sm?.bonesNum ?? 0) > 0,
            splatCount: (sm?.getSplatCount?.() ?? 0) > 0,
            // useFlame === true は flame_params から毎フレーム bone を駆動する別経路
            // (`Viewer.js:2825` updateFlameBones)。steady-state では止めてしまうので
            // 適用しない。FULL133 は useFlame === false。
            useFlameIsFalse: v.useFlame === false,
            minFullRuns: stats.fullRuns >= MIN_FULL_RUNS,
        };
        stats.ready = r;
        return Object.values(r).every(Boolean);
    };

    /** 出荷版の完全実行。centers 再構築と texture 全量 upload を含む。 */
    const runFull = (a: any[]): any => {
        const z = orig(...a);
        stats.fullRuns++;
        // 完全実行で centers を作り直したので、不変条件の基準も取り直す。
        sceneTransformChanged();
        positionBufferChanged();
        // canonical が更新され得たので、predeform も 1 回やり直させる。
        (window as any).__full133PredeformForce?.();
        updateFull133Predeform(renderer);
        return z;
    };

    v.runMorphUpdate = function (...a: any[]) {
        try {
            if (!isReady) {
                const z = runFull(a);
                isReady = checkReady();
                return z;
            }
            // canonical data が変わる条件が起きたら 1 回だけ完全実行へ戻す。
            if (positionBufferChanged()) {
                stats.positionBufferInvalidations++;
                return runFull(a);
            }
            if (sceneTransformChanged()) {
                stats.sceneTransformInvalidations++;
                return runFull(a);
            }

            // ---- steady-state path ----
            // 毎フレーム更新するのは skeleton / bone matrices / expression weights のみ。
            // centers / colors は canonical のまま触らない。
            v.skinModel?.skeleton?.update?.();
            v.boneRoot?.updateMatrixWorld?.(true);
            v.splatMesh?.updateBoneMatrixTexture?.(false);
            // GPU pre-deformation。51 blendshape の合成はここで 1 Gaussian 1 回だけ。
            // expression が変わっていなければ GPU を一切触らない。
            // predeform が無効なら何もしない (legacy は main shader 側で合成する)。
            updateFull133Predeform(renderer);
            stats.steadyFrames++;
            return undefined;
        } catch (e: any) {
            // 黙って壊れた状態で続けない。完全実行へ戻す。
            stats.fallbackCount++;
            stats.lastError = String(e?.message ?? e);
            isReady = false;
            stats.fullRuns = 0;
            console.warn('[FULL133] steady-state path で例外。完全実行へ戻します:', e);
            try {
                return orig(...a);
            } catch (e2) {
                return undefined;
            }
        }
    };

    stats.applied = true;
    stats.reason = 'runMorphUpdate を FULL133 steady-state path へ差し替えた '
        + '(初期化完了までは完全実行)';

    (window as any).__full133ForceFullMorph = () => {
        isReady = false;
        stats.fullRuns = 0;
        return 'ok';
    };
}
