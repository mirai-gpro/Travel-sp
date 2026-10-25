# -*- coding: utf-8 -*-
# tools/poc-tests/final_greeting_gate.spec.py
#
# Backend の final startup lifecycle / greeting_trigger / warmup suppression の
# 回帰テスト（Startup Architecture Phase 4）。
#
# 固定する不変条件:
#   E  warmup 世代の user-facing output は抑止される（live_connected のみ通す）
#   H  final 世代は live_connected 後 FINAL_WAITING_FOR_GREETING となり、
#      greeting_trigger が来るまで INITIAL_GREETING_TRIGGER を Gemini へ送らない
#   I  greeting_trigger を 1 回受理したときだけ 1 回だけ送る
#   J  同じ G2 の greeting_trigger を複数回送っても Gemini への送信は 1 回
#   K  stale な greeting_trigger(G1) は DROP
#   L  FINAL_WAITING_FOR_GREETING 中の live_stop で Greeting を発火せず
#      run() が正常終了する（待機が残らない / timeout は使わない）
#   M  正式 Greeting 後に再接続しても初期挨拶を再送しない
#   N  legacy path（generation / startup_role なし）は従来どおり即送信
#
# 実行方法:
#   python tools/poc-tests/final_greeting_gate.spec.py
#
# mock は外部依存のみ（_live_api_harness.py 参照）。
# 実 socket handler と実 LiveAPISession.run() をそのまま動かし、
# greeting / suppression のロジックは差し替えない。

import sys
import time

sys.path.insert(0, __file__.rsplit('/', 1)[0])
import _live_api_harness as H                                    # noqa: E402

app_mod = H.app_mod
RESULTS = []


def ok(cond, name, extra=''):
    cond = bool(cond)
    RESULTS.append((name, cond))
    print(f"{'PASS' if cond else 'FAIL'}  {name}" + (f"  {extra}" if extra else ''))


def sent_texts(sess):
    """fake Gemini session へ送られた send_client_content の本文一覧"""
    ls = getattr(sess, 'live_session', None)
    if ls is None:
        return []
    return [s[1] for s in ls.sent if s[0] == 'send_client_content']


def initial_trigger_count(sess):
    """INITIAL_GREETING_TRIGGER の送信回数だけを数える。
    再接続時の履歴再送も send_client_content を使うため、本文で区別する。"""
    from live_api_handler import LiveAPISession
    msgs = LiveAPISession.INITIAL_GREETING_TRIGGERS
    expected = msgs.get(sess.mode, msgs['chat']).get(sess.language, msgs['chat']['ja'])
    return sum(1 for t in sent_texts(sess) if t == expected)


# ============================================================
# Test E — warmup suppression
# ============================================================
print("\n=== Test E: warmup 世代の user-facing output 抑止 ===")
H.reset_state()
c = H.new_client()
sid = H.sid_of(c)
H.live_start(c, 'G1', 'warmup')
g1 = H.SESSIONS[-1]
recv = c.get_received()
names = [r['name'] for r in recv]

ok('live_connected' in names,
   'E-1 warmup でも live_connected は通す（lifecycle 確認用）', f"received={names}")
ok(g1.startup_role == 'warmup', 'E-2 session の startup_role = warmup')

c.get_received()
for ev, data in [('live_audio', {'data': 'AAAA'}), ('live_expression', {'expressions': []}),
                 ('live_expression_reset', None), ('user_transcript', {'text': 'x'}),
                 ('ai_transcript', {'text': 'x'}), ('turn_complete', {}),
                 ('greeting_done', {}), ('interrupted', {}),
                 ('shop_search_start', {}), ('shop_search_result', {'shops': []}),
                 ('live_reconnecting', {}), ('live_reconnected', {})]:
    g1._emit(ev, data)
recv = c.get_received()
ok(len(recv) == 0,
   'E-3 warmup の user-facing event は 1 つもクライアントへ届かない',
   f"received={[r['name'] for r in recv]}")
ok(sent_texts(g1) and len(sent_texts(g1)) == 1,
   'E-4 warmup の内部処理（初期挨拶トリガー）は従来どおり実行される',
   f"sent={sent_texts(g1)}")
g1._emit('live_connected', {'session_count': 1})
ok(len(c.get_received()) == 1, 'E-5 live_connected だけは通る')


# ============================================================
# Test H / I — final waiting と exact trigger
# ============================================================
print("\n=== Test H/I: FINAL_WAITING_FOR_GREETING と greeting_trigger ===")
H.reset_state()
c2 = H.new_client()
sid2 = H.sid_of(c2)
H.live_start(c2, 'G2', 'final')
g2 = H.SESSIONS[-1]
recv = c2.get_received()
names = [r['name'] for r in recv]

ok('live_connected' in names, 'H-1 final でも live_connected は届く', f"received={names}")
ok(g2._greeting_state == 'FINAL_WAITING_FOR_GREETING',
   'H-2 state が FINAL_WAITING_FOR_GREETING', f"state={g2._greeting_state}")
ok(sent_texts(g2) == [],
   'H-3 greeting_trigger 前は INITIAL_GREETING_TRIGGER を Gemini へ送らない',
   f"sent={sent_texts(g2)}")
ok(g2._greeting_triggered is False, 'H-4 greeting_triggered は False のまま')

c2.emit('greeting_trigger', {'generation_id': 'G2'})
time.sleep(0.4)
ok(g2._greeting_triggered is True, 'I-1 greeting_trigger を受理して one-shot state が確定')
ok(g2._greeting_state == 'GREETING_TRIGGERED', 'I-2 state が GREETING_TRIGGERED',
   f"state={g2._greeting_state}")
ok(len(sent_texts(g2)) == 1,
   'I-3 INITIAL_GREETING_TRIGGER を exactly 1 回送る', f"sent={sent_texts(g2)}")
ok(g2._is_initial_greeting_phase is True,
   'I-4 初期挨拶フェーズの扱いは従来どおり')


# ============================================================
# Test J — duplicate greeting_trigger
# ============================================================
print("\n=== Test J: 同じ G2 への greeting_trigger 重複 ===")
H.LOG_LINES.clear()
for _ in range(3):
    c2.emit('greeting_trigger', {'generation_id': 'G2'})
time.sleep(0.4)
ok(len(sent_texts(g2)) == 1,
   'J-1 重複受信しても Gemini への初期トリガーは 1 回のまま', f"sent={sent_texts(g2)}")
ok(any('greeting_trigger DROP' in l for l in H.LOG_LINES),
   'J-2 2 回目以降は DROP としてログに出る',
   f"drops={[l for l in H.LOG_LINES if 'greeting_trigger DROP' in l][:1]}")


# ============================================================
# Test K — stale greeting_trigger
# ============================================================
print("\n=== Test K: stale greeting_trigger(G1) ===")
H.reset_state()
c3 = H.new_client()
H.live_start(c3, 'G1', 'final')
H.live_start(c3, 'G2', 'final')
g2b = H.SESSIONS[-1]
H.LOG_LINES.clear()
c3.emit('greeting_trigger', {'generation_id': 'G1'})
time.sleep(0.4)
ok(sent_texts(g2b) == [],
   'K-1 stale な greeting_trigger(G1) では Greeting を送らない', f"sent={sent_texts(g2b)}")
ok(any('event=greeting_trigger' in l and 'DROP' in l for l in H.LOG_LINES),
   'K-2 ログに DROP が出る')
ok(g2b._greeting_triggered is False, 'K-3 G2 の one-shot state は未確定のまま')


# ============================================================
# Test L — stop while waiting
# ============================================================
print("\n=== Test L: FINAL_WAITING_FOR_GREETING 中の live_stop ===")
H.reset_state()
c4 = H.new_client()
H.live_start(c4, 'G2', 'final')
g2c = H.SESSIONS[-1]
ok(g2c._greeting_state == 'FINAL_WAITING_FOR_GREETING', 'L-1 待機状態に入っている')
c4.emit('live_stop', {'generation_id': 'G2'})
time.sleep(0.8)
ok(sent_texts(g2c) == [], 'L-2 Greeting を発火していない', f"sent={sent_texts(g2c)}")
ok(g2c.is_running is False, 'L-3 session が停止している')
ok(g2c._a2e_worker_task is None,
   'L-4 run() が正常終了している（待機が残っていない）',
   f"worker={g2c._a2e_worker_task}")
accepted, reason = g2c.request_greeting('G2')
ok(accepted is False, 'L-5 停止後の greeting_trigger は受理されない', f"reason={reason}")


# ============================================================
# Test M — reconnect after greeting
# ============================================================
print("\n=== Test M: 正式 Greeting 後の再接続 ===")
H.reset_state()
c5 = H.new_client()
H.live_start(c5, 'G2', 'final')
g2d = H.SESSIONS[-1]
c5.emit('greeting_trigger', {'generation_id': 'G2'})
time.sleep(0.4)
ok(initial_trigger_count(g2d) == 1, 'M-1 正式 Greeting が 1 回発火',
   f"sent={sent_texts(g2d)}")
before = initial_trigger_count(g2d)   # 再接続前の送信回数（= 1）
g2d.needs_reconnect = True          # Gemini 側の再接続ループへ入る
time.sleep(0.8)
ok(g2d.session_count >= 2, 'M-2 再接続して session_count が進んだ',
   f"session_count={g2d.session_count}")
# 再接続すると fake Gemini session は新しい接続のものに差し替わる。
# その新しい接続へ初期トリガーが 1 度も送られていないことを確認する。
ok(before == 1 and initial_trigger_count(g2d) == 0,
   'M-3 再接続後の接続へ INITIAL_GREETING_TRIGGER を再送しない',
   f"before={before} after={initial_trigger_count(g2d)} sent={sent_texts(g2d)}")
ok(g2d._greeting_triggered is True,
   'M-4 one-shot state は final startup lifecycle に属し保持される')
g2d.stop()
time.sleep(0.3)


# ============================================================
# Test N — legacy regression
# ============================================================
print("\n=== Test N: legacy path（generation / startup_role なし）===")
H.reset_state()
c6 = H.new_client()
H.live_start(c6)
g_legacy = H.SESSIONS[-1]
recv_names = [r['name'] for r in c6.get_received()]
ok(g_legacy.startup_role is None, 'N-1 startup_role は None のまま')
ok(len(sent_texts(g_legacy)) == 1,
   'N-2 legacy は従来どおり接続と同時に初期挨拶を送る', f"sent={sent_texts(g_legacy)}")
ok(g_legacy._greeting_state is None,
   'N-3 legacy は FINAL_WAITING_FOR_GREETING に入らない',
   f"state={g_legacy._greeting_state}")
ok('live_ready' in recv_names and 'live_connected' in recv_names,
   'N-4 legacy でも live_ready / live_connected は届く', f"received={recv_names}")
q0 = g_legacy.audio_queue_to_gemini.qsize()
c6.emit('live_audio_in', {'data': H.base64.b64encode(b'\x00\x01' * 160).decode()})
time.sleep(0.2)
ok(g_legacy.audio_queue_to_gemini.qsize() == q0 + 1,
   'N-5 legacy の通常会話経路は維持されている')
c6.disconnect()


# ============================================================
# 静的検査
# ============================================================
print("\n=== 静的検査: thread/asyncio 安全性と変更禁止範囲 ===")
with open(H._SUPPORT_BASE + '/live_api_handler.py', encoding='utf-8') as f:
    handler_src = f.read()
with open(H._SUPPORT_BASE + '/app_customer_support.py', encoding='utf-8') as f:
    app_src = f.read()

ok('loop.call_soon_threadsafe(event.set)' in handler_src,
   '静的-1 greeting_trigger は call_soon_threadsafe で loop へ通知する')
ok('asyncio.run(' not in handler_src,
   '静的-2 Socket handler から asyncio.run() で別 loop を作っていない')
req_body = handler_src[handler_src.index('def request_greeting'):
                       handler_src.index('def _release_greeting_wait')]
# docstring を落としてコード部分だけを見る（説明文の語に一致させない）
_d1 = req_body.index('"""')
_d2 = req_body.index('"""', _d1 + 3) + 3
req_code = req_body[:_d1] + req_body[_d2:]
ok('await' not in req_code and not req_code.lstrip().startswith('async def'),
   '静的-3 request_greeting は asyncio object を直接 await していない')
ok('threading.Thread' not in req_body and 'threading.Thread' not in app_src[
    app_src.index('def handle_greeting_trigger'):app_src.index("@socketio.on('live_audio_in')")],
   '静的-4 greeting_trigger 経路で新しい thread を作っていない')
ok('timeout' not in req_body.lower(),
   '静的-5 待機解除に timeout を使っていない')
_has_set = '_greeting_triggered = True' in req_code
_has_notify = 'call_soon_threadsafe' in req_code
ok(_has_set and _has_notify
   and req_code.index('_greeting_triggered = True') < req_code.index('call_soon_threadsafe'),
   '静的-6 one-shot state を loop への通知より先に確定している')
ok('_greeting_pcm_buffer' in handler_src and '_buffer_for_a2e' in handler_src
   and 'A2E_FIRST_FLUSH_BYTES = 4800' in handler_src
   and 'A2E_AUTO_FLUSH_BYTES = 240000' in handler_src,
   '静的-7 A2E 経路 / 閾値を変更していない（Phase 5 の範囲）')
ok('greeted_client_sids' in app_src and 'session_count' in handler_src,
   '静的-8 legacy の greeted_client_sids / session_count を撤去していない')
ok("WARMUP_ALLOWED_EVENTS = frozenset({'live_connected'})" in handler_src,
   '静的-9 warmup で通す event は live_connected だけ')


# ============================================================
print("\n" + "=" * 64)
failures = [n for n, p in RESULTS if not p]
for n, p in RESULTS:
    print(f"{'PASS' if p else 'FAIL'}  {n}")
print("=" * 64)
print(f"TOTAL {len(RESULTS)}  PASS {len(RESULTS) - len(failures)}  FAIL {len(failures)}")
sys.exit(1 if failures else 0)
