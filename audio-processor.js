/**
 * AudioWorklet Processor for Real-time PCM Extraction
 *
 * Float32Array → Int16Array 変換を行い、リアルタイムで音声チャンクを送信
 */

class AudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.bufferSize = 4096; // チャンクサイズ
    this.buffer = [];
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];

    if (input.length > 0) {
      const channelData = input[0]; // モノラル (チャンネル0のみ)

      // Float32Array を Int16Array に変換
      const int16Data = new Int16Array(channelData.length);
      for (let i = 0; i < channelData.length; i++) {
        // Float32 (-1.0 ~ 1.0) を Int16 (-32768 ~ 32767) に変換
        const s = Math.max(-1, Math.min(1, channelData[i]));
        int16Data[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      }

      // バッファに追加
      this.buffer.push(...int16Data);

      // バッファサイズに達したらメインスレッドに送信
      if (this.buffer.length >= this.bufferSize) {
        const chunk = new Int16Array(this.buffer.splice(0, this.bufferSize));
        this.port.postMessage({ audioChunk: chunk });
      }
    }

    return true; // プロセッサーを継続
  }
}

registerProcessor('audio-processor', AudioProcessor);
