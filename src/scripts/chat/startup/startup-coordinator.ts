// src/scripts/chat/startup/startup-coordinator.ts
/**
 * 起動状態管理の唯一の所有者 (指示書 §9)。
 *
 * ここが持つのは次だけ:
 *   Avatar prepare の開始 / Waiting 制御 / Avatar Visible の確認 /
 *   reset #2 へ進むタイミング / 計測
 *
 * session / A2E / audio 同期ロジックはここへ移植しない。
 * Startup MUTE は Phase B-3 で追加する (この段階では持たない)。
 */

import { mark } from './startup-metrics';
import {
    startAvatarPrepare, getAvatarPreparePromise, waitAvatarSettled,
    type AvatarSettleKind,
} from './avatar-prepare';

export type StartupPhase =
    | 'BOOT'
    | 'WARMUP'
    | 'AVATAR_READY'
    | 'FINAL_RESET'
    | 'RUNNING';

/** Waiting の表示先。core-controller から要素を渡してもらう。 */
export interface WaitingElements {
    splashOverlay: HTMLElement | null;
    splashVideo: HTMLVideoElement | null;
    /** アバター内の待機アニメ (splash と二重に見せないため) */
    avatarLoading: HTMLElement | null;
}

export class StartupCoordinator {
    private phase: StartupPhase = 'BOOT';
    /** 古い起動処理が後から UI を書き換えないようにする (指示書 §14.4)。 */
    private generation: number = 0;
    private els: WaitingElements = {
        splashOverlay: null, splashVideo: null, avatarLoading: null,
    };
    private waitingVisible: boolean = true;
    private safetyTimer: any = null;
    /** 安全網が発火したことを知らせる (起動を永久に止めないため)。 */
    private safetyFired: (() => void) | null = null;
    private safetyGate: Promise<'TIMEOUT'> | null = null;
    /** prepare が reject したら FALLBACK 相当として扱う。 */
    private preparePromise: Promise<void> | null = null;

    getPhase(): StartupPhase {
        return this.phase;
    }

    isStartupFinished(): boolean {
        return this.phase === 'RUNNING';
    }

    /** 現在の世代番号。非同期完了時の照合に使う。 */
    currentGeneration(): number {
        return this.generation;
    }

    isCurrent(generation: number): boolean {
        return generation === this.generation;
    }

    /**
     * 起動開始。Waiting を出し、Avatar prepare を 1 度だけ開始する。
     * 戻り値はこの起動の世代番号。
     */
    begin(els: WaitingElements, liveAudioManager: any): number {
        this.generation++;
        this.phase = 'BOOT';
        this.els = els;
        mark('APP_START');
        this.setWaiting(true);
        // 並列化するのは Avatar の download / renderer 初期化だけ (指示書 §3)。
        this.preparePromise = getAvatarPreparePromise()
            ?? startAvatarPrepare(liveAudioManager);
        // 失敗しても起動を止めない (prepare 自体の reject はここで吸収する)。
        void this.preparePromise.catch(() => undefined);
        return this.generation;
    }

    /** reset #1 を開始する直前。 */
    enterWarmup(): void {
        this.phase = 'WARMUP';
    }

    /**
     * Avatar が **実際に画面へ出た** ことを待つ (指示書 §7)。
     *
     *   READY (renderer 初期化完了) / FALLBACK (2D 表示) のどちらかで settle
     *   → 固定時間 sleep ではなく rAF を 2 回通して実描画 frame を確認
     *
     * 必ず戻る。戻れなくなる経路を 3 つとも閉じてある:
     *   - prepare が reject した場合は FALLBACK 相当として進む
     *   - Avatar が READY / FALLBACK のどちらも通知しないまま固まった場合は
     *     既存の安全網 (従来の 10 秒 splash タイマー相当) で進む
     *   - 世代が変わっていたら何もせず戻る
     * ここで Avatar のロード自体をキャンセルはしない (指示書 §14.4)。
     */
    async awaitAvatarVisible(generation: number): Promise<AvatarSettleKind> {
        let kind: AvatarSettleKind = 'FALLBACK';
        const races: Promise<AvatarSettleKind | 'TIMEOUT'>[] = [waitAvatarSettled()];
        if (this.preparePromise) {
            const onPrepareSettled = async (): Promise<AvatarSettleKind> => {
                try {
                    await this.preparePromise;
                } catch (e) {
                    // prepare が失敗したら 2D fallback 相当として起動を続ける
                    return 'FALLBACK';
                }
                return waitAvatarSettled();
            };
            races.push(onPrepareSettled());
        }
        if (this.safetyGate) races.push(this.safetyGate);
        try {
            const r = await Promise.race(races);
            if (r === 'TIMEOUT') {
                console.warn('[Startup] Avatar の表示通知が来ないため安全網で起動を続行');
            } else {
                kind = r;
            }
        } catch (e) {
            console.error('[Startup] Avatar settle 待ちで例外:', e);
        }
        if (!this.isCurrent(generation)) return kind;
        this.phase = 'AVATAR_READY';
        mark('AVATAR_READY');
        await this.nextFrames(2);
        if (!this.isCurrent(generation)) return kind;
        mark('AVATAR_VISIBLE');
        console.log(`[Startup] AVATAR_VISIBLE (${kind})`);
        return kind;
    }

    /** Waiting を外す。StartupCoordinator だけが呼ぶ (指示書 §8)。 */
    hideWaiting(generation: number): void {
        if (!this.isCurrent(generation)) return;
        this.setWaiting(false);
    }

    /** reset #2 へ入る。 */
    enterFinalReset(): void {
        this.phase = 'FINAL_RESET';
    }

    /** 起動完了。以降 resetAppContent() は従来どおり動く (指示書 §15)。 */
    enterRunning(): void {
        this.phase = 'RUNNING';
        this.clearSafetyTimer();
        console.log('[Startup] phase=RUNNING');
    }

    /**
     * 何があっても Waiting を残さないための安全網。
     * 既存の 10 秒 splash タイマー相当をここに集約する。
     */
    armSafetyTimeout(generation: number, ms: number): void {
        this.clearSafetyTimer();
        this.safetyGate = new Promise<'TIMEOUT'>((resolve) => {
            this.safetyFired = () => resolve('TIMEOUT');
        });
        this.safetyTimer = setTimeout(() => {
            this.safetyFired?.();
            if (!this.isCurrent(generation)) return;
            if (!this.waitingVisible) return;
            console.warn(`[Startup] Waiting 安全網 (${ms}ms) で強制解除`);
            this.setWaiting(false);
        }, ms);
    }

    /**
     * 実描画 frame を指定回数通す (指示書 §7)。
     * 固定時間 sleep は使わない。
     */
    private nextFrames(count: number): Promise<void> {
        return new Promise<void>((resolve) => {
            let left = Math.max(1, count);
            const tick = () => {
                left--;
                if (left <= 0) { resolve(); return; }
                requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
        });
    }

    private clearSafetyTimer(): void {
        if (this.safetyTimer !== null) {
            clearTimeout(this.safetyTimer);
            this.safetyTimer = null;
        }
    }

    /**
     * Waiting の表示切替。
     *
     * splash overlay は背景色を持たず中央の video 以外が透過するため、
     * アバター内の待機アニメ (`#lamAvatarLoading`) が同時に見えると
     * 待機アニメが 2 つに見える。splash を出している間は後者を隠す。
     */
    private setWaiting(visible: boolean): void {
        this.waitingVisible = visible;
        const { splashOverlay, splashVideo, avatarLoading } = this.els;
        if (visible) {
            avatarLoading?.classList.add('hidden');
            return;
        }
        if (splashVideo) splashVideo.loop = false;
        if (splashOverlay && !splashOverlay.classList.contains('hidden')) {
            splashOverlay.classList.add('fade-out');
            setTimeout(() => splashOverlay.classList.add('hidden'), 800);
        }
        // Avatar は表示済みなので待機アニメは出さない
        avatarLoading?.classList.add('hidden');
    }
}

/** アプリ全体で 1 つ。 */
export const startupCoordinator = new StartupCoordinator();
