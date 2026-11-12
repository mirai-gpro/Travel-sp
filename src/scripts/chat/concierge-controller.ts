

// src/scripts/chat/concierge-controller.ts
import { CoreController } from './core-controller';
import { AudioManager } from './audio-manager';
import { isUika133kMode } from './uika-133k-mode';

declare const io: any;

export class ConciergeController extends CoreController {
  // ★ LAMAvatar コントローラー参照（仕様書08 セクション7.1）
  private lamAvatarController: any = null;

  // 画面に反映した最後の検索番号（R1.4 §8.2。古い結果を捨てる）
  private lastAppliedSearchSeq = 0;

  // キーボード入力を Live に送れる状態か（Greeting の後で、再接続中でない）。R2.0 §8.2・§8.3
  private liveTextReady = false;
  // 送れない間に打たれたテキスト。送れるようになったら順に送る（/api/chat には送らない）
  private pendingLiveTexts: string[] = [];

  constructor(container: HTMLElement, apiBase: string) {
    super(container, apiBase);

    // ★コンシェルジュモード用のAudioManagerを6.5秒設定で再初期化２
    this.audioManager = new AudioManager(8000);

    // コンシェルジュモードに設定
    this.currentMode = 'concierge';
    this.init();
  }

  // 初期化プロセスをオーバーライド
  protected async init() {
    // 親クラスの初期化を実行
    await super.init();

    // コンシェルジュ固有の要素とイベントを追加
    const query = (sel: string) => this.container.querySelector(sel) as HTMLElement;
    this.els.avatarContainer = query('.avatar-container');
    this.els.avatarImage = query('#avatarImage') as HTMLImageElement;
    this.els.modeSwitch = query('#modeSwitch') as HTMLInputElement;

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
        console.log('[ConciergeController] LAMAvatar連携完了');
      } catch (e) {
        console.error('[ConciergeController] LAMAvatar連携エラー:', e);
      }
    } else {
      console.warn('[ConciergeController] LAMAvatarController が見つかりません');
    }
  }

  // ========================================
  // 🎯 セッション初期化をオーバーライド（LiveAPI統一）
  // （仕様書02 セクション4.4.3）
  // ========================================
  private async prepareUikaAvatarBeforeLive(): Promise<void> {
    if (!isUika133kMode()) return;

    const controller = (window as any).__lamAvatarController;
    if (!controller) {
      throw new Error('UIKA: LAMAvatarController が見つかりません');
    }
    this.lamAvatarController = controller;

    console.log('[UIKA INIT] avatar preparation before Live start');
    await controller.initialize(this.liveAudioManager);
    console.log('[UIKA INIT] avatar READY; Live start permitted');
  }

  protected async initializeSession() {
    try {
      // UIKA 133K のみ: renderer + 初期 morph warm-up 完了まで Live を開始しない
      await this.prepareUikaAvatarBeforeLive();

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
          mode: 'concierge'
        })
      });
      const data = await res.json();
      this.sessionId = data.session_id;
      this.lastAppliedSearchSeq = 0;

      // 2. UIを有効化
      this.els.userInput.disabled = false;
      this.els.sendBtn.disabled = false;
      this.els.micBtn.disabled = false;
      this.els.speakerBtn.disabled = false;
      this.els.speakerBtn.classList.remove('disabled');
      this.els.reservationBtn.classList.remove('visible');

      // 3. ★ LiveAPIで初期挨拶を開始
      //    REST APIの greetingText + speakTextGCP() は全て削除
      //    preGeneratedAcks のTTS事前生成も削除
      //    R2.0 §8.3: マイクがなくても Live を始める。音を出せる状態にしてから live_start を送る
      this.liveTextReady = false;
      this.pendingLiveTexts = [];
      this.liveAudioManager.allowWithoutMic = true;
      await this.prepareAudioOutput();
      await this.startLiveMode();

    } catch (e) {
      console.error('[Session] Initialization error:', e);
    }
  }

  // ========================================
  // 🔧 Socket.IOの初期化をオーバーライド
  // ★ 親クラスを呼んでLiveAPIリスナーも登録（仕様書02 セクション4.4.3）
  // ========================================
  protected initSocket() {
    // ★ 親クラスのinitSocket()を呼んでLiveAPIリスナーも登録
    super.initSocket();

    // コンシェルジュ版のtranscriptハンドラを上書き
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

    // キーボード入力を Live に送れるかどうか（R2.0 §8.2・§8.3）。親のリスナーはそのまま残し、追加で聞く
    this.socket.on('greeting_done', () => {
      this.liveTextReady = true;
      this.flushPendingLiveTexts();
    });
    this.socket.on('live_reconnecting', () => {
      this.liveTextReady = false;
    });
    this.socket.on('live_reconnected', () => {
      this.liveTextReady = true;
      this.flushPendingLiveTexts();
    });
    this.socket.on('live_text_rejected', (data: any) => {
      console.warn('[Concierge] キーボード入力を Live に送れなかった:', data?.reason);
      this.showError('メッセージの送信に失敗しました。');
    });

    // ショップ検索の開始・結果は親のリスナーを外して、applySearchOutcome() を通す（R1.4 §8.2・§8.3）
    this.socket.off('shop_search_start');
    this.socket.off('shop_search_result');
    this.socket.on('shop_search_start', () => {
      console.log('[Concierge] shop_search_start: 待機アニメーション表示');
      this.showWaitOverlay();
    });
    this.socket.on('shop_search_result', (data: any) => {
      console.log('[Concierge] shop_search_result:', data?.status, data?.search_seq);
      // 待機画面は状態に関係なく消す（現行どおり）
      this.hideWaitOverlay();
      this.applySearchOutcome(data, data?.shops || []);
    });
  }

  // ========================================
  // 🎯 検索結果の反映（R1.4 §8.2）
  // Live の shop_search_result と /api/chat の outcome はどちらもここを通す
  // ========================================
  private applySearchOutcome(outcome: any, shops: any[]): boolean {
    if (!outcome) return false;
    // (1) 今のセッションと違えば捨てる
    if (outcome.session_id && outcome.session_id !== this.sessionId) return false;
    // (2) 画面に反映した最後の番号以下ならカードを変えない
    const seq = typeof outcome.search_seq === 'number' ? outcome.search_seq : null;
    if (seq !== null && seq <= this.lastAppliedSearchSeq) return false;
    // (3) complete のときだけカードを入れ替える。not_found・error・superseded は変えない
    if (outcome.status !== 'complete' || !shops || shops.length === 0) return false;

    this.currentShops = shops;
    this.els.reservationBtn?.classList.add('visible');
    document.dispatchEvent(new CustomEvent('displayShops', {
      detail: { shops: shops, language: this.currentLanguage }
    }));
    const section = document.getElementById('shopListSection');
    if (section) section.classList.add('has-shops');
    if (window.innerWidth < 1024) {
      setTimeout(() => {
        const shopSection = document.getElementById('shopListSection');
        if (shopSection) shopSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 300);
    }
    if (seq !== null) this.lastAppliedSearchSeq = seq;
    return true;
  }

  // コンシェルジュモード固有: REST TTS を止める（R1.4 §8.1、ミッション③）
  // AI の発話は Live だけ。リップシンクは LiveAudioManager→A2E→LAMAvatar の自動同期のまま。
  // 共通の CoreController.speakTextGCP は変えない
  protected async speakTextGCP(_text: string, _stopPrevious: boolean = true, _autoRestartMic: boolean = false, _skipAudio: boolean = false) {
    return Promise.resolve();
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
  // 🎯 UI言語更新をオーバーライド(挨拶文をコンシェルジュ用に)
  // ========================================
  protected updateUILanguage() {
    // ✅ バックエンドからの長期記憶対応済み挨拶を保持
    const initialMessage = this.els.chatArea.querySelector('.message.assistant[data-initial="true"] .message-text');
    const savedGreeting = initialMessage?.textContent;

    // 親クラスのupdateUILanguageを実行（UIラベル等を更新）
    super.updateUILanguage();

    // ✅ 長期記憶対応済み挨拶を復元（親が上書きしたものを戻す）
    if (initialMessage && savedGreeting) {
      initialMessage.textContent = savedGreeting;
    }

    // ✅ ページタイトルをコンシェルジュ用に設定
    const pageTitle = document.getElementById('pageTitle');
    if (pageTitle) {
      pageTitle.innerHTML = `<img src="/pwa-152x152.png" alt="Logo" class="app-logo" /> ${this.t('pageTitleConcierge')}`;
    }
  }

  // モード切り替え処理 - ページ遷移
  private toggleMode() {
    const isChecked = this.els.modeSwitch?.checked;
    if (!isChecked) {
      // レッスンモードへページ遷移
      console.log('[ConciergeController] Switching to Lesson mode...');
      window.location.href = '/';
    }
    // コンシェルジュモードは既に現在のページなので何もしない
  }

  // すべての活動を停止(アバターアニメーションも含む)（仕様書08 セクション7.3）
  protected stopAllActivities() {
    super.stopAllActivities();
    this.stopAvatarAnimation();
    // ★ LAMAvatar フレームバッファクリア
    if (this.lamAvatarController) {
      this.lamAvatarController.resetExpression();
    }
  }

  // ========================================
  // 🎯 コンシェルジュモード専用: 音声入力完了時の即答処理
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
        // 短文の注意は文字表示だけ（R1.4 §8.1）
        const msg = this.t('shortMsgWarning');
        this.addMessage('assistant', msg);
        this.els.userInput.value = '';
        this.els.voiceStatus.innerHTML = this.t('voiceStatusStopped');
        this.els.voiceStatus.className = 'voice-status stopped';
        return;
    }

    // 「はい」の相槌は文字表示だけ（R1.4 §8.1）
    const ackText = this.t('ackYes'); // 「はい」のみ
    this.addMessage('assistant', ackText);

    // すぐにLLMへ送信
    if (this.els.userInput.value.trim()) {
      this.isFromVoiceInput = true;
      this.sendMessage();
    }
    
    this.els.voiceStatus.innerHTML = this.t('voiceStatusStopped');
    this.els.voiceStatus.className = 'voice-status stopped';
  }

  // ========================================
  // 🎯 コンシェルジュモード専用: メッセージ送信処理
  // R2.0 §8.2: キーボード入力も Live に送り、Live の 1 回の応答から音声（live_audio）と
  // テキスト（ai_transcript）を出す。/api/chat（文字だけの返答）には送らない
  // ========================================
  protected async sendMessage() {
    this.unlockAudioParams();
    const message = this.els.userInput.value.trim();
    if (!message) return;

    this.els.userInput.value = '';
    this.isFromVoiceInput = false;
    this.addMessage('user', message);
    // 利用者の操作の中で再生を再開しておく（自動再生の制限への備え）
    this.liveAudioManager.resumeOutput().catch(() => {});

    this.pendingLiveTexts.push(message);
    this.flushPendingLiveTexts();
    this.els.userInput.blur();
  }

  // 送れる状態なら、溜まっているテキストを順に Live へ送る
  private flushPendingLiveTexts() {
    if (!this.isLiveMode || !this.socket || !this.socket.connected || !this.liveTextReady) return;
    while (this.pendingLiveTexts.length > 0) {
      const text = this.pendingLiveTexts.shift() as string;
      this.socket.emit('live_text_in', { text });
    }
  }

  // ========================================
  // R2.0 §8.3: Live を始める前に、音を出せる状態にする
  // AudioContext が suspended なら、既存の音声許可の案内をタップしてもらってから Live を始める。
  // Greeting は live_start を受けてサーバーが作るので、必ず再生できる状態で届く
  // （届いた Greeting は今と同じく AVATAR_VISIBLE まで保留される）
  // ========================================
  private async prepareAudioOutput(): Promise<void> {
    if (!this.socket) return;
    await this.liveAudioManager.initialize(this.socket);
    if (this.liveAudioManager.isOutputRunning()) return;
    await new Promise<void>((resolve) => {
      const prompt = document.createElement('div');
      prompt.className = 'click-prompt';
      prompt.innerHTML = `<p>🔊</p><p>${this.t('clickPrompt')}</p><p>🔊</p>`;
      prompt.addEventListener('click', async () => {
        try {
          await this.liveAudioManager.resumeOutput();
        } catch (e) {
          console.warn('[Concierge] 再生の再開に失敗:', e);
        }
        this.enableAudioPlayback();
        prompt.remove();
        resolve();
      }, { once: true });
      this.container.style.position = 'relative';
      this.container.appendChild(prompt);
    });
  }

  // ========================================
  // R2.0 §8.3: マイクがない状態でマイクボタンが押されたら、そこで改めてマイクを求める
  // ========================================
  protected async toggleRecording() {
    if (this.isLiveMode && !this.liveAudioManager.hasMicrophone()) {
      try {
        await this.liveAudioManager.enableMicrophone();
      } catch (e) {
        console.warn('[Concierge] マイクを取得できない:', e);
        this.showError(this.t('micAccessError'));
        return;
      }
    }
    await super.toggleRecording();
  }

}
