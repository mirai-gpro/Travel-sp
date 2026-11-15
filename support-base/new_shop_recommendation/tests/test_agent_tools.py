# -*- coding: utf-8 -*-
"""Gate D1.7: Maps Experience Agent Tools（v1:searchText）+ グラウンディング選択 LLM（方式 D）のテスト（外部 API なし）"""
import json
import os
import sys
from unittest import mock

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

import api_integrations as ai  # noqa: E402
from new_shop_recommendation import agent_tools_places as at  # noqa: E402
from new_shop_recommendation import contracts as c  # noqa: E402
from new_shop_recommendation import llm_grounded_selector as gs  # noqa: E402
from new_shop_recommendation.llm_candidate_selector import SelectionError  # noqa: E402
from new_shop_recommendation.orchestrator import ShopRecommendationOrchestrator, build_from_env  # noqa: E402

import test_orchestrator as to  # noqa: E402

GKEY = 'AQ.TESTGROUNDEDKEY0123456789abcdef'
MKEY = 'AIzaTESTMAPSAGENTKEY0123456789abcd'
GEO_INFO = {'region': '神奈川県', 'country_code': 'JP', 'lat': 35.466, 'lng': 139.622}


@pytest.fixture(autouse=True)
def keys():
    with mock.patch.multiple(ai, GOOGLE_PLACES_API_KEY=to.PKEY, GOOGLE_GEOCODING_API_KEY=to.PKEY, HOTPEPPER_API_KEY='h'):
        yield


class Resp:
    def __init__(self, status, payload):
        self.status_code, self._p, self.text = status, payload, json.dumps(payload) if payload is not None else ''

    def json(self):
        return self._p


def at_place(pid):
    return {'place': f'places/{pid}', 'id': pid,
            'googleMapsLinks': {'placeUrl': f'https://maps.google.com/?cid={pid}'},
            'attribution': {'title': 'Google Maps', 'url': f'https://maps.google.com/?cid={pid}'}}


# ------------------------------------------------------------------ searchText の要求・応答
def test_search_text_request_contract():
    calls = []

    def post(url, json=None, headers=None, timeout=None):
        calls.append((url, json, headers))
        return Resp(200, {'summary': '[0] 焼鳥 美鶏 は…', 'places': [at_place('A1'), at_place('A2')]})
    res = at.search_text(MKEY, '美鶏', '', '横浜', GEO_INFO, http_post=post)
    url, body, headers = calls[0]
    assert url == 'https://mapstools.googleapis.com/v1:searchText' and MKEY not in url
    assert headers['X-Goog-Api-Key'] == MKEY
    assert body == {'textQuery': '美鶏 横浜 神奈川県', 'languageCode': 'ja', 'regionCode': 'JP', 'pageSize': 5,
                    'locationBias': {'circle': {'center': {'latitude': 35.466, 'longitude': 139.622}, 'radiusMeters': 3000}}}
    assert 'includeExtendedDetails' not in body                          # Pro SKU にしない
    assert res['status'] == 'OK' and res['summary'].startswith('[0]')
    assert res['places'][0] == {'place_id': 'A1', 'place_url': 'https://maps.google.com/?cid=A1',
                                'attribution': {'title': 'Google Maps', 'url': 'https://maps.google.com/?cid=A1'}}


def test_search_text_errors_and_zero():
    err = {'error': {'code': 403, 'status': 'PERMISSION_DENIED', 'details': [{'reason': 'SERVICE_DISABLED'}]}}
    r = at.search_text(MKEY, 'x', '', '横浜', None, http_post=lambda *a, **k: Resp(403, err))
    assert r['status'] == 'ERROR:HTTP403:PERMISSION_DENIED:SERVICE_DISABLED' and r['places'] == []
    z = at.search_text(MKEY, 'x', '', '横浜', None, http_post=lambda *a, **k: Resp(200, {'summary': 'なし'}))
    assert z['status'] == 'ZERO_RESULTS' and 'locationBias' not in at.build_body('x', None)


def det_world(**over):
    w = to.World()
    base = {'status': 'OK', 'result': {'name': '焼鳥 美鶏', 'rating': 4.3, 'user_ratings_total': 210,
                                       'formatted_address': '日本、神奈川県横浜市中区…',
                                       'address_components': [{'short_name': 'JP', 'types': ['country']}],
                                       'formatted_phone_number': '045-111-2222',
                                       'geometry': {'location': {'lat': 35.4, 'lng': 139.6}}}}
    base['result'].update(over)
    w.details['A1'] = base
    return w


def test_details_for_card_keeps_attribution_and_place_url():
    w = det_world()
    p = at.parse_response({'places': [at_place('A1')]})['places'][0]
    d, why = at.details_for_card(p, GEO_INFO, http_get=w.get)
    assert why == 'ok' and d['name'] == '焼鳥 美鶏' and d['maps_url'] == 'https://maps.google.com/?cid=A1'
    assert d['maps_attribution'] == {'title': 'Google Maps', 'url': 'https://maps.google.com/?cid=A1'}
    params = dict(w.calls[0][1])
    assert params['place_id'] == 'A1' and 'name' in params['fields'] and 'business_status' in params['fields']


@pytest.mark.parametrize('over,reason', [
    ({'address_components': [{'short_name': 'KR', 'types': ['country']}]}, 'country_mismatch'),
    ({'business_status': 'CLOSED_PERMANENTLY'}, 'closed'),
])
def test_details_for_card_rejects(over, reason):
    d, why = at.details_for_card(at.parse_response({'places': [at_place('A1')]})['places'][0], GEO_INFO,
                                 http_get=det_world(**over).get)
    assert d is None and why == reason


# ------------------------------------------------------------------ グラウンディング選択 LLM
def grecs():
    return [{'rank': 1, 'recommended_name': 'A', 'recommended_area': 'x', 'maps_summary': '[0] a [1] b',
             'maps_places': [{'candidate_id': 1, 'citation': 0}, {'candidate_id': 2, 'citation': 1}]},
            {'rank': 2, 'recommended_name': 'B', 'recommended_area': 'x', 'maps_summary': '[0] c',
             'maps_places': [{'candidate_id': 3, 'citation': 0}]}]


def gselector(results):
    calls = []

    def post(url, json=None, headers=None, timeout=None):
        calls.append(json)
        t = __import__('json').dumps({'results': results}, ensure_ascii=False)
        return Resp(200, {'status': 'completed', 'usage': {'total_tokens': 10},
                          'steps': [{'type': 'model_output', 'content': [{'type': 'text', 'text': t}]}]})
    return gs.LlmGroundedSelector(GKEY, http_post=post), calls


def test_grounded_selector_contract():
    s, calls = gselector([{'rank': 1, 'selected_candidate_id': 2, 'judgment': 'SAME', 'reason': 'r'},
                          {'rank': 2, 'selected_candidate_id': None, 'judgment': 'NOT_FOUND', 'reason': 'r'}])
    out, _ms, searches = s.select(grecs())
    assert out == {1: (2, 'r'), 2: (None, 'r')} and searches == 0 and len(calls) == 1
    b = calls[0]
    assert 'tools' not in b and b['store'] is False and b['generation_config']['thinking_level'] == 'low'
    assert '"maps_summary": "[0] a [1] b"' in b['input'] and 'citation' in b['input']
    assert s.last_usage == {'total_tokens': 10}


def test_grounded_selector_rejects_other_store_id():
    s, _ = gselector([{'rank': 1, 'selected_candidate_id': 3, 'judgment': 'SAME', 'reason': 'r'},
                      {'rank': 2, 'selected_candidate_id': 3, 'judgment': 'SAME', 'reason': 'r'}])
    with pytest.raises(SelectionError) as ei:
        s.select(grecs())
    assert ei.value.error_type == 'selection_unknown_candidate'


# ------------------------------------------------------------------ 方式 D（オーケストレーター）
class FakeGrounded:
    def __init__(self, choose, error=None):
        self.choose, self.error, self.calls = choose, error, []

    def select(self, recs):
        self.calls.append(recs)
        if self.error:
            raise self.error
        return {r['rank']: (self.choose(r), 'r') for r in recs}, 3000, 0


def maps_world(n_places=5, empty_ranks=()):
    """searchText（POST）と Place Details（GET）の模擬。rank i の正解は places の 3 番目（P{i}）"""
    w = to.base_world()
    responses = {}
    for i, n in enumerate(to.NAMES, 1):
        if i in empty_ranks:
            responses[n] = {'summary': '該当なし'}
            continue
        pids = [f'X{i}a', f'X{i}b', f'P{i}', f'X{i}c', f'X{i}d'][:n_places]
        responses[n] = {'summary': f'[2] G_{n}', 'places': [at_place(p) for p in pids]}
        for p in pids:
            w.details[p] = {'status': 'OK', 'result': {'name': f'N_{p}', 'rating': 4.0,
                                                     'address_components': [{'short_name': 'JP', 'types': ['country']}]}}
    posts = []

    def post(url, json=None, headers=None, timeout=None):
        posts.append(json)
        name = next(n for n in to.NAMES if json['textQuery'].startswith(n + ' '))
        return Resp(200, responses[name])
    return w, post, posts


def run_d(world, post, fsel):
    with mock.patch.object(ai.requests, 'get', world.get), mock.patch.object(at.requests, 'post', post):
        return ShopRecommendationOrchestrator(to.FakeRecommender(to.cands()), grounded_selector=fsel,
                                              maps_agent_key=MKEY).run(to.REQUEST)


def third(rec):
    return rec['maps_places'][2]['candidate_id'] if len(rec['maps_places']) >= 3 else None


def test_d_selects_position_3_keeps_order_attribution_and_details_only_for_chosen():
    w, post, posts = maps_world()
    fs = FakeGrounded(third)
    res = run_d(w, post, fs)
    assert len(posts) == 7 and len(fs.calls) == 1 and len(fs.calls[0]) == 7
    assert [cd['candidate_id'] for r in fs.calls[0] for cd in r['maps_places']] == list(range(1, 36))
    assert all(r['maps_summary'].startswith('[2] G_') for r in fs.calls[0])
    assert [x['place_id'] for x in res['cards']] == ['P1', 'P2', 'P3', 'P4', 'P5']
    assert [x['llm_name'] for x in res['cards']] == to.NAMES[:5]
    assert res['cards'][0]['maps_attribution'] == {'title': 'Google Maps', 'url': 'https://maps.google.com/?cid=P1'}
    assert res['cards'][0]['maps_url'] == 'https://maps.google.com/?cid=P1'
    assert len([x for x in w.calls if x[0] == to.DET]) == 7
    assert not [x for x in w.calls if x[0] == to.TS]                       # Legacy Text Search は使わない
    m = res['metrics']
    assert m['selection_positions'] == {3: 7} and m['maps_agent_calls'] == 7 and m['details_calls'] == 7
    assert res['verifications'][0]['selected_position'] == 3


def test_d_no_fill_when_missing_and_not_found():
    w, post, _ = maps_world(empty_ranks=(1, 2))
    fs = FakeGrounded(lambda r: None if r['rank'] == 3 else third(r))
    res = run_d(w, post, fs)
    assert [r['rank'] for r in fs.calls[0]] == [3, 4, 5, 6, 7]               # 候補なしは選択 LLM に送らない
    assert [x['llm_name'] for x in res['cards']] == to.NAMES[3:7]            # 穴埋めしない（4 件）
    assert res['status'] == c.PARTIAL and res['metrics']['selection_not_found'] == 1
    assert res['verifications'][0]['reason'] == 'no_maps_candidates'


def test_d_duplicate_place_dropped_and_error():
    w, post, _ = maps_world()
    res = run_d(w, post, FakeGrounded(lambda r: r['maps_places'][0]['candidate_id'] if r['rank'] in (1, 2)
                                      else third(r)))
    assert [x['place_id'] for x in res['cards']][:2] == ['X1a', 'X2a']
    w2, post2, _ = maps_world()
    err = run_d(w2, post2, FakeGrounded(third, error=SelectionError('selection_unknown_candidate', 'x')))
    assert err['status'] == c.ERROR and err['cards'] == [] and not [x for x in w2.calls if x[0] == to.DET]


def test_build_from_env_agent_tools_flag(monkeypatch):
    monkeypatch.setenv('GEMINI_RECOMMEND_API_KEY', GKEY)
    monkeypatch.delenv(c.AGENT_TOOLS_ENV_FLAG, raising=False)
    assert build_from_env().grounded_selector is None
    monkeypatch.setenv(c.AGENT_TOOLS_ENV_FLAG, 'on')
    monkeypatch.delenv('MAPS_AGENT_TOOLS_API_KEY', raising=False)
    with pytest.raises(c.ConfigError):
        build_from_env()
    monkeypatch.setenv('MAPS_AGENT_TOOLS_API_KEY', MKEY)
    assert build_from_env().grounded_selector is not None
