"""
concierge_recommender / concierge_places の決定的テスト（外部 API は呼ばない）

実行: cd support-base && python -m unittest discover -s tests -v
"""
import json
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault('GEMINI_API_KEY', 'dummy')

import api_integrations  # noqa: E402
import concierge_places as cp  # noqa: E402
import concierge_recommender as cr  # noqa: E402

GEO = {'country_code': 'JP', 'region': '東京都', 'lat': 35.6467, 'lng': 139.7101}


def cand(name, area='恵比寿', locality='恵比寿', branch='', aliases=(), fresh=False, **kw):
    c = {
        'name': name, 'aliases': list(aliases), 'branch': branch, 'area': area, 'locality': locality,
        'genre': '焼き鳥', 'specialty': 'つくね', 'atmosphere': '落ち着いた', 'price_estimate': '6,000円',
        'fit': ['接待に向く個室'], 'reason': '推薦理由。', 'freshness_concern': fresh,
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


def r1(candidates, recency=False, area='恵比寿'):
    return {
        'conditions': {'area': area, 'cuisine': '焼き鳥', 'budget': '', 'occasion': '接待', 'atmosphere': '',
                       'party_size': '', 'must_have': [], 'avoid': [], 'recency_requested': recency,
                       'prefecture': '東京都'},
        'candidates': candidates,
    }


class PlacesStub:
    """店名 → Text Search の結果。登録のない店は ZERO_RESULTS"""

    def __init__(self, table):
        self.table = table
        self.queries = []

    def get(self, url, params=None, timeout=None):
        assert url == cp.TEXT_SEARCH_URL
        self.queries.append(params['query'])
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
    def run_recommend(self, replies, table, request='恵比寿で接待の焼き鳥'):
        client = FakeClient(replies)
        stub = PlacesStub(table)
        with mock.patch.object(cp.requests, 'get', side_effect=stub.get):
            out = cr.recommend_shops(request, 'ja', 'text', gemini_client=client)
        return out, client, stub

    def test_complete_in_stage1_keeps_llm_order(self):
        names = [f'店{i}' for i in range(1, 13)]
        table = {n: [result(f'P{i}', n)] for i, n in enumerate(names, 1)}
        out, client, stub = self.run_recommend([r1([cand(n) for n in names])], table)
        self.assertEqual(out['status'], cr.COMPLETE)
        self.assertEqual([s['name'] for s in out['shops']], names[:5])
        self.assertEqual([s['order'] for s in out['shops']], [1, 2, 3, 4, 5])
        self.assertEqual(len(stub.queries), 7)          # 第 1 段だけ
        self.assertEqual(len(client.models.calls), 1)   # R4 は呼ばない
        self.assertEqual(client.models.calls[0]['model'], cr.RECOMMEND_MODEL)
        self.assertIsNone(client.models.calls[0]['config'].tools)  # 通常の推薦で検索を使わない

    def test_cards_use_llm_name_not_places_name(self):
        names = [f'店{i}' for i in range(1, 6)]
        table = {n: [result(f'P{i}', f'{n} 本店（Places の名前）')] for i, n in enumerate(names, 1)}
        out, _, _ = self.run_recommend([r1([cand(n) for n in names])], table)
        self.assertEqual(out['cards'][0]['name'], '店1')
        self.assertEqual(out['cards'][0]['place_id'], 'P1')
        self.assertEqual(out['cards'][0]['priceRange'], '6,000円（目安）')
        self.assertIn('hotpepper_url', out['cards'][0])
        api_integrations.search_hotpepper.assert_any_call('店1', '恵比寿', GEO)
        # 会話用の項目に Places の値（評価・住所）を入れない
        self.assertNotIn('rating', out['shops'][0])
        self.assertNotIn('location', out['shops'][0])

    def test_stage2_then_supplement(self):
        names = [f'店{i}' for i in range(1, 13)]
        ok = {'店1', '店9'}
        table = {n: [result(f'P{n}', n)] for n in ok}
        extra = [cand('補A'), cand('補B'), cand('補C'), cand('店1')]
        table.update({n: [result(f'P{n}', n)] for n in ['補A', '補B', '補C']})
        out, client, stub = self.run_recommend([r1([cand(n) for n in names]), {'candidates': extra}], table)
        self.assertEqual(out['status'], cr.COMPLETE)
        self.assertEqual([s['name'] for s in out['shops']], ['店1', '店9', '補A', '補B', '補C'])
        self.assertEqual(len(client.models.calls), 2)
        self.assertIn('店12', client.models.calls[1]['contents'])  # 試した店を渡す
        self.assertEqual(stub.queries.count('店1 恵比寿'), 1)       # 試した店は照合し直さない

    def test_too_few_verified_is_not_found(self):
        names = [f'店{i}' for i in range(1, 13)]
        table = {n: [result(f'P{n}', n)] for n in ['店2', '店3', '店4']}
        out, _, _ = self.run_recommend([r1([cand(n) for n in names]), {'candidates': []}], table)
        self.assertEqual((out['status'], out['reason_code'], out['found_count']),
                         (cr.NOT_FOUND, 'too_few_verified', 3))
        self.assertEqual(out['shops'], [])
        self.assertEqual(out['cards'], [])

    def test_no_candidates(self):
        out, _, stub = self.run_recommend([r1([])], {})
        self.assertEqual((out['status'], out['reason_code']), (cr.NOT_FOUND, 'no_candidates'))
        self.assertEqual(stub.queries, [])

    def test_fresh_disabled(self):
        out, client, stub = self.run_recommend([r1([cand('店1')], recency=True)], {})
        self.assertEqual((out['status'], out['reason_code']), (cr.NOT_FOUND, 'fresh_disabled'))
        self.assertEqual(stub.queries, [])
        self.assertEqual(len(client.models.calls), 1)

    def test_freshness_concern_not_matched(self):
        names = [f'店{i}' for i in range(1, 7)]
        cands = [cand(n, fresh=(n == '店1')) for n in names]
        table = {n: [result(f'P{n}', n)] for n in names}
        out, _, stub = self.run_recommend([r1(cands)], table)
        self.assertEqual([s['name'] for s in out['shops']], names[1:6])
        self.assertNotIn('店1 恵比寿', stub.queries)

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

    def test_places_never_answered_is_error(self):
        client = FakeClient([r1([cand('店1')])])
        with mock.patch.object(cp.requests, 'get', side_effect=RuntimeError('net')):
            out = cr.recommend_shops('x', 'ja', 'text', gemini_client=client)
        self.assertEqual((out['status'], out['reason_code']), (cr.ERROR, 'places'))


if __name__ == '__main__':
    unittest.main()
