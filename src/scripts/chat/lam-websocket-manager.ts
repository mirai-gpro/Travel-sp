// src/scripts/chat/lam-websocket-manager.ts
/**
 * LAM WebSocket Manager - Gaussian Splat アバターの管理
 *
 * LAM_gpro より移植・改修:
 * - gaussian-splat-renderer-for-lam パッケージの公式APIを使用
 * - GaussianSplatRenderer.getInstance(div, assetPath, callbacks) パターン
 * - ARKit 52ブレンドシェイプのコールバック方式適用
 * - LiveAudioManager との同期連携
 *
 * 仕様書08 セクション6:
 * External TTS Player モードから LiveAudioManager モードへ変更
 */

import * as GaussianSplats3D from 'gaussian-splat-renderer-for-lam';
import type { ExpressionFrame } from './live-audio-manager';
import { ensureDefaultAvatarInStorage } from '../../config/avatar-config';
import { isUika133kMode, applyUika133kMode } from './uika-133k-mode';
import { getDiagMode, createA2EReplayPlayer, A2EReplayPlayer } from './a2e-replay';
// PoC 限定: ?skinMode=multi / aligned のときだけ splat shader を 4 influence LBS へ
// 差し替える。既定 (?skinMode なし / =head) では何もしないので、出荷版の挙動は変わらない。
import { installMultiBoneSkinning } from './poc/multibone-skinning';
// PoC 限定: ?gpuSort=0 のときだけ splat sort の GPU 距離計算を切る。
// 既定 (フラグ無し) では何もしないので、出荷版の挙動は変わらない。
import { installSortMode, getSortMode } from './poc/sort-mode';
// PoC 限定: ?sortMode=10fps / ?centersProbe=1 / ?frameCost=1。
// FULL133 の morph path は PoC ではなく正式 runtime (full133-runtime.ts)。
// いずれも未指定なら何もしないので、出荷版の挙動は変わらない。
import { installRenderPerf, getAvatarIdForDiag } from './poc/render-perf';
// PoC: 性能計測 run の前提条件チェック (計測の有効性判定のみ。描画は変えない)
import { logRunConfig } from './poc/run-guard';
// PoC: FULL133 adaptive sort (camera 変化時のみ sort。既定は何もしない)
import { installAdaptiveSort } from './poc/adaptive-sort';
import { installFrameCost } from './poc/frame-cost';
import { installFull133Runtime } from './full133-runtime';
import { installFull133Predeform } from './full133-predeform';
import { installFull133RenderBudget } from './full133-render-budget';

export interface LAMConfig {
    containerElement: HTMLDivElement;   // レンダラーを埋め込むdiv要素
    modelUrl: string;                  // .zip モデルURL
}

// ARKit 52 ブレンドシェイプ名（標準順序）
export const ARKIT_BLENDSHAPE_NAMES = [
    'eyeBlinkLeft', 'eyeLookDownLeft', 'eyeLookInLeft', 'eyeLookOutLeft', 'eyeLookUpLeft',
    'eyeSquintLeft', 'eyeWideLeft', 'eyeBlinkRight', 'eyeLookDownRight', 'eyeLookInRight',
    'eyeLookOutRight', 'eyeLookUpRight', 'eyeSquintRight', 'eyeWideRight',
    'jawForward', 'jawLeft', 'jawRight', 'jawOpen',
    'mouthClose', 'mouthFunnel', 'mouthPucker', 'mouthLeft', 'mouthRight',
    'mouthSmileLeft', 'mouthSmileRight', 'mouthFrownLeft', 'mouthFrownRight',
    'mouthDimpleLeft', 'mouthDimpleRight', 'mouthStretchLeft', 'mouthStretchRight',
    'mouthRollLower', 'mouthRollUpper', 'mouthShrugLower', 'mouthShrugUpper',
    'mouthPressLeft', 'mouthPressRight', 'mouthLowerDownLeft', 'mouthLowerDownRight',
    'mouthUpperUpLeft', 'mouthUpperUpRight',
    'browDownLeft', 'browDownRight', 'browInnerUp', 'browOuterUpLeft', 'browOuterUpRight',
    'cheekPuff', 'cheekSquintLeft', 'cheekSquintRight',
    'noseSneerLeft', 'noseSneerRight',
    'tongueOut'
];

/**
 * FIRST_VALID_FRAME_RENDERED の診断値。
 * Architecture 上の AVATAR_VISIBLE の Source of Truth。
 */
export interface FirstValidFrameInfo {
    /** splatMesh.firstRenderTime（renderer が記録した performance.now()） */
    firstRenderTime: number;
    /** アプリ側が観測した performance.now() */
    observedAt: number;
    /** 観測時点の描画対象 splat 数（geometry.instanceCount） */
    renderSplatCount: number;
    /** 観測時点の splat scene 数 */
    sceneCount: number;
    /** firstRenderTime から観測までの遅れ（ms） */
    delayFromRenderMs: number;
}

/**
 * AVATAR_VISIBLE の診断値。
 * FIRST_VALID_FRAME_RENDERED（技術signal）が実際の render/presentation を
 * 通過したことを表す。
 */
export interface AvatarVisibleInfo extends FirstValidFrameInfo {
    /** AVATAR_VISIBLE が成立した performance.now() */
    visibleAt: number;
    /** FIRST_VALID_FRAME_RENDERED からの経過（ms。待機ではなく結果の実測値） */
    barrierMs: number;
    /** barrier 成立までに完了した viewer.render() の回数 */
    rendersSinceFirstValidFrame: number;
}

export class LAMWebSocketManager {
    private renderer: GaussianSplats3D.GaussianSplatRenderer | null = null;
    private isModelLoaded: boolean = false;

    // ★ FIRST_VALID_FRAME_RENDERED（Phase 3）
    //   「Avatar がロードされた」ではなく「最初の有効描画が実際に成立した」ことを
    //   検知する。Avatar lifecycle ごとに 1 回だけ発火する。
    //   Live generation / Greeting / A2E とは独立した lifecycle なので、
    //   generation では reset しない（reset するのは dispose / initialize のみ）。
    private firstValidFrameReported: boolean = false;
    private firstValidFrameInfo: FirstValidFrameInfo | null = null;
    private firstValidFrameListener: ((info: FirstValidFrameInfo) => void) | null = null;

    // ★ AVATAR_VISIBLE（Phase 4-A）
    //   FIRST_VALID_FRAME_RENDERED は updateRenderIndexes() で有効 geometry が
    //   設定された時点であり、実際の GL draw より僅かに先行し得る。
    //   そこで「その有効 geometry を使った viewer.render() が最低1回完了した」
    //   ことを presentation barrier とし、別の frame で AVATAR_VISIBLE を出す。
    //   固定時間待ちは使わない（render progression による barrier）。
    private avatarVisibleReported: boolean = false;
    private avatarVisibleInfo: AvatarVisibleInfo | null = null;
    private avatarVisibleListener: ((info: AvatarVisibleInfo) => void) | null = null;
    private _prevConsecutiveRenderFrames: number = 0;
    private _rendersSinceFirstValidFrame: number = 0;
    private _exprDebugCounter: number = 0;  // デバッグログ間引き用
    private _prevMouthValues: Record<string, number> = {};  // スムージング用前フレーム値

    // 現在適用中の expression フレーム
    // (通常 LAM 経路: AudioSyncPlayer の rAF が updateExpression() で更新する cache)
    private currentExpression: ExpressionFrame | null = null;

    /**
     * expression フレームの直接取得関数 (UIKA mode 専用、任意)。
     *
     * 通常 LAM は
     *   AudioSyncPlayer の rAF
     *     → LiveAudioManager.getCurrentExpressionFrame()
     *     → updateExpression() → currentExpression cache
     *     → renderer.getExpressionData()
     * という経路で、描画が間引かれると **cache に残った古いフレーム**を使う。
     *
     * これが設定されている場合は `_getExpressionData()` がこの関数を直接呼び、
     * **その描画瞬間の AudioContext.currentTime に対応するフレーム**を使う。
     * UIKA mode だけ `() => liveAudioManager.getCurrentExpressionFrame()` を渡す。
     */
    private expressionProvider: (() => ExpressionFrame | null) | null = null;

    /**
     * 【診断専用】UIKA 診断 URL のときだけ設定される。
     * `exprPath` と、`LiveAudioManager` の read-only 同期スナップショット取得関数。
     * 通常 LAM では設定されないので、ログも出ない。
     */
    private exprTrace: {
        path: string;
        getState: () => {
            playbackMs: number; bufferFrames: number; fps: number;
            requestedFrame: number; selectedFrame: number; clamped: boolean;
        };
    } | null = null;

    // ===== 診断専用: 人工 morph プローブ (?morphProbe=1) =====
    // A2E / Socket.IO / AudioContext / expression buffer / provider・cache を
    // すべて外し、performance.now() から直接作った jawOpen だけを renderer へ渡す。
    // 通常 LAM と UIKA が **この同じ分岐**を通るので、違うのはモデルだけになる。
    private readonly morphProbe: boolean = getDiagMode() === 'morphProbe';
    private _probeTimes: number[] = [];
    private _probeLogAt = 0;
    // 累積版 (指示書 §9: warm-up を除いた 30 秒以上を 1 つの数字で出すため)。
    // 直近 120 サンプルの sliding window だけでは run 全体の p50 が出せない。
    private _probeAll: number[] = [];
    private _probeAllLast: number | null = null;
    private _probeApiInstalled = false;
    /** 統計から外した長い中断の回数 (tab 非前面 / スリープ等)。run の有効性判定に使う。 */
    private _probeGaps = 0;
    /** 計測中に tab が非前面になった回数。1 以上なら run は無効 (指示書 §8)。 */
    private _probeHidden = 0;
    /** 計測中に viewport が変わった回数。1 以上なら A/B 比較に使えない (指示書 §5)。 */
    private _probeResized = 0;
    /** 計測開始時点の viewport。`runConfig.viewport` はページロード時の
     *  スナップショットなので、ロード後に DevTools の配置を変えると計測窓の実態と
     *  食い違う (実測: runConfig=1707x898 / 計測窓=1152x898)。計測窓の正本はこちら。 */
    private _probeViewportAtStart: string | null = null;

    // ===== 診断専用: 実 A2E 固定リプレイ (?a2eReplay=1) =====
    // morphProbe とは完全に別モード (同時指定は a2e-replay.ts 側で両方無効化)。
    // frame の取得元だけを固定データに差し替え、name マッピング / 日本語口形補正 /
    // renderer への受け渡しは本番とまったく同じ経路を通す。
    private readonly a2eReplay: boolean = getDiagMode() === 'a2eReplay';
    private replayPlayer: A2EReplayPlayer | null = null;
    private replayInitTried = false;

    // トレース間引き用 (console spam を避ける)
    private _traceRenderAt = 0;
    private _traceRenderSel = -1;
    private _traceRenderClamped: boolean | null = null;
    private _traceCacheAt = 0;
    private _traceCacheSel = -1;
    private _traceCacheClamped: boolean | null = null;

    // チャット状態（Idle / Listening / Thinking / Responding）
    private chatState: string = 'Idle';

    // ブレンドシェイプ名マッピング
    private expressionNames: string[] = ARKIT_BLENDSHAPE_NAMES;

    /**
     * 初期化: Gaussian Splat レンダラーをセットアップ
     * 公式API: GaussianSplatRenderer.getInstance(div, assetPath, callbacks)
     */
    async initialize(config: LAMConfig): Promise<void> {
        try {
            // ★ 新規ユーザー対応: モードのデフォルトアバター情報をlocalStorageに確実に設定
            const mode = window.location.pathname.includes('concierge') ? 'concierge' : 'lesson';
            // UIKA Native 133K hidden PoC (?uika133k=1) では avatar-config を触らない。
            // 通常利用者の localStorage / ZIP 取得に一切影響させないため。
            const uikaMode = isUika133kMode();
            if (!uikaMode) {
                await ensureDefaultAvatarInStorage(mode);
            }

            // ★ Avatar lifecycle の開始。両 signal を未発火に戻す。
            this.firstValidFrameReported = false;
            this.firstValidFrameInfo = null;
            this.avatarVisibleReported = false;
            this.avatarVisibleInfo = null;
            this._prevConsecutiveRenderFrames = 0;
            this._rendersSinceFirstValidFrame = 0;

            this.renderer = await GaussianSplats3D.GaussianSplatRenderer.getInstance(
                config.containerElement,
                config.modelUrl,
                {
                    getChatState: () => this.chatState,
                    getExpressionData: () => this._getExpressionData(),
                    backgroundColor: '0x000000',
                    alpha: 0.0,
                }
            );

            // ★ Startup Avatar では radius-based progressive reveal を使わない。
            //   既定の SceneRevealMode.Default では shader の fade-in により
            //   「有効 geometry は存在するが全 splat が透明」という期間が
            //   renderer 定数 SCENE_FADEIN_RATE_FAST=0.012 に従って
            //   60 frame 以上続き、FIRST_VALID_FRAME_RENDERED と
            //   実際の視認が構造的に一致しなくなる。
            //   renderer が公開している SceneRevealMode.Instant を
            //   アプリ側から設定して無効化する（node_modules は変更しない）。
            //   viewer.sceneRevealMode は描画フレームごとに
            //   updateVisibleRegionFadeDistance() が読む値なので、
            //   renderer/viewer 生成後・最初の有効 render より前に設定すれば効く。
            //   適用範囲はこの renderer instance（= Startup Avatar）だけで、
            //   uika-native PoC ページの別 Viewer には影響しない。
            const viewerForReveal = (this.renderer as any)?.viewer;
            if (viewerForReveal) {
                viewerForReveal.sceneRevealMode = GaussianSplats3D.SceneRevealMode.Instant;
                console.log('[AVATAR] scene_reveal_mode=Instant'
                    + ` value=${viewerForReveal.sceneRevealMode}`);
            } else {
                console.warn('[AVATAR] viewer が取得できず SceneRevealMode を設定できません');
            }

            // renderer と viewer.splatMesh へ到達できるようになった時点。
            // これは「表示準備完了」であって実描画ではない（signal にはしない）。
            console.log('[AVATAR] renderer_ready'
                + ` t=${performance.now().toFixed(1)}ms`
                + ` splatMesh=${!!(this.renderer as any)?.viewer?.splatMesh}`);

            if (uikaMode) {
                // ===== UIKA Native 133K hidden PoC =====
                // 通常の avatar-config camera / orbit-limits / 初期6° polar 補正は
                // 一切適用しない。meta.json の camera と H_head = 恒等だけを使う。
                // gate の判定は splat mesh が揃ってから uika-133k-mode 側が出す。
                applyUika133kMode(this.renderer, { getChatState: () => this.chatState });
                console.log('[LAMWebSocketManager][UIKA133K] mode 適用開始 '
                            + '(gate 判定は window.__uikaStatus を参照)');
                this._markModelReady('UIKA133K');
                console.log('[LAMWebSocketManager] モデルロード完了 (UIKA133K)');
                return;
            }

            // カメラ位置を調整してアバターの顔サイズ・位置を制御
            // avatar-config.json のcameraパラメータをlocalStorageから読み込み
            // offsetX: 横位置の平行移動 (pan)。camera.position.x と controls.target.x を
            //   **同じ量だけ** 動かすので、見る角度は変わらず画面内で左右にスライドするだけ。
            //   + で被写体が画面左へ、- で右へ動く (カメラの右方向 = world +x のため)。
            //   既定 0 = 従来どおり。avatar-config.json の camera に書ける。
            let camParams = { posY: 1.73, posZ: 0.4, targetY: 1.62, offsetX: 0 }; // デフォルト
            try {
                const storedCamera = localStorage.getItem(`selectedCamera_${mode}`);
                if (storedCamera) {
                    const parsed = JSON.parse(storedCamera);
                    camParams = {
                        posY: parsed.posY ?? 1.73,
                        posZ: parsed.posZ ?? 0.4,
                        targetY: parsed.targetY ?? 1.62,
                        offsetX: parsed.offsetX ?? 0,
                    };
                }
            } catch (e) {
                // パース失敗時はデフォルト使用
            }

            // 【調整用】URL で一時上書きできる (実機で数値を詰めてから config へ焼く)。
            //   ?camOffsetX=0.02&camTargetY=1.64&camPosY=1.73&camPosZ=0.45
            // 未指定の項目は config の値のまま。既定では何も変わらない。
            try {
                const q = new URLSearchParams(window.location.search);
                const num = (k: string) => {
                    const v = q.get(k);
                    if (v === null) return undefined;
                    const n = Number(v);
                    return Number.isFinite(n) ? n : undefined;
                };
                const ov = {
                    posY: num('camPosY'), posZ: num('camPosZ'),
                    targetY: num('camTargetY'), offsetX: num('camOffsetX'),
                };
                const applied: string[] = [];
                for (const k of ['posY', 'posZ', 'targetY', 'offsetX'] as const) {
                    if (ov[k] !== undefined) { camParams[k] = ov[k] as number; applied.push(`${k}=${ov[k]}`); }
                }
                if (applied.length) {
                    console.log('[LAMWebSocketManager] camera URL 上書き:', applied.join(' '));
                }
            } catch (e) { /* noop */ }

            if (this.renderer.viewer && this.renderer.viewer.camera) {
                const camera = this.renderer.viewer.camera;
                camera.position.z = camParams.posZ;
                camera.position.y = camParams.posY;
                // pan: camera と target を同量ずらす (角度は変えない)
                camera.position.x = camParams.offsetX;

                // 注視点（controls.target）を顔〜首の高さに合わせる
                const controls = this.renderer.viewer.controls;
                if (controls) {
                    controls.target.set(camParams.offsetX, camParams.targetY, 0);

                    // ★ カーソル操作の可動域制限（orbit-limits.jsonから読み込み）
                    try {
                        const resp = await fetch('/avatar/orbit-limits.json');
                        if (resp.ok) {
                            const limits = await resp.json();
                            if (typeof limits.minPolarAngle === 'number') controls.minPolarAngle = limits.minPolarAngle;
                            if (typeof limits.maxPolarAngle === 'number') controls.maxPolarAngle = limits.maxPolarAngle;
                            if (typeof limits.minAzimuthAngle === 'number') controls.minAzimuthAngle = limits.minAzimuthAngle;
                            if (typeof limits.maxAzimuthAngle === 'number') controls.maxAzimuthAngle = limits.maxAzimuthAngle;
                            if (typeof limits.minDistance === 'number') controls.minDistance = limits.minDistance;
                            if (typeof limits.maxDistance === 'number') controls.maxDistance = limits.maxDistance;
                            console.log('[LAMWebSocketManager] orbit-limits適用:', limits);
                        }
                    } catch (e) {
                        console.warn('[LAMWebSocketManager] orbit-limits.json読み込み失敗、制限なし', e);
                    }

                    // 初期カメラ角度を6°下向きに補正（カーソルで下にドラッグしたのと同等）
                    // 症状: アバターの視線がカメラ上方を向き、おでこ～頭頂部の面積が小さい
                    // 仕組み: 内蔵OrbitControls に setPolarAngle は無いため、camera.position を
                    //         target まわりに球面座標で回転させる。次フレームの update() が
                    //         position から spherical を再計算するので結果が維持される。
                    // 方向: ドラッグ下=phi減少=カメラが上側に回る=額が大きく見える
                    //       → 現 phi から 6° 引く
                    {
                        const tx = controls.target.x, ty = controls.target.y, tz = controls.target.z;
                        const dx = camera.position.x - tx;
                        const dy = camera.position.y - ty;
                        const dz = camera.position.z - tz;
                        const radius = Math.sqrt(dx * dx + dy * dy + dz * dz);
                        const horiz = Math.sqrt(dx * dx + dz * dz);
                        const currentPhi = Math.atan2(horiz, dy);       // polar angle (0=真上, π/2=水平, π=真下)
                        const currentTheta = Math.atan2(dx, dz);        // azimuth
                        const newPhi = currentPhi - (6 * Math.PI / 180);
                        // 球面座標 → 直交座標
                        const sinPhi = Math.sin(newPhi);
                        const newDx = radius * sinPhi * Math.sin(currentTheta);
                        const newDy = radius * Math.cos(newPhi);
                        const newDz = radius * sinPhi * Math.cos(currentTheta);
                        camera.position.set(tx + newDx, ty + newDy, tz + newDz);
                        console.log('[LAMWebSocketManager] 初期phi調整:',
                                    `${(currentPhi * 180 / Math.PI).toFixed(1)}° → ${(newPhi * 180 / Math.PI).toFixed(1)}°`,
                                    'radius=', radius.toFixed(3),
                                    'newPos=', camera.position.x.toFixed(3), camera.position.y.toFixed(3), camera.position.z.toFixed(3));
                    }

                    controls.update();
                }

                camera.updateProjectionMatrix();
                console.log('[LAMWebSocketManager] カメラ位置調整:',
                            'posY=', camParams.posY, 'posZ=', camParams.posZ,
                            'targetY=', camParams.targetY, 'offsetX=', camParams.offsetX,
                            '=> camera=', camera.position.x.toFixed(4), camera.position.y.toFixed(4), camera.position.z.toFixed(4),
                            'target=', controls?.target?.x?.toFixed(4), controls?.target?.y?.toFixed(4));
            }

            // PoC: FULL133 renderer cadence 回復 A/B (既定は何もしない)
            const pPerf = installRenderPerf(this.renderer)
                .then(p => { console.log('[PoC renderPerf]', JSON.stringify(p)); return p; });

            // PoC: splat sort の距離計算経路 (既定は何もしない)
            const sortMode = getSortMode();
            const pGpuSort = installSortMode(this.renderer, sortMode)
                .then(p => { console.log('[PoC gpuSort]', JSON.stringify(p)); return p; });

            // multi-bone skinning。mode は avatar-config から決まる (URL で上書き可)。
            const pSkin = installMultiBoneSkinning(this.renderer)
                .then(p => { console.log('[PoC skinMode]', JSON.stringify(p)); return p; });

            // 3 つの install がすべて確定してから run の前提条件を 1 行で出す。
            // `window.__multiBoneSkinPatch` / `window.__renderPerf` が揃ってからでないと
            // applied の判定ができないため、ここで待つ (isModelLoaded はブロックしない)。
            // adaptive sort は **最後**に入れる。gpuAcceleratedSort の実値を見て
            // backend を決めるので、installSortMode より後でないと取り違える。
            void Promise.all([pPerf, pGpuSort, pSkin])
                // FULL133 の正式 steady-state morph path。avatar-config から選ばれる。
                // multi-bone の shader patch が当たった後に入れる。
                .then(() => installFull133Runtime(this.renderer))
                .then(p => console.log('[FULL133 runtime]', JSON.stringify(p)))
                // GPU pre-deformation。aligned skin patch が当たった後の
                // vertex shader から morph loop を外すので、skin patch より後。
                .then(() => installFull133Predeform(this.renderer))
                .then(p => console.log('[FULL133 predeform]', JSON.stringify(p)))
                .then(() => installAdaptiveSort(this.renderer))
                .then(p => console.log('[PoC adaptiveSort]', JSON.stringify(p)))
                // FULL133 + スマホのときだけ drawing buffer の DPR を 1.0 に制限する。
                // sort / morph / predeform / skinning / shader には触らないので
                // 既存 install の順序は変えず、後ろへ独立 1 段として足す。
                .then(() => installFull133RenderBudget(this.renderer))
                .then(p => { if (p.applied || p.mobile) console.log('[FULL133 RenderBudget]', JSON.stringify(p)); return p; })
                // frame cost は **最後**。morph / sort の wrapper を外側から
                // 包んで「実際に掛かった時間」を測るので、全部入った後でないと
                // 出荷版の関数を直接包んでしまう (指示書 §13)。
                .then(() => installFrameCost(this.renderer))
                .then(p => console.log('[PoC frameCost]', JSON.stringify(p)))
                .then(() => logRunConfig(this.renderer, getDiagMode()))
                .catch(e => console.error('[PERF RUN CONFIG] 取得に失敗:', e));

            this._markModelReady('LAM');
            console.log('[LAMWebSocketManager] モデルロード完了');
        } catch (error) {
            console.error('[LAMWebSocketManager] 初期化エラー:', error);
            this.isModelLoaded = false;
        }
    }

    /**
     * `?morphProbe=1` の累積統計を console から読めるようにする (読み取りのみ)。
     *
     * - `__morphProbeReset()` : warm-up 後にここで 0 クリアしてから本計測に入る
     * - `__morphProbe()`      : run 全体の p50 / p95 / max / approxFps / samples
     *
     * percentile の計算は呼ばれたときだけ行う (毎フレーム sort しない)。
     */
    private _installMorphProbeApi(): void {
        const self = this;
        // tab が非前面になったら記録する。rAF が止まるので、その run は無効 (§8)。
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState !== 'visible') self._probeHidden++;
        });
        // A1 と D1 で viewport が 1707x898 / 1152x898 と違っていた (DevTools の
        // ドッキング変更)。4 run で揃っていないと A/B 比較にならないので数える。
        window.addEventListener('resize', () => { self._probeResized++; });
        /** warm-up 後にこれ 1 回で済むようにする (指示書 §12 / §13)。
         *  reset → 指定秒待つ → __morphProbe() を自動で出す。
         *  待っている間は画面も tab も触らないこと。 */
        (window as any).__morphProbeRun = (seconds = 60, expectViewport?: string) => {
            // viewport 不一致で run を 3 回無駄にしたので、開始前にここで弾く。
            // DevTools のドッキング位置を変えると viewport が変わり、
            // 指示書 §5 / §38 の「4 run で viewport が違ったら比較無効」に引っかかる。
            const vp = `${window.innerWidth}x${window.innerHeight}`;
            if (expectViewport && vp !== expectViewport) {
                console.error(`[MORPH PROBE] 計測を開始しませんでした。`
                    + ` viewport=${vp} ですが ${expectViewport} を期待しています。`
                    + ' DevTools のドッキング位置 / window サイズを直してリロードしてください。');
                return `aborted: viewport=${vp} (expected ${expectViewport})`;
            }
            (window as any).__morphProbeReset();
            self._probeViewportAtStart = vp;
            const until = new Date(Date.now() + seconds * 1000).toLocaleTimeString();
            console.log(`[MORPH PROBE] 計測開始。viewport=${vp}@${window.devicePixelRatio}。`
                + ` ${seconds} 秒後 (${until}) に自動で結果を出します。`
                + ' この間 tab / window を一切触らないでください。');
            setTimeout(() => (window as any).__morphProbe(), seconds * 1000);
            return `measuring ${seconds}s at ${vp}`;
        };
        (window as any).__morphProbeReset = () => {
            self._probeAll = [];
            self._probeAllLast = null;
            self._probeGaps = 0;
            self._probeHidden = 0;
            self._probeResized = 0;
            self._probeViewportAtStart = `${window.innerWidth}x${window.innerHeight}`;
            return 'reset (warm-up 後の計測開始点をここにしました)';
        };
        (window as any).__morphProbe = () => {
            const vpNow = `${window.innerWidth}x${window.innerHeight}`;
            const d = self._probeAll.slice().sort((a, b) => a - b);
            if (d.length < 2) {
                return { samples: d.length, verdict: 'INSUFFICIENT' };
            }
            const q = (pp: number) => d[Math.min(d.length - 1, Math.floor(pp * d.length))];
            const budgetMs = 1000 / 30;          // A2E frame_rate = 30 (live-audio-manager.ts:66)
            const p50 = q(0.5);
            const p95 = q(0.95);
            const over = d.filter(x => x >= budgetMs).length;
            // mean も出す。[A2E Sync] の offsetMs 差 / 60 は「60 フレームの平均」なので、
            // 過去のログの数字と突き合わせられるのは p50 ではなく mean。
            const mean = d.reduce((a, b) => a + b, 0) / d.length;
            const r = {
                samples: d.length,
                p50Ms: +p50.toFixed(2),
                p95Ms: +p95.toFixed(2),
                p99Ms: +q(0.99).toFixed(2),
                meanMs: +mean.toFixed(2),
                maxMs: +d[d.length - 1].toFixed(2),
                minMs: +d[0].toFixed(2),
                approxFps: +(1000 / p50).toFixed(1),
                budgetMs: +budgetMs.toFixed(2),
                overBudget: over + '/' + d.length,
                overBudgetPct: +(100 * over / d.length).toFixed(1),
                verdict: p95 < budgetMs ? 'PASS' : (p50 < budgetMs ? 'PARTIAL' : 'FAIL'),
                // run の有効性 (指示書 §9)。
                // droppedGaps は「統計から外した雑音」ではなく、foreground 中に
                // rAF が 500ms 以上止まった = 製品上の重大 stutter 候補なので、
                // 1 回でも出たらその run は正式比較に使わない。
                droppedGaps: self._probeGaps,
                backgroundEvents: self._probeHidden,
                resizeEvents: self._probeResized,
                // 計測窓の viewport。これが run の正本。
                // `runConfig.viewport` はページロード時のスナップショットなので、
                // ロード後に DevTools の配置を変えた run では別の値になる。
                // **計測窓の外での resize は欠陥ではない**ので runValid には入れない。
                // 窓の中が一貫していること (start === end かつ resizeEvents === 0) だけを見る。
                viewportAtStart: self._probeViewportAtStart,
                viewportAtEnd: vpNow,
                /** 参考情報。false なら「ロード後に resize した」という意味で、
                 *  run 間の比較には `viewportAtStart` を使う。 */
                viewportMatchesRunConfig: vpNow === (window as any).__runConfig?.viewport,
                runValid: (window as any).__runConfig?.valid === true
                    && self._probeHidden === 0
                    && self._probeGaps === 0
                    && self._probeResized === 0
                    && self._probeViewportAtStart === vpNow
                    && d.length >= 1000,
                runConfig: (window as any).__runConfig ?? null,
                renderPerf: (window as any).__renderPerf ?? null,
                adaptiveSort: (window as any).__adaptiveSort ?? null,
            };
            console.log('[MORPH PROBE TOTAL]', JSON.stringify(r));
            return r;
        };
    }

    /**
     * コールバック: 現在のexpressionデータをブレンドシェイプmapとして返す
     */
    /**
     * モデルのロード完了をマークする。
     * これも「表示準備完了」であって実描画ではない（signal にはしない）。
     */
    private _markModelReady(label: string): void {
        this.isModelLoaded = true;
        console.log(`[AVATAR] model_ready t=${performance.now().toFixed(1)}ms (${label})`);
    }

    /**
     * FIRST_VALID_FRAME_RENDERED のリスナ登録。
     * 登録順に依存しないよう、既に成立していれば即座に通知する。
     */
    onFirstValidFrame(listener: (info: FirstValidFrameInfo) => void): void {
        this.firstValidFrameListener = listener;
        if (this.firstValidFrameReported && this.firstValidFrameInfo) {
            try { listener(this.firstValidFrameInfo); }
            catch (e) { console.warn('[AVATAR] first_valid_frame listener エラー:', e); }
        }
    }

    /** FIRST_VALID_FRAME_RENDERED が既に成立しているか（診断用） */
    hasRenderedFirstValidFrame(): boolean {
        return this.firstValidFrameReported;
    }

    /**
     * AVATAR_VISIBLE のリスナ登録。
     * 登録順に依存しないよう、既に成立していれば即座に通知する。
     */
    onAvatarVisible(listener: (info: AvatarVisibleInfo) => void): void {
        this.avatarVisibleListener = listener;
        if (this.avatarVisibleReported && this.avatarVisibleInfo) {
            try { listener(this.avatarVisibleInfo); }
            catch (e) { console.warn('[AVATAR] visible listener エラー:', e); }
        }
    }

    /** AVATAR_VISIBLE が既に成立しているか（診断用） */
    isAvatarVisible(): boolean {
        return this.avatarVisibleReported;
    }

    /**
     * FIRST_VALID_FRAME_RENDERED の観測。
     *
     * 判定条件（すべて成立して初めて発火する）:
     *   1. Avatar model が scene に存在する      … viewer.splatMesh があり scenes.length > 0
     *   2. 描画対象 splat が存在する              … geometry.instanceCount > 0
     *   3. 描画処理へ有効な geometry が渡った      … geometry.drawRange.count > 0
     *   4. firstRenderTime が未設定値から有効値へ  … splatMesh.firstRenderTime >= 0（初期値 -1）
     *
     * renderer が render loop から毎フレーム呼ぶ getExpressionData() の中で
     * 観測するので、新しい loop / setInterval / 固定待機 / monkey patch を作らない。
     * node_modules は読むだけで一切変更しない。
     */
    private _observeFirstValidFrame(): void {
        if (this.avatarVisibleReported) return;

        const viewer = (this.renderer as any)?.viewer;
        if (!viewer) return;
        const splatMesh = viewer.splatMesh;
        if (!splatMesh) return;                                   // 1
        const scenes = splatMesh.scenes;
        if (!scenes || scenes.length === 0) return;               // 1
        const geometry = splatMesh.geometry;
        if (!geometry) return;
        const renderSplatCount = geometry.instanceCount;
        if (!(renderSplatCount > 0)) return;                      // 2
        const drawRange = geometry.drawRange;
        if (!drawRange || !(drawRange.count > 0)) return;         // 3
        const firstRenderTime = splatMesh.firstRenderTime;
        if (typeof firstRenderTime !== 'number' || firstRenderTime < 0) return;  // 4

        // ===== 段階 1: FIRST_VALID_FRAME_RENDERED（技術 signal）=====
        if (!this.firstValidFrameReported) {
            const observedAt = performance.now();
            const info: FirstValidFrameInfo = {
                firstRenderTime,
                observedAt,
                renderSplatCount,
                sceneCount: scenes.length,
                delayFromRenderMs: observedAt - firstRenderTime,
            };
            this.firstValidFrameReported = true;
            this.firstValidFrameInfo = info;
            // barrier の基準点。この frame の viewer.render() はこの後に走る。
            this._prevConsecutiveRenderFrames = viewer.consecutiveRenderFrames || 0;
            this._rendersSinceFirstValidFrame = 0;

            console.log('[AVATAR] first_valid_frame_rendered'
                + ` t=${observedAt.toFixed(1)}ms`
                + ` firstRenderTime=${firstRenderTime.toFixed(1)}ms`
                + ` delay=${info.delayFromRenderMs.toFixed(1)}ms`
                + ` splats=${renderSplatCount}`
                + ` scenes=${info.sceneCount}`
                + ` consecutiveRenderFrames=${this._prevConsecutiveRenderFrames}`);

            if (this.firstValidFrameListener) {
                try { this.firstValidFrameListener(info); }
                catch (e) { console.warn('[AVATAR] first_valid_frame listener エラー:', e); }
            }
            // ★ 同一 call stack で AVATAR_VISIBLE を出さない。
            //   この frame の viewer.render() はこの callback の後に実行される。
            return;
        }

        // ===== 段階 2: presentation barrier → AVATAR_VISIBLE =====
        // GaussianSplatRenderer.render() は 1 frame につき
        //   getExpressionData()（ここ） -> viewer.update() -> viewer.render()
        //   -> consecutiveRenderFrames++
        // の順に実行する（module.js:152436-152467）。
        // したがって次以降の frame で consecutiveRenderFrames が進んでいれば、
        // 有効 geometry を使った viewer.render() が完了している。
        // shouldRender() が false の frame では 0 にリセットされるため、
        // 差分ではなくリセットも数えられる形で積算する。
        const consecutive = viewer.consecutiveRenderFrames || 0;
        const prev = this._prevConsecutiveRenderFrames;
        const rendered = consecutive > prev ? consecutive - prev : consecutive;
        this._prevConsecutiveRenderFrames = consecutive;
        this._rendersSinceFirstValidFrame += rendered;
        if (this._rendersSinceFirstValidFrame < 1) return;

        const visibleAt = performance.now();
        const base = this.firstValidFrameInfo as FirstValidFrameInfo;
        const vinfo: AvatarVisibleInfo = {
            ...base,
            visibleAt,
            barrierMs: visibleAt - base.observedAt,
            rendersSinceFirstValidFrame: this._rendersSinceFirstValidFrame,
        };
        this.avatarVisibleReported = true;
        this.avatarVisibleInfo = vinfo;

        console.log('[AVATAR] visible'
            + ` t=${visibleAt.toFixed(1)}ms`
            + ` barrier=${vinfo.barrierMs.toFixed(1)}ms`
            + ` renders=${vinfo.rendersSinceFirstValidFrame}`
            + ` splats=${vinfo.renderSplatCount}`);

        if (this.avatarVisibleListener) {
            try { this.avatarVisibleListener(vinfo); }
            catch (e) { console.warn('[AVATAR] visible listener エラー:', e); }
        }
    }

    private _getExpressionData(): Record<string, number> {
        // ★ 既存の per-frame callback 内で観測する（Phase 3）。
        //   morphProbe の early return より前に置くので全モードで観測される。
        this._observeFirstValidFrame();

        const result: Record<string, number> = {};

        // ===== 診断専用: 人工 morph プローブ =====
        // `?morphProbe=1` のときだけ、A2E 経路を一切通さず
        // performance.now() から毎フレーム直接 jawOpen を算出して返す。
        // 累積カウンタや setInterval は使わないので、描画フレームが飛んでも
        // 「その時刻に対応する正しい jawOpen」になる。
        // 日本語口形補正や A2E 後処理はこの経路では通さない (両モデルへ同一値を入れる)。
        if (this.morphProbe) {
            const now = performance.now();
            for (const name of this.expressionNames) result[name] = 0;
            const phase = (now % 1000) / 1000;
            const jawOpen = 0.4 - 0.4 * Math.cos(phase * Math.PI * 2);
            result.jawOpen = jawOpen;

            // renderer の呼び出し間隔だけを測る (直近 120 サンプル、2 秒ごとに 1 行)
            this._probeTimes.push(now);
            if (this._probeTimes.length > 120) this._probeTimes.shift();

            // 累積: run 全体の p50/p95/max を 1 つの数字で出せるようにする。
            if (this._probeAllLast !== null) {
                const d = now - this._probeAllLast;
                // tab 非前面などで rAF が止まった区間は統計から外す。
                if (d > 0 && d < 500) {
                    this._probeAll.push(d);
                    if (this._probeAll.length > 20000) this._probeAll.shift();
                } else {
                    // rAF が止まっていた区間。統計には入れないが、回数は残す。
                    this._probeGaps++;
                }
            }
            this._probeAllLast = now;
            if (!this._probeApiInstalled) {
                this._probeApiInstalled = true;
                this._installMorphProbeApi();
            }
            if (now - this._probeLogAt >= 2000) {
                this._probeLogAt = now;
                const t = this._probeTimes;
                if (t.length > 2) {
                    const d: number[] = [];
                    for (let i = 1; i < t.length; i++) d.push(t[i] - t[i - 1]);
                    d.sort((a, b) => a - b);
                    const q = (pp: number) => d[Math.min(d.length - 1, Math.floor(pp * d.length))];
                    const p50 = q(0.5);
                    console.log(
                        '[MORPH PROBE]'
                        + ' avatar=' + (isUika133kMode() ? 'UIKA' : 'LAM')
                        + ' avatarId=' + getAvatarIdForDiag()
                        + ' samples=' + t.length
                        + ' p50Ms=' + p50.toFixed(1)
                        + ' p95Ms=' + q(0.95).toFixed(1)
                        + ' maxMs=' + d[d.length - 1].toFixed(1)
                        + ' approxFps=' + (p50 > 0 ? (1000 / p50).toFixed(1) : '-')
                        + ' jawOpen=' + jawOpen.toFixed(3)
                    );
                }
            }
            return result;
        }

        // frame の取得元だけが通常 LAM と UIKA で違う。
        // provider があれば描画瞬間に直接引く (古い cache を使わない)。
        // 以降の処理 (全0 の静止状態 / 日本語口形補正) は両経路で完全に同じ。
        let frame: ExpressionFrame | null;
        if (this.a2eReplay) {
            // ?a2eReplay=1: Live 通信を一切使わず、保存済みの実 A2E シーケンスから
            // 「現在時刻に対応する frame」を選ぶ。以降の処理は本番と同一。
            if (!this.replayInitTried) {
                this.replayInitTried = true;
                this.replayPlayer = createA2EReplayPlayer();
                if (this.replayPlayer) {
                    // name マッピングも本番と同じにするため capture 時の名前順をそのまま使う
                    this.setExpressionNames(this.replayPlayer.expressionNames);
                }
            }
            frame = this.replayPlayer ? this.replayPlayer.getFrame() : null;
        } else {
            frame = this.expressionProvider
                ? this.expressionProvider()
                : this.currentExpression;
        }

        // ===== 診断ログ (TRACE A2E RENDER) =====
        // renderer が expression を読んだ瞬間の同期状態。frame の選び方は変えていない。
        if (this.exprTrace && !this.a2eReplay) {
            try {
                const st = this.exprTrace.getState();
                const now = performance.now();

                // --- 画面表示用の集計 (DevTools を開かずに読めるようにする) ---
                const w = window as any;
                let agg = w.__uikaA2EStats;
                if (!agg || agg.exprPath !== this.exprTrace.path) {
                    agg = w.__uikaA2EStats = {
                        exprPath: this.exprTrace.path,
                        renderTimes: [] as number[],
                        clampCount: 0, clampTotalMs: 0, clampMaxMs: 0,
                        clampOpenAt: null as number | null,
                        maxLag: 0,
                        firstExprPlaybackMs: null as number | null,
                        firstExprCoverageMs: null as number | null,
                        catchUpPlaybackMs: null as number | null,
                        last: null as any,
                    };
                }
                agg.renderTimes.push(now);
                if (agg.renderTimes.length > 4000) agg.renderTimes.shift();
                const lag = st.requestedFrame - st.selectedFrame;
                if (lag > agg.maxLag) agg.maxLag = lag;
                if (st.bufferFrames > 0 && agg.firstExprPlaybackMs === null) {
                    agg.firstExprPlaybackMs = st.playbackMs;
                    agg.firstExprCoverageMs = st.bufferFrames / st.fps * 1000;
                }
                if (st.clamped && agg.clampOpenAt === null && st.bufferFrames > 0) {
                    agg.clampOpenAt = now; agg.clampCount++;
                } else if (!st.clamped && agg.clampOpenAt !== null) {
                    const dur = now - agg.clampOpenAt;
                    agg.clampTotalMs += dur;
                    if (dur > agg.clampMaxMs) agg.clampMaxMs = dur;
                    agg.clampOpenAt = null;
                    if (agg.catchUpPlaybackMs === null) agg.catchUpPlaybackMs = st.playbackMs;
                }
                agg.last = st;
                if (this._shouldTrace(now, this._traceRenderAt, this._traceRenderSel,
                                      this._traceRenderClamped, st.selectedFrame, st.clamped)) {
                    this._traceRenderAt = now;
                    this._traceRenderSel = st.selectedFrame;
                    this._traceRenderClamped = st.clamped;
                    console.log(
                        `[TRACE A2E RENDER] exprPath=${this.exprTrace.path} `
                        + `perfMs=${now.toFixed(1)} playbackMs=${st.playbackMs.toFixed(1)} `
                        + `fps=${st.fps} bufferFrames=${st.bufferFrames} `
                        + `coverageMs=${(st.bufferFrames / st.fps * 1000).toFixed(1)} `
                        + `requestedFrame=${st.requestedFrame} selectedFrame=${st.selectedFrame} `
                        + `clamped=${st.clamped} frame=${frame ? 'yes' : 'null'}`
                    );
                }
            } catch (e) { /* noop */ }
        }

        if (!frame) {
            // 静止状態: 全て0
            for (const name of this.expressionNames) {
                result[name] = 0;
            }
            return result;
        }

        const values = frame.values;
        for (let i = 0; i < Math.min(values.length, this.expressionNames.length); i++) {
            result[this.expressionNames[i]] = values[i];
        }

        // === STEP1: 日本語口形補正 ===
        // 案B: 静的スケーリング（全体適用）
        const JP_SCALING: Record<string, number> = {
            'mouthStretchLeft':  1.3,
            'mouthStretchRight': 1.3,
            'jawOpen':           0.85,
            'mouthFunnel':       1.1,
            'mouthPucker':       1.1,
        };
        for (const [name, scale] of Object.entries(JP_SCALING)) {
            if (result[name] !== undefined) {
                result[name] = Math.min(1.0, result[name] * scale);
            }
        }

        // 案A: ブレンドシェイプ間の関係制約（イ/エ系でjawOpen追加抑制）
        const stretchL = result['mouthStretchLeft'] ?? 0;
        const stretchR = result['mouthStretchRight'] ?? 0;
        const avgStretch = (stretchL + stretchR) / 2;
        if (avgStretch > 0.2) {
            const suppressionFactor = 1.0 - avgStretch * 0.5;
            result['jawOpen'] *= Math.max(0.3, suppressionFactor);
        }

        // === STEP2: 小さすぎる口の動き対策 ===
        // バイアス: jawOpenが0.015〜0.05の区間を0.05に底上げ（もごもご対策）
        // 0.015未満は底上げしない（A2E最終フレームが0.007〜0.013程度で終わるため）
        const jawOpen = result['jawOpen'] ?? 0;
        if (jawOpen >= 0.015 && jawOpen < 0.05) {
            result['jawOpen'] = 0.05;
        }

        // スムージング: 一時無効化（口閉じ遅延の切り分けテスト）
        // const MOUTH_SHAPES = [
        //     'jawOpen', 'jawForward', 'jawLeft', 'jawRight',
        //     'mouthClose', 'mouthFunnel', 'mouthPucker', 'mouthLeft', 'mouthRight',
        //     'mouthSmileLeft', 'mouthSmileRight', 'mouthFrownLeft', 'mouthFrownRight',
        //     'mouthDimpleLeft', 'mouthDimpleRight', 'mouthStretchLeft', 'mouthStretchRight',
        //     'mouthRollLower', 'mouthRollUpper', 'mouthShrugLower', 'mouthShrugUpper',
        //     'mouthPressLeft', 'mouthPressRight', 'mouthLowerDownLeft', 'mouthLowerDownRight',
        //     'mouthUpperUpLeft', 'mouthUpperUpRight',
        // ];
        // const SMOOTH_ALPHA = 0.45;
        // for (const name of MOUTH_SHAPES) {
        //     if (result[name] !== undefined) {
        //         const prev = this._prevMouthValues[name] ?? 0;
        //         result[name] = prev * (1 - SMOOTH_ALPHA) + result[name] * SMOOTH_ALPHA;
        //         this._prevMouthValues[name] = result[name];
        //     }
        // }

        // デバッグ: 120フレームごと（約2秒）にログ出力
        this._exprDebugCounter++;
        if (this._exprDebugCounter % 120 === 0) {
            const jawOpen = result['jawOpen'] ?? 'N/A';
            const mouthOpen = result['mouthOpen'] ?? 'N/A';
            const nonZero = Object.entries(result).filter(([, v]) => v > 0.01).length;
            console.log(
                `[LAM ExprData] jawOpen=${typeof jawOpen === 'number' ? jawOpen.toFixed(3) : jawOpen}, ` +
                `mouthOpen=${typeof mouthOpen === 'number' ? mouthOpen.toFixed(3) : mouthOpen}, ` +
                `nonZero=${nonZero}/${this.expressionNames.length}, ` +
                `valuesLen=${values.length}, namesLen=${this.expressionNames.length}`
            );
        }

        return result;
    }

    /**
     * expression フレームを更新
     * (通常 LAM 経路。AudioSyncPlayer の rAF から呼ばれる)
     */
    updateExpression(frame: ExpressionFrame | null): void {
        this.currentExpression = frame;

        // ===== 診断ログ (TRACE A2E CACHE) =====
        // AudioSyncPlayer の rAF が cache を更新した瞬間。代入処理は変えていない。
        if (this.exprTrace) {
            try {
                const st = this.exprTrace.getState();
                const now = performance.now();
                if (this._shouldTrace(now, this._traceCacheAt, this._traceCacheSel,
                                      this._traceCacheClamped, st.selectedFrame, st.clamped)) {
                    this._traceCacheAt = now;
                    this._traceCacheSel = st.selectedFrame;
                    this._traceCacheClamped = st.clamped;
                    console.log(
                        `[TRACE A2E CACHE] exprPath=${this.exprTrace.path} `
                        + `perfMs=${now.toFixed(1)} playbackMs=${st.playbackMs.toFixed(1)} `
                        + `fps=${st.fps} bufferFrames=${st.bufferFrames} `
                        + `coverageMs=${(st.bufferFrames / st.fps * 1000).toFixed(1)} `
                        + `requestedFrame=${st.requestedFrame} selectedFrame=${st.selectedFrame} `
                        + `clamped=${st.clamped} frame=${frame ? 'yes' : 'null'}`
                    );
                }
            } catch (e) { /* noop */ }
        }
    }

    /**
     * expression フレームの直接取得関数を設定する (UIKA mode 専用)。
     * 設定すると `_getExpressionData()` は cache ではなくこの関数を使う。
     * `null` を渡すと通常 LAM 経路 (cache) に戻る。
     */
    setExpressionProvider(provider: (() => ExpressionFrame | null) | null): void {
        this.expressionProvider = provider;
    }

    /**
     * 【診断専用】トレースを有効にする。UIKA 診断 URL からのみ呼ばれる。
     */
    setExpressionTrace(
        path: string,
        getState: () => {
            playbackMs: number; bufferFrames: number; fps: number;
            requestedFrame: number; selectedFrame: number; clamped: boolean;
        },
    ): void {
        this.exprTrace = { path, getState };
    }

    /**
     * 間引き判定: 250ms 経過 / clamped の変化 / selectedFrame が 10 フレーム超飛んだ
     * のいずれかで true。
     */
    private _shouldTrace(
        now: number, lastAt: number, prevSel: number, prevClamped: boolean | null,
        sel: number, clamped: boolean,
    ): boolean {
        if (now - lastAt >= 250) return true;
        if (prevClamped !== clamped) return true;
        if (prevSel >= 0 && Math.abs(sel - prevSel) > 10) return true;
        return false;
    }

    /**
     * チャット状態を更新
     */
    setChatState(state: string): void {
        this.chatState = state;
    }

    /**
     * ブレンドシェイプ名リストを設定
     */
    setExpressionNames(names: string[]): void {
        if (names && names.length > 0) {
            this.expressionNames = names;
        }
    }

    /**
     * モデルがロード済みかどうか
     */
    isLoaded(): boolean {
        return this.isModelLoaded;
    }

    /**
     * expression バッファをクリア（リセット）
     */
    resetExpression(): void {
        this.currentExpression = null;
        this.chatState = 'Idle';
    }

    /**
     * クリーンアップ
     */
    dispose(): void {
        this.renderer = null;
        this.isModelLoaded = false;
        // ★ Avatar lifecycle の終端。次の lifecycle で再び 1 回だけ発火できるようにする。
        this.firstValidFrameReported = false;
        this.firstValidFrameInfo = null;
        this.avatarVisibleReported = false;
        this.avatarVisibleInfo = null;
        this._prevConsecutiveRenderFrames = 0;
        this._rendersSinceFirstValidFrame = 0;
        this.currentExpression = null;
        this.expressionProvider = null;
        this.exprTrace = null;
    }
}
