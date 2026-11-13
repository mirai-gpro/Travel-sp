# -*- coding: utf-8 -*-
"""オーケストレーターのテスト（外部 API なし）。指示書 8.1"""
import json
import logging
import os
import sys
import threading
import time

import requests

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from new_shop_recommendation import contracts as c  # noqa: E402
from new_shop_recommendation.orchestrator import ShopRecommendationOrchestrator  # noqa: E402
from new_shop_recommendation.place_verifier import PlacesNewClient  # noqa: E402
from new_shop_recommendation.redact import register_secret  # noqa: E402

from test_identity import P  # noqa: E402

PKEY = 'AIzaTESTPLACESKEY0123456789abcdefg'
NAMES = ['美鶏', '地葉', '里葉亭', '炭火焼鳥 おがわ', '焼鳥 さいとう', '野毛末広', '焼鳥 幸八']


class FakeRecommender:
    def __init__(self, names=NAMES, error=None, delay=0.0):
        self.names = names
        self.error = error
        self.delay = delay
        self.finished_at = None

    def recommend(self, user_request):
        time.sleep(self.delay)
        self.finished_at = time.monotonic()
        if self.error:
            raise self.error
        cands = [c.Candidate(i, n, '横浜駅西口', f'{n}の名物', f'{n}を推す理由') for i, n in enumerate(self.names, 1)]
        return c.LlmOutput('not_needed', cands, 1234, 0, 'completed')


class FakePlacesHttp:
    """Places (New) の HTTP を模擬。textQuery の店名部分で応答を決め、遅延を個別に設定できる"""

    def __init__(self, db=None, delays=None):
        self.db = db if db is not None else {n: [P(f'id_{i}', n)] for i, n in enumerate(NAMES, 1)}
        self.delays = delays or {}
        self.started = []
        self.lock = threading.Lock()

    def __call__(self, url, timeout=None, headers=None, json=None):
        name = json['textQuery'].rsplit(' ', 1)[0]
        with self.lock:
            self.started.append((name, time.monotonic()))
        assert headers['X-Goog-Api-Key'] == PKEY and 'X-Goog-FieldMask' in headers and '*' not in headers['X-Goog-FieldMask']
        assert PKEY not in url
        time.sleep(self.delays.get(name, 0.01))
        v = self.db.get(name, [])
        if isinstance(v, BaseException):
            raise v

        class R:
            status_code = 200
            text = ''

            @staticmethod
            def json():
                return {'places': v}
        return R()


def run(rec=None, http=None, timeout=3.0):
    http = http or FakePlacesHttp()
    o = ShopRecommendationOrchestrator(rec or FakeRecommender(), PlacesNewClient(PKEY, http_post=http, timeout_sec=timeout),
                                       credential_kind='AQ')
    return o.run('横浜で美味しい焼き鳥屋'), http


def test_complete_top5_in_llm_order_with_reverse_latency():
    delays = {n: 0.30 - 0.04 * i for i, n in enumerate(NAMES)}        # 上位ほど遅い
    res, http = run(http=FakePlacesHttp(delays=delays))
    assert res['status'] == c.COMPLETE
    assert [x['llm_name'] for x in res['cards']] == NAMES[:5]
    assert [x['display_rank'] for x in res['cards']] == [1, 2, 3, 4, 5]
    assert [x['recommend_rank'] for x in res['cards']] == [1, 2, 3, 4, 5]


def test_all_candidates_queried_in_parallel_after_llm_finishes():
    rec = FakeRecommender(delay=0.05)
    res, http = run(rec=rec, http=FakePlacesHttp(delays={n: 0.2 for n in NAMES}))
    starts = [t for _n, t in http.started]
    assert len(starts) == 7
    assert min(starts) >= rec.finished_at                   # LLM の JSON 完成前に Places を始めない
    assert max(starts) - min(starts) < 0.1                  # 7 件が同時に開始（直列なら 0.2 秒ずつずれる）
    assert res['metrics']['places_duration_ms'] < 600


def test_unverified_skipped_and_backups_used_in_order():
    db = {n: [P(f'id_{i}', n)] for i, n in enumerate(NAMES, 1)}
    db['地葉'] = [P('other', '鳥よし')]                                # 1 位が別店 → 採用しない
    db['里葉亭'] = [P('cl', '里葉亭', status='CLOSED_PERMANENTLY')]
    db['焼鳥 さいとう'] = requests.exceptions.ConnectionError('down')
    res, _ = run(http=FakePlacesHttp(db=db))
    assert [x['llm_name'] for x in res['cards']] == ['美鶏', '炭火焼鳥 おがわ', '野毛末広', '焼鳥 幸八']
    assert res['status'] == c.PARTIAL
    assert all(x['place_id'] != 'other' for x in res['cards'])
    st = {v['name']: v['status'] for v in res['verifications']}
    assert st['地葉'] == c.NOT_VERIFIED and st['里葉亭'] == c.CLOSED and st['焼鳥 さいとう'] == c.API_ERROR
    assert res['metrics']['rejected_counts_by_reason'] == {'NOT_VERIFIED:name_mismatch': 1, 'CLOSED:closed': 1,
                                                          'API_ERROR': 1}


def test_empty_never_padded():
    res, _ = run(http=FakePlacesHttp(db={}))
    assert res['status'] == c.EMPTY and res['cards'] == [] and res['narration'] == []


def test_duplicate_place_id_kept_once():
    db = {n: [P(f'id_{i}', n)] for i, n in enumerate(NAMES, 1)}
    db['地葉'] = [P('id_1', '地葉')]                                   # 1 位と同じ place_id
    res, _ = run(http=FakePlacesHttp(db=db))
    ids = [x['place_id'] for x in res['cards']]
    assert len(ids) == len(set(ids)) == 5
    assert [x['llm_name'] for x in res['cards']] == ['美鶏', '里葉亭', '炭火焼鳥 おがわ', '焼鳥 さいとう', '野毛末広']


def test_cards_and_narration_same_shops_same_order_and_no_maps_data_in_narration():
    res, _ = run()
    assert [x['llm_name'] for x in res['cards']] == [n['name'] for n in res['narration']]
    for n in res['narration']:
        assert set(n) == {'name', 'area', 'category', 'description', 'price_range'}
        assert 'id_' not in json.dumps(n) and '日本、' not in json.dumps(n) and 'maps' not in json.dumps(n)
    card = res['cards'][0]
    assert card['maps_url'].startswith('https://maps.google.com/') and card['location'].startswith('日本、')
    assert 'image' not in card                                          # 写真は帰属表示の対応まで出さない


def test_llm_errors_are_error_or_timed_out_without_cards():
    for err, status in [(c.RecommendationError('rate_limited', 'HTTP 429'), c.ERROR),
                        (c.RecommendationError('timeout', ''), c.TIMED_OUT),
                        (c.RecommendationError('invalid_output_json', 'x'), c.ERROR)]:
        http = FakePlacesHttp()
        res, _ = run(rec=FakeRecommender(error=err), http=http)
        assert res['status'] == status and res['cards'] == [] and res['narration'] == []
        assert http.started == []                                       # 補充検索をしない
        assert res['error_type'] == err.error_type


def test_places_batch_timeout_marks_api_error():
    res, _ = run(http=FakePlacesHttp(delays={'美鶏': 3.0}), timeout=0.2)  # 待機上限 0.2+2.0 秒を超える
    st = {v['name']: v['status'] for v in res['verifications']}
    assert st['美鶏'] == c.API_ERROR
    assert '美鶏' not in [x['llm_name'] for x in res['cards']]


def test_metrics_fields_and_no_secret_in_result_or_log(caplog):
    register_secret(PKEY)
    with caplog.at_level(logging.INFO):
        res, _ = run(http=FakePlacesHttp(db={NAMES[0]: RuntimeError(f'url?key={PKEY}')}))
    m = res['metrics']
    for k in ('request_id', 'git_sha', 'model_id', 'thinking_level', 'credential_kind', 'llm_started',
              'llm_finished', 'llm_duration_ms', 'llm_candidate_count', 'google_search_calls', 'places_started',
              'places_finished', 'places_duration_ms', 'verified_count', 'rejected_counts_by_reason',
              'final_status', 'error_type'):
        assert k in m
    assert m['model_id'] == 'gemini-3.8-flash' and m['thinking_level'] == 'low' and m['google_search_calls'] == 0
    blob = json.dumps(res, ensure_ascii=False) + caplog.text
    assert PKEY not in blob
    assert '[NewShopRec]' in caplog.text
