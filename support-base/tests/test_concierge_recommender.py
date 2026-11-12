"""
concierge_recommender / concierge_places の決定的テスト（外部 API は呼ばない）

実行: cd support-base && python -m unittest discover -s tests -v
"""
import json
import os
import sys
import threading
import time
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault('GEMINI_API_KEY', 'dummy')

import api_integrations  # noqa: E402
import concierge_places as cp  # noqa: E402
import concierge_recommender as cr  # noqa: E402

GEO = {'country_code': 'JP', 'region': '東京都', 'lat': 35.6467, 'lng': 139.7101}


def cand(name, area='恵比寿', locality='恵比寿', branch='', aliases=(), **kw):
    c = {
        'name': name, 'aliases': list(aliases), 'branch': branch, 'area': area, 'locality': locality,
        'genre': '焼き鳥', 'specialty': 'つくね', 'atmosphere': '落ち着いた', 'price_estimate': '6,000円',
        'reason': '推薦理由。',
    }
    c.update(kw)
    return c


def result(pid, name, address='日本、東京都渋谷区恵比寿1-1-1', status='OPERATIONAL',
           types_=('restaurant', 'food'), lat=35.6467, lng=139.7101):
    return {'place_id': pid, 'name': name, 'formatted_address': address, 'business_status': status,
            'types': list(types_), 'geometry': {'location': {'lat': lat, 'lng': lng}},
            'rating': 4.2, 'user_ratings_total': 100, 'photos': [{'photo_reference': 'REF'}]}


class FakeResponse:
    def __init__(self, data):
        self._data = data

    def json(self):
        return self._data


class FakeModels:
    def __init__(self, replies):
        self.replies = list(replies)
        self.calls = []

    def generate_content(self, model, contents, config):
        self.calls.append({'model': model, 'contents': contents, 'config': config})
        reply = self.replies.pop(0)
        if isinstance(reply, Exception):
            raise reply
        return mock.Mock(text=reply if isinstance(reply, str) else json.dumps(reply, ensure_ascii=False))


class FakeClient:
    def __init__(self, replies):
        self.models = FakeModels(replies)


def r1(candidates, area='恵比寿'):
    return {'area': area, 'candidates': candidates}


class PlacesStub:
    """店名 → Text Search の結果。登録のない店は ZERO_RESULTS"""

    def __init__(self, table, slow=None, fail=()):
        self.table = table
        self.queries = []
        self.slow = slow or {}      # 店名 → 応答の前に待つ threading.Event か秒数
        self.fail = set(fail)       # 店名 → 時間切れにする

    def get(self, url, params=None, timeout=None):
        assert url == cp.TEXT_SEARCH_URL
        self.queries.append(params['query'])
        for name, wait in self.slow.items():
            if params['query'].startswith(name + ' '):
                wait.wait(5) if isinstance(wait, threading.Event) else time.sleep(wait)
        for name in self.fail:
            if params['query'].startswith(name + ' '):
                raise cp.requests.exceptions.Timeout()
        for name, results in self.table.items():
            if params['query'].startswith(name + ' '):
                return FakeResponse({'status': 'OK', 'results': results})
        return FakeResponse({'status': 'ZERO_RESULTS', 'results': []})


class BaseCase(unittest.TestCase):
    def setUp(self):
        patches = [
            mock.patch.object(api_integrations, 'GOOGLE_PLACES_API_KEY', 'TEST-KEY'),
            mock.patch.object(api_integrations, 'TRIPADVISOR_API_KEY', ''),
            mock.patch.object(api_integrations, 'get_region_from_area', return_value=GEO),
            mock.patch.object(api_integrations, 'get_place_details',
                              return_value={'phone': '03-0000-0000', 'country_code': 'JP',
                                            'photos': None, 'formatted_address': None}),
            mock.patch.object(api_integrations, 'search_hotpepper', return_value=None),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)


class TestNormalizeAndJudge(BaseCase):
    def test_normalize_kana_symbols_width(self):
        self.assertEqual(cp.normalize('トリ・ヤ ＡＢＣ'), cp.normalize('とりや abc'))

    def test_name_match_either_direction(self):
        self.assertTrue(cp.name_matches(['鳥よし'], '鳥よし 恵比寿店'))
        self.assertTrue(cp.name_matches(['鳥よし 恵比寿店'], '鳥よし'))
        self.assertFalse(cp.name_matches(['鳥'], '鳥よし'))  # 2 文字未満は使わない

    def test_same_when_one_result_meets_all(self):
        v, p = cp.judge(cand('鳥よし'), [result('A', '鳥よし'), result('B', '別の店')], GEO)
        self.assertEqual((v, p['place_id']), (cp.SAME, 'A'))

    def test_alias_matches(self):
        v, _ = cp.judge(cand('Toriyoshi', aliases=['鳥よし']), [result('A', '鳥よし')], GEO)
        self.assertEqual(v, cp.SAME)

    def test_closed_only(self):
        v, p = cp.judge(cand('鳥よし'), [result('A', '鳥よし', status='CLOSED_PERMANENTLY')], GEO)
        self.assertEqual((v, p), (cp.CLOSED, None))

    def test_not_found_when_name_differs(self):
        # 名前が合わない店に置き換えない
        v, p = cp.judge(cand('鳥よし'), [result('A', '焼鳥 別名店')], GEO)
        self.assertEqual((v, p), (cp.NOT_FOUND, None))

    def test_out_of_radius_without_locality(self):
        far = result('A', '鳥よし', address='日本、大阪府大阪市北区', lat=34.70, lng=135.50)
        v, _ = cp.judge(cand('鳥よし', locality=''), [far], GEO)
        self.assertEqual(v, cp.NOT_FOUND)

    def test_locality_in_address_counts_as_location(self):
        far = result('A', '鳥よし', lat=34.70, lng=135.50)
        v, _ = cp.judge(cand('鳥よし', locality='恵比寿'), [far], GEO)
        self.assertEqual(v, cp.SAME)

    def test_non_food_type_rejected(self):
        v, _ = cp.judge(cand('鳥よし'), [result('A', '鳥よし', types_=('lodging',))], GEO)
        self.assertEqual(v, cp.NOT_FOUND)

    def test_multiple_ambiguous_without_branch(self):
        rs = [result('A', '鳥よし 恵比寿店'), result('B', '鳥よし 恵比寿西店', address='日本、東京都渋谷区恵比寿西1-1')]
        v, _ = cp.judge(cand('鳥よし', locality=''), rs, GEO)
        self.assertEqual(v, cp.AMBIGUOUS)

    def test_multiple_narrowed_by_branch(self):
        rs = [result('A', '鳥よし 恵比寿店'), result('B', '鳥よし 中目黒店', address='日本、東京都目黒区上目黒1-1')]
        v, p = cp.judge(cand('鳥よし', branch='中目黒店', locality=''), rs, GEO)
        self.assertEqual((v, p['place_id']), (cp.SAME, 'B'))


class TestRecommend(BaseCase):
    def run_recommend(self, replies, table, request='恵比寿で接待の焼き鳥', area='', **stub_kw):
        client = FakeClient(replies)
        stub = PlacesStub(table, **stub_kw)
        with mock.patch.object(cp.requests, 'get', side_effect=stub.get):
            out = cr.recommend_shops(request, 'ja', 'live', gemini_client=client, area=area)
        return out, client, stub

    def test_complete_keeps_llm_order(self):
        names = [f'店{i}' for i in range(1, 13)]
        table = {n: [result(f'P{i}', n)] for i, n in enumerate(names, 1)}
        out, client, _ = self.run_recommend([r1([cand(n) for n in names])], table)
        self.assertEqual(out['status'], cr.COMPLETE)
        self.assertEqual([s['name'] for s in out['shops']], names[:5])
        self.assertEqual([s['order'] for s in out['shops']], [1, 2, 3, 4, 5])
        self.assertEqual(len(client.models.calls), 1)   # R4 は呼ばない
        config = client.models.calls[0]['config']
        self.assertEqual(client.models.calls[0]['model'], cr.RECOMMEND_MODEL)
        self.assertIsNone(config.tools)                 # D-1 の承認まで検索を使わない
        self.assertEqual(config.thinking_config.thinking_level, cr.types.ThinkingLevel.LOW)
        self.assertEqual(len(out['card_geos']), 5)

    def test_order_kept_when_lower_rank_answers_first(self):
        names = [f'店{i}' for i in range(1, 7)]
        table = {n: [result(f'P{n}', n)] for n in names}
        out, _, _ = self.run_recommend([r1([cand(n) for n in names])], table, slow={'店1': 0.2})
        self.assertEqual([s['name'] for s in out['shops']], names[:5])

    def test_does_not_wait_for_remaining_after_five(self):
        names = [f'店{i}' for i in range(1, 9)]
        table = {n: [result(f'P{n}', n)] for n in names}
        gate = threading.Event()
        self.addCleanup(gate.set)
        started = time.monotonic()
        out, _, _ = self.run_recommend([r1([cand(n) for n in names])], table, slow={'店7': gate, '店8': gate})
        self.assertLess(time.monotonic() - started, 2)  # 7・8 位の照合を待たずに返る
        self.assertEqual(out['status'], cr.COMPLETE)
        self.assertEqual([s['name'] for s in out['shops']], names[:5])

    def test_cards_without_details_and_external_api(self):
        names = [f'店{i}' for i in range(1, 6)]
        table = {n: [result(f'P{i}', f'{n} 本店（Places の名前）')] for i, n in enumerate(names, 1)}
        out, _, _ = self.run_recommend([r1([cand(n) for n in names])], table)
        card = out['cards'][0]
        self.assertEqual((card['name'], card['place_id'], card['priceRange']), ('店1', 'P1', '6,000円（目安）'))
        self.assertEqual(card['highlights'], ['つくね', '落ち着いた'])   # specialty・atmosphere
        self.assertEqual(card['description'], '推薦理由。')
        self.assertIn('photo_reference=REF', card['image'])
        self.assertIn('google.com/search', card['hotpepper_url'])     # 表示前は検索 URL
        self.assertIn('tabelog.com/tokyo/', card['tabelog_url'])
        self.assertNotIn('phone', card)
        api_integrations.get_place_details.assert_not_called()
        api_integrations.search_hotpepper.assert_not_called()
        # 会話用の項目に Places の値（評価・住所）を入れない。specialty・atmosphere・reason は残す
        self.assertNotIn('rating', out['shops'][0])
        self.assertEqual((out['shops'][0]['specialty'], out['shops'][0]['atmosphere']), ('つくね', '落ち着いた'))
        self.assertNotIn('fit', out['shops'][0])
        # 紹介の要点は確定後に既存の項目から組み立てる（カードには入れない）
        self.assertEqual(out['shops'][0]['talking_points'],
                         ['看板料理：つくね', '雰囲気：落ち着いた', 'おすすめ理由：推薦理由。', '予算目安：6,000円'])
        self.assertNotIn('talking_points', card)

    def test_initial_candidates_limited_to_eight(self):
        names = [f'店{i}' for i in range(1, 13)]
        out, client, stub = self.run_recommend([r1([cand(n) for n in names]), {'candidates': []}], {})
        self.assertEqual(out['status'], cr.NOT_FOUND)
        self.assertEqual(len(stub.queries), 8)                          # 9 位以降は照合しない
        config = client.models.calls[0]['config']
        self.assertEqual(config.response_json_schema['properties']['candidates']['maxItems'], 8)
        self.assertIn('最大8件', config.system_instruction)
        self.assertEqual(client.models.calls[1]['config']
                         .response_json_schema['properties']['candidates']['maxItems'], 8)   # R4 は 8 のまま

    def test_talking_points_skip_empty_values(self):
        item = {'specialty': '', 'atmosphere': '落ち着いた', 'reason': '理由。', 'price_estimate': ' '}
        self.assertEqual(cr.talking_points(item, 'ja'), ['雰囲気：落ち着いた', 'おすすめ理由：理由。'])
        self.assertEqual(cr.talking_points(item, 'en'), ['Atmosphere: 落ち着いた', 'Why we recommend it: 理由。'])

    def test_candidate_schema_same_as_before(self):
        self.assertEqual(cr._CANDIDATE_ITEM['required'],
                         ['name', 'aliases', 'branch', 'area', 'locality', 'genre', 'specialty',
                          'atmosphere', 'price_estimate', 'reason'])

    def test_supplement_after_all_candidates(self):
        names = [f'店{i}' for i in range(1, 9)]
        ok = {'店1', '店8'}
        table = {n: [result(f'P{n}', n)] for n in ok}
        extra = [cand('補A'), cand('補B'), cand('補C'), cand('店1')]
        table.update({n: [result(f'P{n}', n)] for n in ['補A', '補B', '補C']})
        out, client, stub = self.run_recommend([r1([cand(n) for n in names]), {'candidates': extra}], table)
        self.assertEqual(out['status'], cr.COMPLETE)
        self.assertEqual([s['name'] for s in out['shops']], ['店1', '店8', '補A', '補B', '補C'])
        self.assertEqual(len(client.models.calls), 2)
        self.assertIn('店8', client.models.calls[1]['contents'])        # 試した店を渡す
        self.assertIn('恵比寿で接待の焼き鳥', client.models.calls[1]['contents'])  # 元の依頼を渡す
        self.assertEqual(stub.queries.count('店1 恵比寿'), 1)             # 試した店は照合し直さない

    def test_too_few_verified_is_not_found(self):
        names = [f'店{i}' for i in range(1, 13)]
        table = {n: [result(f'P{n}', n)] for n in ['店2', '店3', '店4']}
        out, _, _ = self.run_recommend([r1([cand(n) for n in names]), {'candidates': []}], table)
        self.assertEqual((out['status'], out['reason_code'], out['found_count']),
                         (cr.NOT_FOUND, 'too_few_verified', 3))
        self.assertEqual((out['shops'], out['cards']), ([], []))

    def test_partial_no_response_is_places_partial(self):
        names = [f'店{i}' for i in range(1, 7)]
        table = {n: [result(f'P{n}', n)] for n in ['店1', '店2', '店3']}
        out, client, _ = self.run_recommend([r1([cand(n) for n in names]), {'candidates': []}], table,
                                            fail={'店4'})
        self.assertEqual((out['status'], out['reason_code'], out['found_count']),
                         (cr.NOT_FOUND, 'places_partial', 3))
        self.assertEqual(len(client.models.calls), 2)   # 一部の応答なしでは R4 を呼ぶ

    def test_all_no_response_is_error_without_r4(self):
        names = [f'店{i}' for i in range(1, 4)]
        out, client, _ = self.run_recommend([r1([cand(n) for n in names])], {}, fail=set(names))
        self.assertEqual((out['status'], out['reason_code']), (cr.ERROR, 'places'))
        self.assertEqual(len(client.models.calls), 1)   # R4 は呼ばない

    def test_no_candidates(self):
        out, _, stub = self.run_recommend([r1([])], {})
        self.assertEqual((out['status'], out['reason_code']), (cr.NOT_FOUND, 'no_candidates'))
        self.assertEqual(stub.queries, [])

    def test_area_from_search_shops_is_geocoded_once(self):
        names = [f'店{i}' for i in range(1, 6)]
        table = {n: [result(f'P{n}', n)] for n in names}
        out, _, _ = self.run_recommend([r1([cand(n) for n in names], area='恵比寿駅')], table, area='恵比寿')
        self.assertEqual(out['status'], cr.COMPLETE)
        api_integrations.get_region_from_area.assert_called_once_with('恵比寿', 'ja')

    def test_grounding_flag_adds_search_tool_and_rule(self):
        names = [f'店{i}' for i in range(1, 6)]
        table = {n: [result(f'P{n}', n)] for n in names}
        with mock.patch.object(cr, 'GROUNDING_ENABLED', True):
            _, client, _ = self.run_recommend([r1([cand(n) for n in names])], table)
        config = client.models.calls[0]['config']
        self.assertEqual(len(config.tools), 1)
        self.assertIsNotNone(config.tools[0].google_search)
        self.assertIn('Google 検索', config.system_instruction)

    def test_duplicate_place_and_chain(self):
        cands = [cand('店1'), cand('店1', branch='西口店'), cand('店2'), cand('店3'), cand('店4'),
                 cand('店5'), cand('店6')]
        table = {n: [result(f'P{n}', n)] for n in ['店2', '店3', '店4', '店5', '店6']}
        table['店1'] = [result('P店1', '店1')]
        out, _, _ = self.run_recommend([r1(cands)], table)
        self.assertEqual([s['name'] for s in out['shops']], ['店1', '店2', '店3', '店4', '店5'])

    def test_r1_not_json_is_error(self):
        out, _, stub = self.run_recommend(['not json'], {})
        self.assertEqual((out['status'], out['reason_code']), (cr.ERROR, 'llm'))
        self.assertEqual(stub.queries, [])

    def test_r1_exception_is_error_without_retry(self):
        out, client, _ = self.run_recommend([RuntimeError('boom')], {})
        self.assertEqual(out['status'], cr.ERROR)
        self.assertEqual(len(client.models.calls), 1)  # 自動のやり直しはしない

    def test_error_text_has_http_status(self):
        err = RuntimeError('server')
        err.code = 504
        with self.assertRaisesRegex(cr.RecommendError, 'RuntimeError 504'):
            cr._call_json(FakeClient([err]), 'i', 'c', cr.R1_SCHEMA)

    def test_places_exception_is_error(self):
        client = FakeClient([r1([cand('店1')])])
        with mock.patch.object(cp.requests, 'get', side_effect=RuntimeError('net')):
            out = cr.recommend_shops('x', 'ja', 'text', gemini_client=client)
        self.assertEqual((out['status'], out['reason_code']), (cr.ERROR, 'places'))


class TestPlacesHelpers(BaseCase):
    def test_timeout_is_no_response_and_zero_results_is_response(self):
        with mock.patch.object(cp.requests, 'get', side_effect=cp.requests.exceptions.Timeout()):
            self.assertEqual(cp.text_search(cand('店1'), GEO, 'ja'), ([], False))
        with mock.patch.object(cp.requests, 'get',
                               return_value=FakeResponse({'status': 'ZERO_RESULTS', 'results': []})):
            self.assertEqual(cp.text_search(cand('店1'), GEO, 'ja'), ([], True))

    def test_pref_key(self):
        self.assertEqual([cp._pref_key(x) for x in ['京都府', '北海道', '東京都', '大阪府', '福岡県']],
                         ['京都', '北海道', '東京', '大阪', '福岡'])

    def test_links_for_cards_calls_external_api(self):
        api_integrations.search_hotpepper.return_value = 'https://www.hotpepper.jp/strJ000/'
        cards = [{'name': '店1', 'area': '恵比寿', 'place_id': 'P1', 'latitude': 1, 'longitude': 2},
                 {'name': '店2', 'area': '恵比寿', 'place_id': 'P2', 'latitude': 1, 'longitude': 2}]
        out = cp.links_for_cards(cards, [GEO, GEO], 'ja')
        self.assertEqual(out[0], {'place_id': 'P1', 'links': {'hotpepper_url': 'https://www.hotpepper.jp/strJ000/'}})
        self.assertEqual(len(out), 2)


if __name__ == '__main__':
    unittest.main()
