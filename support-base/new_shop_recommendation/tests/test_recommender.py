# -*- coding: utf-8 -*-
"""推薦 LLM クライアント（REST Interactions）のテスト。外部 API は呼ばない"""
import json
import os
import sys

import pytest
import requests

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from new_shop_recommendation import contracts as c  # noqa: E402
from new_shop_recommendation import recommender as rec  # noqa: E402

KEY = 'AQ.TESTRECOMMENDKEY0123456789abcdef'


class Resp:
    def __init__(self, status, payload=None, text=None):
        self.status_code = status
        self._payload = payload
        self.text = text if text is not None else json.dumps(payload, ensure_ascii=False)

    def json(self):
        if isinstance(self._payload, Exception):
            raise self._payload
        return self._payload


def cand(i, name=None):
    return {'rank': i, 'name': name or f'店{i}', 'area_hint': '横浜駅西口', 'specialty': 'つくね', 'reason': f'理由{i}'}


def ok_payload(cands, intent='useful', via='steps', extra_steps=()):
    text = json.dumps({'freshness_intent': intent, 'candidates': cands}, ensure_ascii=False)
    if via == 'output_text':
        return {'status': 'completed', 'output_text': text, 'usage': {'total_tokens': 10}}
    half = len(text) // 2
    return {'status': 'completed', 'steps': list(extra_steps) + [
        {'type': 'thought', 'summary': []},
        {'type': 'model_output', 'content': [{'type': 'text', 'text': text[:half]}, {'type': 'text', 'text': text[half:]}]}]}


class Recorder:
    def __init__(self, resp):
        self.resp = resp
        self.calls = []

    def __call__(self, url, json=None, headers=None, timeout=None):
        self.calls.append({'url': url, 'json': json, 'headers': headers, 'timeout': timeout})
        if isinstance(self.resp, BaseException):
            raise self.resp
        return self.resp


def client(resp):
    rec_ = Recorder(resp)
    return rec.RecommendationClient(KEY, http_post=rec_), rec_


def test_request_contract_no_tools_low_thinking_schema():
    cl, r = client(Resp(200, ok_payload([cand(i) for i in range(1, 8)])))
    out = cl.recommend('横浜で美味しい焼き鳥屋 予算6000円 2名')
    call = r.calls[0]
    body = call['json']
    assert call['url'] == 'https://generativelanguage.googleapis.com/v1beta/interactions'
    assert 'tools' not in body                                    # Google 検索なし
    assert body['model'] == 'gemini-3.8-flash'
    assert body['generation_config'] == {'thinking_level': 'low', 'max_output_tokens': 3072}
    assert body['response_format'] == {'type': 'text', 'mime_type': 'application/json',
                                       'schema': c.RECOMMENDATION_SCHEMA}
    assert body['stream'] is False and body['store'] is False
    assert '横浜で美味しい焼き鳥屋 予算6000円 2名' in body['input']   # ユーザー条件を削らない
    assert '最大7候補' in body['input'] and 'Google検索や外部ツールを利用せず' in body['input']
    # キーはヘッダーだけ（URL・本文に入れない）
    assert call['headers']['x-goog-api-key'] == KEY and KEY not in call['url'] and KEY not in json.dumps(body)
    assert call['headers']['Api-Revision'] == '2026-05-20'
    assert [x.name for x in out.candidates] == [f'店{i}' for i in range(1, 8)]
    assert out.google_search_calls == 0 and out.freshness_intent == 'useful'


def test_output_text_preferred_and_fewer_than_seven_ok():
    cl, _ = client(Resp(200, ok_payload([cand(1), cand(2), cand(3)], via='output_text')))
    out = cl.recommend('x')
    assert len(out.candidates) == 3


def test_search_calls_are_counted_if_present():
    cl, _ = client(Resp(200, ok_payload([cand(1)], extra_steps=[{'type': 'google_search_call', 'id': 'g'}])))
    assert cl.recommend('x').google_search_calls == 1


@pytest.mark.parametrize('payload_text,etype', [
    ('', 'invalid_output_empty'),
    ('{"freshness_intent": "useful", "candidates": [', 'invalid_output_json'),
    ('[1,2]', 'invalid_output_schema'),
    ('{"freshness_intent": "maybe", "candidates": []}', 'invalid_output_schema'),
    ('{"freshness_intent": "useful", "candidates": []}', 'invalid_output_count'),
])
def test_invalid_outputs(payload_text, etype):
    cl, _ = client(Resp(200, {'status': 'completed', 'output_text': payload_text}))
    with pytest.raises(c.RecommendationError) as ei:
        cl.recommend('x')
    assert ei.value.error_type == etype


def test_invalid_candidates():
    cases = [
        ([cand(i) for i in range(1, 9)], 'invalid_output_count'),
        ([cand(1), cand(3)], 'invalid_output_rank'),
        ([cand(1), cand(2, name='  ')], 'invalid_output_empty_name'),
        ([cand(1, name='焼鳥 地葉'), cand(2, name='焼鳥  地葉')], 'invalid_output_duplicate'),
        ([{**cand(1), 'rank': '1'}], 'invalid_output_schema'),
        ([{k: v for k, v in cand(1).items() if k != 'reason'}], 'invalid_output_schema'),
    ]
    for cands, etype in cases:
        cl, _ = client(Resp(200, ok_payload(cands)))
        with pytest.raises(c.RecommendationError) as ei:
            cl.recommend('x')
        assert ei.value.error_type == etype, (cands, ei.value.error_type)


@pytest.mark.parametrize('status,etype', [(429, 'rate_limited'), (503, 'unavailable'), (504, 'deadline_exceeded'),
                                          (500, 'upstream_error'), (403, 'auth_error'), (400, 'client_error')])
def test_http_errors_classified_and_key_redacted(status, etype):
    cl, _ = client(Resp(status, text=f'{{"error":"quota","echo":"{KEY}"}}'))
    with pytest.raises(c.RecommendationError) as ei:
        cl.recommend('x')
    assert ei.value.error_type == etype and ei.value.http_status == status
    assert KEY not in str(ei.value) and KEY not in ei.value.detail


def test_timeout_and_network_errors():
    cl, _ = client(requests.exceptions.ReadTimeout())
    with pytest.raises(c.RecommendationError) as ei:
        cl.recommend('x')
    assert ei.value.error_type == 'timeout'
    cl, _ = client(requests.exceptions.ConnectionError(f'https://x/?key={KEY}'))
    with pytest.raises(c.RecommendationError) as ei:
        cl.recommend('x')
    assert ei.value.error_type == 'network_error' and KEY not in str(ei.value)


def test_not_completed_status():
    cl, _ = client(Resp(200, {'status': 'incomplete', 'steps': []}))
    with pytest.raises(c.RecommendationError) as ei:
        cl.recommend('x')
    assert ei.value.error_type == 'interaction_not_completed'


def test_missing_key_is_config_error_not_fallback(monkeypatch):
    monkeypatch.setenv('GEMINI_API_KEY', 'AIzaOLDKEYSHOULDNOTBEUSED123456')
    with pytest.raises(c.ConfigError):
        rec.RecommendationClient('')
