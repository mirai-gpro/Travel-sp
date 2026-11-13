# -*- coding: utf-8 -*-
"""
オーケストレーターのテスト（外部 API なし）

中心: 33秒版本番（8d30e554）の enrich_shops_with_photos と、新エンジンの Places 照合が
同じ模擬 API 応答に対して同じ店舗を同じ順で採用し、同じ店舗情報をカードに反映すること。
（新エンジンは api_integrations の関数をそのまま呼ぶ。写真 URL＝キー入りだけは反映しない）
"""
import copy
import json
import logging
import os
import random
import sys
import threading
import time
from unittest import mock

import pytest
import requests

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

import api_integrations as ai  # noqa: E402
from new_shop_recommendation import contracts as c  # noqa: E402
from new_shop_recommendation.orchestrator import ShopRecommendationOrchestrator  # noqa: E402
from new_shop_recommendation.redact import register_secret  # noqa: E402

PKEY = 'AIzaTESTPLACESKEY0123456789abcdefg'
GEO = 'https://maps.googleapis.com/maps/api/geocode/json'
TS = 'https://maps.googleapis.com/maps/api/place/textsearch/json'
DET = 'https://maps.googleapis.com/maps/api/place/details/json'
HP = 'http://webservice.recruit.co.jp/hotpepper/gourmet/v1/'


class R:
    def __init__(self, payload, status=200):
        self.status_code = status
        self._p = payload
        self.text = ''

    def json(self):
        if isinstance(self._p, BaseException):
            raise self._p
        return self._p


class World:
    """旧版 API（Geocoding / Text Search / Details / Hot Pepper）の決定的な模擬。応答は要求内容だけで決まる"""

    def __init__(self, geocode=None, places=None, details=None, delay=None):
        self.geocode = geocode or {}
        self.places = places or {}
        self.details = details or {}
        self.delay = delay or (lambda kind, key: 0)
        self.calls = []
        self.lock = threading.Lock()

    def get(self, url, params=None, headers=None, timeout=None):
        with self.lock:
            self.calls.append((url, tuple(sorted((params or {}).items())), time.monotonic()))
        if url == GEO:
            v = self.geocode.get(params['address'], {'status': 'ZERO_RESULTS', 'results': []})
            time.sleep(self.delay('geo', params['address']))
        elif url == TS:
            v = self.places.get(params['query'], {'status': 'ZERO_RESULTS', 'results': []})
            time.sleep(self.delay('ts', params['query']))
        elif url == DET:
            v = self.details.get(params['place_id'], {'status': 'NOT_FOUND'})
            time.sleep(self.delay('det', params['place_id']))
        elif url == HP:
            v = {'results': {'shop': []}}
        else:
            raise AssertionError(url)
        if isinstance(v, BaseException) and not isinstance(v, ValueError):
            raise v
        return R(v)

    def places_calls(self):
        return sorted((u, p) for u, p, _t in self.calls if u in (TS, DET))


def geo(region='神奈川県', cc='JP', lat=35.466, lng=139.622):
    return {'status': 'OK', 'results': [{'address_components': [
        {'long_name': '日本', 'short_name': cc, 'types': ['country']},
        {'long_name': region, 'short_name': region, 'types': ['administrative_area_level_1']}],
        'formatted_address': region, 'geometry': {'location': {'lat': lat, 'lng': lng}}}]}


def place(pid, name, status='OPERATIONAL', rating=4.2, total=100):
    p = {'place_id': pid, 'name': name, 'rating': rating, 'user_ratings_total': total,
         'formatted_address': f'神奈川県横浜市 {name}', 'geometry': {'location': {'lat': 35.4, 'lng': 139.6}},
         'photos': [{'photo_reference': f'ref_{pid}'}]}
    if status:
        p['business_status'] = status
    return p


def details(cc='JP'):
    return {'status': 'OK', 'result': {'formatted_phone_number': '045-000-0000',
                                       'address_components': [{'short_name': cc, 'types': ['country']}]}}


def q(name, area, region='神奈川県'):
    return f'{name} {area} {region}'.strip()


REQUEST = '横浜で美味しい焼き鳥屋'
AREA = '横浜'   # extract_area_from_text('横浜で美味しい焼き鳥屋') → '横浜'
NAMES = ['美鶏', '地葉', '里葉亭', '炭火焼鳥 おがわ', '焼鳥 さいとう', '野毛末広', '焼鳥 幸八']


class FakeRecommender:
    def __init__(self, cands, error=None):
        self.cands, self.error = cands, error
        self.finished_at = None

    def recommend(self, user_request):
        self.finished_at = time.monotonic()
        if self.error:
            raise self.error
        return c.LlmOutput('not_needed', self.cands, 1000, 0, 'completed')


def cands(names=NAMES, area_hint=''):
    return [c.Candidate(i, n, area_hint, f'{n}の名物', f'{n}の理由') for i, n in enumerate(names, 1)]


@pytest.fixture(autouse=True)
def keys():
    with mock.patch.multiple(ai, GOOGLE_PLACES_API_KEY=PKEY, GOOGLE_GEOCODING_API_KEY=PKEY, HOTPEPPER_API_KEY='h'):
        yield


def run_new(world, cs):
    with mock.patch.object(ai.requests, 'get', world.get):
        rec = FakeRecommender(cs)
        res = ShopRecommendationOrchestrator(rec, credential_kind='AQ').run(REQUEST)
    return res, rec


def run_old(world, cs):
    """33秒版: callback で area = extract_area_from_text(user_request) → enrich_shops_with_photos(raw_shops, area)"""
    shops = [{'name': x.name, 'area': x.area_hint} for x in cs]
    with mock.patch.object(ai.requests, 'get', world.get):
        area = ai.extract_area_from_text(REQUEST, 'ja')
        out = ai.enrich_shops_with_photos(copy.deepcopy(shops), area, 'ja')
    return out


PLACE_FIELDS = ('name', 'rating', 'reviewCount', 'location', 'maps_url', 'phone', 'place_id')


def assert_same_as_33s(world, cs):
    old = run_old(world, cs)
    old_calls = world.places_calls()
    world.calls = []
    new, _ = run_new(world, cs)
    new_calls = world.places_calls()
    exp = old[:c.DISPLAY_COUNT]
    got = new['cards']
    assert [x.get('place_id') for x in got] == [x.get('place_id') for x in exp]
    for g, o in zip(got, exp):
        for k in PLACE_FIELDS:
            assert g.get(k) == o.get(k), (k, g.get(k), o.get(k))
        assert 'image' not in g                       # キー入り写真 URL は出さない（意図した差分）
    # Text Search / Details の要求内容・回数が 33秒版と同一
    assert [x[:2] for x in new_calls] == [x[:2] for x in old_calls]
    return old, new


def base_world(names=NAMES, area_hint=''):
    places = {q(n, area_hint or AREA): {'status': 'OK', 'results': [place(f'P{i}', f'G_{n}')]}
              for i, n in enumerate(names, 1)}
    return World(geocode={AREA: geo()}, places=places, details={f'P{i}': details() for i in range(1, 8)})


# ------------------------------------------------------------------ 33秒版との一致
def test_same_as_33s_all_found_reverse_latency_top5():
    w = base_world()
    w.delay = lambda kind, key: (0.2 - 0.02 * int(key[1:])) if kind == 'det' else 0   # 上位ほど遅い
    old, new = assert_same_as_33s(w, cands())
    assert new['status'] == c.COMPLETE and len(old) == 7 and len(new['cards']) == 5
    assert [x['name'] for x in new['cards']] == [f'G_{n}' for n in NAMES[:5]]    # 店名は Places 名で上書き（33秒版と同じ）


def test_same_as_33s_with_not_found_closed_country_duplicate_timeout():
    w = base_world()
    del w.places[q('地葉', AREA)]                                                        # 結果なし
    w.places[q('里葉亭', AREA)] = {'status': 'OK', 'results': [place('PC', 'x', status='CLOSED_PERMANENTLY'),
                                                               place('P3', 'G_里葉亭')]}  # 先頭は閉店 → 次の営業中
    w.details['P4'] = details('KR')                                                     # 国コード不一致
    w.places[q('焼鳥 さいとう', AREA)] = {'status': 'OK', 'results': [place('P1', 'G_美鶏')]}  # 重複 place_id
    w.places[q('野毛末広', AREA)] = requests.exceptions.Timeout('t')
    old, new = assert_same_as_33s(w, cands())
    assert [x['place_id'] for x in new['cards']] == ['P1', 'P3', 'P7']
    assert new['status'] == c.PARTIAL


def test_same_as_33s_uses_llm_area_hint_and_no_region_when_geocode_fails():
    w = base_world(area_hint='関内')
    old, new = assert_same_as_33s(w, cands(area_hint='関内'))
    w2 = World(geocode={}, places={f'{n} {AREA}': {'status': 'OK', 'results': [place(f'P{i}', n)]}
                                   for i, n in enumerate(NAMES, 1)},
               details={f'P{i}': details() for i in range(1, 8)})
    assert_same_as_33s(w2, cands())


def test_same_as_33s_random_scenarios():
    rnd = random.Random(1113)
    for case in range(30):
        names = [f'R{case}_{i}' for i in range(rnd.randint(1, 7))]
        places, det = {}, {}
        for nm in names:
            k = rnd.random()
            if k < 0.2:
                continue
            pid = f'X{case}_{rnd.randint(0, max(1, len(names) - 2))}'
            res = [place(pid + 'c', 'closed', status='CLOSED_PERMANENTLY')] if rnd.random() < 0.3 else []
            res.append(place(pid, f'G_{pid}', status=rnd.choice(['OPERATIONAL', 'OPERATIONAL', None,
                                                                 'CLOSED_TEMPORARILY'])))
            places[q(nm, AREA)] = {'status': 'OK', 'results': res}
            det[pid] = rnd.choice([details('JP'), details('JP'), details('US'), {'status': 'NOT_FOUND'}])
        w = World(geocode={AREA: geo()}, places=places, details=det,
                  delay=lambda kind, key, _r=rnd.random(): (_r * 0.01))
        assert_same_as_33s(w, cands(names))


# ------------------------------------------------------------------ 順序・並列・失敗
def test_places_start_after_llm_and_candidates_in_parallel():
    w = base_world()
    w.delay = lambda kind, key: 0.15 if kind == 'ts' else 0
    res, rec = run_new(w, cands())
    ts_starts = [t for u, _p, t in w.calls if u == TS]
    first_any = min(t for _u, _p, t in w.calls)
    assert first_any >= rec.finished_at                      # LLM 完了前に Places/Geocoding を呼ばない
    assert len(ts_starts) == 7 and max(ts_starts) - min(ts_starts) < 0.1   # 7 件同時に開始
    assert res['metrics']['area'] == AREA


def test_llm_error_no_places_calls():
    w = base_world()
    for err, st in [(c.RecommendationError('rate_limited', 'x'), c.ERROR), (c.RecommendationError('timeout', ''), c.TIMED_OUT)]:
        with mock.patch.object(ai.requests, 'get', w.get):
            res = ShopRecommendationOrchestrator(FakeRecommender([], error=err)).run(REQUEST)
        assert res['status'] == st and res['cards'] == [] and w.calls == []


def test_empty_when_nothing_found_no_padding():
    w = World(geocode={AREA: geo()})
    res, _ = run_new(w, cands())
    assert res['status'] == c.EMPTY and res['cards'] == [] and res['narration'] == []
    assert res['metrics']['rejected_counts_by_reason'] == {'NOT_VERIFIED:places_not_found': 7}


def test_cards_and_narration_same_order_narration_llm_only():
    res, _ = run_new(base_world(), cands())
    assert [x['llm_name'] for x in res['cards']] == [n['name'] for n in res['narration']] == NAMES[:5]
    blob = json.dumps(res['narration'], ensure_ascii=False)
    assert 'G_' not in blob and 'place_id' not in blob and '横浜市' not in blob


def test_no_key_in_result_or_log(caplog):
    register_secret(PKEY)
    with caplog.at_level(logging.INFO):
        res, _ = run_new(base_world(), cands())
    blob = json.dumps(res, ensure_ascii=False)
    assert PKEY not in blob and 'photo_reference' not in blob
    assert '[NewShopRec]' in caplog.text and PKEY not in caplog.records[-1].getMessage()
    m = res['metrics']
    assert m['model_id'] == 'gemini-3.8-flash' and m['thinking_level'] == 'low' and m['google_search_calls'] == 0
