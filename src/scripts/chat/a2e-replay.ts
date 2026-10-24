// src/scripts/chat/a2e-replay.ts
/**
 * 【診断専用】実 A2E データの固定リプレイ
 *
 * 目的:
 *   人工 jawOpen (?morphProbe=1) は LAM / UIKA 両方で滑らかだった。
 *   次の問いは「実際の A2E 52 係数を入れたときに差が出るか」である。
 *   そのため、1 回の正常な A2E 受信データを固定保存し、
 *   Live 通信 (Gemini / 音声 / Socket.IO / AudioContext / LiveAudioManager の
 *   時刻同期 / chunk 到着タイミング) を一切通さずに再生する。
 *
 *   逆に、以下は本番とまったく同じ経路を通す:
 *     実 A2E 52 係数 / expression_names / LAMWebSocketManager の name マッピング /
 *     日本語口形補正 / renderer への expression map / UIKA D_UIKA
 *
 * URL:
 *   ?a2eCapture=1  … live_expression をそのまま保存する (発話 1 回)
 *   ?a2eReplay=1   … 保存済みデータを performance.now() 基準で再生する
 *
 * ?morphProbe=1 とは完全に別モード。同時指定は禁止 (両方無効化し、暗黙の優先順位は作らない)。
 */

import type { ExpressionFrame } from './live-audio-manager';

const STORAGE_KEY = 'a2eCapture.v1';

/** リプレイ 1 周の末尾に挟む静止区間。ループの折り返しを口閉じ状態から始めるため。 */
const LOOP_GAP_MS = 1000;

export interface CapturedA2E {
    /** A2E の frame_rate (受信値そのまま) */
    fps: number;
    /** A2E の expression_names (受信値そのまま) */
    expression_names: string[];
    /** 全 chunk の expressions を到着順に単純連結した 1 本のシーケンス (変換なし) */
    frames: number[][];
    /** 参考情報のみ。リプレイでは使用しない。 */
    chunks: { chunk_index: unknown; frames: number; perfMs: number }[];
    capturedAt: string;
}

export type DiagMode = 'none' | 'morphProbe' | 'a2eReplay' | 'conflict';

/**
 * 【診断専用・read-only】リプレイ中の「描画 cadence」と「A2E frame 選択」の集計。
 *
 * **frame の選び方は一切変えない。** `A2EReplayPlayer.getFrame()` が決めた
 * index を後から観測して数えるだけ。定義:
 *
 *     ΔselectedFrame === 0  -> repeat (同じ A2E frame を 2 回以上描いた)
 *     ΔselectedFrame  >  1  -> skip   (A2E frame を飛ばした / 補間は無いので丸ごと欠落)
 *
 * ループ折り返し (末尾 gap) をまたぐ差分は jump として数えない。
 */
export interface A2EReplayStats {
    /** renderer が expression を読んだ回数 (= getFrame 呼び出し回数) */
    readCount: number;
    /** 直近に選ばれた replay frame index (gap 中は -1) */
    selectedFrame: number;
    /** 同じ frame を連続で選んだ回数 */
    repeats: number;
    /** frame index が 2 以上飛んだ回数 */
    skips: number;
    /** 飛ばされた frame の総数 (Σ(Δ-1)) */
    skippedFrames: number;
    /** 最大 jump 幅 (Δ の最大値) */
    maxJump: number;
    /** getFrame 呼び出し間隔 ms */
    p50Ms: number | null;
    p95Ms: number | null;
    maxMs: number | null;
    approxFps: number | null;
    /** A2E の 1 frame ぶんの時間 (= 1000 / fps)。判定の基準値。 */
    frameBudgetMs: number;
}

function queryParam(name: string): string | null {
    try {
        return new URLSearchParams(window.location.search).get(name);
    } catch {
        return null;
    }
}

let _diagMode: DiagMode | null = null;

/**
 * 診断モードの解決。
 * morphProbe と a2eReplay が同時指定されたら両方無効 ('conflict')。
 */
export function getDiagMode(): DiagMode {
    if (_diagMode !== null) return _diagMode;
    const probe = queryParam('morphProbe') === '1';
    const replay = queryParam('a2eReplay') === '1';
    if (probe && replay) {
        console.error(
            '[A2E REPLAY] morphProbe=1 と a2eReplay=1 の同時指定は禁止です。両方を無効にしました。'
        );
        _diagMode = 'conflict';
    } else if (probe) {
        _diagMode = 'morphProbe';
    } else if (replay) {
        _diagMode = 'a2eReplay';
    } else {
        _diagMode = 'none';
    }
    return _diagMode;
}

export function isA2ECaptureMode(): boolean {
    return queryParam('a2eCapture') === '1';
}

/**
 * 【診断専用】`?a2eTrace=1`
 *
 * 通常 avatar 経路 (avatar-config 経由の B80 / FULL133 など) のまま
 * `setExpressionTrace()` だけを有効にするためのフラグ。
 * uika133k mode には入れず、`expressionProvider` も設定しないので、
 * cache path の動作は本番とまったく同じまま trace だけが増える。
 */
export function isA2ETraceMode(): boolean {
    return queryParam('a2eTrace') === '1';
}

// ===================================================================
// 画面表示 (DevTools を開かずに状態が読めるようにする。1 行だけ)
// ===================================================================

let hudEl: HTMLDivElement | null = null;

function hud(text: string): void {
    if (typeof document === 'undefined') return;
    if (!hudEl) {
        hudEl = document.createElement('div');
        hudEl.id = 'a2eReplayHud';
        hudEl.style.cssText = [
            'position:fixed', 'left:8px', 'bottom:8px', 'z-index:99999',
            'padding:4px 8px', 'border-radius:4px',
            'background:rgba(0,0,0,0.72)', 'color:#0f0',
            'font:12px/1.4 ui-monospace,Menlo,Consolas,monospace',
            'white-space:pre', 'pointer-events:none',
        ].join(';');
        document.body.appendChild(hudEl);
    }
    if (hudEl.textContent !== text) hudEl.textContent = text;
}

// ===================================================================
// capture
// ===================================================================

let capture: CapturedA2E | null = null;

function persist(): void {
    if (!capture) return;
    try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(capture));
    } catch (e) {
        console.error('[A2E CAPTURE] localStorage 保存に失敗:', e);
    }
}

/**
 * live_expression の受信データをそのまま蓄積する。
 * データは一切変換しない (frames / expression_names は受信値をそのまま保持)。
 */
export function captureLiveExpression(data: any): void {
    if (!isA2ECaptureMode()) return;

    const expressions = data?.expressions;
    if (!Array.isArray(expressions) || expressions.length === 0) return;

    if (!capture) {
        capture = {
            fps: typeof data.frame_rate === 'number' ? data.frame_rate : 30,
            expression_names: Array.isArray(data.expression_names) ? data.expression_names : [],
            frames: [],
            chunks: [],
            capturedAt: new Date().toISOString(),
        };
        (window as any).__a2eCaptured = capture;
    }

    if (capture.expression_names.length === 0 && Array.isArray(data.expression_names)) {
        capture.expression_names = data.expression_names;
    }
    if (typeof data.frame_rate === 'number' && data.frame_rate !== capture.fps) {
        console.warn(
            `[A2E CAPTURE] chunk 間で frame_rate が違う (保持=${capture.fps} 受信=${data.frame_rate})。保持側を使う。`
        );
    }

    // chunk 境界は捨てる: 到着順に単純連結して 1 本のシーケンスにする
    for (const f of expressions) capture.frames.push(f);
    capture.chunks.push({
        chunk_index: data.chunk_index,
        frames: expressions.length,
        perfMs: performance.now(),
    });

    persist();

    console.log(
        `[A2E CAPTURE] chunk=${data.chunk_index} frames=${expressions.length} `
        + `total=${capture.frames.length} names=${capture.expression_names.length} fps=${capture.fps}`
    );
    hud(
        `A2E CAPTURE  frames=${capture.frames.length}  names=${capture.expression_names.length}`
        + `  fps=${capture.fps}  saved`
    );
}

/** 保存済み capture を読む。壊れていたら null。 */
export function loadCapturedA2E(): CapturedA2E | null {
    let raw: string | null = null;
    try {
        raw = window.localStorage.getItem(STORAGE_KEY);
    } catch {
        return null;
    }
    if (!raw) return null;
    try {
        const d = JSON.parse(raw);
        if (!d || typeof d.fps !== 'number' || d.fps <= 0) return null;
        if (!Array.isArray(d.expression_names) || d.expression_names.length === 0) return null;
        if (!Array.isArray(d.frames) || d.frames.length === 0) return null;
        if (!Array.isArray(d.frames[0])) return null;
        return d as CapturedA2E;
    } catch {
        return null;
    }
}

// ===================================================================
// replay
// ===================================================================

export class A2EReplayPlayer {
    private readonly data: CapturedA2E;
    private readonly durationMs: number;
    private readonly periodMs: number;
    private readonly start: number;
    private hudAt = 0;

    // ---- 診断専用 counter (選択ロジックには一切関与しない) ----
    private readCount = 0;
    private prevIndex = -1;
    private repeats = 0;
    private skips = 0;
    private skippedFrames = 0;
    private maxJump = 0;
    private lastReadAt: number | null = null;
    private readonly gaps: number[] = [];
    private hooksInstalled = false;

    constructor(data: CapturedA2E) {
        this.data = data;
        this.durationMs = (data.frames.length / data.fps) * 1000;
        this.periodMs = this.durationMs + LOOP_GAP_MS;
        this.start = performance.now();
    }

    get info(): { fps: number; frames: number; names: number; durationMs: number } {
        return {
            fps: this.data.fps,
            frames: this.data.frames.length,
            names: this.data.expression_names.length,
            durationMs: this.durationMs,
        };
    }

    get expressionNames(): string[] {
        return this.data.expression_names;
    }

    /**
     * 現在時刻に対応する A2E frame を返す。
     * setInterval で frame++ はしない。描画が遅れても
     * 「その時刻に対応する正しい frame」を選ぶ (人工 jawOpen 試験と同じ考え方)。
     * 末尾の静止区間では null (= 全 0 / 口閉じ) を返す。
     */
    getFrame(): ExpressionFrame | null {
        const now = performance.now();
        const elapsed = now - this.start;
        const loop = Math.floor(elapsed / this.periodMs);
        const t = elapsed - loop * this.periodMs;
        const total = this.data.frames.length;

        this.countRead(now);
        this.installWindowHooks();

        if (t >= this.durationMs) {
            // gap 区間。折り返しを jump として数えないよう prevIndex を畳む。
            this.prevIndex = -1;
            this.showHudThrottled(now, () => `A2E REPLAY  frame --- / ${total}  (gap)  loop=${loop + 1}`);
            return null;
        }

        const index = Math.min(total - 1, Math.floor((t / 1000) * this.data.fps));
        this.countIndex(index);
        this.showHudThrottled(now, () =>
            `A2E REPLAY  frame ${index + 1} / ${total}  loop=${loop + 1}\n`
            + this.hudStatsLine());
        return { values: this.data.frames[index] };
    }

    // ===============================================================
    // 以下は診断専用。frame の選び方には一切関与しない (観測のみ)。
    // ===============================================================

    /** getFrame 呼び出し間隔を記録する (= renderer の expression 読み出し cadence)。 */
    private countRead(now: number): void {
        this.readCount++;
        if (this.lastReadAt !== null) {
            this.gaps.push(now - this.lastReadAt);
            if (this.gaps.length > 4000) this.gaps.shift();
        }
        this.lastReadAt = now;
    }

    /** 選ばれた index の連続性を記録する。repeat / skip の定義は A2EReplayStats 参照。 */
    private countIndex(index: number): void {
        if (this.prevIndex >= 0) {
            const d = index - this.prevIndex;
            if (d === 0) {
                this.repeats++;
            } else if (d > 1) {
                this.skips++;
                this.skippedFrames += d - 1;
                if (d > this.maxJump) this.maxJump = d;
            }
            // d < 0 は起きない想定 (gap で prevIndex を畳んでいる)。起きても数えない。
        }
        this.prevIndex = index;
    }

    private percentile(sorted: number[], p: number): number {
        return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
    }

    get stats(): A2EReplayStats {
        const sorted = this.gaps.slice().sort((a, b) => a - b);
        const p50 = sorted.length > 2 ? this.percentile(sorted, 0.5) : null;
        return {
            readCount: this.readCount,
            selectedFrame: this.prevIndex,
            repeats: this.repeats,
            skips: this.skips,
            skippedFrames: this.skippedFrames,
            maxJump: this.maxJump,
            p50Ms: p50,
            p95Ms: sorted.length > 2 ? this.percentile(sorted, 0.95) : null,
            maxMs: sorted.length > 0 ? sorted[sorted.length - 1] : null,
            approxFps: p50 && p50 > 0 ? 1000 / p50 : null,
            frameBudgetMs: 1000 / this.data.fps,
        };
    }

    /** cold / warm を分けて測るための reset。累積 counter だけを 0 に戻す。 */
    resetStats(): void {
        this.readCount = 0;
        this.repeats = 0;
        this.skips = 0;
        this.skippedFrames = 0;
        this.maxJump = 0;
        this.gaps.length = 0;
        this.lastReadAt = null;
        // prevIndex は連続性の基準なので畳む (reset 直後の 1 回を jump にしない)
        this.prevIndex = -1;
    }

    /**
     * `window.__a2eReplayStats` を **getter** として 1 回だけ生やす。
     *
     * 毎フレーム `this.stats` を作ると percentile のための sort が
     * 描画コールバックの中で走り、**測ろうとしている frame time 自体を
     * 太らせてしまう**。読まれたときだけ計算する。
     * 毎フレームの処理は O(1) の counter 更新だけに保つ。
     */
    private installWindowHooks(): void {
        if (this.hooksInstalled) return;
        this.hooksInstalled = true;
        const w = window as any;
        try {
            Object.defineProperty(w, '__a2eReplayStats', {
                configurable: true,
                get: () => this.stats,
            });
        } catch {
            // defineProperty が通らない環境では諦める (計測は HUD 側で読める)
        }
        w.__a2eReplayStatsReset = () => { this.resetStats(); return 'reset'; };
    }

    private hudStatsLine(): string {
        const s = this.stats;
        const f = (v: number | null) => (v === null ? '--' : v.toFixed(1));
        return (
            `budget=${s.frameBudgetMs.toFixed(1)}ms  p50=${f(s.p50Ms)}  p95=${f(s.p95Ms)}\n`
            + `rep=${s.repeats}  skip=${s.skips}(${s.skippedFrames}f)  maxJump=${s.maxJump}`
        );
    }

    /**
     * HUD は 100ms に 1 回だけ更新する。
     * **文字列の構築 (percentile の sort を含む) も throttle の内側で行う**ので、
     * 毎フレームのコストにはならない。
     */
    private showHudThrottled(now: number, build: () => string): void {
        if (now - this.hudAt < 100) return;
        this.hudAt = now;
        hud(build());
    }
}

/**
 * リプレイ用プレイヤを作る。capture データが無ければ null を返し、画面に理由を出す。
 */
export function createA2EReplayPlayer(): A2EReplayPlayer | null {
    const data = loadCapturedA2E();
    if (!data) {
        console.error(
            '[A2E REPLAY] capture データがありません。'
            + 'repo の実 capture を使うなら console で `await __a2eCaptureLoadFixture()` を'
            + '1 回実行してリロードしてください。新規に録るなら ?a2eCapture=1 で 1 回発話します。'
        );
        hud('A2E REPLAY  capture 無し -> await __a2eCaptureLoadFixture() か ?a2eCapture=1');
        return null;
    }
    const player = new A2EReplayPlayer(data);
    const i = player.info;
    console.log(
        `[A2E REPLAY] 開始: fps=${i.fps} frames=${i.frames} names=${i.names} `
        + `duration=${(i.durationMs / 1000).toFixed(2)}s capturedAt=${data.capturedAt}`
    );
    (window as any).__a2eReplayInfo = i;
    return player;
}

// ===================================================================
// 手動操作用 (console から JSON を出し入れする)
// ===================================================================

if (typeof window !== 'undefined') {
    const w = window as any;
    w.__a2eCaptureJson = () => JSON.stringify(capture ?? loadCapturedA2E());
    w.__a2eCaptureSave = () => { persist(); return capture; };
    w.__a2eCaptureClear = () => {
        try { window.localStorage.removeItem(STORAGE_KEY); } catch { /* noop */ }
        capture = null;
        return 'cleared';
    };
    w.__a2eCaptureLoadJson = (json: string) => {
        try {
            window.localStorage.setItem(STORAGE_KEY, json);
            return 'stored';
        } catch (e) {
            return String(e);
        }
    };
    /**
     * repo に入っている実 A2E capture を localStorage へ入れる。
     *
     * `src/scripts/chat/uika-native/fixtures/a2e-real-capture-gate3.json` は
     * `CapturedA2E` と同じ形 (`fps` / `expression_names` / `frames` / `chunks`
     * / `capturedAt`) なので、そのまま replay の入力に使える。
     * これがあるので **Replay のたびに録り直す必要は無い**。
     *
     * dynamic import なので、呼ばない限り bundle には載らない。
     *
     *     await __a2eCaptureLoadFixture()      // 1 回だけ
     *     // その後 ?a2eReplay=1 でリロード
     */
    w.__a2eCaptureLoadFixture = async () => {
        try {
            const mod = await import('./uika-native/fixtures/a2e-real-capture-gate3.json');
            const data = (mod as any).default ?? mod;
            window.localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
            capture = null;
            const loaded = loadCapturedA2E();
            if (!loaded) return 'fixture の形式が CapturedA2E と一致しません';
            const msg = `stored: frames=${loaded.frames.length} `
                + `names=${loaded.expression_names.length} fps=${loaded.fps} `
                + `capturedAt=${loaded.capturedAt}`;
            console.log('[A2E CAPTURE] ' + msg);
            return msg;
        } catch (e) {
            return String(e);
        }
    };
}
