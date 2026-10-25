# -*- coding: utf-8 -*-
# tools/poc-tests/_live_api_harness.py
#
# poc-tests 用の LiveAPISession ハーネス。
# 実 socket handler と実 LiveAPISession.run() をそのまま動かし、
# 外部依存（ADC を要求する TTS/Speech、Gemini Live websocket、
# websocket 前提の _session_loop）だけを差し替える。
#
# 注意: tools/poc-tests/live_generation_isolation.spec.py は Phase 1 時点の
#       内容を凍結しているため、この helper を使っていない。
#       同等のハーネスがそちらにも入っている（意図的な重複）。
#
# ハーネス上の注意点は live_generation_isolation.spec.py の先頭コメント参照:
#   [1] _session_loop を単純 no-op にすると run() が終了し is_running が落ちる
#   [2] Flask-SocketIO 5.3.5 / python-socketio 5.10.0 では test client が
#       mock する _send_packet ではなく _send_eio_packet が使われる

import os
import sys
import time
import base64
import logging

_REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
_SUPPORT_BASE = os.path.join(_REPO_ROOT, 'support-base')
sys.path.insert(0, _SUPPORT_BASE)

os.environ.setdefault('GEMINI_API_KEY', 'dummy-key-for-test')
os.environ.pop('PROMPTS_BUCKET_NAME', None)  # GCS ではなくローカル prompts を使う

# 外部依存の mock（注意: import より前に差し替える）
from google.cloud import texttospeech, speech  # noqa: E402
texttospeech.TextToSpeechClient = lambda *a, **k: None
speech.SpeechClient = lambda *a, **k: None

import app_customer_support as app_mod       # noqa: E402
from live_api_handler import LiveAPISession  # noqa: E402
from socketio import packet as sio_packet    # noqa: E402


# ============================================================
# 受信キャプチャ shim（上記 注意点 [2]）
# ============================================================
def install_recv_shim():
    """test client 作成直後に呼ぶ。_send_eio_packet 経路の emit を拾う。"""
    server = app_mod.socketio.server
    mock_send_packet = server._send_packet  # test client が差し替えた mock
    def _send_eio_packet(eio_sid, eio_pkt):
        try:
            pkt = sio_packet.Packet(encoded_packet=eio_pkt.data)
        except Exception:
            return
        mock_send_packet(eio_sid, pkt)
    server._send_eio_packet = _send_eio_packet


def new_client():
    client = app_mod.socketio.test_client(app_mod.app)
    install_recv_shim()
    return client


# ============================================================
# ログ収集
# ============================================================
LOG_LINES = []


class _Collect(logging.Handler):
    def emit(self, record):
        LOG_LINES.append(f"{record.levelname:7s} {record.getMessage()}")


logging.getLogger().addHandler(_Collect())
logging.getLogger().setLevel(logging.INFO)


# ============================================================
# Gemini Live websocket の mock
# ============================================================
class _FakeGeminiLiveSession:
    def __init__(self):
        self.sent = []

    async def send_client_content(self, turns=None, turn_complete=None):
        text = ''
        try:
            text = turns.parts[0].text
        except Exception:
            pass
        self.sent.append(('send_client_content', text, turn_complete))

    async def send_realtime_input(self, **kw):
        self.sent.append(('send_realtime_input', kw))


class _FakeConnectCM:
    def __init__(self, holder):
        self.holder = holder

    async def __aenter__(self):
        self.holder.live_session = _FakeGeminiLiveSession()
        return self.holder.live_session

    async def __aexit__(self, *a):
        return False


class _FakeLive:
    def __init__(self, holder):
        self.holder = holder

    def connect(self, model=None, config=None):
        return _FakeConnectCM(self.holder)


class _FakeAio:
    def __init__(self, holder):
        self.live = _FakeLive(holder)


class _FakeGeminiClient:
    def __init__(self, holder):
        self.aio = _FakeAio(holder)


SESSIONS = []


class HarnessLiveAPISession(LiveAPISession):
    """実 run() をそのまま使い、外部依存（Gemini websocket）と
    websocket 前提の _session_loop だけ差し替えたサブクラス。
    generation_id / startup_role の保持や live_connected の emit は
    実物の run() がそのまま実行する。"""

    def __init__(self, *a, **kw):
        super().__init__(*a, **kw)
        self.live_session = None            # _FakeGeminiLiveSession が入る
        self.client = _FakeGeminiClient(self)
        SESSIONS.append(self)

    async def _session_loop(self, session):
        # 注意点 [1]: no-op にすると run() が即終了して is_running が落ちる。
        # 実物と同じく stop() されるまで戻らない。
        import asyncio
        while self.is_running and not self.needs_reconnect:
            await asyncio.sleep(0.02)


app_mod.LiveAPISession = HarnessLiveAPISession


# ============================================================
# ヘルパ
# ============================================================
RESULTS = []
PCM_B64 = base64.b64encode(b'\x00\x01' * 160).decode()
CONNECT_WAIT_SEC = 0.6  # run() スレッドが connect を終えるまでの待ち


def ok(cond, name, extra=''):
    cond = bool(cond)
    RESULTS.append((name, cond))
    print(f"{'PASS' if cond else 'FAIL'}  {name}" + (f"  {extra}" if extra else ''))


def reset_state():
    app_mod.active_live_sessions.clear()
    app_mod.greeted_client_sids.clear()
    app_mod.active_generation_by_sid.clear()
    app_mod._generation_log_seen.clear()
    SESSIONS.clear()
    LOG_LINES.clear()


def sid_of(client):
    # test client は engine.io の sid しか持たないので server 側の sid へ変換する
    return app_mod.socketio.server.manager.sid_from_eio_sid(client.eio_sid, '/')


def live_start(client, generation_id=None, startup_role=None):
    payload = {'session_id': None, 'mode': 'chat', 'language': 'ja',
               'voice_model': '', 'live_voice': '', 'teacher_name': ''}
    # generation を送らない legacy request を再現できるよう、None はキーごと省く
    if generation_id is not None:
        payload['generation_id'] = generation_id
    if startup_role is not None:
        payload['startup_role'] = startup_role
    client.emit('live_start', payload)
    time.sleep(CONNECT_WAIT_SEC)


def read_source(rel):
    with open(os.path.join(_REPO_ROOT, rel), encoding='utf-8') as f:
        return f.read()


def slice_function(source, header):
    """`def foo(` から次の同インデント def / デコレータまでを切り出す。"""
    start = source.index(header)
    rest = source[start + len(header):]
    end = len(rest)
    for marker in ('\n@socketio.on(', '\ndef ', '\n# ====='):
        at = rest.find(marker)
        if at != -1:
            end = min(end, at)
    return header + rest[:end]


def strip_comment_lines(source):
    """行頭コメントを除去する。
    削除した emit の理由をコメントで残しているため、コメント本文に
    'greeting_done' の語が含まれる。静的検査が実コードではなく
    コメントに一致してしまうのを防ぐ。"""
    return '\n'.join(line for line in source.splitlines()
                     if not line.strip().startswith('#'))



def reset_state():
    app_mod.active_live_sessions.clear()
    app_mod.greeted_client_sids.clear()
    app_mod.active_generation_by_sid.clear()
    app_mod._generation_log_seen.clear()
    SESSIONS.clear()
    LOG_LINES.clear()


def sid_of(client):
    return app_mod.socketio.server.manager.sid_from_eio_sid(client.eio_sid, '/')


def live_start(client, generation_id=None, startup_role=None, wait=0.6):
    import time as _t
    payload = {'session_id': None, 'mode': 'chat', 'language': 'ja',
               'voice_model': '', 'live_voice': '', 'teacher_name': ''}
    if generation_id is not None:
        payload['generation_id'] = generation_id
    if startup_role is not None:
        payload['startup_role'] = startup_role
    client.emit('live_start', payload)
    _t.sleep(wait)
