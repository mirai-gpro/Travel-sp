# -*- coding: utf-8 -*-
# tools/poc-tests/initial_greeting_a2e_streaming.spec.py
#
# 初期 Greeting の A2E 経路統一の回帰テスト（Startup Architecture Phase 5）。
#
# 固定する不変条件:
#   A  製品コードに初期あいさつ専用の一括PCMバッファが残っていない
#   B  初期 Greeting の最初の PCM chunk で _buffer_for_a2e() が呼ばれる
#   C  初期 Greeting では _send_a2e_ahead() が 0 回（他用途の call site は残る）
#   D  初期 Greeting でも A2E_FIRST_FLUSH_BYTES が作用する（閾値は不変）
#   E  初期 Greeting の output transcription の句読点で _delayed_a2e_flush が動く
#   F  FIRST_LIVE_EXPRESSION が TURN_COMPLETE より前（Phase 5 最大の判定条件）
#   G  turn_complete で通常と同じ final flush が走り queue が drain する
#   H  同一 PCM の二重送信が無く、欠落も無い
#   I  通常会話の call sequence が初期 Greeting と同じ形になっている
#   J  warmup でも内部 A2E streaming が動き、user-facing emit は 0
#   17 turn 境界で _a2e_chunk_index / buffer / queue が正常化する
#
# 実行方法:
#   python tools/poc-tests/initial_greeting_a2e_streaming.spec.py
#
# ------------------------------------------------------------------
# mock する範囲（= 外部サービスのみ。A2E ロジックは差し替えない）
# ------------------------------------------------------------------
# 実 LiveAPISession の _receive_and_forward() / _buffer_for_a2e() /
# _flush_a2e_buffer() / _a2e_send_worker() / _send_to_a2e() をそのまま動かす。
# 差し替えるのは以下だけ:
#   * Gemini Live の session.receive()（スクリプト化した応答を流す）
#   * _a2e_http_client（A2E サービスへの HTTP。固定の frames を返す）
#   * socketio（emit を記録する）
#   * ADC を要求する TTS/Speech クライアント（import 時）

import os
import sys
import asyncio
import logging

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO_ROOT = os.path.abspath(os.path.join(_HERE, '..', '..'))
_SUPPORT_BASE = os.path.join(_REPO_ROOT, 'support-base')
sys.path.insert(0, _SUPPORT_BASE)
os.environ.setdefault('GEMINI_API_KEY', 'dummy-key-for-test')
os.environ.pop('PROMPTS_BUCKET_NAME', None)

from google.cloud import texttospeech, speech                      # noqa: E402
texttospeech.TextToSpeechClient = lambda *a, **k: None
speech.SpeechClient = lambda *a, **k: None

import live_api_handler as LH                                      # noqa: E402
from live_api_handler import (LiveAPISession, A2E_FIRST_FLUSH_BYTES,  # noqa: E402
                              A2E_AUTO_FLUSH_BYTES, A2E_MIN_BUFFER_BYTES)

logging.getLogger().setLevel(logging.WARNING)

RESULTS = []


def ok(cond, name, extra=''):
    cond = bool(cond)
    RESULTS.append((name, cond))
    print(f"{'PASS' if cond else 'FAIL'}  {name}" + (f"  {extra}" if extra else ''))


# ============================================================
# Gemini 応答のスクリプト化
# ============================================================
class _Obj:
    def __init__(self, **kw):
        self.__dict__.update(kw)


def audio_response(pcm: bytes):
    part = _Obj(inline_data=_Obj(data=pcm))
    return _Obj(tool_call=None,
                server_content=_Obj(turn_complete=False, interrupted=False,
                                    model_turn=_Obj(parts=[part])))


def text_response(text: str):
    return _Obj(tool_call=None,
                server_content=_Obj(turn_complete=False, interrupted=False,
                                    output_transcription=_Obj(text=text),
                                    model_turn=None))


def turn_complete_response():
    return _Obj(tool_call=None,
                server_content=_Obj(turn_complete=True, interrupted=False,
                                    model_turn=None))


class FakeGeminiSession:
    """session.receive() がスクリプトを 1 ターン分だけ流す。"""

    def __init__(self, script, sess):
        self.script = script
        self.sess = sess
        self.turns = 0

    def receive(self):
        self.turns += 1
        script = self.script if self.turns == 1 else []
        sess = self.sess

        async def gen():
            for item in script:
                yield item
                await asyncio.sleep(0)
            if script:
                # 1 ターン流し終えたら receive ループを抜けさせる
                sess.is_running = False
        return gen()


# ============================================================
# A2E サービスの mock（HTTP 境界だけ差し替える）
# ============================================================
class _FakeResponse:
    status_code = 200

    def json(self):
        return {'frames': [{'weights': [0.0] * 52}],
                'names': ['jawOpen'], 'frame_rate': 30}


class FakeA2EClient:
    def __init__(self):
        self.requests = []          # (pcm_bytes_len, chunk_index, is_final)

    async def post(self, url, json=None, timeout=None):
        import base64 as _b64
        audio = _b64.b64decode(json['audio_base64'])
        self.requests.append({
            'resampled_bytes': len(audio),
            'is_start': json['is_start'],
            'is_final': json['is_final'],
        })
        return _FakeResponse()


class FakeSocketIO:
    def __init__(self):
        self.emitted = []

    def emit(self, event, payload=None, room=None):
        self.emitted.append((event, payload))


# ============================================================
# セッション構築と実行
# ============================================================
def make_session(generation_id='G2', startup_role='final'):
    sio = FakeSocketIO()
    sess = LiveAPISession(
        session_id='test-session', mode='chat', language='ja',
        system_prompt='test', socketio=sio, client_sid='sid-test',
        generation_id=generation_id, startup_role=startup_role)
    sess.socketio = sio
    sess._fake_sio = sio
    return sess


def run_turn(sess, script, is_initial_greeting):
    """実 _receive_and_forward() を 1 ターン動かし、呼び出し順を記録する。"""
    calls = []
    a2e_client = FakeA2EClient()
    pcm_in = bytearray()

    orig_buffer = sess._buffer_for_a2e
    orig_flush = sess._flush_a2e_buffer
    orig_ahead = sess._send_a2e_ahead
    orig_send = sess._send_to_a2e
    orig_delayed = sess._delayed_a2e_flush

    def rec_buffer(pcm):
        calls.append(('buffer_for_a2e', len(pcm)))
        pcm_in.extend(pcm)
        return orig_buffer(pcm)

    async def rec_flush(force=False, is_final=False):
        pending = len(sess._a2e_audio_buffer)
        r = await orig_flush(force=force, is_final=is_final)
        if pending and (force or pending >= A2E_MIN_BUFFER_BYTES):
            calls.append(('flush', pending, f'final={is_final}'))
        return r

    async def rec_ahead(pcm):
        calls.append(('send_a2e_ahead', len(pcm)))
        return await orig_ahead(pcm)

    async def rec_send(pcm, chunk_index, is_final=False):
        calls.append(('send_to_a2e', len(pcm), f'chunk={chunk_index}'))
        return await orig_send(pcm, chunk_index, is_final=is_final)

    async def rec_delayed():
        calls.append(('delayed_a2e_flush',))
        return await orig_delayed()

    sess._buffer_for_a2e = rec_buffer
    sess._flush_a2e_buffer = rec_flush
    sess._send_a2e_ahead = rec_ahead
    sess._send_to_a2e = rec_send
    sess._delayed_a2e_flush = rec_delayed

    orig_emit = sess._emit

    def rec_emit(event, data=None):
        if event in ('live_expression', 'turn_complete', 'greeting_done', 'live_audio'):
            calls.append(('emit:' + event,))
        return orig_emit(event, data)
    sess._emit = rec_emit

    async def scenario():
        sess._loop = asyncio.get_running_loop()
        sess.is_running = True
        sess._greeting_event = asyncio.Event()
        sess.audio_queue_to_gemini = asyncio.Queue(maxsize=5)
        sess._a2e_send_queue = asyncio.Queue()
        sess._a2e_http_client = a2e_client
        sess._a2e_worker_task = asyncio.ensure_future(sess._a2e_send_worker())
        sess._is_initial_greeting_phase = is_initial_greeting
        sess._turn_marks = set()
        await sess._receive_and_forward(FakeGeminiSession(script, sess))
        # 未完了の ensure_future（_buffer_for_a2e 内の自動フラッシュ）を流し切る
        for _ in range(5):
            await asyncio.sleep(0.05)
        sess._a2e_worker_task.cancel()

    asyncio.run(scenario())
    return calls, a2e_client, bytes(pcm_in)


def names(calls):
    return [c[0] for c in calls]


CHUNK = b'\x01\x02' * 1200          # 2400 bytes = 0.05 秒相当
GREETING_SCRIPT = ([audio_response(CHUNK) for _ in range(4)]
                   + [text_response('こんにちは。')]
                   + [audio_response(CHUNK) for _ in range(4)]
                   + [turn_complete_response()])


# ============================================================
# Test A — 旧 workaround の撤去
# ============================================================
print("\n=== Test A: 初期あいさつ専用バッファの撤去 ===")
with open(os.path.join(_SUPPORT_BASE, 'live_api_handler.py'), encoding='utf-8') as f:
    handler_src = f.read()
ok('_greeting_pcm_buffer' not in handler_src,
   'A-1 製品コードに初期あいさつ専用PCMバッファの参照が 0 件')
ok('_send_a2e_ahead' in handler_src,
   'A-2 _send_a2e_ahead() 自体は削除していない')
ahead_calls = handler_src.count('await self._send_a2e_ahead(')
ok(ahead_calls == 2,
   'A-3 _send_a2e_ahead() の call site は他用途の 2 件だけ残っている',
   f"count={ahead_calls}")
ok('_is_initial_greeting_phase' in handler_src,
   'A-4 _is_initial_greeting_phase 自体は残っている（Greeting lifecycle 用）')
turn_block = handler_src[handler_src.index("if hasattr(sc, 'turn_complete') and sc.turn_complete:"):]
turn_block = turn_block[:turn_block.index('# 3. 割り込み検知')]
# コメント行を落としてコードだけを見る（撤去を説明するコメントに一致させない）
turn_code = '\n'.join(l for l in turn_block.splitlines()
                      if not l.strip().startswith('#'))
ok('_send_a2e_ahead' not in turn_code,
   'A-5 turn_complete に一括 A2E 送信の分岐が無い')
ok('await self._flush_a2e_buffer(force=True, is_final=True)' in turn_block
   and 'await self._a2e_send_queue.join()' in turn_block,
   'A-6 turn_complete は通常と同じ final flush -> queue.join() だけ')


# ============================================================
# Test B〜H — 初期 Greeting の実経路
# ============================================================
print("\n=== Test B〜H: 初期 Greeting の PCM -> A2E sequence ===")
sess = make_session('G2', 'final')
calls, a2e, pcm_in = run_turn(sess, GREETING_SCRIPT, is_initial_greeting=True)
seq = names(calls)

ok(seq and seq[0] == 'emit:live_audio' and seq[1] == 'buffer_for_a2e',
   'B-1 最初の PCM chunk で _buffer_for_a2e() が呼ばれる', f"head={seq[:4]}")
ok('send_a2e_ahead' not in seq,
   'C-1 初期 Greeting で _send_a2e_ahead() は 0 回', f"seq={seq[:12]}")

first_flush = next((c for c in calls if c[0] == 'flush'), None)
ok(first_flush is not None and first_flush[1] >= A2E_FIRST_FLUSH_BYTES,
   'D-1 初回フラッシュが A2E_FIRST_FLUSH_BYTES で発火する',
   f"first_flush_bytes={first_flush[1] if first_flush else None}"
   f" threshold={A2E_FIRST_FLUSH_BYTES}")
ok(A2E_FIRST_FLUSH_BYTES == 4800 and A2E_AUTO_FLUSH_BYTES == 240000
   and A2E_MIN_BUFFER_BYTES == 4800,
   'D-2 A2E 閾値は変更されていない',
   f"{A2E_MIN_BUFFER_BYTES}/{A2E_FIRST_FLUSH_BYTES}/{A2E_AUTO_FLUSH_BYTES}")

ok('delayed_a2e_flush' in seq,
   'E-1 初期 Greeting でも句読点検出の遅延フラッシュが動く', f"seq={seq}")
ok('250' in handler_src and 'asyncio.sleep(0.25)' in handler_src,
   'E-2 250ms の遅延は変更されていない')

idx_expr = seq.index('emit:live_expression') if 'emit:live_expression' in seq else -1
idx_turn = seq.index('emit:turn_complete') if 'emit:turn_complete' in seq else -1
ok(idx_expr != -1 and idx_turn != -1 and idx_expr < idx_turn,
   'F-1 FIRST_LIVE_EXPRESSION が TURN_COMPLETE より前（Phase 5 最大の判定条件）',
   f"expression@{idx_expr} turn_complete@{idx_turn}")
ok(idx_expr != -1 and 'send_to_a2e' in seq[:idx_expr],
   'F-2 expression は streaming chunk の A2E 応答から出ている')

final_flush = [c for c in calls if c[0] == 'flush' and 'final=True' in c[2]]
ok(len(final_flush) == 1, 'G-1 turn_complete で final flush が 1 回',
   f"count={len(final_flush)}")
ok(sess._a2e_send_queue.qsize() == 0, 'G-2 turn 終了時に queue が drain している',
   f"qsize={sess._a2e_send_queue.qsize()}")
ok(len(sess._a2e_audio_buffer) == 0, 'G-3 turn 終了時に PCM バッファが空',
   f"bytes={len(sess._a2e_audio_buffer)}")
ok(sess._a2e_chunk_index == 0, '17-1 turn 境界で _a2e_chunk_index が reset される',
   f"chunk_index={sess._a2e_chunk_index}")

sent_total = sum(c[1] for c in calls if c[0] == 'send_to_a2e')
ok(sent_total == len(pcm_in),
   'H-1 A2E へ渡された PCM 総量が入力と一致（重複なし / 欠落なし）',
   f"in={len(pcm_in)} to_a2e={sent_total}")
ok(len(a2e.requests) >= 2,
   'H-2 1 ターンが複数チャンクに分かれて streaming 送信されている',
   f"requests={len(a2e.requests)}")
ok(a2e.requests[0]['is_start'] is True and a2e.requests[-1]['is_final'] is True,
   'H-3 is_start / is_final が通常どおり付く',
   f"first={a2e.requests[0]} last={a2e.requests[-1]}")

print("\n--- 初期 Greeting の call sequence ---")
for c in calls:
    print('   ', c)


# ============================================================
# Test I — 通常会話との形の一致
# ============================================================
print("\n=== Test I: 通常会話との call sequence 比較 ===")
sess_n = make_session('G2', 'final')
calls_n, a2e_n, pcm_in_n = run_turn(sess_n, GREETING_SCRIPT, is_initial_greeting=False)
seq_n = names(calls_n)

A2E_STEPS = {'buffer_for_a2e', 'flush', 'send_to_a2e', 'send_a2e_ahead',
             'delayed_a2e_flush', 'emit:live_expression', 'emit:turn_complete'}
a2e_seq = [n for n in seq if n in A2E_STEPS]
a2e_seq_n = [n for n in seq_n if n in A2E_STEPS]
ok(a2e_seq == a2e_seq_n,
   'I-1 初期 Greeting と通常会話の A2E call sequence が完全に一致する',
   f"greeting={len(a2e_seq)} normal={len(a2e_seq_n)}")
ok(set(seq) - set(seq_n) <= {'emit:greeting_done'}
   and set(seq_n) - set(seq) == set(),
   'I-1b 両者の差は Greeting lifecycle の greeting_done だけ',
   f"diff={sorted(set(seq) ^ set(seq_n))}")
ok(sum(c[1] for c in calls_n if c[0] == 'send_to_a2e') == len(pcm_in_n),
   'I-2 通常会話側も PCM の重複 / 欠落が無い')
ok(len(a2e_n.requests) == len(a2e.requests),
   'I-3 A2E リクエスト数が同じ', f"{len(a2e.requests)} vs {len(a2e_n.requests)}")


# ============================================================
# Test J — warmup の内部 streaming と抑止
# ============================================================
print("\n=== Test J: warmup 内部 A2E streaming + user-facing 抑止 ===")
sess_w = make_session('G1', 'warmup')
calls_w, a2e_w, pcm_in_w = run_turn(sess_w, GREETING_SCRIPT, is_initial_greeting=True)
seq_w = names(calls_w)

ok('buffer_for_a2e' in seq_w and 'send_to_a2e' in seq_w,
   'J-1 warmup でも内部 A2E streaming が動く', f"seq={seq_w[:8]}")
emitted = [e for e, _ in sess_w._fake_sio.emitted]
ok(len(emitted) == 0,
   'J-2 warmup の user-facing emit は 0 件', f"emitted={emitted}")
ok(sum(c[1] for c in calls_w if c[0] == 'send_to_a2e') == len(pcm_in_w),
   'J-3 warmup でも PCM の重複 / 欠落が無い')


# ============================================================
# Test K — G1 停止後に A2E の内部 task / queue が G2 を汚染しない
# ============================================================
print("\n=== Test K: G1 stop -> cleanup -> G2 start ===")
g1 = make_session('G1', 'warmup')
g2 = make_session('G2', 'final')
ok(g1._a2e_send_queue is not g2._a2e_send_queue
   and g1._a2e_audio_buffer is not g2._a2e_audio_buffer,
   'K-1 世代ごとに A2E queue / buffer が独立している')

calls_k, a2e_k, pcm_k = run_turn(g1, GREETING_SCRIPT, is_initial_greeting=True)
ok(g1._a2e_worker_task.cancelled() or g1._a2e_worker_task.done(),
   'K-2 G1 の A2E worker task が残っていない',
   f"done={g1._a2e_worker_task.done()}")
ok(len(g1._a2e_audio_buffer) == 0 and g1._a2e_send_queue.qsize() == 0,
   'K-3 G1 の pending A2E work が残っていない')

# G1 が遅れて expression を emit しても generation は G1 のまま
g1.is_running = True
g1._emit('live_expression', {'expressions': [[0.0]], 'chunk_index': 9})
late = [p for e, p in g1._fake_sio.emitted if e == 'live_expression']
ok(len(late) == 0,
   'K-4 warmup G1 の遅延 expression は suppression で出ない', f"late={late}")
g1b = make_session('G1', 'final')      # warmup 以外でも generation は付け替わらない
g1b.is_running = True
g1b._emit('live_expression', {'expressions': [[0.0]], 'chunk_index': 9})
late_b = [p for e, p in g1b._fake_sio.emitted if e == 'live_expression']
ok(len(late_b) == 1 and late_b[0]['generation_id'] == 'G1',
   'K-5 遅延 expression の generation_id は G1 のまま（G2 に付け替えない）',
   f"payload={late_b[0] if late_b else None}")


# ============================================================
# 静的検査 — 凍結範囲
# ============================================================
print("\n=== 静的検査: 凍結範囲 ===")


def body(name, end):
    i = handler_src.index(name)
    return handler_src[i:handler_src.index(end, i)]


buf_body = body('def _buffer_for_a2e', 'def _on_output_transcription')
ok(buf_body.count('asyncio.ensure_future(self._flush_a2e_buffer(force=True))') == 1
   and 'A2E_FIRST_FLUSH_BYTES if self._a2e_chunk_index == 0 else A2E_AUTO_FLUSH_BYTES' in buf_body,
   '静的-1 _buffer_for_a2e() の本体が baseline のまま')
trans_body = body('def _on_output_transcription', 'def _delayed_a2e_flush')
ok("['。', '？', '！', '?', '!', '、', '，', ',']" in trans_body
   or '。' in trans_body,
   '静的-2 句読点トリガーのリストが残っている')
ok('asyncio.sleep(0.25)' in body('def _delayed_a2e_flush', 'async def _send_a2e_ahead'),
   '静的-3 _delayed_a2e_flush の 250ms が不変')
worker_body = body('async def _a2e_send_worker', 'def _clear_a2e_queue')
ok('await self._a2e_send_queue.get()' in worker_body
   and 'self._a2e_send_queue.task_done()' in worker_body,
   '静的-4 _a2e_send_worker() が baseline のまま')
send_body = body('async def _send_to_a2e', 'def _format_shop_for_prompt')
ok('resample_poly' in send_body and 'up=2, down=3' in send_body
   and "'is_start': chunk_index == 0" in send_body.replace('"', "'"),
   '静的-5 _send_to_a2e() が baseline のまま')
ok('FINAL_WAITING_FOR_GREETING' in handler_src
   and 'def request_greeting' in handler_src
   and "WARMUP_ALLOWED_EVENTS = frozenset({'live_connected'})" in handler_src,
   '静的-6 Phase 4 の greeting gate / warmup suppression を壊していない')


# ============================================================
print("\n" + "=" * 64)
failures = [n for n, p in RESULTS if not p]
for n, p in RESULTS:
    print(f"{'PASS' if p else 'FAIL'}  {n}")
print("=" * 64)
print(f"TOTAL {len(RESULTS)}  PASS {len(RESULTS) - len(failures)}  FAIL {len(failures)}")
sys.exit(1 if failures else 0)
