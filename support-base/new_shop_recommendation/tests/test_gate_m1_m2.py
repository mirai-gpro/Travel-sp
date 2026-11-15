# -*- coding: utf-8 -*-
"""Gate M1（ストリーミング計測）・M2（resolveNames 計測）の計測処理のテスト（外部 API なし）"""
import json
import os
import random
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from new_shop_recommendation import contracts as c  # noqa: E402
from new_shop_recommendation.poc import gate_m1_streaming as m1  # noqa: E402
from new_shop_recommendation.poc import gate_m2_resolve_names as m2  # noqa: E402
from new_shop_recommendation.poc.stream_json import CandidateStreamTracker, SseReader  # noqa: E402
from new_shop_recommendation.recommender import build_request_body  # noqa: E402

CANDS = [{'rank': i, 'name': n, 'area_hint': a, 'specialty': 's{"x"}', 'reason': 'r, [括弧] {波} \\ "引用" ' + str(i)}
         for i, (n, a) in enumerate([('焼鳥 美鶏', '関内'), ('里葉亭', '福富町'), ('A "B"', '関内'), ('地葉', ''),
                                      ('伝兵衛', '西口'), ('末広', '野毛'), ('弥平', '鶴屋町')], 1)]
DOC = json.dumps({'freshness_intent': 'not_needed', 'candidates': CANDS}, ensure_ascii=False, indent=1)


def feed_in_chunks(text, seed):
    rnd, tr, i, t = random.Random(seed), CandidateStreamTracker(), 0, 0
    marks = []
    while i < len(text):
        n = rnd.randint(1, 9)
        tr.feed(text[i:i + n], t)
        marks.append((i + n, t))
        i, t = i + n, t + 1
    return tr, marks


# ------------------------------------------------------------------ M1: JSON トラッカー
@pytest.mark.parametrize('seed', range(20))
def test_tracker_full_objects_equal_json_regardless_of_chunking(seed):
    tr, _ = feed_in_chunks(DOC, seed)
    assert tr.root_closed and not tr.errors
    assert [cd['obj'] for cd in tr.candidates] == CANDS          # 文字列中の { } [ ] " \ , に惑わされない
    assert all(cd['error'] is None and cd['full_t'] is not None for cd in tr.candidates)
    assert tr.text() == DOC


def test_tracker_early_before_full_and_exact_times():
    tr = CandidateStreamTracker()
    head = DOC[:DOC.index('"specialty"')]                         # 1 店舗目の rank・name・area_hint まで
    tr.feed(head, 10)
    c1 = tr.candidates[0]
    assert c1['early_t'] == 10 and c1['full_t'] is None and c1['fields']['name'] == '焼鳥 美鶏'
    end1 = DOC.rfind('}', 0, DOC.index('"rank": 2')) + 1          # 1 店舗目のオブジェクトが閉じる位置（2 店舗目の直前）
    tr.feed(DOC[len(head):end1], 20)
    assert c1['full_t'] == 20 and tr.candidates[0]['obj']['rank'] == 1
    assert len(tr.candidates) == 1


def test_tracker_name_not_early_until_string_closed():
    tr = CandidateStreamTracker()
    prefix = DOC[:DOC.index('焼鳥 美鶏') + 2]                      # 店名の途中で切れている
    tr.feed(prefix, 1)
    assert tr.candidates[0]['early_t'] is None


def test_tracker_truncated_and_invalid_rank():
    tr = CandidateStreamTracker()
    tr.feed(DOC[:len(DOC) // 2], 1)
    s = tr.summary()
    assert not s['root_closed'] and s['n_full'] < 7
    bad = json.dumps({'freshness_intent': 'x', 'candidates': [dict(CANDS[0], rank=2)]}, ensure_ascii=False)
    tr2 = CandidateStreamTracker()
    tr2.feed(bad, 1)
    assert tr2.candidates[0]['error'] == 'invalid_output_rank' and tr2.candidates[0]['full_t'] is None


def test_sse_reader_split_lines_and_multibyte():
    raw = ('event: step.delta\ndata: {"index": 1, "delta": {"type": "text", "text": "焼鳥"}, "event_type": "step.delta"}\n\n'
           'event: done\ndata: [DONE]\n\n').encode('utf-8')
    for cut in range(1, len(raw)):
        r = SseReader()
        ev = r.feed(raw[:cut]) + r.feed(raw[cut:]) + r.flush()
        assert [e for e, _ in ev] == ['step.delta', 'done']
        assert json.loads(ev[0][1])['delta']['text'] == '焼鳥'


# ------------------------------------------------------------------ M1: 1 試行（SSE を模擬）
class FakeStream:
    def __init__(self, chunks, status=200):
        self.status_code, self._chunks, self.text = status, chunks, ''

    def iter_content(self, chunk_size=None):
        yield from self._chunks


def sse(event, obj):
    return f'event: {event}\ndata: {json.dumps(obj, ensure_ascii=False)}\n\n'.encode('utf-8')


def test_run_stream_request_and_metrics():
    captured = {}
    clock = iter(range(0, 100000, 100))

    def post(url, json=None, headers=None, timeout=None, stream=None):
        captured.update(url=url, body=json, headers=headers, stream=stream)
        parts = [sse('interaction.created', {'event_type': 'interaction.created', 'interaction': {'status': 'in_progress'}}),
                 sse('step.start', {'event_type': 'step.start', 'index': 0, 'step': {'type': 'thought'}}),
                 sse('step.stop', {'event_type': 'step.stop', 'index': 0}),
                 sse('step.start', {'event_type': 'step.start', 'index': 1, 'step': {'type': 'model_output'}})]
        for k in range(0, len(DOC), 40):
            parts.append(sse('step.delta', {'event_type': 'step.delta', 'index': 1,
                                            'delta': {'type': 'text', 'text': DOC[k:k + 40]}}))
        parts += [sse('step.stop', {'event_type': 'step.stop', 'index': 1}),
                  sse('interaction.completed', {'event_type': 'interaction.completed', 'interaction': {
                      'status': 'completed', 'usage': {'total_output_tokens': 321, 'total_thought_tokens': 99}}}),
                  b'event: done\ndata: [DONE]\n\n']
        blob = b''.join(parts)
        return FakeStream([blob[i:i + 37] for i in range(0, len(blob), 37)])
    m, tr = m1.run_stream('AQ.TESTKEY0123456789abcdefghij', '横浜で焼き鳥', post=post, now=lambda: next(clock) / 1000)
    body = captured['body']
    expected = build_request_body('横浜で焼き鳥')
    expected['stream'] = True
    assert body == expected and 'tools' not in body and body['generation_config']['thinking_level'] == 'low'
    assert captured['stream'] is True and body['model'] == c.MODEL_ID
    ev = m1.evaluate(m, tr)
    assert ev['validate_error'] is None and ev['n_final'] == 7 and ev['stream_matches_final'] is True
    assert m['status'] == 'completed' and m['usage']['total_output_tokens'] == 321 and m['error'] is None
    assert m['first_event_ms'] < m['thought_stop_ms'] < m['first_text_ms'] < m['completed_ms'] <= m['end_ms']
    full = [cd['full_t'] for cd in tr.candidates]
    early = [cd['early_t'] for cd in tr.candidates]
    assert all(e <= f for e, f in zip(early, full)) and full == sorted(full)


def test_run_stream_http_error_and_duplicate_detected():
    m, tr = m1.run_stream('k', 'q', post=lambda *a, **k: FakeStream([], status=429))
    assert m['error'].startswith('http_429')
    dup = json.dumps({'freshness_intent': 'not_needed', 'candidates': [CANDS[0], dict(CANDS[0], rank=2)]}, ensure_ascii=False)
    tr2 = CandidateStreamTracker()
    tr2.feed(dup, 1)
    assert m1.evaluate({}, tr2)['validate_error'] == 'invalid_output_duplicate'


# ------------------------------------------------------------------ M2: resolveNames
def test_m2_build_body_and_parse_alignment():
    vp = m2.viewport({'lat': 35.0, 'lng': 139.0})
    b = m2.build_body(['a', 'b'], vp)
    assert b == {'queries': [{'text': 'a'}, {'text': 'b'}], 'regionCode': 'JP',
                 'locationBias': {'viewport': {'low': {'latitude': 34.97, 'longitude': 138.963},
                                               'high': {'latitude': 35.03, 'longitude': 139.037}}}}
    assert 'locationBias' not in m2.build_body(['a'])
    with pytest.raises(ValueError):
        m2.build_body(['x'] * 21)
    data = {'results': [{'entity': {'place': 'places/P0'}, 'confidence': 'HIGH'}, {}, {'entity': {'place': 'places/P2'},
                                                                                       'confidence': 'MEDIUM'}, {}],
            'failedRequests': {'1': {'code': 5, 'message': 'Place not found.'}, '3': {'code': 13, 'message': 'x'}}}
    out = m2.parse_response(data, 4)
    assert [(o['place_id'], o['confidence'], o['status']) for o in out] == [
        ('P0', 'HIGH', 'OK'), (None, None, 'NOT_FOUND'), ('P2', 'MEDIUM', 'OK'), (None, None, 'FAILED_13')]
    short = m2.parse_response({'results': [{'entity': {'place': 'places/A'}, 'confidence': 'HIGH'}]}, 2)
    assert short[1]['status'] == 'NO_ENTITY'


def test_m2_resolve_request_headers_and_http_error():
    cap = {}

    class R:
        status_code = 200

        def json(self):
            return {'results': [{'entity': {'place': 'places/X'}, 'confidence': 'HIGH'}]}

    def post(url, json=None, headers=None, timeout=None):
        cap.update(url=url, json=json, headers=headers)
        return R()
    out, _ms, st = m2.resolve('AIzaKEY', ['店 地区 東京都'], None, post=post)
    assert cap['url'] == 'https://mapstools.googleapis.com/v1:resolveNames' and cap['headers']['X-Goog-Api-Key'] == 'AIzaKEY'
    assert 'AIzaKEY' not in cap['url'] and out[0]['place_id'] == 'X' and st == 200

    class E:
        status_code, text = 403, 'denied'
    out2, _ms, st2 = m2.resolve('k', ['a', 'b'], None, post=lambda *a, **k: E())
    assert st2 == 403 and [o['status'] for o in out2] == ['HTTP_403', 'HTTP_403']


def test_m2_fixture_and_evaluation(monkeypatch):
    groups = m2.load_groups()
    assert len(groups) == 118 and sum(len(g['rids']) for g in groups) == 132
    hato = next(g for g in groups if g['rec'] == '茶亭 羽當')
    assert hato['labels'] == {'珈琲茶館 集＆ガトーナチュレール シュウ 渋谷宮益坂店': 'X', '茶亭 羽當': 'O'}
    assert m2.query_text(hato) == '茶亭 羽當 渋谷駅東口・宮益坂 東京都'
    sub = [hato, next(g for g in groups if g['rec'] == '日本料理 水天一碧'), next(g for g in groups if g['rec'] == '地葉')]
    names = {'H': '茶亭 羽當', 'S': '鮨 水天一碧', 'Z': '知らない店'}
    monkeypatch.setattr(m2, 'details', lambda pid, get=None: {'name': names[pid], 'address': '東京都', 'business_status': ''})
    res = [{'place_id': 'H', 'confidence': 'HIGH', 'status': 'OK'}, {'place_id': 'S', 'confidence': 'HIGH', 'status': 'OK'},
           {'place_id': 'Z', 'confidence': 'HIGH', 'status': 'OK'}]
    ev = m2.evaluate(sub, res)
    assert (ev['high_correct'], ev['high_wrong'], ev['high_unknown'], ev['known']) == (1, 1, 1, 2)
    assert [x['v'] for x in ev['cases']] == ['O', 'X', 'unlabeled']
    res[2] = {'place_id': None, 'confidence': None, 'status': 'NOT_FOUND'}
    assert m2.evaluate(sub, res)['missed_known'] == 1


def test_m2_d_baseline_same_denominator():
    d0 = m2.d_baseline(m2.load_groups())
    assert d0['known'] == 81 and d0['adopt_x'] >= 1 and d0['adopt_o'] > d0['adopt_x']
