# -*- coding: utf-8 -*-
"""同一性判定 LLM（Gate D1.5 PoC）のテスト。外部 API なし"""
import json
import os
import sys
from unittest import mock

import pytest
import requests

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

import api_integrations as ai  # noqa: E402
from new_shop_recommendation import contracts as c  # noqa: E402
from new_shop_recommendation import llm_identity_verifier as liv  # noqa: E402
from new_shop_recommendation.orchestrator import ShopRecommendationOrchestrator, build_from_env  # noqa: E402

import test_orchestrator as to  # noqa: E402

KEY = 'AQ.TESTIDENTITYKEY0123456789abcdef'


def pairs(n=3):
    return [{'id': i, 'recommended_name': f'店{i}', 'recommended_area': '中央区',
             'matched_name': f'G店{i}', 'matched_area': '東京都中央区'} for i in range(1, n + 1)]


class Resp:
    def __init__(self, status, payload=None, text=''):
        self.status_code, self._p, self.text = status, payload, text

    def json(self):
        return self._p


def payload(results, via='steps'):
    t = json.dumps({'results': results}, ensure_ascii=False)
    if via == 'output_text':
        return {'status': 'completed', 'output_text': t}
    return {'status': 'completed', 'steps': [{'type': 'model_output', 'content': [{'type': 'text', 'text': t}]}]}


def verifier(resp):
    calls = []

    def post(url, json=None, headers=None, timeout=None):
        calls.append({'url': url, 'json': json, 'headers': headers})
        if isinstance(resp, BaseException):
            raise resp
        return resp
    return liv.LlmIdentityVerifier(KEY, http_post=post), calls


def test_request_contract_one_call_no_tools_low():
    v, calls = verifier(Resp(200, payload([{'id': i, 'judgment': 'SAME', 'reason': 'r'} for i in range(1, 8)])))
    res, dur, searches = v.verify(pairs(7))
    assert len(calls) == 1                                        # 7 組を 1 回で
    b = calls[0]['json']
    assert 'tools' not in b and b['model'] == 'gemini-3.8-flash'
    assert b['generation_config'] == {'thinking_level': 'low', 'max_output_tokens': 1024}
    assert b['response_format'] == {'type': 'text', 'mime_type': 'application/json', 'schema': c.IDENTITY_SCHEMA}
    assert b['stream'] is False and b['store'] is False
    assert '新たな店舗推薦は行わない' in b['input'] and '"id": 7' in b['input']
    assert calls[0]['headers']['x-goog-api-key'] == KEY and KEY not in json.dumps(b)
    assert set(res) == set(range(1, 8)) and searches == 0


@pytest.mark.parametrize('results,etype', [
    ([{'id': 1, 'judgment': 'SAME', 'reason': 'r'}], 'identity_count_mismatch'),
    ([{'id': 1, 'judgment': 'SAME', 'reason': 'r'}, {'id': 9, 'judgment': 'SAME', 'reason': 'r'}], 'identity_id_mismatch'),
    ([{'id': 1, 'judgment': 'SAME', 'reason': 'r'}, {'id': 1, 'judgment': 'SAME', 'reason': 'r'}], 'identity_id_duplicate'),
    ([{'id': 1, 'judgment': 'MAYBE', 'reason': 'r'}, {'id': 2, 'judgment': 'SAME', 'reason': 'r'}], 'identity_invalid_judgment'),
    ([{'id': 1, 'judgment': 'SAME'}, {'id': 2, 'judgment': 'SAME', 'reason': 'r'}], 'identity_invalid_output'),
])
def test_invalid_results_are_errors_not_guessed(results, etype):
    v, _ = verifier(Resp(200, payload(results)))
    with pytest.raises(liv.IdentityError) as ei:
        v.verify(pairs(2))
    assert ei.value.error_type == etype


def test_bad_json_http_errors_timeout():
    v, _ = verifier(Resp(200, {'status': 'completed', 'output_text': '{"results": ['}))
    with pytest.raises(liv.IdentityError) as ei:
        v.verify(pairs(1))
    assert ei.value.error_type == 'identity_invalid_json'
    v, _ = verifier(Resp(429, text=f'quota {KEY}'))
    with pytest.raises(liv.IdentityError) as ei:
        v.verify(pairs(1))
    assert ei.value.error_type == 'identity_rate_limited' and KEY not in str(ei.value)
    v, _ = verifier(requests.exceptions.ReadTimeout())
    with pytest.raises(liv.IdentityError) as ei:
        v.verify(pairs(1))
    assert ei.value.error_type == 'identity_timeout'


def test_input_limits():
    v, calls = verifier(Resp(200, payload([])))
    for bad in ([], pairs(8)):
        with pytest.raises(liv.IdentityError):
            v.verify(bad)
    assert calls == []


# ------------------------------------------------------------------ オーケストレーター統合（模擬）
class FakeVerifier:
    def __init__(self, judge=None, error=None):
        self.judge = judge or {}
        self.error = error
        self.calls = []

    def verify(self, pairs):
        self.calls.append(pairs)
        if self.error:
            raise self.error
        return {p['id']: (self.judge.get(p['id'], c.SAME), 'r') for p in pairs}, 1500, 0


def run(world, verifier_=None):
    with mock.patch.object(ai.requests, 'get', world.get):
        return ShopRecommendationOrchestrator(to.FakeRecommender(to.cands()), identity_verifier=verifier_).run(to.REQUEST)


@pytest.fixture(autouse=True)
def keys():
    with mock.patch.multiple(ai, GOOGLE_PLACES_API_KEY=to.PKEY, GOOGLE_GEOCODING_API_KEY=to.PKEY, HOTPEPPER_API_KEY='h'):
        yield


def test_off_by_default_identical_to_legacy():
    res = run(to.base_world(), None)
    assert res['metrics']['identity_enabled'] is False and res['metrics']['identity_calls'] == 0
    assert [x['place_id'] for x in res['cards']] == [x['place_id'] for x in res['legacy_cards']]


def test_same_only_with_reserves_and_single_call():
    fv = FakeVerifier({2: c.DIFFERENT, 4: c.UNCERTAIN})
    res = run(to.base_world(), fv)
    assert len(fv.calls) == 1 and len(fv.calls[0]) == 7                     # 1 検索 1 回・7 組
    assert [p['id'] for p in fv.calls[0]] == [1, 2, 3, 4, 5, 6, 7]
    assert [x['llm_name'] for x in res['cards']] == ['美鶏', '里葉亭', '焼鳥 さいとう', '野毛末広', '焼鳥 幸八']
    assert [x['llm_name'] for x in res['legacy_cards']] == to.NAMES[:5]      # A: 従来方式
    m = res['metrics']
    assert (m['identity_same'], m['identity_different'], m['identity_uncertain']) == (5, 1, 1)
    assert m['legacy_card_count'] == 5 and m['identity_card_count'] == 5 and m['identity_duration_ms'] == 1500
    assert m['rejected_counts_by_reason']['IDENTITY:not_same'] == 2
    narr = [n['name'] for n in res['narration']]
    assert narr == [x['llm_name'] for x in res['cards']]                     # 読み上げとカードは同じ店・同じ順
    v = {x['rank']: x for x in res['verifications']}
    assert v[2]['identity'] == c.DIFFERENT and v[4]['identity'] == c.UNCERTAIN


def test_not_same_never_backfilled():
    fv = FakeVerifier({i: c.DIFFERENT for i in range(1, 8)})
    res = run(to.base_world(), fv)
    assert res['status'] == c.EMPTY and res['cards'] == [] and res['metrics']['legacy_card_count'] == 5


def test_identity_error_is_error_without_cards():
    fv = FakeVerifier(error=liv.IdentityError('identity_count_mismatch', 'x'))
    res = run(to.base_world(), fv)
    assert res['status'] == c.ERROR and res['error_type'] == 'identity_count_mismatch' and res['cards'] == []
    assert res['metrics']['legacy_card_count'] == 5


def test_no_found_candidates_means_no_identity_call():
    fv = FakeVerifier()
    res = run(to.World(geocode={to.AREA: to.geo()}), fv)
    assert fv.calls == [] and res['metrics']['identity_calls'] == 0 and res['status'] == c.EMPTY


def test_build_from_env_flag_default_off(monkeypatch):
    monkeypatch.setenv('GEMINI_RECOMMEND_API_KEY', KEY)
    monkeypatch.delenv(c.IDENTITY_ENV_FLAG, raising=False)
    assert build_from_env().identity_verifier is None
    monkeypatch.setenv(c.IDENTITY_ENV_FLAG, 'on')
    assert build_from_env().identity_verifier is not None
