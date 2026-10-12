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
        const elapsed = performance.now() - this.start;
        const loop = Math.floor(elapsed / this.periodMs);
        const t = elapsed - loop * this.periodMs;
        const total = this.data.frames.length;

        if (t >= this.durationMs) {
            this.showHud(`A2E REPLAY  frame --- / ${total}  (gap)  loop=${loop + 1}`);
            return null;
        }

        const index = Math.min(total - 1, Math.floor((t / 1000) * this.data.fps));
        this.showHud(`A2E REPLAY  frame ${index + 1} / ${total}  loop=${loop + 1}`);
        return { values: this.data.frames[index] };
    }

    private showHud(text: string): void {
        const now = performance.now();
        if (now - this.hudAt < 100) return;
        this.hudAt = now;
        hud(text);
    }
}

/**
 * リプレイ用プレイヤを作る。capture データが無ければ null を返し、画面に理由を出す。
 */
export function createA2EReplayPlayer(): A2EReplayPlayer | null {
    const data = loadCapturedA2E();
    if (!data) {
        console.error(
            '[A2E REPLAY] capture データがありません。先に ?a2eCapture=1 で 1 回発話して録ってください。'
        );
        hud('A2E REPLAY  capture データ無し -> ?a2eCapture=1 で 1 回録ってください');
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
}
