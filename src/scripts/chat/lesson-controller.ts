

// src/scripts/chat/lesson-controller.ts
// 会話レッスン・モード用コントローラ（concierge-controller.tsベースに移植）
// アバター + A2Eリップシンク搭載、ショップ検索・予約機能を除外
import { CoreController } from './core-controller';
import { AudioManager } from './audio-manager';

declare const io: any;

export class LessonController extends CoreController {
  // ★ LAMAvatar コントローラー参照（仕様書08 セクション7.1）
  private lamAvatarController: any = null;

  constructor(container: HTMLElement, apiBase: string) {
    super(container, apiBase);

    // ★レッスンモード用のAudioManagerを6.5秒設定で再初期化
    this.audioManager = new AudioManager(8000);

    // レッスンモードに設定
    this.currentMode = 'lesson';
    this.init();
  }

  // 初期化プロセスをオーバーライド
  protected async init() {
    // 親クラスの初期化を実行
    await super.init();

    // レッスン固有の要素とイベントを追加
    const query = (sel: string) => this.container.querySelector(sel) as HTMLElement;
    this.els.avatarContainer = query('.avatar-container');
    this.els.avatarImage = query('#avatarImage') as HTMLImageElement;
    this.els.modeSwitch = query('#modeSwitch') as HTMLInputElement;

    // 相手先言語ラベルのi18n対応
    const targetLangLabel = this.container.querySelector('#targetLangLabel');
    if (targetLangLabel) {
      targetLangLabel.textContent = this.t('targetLanguageLabel');
    }

    // モードスイッチのイベントリスナー追加
    if (this.els.modeSwitch) {
      this.els.modeSwitch.addEventListener('change', () => {
        this.toggleMode();
      });
    }

    // ★ LAMAvatar連携初期化（仕様書08 セクション7.1）
    this.linkLamAvatar();
  }

  // ★ LAMAvatarにLiveAudioManagerをバインド（仕様書08 セクション7.1）
  private async linkLamAvatar(): Promise<void> {
    const controller = (window as any).__lamAvatarController;
    if (controller) {
      this.lamAvatarController = controller;
      try {
        await controller.initialize(this.liveAudioManager);
        console.log('[LessonController] LAMAvatar連携完了');
      } catch (e) {
        console.error('[LessonController] LAMAvatar連携エラー:', e);
      }
    } else {
      console.warn('[LessonController] LAMAvatarController が見つかりません');
    }
  }

  // ========================================
  // 🎯 セッション初期化をオーバーライド（LiveAPI統一）
  // ========================================
  protected async initializeSession() {
    try {
      if (this.sessionId) {
        try {
          await fetch(`${this.apiBase}/api/session/end`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ session_id: this.sessionId })
          });
        } catch (e) {}
      }

      // 1. REST APIでsession_id取得（user_id付き）
      const userId = this.getUserId();

      const res = await fetch(`${this.apiBase}/api/session/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_info: { user_id: userId },
          language: this.currentLanguage,
          mode: 'lesson'
        })
      });
      const data = await res.json();
      this.sessionId = data.session_id;

      // 2. UIを有効化
      this.els.userInput.disabled = false;
      this.els.sendBtn.disabled = false;
      this.els.micBtn.disabled = false;
      this.els.speakerBtn.disabled = false;
      this.els.speakerBtn.classList.remove('disabled');

      // 3. ★ LiveAPIで初期挨拶を開始
      await this.startLiveMode();

    } catch (e) {
      console.error('[Session] Initialization error:', e);
    }
  }

  // ========================================
  // 🔧 Socket.IOの初期化をオーバーライド
  // ========================================
  protected initSocket() {
    // ★ 親クラスのinitSocket()を呼んでLiveAPIリスナーも登録
    super.initSocket();

    // レッスン版のtranscriptハンドラを上書き
    this.socket.off('transcript');
    this.socket.on('transcript', (data: any) => {
      const { text, is_final } = data;
      if (this.isAISpeaking) return;
      if (is_final) {
        this.handleStreamingSTTComplete(text);
        this.currentAISpeech = "";
      } else {
        this.els.userInput.value = text;
      }
    });
  }

  // アバターアニメーション制御
  protected async speakTextGCP(text: string, stopPrevious: boolean = true, autoRestartMic: boolean = false, skipAudio: boolean = false) {
    if (skipAudio || !this.isTTSEnabled || !text) return Promise.resolve();

    if (stopPrevious) {
      this.ttsPlayer.pause();
    }

    // アバターアニメーションを開始
    if (this.els.avatarContainer) {
      this.els.avatarContainer.classList.add('speaking');
    }
    if (this.lamAvatarController) {
      this.lamAvatarController.onSpeakingStart();
    }

    // 親クラスのTTS処理を実行
    await super.speakTextGCP(text, stopPrevious, autoRestartMic, skipAudio);

    // アバターアニメーションを停止
    this.stopAvatarAnimation();
  }

  // アバターアニメーション停止
  private stopAvatarAnimation() {
    if (this.els.avatarContainer) {
      this.els.avatarContainer.classList.remove('speaking');
    }
    if (this.lamAvatarController) {
      this.lamAvatarController.onSpeakingEnd();
    }
  }

  // ========================================
  // 🎯 UI言語更新をオーバーライド(挨拶文をレッスン用に)
  // ========================================
  protected updateUILanguage() {
    // ✅ バックエンドからの長期記憶対応済み挨拶を保持
    const initialMessage = this.els.chatArea.querySelector('.message.assistant[data-initial="true"] .message-text');
    const savedGreeting = initialMessage?.textContent;

    // 親クラスのupdateUILanguageを実行（UIラベル等を更新）
    super.updateUILanguage();

    // ✅ 長期記憶対応済み挨拶を復元
    if (initialMessage && savedGreeting) {
      initialMessage.textContent = savedGreeting;
    }

    // ✅ ページタイトルをレッスン用に設定
    const pageTitle = document.getElementById('pageTitle');
    if (pageTitle) {
      pageTitle.innerHTML = `<img src="/pwa-152x152.png" alt="Logo" class="app-logo" /> ${this.t('pageTitleLesson')}`;
    }

    // ✅ 相手先言語ラベルを更新
    const targetLangLabel = this.container.querySelector('#targetLangLabel');
    if (targetLangLabel) {
      targetLangLabel.textContent = this.t('targetLanguageLabel');
    }
  }

  // モード切り替え処理 - コンシェルジュモードへページ遷移
  private toggleMode() {
    const isChecked = (this.els.modeSwitch as HTMLInputElement)?.checked;
    if (isChecked) {
      // コンシェルジュモードへページ遷移
      console.log('[LessonController] Switching to Concierge mode...');
      window.location.href = '/concierge';
    }
    // レッスンモードは既に現在のページなので何もしない
  }

  // すべての活動を停止(アバターアニメーションも含む)
  protected stopAllActivities() {
    super.stopAllActivities();
    this.stopAvatarAnimation();
    // ★ LAMAvatar フレームバッファクリア
    if (this.lamAvatarController) {
      this.lamAvatarController.resetExpression();
    }
  }

  // ========================================
  // 🎯 レッスンモード専用: 音声入力完了時の処理
  // ========================================
  protected async handleStreamingSTTComplete(transcript: string) {
    this.stopStreamingSTT();

    if ('mediaSession' in navigator) {
      try { navigator.mediaSession.playbackState = 'playing'; } catch (e) {}
    }

    this.els.voiceStatus.innerHTML = this.t('voiceStatusComplete');
    this.els.voiceStatus.className = 'voice-status';

    // オウム返し判定(エコーバック防止)
    const normTranscript = this.normalizeText(transcript);
    if (this.isSemanticEcho(normTranscript, this.lastAISpeech)) {
        this.els.voiceStatus.innerHTML = this.t('voiceStatusStopped');
        this.els.voiceStatus.className = 'voice-status stopped';
        this.lastAISpeech = '';
        return;
    }

    this.els.userInput.value = transcript;
    this.addMessage('user', transcript);

    // 短すぎる入力チェック
    const textLength = transcript.trim().replace(/\s+/g, '').length;
    if (textLength < 2) {
        const msg = this.t('shortMsgWarning');
        this.addMessage('assistant', msg);
        if (this.isTTSEnabled && this.isUserInteracted) {
          await this.speakTextGCP(msg, true);
        } else {
          await new Promise(r => setTimeout(r, 2000));
        }
        this.els.userInput.value = '';
        this.els.voiceStatus.innerHTML = this.t('voiceStatusStopped');
        this.els.voiceStatus.className = 'voice-status stopped';
        return;
    }

    // ✅ 即答を「はい」だけに簡略化
    const ackText = this.t('ackYes');
    const preGeneratedAudio = this.preGeneratedAcks.get(ackText);

    // 即答を再生
    let firstAckPromise: Promise<void> | null = null;
    if (preGeneratedAudio && this.isTTSEnabled && this.isUserInteracted) {
      firstAckPromise = new Promise<void>((resolve) => {
        this.lastAISpeech = this.normalizeText(ackText);
        this.ttsPlayer.src = `data:audio/mp3;base64,${preGeneratedAudio}`;
        this.ttsPlayer.onended = () => resolve();
        this.ttsPlayer.play().catch(_e => resolve());
      });
    } else if (this.isTTSEnabled) {
      firstAckPromise = this.speakTextGCP(ackText, false);
    }

    this.addMessage('assistant', ackText);

    // すぐにLLMへ送信
    (async () => {
      try {
        if (firstAckPromise) await firstAckPromise;

        if (this.els.userInput.value.trim()) {
          this.isFromVoiceInput = true;
          this.sendMessage();
        }
      } catch (_error) {
        if (this.els.userInput.value.trim()) {
          this.isFromVoiceInput = true;
          this.sendMessage();
        }
      }
    })();

    this.els.voiceStatus.innerHTML = this.t('voiceStatusStopped');
    this.els.voiceStatus.className = 'voice-status stopped';
  }

  // ========================================
  // 🎯 レッスンモード専用: メッセージ送信処理
  // （ショップ検索・予約ロジックを除外したシンプル版）
  // ========================================
  protected async sendMessage() {
    let firstAckPromise: Promise<void> | null = null;
    this.unlockAudioParams();
    const message = this.els.userInput.value.trim();
    if (!message || this.isProcessing) return;

    const currentSessionId = this.sessionId;
    const isTextInput = !this.isFromVoiceInput;

    this.isProcessing = true;
    this.els.sendBtn.disabled = true;
    this.els.micBtn.disabled = true;
    this.els.userInput.disabled = true;

    // テキスト入力時の即答処理
    if (!this.isFromVoiceInput) {
      this.addMessage('user', message);
      const textLength = message.trim().replace(/\s+/g, '').length;
      if (textLength < 2) {
           const msg = this.t('shortMsgWarning');
           this.addMessage('assistant', msg);
           if (this.isTTSEnabled && this.isUserInteracted) await this.speakTextGCP(msg, true);
           this.resetInputState();
           return;
      }

      this.els.userInput.value = '';

      const ackText = this.t('ackYes');
      this.currentAISpeech = ackText;
      this.addMessage('assistant', ackText);

      if (this.isTTSEnabled && !isTextInput) {
        try {
          const preGeneratedAudio = this.preGeneratedAcks.get(ackText);
          if (preGeneratedAudio && this.isUserInteracted) {
            firstAckPromise = new Promise<void>((resolve) => {
              this.lastAISpeech = this.normalizeText(ackText);
              this.ttsPlayer.src = `data:audio/mp3;base64,${preGeneratedAudio}`;
              this.ttsPlayer.onended = () => resolve();
              this.ttsPlayer.play().catch(_e => resolve());
            });
          } else {
            firstAckPromise = this.speakTextGCP(ackText, false);
          }
        } catch (_e) {}
      }
      if (firstAckPromise) await firstAckPromise;
    }

    this.isFromVoiceInput = false;

    // 待機アニメーション
    if (this.waitOverlayTimer) clearTimeout(this.waitOverlayTimer);
    let responseReceived = false;

    this.waitOverlayTimer = window.setTimeout(() => {
      if (!responseReceived) {
        this.showWaitOverlay();
      }
    }, 6500);

    try {
      const response = await fetch(`${this.apiBase}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: currentSessionId,
          message: message,
          stage: this.currentStage,
          language: this.currentLanguage,
          mode: this.currentMode
        })
      });
      const data = await response.json();

      responseReceived = true;

      if (this.sessionId !== currentSessionId) return;

      if (this.waitOverlayTimer) {
        clearTimeout(this.waitOverlayTimer);
        this.waitOverlayTimer = null;
      }
      this.hideWaitOverlay();
      this.currentAISpeech = data.response;
      this.addMessage('assistant', data.response, data.summary);

      if (!isTextInput && this.isTTSEnabled) {
        this.stopCurrentAudio();
      }

      // レッスンモード: ショップ検索なし、シンプルにTTS再生
      if (data.response) {
        await this.speakTextGCP(data.response, true, false, isTextInput);
      }
    } catch (error) {
      console.error('送信エラー:', error);
      this.hideWaitOverlay();
      this.showError('メッセージの送信に失敗しました。');
    } finally {
      this.resetInputState();
      this.els.userInput.blur();
    }
  }

}
