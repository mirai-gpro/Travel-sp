# -*- coding: utf-8 -*-
"""Gate D1.6: Places 複数候補取得・候補選択 LLM・方式 C のテスト（外部 API なし）"""
import json
import os
import sys
from unittest import mock

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

import api_integrations as ai  # noqa: E402
from new_shop_recommendation import contracts as c  # noqa: E402
from new_shop_recommendation import legacy_places as lp  # noqa: E402
from new_shop_recommendation import llm_candidate_selector as sel  # noqa: E402
from new_shop_recommendation.orchestrator import ShopRecommendationOrchestrator, build_from_env  # noqa: E402

import test_orchestrator as to  # noqa: E402

KEY = 'AQ.TESTSELECTORKEY0123456789abcdef'


@pytest.fixture(autouse=True)
def keys():
    with mock.patch.multiple(ai, GOOGLE_PLACES_API_KEY=to.PKEY, GOOGLE_GEOCODING_API_KEY=to.PKEY, HOTPEPPER_API_KEY='h'):
        yield


def multi_world():
    """各店の検索結果に 5 件以上（閉店混在）を返す World"""
    w = to.base_world()
    for i, n in enumerate(to.NAMES, 1):
        w.places[to.q(n, to.AREA)] = {'status': 'OK', 'results': [
            to.place(f'X{i}a', f'別店{i}a'),
            to.place(f'X{i}c', f'閉店{i}', status='CLOSED_PERMANENTLY'),
            to.place(f'P{i}', f'G_{n}'),
            to.place(f'X{i}b', f'別店{i}b'),
            to.place(f'X{i}d', f'別店{i}d', status=None),
            to.place(f'X{i}e', f'別店{i}e'),
            to.place(f'X{i}f', f'別店{i}f')]}
        for pid in (f'X{i}a', f'X{i}b', f'X{i}d', f'X{i}e', f'X{i}f'):
            w.details[pid] = to.details()
    return w


# ------------------------------------------------------------------ 33秒版との互換性
def test_candidates_use_same_textsearch_request_as_search_place_and_top1_equals_search_place():
    w = to.base_world()
    geo = None
    with mock.patch.object(ai.requests, 'get', w.get):
        geo = ai.get_region_from_area(to.AREA, 'ja')
        w.calls = []
        old = ai.search_place('美鶏', to.AREA, geo, 'ja')
        old_ts = [x[:2] for x in w.calls if x[0] == to.TS]
        w.calls = []
        cands, st = lp.search_place_candidates('美鶏', '', to.AREA, geo, 'ja')
        new_ts = [x[:2] for x in w.calls if x[0] == to.TS]
        assert new_ts == old_ts and len(new_ts) == 1                 # 同じ要求を 1 回だけ
        assert not [x for x in w.calls if x[0] == to.DET]           # 候補取得では Details を呼ばない
        top1 = lp.fetch_selected_details(cands[0], geo, 'ja')
    old.pop('photo_url')                                             # キー入り写真 URL は意図的に作らない
    assert top1 == old and st == 'OK'


def test_candidates_order_limit_and_closed_excluded():
    w = multi_world()
    with mock.patch.object(ai.requests, 'get', w.get):
        geo = ai.get_region_from_area(to.AREA, 'ja')
        cands, st = lp.search_place_candidates('美鶏', '', to.AREA, geo, 'ja')
        none, st0 = lp.search_place_candidates('存在しない', '', to.AREA, geo, 'ja')
    assert [x['place_id'] for x in cands] == ['X1a', 'P1', 'X1b', 'X1d', 'X1e']   # 閉店除外・順位順・最大 5
    assert none == [] and st0 == 'ZERO_RESULTS'


def test_country_mismatch_rejected_after_selection():
    w = to.base_world()
    w.details['P1'] = to.details('KR')
    with mock.patch.object(ai.requests, 'get', w.get):
        geo = ai.get_region_from_area(to.AREA, 'ja')
        cands, _ = lp.search_place_candidates('美鶏', '', to.AREA, geo, 'ja')
        assert lp.fetch_selected_details(cands[0], geo, 'ja') is None


# ------------------------------------------------------------------ 選択 LLM の契約
def recs():
    return [{'rank': 1, 'recommended_name': 'A', 'recommended_area': 'x',
             'places_candidates': [{'candidate_id': 1, 'name': 'a1', 'area': 'x'}, {'candidate_id': 2, 'name': 'a2', 'area': 'x'}]},
            {'rank': 2, 'recommended_name': 'B', 'recommended_area': 'x',
             'places_candidates': [{'candidate_id': 3, 'name': 'b1', 'area': 'x'}]}]


class Resp:
    def __init__(self, status, payload=None, text=''):
        self.status_code, self._p, self.text = status, payload, text

    def json(self):
        return self._p


def selector(results):
    calls = []

    def post(url, json=None, headers=None, timeout=None):
        calls.append(json)
        t = __import__('json').dumps({'results': results}, ensure_ascii=False)
        return Resp(200, {'status': 'completed', 'steps': [{'type': 'model_output', 'content': [{'type': 'text', 'text': t}]}]})
    return sel.LlmCandidateSelector(KEY, http_post=post), calls


def test_selector_request_contract_and_null():
    s, calls = selector([{'rank': 1, 'selected_candidate_id': 2, 'judgment': 'SAME', 'reason': 'r'},
                         {'rank': 2, 'selected_candidate_id': None, 'judgment': 'NOT_FOUND', 'reason': 'r'}])
    out, dur, searches = s.select(recs())
    assert out == {1: (2, 'r'), 2: (None, 'r')} and len(calls) == 1 and searches == 0
    b = calls[0]
    assert 'tools' not in b and b['model'] == 'gemini-3.8-flash' and b['generation_config']['thinking_level'] == 'low'
    assert b['response_format']['schema']['properties']['results']['items']['properties']['selected_candidate_id'] == \
        {'type': ['integer', 'null']}
    assert '検索順位は同一性の保証ではない' in b['input'] and '候補リスト外の店舗を作成・推薦しない' in b['input']


@pytest.mark.parametrize('results,etype', [
    ([{'rank': 1, 'selected_candidate_id': 3, 'judgment': 'SAME', 'reason': 'r'},           # 他店舗の候補 ID
      {'rank': 2, 'selected_candidate_id': 3, 'judgment': 'SAME', 'reason': 'r'}], 'selection_unknown_candidate'),
    ([{'rank': 1, 'selected_candidate_id': 99, 'judgment': 'SAME', 'reason': 'r'},          # 架空の ID
      {'rank': 2, 'selected_candidate_id': 3, 'judgment': 'SAME', 'reason': 'r'}], 'selection_unknown_candidate'),
    ([{'rank': 1, 'selected_candidate_id': None, 'judgment': 'SAME', 'reason': 'r'},
      {'rank': 2, 'selected_candidate_id': 3, 'judgment': 'SAME', 'reason': 'r'}], 'selection_inconsistent'),
    ([{'rank': 1, 'selected_candidate_id': 1, 'judgment': 'SAME', 'reason': 'r'}], 'selection_count_mismatch'),
    ([{'rank': 1, 'selected_candidate_id': 1, 'judgment': 'SAME', 'reason': 'r'},
      {'rank': 1, 'selected_candidate_id': 2, 'judgment': 'SAME', 'reason': 'r'}], 'selection_rank_duplicate'),
    ([{'rank': 1, 'selected_candidate_id': 1, 'judgment': 'SAME', 'reason': 'r'},
      {'rank': 9, 'selected_candidate_id': 3, 'judgment': 'SAME', 'reason': 'r'}], 'selection_rank_mismatch'),
])
def test_selector_validation_errors(results, etype):
    s, _ = selector(results)
    with pytest.raises(sel.SelectionError) as ei:
        s.select(recs())
    assert ei.value.error_type == etype


# ------------------------------------------------------------------ 方式 C（オーケストレーター）
class FakeSelector:
    def __init__(self, choose=None, error=None):
        self.choose = choose or (lambda rec: rec['places_candidates'][0]['candidate_id'])
        self.error = error
        self.calls = []

    def select(self, recommendations):
        self.calls.append(recommendations)
        if self.error:
            raise self.error
        return {r['rank']: (self.choose(r), 'r') for r in recommendations}, 2000, 0


def run_c(world, fsel):
    with mock.patch.object(ai.requests, 'get', world.get):
        return ShopRecommendationOrchestrator(to.FakeRecommender(to.cands()), candidate_selector=fsel).run(to.REQUEST)


def pick_name(prefix):
    def f(rec):
        for cd in rec['places_candidates']:
            if cd['name'].startswith(prefix):
                return cd['candidate_id']
        return None
    return f


def test_selects_correct_candidate_at_position_3_and_details_only_for_chosen():
    w = multi_world()
    fs = FakeSelector(pick_name('G_'))
    res = run_c(w, fs)
    assert len(fs.calls) == 1 and len(fs.calls[0]) == 7 and all(len(r['places_candidates']) == 5 for r in fs.calls[0])
    ids = [cd['candidate_id'] for r in fs.calls[0] for cd in r['places_candidates']]
    assert ids == list(range(1, 36))                                          # 検索内で一意
    assert [x['place_id'] for x in res['cards']] == ['P1', 'P2', 'P3', 'P4', 'P5']
    assert [x['llm_name'] for x in res['cards']] == to.NAMES[:5]              # 推薦順位を維持
    det_calls = [x for x in w.calls if x[0] == to.DET]
    assert len(det_calls) == 7                                                # 選ばれた 7 店舗だけ
    m = res['metrics']
    assert m['selection_calls'] == 1 and m['selection_positions'] == {2: 7} and m['places_candidates_total'] == 35
    v1 = res['verifications'][0]
    assert v1['top1_name'] == '別店1a' and v1['selected_position'] == 2
    assert [n['name'] for n in res['narration']] == to.NAMES[:5]


def test_not_found_and_duplicate_place_id_and_order():
    w = multi_world()
    choose = {1: '別店1a', 2: None, 4: '別店1a'}                               # rank1 と rank4 が同じ place を選ぶ

    def f(rec):
        p = choose.get(rec['rank'], 'G_')
        return None if p is None else pick_name(p)(rec)
    w.places[to.q(to.NAMES[3], to.AREA)]['results'][0] = to.place('X1a', '別店1a')   # rank4 の 1 位 = rank1 の候補と同じ place
    fs = FakeSelector(f)
    res = run_c(w, fs)
    # rank2 は該当なし、rank4 は rank1 と同じ place_id → 後順位を不採用。順位は維持
    assert [x['llm_name'] for x in res['cards']] == ['美鶏', '里葉亭', '焼鳥 さいとう', '野毛末広', '焼鳥 幸八']
    assert res['cards'][0]['place_id'] == 'X1a'
    assert res['metrics']['selection_not_found'] == 1
    assert res['verifications'][1]['selected_position'] is None and res['verifications'][1]['reason'] == 'selection_not_found'
    assert res['verifications'][3]['status'] != c.VERIFIED or 'X1a' not in [x['place_id'] for x in res['cards'][1:]]


def test_first_rank_not_found_has_no_position():
    w = multi_world()
    res = run_c(w, FakeSelector(lambda rec: None if rec['rank'] == 1 else pick_name('G_')(rec)))
    assert res['verifications'][0]['selected_position'] is None
    assert [x['place_id'] for x in res['cards']] == ['P2', 'P3', 'P4', 'P5', 'P6']


def test_selection_error_is_error_without_cards_and_no_details():
    w = multi_world()
    res = run_c(w, FakeSelector(error=sel.SelectionError('selection_unknown_candidate', 'x')))
    assert res['status'] == c.ERROR and res['error_type'] == 'selection_unknown_candidate' and res['cards'] == []
    assert not [x for x in w.calls if x[0] == to.DET]


def test_no_candidates_no_selector_call():
    fs = FakeSelector()
    res = run_c(to.World(geocode={to.AREA: to.geo()}), fs)
    assert fs.calls == [] and res['status'] == c.EMPTY and res['metrics']['selection_calls'] == 0


def test_build_from_env_selection_flag_default_off(monkeypatch):
    monkeypatch.setenv('GEMINI_RECOMMEND_API_KEY', KEY)
    monkeypatch.delenv(c.SELECTION_ENV_FLAG, raising=False)
    assert build_from_env().candidate_selector is None
    monkeypatch.setenv(c.SELECTION_ENV_FLAG, 'on')
    assert build_from_env().candidate_selector is not None
