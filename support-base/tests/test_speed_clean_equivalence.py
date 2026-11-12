# -*- coding: utf-8 -*-
"""
speed-clean 同等性テスト（段階1: ローカル／モック）

旧版 enrich_shops_with_photos（33秒版 8d30e55 と同一）と、
新版 enrich_shops_core_parallel + run_shop_link_jobs（後送りリンクをマージ）を、
同一の raw_shops と同一のモック外部 API 応答で実行し、以下が一致することを確認する。
  - 採用 place_id・順序・店名（Places 名での上書き含む）・カード表示データの全フィールド
  - 最終的な外部リンク（hotpepper_url / tabelog_url / gnavi_url / tripadvisor_*）
  - 外部 API に送ったリクエスト（URL・パラメータ）の集合（回数を含む）
  - 全店照合失敗時に enriched が空になり、raw_shops が無変更であること（元候補フォールバックの前提）
並列化で到着順が逆転するよう、応答遅延をランダム／逆順に変えて複数回実行する。

実行: cd support-base && python -m pytest -q tests/test_speed_clean_equivalence.py
"""
import copy
import json
import os
import random
import subprocess
import sys
import threading
import time
import urllib.parse
from collections import Counter
from unittest import mock

import pytest
import requests

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

import api_integrations as ai  # noqa: E402

BASE_SHA = '8d30e554f004957996a871b79b2c0b177a5e3e47'

GEOCODE_URL = 'https://maps.googleapis.com/maps/api/geocode/json'
TEXTSEARCH_URL = 'https://maps.googleapis.com/maps/api/place/textsearch/json'
DETAILS_URL = 'https://maps.googleapis.com/maps/api/place/details/json'
HOTPEPPER_URL = 'http://webservice.recruit.co.jp/hotpepper/gourmet/v1/'
TA_SEARCH_URL = 'https://api.content.tripadvisor.com/api/v1/location/search'
TA_DETAILS_PREFIX = 'https://api.content.tripadvisor.com/api/v1/location/'


class FakeResponse:
    def __init__(self, payload, status_code=200):
        self._payload = payload
        self.status_code = status_code
        self.text = json.dumps(payload, ensure_ascii=False) if not isinstance(payload, Exception) else ''

    def json(self):
        if isinstance(self._payload, Exception):
            raise self._payload
        return self._payload


class FakeWorld:
    """
    外部 API の決定的モック。応答はリクエスト内容だけで決まり、呼び出し順には依存しない。
    delay_fn(kind, key) で応答遅延（並列時の到着順の入れ替え）を制御する。
    """

    def __init__(self, geocode=None, places=None, details=None, hotpepper=None,
                 ta_search=None, ta_details=None, delay_fn=None):
        self.geocode = geocode or {}
        self.places = places or {}
        self.details = details or {}
        self.hotpepper = hotpepper or {}
        self.ta_search = ta_search or {}
        self.ta_details = ta_details or {}
        self.delay_fn = delay_fn or (lambda kind, key: 0)
        self.calls = []
        self._lock = threading.Lock()

    def _record(self, url, params, headers):
        key = (url, tuple(sorted((params or {}).items())),
               tuple(sorted((headers or {}).items())))
        with self._lock:
            self.calls.append(key)

    def get(self, url, params=None, headers=None, timeout=None, **kw):
        assert timeout == 10, f"timeout が変更されている: {timeout}"
        self._record(url, params, headers)
        params = params or {}
        if url == GEOCODE_URL:
            key = params['address']
            time.sleep(self.delay_fn('geocode', key))
            return self._resolve(self.geocode.get(key, {'status': 'ZERO_RESULTS', 'results': []}))
        if url == TEXTSEARCH_URL:
            key = params['query']
            time.sleep(self.delay_fn('places', key))
            return self._resolve(self.places.get(key, {'status': 'ZERO_RESULTS', 'results': []}))
        if url == DETAILS_URL:
            key = params['place_id']
            time.sleep(self.delay_fn('details', key))
            return self._resolve(self.details.get(key, {'status': 'NOT_FOUND'}))
        if url == HOTPEPPER_URL:
            key = params['keyword']
            time.sleep(self.delay_fn('hotpepper', key))
            return self._resolve(self.hotpepper.get(key, {'results': {'shop': []}}))
        if url == TA_SEARCH_URL:
            key = (params['searchQuery'], params['language'])
            time.sleep(self.delay_fn('ta_search', key))
            return self._resolve(self.ta_search.get(key, {'data': []}))
        if url.startswith(TA_DETAILS_PREFIX) and url.endswith('/details'):
            loc = url[len(TA_DETAILS_PREFIX):-len('/details')]
            time.sleep(self.delay_fn('ta_details', loc))
            return self._resolve(self.ta_details.get(loc, ({}, 404)))
        raise AssertionError(f"想定外の URL: {url}")

    @staticmethod
    def _resolve(v):
        if isinstance(v, BaseException) and not isinstance(v, ValueError):
            raise v
        if isinstance(v, tuple):
            return FakeResponse(v[0], v[1])
        return FakeResponse(v)


# ---------------------------------------------------------------
# モックデータ生成ヘルパー
# ---------------------------------------------------------------
def geo_ok(region='東京都', cc='JP', lat=35.644, lng=139.699):
    return {'status': 'OK', 'results': [{
        'address_components': [
            {'long_name': '日本' if cc == 'JP' else cc, 'short_name': cc, 'types': ['country', 'political']},
            {'long_name': region, 'short_name': region, 'types': ['administrative_area_level_1', 'political']},
        ],
        'formatted_address': f'{region}',
        'geometry': {'location': {'lat': lat, 'lng': lng}},
    }]}


def place(pid, name, status='OPERATIONAL', photos=True, rating=4.2, total=120, addr=None):
    p = {'place_id': pid, 'name': name, 'business_status': status,
         'rating': rating, 'user_ratings_total': total,
         'formatted_address': addr or f'東京都目黒区 {name}',
         'geometry': {'location': {'lat': 35.6 + len(pid) * 0.001, 'lng': 139.7}}}
    if photos:
        p['photos'] = [{'photo_reference': f'ref_{pid}'}]
    if status is None:
        del p['business_status']
    return p


def details(cc='JP', phone='03-0000-0000', photos=False, addr=None):
    r = {'formatted_phone_number': phone,
         'address_components': [{'short_name': cc, 'long_name': cc, 'types': ['country']}]}
    if photos:
        r['photos'] = [{'photo_reference': 'detail_ref'}]
    if addr:
        r['formatted_address'] = addr
    return {'status': 'OK', 'result': r}


def hp_hit(url):
    return {'results': {'shop': [{'urls': {'pc': url}}]}}


def llm_shop(name, area='中目黒', **extra):
    s = {
        'name': name, 'area': area, 'category': 'イタリアン',
        'description': f'{name}の説明。', 'rating': 4.5, 'reviewCount': 150,
        'priceRange': 'ディナー6,000円〜', 'location': area,
        'highlights': ['a', 'b', 'c'], 'tips': 't', 'specialty': 's',
        'price_range': 'p', 'atmosphere': 'at', 'features': 'f',
        'hotpepper_url': '', 'maps_url': '', 'tabelog_url': '', 'gnavi_url': '',
        'tripadvisor_url': '', 'tripadvisor_rating': None, 'tripadvisor_reviews': None,
        'latitude': None, 'longitude': None,
    }
    s.update(extra)
    return s


def q(shop_name, area, region='東京都'):
    """search_place が組み立てるクエリ（旧版と同じ式）"""
    if region:
        return f"{shop_name} {area} {region}".strip()
    return f"{shop_name} {area}".strip()


# ---------------------------------------------------------------
# 旧版／新版の実行
# ---------------------------------------------------------------
def run_old(world, shops, area, language):
    world.calls = []
    with mock.patch.object(ai.requests, 'get', world.get):
        out = ai.enrich_shops_with_photos(copy.deepcopy(shops), area, language)
    return out, Counter(world.calls)


def apply_updates(shops, updates):
    """フロントエンドの shop_links_update 適用と同じ規則（place_id で特定し、fields のみ上書き）"""
    merged = copy.deepcopy(shops)
    by_pid = {s.get('place_id'): s for s in merged}
    for u in updates:
        target = by_pid.get(u['place_id'])
        assert target is not None, f"place_id が初回カードに無い: {u['place_id']}"
        target.update(u['fields'])
    return merged


def run_new(world, shops, area, language):
    world.calls = []
    with mock.patch.object(ai.requests, 'get', world.get):
        timing = {}
        first, jobs = ai.enrich_shops_core_parallel(copy.deepcopy(shops), area, language, timing=timing)
        first_snapshot = copy.deepcopy(first)  # 初回カード送信時点の内容
        updates = ai.run_shop_link_jobs(jobs)
    return first_snapshot, updates, apply_updates(first_snapshot, updates), Counter(world.calls)


LINK_FIELDS = {'hotpepper_url', 'tripadvisor_url', 'tripadvisor_rating', 'tripadvisor_reviews'}


def assert_equivalent(world, shops, area, language, runs=4, seed=0):
    old_out, old_calls = run_old(world, shops, area, language)
    rnd = random.Random(seed)
    base_delay = world.delay_fn
    for r in range(runs):
        # 1回目: 指定どおりの遅延（逆順など）、2回目以降: ランダム遅延で到着順を入れ替える
        if r > 0:
            delays = {}

            def rand_delay(kind, key, _d=delays):
                k = (kind, str(key))
                if k not in _d:
                    _d[k] = rnd.uniform(0, 0.03)
                return _d[k]
            world.delay_fn = rand_delay
        first, updates, merged, new_calls = run_new(world, shops, area, language)
        world.delay_fn = base_delay

        # (1) 最終結果が旧版と完全一致
        assert merged == old_out, (
            f"run={r} 最終結果が旧版と不一致\nold={json.dumps(old_out, ensure_ascii=False, indent=1)}\n"
            f"new={json.dumps(merged, ensure_ascii=False, indent=1)}")
        # (2) 採用 place_id・順序・店名は初回カード時点で旧版と一致
        assert [s.get('place_id') for s in first] == [s.get('place_id') for s in old_out]
        assert [s.get('name') for s in first] == [s.get('name') for s in old_out]
        # (3) 初回カードはリンク以外の全フィールドが旧版と一致
        for f_shop, o_shop in zip(first, old_out):
            f_rest = {k: v for k, v in f_shop.items() if k not in LINK_FIELDS}
            o_rest = {k: v for k, v in o_shop.items() if k not in LINK_FIELDS}
            assert f_rest == o_rest
        # (4) 後送りは place_id で一意に紐づき、リンク項目以外を書き換えない
        pids = [u['place_id'] for u in updates]
        assert len(pids) == len(set(pids))
        for u in updates:
            assert set(u['fields']) <= LINK_FIELDS
        # (5) 外部 API へのリクエスト（URL・パラメータ・ヘッダ・回数）が旧版と同一
        assert new_calls == old_calls, (
            f"run={r} API 呼び出しが不一致\nonly_old={old_calls - new_calls}\nonly_new={new_calls - old_calls}")
    return old_out


@pytest.fixture(autouse=True)
def api_keys():
    with mock.patch.multiple(ai, GOOGLE_PLACES_API_KEY='gkey', GOOGLE_GEOCODING_API_KEY='gkey',
                             HOTPEPPER_API_KEY='hkey', TRIPADVISOR_API_KEY='tkey'):
        yield


AREA = '中目黒'


def tokyo_world(**kw):
    geocode = kw.pop('geocode', {AREA: geo_ok()})
    return FakeWorld(geocode=geocode, **kw)


# ---------------------------------------------------------------
# テストケース
# ---------------------------------------------------------------
def test_base_function_unchanged_from_33s_version():
    """旧版 enrich_shops_with_photos を含む既存部分は 8d30e55 と完全一致（追記のみ）"""
    try:
        base = subprocess.run(['git', 'show', f'{BASE_SHA}:support-base/api_integrations.py'],
                              cwd=HERE, capture_output=True, check=True).stdout
    except (subprocess.CalledProcessError, FileNotFoundError):
        pytest.skip('git 履歴が無い環境')
    with open(ai.__file__, 'rb') as f:
        cur = f.read()
    assert cur.startswith(base), '既存部分が 8d30e55 から変更されている'


def test_five_unique_shops_all_found_reverse_arrival():
    names = [f'店{i}' for i in range(1, 6)]
    places = {q(n, AREA): {'status': 'OK', 'results': [place(f'P{i}', f'Google{n}')]}
              for i, n in enumerate(names, 1)}
    det = {f'P{i}': details() for i in range(1, 6)}
    hp = {'店1': hp_hit('https://hp/1'), 'Google店3': hp_hit('https://hp/3')}  # 3 は Places 名で再トライ成功
    # 先頭ほど遅い（到着順が推薦順と逆）
    w = tokyo_world(places=places, details=det, hotpepper=hp,
                    delay_fn=lambda kind, key: (0.05 - 0.01 * int(str(key)[1])) if kind == 'places' else 0)
    out = assert_equivalent(w, [llm_shop(n) for n in names], AREA, 'ja')
    assert [s['place_id'] for s in out] == ['P1', 'P2', 'P3', 'P4', 'P5']
    assert out[0]['hotpepper_url'] == 'https://hp/1'
    assert out[2]['hotpepper_url'] == 'https://hp/3'
    assert out[1]['hotpepper_url'].startswith('https://www.google.com/search?q=店2+中目黒+ホットペッパーグルメ')


def test_first_candidate_not_found():
    names = ['見つからない店', '店B', '店C']
    places = {q('店B', AREA): {'status': 'OK', 'results': [place('PB', '店B')]},
              q('店C', AREA): {'status': 'OK', 'results': [place('PC', '店C')]}}
    w = tokyo_world(places=places, details={'PB': details(), 'PC': details()})
    out = assert_equivalent(w, [llm_shop(n) for n in names], AREA, 'ja')
    assert [s['place_id'] for s in out] == ['PB', 'PC']


def test_duplicate_place_id_keeps_earlier_recommendation():
    names = ['やきとり 串若丸', '別の店', '炭火焼鳥 串若丸', '店D']
    places = {
        q('やきとり 串若丸', AREA): {'status': 'OK', 'results': [place('PX', '串若丸')]},
        q('別の店', AREA): {'status': 'OK', 'results': [place('PY', '別の店')]},
        q('炭火焼鳥 串若丸', AREA): {'status': 'OK', 'results': [place('PX', '串若丸')]},
        q('店D', AREA): {'status': 'OK', 'results': [place('PX', '串若丸'), place('PZ', '店D')]},
    }
    # 後ろの重複候補ほど早く返る（並列でも先に推薦された方を残すか）
    w = tokyo_world(places=places, details={'PX': details(), 'PY': details(), 'PZ': details()},
                    delay_fn=lambda kind, key: 0.04 if key == q('やきとり 串若丸', AREA) else 0)
    out = assert_equivalent(w, [llm_shop(n) for n in names], AREA, 'ja')
    assert [s['place_id'] for s in out] == ['PX', 'PY']
    assert out[0]['description'].startswith('やきとり 串若丸')


def test_country_code_mismatch_excluded():
    names = ['国内店', '海外店']
    places = {q('国内店', AREA): {'status': 'OK', 'results': [place('PJ', '国内店')]},
              q('海外店', AREA): {'status': 'OK', 'results': [place('PK', '海外店')]}}
    w = tokyo_world(places=places, details={'PJ': details('JP'), 'PK': details('KR')})
    out = assert_equivalent(w, [llm_shop(n) for n in names], AREA, 'ja')
    assert [s['place_id'] for s in out] == ['PJ']


def test_empty_name_and_mixed_languages_and_missing_area():
    shops = [llm_shop(''), llm_shop('Trattoria ABC 中目黒'), llm_shop('Bistro 東京', area=''),
             {'name': 'エリアなし店'}]
    places = {q('Trattoria ABC 中目黒', AREA): {'status': 'OK', 'results': [place('P1', 'Trattoria ABC')]},
              q('Bistro 東京', AREA): {'status': 'OK', 'results': [place('P2', 'Bistro TOKYO', photos=False)]},
              q('エリアなし店', AREA): {'status': 'OK', 'results': [place('P3', 'エリアなし店')]}}
    det = {'P1': details(), 'P2': details(photos=True), 'P3': details(phone=None, addr='住所3')}
    hp = {'Bistro TOKYO': hp_hit('https://hp/bistro')}
    w = tokyo_world(places=places, details=det, hotpepper=hp)
    out = assert_equivalent(w, shops, AREA, 'ja')
    assert [s['place_id'] for s in out] == ['P1', 'P2', 'P3']


def test_places_timeout_error_zero_and_closed():
    names = ['タイムアウト店', 'エラー店', 'ゼロ件店', '閉店先頭店', '例外店', '正常店']
    places = {
        q('タイムアウト店', AREA): requests.exceptions.Timeout('timeout'),
        q('エラー店', AREA): {'status': 'REQUEST_DENIED', 'results': []},
        q('ゼロ件店', AREA): {'status': 'OK', 'results': []},
        q('閉店先頭店', AREA): {'status': 'OK', 'results': [
            place('PC0', '閉店', status='CLOSED_PERMANENTLY'),
            place('PC1', '休業', status='CLOSED_TEMPORARILY'),
            place('PC2', '閉店先頭店の次', status=None)]},  # business_status 無し = OPERATIONAL 扱い
        q('例外店', AREA): ValueError('bad json'),
        q('正常店', AREA): {'status': 'OK', 'results': [place('PN', '正常店')]},
    }
    det = {'PC2': requests.exceptions.Timeout('details timeout'), 'PN': details()}
    w = tokyo_world(places=places, details=det)
    out = assert_equivalent(w, [llm_shop(n) for n in names], AREA, 'ja')
    # PC2 は Details タイムアウト → country None → 国コード検証をスキップして採用（旧版仕様）
    assert [s['place_id'] for s in out] == ['PC2', 'PN']


def test_all_places_fail_fallback_precondition():
    shops = [llm_shop('無1'), llm_shop('無2'), llm_shop('無3')]
    original = copy.deepcopy(shops)
    w = tokyo_world()
    old_out, _ = run_old(w, shops, AREA, 'ja')
    assert old_out == []
    raw_for_new = copy.deepcopy(shops)
    with mock.patch.object(ai.requests, 'get', w.get):
        first, jobs = ai.enrich_shops_core_parallel(raw_for_new, AREA, 'ja')
    assert first == [] and jobs == []
    # 元候補フォールバック（shops = enriched if enriched else raw_shops）で使う raw_shops が無変更
    assert raw_for_new == original


def test_geocode_failure_and_empty_area():
    names = ['店X', '店Y']
    # Geocoding 失敗 → region なしのクエリ、位置バイアスなし
    places = {q('店X', AREA, region=''): {'status': 'OK', 'results': [place('PX', '店X')]},
              q('店Y', AREA, region=''): {'status': 'OK', 'results': [place('PY', '店Y')]}}
    w = FakeWorld(geocode={}, places=places, details={'PX': details(), 'PY': details()})
    assert_equivalent(w, [llm_shop(n) for n in names], AREA, 'ja')
    # area='' → Geocoding 自体を呼ばない
    w2 = FakeWorld(places=places, details={'PX': details(), 'PY': details()})
    assert_equivalent(w2, [llm_shop(n) for n in names], '', 'ja')


def test_tripadvisor_path_overseas_and_english():
    area = '台北'
    names = ['鼎泰豊 信義店', '海外2', '海外3']
    geo = {area: geo_ok(region='台北市', cc='TW', lat=25.03, lng=121.56)}
    places = {q(n, area, region='台北市'): {'status': 'OK', 'results': [place(f'T{i}', n)]}
              for i, n in enumerate(names, 1)}
    det = {f'T{i}': details('TW') for i in range(1, 4)}
    ta_search = {
        ('鼎泰豊 信義店', 'ja'): {'data': [{'location_id': '111', 'name': 'x'}]},
        ('海外2', 'en'): {'data': [{'location_id': '222', 'name': 'y'}]},  # ja で見つからず en で再検索
    }
    ta_details = {'111': ({'rating': '4.5', 'num_reviews': 900, 'web_url': 'https://ta/111'}, 200),
                  '222': ({'rating': None, 'num_reviews': 3, 'web_url': 'https://ta/222'}, 200)}
    shops = [llm_shop(n, area=area, tripadvisor_url='https://llm/ta') for n in names]
    w = FakeWorld(geocode=geo, places=places, details=det, ta_search=ta_search, ta_details=ta_details)
    out = assert_equivalent(w, shops, area, 'ja')
    assert out[0]['tripadvisor_url'] == 'https://ta/111'
    assert out[1]['tripadvisor_url'] == 'https://ta/222'
    assert out[2]['tripadvisor_url'] == 'https://llm/ta'  # 見つからなければ LLM 値のまま（旧版仕様）
    # 英語セッション（国内店でも TripAdvisor 経路）
    w2 = tokyo_world(places={q('店E', AREA): {'status': 'OK', 'results': [place('PE', '店E')]}},
                     details={'PE': details()},
                     ta_search={('店E', 'en'): {'data': [{'location_id': '9'}]}},
                     ta_details={'9': ({'rating': '4.0', 'num_reviews': 1, 'web_url': 'https://ta/9'}, 200)})
    assert_equivalent(w2, [llm_shop('店E')], AREA, 'en')


def test_tripadvisor_key_missing_and_hotpepper_errors():
    names = ['店1', '店2']
    places = {q(n, AREA): {'status': 'OK', 'results': [place(f'P{i}', n + '本店')]}
              for i, n in enumerate(names, 1)}
    det = {'P1': details(), 'P2': details('US')}
    hp = {'店1': requests.exceptions.ConnectionError('hp down'), '店1本店': hp_hit('https://hp/x')}
    w = FakeWorld(geocode={AREA: geo_ok(cc='US', region='東京都')}, places=places, details=det, hotpepper=hp)
    with mock.patch.object(ai, 'TRIPADVISOR_API_KEY', ''):
        assert_equivalent(w, [llm_shop(n) for n in names], AREA, 'ja')


def test_llm_prefilled_links_are_handled_like_base():
    shops = [llm_shop('店P', hotpepper_url='https://llm/hp', tripadvisor_url='https://llm/ta',
                      tripadvisor_rating=4.0, tripadvisor_reviews=10, tabelog_url='https://llm/tb')]
    w = tokyo_world(places={q('店P', AREA): {'status': 'OK', 'results': [place('PP', '店P')]}},
                    details={'PP': details()})
    out = assert_equivalent(w, shops, AREA, 'ja')
    assert 'tripadvisor_url' not in out[0]
    assert out[0]['hotpepper_url'].startswith('https://www.google.com/search?q=')


def test_many_random_scenarios():
    """ランダム生成シナリオで旧版と新版の一致を網羅的に確認"""
    rnd = random.Random(20261112)
    for case in range(40):
        n = rnd.randint(1, 7)
        names = [f'R{case}_{i}' for i in range(n)]
        pid_pool = [f'X{case}_{k}' for k in range(max(1, n - 1))]
        places, det, hp = {}, {}, {}
        for nm in names:
            kind = rnd.random()
            if kind < 0.15:
                continue  # ZERO_RESULTS
            if kind < 0.2:
                places[q(nm, AREA)] = requests.exceptions.Timeout('t')
                continue
            pid = rnd.choice(pid_pool)  # 重複も発生
            status = rnd.choice(['OPERATIONAL', 'OPERATIONAL', 'CLOSED_TEMPORARILY'])
            res = [place(pid + 'c', 'closed', status='CLOSED_PERMANENTLY')] if rnd.random() < 0.2 else []
            res.append(place(pid, f'G_{pid}', status=status, photos=rnd.random() < 0.7,
                             rating=rnd.choice([None, 3.9, 4.6])))
            places[q(nm, AREA)] = {'status': 'OK', 'results': res}
            det[pid] = rnd.choice([details('JP'), details('JP', photos=True), details('KR'),
                                   {'status': 'NOT_FOUND'}])
            if rnd.random() < 0.4:
                hp[nm] = hp_hit(f'https://hp/{nm}')
            if rnd.random() < 0.3:
                hp[f'G_{pid}'] = hp_hit(f'https://hp/G_{pid}')
        w = tokyo_world(places=places, details=det, hotpepper=hp)
        assert_equivalent(w, [llm_shop(nm) for nm in names], AREA, rnd.choice(['ja', 'ja', 'en']),
                          runs=3, seed=case)
