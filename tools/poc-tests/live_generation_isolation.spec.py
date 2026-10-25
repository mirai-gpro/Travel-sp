# -*- coding: utf-8 -*-
# tools/poc-tests/live_generation_isolation.spec.py
#
# LiveAPI の Generation Isolation 回帰テスト（Startup Architecture Phase 1）。
#
# 固定する不変条件:
#   1. live_start が active generation の所有権を更新する（G1 -> G2）
#   2. LiveAPISession の generation_id / startup_role は生成後に変更できない
#   3. 旧世代の live_stop(G1) は DROP され、現行の G2 を停止しない
#   4. 旧世代の live_audio_in(G1) は DROP され、G2 のキューに渡らない
#   5. 現行世代の live_audio_in(G2) は ACCEPT される
#   6. generation を送らない legacy request では現行挙動を維持する
#      （仮の generation を推測生成しない / startup_role に既定値を与えない）
#   7. live_ready（Socket handler の起動通知）と live_connected（Gemini の
#      connect() 成功通知）は意味が分離しており、この順で届く
#   8. handle_live_start に即時 greeting_done emit が存在しない
#   9. 実際の Greeting 完了時の greeting_done（turn_complete 側）は残っている
#  10. disconnect で generation ownership がクリーンアップされる
#  11. Server -> Client の Live event に generation_id が付く（Phase 2）
#  12. 旧世代 session の emit は G1 のまま（G2 に付け替えない）（Phase 2）
#  13. 停止済み session からの outbound は送信されない（Phase 2）
#
# ------------------------------------------------------------------
# 実行方法
# ------------------------------------------------------------------
#   python tools/poc-tests/live_generation_isolation.spec.py
#
# support-base の import が通る環境が必要（support-base/requirements.txt のうち
# Flask / Flask-SocketIO / python-socketio / google-genai /
# google-cloud-texttospeech / google-cloud-speech / google-cloud-storage /
# google-generativeai / httpx / requests / numpy / scipy）。
# GEMINI_API_KEY はダミー値を自動設定する（外部通信はしない）。
#
# ------------------------------------------------------------------
# mock する範囲（= 外部依存のみ。製品コードは mock しない）
# ------------------------------------------------------------------
# 実際の socket handler（handle_live_start / handle_live_audio_in /
# handle_live_stop / handle_disconnect）と実際の LiveAPISession.run() を
# そのまま実行する。generation 判定ロジックは一切差し替えない。
# 差し替えるのは以下の外部依存だけ:
#   * texttospeech.TextToSpeechClient / speech.SpeechClient
#       -> import 時に ADC（Application Default Credentials）を要求するため
#   * client.aio.live.connect（Gemini Live websocket）
#       -> 実際の Gemini への接続を避けるため
#   * LiveAPISession._session_loop（Gemini との送受信ループ）
#       -> websocket を mock した以上、実物は動かせない
#
# ------------------------------------------------------------------
# ハーネス上の注意点（過去にハマった2点）
# ------------------------------------------------------------------
# [1] _session_loop を単純な no-op にしてはいけない。
#     run() は `await self._session_loop(session)` から戻ると break し、
#     finally で is_running = False にしてセッションを終了させる。no-op だと
#     live_start 直後にセッションが終了してしまい、enqueue_audio() が
#     `if ... and self.is_running` で弾かれる（= 本物では起きない FAIL になる）。
#     実物と同じく stop() まで戻らない待機ループにする。
#
# [2] test client の受信キャプチャには shim が必要。
#     requirements.txt の pin（Flask-SocketIO 5.3.5 / python-socketio 5.10.0）
#     では、SocketIOTestClient が server._send_packet だけを mock するのに対し、
#     python-socketio 5.10.0 の manager.emit は callback なしの経路で
#     server._send_eio_packet を使う。そのため既定では emit が test client の
#     キューに入らず、live_ready / live_connected / live_stopped が
#     「届いていない」ように見える。install_recv_shim() で
#     _send_eio_packet を decode して既存の mock へ渡す。
#     （これはテスト側のバージョン差であり、製品コードの問題ではない）

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


# ============================================================
# Test A — Generation ownership / G1 -> G2 transition / immutability
# ============================================================
print("\n=== Test A: generation ownership と G1 -> G2 の所有権移行 ===")
reset_state()
c = new_client()
sid = sid_of(c)

live_start(c, 'G1', 'warmup')
ok(app_mod.active_generation_by_sid.get(sid) == 'G1',
   'A-1 live_start(G1) 後の active generation = G1',
   f"active={app_mod.active_generation_by_sid.get(sid)}")

g1 = SESSIONS[-1]
ok(g1.generation_id == 'G1' and g1.startup_role == 'warmup',
   'A-2 G1 session に generation_id / startup_role が固定されている',
   f"generation_id={g1.generation_id} startup_role={g1.startup_role}")

try:
    g1.generation_id = 'TAMPERED'
    immutable_gen = False
except AttributeError:
    immutable_gen = True
try:
    g1.startup_role = 'TAMPERED'
    immutable_role = False
except AttributeError:
    immutable_role = True
ok(immutable_gen and immutable_role,
   'A-3 generation_id / startup_role は生成後に変更不可（read-only property）')

live_start(c, 'G2', 'final')
ok(app_mod.active_generation_by_sid.get(sid) == 'G2',
   'A-4 live_start(G2) 後の active generation = G2',
   f"active={app_mod.active_generation_by_sid.get(sid)}")

g2 = SESSIONS[-1]
ok(app_mod.active_live_sessions.get(sid) is g2,
   'A-5 active_live_sessions が G2 を保持している')
ok(g1.is_running is False,
   'A-6 旧世代 G1 の session は停止している', f"G1.is_running={g1.is_running}")
LOG_A = list(LOG_LINES)


# ============================================================
# Test B — stale live_stop(G1) は DROP
# ============================================================
print("\n=== Test B: 遅延した live_stop(G1) ===")
c.get_received()
LOG_LINES.clear()
c.emit('live_stop', {'generation_id': 'G1'})
time.sleep(0.2)
received = [r['name'] for r in c.get_received()]

ok(app_mod.active_generation_by_sid.get(sid) == 'G2',
   'B-1 active generation は G2 のまま',
   f"active={app_mod.active_generation_by_sid.get(sid)}")
ok(g2.is_running is True,
   'B-2 現行世代 G2 の session は停止していない', f"G2.is_running={g2.is_running}")
ok(app_mod.active_live_sessions.get(sid) is g2,
   'B-3 active_live_sessions に G2 が残っている')
ok('live_stopped' not in received,
   'B-4 live_stopped は返っていない', f"received={received}")
ok(any('event=live_stop' in l and 'DROP' in l for l in LOG_LINES),
   'B-5 ログに event / received / active / DROP が出ている')
LOG_B = list(LOG_LINES)


# ============================================================
# Test C — stale live_audio_in(G1) は DROP
# ============================================================
print("\n=== Test C: 旧世代からの live_audio_in(G1) ===")
LOG_LINES.clear()
qsize_before = g2.audio_queue_to_gemini.qsize()
c.emit('live_audio_in', {'generation_id': 'G1', 'data': PCM_B64})
time.sleep(0.2)
ok(g2.audio_queue_to_gemini.qsize() == qsize_before,
   'C-1 G2 のキューに渡っていない',
   f"qsize {qsize_before} -> {g2.audio_queue_to_gemini.qsize()}")
ok(any('event=live_audio_in' in l and 'DROP' in l for l in LOG_LINES),
   'C-2 ログに event / received / active / DROP が出ている')
LOG_C = list(LOG_LINES)


# ============================================================
# Test D — valid live_audio_in(G2) は ACCEPT / disconnect cleanup
# ============================================================
print("\n=== Test D: 現行世代からの live_audio_in(G2) ===")
LOG_LINES.clear()
c.emit('live_audio_in', {'generation_id': 'G2', 'data': PCM_B64})
time.sleep(0.2)
ok(g2.audio_queue_to_gemini.qsize() == qsize_before + 1,
   'D-1 G2 のキューに渡っている',
   f"qsize {qsize_before} -> {g2.audio_queue_to_gemini.qsize()}")
ok(any('event=live_audio_in' in l and '-> ACCEPT' in l for l in LOG_LINES),
   'D-2 ログに event / received / active / ACCEPT が出ている')
LOG_D = list(LOG_LINES)

c.disconnect()
time.sleep(0.2)
ok(sid not in app_mod.active_generation_by_sid,
   'D-3 disconnect で generation ownership がクリーンアップされる')
ok(not any(k[0] == sid for k in app_mod._generation_log_seen),
   'D-4 disconnect でログ重複抑止キャッシュもクリーンアップされる')


# ============================================================
# Test E — live_ready と live_connected の意味の分離
# ============================================================
print("\n=== Test E: live_ready / Gemini connect開始 / connect成功 / live_connected ===")
reset_state()
c2 = new_client()
live_start(c2, 'G2', 'final')
recv = c2.get_received()
names = [r['name'] for r in recv]
live_connected = [r for r in recv if r['name'] == 'live_connected']
connect_log = [l for l in LOG_LINES
               if 'Gemini connect開始' in l or 'Gemini connect成功' in l]

ok('live_ready' in names,
   'E-1 live_ready が届いている（Socket handler の起動通知）', f"received={names}")
ok(len(live_connected) == 1,
   'E-2 live_connected が1回届いている（Gemini connect 成功通知）',
   f"count={len(live_connected)}")
ok(live_connected and live_connected[0]['args'][0].get('generation_id') == 'G2',
   'E-3 live_connected の payload に generation_id が入っている',
   f"payload={live_connected[0]['args'][0] if live_connected else None}")
ok('live_connected' in names and names.index('live_ready') < names.index('live_connected'),
   'E-4 live_ready -> live_connected の順で届く（2つは別物）')
ok(len(connect_log) == 2
   and 'connect開始' in connect_log[0] and 'connect成功' in connect_log[1],
   'E-5 Gemini connect開始 -> connect成功 の順でログ出力', f"{connect_log}")
ok(live_connected
   and live_connected[0]['args'][0].get('session_count') == 1,
   'E-6 live_connected は connect 成功後（session_count 確定後）に emit される',
   f"payload={live_connected[0]['args'][0] if live_connected else None}")
LOG_E = [l for l in LOG_LINES if 'Generation' in l or 'LiveAPI' in l]
c2.disconnect()


# ============================================================
# Test F — legacy request（generation を送らない経路）の互換性
# ============================================================
print("\n=== Test F: legacy request（generation を送らない Frontend 経路）===")
reset_state()
c3 = new_client()
sid3 = sid_of(c3)
live_start(c3)                       # generation_id / startup_role なし
recv_names = [r['name'] for r in c3.get_received()]
sess = SESSIONS[-1]

ok('live_ready' in recv_names,
   'F-1 Live接続: live_ready が届いている', f"received={recv_names}")
ok(sid3 in app_mod.active_generation_by_sid
   and app_mod.active_generation_by_sid[sid3] is None,
   'F-2 active generation は None（仮の generation を推測生成していない）',
   f"active={app_mod.active_generation_by_sid.get(sid3, '<missing>')}")
ok(sess.startup_role is None,
   'F-3 startup_role も None（既定値の意味付けをしていない）',
   f"startup_role={sess.startup_role}")
ok(sess.live_session is not None
   and any(s[0] == 'send_client_content' and s[2] is True for s in sess.live_session.sent),
   'F-4 初期挨拶トリガーが従来どおり送信されている',
   f"sent={sess.live_session.sent if sess.live_session else None}")
ok(sess._is_initial_greeting_phase is True,
   'F-5 _is_initial_greeting_phase = True（初期挨拶経路は不変）')
ok('greeting_done' not in recv_names,
   'F-6 live_start 時に greeting_done が emit されない', f"received={recv_names}")

q0 = sess.audio_queue_to_gemini.qsize()
c3.emit('live_audio_in', {'data': PCM_B64})   # generation なし
time.sleep(0.2)
ok(sess.audio_queue_to_gemini.qsize() == q0 + 1,
   'F-7 通常会話: generation なしの live_audio_in が ACCEPT される',
   f"qsize {q0} -> {sess.audio_queue_to_gemini.qsize()}")

c3.get_received()
live_start(c3)                       # 2回目（旧ソフトリロード経路）
sess2 = SESSIONS[-1]
ok(sess2._is_initial_greeting_phase is False,
   'F-8 2回目 live_start: 挨拶ガードで挨拶がスキップされる',
   f"session_count={sess2.session_count}")

c3.get_received()
c3.emit('live_stop')                 # payload なし = 現行 Frontend
time.sleep(0.2)
recv_names = [r['name'] for r in c3.get_received()]
ok('live_stopped' in recv_names,
   'F-9 live_stop（payload なし）が ACCEPT され live_stopped が返る',
   f"received={recv_names}")
ok(sess2.is_running is False,
   'F-10 live_stop 後にセッションが停止している')
LOG_F = list(LOG_LINES)
c3.disconnect()


# ============================================================
# Test G — greeting_done の emit 位置（静的検査）
#   実際の Greeting の turn_complete は Gemini websocket を mock した状態では
#   再現できないため、emit の所在をソース上で固定する。
# ============================================================
print("\n=== Test G: greeting_done の emit 位置（静的検査）===")
app_src = read_source('support-base/app_customer_support.py')
handler_src = read_source('support-base/live_api_handler.py')
live_start_src = strip_comment_lines(
    slice_function(app_src, "def handle_live_start(data):"))

ok("emit('greeting_done'" not in live_start_src
   and 'emit("greeting_done"' not in live_start_src,
   'G-1 handle_live_start に即時 greeting_done emit が存在しない')
ok("greeted_client_sids" in app_src and "session_count" in handler_src,
   'G-2 greeted_client_sids / session_count の仕組みは残っている')
ok("emit('greeting_done'" in handler_src,
   'G-3 実際の Greeting 完了側（live_api_handler）の greeting_done は残っている')

turn_complete_at = handler_src.find('turn_complete')
greeting_done_at = handler_src.find("emit('greeting_done'")
ok(turn_complete_at != -1 and greeting_done_at > turn_complete_at,
   'G-4 その greeting_done は turn_complete の処理内にある')

ok("emit('live_ready'" in app_src and "emit('live_ready'" not in handler_src,
   'G-5 live_ready は Socket handler 側のみ（意味の分離）')
ok("live_connected" in handler_src and "live_connected" not in app_src,
   'G-6 live_connected は LiveAPISession 側のみ（意味の分離）')

async_with_at = handler_src.find('async with self.client.aio.live.connect(')
live_connected_at = handler_src.find("emit('live_connected'")
ok(async_with_at != -1 and live_connected_at > async_with_at,
   'G-7 live_connected の emit は connect() の Context Manager 内にある')


# ============================================================
# Test H — Server -> Client への generation 付与と
#          停止済み session の outbound 抑止（Phase 2）
# ============================================================
print("\n=== Test H: server -> client の generation 付与 / outbound 抑止 ===")
reset_state()
c4 = new_client()
sid4 = sid_of(c4)

live_start(c4, 'G1', 'warmup')
g1 = SESSIONS[-1]
recv = c4.get_received()
ready = [r for r in recv if r['name'] == 'live_ready']
connected = [r for r in recv if r['name'] == 'live_connected']
ok(ready and ready[0]['args'][0].get('generation_id') == 'G1',
   'H-1 live_ready に generation_id が付いている',
   f"payload={ready[0]['args'][0] if ready else None}")
ok(connected and connected[0]['args'][0].get('generation_id') == 'G1',
   'H-2 LiveAPISession の emit に generation_id が付いている（live_connected）',
   f"payload={connected[0]['args'][0] if connected else None}")

live_start(c4, 'G2', 'final')
g2 = SESSIONS[-1]
c4.get_received()

# 旧世代 session が遅れて emit した場合、generation_id は G1 のままでなければならない。
# （停止済みなので通常は抑止されるが、「G2 へ付け替えない」ことを直接確認する）
g1_was_running = g1.is_running
g1.is_running = True
g1._emit('live_audio', {'data': 'AAAA'})
g1.is_running = g1_was_running
recv = c4.get_received()
stale = [r for r in recv if r['name'] == 'live_audio']
ok(stale and stale[0]['args'][0].get('generation_id') == 'G1',
   'H-3 旧世代 session の emit は G1 のまま（G2 に付け替えない）',
   f"payload={stale[0]['args'][0] if stale else None}")

# 停止済み（退役した）session からの user-facing event は送信されない
ok(g1.is_running is False, 'H-4 旧世代 session は停止している',
   f"is_running={g1.is_running}")
c4.get_received()
g1._emit('live_audio', {'data': 'AAAA'})
g1._emit('turn_complete', {})
recv = c4.get_received()
ok(len(recv) == 0,
   'H-5 停止済み session からの outbound は送信されない（server側 stale Drop）',
   f"received={[r['name'] for r in recv]}")

# 現行世代の emit は通る
c4.get_received()
g2._emit('live_audio', {'data': 'AAAA'})
recv = c4.get_received()
ok(len(recv) == 1 and recv[0]['args'][0].get('generation_id') == 'G2',
   'H-6 現行世代 session の emit は通り generation_id = G2',
   f"received={[(r['name'], r['args'][0].get('generation_id')) for r in recv]}")

c4.get_received()
c4.emit('live_stop', {'generation_id': 'G2'})
time.sleep(0.2)
recv = c4.get_received()
stopped = [r for r in recv if r['name'] == 'live_stopped']
ok(stopped and stopped[0]['args'][0].get('generation_id') == 'G2',
   'H-7 live_stopped に停止した session の generation_id が付いている',
   f"payload={stopped[0]['args'][0] if stopped else None}")
LOG_H = list(LOG_LINES)
c4.disconnect()


# ============================================================
# サマリ
# ============================================================
print("\n" + "=" * 64)
failures = [name for name, passed in RESULTS if not passed]
for name, passed in RESULTS:
    print(f"{'PASS' if passed else 'FAIL'}  {name}")
print("=" * 64)
print(f"TOTAL {len(RESULTS)}  PASS {len(RESULTS) - len(failures)}  FAIL {len(failures)}")

if '--dump-logs' in sys.argv:
    print("\n" + "=" * 64)
    for label, lines in [('TEST A', LOG_A), ('TEST B', LOG_B), ('TEST C', LOG_C),
                         ('TEST D', LOG_D), ('TEST E', LOG_E), ('TEST F', LOG_F),
                         ('TEST H', LOG_H)]:
        print(f"\n########## {label} ##########")
        for line in lines:
            print(line)

sys.exit(1 if failures else 0)
