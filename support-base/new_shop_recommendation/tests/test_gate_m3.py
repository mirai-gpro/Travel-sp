# -*- coding: utf-8 -*-
"""Gate M3（フロー S 統合 PoC）の計測ロジックのテスト（外部 API なし）"""
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from new_shop_recommendation import contracts as c  # noqa: E402
from new_shop_recommendation import recommender  # noqa: E402
from new_shop_recommendation.poc import gate_m3_flow_s as g  # noqa: E402
from new_shop_recommendation.poc import gate_m3_score as sc  # noqa: E402
from new_shop_recommendation.poc import light_identity as L  # noqa: E402
from new_shop_recommendation.poc import m3_core as m3  # noqa: E402


# ------------------------------------------------------------------ 推薦A・B
@pytest.mark.parametrize('n', [7, 10])
def test_a_prompt_keeps_criteria_and_only_changes_count_and_output(n):
    a = m3.a_instruction(n)
    for keep in ('味・調理技術・素材・専門性・評判・その人の条件への適合性を重視し、知名度順の単純羅列は避けてください。',
                 '料金・受賞歴・営業状態などを根拠なく創作しないでください。', 'rankは1からの連番です。',
                 '今回はGoogle検索や外部ツールを利用せず、学習済み知識のみで選びます。'):
        assert keep in a and keep in recommender.BASE_INSTRUCTION
    assert f'最大{n}候補' in a and f'残り{n - 5}店' in a and '各店の名称と駅・地区だけを返してください' in a
    body = m3.a_body('横浜 焼き鳥', n)
    assert body['stream'] is True and 'tools' not in body and body['model'] == c.MODEL_ID
    assert body['generation_config']['thinking_level'] == 'low'
    assert set(body['response_format']['schema']['properties']['candidates']['items']['properties']) == {'rank', 'name', 'area_hint'}


def test_validate_a_and_b():
    txt = json.dumps({'freshness_intent': 'not_needed', 'candidates': [
        {'rank': 1, 'name': '美鶏', 'area_hint': '関内'}, {'rank': 2, 'name': '里葉亭', 'area_hint': '福富町'}]}, ensure_ascii=False)
    stores = m3.validate_a(txt, 7)
    assert [s['name'] for s in stores] == ['美鶏', '里葉亭']
    dup = txt.replace('里葉亭', '美 鶏')
    with pytest.raises(c.RecommendationError) as e:
        m3.validate_a(dup, 7)
    assert e.value.error_type == 'a_duplicate'
    with pytest.raises(c.RecommendationError):
        m3.validate_a(txt, 1)                                                # 件数超過
    b = json.dumps({'items': [{'rank': 1, 'name': '美鶏', 'specialty': 's', 'reason': 'r'},
                              {'rank': 2, 'name': '里葉亭', 'specialty': 's', 'reason': 'r'}]}, ensure_ascii=False)
    assert m3.validate_b(b, stores) == {1: ('s', 'r'), 2: ('s', 'r')}
    with pytest.raises(c.RecommendationError) as e:
        m3.validate_b(b.replace('里葉亭', '別の店'), stores)
    assert e.value.error_type == 'b_name_changed'                            # 推薦B は店名を変えてはいけない
    body = m3.b_body('q', stores)
    assert 'tools' not in body and '店舗の追加・削除、店名や順位の変更はしないでください。' in body['input']


def test_odd_names_and_scope():
    assert 'foreign_script' in m3.odd_name_flags('割烹 ธุรกิจ 祇園 大渡')
    assert 'meta_text' in m3.odd_name_flags("羊飼いの店 『いただきコッコちゃん』系列 ではなく『しろくま 札幌本店』")
    assert m3.odd_name_flags('焼鳥 美鶏') == []
    assert m3.scope_radius_km('東京駅から徒歩5分以内の美味しいラーメン') == (pytest.approx(0.6), 'walk_5min')
    assert m3.scope_radius_km('東京駅から徒歩10分') == (pytest.approx(1.2), 'walk_10min')
    vp = {'northeast': {'lat': 35.50, 'lng': 139.70}, 'southwest': {'lat': 35.40, 'lng': 139.60}}
    r, why = m3.scope_radius_km('横浜で美味しい焼き鳥', vp)
    assert why == 'viewport' and 6 < r < 8
    assert m3.scope_radius_km('銀座 天ぷら', None) == (3.0, 'default')
    assert m3.area_candidates('東京駅から徒歩5分以内の美味しいラーメン', '') == ['東京駅']


# ------------------------------------------------------------------ 店舗単位の照合
SCOPE = {'prefecture': '東京都', 'center': (35.6580, 139.7016), 'radius_km': 3.0}


def det(name, lat=35.659, lng=139.702, types=('cafe', 'food'), status='OPERATIONAL', addr='東京都渋谷区渋谷'):
    return {'name': name, 'address': addr, 'types': list(types), 'business_status': status, 'lat': lat, 'lng': lng}


class Deps:
    def __init__(self, places, dets, pick=None, sel_error=None):
        self.places, self.dets, self.pick, self.sel_error, self.sel_calls = places, dets, pick, sel_error, 0

    def search(self, rec):
        return {'status': 'OK' if self.places else 'ZERO_RESULTS', 'summary': 's',
                'places': [{'place_id': p, 'place_url': 'u', 'attribution': {}} for p in self.places]}

    def details_many(self, places):
        return self.dets

    def select(self, rec, r):
        self.sel_calls += 1
        if self.sel_error:
            raise c.RecommendationError(self.sel_error)
        return self.pick

    judge = staticmethod(m3.judge_with_scope)


REC = {'rank': 1, 'name': '茶亭 羽當', 'area_hint': '渋谷'}


def test_match_store_same_at_second_position_no_llm():
    d = Deps(['A', 'B'], [det('珈琲茶館 集'), det('茶亭 羽當')])
    out = m3.match_store(REC, SCOPE, d)
    assert out['path'] == 'same' and out['pos'] == 2 and out['place_id'] == 'B' and d.sel_calls == 0
    assert out['verdicts'][0].startswith('DIFFERENT') and out['calls']['details'] == 2


def test_match_store_ambiguous_goes_to_llm_and_rejects_hard_different():
    d = Deps(['A', 'B'], [det("CHATEI HATOU"), det('茶亭 羽當', status='CLOSED_PERMANENTLY')], pick=0)
    out = m3.match_store(REC, SCOPE, d)
    assert out['path'] == 'llm' and out['place_id'] == 'A' and d.sel_calls == 1        # 英字表記は曖昧 → LLM で確認
    d2 = Deps(['A', 'B'], [det('CHATEI HATOU'), det('茶亭 羽當', status='CLOSED_PERMANENTLY')], pick=1)
    out2 = m3.match_store(REC, SCOPE, d2)
    assert out2['path'].startswith('llm_pick_rejected:closed') and out2['place_id'] is None
    d3 = Deps(['A'], [det('CHATEI HATOU')], sel_error='rate_limited')
    assert m3.match_store(REC, SCOPE, d3)['path'] == 'selection_error'


def test_match_store_rejects_building_far_and_no_candidates():
    bld = det('茶亭 羽當', types=('premise', 'point_of_interest'))
    far = det('茶亭 羽當', lat=35.6717, lng=139.7650)                                   # 約 6km
    out = m3.match_store(REC, SCOPE, Deps(['A', 'B'], [bld, far]))
    assert out['path'] == 'all_different' and out['verdicts'] == ['DIFFERENT:not_a_store', 'DIFFERENT:area_mismatch']
    assert m3.match_store(REC, SCOPE, Deps([], []))['path'] == 'no_candidates'


def test_adopt_deadline_dedupe_and_set_time():
    st = [{'rank': 1, 'place_id': 'a', 't_done': 3000}, {'rank': 2, 'place_id': None, 't_done': 3500},
          {'rank': 3, 'place_id': 'a', 't_done': 4000}, {'rank': 4, 'place_id': 'b', 't_done': 9000},
          {'rank': 5, 'place_id': 'c', 't_done': 5000}, {'rank': 6, 'place_id': 'd', 't_done': 6000},
          {'rank': 7, 'place_id': 'e', 't_done': 12000}, {'rank': 8, 'place_id': 'f', 't_done': 7000}]
    a10 = m3.adopt(st, 10000)
    assert [x['place_id'] for x in a10['cards']] == ['a', 'b', 'c', 'd', 'f'] and a10['t_first'] == 3000
    assert a10['t_set'] == 9000                                        # 8 位までの全店舗（7 位は 12 秒で期限外）が判定済み
    assert [x['place_id'] for x in m3.adopt(st)['cards']] == ['a', 'b', 'c', 'd', 'e']


# ------------------------------------------------------------------ 集計・保存
def test_score_with_labels_and_unlabeled_not_counted_as_correct():
    stores = [{'rank': i, 'rec': f'r{i}', 'place_id': f'p{i}', 't_done': 1000 * i + 2000} for i in range(1, 7)]
    lab = {(f'r{i}', f'p{i}'): 'O' for i in range(1, 6)}
    m = sc.trial_metrics(stores, lab, 10000)
    assert m['complete'] and m['t_set'] == 7000 and m['t_first_ok'] == 3000
    lab[('r3', 'p3')] = 'X'
    m2 = sc.trial_metrics(stores, lab, 10000)
    assert not m2['complete'] and m2['x'] == 1
    del lab[('r2', 'p2')]
    assert sc.trial_metrics(stores, lab, 10000)['u'] == 1


def test_strip_for_save_has_no_places_content():
    st = {'rank': 1, 'rec': '美鶏', 'hint': '関内', 'path': 'same', 'pos': 1, 'place_id': 'P', 'top1': 'P',
          'place': {'name': '焼鳥 美鶏', 'address': '神奈川県…', 'lat': 1, 'lng': 2}, 'top1_place': {'name': 'x'},
          't_name': 2000, 't_done': 3000, 'sel_ms': None, 'sel_err': None, 'verdicts': ['SAME:core_name_equal'], 'n_cand': 1}
    a = {'early': [2000], 'full': [2100], 'first_text_ms': 1900, 'completed_ms': 3000, 'duplicates': 0, 'error': None,
         'usage': {}, 'odd': []}
    res = [{'trial': 1, 'q': 'q', 'S7': {'stores': [st], 'a': a, 'a_err': None, 'a_list': [], 'scope': {'area': '横浜'},
                                         'b': {'t_done': 5000, 'error': None, 'items': {1: ('s', 'r')}}, 'unfinished': 0}}]
    dumped = json.dumps(g.strip_for_save(res), ensure_ascii=False)
    assert '焼鳥 美鶏' not in dumped and '神奈川県' not in dumped and '"P"' in dumped


def test_parse_33_json_like_production():
    assert g.parse_33_json('前置き {"shops": [{"name": "a"}], "message": "{x}"} 後') == {'shops': [{'name': 'a'}], 'message': '{x}'}
    assert g.parse_33_json('no json') is None


def test_score_closed_and_bad_cards_and_label_file():
    stores = [{'rank': i, 'rec': f'r{i}', 'place_id': f'p{i}', 't_done': 1000 * i + 2000, 'path': 'same'} for i in range(1, 6)]
    lab = {(f'r{i}', f'p{i}'): 'O' for i in range(1, 6)}
    lab[('r2', 'p2')] = 'Z'                                              # 閉業店のカードは正解に含めない
    m = sc.trial_metrics(stores, lab, 10000)
    assert m['z'] == 1 and m['x'] == 0 and not m['complete']
    res = [{'trial': 1, 'q': 'q', 'S7': {'stores': stores}}]
    assert sc.score(res, lab)['S7']['closed_all'] == 1
    assert [r[3:5] for r in sc.bad_cards(res, lab, 'S7')] == [('r2', 'Z')]
    path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'poc', 'm3_labels.tsv')
    labels = sc.load_labels(path)
    assert labels and set(labels.values()) <= {'O', 'X', '?', 'Z'}
    assert all(len(pid) == 27 and pid.startswith('ChIJ') for _, pid in labels)


def test_analyze_trial_causes():
    from new_shop_recommendation.poc import gate_m3_analyze as an
    st = [{'rank': 1, 'rec': 'a', 'place_id': 'pa', 'top1': 'pa', 'path': 'same', 't_done': 3000},
          {'rank': 2, 'rec': 'b', 'place_id': None, 'top1': 'pb', 'path': 'all_different', 't_done': 3100},
          {'rank': 3, 'rec': 'c', 'place_id': 'pc', 'top1': 'pc', 'path': 'llm', 't_done': 6000},
          {'rank': 4, 'rec': 'd', 'place_id': 'pa', 'top1': 'pa', 'path': 'same', 't_done': 3200},
          {'rank': 5, 'rec': 'e', 'place_id': None, 'top1': 'px', 'path': 'llm_none', 't_done': 4000},
          {'rank': 6, 'rec': 'f', 'place_id': 'pf', 'top1': 'pf', 'path': 'same', 't_done': 12000},
          {'rank': 7, 'rec': 'g', 'place_id': 'pg', 'top1': 'pg', 'path': 'same', 't_done': 5000},
          {'rank': 8, 'rec': 'h', 'place_id': 'ph', 'top1': 'ph', 'path': 'same', 't_done': 5000},
          {'rank': 9, 'rec': 'i', 'place_id': 'pi', 'top1': 'pi', 'path': 'same', 't_done': 5000},
          {'rank': 10, 'rec': 'j', 'place_id': 'pj', 'top1': 'pj', 'path': 'same', 't_done': 5000}]
    lab = {('a', 'pa'): 'O', ('b', 'pb'): 'O', ('c', 'pc'): 'X', ('d', 'pa'): 'O', ('e', 'px'): 'O',
           ('f', 'pf'): 'O', ('g', 'pg'): '?', ('h', 'ph'): 'O', ('i', 'pi'): 'O', ('j', 'pj'): 'O'}
    r = an.analyze_trial({'stores': st}, lab)
    notes = {x['rec']: x['note'] for x in r['rows']}
    assert notes == {'a': 'CARD', 'b': 'MISS_LIGHT', 'c': 'CARD', 'd': 'DUPLICATE', 'e': 'MISS_LLM', 'f': 'LATE',
                     'g': 'CARD', 'h': 'CARD', 'i': 'CARD', 'j': 'CAP_PUSHED'}
    assert r['n_ok'] == 3 and r['short'] == 2 and {'WRONG_LLM', 'UNKNOWN', 'CAP_PUSHED'} <= set(r['causes'])
    assert an.replacement_events({'stores': st}) == 1                  # 3 位（6 秒）の後着で 10 位が押し出される


def test_prefix_stable_display():
    from new_shop_recommendation.poc import gate_m3_analyze as an
    st = [{'rank': 1, 'place_id': 'a', 't_done': 4000}, {'rank': 2, 'place_id': 'b', 't_done': 2000},
          {'rank': 3, 'place_id': None, 't_done': 3000}, {'rank': 4, 'place_id': 'd', 't_done': 11000},
          {'rank': 5, 'place_id': 'e', 't_done': 5000}, {'rank': 6, 'place_id': 'f', 't_done': 6000},
          {'rank': 7, 'place_id': 'g', 't_done': 1000}]
    sh = an.prefix_stable({'stores': st})
    assert [(s['place_id'], t) for s, t in sh] == [('a', 4000), ('b', 4000), ('e', 10000), ('f', 10000), ('g', 10000)]
