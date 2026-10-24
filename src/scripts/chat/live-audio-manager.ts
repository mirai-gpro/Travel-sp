// src/scripts/chat/live-audio-manager.ts
/**
 * Gemini LiveAPI 用 AudioStreamManager
 *
 * 【設計原則】(仕様書02 セクション4.2)
 * - AudioContext/MediaStream/AudioWorkletNode はセッション中使い回し
 * - 半二重制御はフラグ（isAiSpeaking）で行う
 * - VADはGemini側に委譲
 * - AI音声再生もWeb Audio APIで行う（iOS対策）
 */

const b64chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function arrayBufferToBase64(buffer: ArrayBuffer): string {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i += 3) {
        const c1 = bytes[i];
        const c2 = bytes[i + 1];
        const c3 = bytes[i + 2];
        const enc1 = c1 >> 2;
        const enc2 = ((c1 & 3) << 4) | (c2 >> 4);
        const enc3 = ((c2 & 15) << 2) | (c3 >> 6);
        const enc4 = c3 & 63;
        binary += b64chars[enc1] + b64chars[enc2];
        if (Number.isNaN(c2)) { binary += '=='; }
        else if (Number.isNaN(c3)) { binary += b64chars[enc3] + '='; }
        else { binary += b64chars[enc3] + b64chars[enc4]; }
    }
    return binary;
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
    const binaryString = atob(base64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes.buffer;
}

// Expression フレームデータ型
export interface ExpressionFrame {
    values: number[];  // ARKit 52 ブレンドシェイプ値
}

// ============================================================
// AV coordinated scheduler のチューニング定数
// ============================================================

/**
 * segment の最初の音声を、実時間で何秒遅らせて鳴らし始めるか (pre-roll)。
 *
 * Audio は Expression coverage を超えて schedule しないので、coverage が
 * 伸びる前に音声が鳴り終わると再生が途切れる。segment 先頭を LEAD だけ
 * 後ろにずらすと、以降すべての drain 点が実時間で LEAD だけ後ろにずれ、
 * その分が A2E 到着の揺らぎ吸収になる。
 *
 * この値そのものが重要なのではなく、「Audio が Expression buffer を
 * 追い越した状態で再生されない」ことが重要。0 にすると pre-roll 無しになる。
 */
/**
 * 値の根拠 (実機実測 2026/10/24):
 *   先頭で解放した音声            0.87s
 *   次の live_expression の到着   1.204s 後
 *   必要な pre-roll              1.204 - 0.87 = 0.334s
 * 0.20 では 0.134s 足りず、再生位置 795ms で音声が約 330ms 途切れた
 * (playhead が null = 無音)。0.60 は上記必要量に 0.266s の余裕を持たせた値。
 * A2E の到着は burst なので、ここは「最大の到着間隔を吸収する余裕」であり
 * 計測済みの物理量ではない。途切れが再発したら増やす、挨拶の鳴り始めを
 * 詰めたいなら減らす (0.334s 未満にすると今回の症状が戻る)。
 */
export const A2E_LEAD_SEC = 0.60;

/** AudioContext へ渡す前の、まだ schedule していない音声チャンク。 */
interface PendingAudioChunk {
    buffer: AudioBuffer;
    durationSec: number;
}

/** 実際に AudioBufferSourceNode.start() した 1 チャンクの時間対応。 */
interface ScheduledEntry {
    wallStart: number;       // start() に渡した AudioContext 時刻 (= master origin)
    contentStart: number;    // segment 内のコンテンツ時刻 [sec]
    durationSec: number;
}

/**
 * 1 つの発話 segment。Expression frame と、その segment の
 * コンテンツ時刻 → AudioContext 時刻の対応表を持つ。
 */
interface AvSegment {
    id: number;
    frames: ExpressionFrame[];
    fps: number;
    contentSec: number;      // この segment で schedule 済みのコンテンツ長 [sec]
    entries: ScheduledEntry[];
    started: boolean;
    /** server から turn_complete が来た = これ以上 Audio が追加されない */
    serverEnded: boolean;
    /** まだ再生中 (未 onended) の AudioBufferSourceNode 数 */
    activeSources: number;
}

export class LiveAudioManager {
    private audioContext: AudioContext | null = null;
    private mediaStream: MediaStream | null = null;
    private audioWorkletNode: AudioWorkletNode | null = null;
    private sourceNode: MediaStreamAudioSourceNode | null = null;
    private socket: any = null;

    public isAiSpeaking: boolean = false;
    private isStreaming: boolean = false;

    // PCM再生（24kHz）
    private nextPlayTime: number = 0;
    private scheduledSources: AudioBufferSourceNode[] = [];  // interrupt時にstop()用

    // ===== AV coordinated scheduler =====
    // live_audio は即 schedule せず pending queue に積み、
    // Expression coverage が足りた分だけ _pumpAvScheduler() が AudioContext に渡す。
    private pendingAudio: PendingAudioChunk[] = [];
    private segments: AvSegment[] = [];
    private segmentSeq: number = 0;

    // master origin = 最初の AudioBufferSourceNode.start() に渡した startTime
    private audioTimelineStart: number | null = null;

    public expressionFrameRate: number = 30;           // fps（A2E 受信値。既定30）
    public expressionNames: string[] = [];             // ARKit ブレンドシェイプ名
    private _a2eDebugCounter: number = 0;              // デバッグログ間引き用

    // invariant 検証用カウンタ (read-only で外へ出すだけ)
    private _underrunCount: number = 0;        // requested frame が buffer に無かった回数
    private _interpCount: number = 0;          // 2 frame 間を補間した回数
    private _tailSampleCount: number = 0;      // 補間相手が無く requested frame をそのまま返した回数
    private _lastSample: { i0: number; i1: number; t: number } | null = null;

    // ========================================
    // セッション開始時に1度だけ呼ぶ
    // ========================================
    async initialize(socket: any): Promise<void> {
        if (this.audioContext) return; // 既に初期化済み

        this.socket = socket;

        // 1. AudioContext (1つだけ) - 48kHzでマイク入力
        // @ts-ignore
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        this.audioContext = new AudioContextClass({ sampleRate: 48000 });

        // 2. getUserMedia (1回だけ)
        this.mediaStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
                channelCount: 1,
            }
        });

        // 3. AudioWorklet登録 (1回だけ)
        // 48kHz → 16kHz ダウンサンプリング + Int16変換
        const downsampleRatio = 48000 / 16000; // = 3
        const audioProcessorCode = `
        class LiveAudioProcessor extends AudioWorkletProcessor {
            constructor() {
                super();
                this.bufferSize = 4800; // 300ms分 at 16kHz
                this.buffer = new Int16Array(this.bufferSize);
                this.writeIndex = 0;
                this.ratio = ${downsampleRatio};
                this.inputSampleCount = 0;
            }
            process(inputs, outputs, parameters) {
                const input = inputs[0];
                if (!input || input.length === 0) return true;
                const channelData = input[0];
                if (!channelData || channelData.length === 0) return true;
                for (let i = 0; i < channelData.length; i++) {
                    this.inputSampleCount++;
                    if (this.inputSampleCount >= this.ratio) {
                        this.inputSampleCount -= this.ratio;
                        if (this.writeIndex < this.bufferSize) {
                            const s = Math.max(-1, Math.min(1, channelData[i]));
                            const int16Value = s < 0 ? s * 0x8000 : s * 0x7FFF;
                            this.buffer[this.writeIndex++] = int16Value;
                        }
                        if (this.writeIndex >= this.bufferSize) {
                            this.flush();
                        }
                    }
                }
                return true;
            }
            flush() {
                if (this.writeIndex === 0) return;
                const chunk = this.buffer.slice(0, this.writeIndex);
                this.port.postMessage({ audioChunk: chunk }, [chunk.buffer]);
                this.buffer = new Int16Array(this.bufferSize);
                this.writeIndex = 0;
            }
        }
        registerProcessor('live-audio-processor', LiveAudioProcessor);
        `;

        const blob = new Blob([audioProcessorCode], { type: 'application/javascript' });
        const processorUrl = URL.createObjectURL(blob);
        await this.audioContext.audioWorklet.addModule(processorUrl);
        URL.revokeObjectURL(processorUrl);

        // 4. Node作成・接続
        this.sourceNode = this.audioContext.createMediaStreamSource(this.mediaStream);
        this.audioWorkletNode = new AudioWorkletNode(this.audioContext, 'live-audio-processor');
        this.sourceNode.connect(this.audioWorkletNode);

        // 5. フラグによる送信制御
        this.audioWorkletNode.port.onmessage = (e) => {
            if (!this.isStreaming) return;
            if (this.isAiSpeaking) return; // 半二重: AI応答中は送信しない

            const audioChunk: Int16Array = e.data.audioChunk;
            const base64 = arrayBufferToBase64(audioChunk.buffer);
            this.socket.emit('live_audio_in', { data: base64 });
        };

        console.log('[LiveAudioManager] 初期化完了');
    }

    // ========================================
    // ストリーミング開始（live_ready後に呼ぶ）
    // ========================================
    startStreaming(): void {
        this.isStreaming = true;
        // AudioContextがsuspendedなら再開
        if (this.audioContext && this.audioContext.state === 'suspended') {
            this.audioContext.resume();
        }
        console.log('[LiveAudioManager] ストリーミング開始');
    }

    // ========================================
    // ストリーミング停止（マイクは切らない）
    // ========================================
    stopStreaming(): void {
        this.isStreaming = false;
        console.log('[LiveAudioManager] ストリーミング停止');
    }

    // ========================================
    // AI応答音声の再生（Web Audio API, iOS対策）
    // PCM 24kHz 16bit mono
    // ========================================
    playPcmAudio(pcmBase64: string): void {
        if (!this.audioContext) return;

        const pcmBytes = base64ToArrayBuffer(pcmBase64);
        // PCM 24kHz 16bit mono → Float32
        const int16 = new Int16Array(pcmBytes);
        const float32 = new Float32Array(int16.length);
        for (let i = 0; i < int16.length; i++) {
            float32[i] = int16[i] / 32768.0;
        }

        const buffer = this.audioContext.createBuffer(1, float32.length, 24000);
        buffer.copyToChannel(float32, 0);

        // ★ 即時 schedule はしない。Expression coverage を見て解放する。
        this.pendingAudio.push({
            buffer,
            durationSec: buffer.duration,
        });
        this._pumpAvScheduler();
    }

    // ========================================
    // AV coordinated scheduler
    // ========================================

    /**
     * Expression coverage が存在する分だけ Audio を AudioContext へ渡す。
     *
     *   scheduledAudioEnd <= expressionCoverage
     *
     * を満たさないチャンクは pending に留める。これにより
     * 「Audio が Expression buffer を追い越す」状態を作らない。
     * segment の 1 本目だけ A2E_LEAD_SEC ぶん実時間で後ろにずらし、
     * 以降の drain 点を同じだけ後ろへ送る (A2E 到着揺らぎの吸収)。
     */
    private _pumpAvScheduler(): void {
        if (!this.audioContext) return;

        while (this.pendingAudio.length > 0) {
            const seg = this._currentSegment();
            const chunk = this.pendingAudio[0];
            const fps = seg.fps > 0 ? seg.fps : 30;
            const coverageSec = seg.frames.length / fps;
            const scheduledEnd = seg.contentSec + chunk.durationSec;
            // 浮動小数の端 (2.4000000000000004 > 2.4) で 1 チャンク取り残さない
            const EPS = 1e-6;

            // Expression coverage が無い音声は例外なく pending に留める。
            // A2E が来なければ Audio も進めない (Audio-only 再生で A2E 障害を隠さない)。
            if (scheduledEnd > coverageSec + EPS) return;

            this.pendingAudio.shift();
            // segment の 1 本目だけ pre-roll ぶん後ろにずらす (揺らぎ吸収)
            const minDelaySec = seg.entries.length === 0 ? A2E_LEAD_SEC : 0.005;
            const wallStart = this._scheduleBuffer(chunk.buffer, minDelaySec, seg);
            seg.entries.push({
                wallStart,
                contentStart: seg.contentSec,
                durationSec: chunk.durationSec,
            });
            seg.contentSec = scheduledEnd;
            seg.started = true;

            // ★ master origin は「実際に start() した startTime」
            if (this.audioTimelineStart === null) {
                this.audioTimelineStart = wallStart;
            }
        }
    }

    /** 実際に AudioContext へ渡す。戻り値は start() に渡した startTime。 */
    private _scheduleBuffer(buffer: AudioBuffer, minDelaySec: number = 0.005, seg: AvSegment | null = null): number {
        const source = this.audioContext!.createBufferSource();
        source.buffer = buffer;
        source.connect(this.audioContext!.destination);

        const now = this.audioContext!.currentTime;
        // 少なくとも now + minDelaySec 後に再生開始（スケジューリングマージン / pre-roll）
        const startTime = Math.max(now + minDelaySec, this.nextPlayTime);
        source.start(startTime);
        this.nextPlayTime = startTime + buffer.duration;

        // interrupt用にソースを追跡、終了時に自動除去
        this.scheduledSources.push(source);
        if (seg) seg.activeSources++;
        source.onended = () => {
            const idx = this.scheduledSources.indexOf(source);
            if (idx !== -1) this.scheduledSources.splice(idx, 1);
            if (seg) seg.activeSources = Math.max(0, seg.activeSources - 1);
            // ★ 実際の再生終了はここで判定する (server の turn_complete ではない)
            this._maybeFinishSpeaking();
        };
        return startTime;
    }

    // ========================================
    // segment lifecycle
    // ========================================

    /**
     * 新しい正常 segment を開始する。
     * schedule 済みの音声は止めない (自然に鳴り終わり、新 segment はその後ろに並ぶ)。
     */
    beginSegment(): void {
        this.pendingAudio = [];
        this.segments.push({
            id: ++this.segmentSeq,
            frames: [],
            fps: this.expressionFrameRate,
            contentSec: 0,
            entries: [],
            started: false,
            serverEnded: false,
            activeSources: 0,
        });
        this._pruneSegments();
        this._a2eDebugCounter = 0;
        console.log(`[AV] beginSegment id=${this.segmentSeq}`);
    }

    /**
     * 本当に即時停止が必要な場合のみ (ユーザー割り込み等)。
     * schedule 済み source を止め、キューと timeline を捨てる。
     */
    interrupt(): void {
        this.pendingAudio = [];
        for (const source of this.scheduledSources) {
            try { source.stop(); } catch (_) { /* already stopped */ }
        }
        this.scheduledSources = [];
        this.nextPlayTime = 0;
        this.audioTimelineStart = null;
        this.segments = [];
        this.isAiSpeaking = false;
        console.log('[AV] interrupt: scheduled audio 停止 + timeline クリア');
    }

    private _currentSegment(): AvSegment {
        if (this.segments.length === 0) {
            this.segments.push({
                id: ++this.segmentSeq,
                frames: [],
                fps: this.expressionFrameRate,
                contentSec: 0,
                entries: [],
                started: false,
                serverEnded: false,
                activeSources: 0,
            });
        }
        return this.segments[this.segments.length - 1];
    }

    /** 鳴り終わった古い segment を落とす (最後の segment は常に残す)。 */
    private _pruneSegments(): void {
        if (!this.audioContext || this.segments.length <= 1) return;
        const now = this.audioContext.currentTime;
        const keep: AvSegment[] = [];
        for (let i = 0; i < this.segments.length; i++) {
            const seg = this.segments[i];
            const isLast = i === this.segments.length - 1;
            if (isLast) { keep.push(seg); continue; }
            const last = seg.entries[seg.entries.length - 1];
            const endsAt = last ? last.wallStart + last.durationSec : -Infinity;
            if (endsAt > now - 1.0) keep.push(seg);
        }
        this.segments = keep;
    }

    // ========================================
    // master playhead → Expression sampling
    // ========================================

    /**
     * 「実際に schedule した Audio」から、いま鳴っているコンテンツ時刻を求める。
     *
     * - entry の中にいる → contentStart + 経過
     * - entry が鳴り終わっていて後続 entry が未開始 (gap) → その entry の終端
     * - schedule 済み音声の末尾より後 (= 無音) → null (全0 = 口を閉じる)
     * - まだ 1 つも鳴り始めていない → null
     */
    private _resolvePlayhead(): { seg: AvSegment; contentSec: number } | null {
        if (!this.audioContext) return null;
        const now = this.audioContext.currentTime;
        for (let si = this.segments.length - 1; si >= 0; si--) {
            const seg = this.segments[si];
            for (let i = seg.entries.length - 1; i >= 0; i--) {
                const e = seg.entries[i];
                if (now < e.wallStart) continue;
                const into = now - e.wallStart;
                if (into < e.durationSec) {
                    return { seg, contentSec: e.contentStart + into };
                }
                const isGlobalLast = (i === seg.entries.length - 1) && (si === this.segments.length - 1);
                if (isGlobalLast) return null;
                return { seg, contentSec: e.contentStart + e.durationSec };
            }
        }
        return null;
    }

    /**
     * 現在の再生オフセット（ms）。
     * 基準は firstChunkStartTime ではなく、実際に start() した startTime。
     */
    getCurrentPlaybackOffset(): number {
        const p = this._resolvePlayhead();
        return p ? p.contentSec * 1000 : 0;
    }

    /**
     * 【診断専用・read-only】同期状態のスナップショット。状態は変更しない。
     */
    getExpressionSyncDebugState(): {
        playbackMs: number;
        bufferFrames: number;
        fps: number;
        requestedFrame: number;
        selectedFrame: number;
        clamped: boolean;
    } {
        const p = this._resolvePlayhead();
        const seg = this.segments.length > 0 ? this.segments[this.segments.length - 1] : null;
        const fps = seg && seg.fps > 0 ? seg.fps : this.expressionFrameRate;
        const bufferFrames = seg ? seg.frames.length : 0;
        if (!p) {
            return { playbackMs: 0, bufferFrames, fps, requestedFrame: -1, selectedFrame: -1, clamped: false };
        }
        const requestedFrame = Math.floor(p.contentSec * (p.seg.fps > 0 ? p.seg.fps : fps));
        return {
            playbackMs: p.contentSec * 1000,
            bufferFrames: p.seg.frames.length,
            fps: p.seg.fps > 0 ? p.seg.fps : fps,
            requestedFrame,
            selectedFrame: requestedFrame,   // clamp しないので常に一致
            clamped: requestedFrame >= p.seg.frames.length,   // underrun 指標 (通常は false)
        };
    }

    /**
     * 【read-only】invariant 検証用の内部状態。
     */
    getAvDebugState(): {
        timelineStart: number | null;
        firstEntryWallStart: number | null;
        pendingChunks: number;
        segments: number;
        currentSegmentFrames: number;
        currentSegmentContentSec: number;
        underrunCount: number;
        interpCount: number;
        tailSampleCount: number;
        serverEnded: boolean;
        activeSources: number;
        isAiSpeaking: boolean;
        lastSample: { i0: number; i1: number; t: number } | null;
    } {
        let firstEntryWallStart: number | null = null;
        for (const seg of this.segments) {
            if (seg.entries.length > 0) { firstEntryWallStart = seg.entries[0].wallStart; break; }
        }
        const seg = this.segments.length > 0 ? this.segments[this.segments.length - 1] : null;
        return {
            timelineStart: this.audioTimelineStart,
            firstEntryWallStart,
            pendingChunks: this.pendingAudio.length,
            segments: this.segments.length,
            currentSegmentFrames: seg ? seg.frames.length : 0,
            currentSegmentContentSec: seg ? seg.contentSec : 0,
            underrunCount: this._underrunCount,
            interpCount: this._interpCount,
            tailSampleCount: this._tailSampleCount,
            serverEnded: seg ? seg.serverEnded : false,
            activeSources: seg ? seg.activeSources : 0,
            isAiSpeaking: this.isAiSpeaking,
            lastSample: this._lastSample,
        };
    }

    /**
     * 描画時刻に対応する expression を返す。
     *
     * - A2E 本体の smoothing は足さない。30fps 離散信号を描画時刻へ
     *   resampling するための隣接 2 frame 線形補間だけを行う。
     * - clamp to last frame はしない。requested frame が buffer に無ければ
     *   それは underrun であり、null (全0) を返す。
     */
    getCurrentExpressionFrame(): ExpressionFrame | null {
        const p = this._resolvePlayhead();
        if (!p) return null;

        const seg = p.seg;
        const total = seg.frames.length;
        if (total === 0) return null;

        const fps = seg.fps > 0 ? seg.fps : 30;
        const framePos = p.contentSec * fps;
        const i0 = Math.floor(framePos);
        if (i0 < 0) return null;
        if (i0 >= total) {
            // Audio scheduler が正しければ起きない。保持はせず口を閉じる。
            this._underrunCount++;
            this._lastSample = { i0, i1: -1, t: 0 };
            return null;
        }

        const f0 = seg.frames[i0];
        const i1 = i0 + 1;
        let out: ExpressionFrame;
        if (i1 >= total) {
            // segment 末尾の 1 frame 区間のみ: 補間相手が無いので requested frame をそのまま使う
            this._tailSampleCount++;
            this._lastSample = { i0, i1: -1, t: 0 };
            out = f0;
        } else {
            const f1 = seg.frames[i1];
            const t = framePos - i0;
            const n = Math.min(f0.values.length, f1.values.length);
            const values = new Array<number>(n);
            for (let k = 0; k < n; k++) {
                values[k] = f0.values[k] * (1 - t) + f1.values[k] * t;
            }
            this._interpCount++;
            this._lastSample = { i0, i1, t };
            out = { values };
        }

        // デバッグ: 60回ごとにログ出力
        this._a2eDebugCounter++;
        if (this._a2eDebugCounter % 60 === 0) {
            const jawOpenIdx = this.expressionNames.indexOf('jawOpen');
            const jawVal = jawOpenIdx >= 0 && out.values[jawOpenIdx] !== undefined
                ? out.values[jawOpenIdx].toFixed(3) : 'N/A';
            console.log(
                `[A2E Sync] seg=${seg.id} playbackMs=${(p.contentSec * 1000).toFixed(0)}, `
                + `frame=${framePos.toFixed(2)}/${total}, jawOpen=${jawVal}`
            );
        }

        return out;
    }

    /**
     * Socket.IO live_expression イベントデータを現 segment のバッファに追加
     */
    onExpressionReceived(data: {
        expressions: number[][];
        expression_names: string[];
        frame_rate: number;
        chunk_index: number;
    }): void {
        // フレームレートとブレンドシェイプ名を更新
        if (data.frame_rate) this.expressionFrameRate = data.frame_rate;
        if (data.expression_names && data.expression_names.length > 0) {
            this.expressionNames = data.expression_names;
        }

        const seg = this._currentSegment();
        if (data.frame_rate) seg.fps = data.frame_rate;

        for (const values of data.expressions) {
            seg.frames.push({ values });
        }

        // デバッグ: バッファ状態とjawOpen値を出力
        if (data.expressions.length > 0) {
            const jawOpenIdx = this.expressionNames.indexOf('jawOpen');
            const firstFrame = data.expressions[0];
            const lastFrame = data.expressions[data.expressions.length - 1];
            const fps = seg.fps > 0 ? seg.fps : 30;
            console.log(
                `[A2E Buffer] seg=${seg.id} chunk=${data.chunk_index}, +${data.expressions.length}frames, `
                + `total=${seg.frames.length} (coverage=${(seg.frames.length / fps).toFixed(2)}s, `
                + `scheduled=${seg.contentSec.toFixed(2)}s, pending=${this.pendingAudio.length}), `
                + `jawOpen=[${jawOpenIdx >= 0 ? firstFrame[jawOpenIdx]?.toFixed(3) : 'N/A'}..${jawOpenIdx >= 0 ? lastFrame[jawOpenIdx]?.toFixed(3) : 'N/A'}]`
            );
        }

        // coverage が増えたので、待っていた Audio を解放できるか見る
        this._pumpAvScheduler();
    }

    // ========================================
    // 再生キューをクリア（割り込み時）
    // ========================================
    clearPlaybackQueue(): void {
        this.interrupt();
    }

    // ========================================
    // フラグ切り替え
    // ========================================
    onAiResponseStarted(): void {
        // ★ 新しいAI応答ターンの最初のチャンクのみ segment を切る
        if (!this.isAiSpeaking) {
            this.beginSegment();
        }
        this.isAiSpeaking = true;
    }

    /**
     * 新音声セグメント開始（live_expression_reset 用）
     *
     * A2E先行方式: resetForNewSegment() → live_expression → live_audio の順で届くため、
     * isAiSpeaking = true を維持して onAiResponseStarted() の segment 切りを抑制し、
     * A2E先行で追加された Expression フレームを保持する。
     *
     * ここでは schedule 済み音声を停止しない (停止が必要なのは interrupt() だけ)。
     * 新 segment の音声は前 segment の音声の後ろに並ぶので、重なりも途切れも起きない。
     */
    resetForNewSegment(): void {
        this.beginSegment();
        this.isAiSpeaking = true;
    }

    /**
     * server の turn_complete。
     * 「これ以上 server から Audio が追加されない」という意味だけ。
     * この時点では pending / scheduled Audio が残っているので
     * isAiSpeaking はここでは false にしない。
     */
    onAiResponseEnded(): void {
        const seg = this.segments.length > 0 ? this.segments[this.segments.length - 1] : null;
        if (seg) seg.serverEnded = true;

        // ★ ターン終了時: 最終フレームのjawOpen関連を0にリセット（口閉じ遅延対策）
        // A2Eの最終フレームが0.008〜0.013で止まることがあり、口が閉じきらない
        if (seg && seg.frames.length > 0) {
            const lastFrame = seg.frames[seg.frames.length - 1];
            if (lastFrame && lastFrame.values) {
                for (const name of ['jawOpen', 'jawForward', 'jawLeft', 'jawRight']) {
                    const idx = this.expressionNames.indexOf(name);
                    if (idx >= 0) lastFrame.values[idx] = 0;
                }
            }
        }

        // 既に全部鳴り終わっていた場合はここで確定する
        this._maybeFinishSpeaking();
    }

    /**
     * 実際の再生終了判定。
     *   server が turn_complete を出した (serverEnded)
     *   かつ pending Audio = 0
     *   かつ その segment の AudioBufferSourceNode が全て onended 済み
     * を満たしたときだけ isAiSpeaking = false にする。
     * source.onended から再判定される。
     */
    private _maybeFinishSpeaking(): void {
        if (!this.isAiSpeaking) return;
        const seg = this.segments.length > 0 ? this.segments[this.segments.length - 1] : null;
        if (!seg || !seg.serverEnded) return;
        if (this.pendingAudio.length > 0) return;
        if (seg.activeSources > 0) return;
        this.isAiSpeaking = false;
        console.log(`[AV] 再生終了: segment=${seg.id} -> isAiSpeaking=false`);
    }

    // ========================================
    // 完全終了時のみ全破棄
    // ========================================
    terminate(): void {
        this.isStreaming = false;
        this.clearPlaybackQueue();

        if (this.audioWorkletNode) {
            this.audioWorkletNode.port.onmessage = null;
            this.audioWorkletNode.disconnect();
            this.audioWorkletNode = null;
        }
        if (this.sourceNode) {
            this.sourceNode.disconnect();
            this.sourceNode = null;
        }
        if (this.mediaStream) {
            this.mediaStream.getTracks().forEach(t => t.stop());
            this.mediaStream = null;
        }
        if (this.audioContext) {
            this.audioContext.close();
            this.audioContext = null;
        }
        this.socket = null;
        console.log('[LiveAudioManager] 完全終了');
    }
}
