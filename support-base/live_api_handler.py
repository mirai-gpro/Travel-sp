# -*- coding: utf-8 -*-
"""
Gemini LiveAPI ハンドラ（WebSocket プロキシ）
stt_stream.py の GeminiLiveApp をWebアプリ向けに改変

【重要】
- 本ファイルの実装は 01_stt_stream_detailed_spec.md のセクション5-9に準拠する
- LiveAPI の設定値・メソッド名は仕様書のコード引用を正解とする
- 推測でメソッド名や引数を変えてはならない
"""

import asyncio
import base64
import os
import logging
import struct
import time
import httpx
from scipy.signal import resample_poly
import numpy as np
from google import genai
from google.genai import types
from google.cloud import texttospeech

logger = logging.getLogger(__name__)

# A2E (Audio2Expression) サービス設定
A2E_SERVICE_URL = os.getenv("A2E_SERVICE_URL", "https://audio2exp-service-417509577941.us-central1.run.app")
# プロトコルが省略された場合に自動補完
if A2E_SERVICE_URL and not A2E_SERVICE_URL.startswith("http"):
    A2E_SERVICE_URL = f"https://{A2E_SERVICE_URL}"
A2E_MIN_BUFFER_BYTES = 4800      # 最低バッファサイズ（24kHz 16bit mono × 0.1秒 = 4800bytes）
A2E_PUNCTUATION_MIN_BYTES = 1000 # 句読点フラッシュ時の緩い閾値（初期あいさつ冒頭の空振り防止）
A2E_FIRST_FLUSH_BYTES = 4800     # 初回フラッシュ閾値（0.1秒分 = 4800bytes）遅延最小化
A2E_AUTO_FLUSH_BYTES = 240000    # 2回目以降フラッシュ閾値（5秒分 = 240000bytes）
A2E_EXPRESSION_FPS = 30

# stt_stream.py から転記（変更禁止）
LIVE_API_MODEL = "gemini-2.5-flash-native-audio-preview-12-2025"
MAX_AI_CHARS_BEFORE_RECONNECT = 800
LONG_SPEECH_THRESHOLD = 500

# ============================================================
# ショップ検索UX: 事前生成キャッシュ音声（24kHz 16bit mono PCM）
# ============================================================
_CACHED_SEARCHING_PCM: bytes | None = None   # 「お店をお探ししますね」(0.5秒後)
_CACHED_PLEASE_WAIT_PCM: bytes | None = None  # 「只今、お店の情報を確認中です。もう少々お待ち下さい」(6.5秒後)
_CACHED_ANNOUNCE_PCM: bytes | None = None   # 「お待たせしました、お店をご紹介しますね！」(検索完了時)
_CACHED_BRIDGE_PCM: bytes | None = None    # 「お待たせしました。それではお薦めのお店をご紹介します。」(ショップ紹介前の場繋ぎ)


def _generate_cached_audio():
    """起動時にTTSで音声を事前生成し、24kHz 16bit mono PCMとしてキャッシュ"""
    global _CACHED_SEARCHING_PCM, _CACHED_PLEASE_WAIT_PCM, _CACHED_ANNOUNCE_PCM, _CACHED_BRIDGE_PCM
    try:
        tts_client = texttospeech.TextToSpeechClient()
        voice = texttospeech.VoiceSelectionParams(
            language_code="ja-JP",
            name="ja-JP-Chirp3-HD-Leda"
        )
        # LiveAPIと同じ24kHz LINEAR16で生成
        audio_config = texttospeech.AudioConfig(
            audio_encoding=texttospeech.AudioEncoding.LINEAR16,
            sample_rate_hertz=24000,
        )

        messages = {
            'searching': 'お店をお探ししますね',
            'please_wait': '只今、お店の情報を確認中です。もう少々お待ち下さい',
            'announce': 'お待たせしました、お店をご紹介しますね！',
            'bridge': 'お待たせしました。それではお薦めのお店をご紹介します。',
        }

        for key, text in messages.items():
            resp = tts_client.synthesize_speech(
                input=texttospeech.SynthesisInput(text=text),
                voice=voice,
                audio_config=audio_config,
            )
            # LINEAR16レスポンスにはWAVヘッダ(44bytes)が付くので除去
            pcm = resp.audio_content[44:]
            if key == 'searching':
                _CACHED_SEARCHING_PCM = pcm
            elif key == 'please_wait':
                _CACHED_PLEASE_WAIT_PCM = pcm
            elif key == 'bridge':
                _CACHED_BRIDGE_PCM = pcm
            else:
                _CACHED_ANNOUNCE_PCM = pcm
            logger.info(f"[CachedAudio] '{key}' 生成完了: {len(pcm)} bytes")

    except Exception as e:
        logger.error(f"[CachedAudio] 事前生成失敗: {e}")


# モジュール読み込み時に事前生成
_generate_cached_audio()

# ============================================================
# プロンプト: GCSプロンプト（SYSTEM_PROMPTS）に移行済み
# build_system_instruction() で GCS/ローカルのプロンプトを参照
# ============================================================


def build_system_instruction(mode: str, user_profile: dict = None,
                             system_prompts: dict = None, language: str = 'ja') -> str:
    """モードに応じたシステムインストラクションを組み立てる
    （03_prompt_modification_spec.md セクション7.1）

    GCSプロンプト（system_prompts）をベースに、動的パラメータを埋め込む。

    Args:
        mode: 'chat', 'concierge', or 'lesson'
        user_profile: コンシェルジュ/レッスンモード用。
            {
                'is_first_visit': bool,
                'preferred_name': str or None,
                'name_honorific': str or None,
                'lesson_teacher_name': str or None,  # lessonモード用
            }
        system_prompts: GCS/ローカルから読み込んだプロンプト辞書
            {
                'chat': {'ja': '...', ...},
                'concierge': {'ja': '...', ...},
                'lesson': {'ja': '...', ...}
            }
    """
    # GCSプロンプトからベーステキストを取得
    lang = language
    if system_prompts:
        base_prompt = system_prompts.get(mode, {}).get(lang, '')
    else:
        base_prompt = ''
        logger.warning("[LiveAPI] system_prompts が未設定。プロンプトが空になります。")

    if mode == 'concierge':
        # ユーザープロファイルに応じた初期あいさつ指示を構築
        user_context = _build_concierge_user_context(user_profile)
        return base_prompt.replace('{user_context}', user_context)
    elif mode == 'lesson':
        # レッスンモード: 講師名・ユーザー名・user_contextを埋め込む
        teacher_name = (user_profile or {}).get('lesson_teacher_name', 'Lisa')
        user_context = _build_lesson_user_context(user_profile)
        prompt = base_prompt.replace('{teacher_name}', teacher_name)
        prompt = prompt.replace('{user_context}', user_context)
        # {user_name} はプロンプト内の例示用テンプレートなのでそのまま残す
        # （LLMが実際の名前を user_context から取得して使う）
        return prompt
    else:
        return base_prompt


def _build_concierge_user_context(user_profile: dict = None) -> str:
    """コンシェルジュモードのユーザーコンテキストを構築"""
    if not user_profile:
        # プロファイル不明 → 新規ユーザー扱い
        return _get_first_visit_context()

    is_first_visit = user_profile.get('is_first_visit', True)
    preferred_name = user_profile.get('preferred_name', '')
    name_honorific = user_profile.get('name_honorific', '')

    if is_first_visit or not preferred_name:
        return _get_first_visit_context()
    else:
        return _get_returning_user_context(preferred_name, name_honorific)


def _get_first_visit_context() -> str:
    """新規ユーザー用コンテキスト: 名前を聞く"""
    return """## 初期あいさつ（新規ユーザー）
このユーザーは初めての来訪です。
最初の発話で「初めまして、AIコンシェルジュです。よろしければ、何とお呼びすればいいか教えてください。」と名前を聞いてください。
ユーザーが名前を教えてくれたら、その名前で呼びかけてから、お店探しの会話を始めてください。"""


def _get_returning_user_context(preferred_name: str, name_honorific: str) -> str:
    """リピーター用コンテキスト: 名前で呼びかける"""
    full_name = f"{preferred_name}{name_honorific}"
    return f"""## 初期あいさつ（リピーター）
このユーザーの名前は「{full_name}」です。
最初の発話で「お帰りなさいませ、{full_name}。今日はどのようなお食事をお考えですか？」と名前を呼んで挨拶してください。
以降の会話でも「{full_name}」と呼びかけてください。"""


# ============================================================
# レッスンモード用コンテキスト構築
# ============================================================

def _build_lesson_user_context(user_profile: dict = None) -> str:
    """レッスンモードのユーザーコンテキストを構築"""
    if not user_profile:
        return _get_lesson_first_visit_context()

    is_first_visit = user_profile.get('is_first_visit', True)
    preferred_name = user_profile.get('preferred_name', '')
    name_honorific = user_profile.get('name_honorific', 'さん')
    teacher_name = user_profile.get('lesson_teacher_name', 'Lisa')

    if is_first_visit or not preferred_name:
        return _get_lesson_first_visit_context(teacher_name)
    else:
        return _get_lesson_returning_context(preferred_name, name_honorific, teacher_name)


def _get_lesson_first_visit_context(teacher_name: str = 'Lisa') -> str:
    """レッスンモード: 新規ユーザー用コンテキスト"""
    return f"""## 初期あいさつ（新規ユーザー）
このユーザーは初めてのレッスンです。
最初の発話で、まず英語で、次に日本語で自己紹介とレッスン案内をしてください。
英語: "Hi! I'm {teacher_name}, your English teacher. We have two options: travel English lessons, or free talk sessions with me. Which would you like to start with?"
日本語: 「こんにちは、英会話の先生の{teacher_name}です。旅行で使える英会話レッスンや、私との英語のフリートークレッスンができます。今日は、どちらからやりますか？」
ユーザーが名前を教えてくれたら、その名前で呼びかけてください。"""


def _get_lesson_returning_context(preferred_name: str, name_honorific: str,
                                   teacher_name: str = 'Lisa') -> str:
    """レッスンモード: リピーター用コンテキスト"""
    full_name = f"{preferred_name}{name_honorific}"
    return f"""## 初期あいさつ（リピーター）
このユーザーの名前は「{full_name}」です。
最初の発話で、まず英語で、次に日本語で挨拶とレッスン案内をしてください。
英語: "Welcome back, {full_name}! Shall we do a travel English lesson today, or would you like a free talk session with me?"
日本語: 「おかえりなさい、{full_name}。今日は、旅行で使える英会話レッスンか、私との英語のフリートークレッスン、どちらからやりますか？」"""


# ============================================================
# Function Calling 定義（v5 §5.2）
# ============================================================

SEARCH_SHOPS_DECLARATION = types.FunctionDeclaration(
    name="search_shops",
    description="ユーザーの条件に基づいてレストランを検索する。条件が十分に揃ったと判断した時に呼び出す。user_requestには会話で確認した全条件を必ず含めること。",
    parameters=types.Schema(
        type="OBJECT",
        properties={
            "user_request": types.Schema(
                type="STRING",
                description="検索条件の要約。会話で確定した全条件（エリア・ジャンル/シーン・予算・人数・その他希望）を漏れなく含めること。例: '六本木 接待向けイタリアン 予算1万円 4名 個室希望'"
            )
        },
        required=["user_request"]
    )
)

UPDATE_USER_PROFILE_DECLARATION = types.FunctionDeclaration(
    name="update_user_profile",
    description="ユーザーが名前を教えてくれた時、または名前の変更を依頼された時に呼び出す。初回の名前登録にも、名前変更にも使用する。",
    parameters=types.Schema(
        type="OBJECT",
        properties={
            "preferred_name": types.Schema(
                type="STRING",
                description="ユーザーの名前（例: 太郎、花子）"
            ),
            "name_honorific": types.Schema(
                type="STRING",
                description="敬称（例: 様、さん、くん）。デフォルトは「様」"
            )
        },
        required=["preferred_name"]
    )
)


# ============================================================
# LiveAPISession クラス
# ============================================================

class LiveAPISession:
    """
    1つのブラウザクライアントに対応するLiveAPIセッション

    stt_stream.py の GeminiLiveApp を参考に、以下を移植:
    - Live API接続設定 (仕様書 セクション5.2)
    - 音声送受信 (仕様書 セクション7)
    - 再接続メカニズム (仕様書 セクション8)
    - エラーハンドリング (仕様書 セクション9)
    """

    # ========================================
    # 初期あいさつ用ダミーメッセージ（モード別・言語別）
    # ========================================
    INITIAL_GREETING_TRIGGERS = {
        'chat': {
            'ja': 'こんにちは。お店探しを手伝ってください。',
            'en': 'Hello. I need help finding a restaurant.',
            'zh': '你好，请帮我找餐厅。',
            'ko': '안녕하세요. 레스토랑을 찾아주세요.',
        },
        'concierge': {
            'ja': 'こんにちは。',
            'en': 'Hello.',
            'zh': '你好。',
            'ko': '안녕하세요.',
        },
        'lesson': {
            'ja': 'こんにちは。英会話のレッスンをお願いします。',
            'en': 'Hello. I would like an English conversation lesson.',
            'zh': '你好。我想上英语会话课。',
            'ko': '안녕하세요. 영어 회화 레슨을 부탁합니다.',
        },
    }

    def __init__(self, session_id: str, mode: str, language: str,
                 system_prompt: str, socketio, client_sid: str,
                 shop_search_callback=None, user_id: str = None,
                 voice_model: str = '', live_voice: str = ''):
        self.session_id = session_id
        self.mode = mode
        self.language = language
        self.system_prompt = system_prompt  # 外部から受け取る（将来GCS移行対応）
        self.socketio = socketio
        self.client_sid = client_sid
        self._shop_search_callback = shop_search_callback  # v5 §5.5: ショップ検索用コールバック
        self.voice_model = voice_model  # REST TTS用音声モデル名（例: ja-JP-Chirp3-HD-Leda）
        self.live_voice = live_voice    # LiveAPI用音声名（例: Leda）
        self.user_id = user_id  # 長期記憶のプロファイル更新に使用

        # 初期あいさつフェーズ（ダミーメッセージのinput_transcriptionを非表示）
        # （仕様書02 セクション4.5.5）
        self._is_initial_greeting_phase = True

        # Gemini APIクライアント
        api_key = os.getenv("GEMINI_API_KEY")
        self.client = genai.Client(api_key=api_key)

        # 状態管理（stt_stream.py:387-394 から転記）
        self.user_transcript_buffer = ""
        self.ai_transcript_buffer = ""
        self.conversation_history = []
        self.ai_char_count = 0
        self.needs_reconnect = False
        self.session_count = 0

        # 再接続時のトリガーメッセージ（§7.1）
        self._resume_message = None

        # ★ A2Eバッファリング機構（仕様書08 セクション3.1）
        self._a2e_audio_buffer = bytearray()       # PCMチャンク蓄積用
        self._a2e_transcript_buffer = ""            # 句読点検出用
        self._a2e_chunk_index = 0                   # expression同期用チャンク識別子
        self._a2e_http_client = httpx.AsyncClient(timeout=10.0)
        self._a2e_send_queue: asyncio.Queue = asyncio.Queue()
        self._a2e_worker_task: asyncio.Task | None = None

        # 非同期キュー
        self.audio_queue_to_gemini = None
        self.is_running = False

    def _build_config(self, with_context=None):
        """
        Live API接続設定を構築

        【厳守】仕様書 セクション5.2 のconfig辞書をそのまま使う。
        """
        instruction = self.system_prompt

        if with_context:
            last_user_message = ""
            for h in reversed(self.conversation_history):
                if h['role'] == 'user':
                    last_user_message = h['text'][:100]
                    break

            instruction += f"""

【これまでの会話の要約】
{with_context}

【重要：必ず守ること】
1. 直前のユーザーの発言「{last_user_message}」に対して短い相槌を入れる
2. 既に話した内容は繰り返さない
"""

        config = {
            "response_modalities": ["AUDIO"],
            "system_instruction": instruction,
            "input_audio_transcription": {},
            "output_audio_transcription": {},
            "speech_config": self._get_speech_config(),
            "realtime_input_config": {
                "automatic_activity_detection": {
                    "disabled": False,
                    "start_of_speech_sensitivity": "START_SENSITIVITY_HIGH",
                    "end_of_speech_sensitivity": "END_SENSITIVITY_HIGH",
                    "prefix_padding_ms": 100,
                    "silence_duration_ms": 500,
                }
            },
            "context_window_compression": {
                "sliding_window": {
                    "target_tokens": 32000,
                }
            },
        }

        # モードに応じたfunction calling定義
        if self.mode == 'lesson':
            # lessonモードはショップ検索不要、プロファイル更新のみ
            config["tools"] = [types.Tool(function_declarations=[UPDATE_USER_PROFILE_DECLARATION])]
        else:
            # conciergeモード等はショップ検索 + プロファイル更新
            config["tools"] = [types.Tool(function_declarations=[SEARCH_SHOPS_DECLARATION, UPDATE_USER_PROFILE_DECLARATION])]

        return config

    def _get_speech_language_code(self):
        """言語コードをLiveAPI形式に変換"""
        lang_map = {
            'ja': 'ja-JP',
            'en': 'en-US',
            'zh': 'zh-CN',
            'ko': 'ko-KR',
        }
        return lang_map.get(self.language, 'ja-JP')

    def _get_speech_config(self) -> dict:
        """speech_config辞書を構築"""
        config = {
            "language_code": self._get_speech_language_code(),
        }
        # LiveAPI用voice名（Puck, Charon, Kore, Fenrir, Aoede, Leda, Orus, Zephyr）
        if self.live_voice:
            config["voice_config"] = {
                "prebuilt_voice_config": {
                    "voice_name": self.live_voice
                }
            }
            logger.info(f"[LiveAPI] live_voice設定: {self.live_voice}")
        if self.voice_model:
            logger.info(f"[LiveAPI] voice_model設定あり（REST TTS用）: {self.voice_model}")
        return config

    def enqueue_audio(self, pcm_bytes: bytes):
        """ブラウザから受信したPCMデータをキューに追加"""
        if self.audio_queue_to_gemini and self.is_running:
            try:
                self.audio_queue_to_gemini.put_nowait(pcm_bytes)
            except asyncio.QueueFull:
                pass  # キューが満杯の場合はドロップ

    def stop(self):
        """セッションを停止"""
        self.is_running = False
        self.needs_reconnect = False

    async def run(self):
        """
        メインループ（再接続対応）
        仕様書 セクション6.1 の run() を移植
        """
        self.audio_queue_to_gemini = asyncio.Queue(maxsize=5)
        self.is_running = True
        self._a2e_worker_task = asyncio.ensure_future(self._a2e_send_worker())

        try:
            while self.is_running:
                self.session_count += 1
                self.ai_char_count = 0
                self.needs_reconnect = False

                context = None
                if self.session_count > 1:
                    context = self._get_context_summary()

                config = self._build_config(with_context=context)

                try:
                    async with self.client.aio.live.connect(
                        model=LIVE_API_MODEL,
                        config=config
                    ) as session:

                        if self.session_count == 1:
                            # 初回接続: ダミーメッセージで初期あいさつを発火
                            self._is_initial_greeting_phase = True
                            trigger_msgs = self.INITIAL_GREETING_TRIGGERS
                            mode_msgs = trigger_msgs.get(self.mode, trigger_msgs['chat'])
                            dummy_text = mode_msgs.get(self.language, mode_msgs['ja'])

                            await session.send_client_content(
                                turns=types.Content(
                                    role="user",
                                    parts=[types.Part(text=dummy_text)]
                                ),
                                turn_complete=True
                            )
                            logger.info(f"[LiveAPI] 初期あいさつトリガー送信: '{dummy_text}'")
                        else:
                            # 再接続時（v5 §7.1: 履歴再送 → トリガーの2段階送信）
                            self._is_initial_greeting_phase = False
                            self.socketio.emit('live_reconnecting', {},
                                               room=self.client_sid)

                            # ★ 1008で中断された未処理のユーザー発話を履歴に救済
                            if self.user_transcript_buffer.strip():
                                rescued_text = self.user_transcript_buffer.strip()
                                self._add_to_history("user", rescued_text)
                                logger.info(f"[LiveAPI] 再接続: 未処理ユーザー発話を履歴に救済: '{rescued_text}'")
                                self.user_transcript_buffer = ""

                            # 1. 会話履歴turnsを再送（turn_complete=False）
                            await self._send_history_on_reconnect(session)

                            # 2. トリガーメッセージ（turn_complete=True）
                            resume_text = self._resume_message or "続きをお願いします"
                            self._resume_message = None
                            await session.send_client_content(
                                turns=types.Content(
                                    role="user",
                                    parts=[types.Part(text=resume_text)]
                                ),
                                turn_complete=True
                            )
                            logger.info("[LiveAPI] 再接続: 履歴再送+トリガー送信完了")
                            self.socketio.emit('live_reconnected', {},
                                               room=self.client_sid)

                        await self._session_loop(session)

                        if not self.needs_reconnect:
                            break

                except Exception as e:
                    error_msg = str(e).lower()
                    if any(kw in error_msg for kw in
                           ["1011", "internal error", "disconnected",
                            "closed", "websocket"]):
                        logger.warning(f"[LiveAPI] 接続エラー、3秒後に再接続: {e}")
                        await asyncio.sleep(3)
                        self.needs_reconnect = True
                        continue
                    else:
                        # 致命的エラー: ログ出力して終了（RESTフォールバックなし）
                        logger.error(f"[LiveAPI] 致命的エラー: {e}")
                        break

        except asyncio.CancelledError:
            pass
        finally:
            if self._a2e_worker_task:
                self._a2e_worker_task.cancel()
                self._a2e_worker_task = None
            self.is_running = False
            logger.info(f"[LiveAPI] セッション終了: {self.session_id}")

    async def _session_loop(self, session):
        """
        セッション内ループ
        仕様書 セクション7.1: 2つのタスクを並行実行
        """
        async def send_audio():
            """ブラウザからの音声をLiveAPIに転送"""
            while not self.needs_reconnect and self.is_running:
                try:
                    audio_data = await asyncio.wait_for(
                        self.audio_queue_to_gemini.get(),
                        timeout=0.1
                    )
                    await session.send_realtime_input(
                        audio={"data": audio_data, "mime_type": "audio/pcm;rate=16000"}
                    )
                except asyncio.TimeoutError:
                    continue
                except Exception as e:
                    if self.needs_reconnect or not self.is_running:
                        return
                    logger.error(f"[LiveAPI] 送信エラー: {e}")
                    self.needs_reconnect = True
                    return

        async def receive():
            """LiveAPIからの応答を受信してブラウザに転送"""
            try:
                await self._receive_and_forward(session)
            except Exception as e:
                if self.needs_reconnect or not self.is_running:
                    return
                error_msg = str(e).lower()
                if any(kw in error_msg for kw in
                       ["1011", "1008", "internal error",
                        "closed", "deadline", "policy"]):
                    logger.warning(f"[LiveAPI] 受信エラー（再接続）: {e}")
                    self.needs_reconnect = True
                else:
                    logger.error(f"[LiveAPI] 受信致命エラー: {e}")
                    raise

        # キューをクリア
        while not self.audio_queue_to_gemini.empty():
            try:
                self.audio_queue_to_gemini.get_nowait()
            except asyncio.QueueEmpty:
                break

        try:
            async with asyncio.TaskGroup() as tg:
                tg.create_task(send_audio())
                tg.create_task(receive())
        except* Exception as eg:
            if not self.needs_reconnect:
                for e in eg.exceptions:
                    error_msg = str(e).lower()
                    if any(kw in error_msg for kw in
                           ["1011", "internal error", "closed", "websocket"]):
                        self.needs_reconnect = True
                    else:
                        logger.error(f"[LiveAPI] タスクエラー: {e}")

    async def _receive_and_forward(self, session):
        """
        LiveAPIレスポンスを受信してSocket.IOでブラウザに転送
        仕様書 セクション7.3 の receive_audio() を移植
        """
        while not self.needs_reconnect and self.is_running:
            turn = session.receive()
            async for response in turn:
                if self.needs_reconnect or not self.is_running:
                    return

                # 1. tool_call: search_shops（v5 §5.4）
                if hasattr(response, 'tool_call') and response.tool_call:
                    await self._handle_tool_call(response.tool_call, session)
                    continue

                if response.server_content:
                    sc = response.server_content

                    # 2. ターン完了
                    if hasattr(sc, 'turn_complete') and sc.turn_complete:
                        # ★ A2E: 残存バッファを強制フラッシュ（最終チャンク）
                        await self._flush_a2e_buffer(force=True, is_final=True)
                        await self._a2e_send_queue.join()  # 全チャンク送信完了を待つ
                        self._a2e_chunk_index = 0  # 次ターン用にリセット
                        self._process_turn_complete()
                        self.socketio.emit('turn_complete', {},
                                           room=self.client_sid)

                        # 初期あいさつフェーズ終了（仕様書02 セクション4.5.5）
                        if self._is_initial_greeting_phase:
                            self._is_initial_greeting_phase = False
                            self.socketio.emit('greeting_done', {},
                                               room=self.client_sid)
                            logger.info("[LiveAPI] greeting_done送信")

                            # ★ keep-alive: セッション安定化（1008予防）
                            # greeting_done後、ユーザーがマイクを押す前に空ターンを送信
                            await session.send_client_content(
                                turns=types.Content(
                                    role="user",
                                    parts=[types.Part(text="")]
                                ),
                                turn_complete=False
                            )
                            logger.info("[LiveAPI] keep-alive送信（greeting後）")

                    # 3. 割り込み検知
                    if hasattr(sc, 'interrupted') and sc.interrupted:
                        # ★ A2E: 割り込み時はキュークリア（未送信チャンク破棄）
                        self._clear_a2e_queue()
                        self._a2e_chunk_index = 0  # 次ターン用にリセット
                        self.ai_transcript_buffer = ""
                        self.socketio.emit('interrupted', {},
                                           room=self.client_sid)
                        continue

                    # 4. 入力トランスクリプション
                    #    初期あいさつフェーズのinput_transcriptionは転送しない
                    #    （仕様書02 セクション4.5.5）
                    if (hasattr(sc, 'input_transcription')
                            and sc.input_transcription):
                        text = sc.input_transcription.text
                        if text and not self._is_initial_greeting_phase:
                            self.user_transcript_buffer += text
                            self.socketio.emit('user_transcript',
                                               {'text': text},
                                               room=self.client_sid)

                    # 5. 出力トランスクリプション
                    if (hasattr(sc, 'output_transcription')
                            and sc.output_transcription):
                        text = sc.output_transcription.text
                        if text:
                            self.ai_transcript_buffer += text
                            self.socketio.emit('ai_transcript',
                                               {'text': text},
                                               room=self.client_sid)
                            # ★ A2E: 句読点検出フラッシュ（キュー直列化で順序保証済み）
                            self._on_output_transcription(text)

                    # 6. 音声データ
                    if sc.model_turn:
                        for part in sc.model_turn.parts:
                            if (hasattr(part, 'inline_data')
                                    and part.inline_data):
                                if isinstance(part.inline_data.data, bytes):
                                    audio_b64 = base64.b64encode(
                                        part.inline_data.data
                                    ).decode('utf-8')
                                    self.socketio.emit('live_audio',
                                                       {'data': audio_b64},
                                                       room=self.client_sid)
                                    # ★ A2E: PCMバッファ蓄積（仕様書08 セクション3.2）
                                    self._buffer_for_a2e(part.inline_data.data)

    async def _handle_tool_call(self, tool_call, session):
        """
        LLMからのfunction calling応答を処理する（v5 §5.4）
        search_shops の場合、ショップ検索を実行する。
        """
        for fc in tool_call.function_calls:
            if fc.name == "search_shops":
                user_request = fc.args.get("user_request", "")
                logger.info(f"[LiveAPI] search_shops呼び出し: '{user_request}'")

                # 検索開始をブラウザに通知 → 待機アニメーション表示（§3.6.3）
                self.socketio.emit('shop_search_start', {},
                                   room=self.client_sid)

                # 0.5秒後「お店をお探ししますね」+ 6.5秒後「只今…確認中です」を並行起動
                # ★ テスト: キャッシュ音声を無効化（A2Eバッファ汚染の切り分け）
                # searching_task = asyncio.ensure_future(
                #     self._delayed_cached_audio(_CACHED_SEARCHING_PCM, delay=0.5)
                # )
                # please_wait_task = asyncio.ensure_future(
                #     self._delayed_cached_audio(_CACHED_PLEASE_WAIT_PCM, delay=6.5)
                # )
                searching_task = asyncio.ensure_future(asyncio.sleep(0))
                please_wait_task = asyncio.ensure_future(asyncio.sleep(0))

                # ショップ検索を実行
                await self._handle_shop_search(user_request)

                # 検索完了 → 未再生のタスクをキャンセル
                for task, name in [(searching_task, 'searching'), (please_wait_task, 'please_wait')]:
                    if not task.done():
                        task.cancel()
                        logger.info(f"[CachedAudio] {name}: 検索完了によりスキップ")

                # function responseを返す（LiveAPI SDK: キーワード引数必須）
                await session.send_tool_response(
                    function_responses=[types.FunctionResponse(
                        name=fc.name,
                        id=fc.id,
                        response={"result": "検索結果をユーザーに表示しました"}
                    )]
                )
            elif fc.name == "update_user_profile":
                # ユーザー名登録・変更をDBに永続化
                updates = fc.args or {}
                if updates and self.user_id:
                    try:
                        from long_term_memory import LongTermMemory
                        ltm = LongTermMemory()
                        success = ltm.update_profile(self.user_id, updates)
                        if success:
                            logger.info(f"[LiveAPI] プロファイル更新成功: updates={updates}, user_id={self.user_id}")
                        else:
                            logger.error(f"[LiveAPI] プロファイル更新失敗: updates={updates}, user_id={self.user_id}")
                    except Exception as e:
                        logger.error(f"[LiveAPI] プロファイル更新エラー: {e}")

                # function responseを返す（LiveAPI SDK: キーワード引数必須）
                await session.send_tool_response(
                    function_responses=[types.FunctionResponse(
                        name=fc.name,
                        id=fc.id,
                        response={"result": "プロファイルを更新しました"}
                    )]
                )
            else:
                logger.warning(f"[LiveAPI] 未知のfunction call: {fc.name}")

    async def _handle_shop_search(self, user_request: str):
        """
        ショップ検索を実行し、結果をブラウザに送信する（案A: enrich並行方式）

        【設計】
        - callbackでLLM JSON生成のみ（enrichなし）→ raw_shopsを取得
        - raw_shopsで即座にTTS並行生成を開始
        - enrichをTTS生成と並行でrun_in_executor実行
        - enrich完了後にショップカードをブラウザに送信
        - TTS再生（生成済みタスクを_describe_shops_via_liveに渡す）
        """
        if not self._shop_search_callback:
            logger.error("[ShopSearch] shop_search_callback が未設定")
            self.socketio.emit('shop_search_result', {
                'shops': [], 'response': '',
            }, room=self.client_sid)
            return

        try:
            # 1. callbackでLLM JSON生成（enrichなし）
            loop = asyncio.get_event_loop()
            shop_data = await loop.run_in_executor(
                None,
                self._shop_search_callback,
                user_request, self.language, self.mode
            )

            if not shop_data or not shop_data.get('shops'):
                logger.info("[ShopSearch] ショップ見つからず")
                self.socketio.emit('shop_search_result', {
                    'shops': [], 'response': shop_data.get('response', '') if shop_data else '',
                }, room=self.client_sid)
                return

            raw_shops = shop_data['shops']
            response_text = shop_data.get('response', '')
            area = shop_data.get('area', '')

            # 2. enrich実行
            from api_integrations import enrich_shops_with_photos
            enriched = await loop.run_in_executor(
                None, enrich_shops_with_photos, raw_shops, area, self.language
            )
            shops = enriched if enriched else raw_shops
            logger.info(f"[ShopSearch] enrich完了: {len(shops)}件")

            # 3. ショップカードデータをブラウザに送信
            self.socketio.emit('shop_search_result', {
                'shops': shops,
                'response': response_text,
            }, room=self.client_sid)
            logger.info(f"[ShopSearch] {len(shops)}件のショップをブラウザに送信")
            await asyncio.sleep(0.3)

            # 4. TTS再生（ショップカード提示後にTTS生成開始）
            await self._describe_shops_via_live(shops)

        except Exception as e:
            logger.error(f"[ShopSearch] エラー: {e}", exc_info=True)
            self.socketio.emit('shop_search_result', {
                'shops': [], 'response': '',
            }, room=self.client_sid)

    def _process_turn_complete(self):
        """
        ターン完了時の処理
        stt_stream.py:600-644 から移植
        """
        user_text = ""
        if self.user_transcript_buffer.strip():
            user_text = self.user_transcript_buffer.strip()
            logger.info(f"[LiveAPI] ユーザー: {user_text}")
            self._add_to_history("user", user_text)
            self.user_transcript_buffer = ""

        if self.ai_transcript_buffer.strip():
            ai_text = self.ai_transcript_buffer.strip()
            logger.info(f"[LiveAPI] AI: {ai_text}")
            self._add_to_history("ai", ai_text)

            # 発言が途中で切れているかチェック
            is_incomplete = self._is_speech_incomplete(ai_text)

            # 文字数をカウント
            char_count = len(ai_text)
            self.ai_char_count += char_count
            remaining = MAX_AI_CHARS_BEFORE_RECONNECT - self.ai_char_count
            logger.info(f"[LiveAPI] 累積: {self.ai_char_count}文字 / 残り: {remaining}文字")

            self.ai_transcript_buffer = ""

            # 再接続判定
            if is_incomplete:
                logger.info("[LiveAPI] 発言途切れのため再接続")
                self.needs_reconnect = True
            elif char_count >= LONG_SPEECH_THRESHOLD:
                logger.info(f"[LiveAPI] 長い発話({char_count}文字)のため再接続")
                self.needs_reconnect = True
            elif self.ai_char_count >= MAX_AI_CHARS_BEFORE_RECONNECT:
                logger.info("[LiveAPI] 累積制限到達のため再接続")
                self.needs_reconnect = True

    async def _describe_shops_via_live(self, shops: list):
        """
        ショップ説明をREST TTSで読み上げ（1軒目冒頭先行 + A2E並行事前計算）

        【フロー】
        1. 1軒目の冒頭2文だけ先行TTS+A2E（場繋ぎ中に完了）
        2. 場繋ぎ終了 → 冒頭2文を即再生（ほぼ遅延ゼロ）
        3. 冒頭再生中に1軒目残り部分のTTS+A2E → 連続再生
        4. 1軒目再生中に2〜5軒目TTS一括開始 + 2軒目A2E事前計算
        5. 2軒目以降: 前軒の再生中に次軒のA2E事前計算
        """
        total = len(shops)
        if total == 0:
            return

        # ── 1軒目のテキストを冒頭2文と残りに分割 ──
        shop = shops[0]
        name = shop.get('name', '')
        area = shop.get('area', '')
        category = shop.get('category', shop.get('genre', ''))
        description = shop.get('description', '')
        price_range = shop.get('priceRange', shop.get('budget', ''))
        is_last_1 = (1 == total)

        head_text = f"1軒目は、{name}です。"
        if area and category:
            head_text += f"{area}にある{category}のお店です。"
        elif area:
            head_text += f"{area}にあるお店です。"

        tail_text = ""
        if description:
            tail_text += description
        if price_range:
            tail_text += f"ご予算は{price_range}です。"
        if is_last_1:
            tail_text += f"以上、{total}軒のお店をご紹介しました。気になるお店はありましたか？"

        # ── 冒頭2文のTTS先行開始 ──
        loop = asyncio.get_event_loop()
        head_tts_task = asyncio.ensure_future(
            loop.run_in_executor(None, self._synthesize_speech, head_text)
        )
        logger.info(f"[ShopDesc] 1軒目冒頭TTS先行開始: '{head_text}'")

        # ── A2Eリセット ──
        self.socketio.emit('live_expression_reset', room=self.client_sid)
        self._clear_a2e_queue()
        self._a2e_chunk_index = 0
        self._a2e_audio_buffer = bytearray()

        # ── 場繋ぎ: REST TTSで定型文を生成・再生（アバターの声と統一）──
        bridge_text = "お待たせしました。それではおすすめのお店をご紹介します。"
        bridge_start = time.time()
        total_bridge_duration = 0.0

        bridge_pcm = await loop.run_in_executor(None, self._synthesize_speech, bridge_text)
        if bridge_pcm:
            await self._emit_cached_audio(bridge_pcm)
            dur = len(bridge_pcm) / 48000
            total_bridge_duration += dur
            logger.info(f"[ShopDesc] 場繋ぎ(REST TTS)再生: {dur:.1f}秒")

        # bridge再生完了を待つ
        elapsed = time.time() - bridge_start
        wait1 = max(total_bridge_duration - elapsed + 0.7, 1.0)
        await asyncio.sleep(wait1)

        # ── 場繋ぎ中に冒頭TTS完了を待つ → A2E事前計算 ──
        head_pcm = await head_tts_task
        head_a2e_result = None
        if head_pcm:
            head_a2e_result = await self._precompute_a2e_expressions(head_pcm)
            logger.info(f"[ShopDesc] 1軒目冒頭A2E完了: {len(head_pcm)} bytes")

        # 場繋ぎ+冒頭A2E完了後の余白
        elapsed = time.time() - bridge_start
        remaining_sleep = max(total_bridge_duration - elapsed + 0.7, 0.3)
        logger.info(f"[ShopDesc] 場繋ぎ残り待ち: {remaining_sleep:.1f}秒 (経過{elapsed:.1f}秒)")
        await asyncio.sleep(remaining_sleep)

        # ── 冒頭2文をA2E付きで即再生 ──
        if head_pcm:
            await self._emit_collected_shop([head_pcm], head_text, 1, head_a2e_result)
            head_duration = len(head_pcm) / 48000
            logger.info(f"[ShopDesc] ショップ1冒頭再生: {head_duration:.1f}秒")

            # ── 冒頭再生中に残り部分のTTS+A2Eを並行処理 ──
            tail_pcm = None
            tail_a2e_result = None

            async def _process_tail():
                nonlocal tail_pcm, tail_a2e_result
                if tail_text:
                    tail_pcm = await loop.run_in_executor(None, self._synthesize_speech, tail_text)
                    if tail_pcm:
                        tail_a2e_result = await self._precompute_a2e_expressions(tail_pcm)
                        logger.info(f"[ShopDesc] 1軒目残りTTS+A2E完了: {len(tail_pcm)} bytes")

            await asyncio.gather(
                asyncio.sleep(head_duration + 0.7),
                _process_tail()
            )

            # ── 残り部分をA2E付きで連続再生 ──
            tail_duration = 0
            if tail_pcm:
                # transcriptは残り部分のみ（冒頭は既にhistoryに追加済み）
                await self._emit_collected_shop([tail_pcm], tail_text, 1, tail_a2e_result)
                tail_duration = len(tail_pcm) / 48000
                logger.info(f"[ShopDesc] ショップ1残り再生: {tail_duration:.1f}秒")

            # ── 1軒目再生中に2〜5軒目TTS一括開始 ──
            remaining_tasks = []
            for i in range(1, total):
                task = asyncio.create_task(
                    self._collect_shop_audio(shops[i], i + 1, total)
                )
                remaining_tasks.append(task)
            if remaining_tasks:
                logger.info(f"[ShopDesc] 2〜{total}軒目のTTS生成を一括開始（1軒目残り再生中に生成進行）")

            # 残り部分再生中に2軒目のA2E事前計算を並行実行
            next_a2e_task = None

            async def _prepare_shop2():
                nonlocal next_a2e_task
                if remaining_tasks:
                    next_chunks, _ = await remaining_tasks[0]
                    if next_chunks:
                        next_a2e_task = asyncio.create_task(
                            self._precompute_a2e_expressions(b''.join(next_chunks))
                        )

            await asyncio.gather(
                asyncio.sleep(tail_duration + 0.7),
                _prepare_shop2()
            )
        else:
            # 1軒目失敗時
            remaining_tasks = []
            for i in range(1, total):
                task = asyncio.create_task(
                    self._collect_shop_audio(shops[i], i + 1, total)
                )
                remaining_tasks.append(task)
            next_a2e_task = None

        # ── 2軒目以降: A2E付きで順次再生 ──
        for i, task in enumerate(remaining_tasks):
            if not self.is_running:
                break
            try:
                audio_chunks, transcript = await task

                # このショップのA2E事前計算結果を取得
                a2e_result = None
                if next_a2e_task:
                    a2e_result = await next_a2e_task
                    next_a2e_task = None

                if audio_chunks:
                    shop_number = i + 2
                    await self._emit_collected_shop(audio_chunks, transcript, shop_number, a2e_result)

                    all_pcm = b''.join(audio_chunks)
                    audio_duration = len(all_pcm) / 48000
                    logger.info(f"[ShopDesc] ショップ{shop_number}再生待ち: {audio_duration:.1f}秒")

                    # 次のショップのA2E事前計算と再生待ちを並行実行
                    async def _prepare_next(idx):
                        nonlocal next_a2e_task
                        if idx < len(remaining_tasks):
                            nxt_chunks, _ = await remaining_tasks[idx]
                            if nxt_chunks:
                                next_a2e_task = asyncio.create_task(
                                    self._precompute_a2e_expressions(b''.join(nxt_chunks))
                                )

                    await asyncio.gather(
                        asyncio.sleep(audio_duration + 0.7),
                        _prepare_next(i + 1)
                    )
            except Exception as e:
                logger.error(f"[ShopDesc] ショップ{i+2}再生エラー: {e}")

        # 全ショップ説明完了 → 通常会話に復帰
        summary = f"{total}軒のお店を紹介しました。気になるお店はありましたか？"
        self._add_to_history("ai", summary)
        self._resume_message = "ありがとうございます。気になるお店について教えてください。"
        self.needs_reconnect = True  # 通常会話に復帰するために再接続

    async def _emit_shop_audio_simple(self, audio_chunks: list, transcript: str, shop_number: int):
        """音声をA2Eなしで直接送信（リップシンクなし・最速再生）"""
        if transcript:
            logger.info(f"[ShopDesc] ショップ{shop_number}: {transcript}")
            self._add_to_history("ai", transcript)

        # expressionリセット（前セグメントの残留防止）
        self.socketio.emit('live_expression_reset', room=self.client_sid)

        # 音声送信
        for chunk in audio_chunks:
            audio_b64 = base64.b64encode(chunk).decode('utf-8')
            self.socketio.emit('live_audio', {'data': audio_b64},
                               room=self.client_sid)

    async def _stream_single_shop(self, shop, shop_number: int, total: int):
        """1軒目用: 音声を直接ブラウザにストリーミング"""
        is_last = (shop_number == total)
        shop_context = self._format_shop_for_prompt(shop, shop_number, total)

        shop_instruction = self.system_prompt + f"""

【現在のタスク：ショップ紹介】
あなたは今、ユーザーに検索結果のお店を紹介しています。

{shop_context}

【読み上げルール】
1. このお店の特徴を自然な話し言葉で紹介する（3〜5文程度）
2. 店名、ジャンル、エリア、特徴、価格帯を含める
3. マークダウン記法は使わない（音声出力のため）
4. 「{shop_number}軒目は」から始める
5. 紹介が終わったら、次のお店の紹介に自然につなげる。「以上です」とは言わない。
"""
        if is_last:
            shop_instruction += f"5の代わりに: 最後のお店です。紹介後「以上、{total}軒のお店をご紹介しました。気になるお店はありましたか？」で締めてください。\n"

        try:
            config = self._build_config()
            config["system_instruction"] = shop_instruction
            config.pop("tools", None)

            async with self.client.aio.live.connect(
                model=LIVE_API_MODEL,
                config=config
            ) as session:
                trigger_text = f"検索結果を紹介してください。まず1軒目のお店からお願いします。"
                await session.send_client_content(
                    turns=types.Content(
                        role="user",
                        parts=[types.Part(text=trigger_text)]
                    ),
                    turn_complete=True
                )
                await self._receive_shop_description(session, shop_number)

        except Exception as e:
            logger.error(f"[ShopDesc] ショップ{shop_number}ストリーミングエラー: {e}")

    async def _collect_shop_audio(self, shop, shop_number: int, total: int, delay: float = 0):
        """ショップ説明用: REST TTS（Google Cloud TTS）で音声を生成（LiveAPI接続不要）"""
        if delay > 0:
            await asyncio.sleep(delay)
        is_last = (shop_number == total)

        # ── 読み上げテキストを構成 ──
        name = shop.get('name', '')
        area = shop.get('area', '')
        category = shop.get('category', shop.get('genre', ''))
        description = shop.get('description', '')
        price_range = shop.get('priceRange', shop.get('budget', ''))

        script = f"{shop_number}軒目は、{name}です。"
        if area and category:
            script += f"{area}にある{category}のお店です。"
        elif area:
            script += f"{area}にあるお店です。"
        if description:
            script += description
        if price_range:
            script += f"ご予算は{price_range}です。"
        if is_last:
            script += f"以上、{total}軒のお店をご紹介しました。気になるお店はありましたか？"

        audio_chunks = []
        transcript = script

        try:
            # REST TTS（Google Cloud TTS）で音声生成（起動時キャッシュと同じ方式）
            loop = asyncio.get_event_loop()
            pcm = await loop.run_in_executor(None, self._synthesize_speech, script)

            if pcm:
                audio_chunks = [pcm]
                logger.info(f"[ShopDesc] ショップ{shop_number} TTS生成完了: {len(pcm)} bytes, {len(transcript)}文字")
            else:
                logger.error(f"[ShopDesc] ショップ{shop_number} TTS生成失敗")

        except Exception as e:
            logger.error(f"[ShopDesc] ショップ{shop_number} TTS生成エラー: {e}")

        return audio_chunks, transcript

    def _synthesize_speech(self, text: str) -> bytes | None:
        """Google Cloud TTSでテキストを24kHz 16bit mono PCMに変換"""
        try:
            tts_client = texttospeech.TextToSpeechClient()
            voice_name = self.voice_model if self.voice_model else "ja-JP-Chirp3-HD-Leda"
            # セッション言語に応じてvoice_nameの言語部分を差し替え
            # 例: ja-JP-Chirp3-HD-Leda + language='en' → en-US-Chirp3-HD-Leda
            lang_map = {'ja': 'ja-JP', 'en': 'en-US', 'zh': 'cmn-CN', 'ko': 'ko-KR'}
            target_lang = lang_map.get(self.language, 'ja-JP')
            parts = voice_name.split('-')
            if len(parts) >= 2:
                current_lang = f"{parts[0]}-{parts[1]}"
                if current_lang != target_lang:
                    voice_name = voice_name.replace(current_lang, target_lang, 1)
                    logger.info(f"[TTS] 言語差し替え: {current_lang} → {target_lang}, voice={voice_name}")
            lang_code = target_lang
            voice = texttospeech.VoiceSelectionParams(
                language_code=lang_code,
                name=voice_name
            )
            audio_config = texttospeech.AudioConfig(
                audio_encoding=texttospeech.AudioEncoding.LINEAR16,
                sample_rate_hertz=24000,
                speaking_rate=1.2,
            )
            resp = tts_client.synthesize_speech(
                input=texttospeech.SynthesisInput(text=text),
                voice=voice,
                audio_config=audio_config,
            )
            # LINEAR16レスポンスにはWAVヘッダ(44bytes)が付くので除去
            return resp.audio_content[44:]
        except Exception as e:
            logger.error(f"[TTS] 音声合成エラー: {e}")
            return None

    async def _emit_collected_shop(self, audio_chunks: list, transcript: str, shop_number: int, a2e_result: dict | None = None):
        """収集済み音声をA2E先行方式で送信（_emit_cached_audioと同パターン）"""
        if transcript:
            logger.info(f"[ShopDesc] ショップ{shop_number}: {transcript}")
            self._add_to_history("ai", transcript)

        all_pcm = b''.join(audio_chunks)

        # 1. expressionリセット → フロントのバッファクリア
        self.socketio.emit('live_expression_reset', room=self.client_sid)

        # 2. A2E先行: Expressionをフロントに先着させる
        if a2e_result:
            # 事前計算済み: emitのみ（HTTP待ちなし）
            self.socketio.emit('live_expression', {
                'expressions': a2e_result['expressions'],
                'expression_names': a2e_result['expression_names'],
                'frame_rate': a2e_result['frame_rate'],
                'chunk_index': 0,
            }, room=self.client_sid)
            logger.info(f"[A2E] ショップ{shop_number}: 事前計算済みexpression emit ({len(a2e_result['expressions'])} frames)")
        else:
            # 事前計算失敗時: 従来通りHTTP呼び出し
            await self._send_a2e_ahead(all_pcm)

        # 3. sleep: Expressionがフロントのバッファに格納される時間マージン
        await asyncio.sleep(0.05)

        # 4. 音声送信: Expressionが既にバッファにある状態で再生開始
        for chunk in audio_chunks:
            audio_b64 = base64.b64encode(chunk).decode('utf-8')
            self.socketio.emit('live_audio', {'data': audio_b64},
                               room=self.client_sid)

    async def _receive_shop_description(self, session, shop_number: int):
        """
        ショップ説明専用の応答受信（v5 §6.2）
        turn_completeまで受信して終了。
        """
        self._last_stream_pcm_bytes = 0  # ★ ストリーミング送信バイト数累計
        self._stream_start_time = None  # ★ 最初の音声チャンク送信時刻
        turn = session.receive()
        async for response in turn:
            if not self.is_running:
                return

            if response.server_content:
                sc = response.server_content

                # ターン完了
                if hasattr(sc, 'turn_complete') and sc.turn_complete:
                    # ★ A2E: 残存バッファを強制フラッシュ（最終チャンク）
                    await self._flush_a2e_buffer(force=True, is_final=True)
                    await self._a2e_send_queue.join()  # 全チャンク送信完了を待つ
                    self._a2e_chunk_index = 0  # 次ターン用にリセット
                    if self.ai_transcript_buffer.strip():
                        ai_text = self.ai_transcript_buffer.strip()
                        logger.info(f"[ShopDesc] ショップ{shop_number}: {ai_text}")
                        self._add_to_history("ai", ai_text)
                        self.ai_transcript_buffer = ""
                    return

                # 出力トランスクリプション
                if (hasattr(sc, 'output_transcription')
                        and sc.output_transcription):
                    text = sc.output_transcription.text
                    if text:
                        self.ai_transcript_buffer += text
                        self.socketio.emit('ai_transcript',
                                           {'text': text, 'type': 'shop_description'},
                                           room=self.client_sid)

                # 出力トランスクリプション（ショップ説明 - A2E句読点検出）
                if (hasattr(sc, 'output_transcription')
                        and sc.output_transcription):
                    text_tr = sc.output_transcription.text
                    if text_tr:
                        self._on_output_transcription(text_tr)

                # 音声データ
                if sc.model_turn:
                    for part in sc.model_turn.parts:
                        if (hasattr(part, 'inline_data')
                                and part.inline_data):
                            if isinstance(part.inline_data.data, bytes):
                                audio_b64 = base64.b64encode(
                                    part.inline_data.data
                                ).decode('utf-8')
                                self.socketio.emit('live_audio',
                                                   {'data': audio_b64},
                                                   room=self.client_sid)
                                # ★ A2E: ショップ説明でも蓄積（仕様書08 セクション3.5）
                                self._buffer_for_a2e(part.inline_data.data)
                                # ★ ストリーミング送信バイト数累計（動的sleep用）
                                if self._stream_start_time is None:
                                    self._stream_start_time = time.time()
                                self._last_stream_pcm_bytes += len(part.inline_data.data)

    # ============================================================
    # キャッシュ済み音声再生（A2Eパイプライン経由）
    # ============================================================

    async def _emit_cached_audio(self, pcm_data: bytes | None):
        """キャッシュ済みPCM音声をA2E先行+sleep方式で送信（仕様書12 §3.1.1）

        公式デモの「全データ揃ってから再生」パターン:
        1. expressionリセット → フロントのバッファクリア
        2. A2E先行送信 → Expressionをフロントに先着させる
        3. sleep → Expressionがバッファに格納される時間マージン
        4. 音声送信 → Expressionが既にバッファにある状態で再生開始
        """
        if not pcm_data:
            logger.warning("[CachedAudio] PCMデータなし、スキップ")
            return

        # 1. expressionリセット → フロントのバッファクリア
        self.socketio.emit('live_expression_reset', room=self.client_sid)

        # 2. A2E先行: 全音声を一括でA2Eに送信し、Expressionを先にフロントへ届ける
        await self._send_a2e_ahead(pcm_data)

        # 3. sleep: Expressionがフロントのバッファに格納される時間マージン
        await asyncio.sleep(0.05)

        # 4. 音声送信: Expressionが既にバッファにある状態で再生開始
        CHUNK_SIZE = 4800  # 0.1秒分 (24kHz 16bit mono)
        for i in range(0, len(pcm_data), CHUNK_SIZE):
            chunk = pcm_data[i:i + CHUNK_SIZE]
            audio_b64 = base64.b64encode(chunk).decode('utf-8')
            self.socketio.emit('live_audio', {'data': audio_b64},
                               room=self.client_sid)

        logger.info(f"[CachedAudio] A2E先行+再生完了: {len(pcm_data)} bytes")

    async def _delayed_cached_audio(self, pcm_data: bytes | None, delay: float):
        """指定秒数待機後にキャッシュ済み音声を再生"""
        try:
            await asyncio.sleep(delay)
            await self._emit_cached_audio(pcm_data)
        except asyncio.CancelledError:
            pass  # 検索が先に完了した場合はキャンセルされる

    # ============================================================
    # A2E バッファリングメソッド（仕様書08 セクション3.3）
    # ============================================================

    def _buffer_for_a2e(self, pcm_data: bytes):
        """PCMをバッファに追加。閾値超過で自動フラッシュ（句読点待ち不要）"""
        self._a2e_audio_buffer.extend(pcm_data)
        # ★ 初回は即フラッシュ（遅延最小化）、2回目以降は品質優先で大きく溜める
        threshold = A2E_FIRST_FLUSH_BYTES if self._a2e_chunk_index == 0 else A2E_AUTO_FLUSH_BYTES
        if len(self._a2e_audio_buffer) >= threshold:
            asyncio.ensure_future(self._flush_a2e_buffer(force=True))

    def _on_output_transcription(self, text: str):
        """句読点検出でフラッシュ判定（仕様書08 セクション3.3）"""
        self._a2e_transcript_buffer += text
        # 句読点（。？！）を検出したら、250ms遅延後にフラッシュ
        # 余韻の無音データがバッファに入ってからフラッシュすることで、
        # A2Eが口を閉じるための無音区間（7フレーム=233ms以上）を確保する
        flush_triggers = ['。', '？', '！', '?', '!', '、', '，', ',']
        if any(t in text for t in flush_triggers):
            asyncio.ensure_future(self._delayed_a2e_flush())
            self._a2e_transcript_buffer = ""

    async def _delayed_a2e_flush(self):
        """句読点フラッシュの遅延実行（250ms後）"""
        await asyncio.sleep(0.25)
        await self._flush_a2e_buffer(force=False, is_punctuation=True)

    async def _send_a2e_ahead(self, pcm_data: bytes):
        """A2E先行送信: 音声をフロントに送る前にExpressionを先に届ける

        公式デモの「推論完了 → 全データ揃ってから再生」パターンの再現。
        _buffer_for_a2e() + _flush_a2e_buffer() の一括実行版。
        仕様書12 §3.1.3
        """
        # chunk_indexリセット（新セグメント）
        self._a2e_chunk_index = 0
        self._a2e_audio_buffer = bytearray()

        # 一括でA2Eに送信（is_start=True, is_final=True）
        await self._send_to_a2e(pcm_data, chunk_index=0, is_final=True)

        # chunk_indexを1に進める（次のフラッシュがis_start=Falseになるように）
        self._a2e_chunk_index = 1

    async def _precompute_a2e_expressions(self, pcm_data: bytes) -> dict | None:
        """A2E事前計算: 分割送信でexpressionデータを取得（emitしない）

        大きなPCMデータを5秒ごとのチャンクに分割して送信し、
        全チャンクのframesを結合して返す。タイムアウトリスクを回避。
        """
        try:
            # 24kHz PCM全体をリサンプル（24→16kHz）
            int16_array = np.frombuffer(pcm_data, dtype=np.int16)
            resampled = resample_poly(int16_array.astype(np.float32), up=2, down=3)
            int16_resampled = np.clip(resampled, -32768, 32767).astype(np.int16)
            resampled_bytes = int16_resampled.tobytes()

            # 16kHz 16bit mono = 32000 bytes/秒 × 5秒 = 160000 bytes/チャンク
            CHUNK_BYTES_16K = 160000
            all_expressions = []
            names = []
            frame_rate = A2E_EXPRESSION_FPS
            total_chunks = (len(resampled_bytes) + CHUNK_BYTES_16K - 1) // CHUNK_BYTES_16K

            for idx in range(total_chunks):
                start = idx * CHUNK_BYTES_16K
                end = min(start + CHUNK_BYTES_16K, len(resampled_bytes))
                chunk = resampled_bytes[start:end]
                audio_b64 = base64.b64encode(chunk).decode('utf-8')

                response = await self._a2e_http_client.post(
                    f"{A2E_SERVICE_URL}/api/audio2expression",
                    json={
                        "audio_base64": audio_b64,
                        "session_id": self.session_id,
                        "audio_format": "pcm",
                        "is_start": idx == 0,
                        "is_final": idx == total_chunks - 1,
                    },
                    timeout=10.0
                )

                if response.status_code == 200:
                    result = response.json()
                    frames = result.get('frames', [])
                    if frames:
                        expressions = [f['weights'] if isinstance(f, dict) else f for f in frames]
                        all_expressions.extend(expressions)
                    if idx == 0:
                        names = result.get('names', [])
                        frame_rate = result.get('frame_rate', A2E_EXPRESSION_FPS)
                else:
                    logger.warning(f"[A2E] 事前計算チャンク{idx}エラー: {response.status_code}")

            if all_expressions:
                logger.info(f"[A2E] 事前計算完了: {len(all_expressions)} frames ({total_chunks}チャンク)")
                return {
                    'expressions': all_expressions,
                    'expression_names': names,
                    'frame_rate': frame_rate,
                }
        except Exception as e:
            logger.error(f"[A2E] 事前計算エラー: {e}")
        return None

    async def _a2e_send_worker(self):
        """キューからチャンクを取り出し、直列でA2Eに送信（順序保証）"""
        try:
            while True:
                pcm_data, chunk_index, is_final = await self._a2e_send_queue.get()
                try:
                    await self._send_to_a2e(pcm_data, chunk_index, is_final=is_final)
                except Exception as e:
                    logger.error(f"[A2E] worker送信エラー: {e}")
                finally:
                    self._a2e_send_queue.task_done()
        except asyncio.CancelledError:
            pass

    def _clear_a2e_queue(self):
        """A2E送信キューをクリア（割り込み・リセット時）"""
        while not self._a2e_send_queue.empty():
            try:
                self._a2e_send_queue.get_nowait()
                self._a2e_send_queue.task_done()
            except asyncio.QueueEmpty:
                break
        self._a2e_audio_buffer = bytearray()

    async def _flush_a2e_buffer(self, force: bool = False, is_final: bool = False, is_punctuation: bool = False):
        """最低バイト数チェック後、キューに投入してA2E直列送信（仕様書08 セクション3.3）"""
        if len(self._a2e_audio_buffer) == 0:
            return

        # force=Falseの場合、最低バッファサイズをチェック
        # 句読点トリガー時は緩い閾値を使用（初期あいさつ冒頭の空振り防止）
        min_bytes = A2E_PUNCTUATION_MIN_BYTES if is_punctuation else A2E_MIN_BUFFER_BYTES
        if not force and len(self._a2e_audio_buffer) < min_bytes:
            return

        # バッファを取得してクリア
        pcm_data = bytes(self._a2e_audio_buffer)
        self._a2e_audio_buffer = bytearray()
        chunk_index = self._a2e_chunk_index
        self._a2e_chunk_index += 1

        # キューに投入（ワーカーが直列で送信）
        await self._a2e_send_queue.put((pcm_data, chunk_index, is_final))

    async def _send_to_a2e(self, pcm_data: bytes, chunk_index: int, is_final: bool = False):
        """リサンプリング（24→16kHz）後、A2Eサービスに送信（仕様書08 セクション3.4）

        a2e_engine.py _decode_audio の "pcm" フォーマット:
          samples = np.frombuffer(audio_bytes, dtype=np.int16)
        → raw int16 PCMバイトをbase64で送信
        """
        try:
            # PCM 24kHz 16bit mono → numpy int16
            int16_array = np.frombuffer(pcm_data, dtype=np.int16)

            # 24kHz → 16kHz リサンプリング（SciPy resample_poly）
            resampled = resample_poly(int16_array.astype(np.float32), up=2, down=3)

            # int16に戻す
            int16_resampled = np.clip(resampled, -32768, 32767).astype(np.int16)

            # raw int16 PCMをbase64エンコードしてJSON送信
            audio_b64 = base64.b64encode(int16_resampled.tobytes()).decode('utf-8')

            response = await self._a2e_http_client.post(
                f"{A2E_SERVICE_URL}/api/audio2expression",
                json={
                    "audio_base64": audio_b64,
                    "session_id": self.session_id,
                    "audio_format": "pcm",
                    "is_start": chunk_index == 0,
                    "is_final": is_final,
                },
                timeout=10.0
            )

            if response.status_code == 200:
                result = response.json()
                frames = result.get('frames', [])
                names = result.get('names', [])
                frame_rate = result.get('frame_rate', A2E_EXPRESSION_FPS)

                if frames:
                    # A2Eレスポンス frames: [{weights: [float]}] →
                    # フロントエンド expressions: [[float]] に変換
                    expressions = [f['weights'] if isinstance(f, dict) else f for f in frames]
                    self.socketio.emit('live_expression', {
                        'expressions': expressions,
                        'expression_names': names,
                        'frame_rate': frame_rate,
                        'chunk_index': chunk_index,
                    }, room=self.client_sid)
                    logger.info(f"[A2E] chunk {chunk_index}: {len(frames)} frames送信")
            else:
                logger.warning(f"[A2E] サービスエラー: {response.status_code}")

        except Exception as e:
            logger.error(f"[A2E] 送信エラー: {e}")

    def _format_shop_for_prompt(self, shop: dict, number: int, total: int) -> str:
        """ショップ情報をプロンプト用にフォーマット"""
        name = shop.get('name', '不明')
        genre = shop.get('genre', '')
        area = shop.get('area', '')
        budget = shop.get('budget', '')
        description = shop.get('description', '')
        features = shop.get('features', '')

        lines = [f"【{number}/{total}軒目】{name}"]
        if genre:
            lines.append(f"ジャンル: {genre}")
        if area:
            lines.append(f"エリア: {area}")
        if budget:
            lines.append(f"予算: {budget}")
        if description:
            lines.append(f"説明: {description}")
        if features:
            lines.append(f"特徴: {features}")

        return "\n".join(lines)

    def _get_last_user_text(self) -> str:
        """会話履歴から最後のユーザー発言を取得"""
        for h in reversed(self.conversation_history):
            if h['role'] == 'user':
                return h['text']
        return ""

    def _is_speech_incomplete(self, text: str) -> bool:
        """
        発言が途中で切れているかチェック
        stt_stream.py:501-529 から移植
        """
        if not text:
            return False

        text = text.strip()

        normal_endings = ['。', '？', '?', '！', '!', 'ます', 'です',
                          'ね', 'よ', 'した', 'ください']
        for ending in normal_endings:
            if text.endswith(ending):
                return False

        incomplete_patterns = ['、', 'の', 'を', 'が', 'は', 'に', 'で', 'と', 'も', 'や']
        for pattern in incomplete_patterns:
            if text.endswith(pattern):
                return True

        return False

    def _add_to_history(self, role: str, text: str):
        """会話履歴に追加"""
        self.conversation_history.append({"role": role, "text": text})
        if len(self.conversation_history) > 20:
            self.conversation_history = self.conversation_history[-20:]

    def _get_context_summary(self) -> str:
        """
        再接続時のコンテキスト要約（v5 §3.2.2: 簡素化）
        主力は send_client_content(turns) による履歴再送。
        ここでは最後のAIの質問のみ補足情報として返す。
        """
        if not self.conversation_history:
            return ""

        last_ai = None
        for h in reversed(self.conversation_history):
            if h['role'] == 'ai':
                last_ai = h['text']
                break

        if last_ai and ('?' in last_ai or '？' in last_ai
                        or 'ですか' in last_ai or 'ますか' in last_ai):
            return f"【直前のAIの質問（回答を待っています）】\n{last_ai[:200]}"

        return ""

    async def _send_history_on_reconnect(self, session):
        """
        再接続時に会話履歴をsend_client_content()で再送する（v5 §3.2.1）

        【設計根拠（REST版準拠）】
        REST版では毎回全会話履歴をGemini APIに送信していた。
        LiveAPIのsend_client_content()のturnsパラメータで同等のことを実現。

        - turnsは types.Content のリストとして送信
        - role は "user" または "model"（"ai"ではない）
        - 直近10ターン、各150文字までに制限（トークン消費抑制）
        """
        if not self.conversation_history:
            return

        recent = self.conversation_history[-10:]
        history_turns = []

        for h in recent:
            role = "user" if h['role'] == 'user' else "model"
            text = h['text'][:150]
            history_turns.append(
                types.Content(
                    role=role,
                    parts=[types.Part(text=text)]
                )
            )

        if history_turns:
            await session.send_client_content(
                turns=history_turns,
                turn_complete=False  # まだターンは終わっていない
            )
            logger.info(f"[LiveAPI] 会話履歴 {len(history_turns)} ターン再送")
