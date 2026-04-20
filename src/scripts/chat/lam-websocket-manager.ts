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

export class LAMWebSocketManager {
    private renderer: GaussianSplats3D.GaussianSplatRenderer | null = null;
    private isModelLoaded: boolean = false;
    private _exprDebugCounter: number = 0;  // デバッグログ間引き用
    private _prevMouthValues: Record<string, number> = {};  // スムージング用前フレーム値

    // 現在適用中の expression フレーム
    private currentExpression: ExpressionFrame | null = null;

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
            await ensureDefaultAvatarInStorage(mode);

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

            // カメラ位置を調整してアバターの顔サイズ・位置を制御
            // avatar-config.json のcameraパラメータをlocalStorageから読み込み
            let camParams = { posY: 1.73, posZ: 0.4, targetY: 1.62 }; // デフォルト
            try {
                const storedCamera = localStorage.getItem(`selectedCamera_${mode}`);
                if (storedCamera) {
                    const parsed = JSON.parse(storedCamera);
                    camParams = { posY: parsed.posY ?? 1.73, posZ: parsed.posZ ?? 0.4, targetY: parsed.targetY ?? 1.62 };
                }
            } catch (e) {
                // パース失敗時はデフォルト使用
            }

            if (this.renderer.viewer && this.renderer.viewer.camera) {
                const camera = this.renderer.viewer.camera;
                camera.position.z = camParams.posZ;
                camera.position.y = camParams.posY;

                // 注視点（controls.target）を顔〜首の高さに合わせる
                const controls = this.renderer.viewer.controls;
                if (controls) {
                    controls.target.set(0, camParams.targetY, 0);

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

                    // 初期カメラ角度を15°下向きに補正（カーソルで下にドラッグしたのと同等）
                    // 症状: アバターの視線がカメラ上方を向き、おでこ～頭頂部の面積が小さい
                    // 仕組み: 内蔵OrbitControls に setPolarAngle は無いため、camera.position を
                    //         target まわりに球面座標で回転させる。次フレームの update() が
                    //         position から spherical を再計算するので結果が維持される。
                    // 方向: ドラッグ下=phi減少=カメラが上側に回る=額が大きく見える
                    //       → 現 phi から 15° 引く
                    {
                        const tx = controls.target.x, ty = controls.target.y, tz = controls.target.z;
                        const dx = camera.position.x - tx;
                        const dy = camera.position.y - ty;
                        const dz = camera.position.z - tz;
                        const radius = Math.sqrt(dx * dx + dy * dy + dz * dz);
                        const horiz = Math.sqrt(dx * dx + dz * dz);
                        const currentPhi = Math.atan2(horiz, dy);       // polar angle (0=真上, π/2=水平, π=真下)
                        const currentTheta = Math.atan2(dx, dz);        // azimuth
                        const newPhi = currentPhi - (15 * Math.PI / 180);
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
                console.log('[LAMWebSocketManager] カメラ位置調整: y=', camera.position.y, 'z=', camera.position.z, 'target.y=', controls?.target?.y);
            }

            this.isModelLoaded = true;
            console.log('[LAMWebSocketManager] モデルロード完了');
        } catch (error) {
            console.error('[LAMWebSocketManager] 初期化エラー:', error);
            this.isModelLoaded = false;
        }
    }

    /**
     * コールバック: 現在のexpressionデータをブレンドシェイプmapとして返す
     */
    private _getExpressionData(): Record<string, number> {
        const result: Record<string, number> = {};

        if (!this.currentExpression) {
            // 静止状態: 全て0
            for (const name of this.expressionNames) {
                result[name] = 0;
            }
            return result;
        }

        const values = this.currentExpression.values;
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
     */
    updateExpression(frame: ExpressionFrame | null): void {
        this.currentExpression = frame;
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
        this.currentExpression = null;
    }
}
