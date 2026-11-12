# -*- coding: utf-8 -*-
"""DESIGN.md §4.2〜4.3 の決定的照合ルールのテスト"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from shop_engine import matching as m  # noqa: E402

NAKAMEGURO = (35.6441, 139.6990)


def place(pid, name, addr='日本、〒153-0051 東京都目黒区上目黒1丁目', lat=35.6445, lng=139.6985,
          types=('restaurant', 'food', 'point_of_interest'), status='OPERATIONAL'):
    p = {'place_id': pid, 'name': name, 'formatted_address': addr,
         'geometry': {'location': {'lat': lat, 'lng': lng}}, 'types': list(types)}
    if status is not None:
        p['business_status'] = status
    return p


def cand(name, variants=(), area='中目黒'):
    return {'name': name, 'name_variants': list(variants), 'area': area}


def test_core_name_strips_genre_branch_and_symbols():
    assert m.core_name('炭火焼鳥 串若丸', '中目黒') == '串若丸'
    assert m.core_name('やきとり 串若丸', '中目黒') == '串若丸'
    assert m.core_name('焼鳥つかだ 中目黒店', '中目黒') == 'つかだ'
    assert m.core_name('焼鳥つかだ中目黒店', '中目黒') == 'つかだ'
    assert m.core_name('ＫＵＲＡ　中目黒店', '中目黒') == 'kura'
    # 一般語を除くと 2 文字未満になる場合は除去しない
    assert m.core_name('焼鳥 X', '') == '焼鳥x'


def test_notation_variants_are_verified():
    for llm_name, places_name in [('炭火焼鳥 串若丸', 'やきとり 串若丸'),
                                  ('焼鳥つかだ', '焼鳥つかだ 中目黒店'),
                                  ('KURA', 'KURA 中目黒店')]:
        st, p, d = m.classify(cand(llm_name), [place('P1', places_name)], '中目黒', NAKAMEGURO)
        assert st == m.VERIFIED, (llm_name, places_name, d)
        assert p['place_id'] == 'P1'


def test_english_name_matched_via_llm_variants_or_brackets():
    p = place('PB', 'Baird Beer Nakameguro Taproom (ベアードビール中目黒タップルーム)', types=('bar', 'food'))
    st, _, d = m.classify(cand('ベアードビール中目黒タップルーム'), [p], '中目黒', NAKAMEGURO)
    assert st == m.VERIFIED, d
    st2, _, _ = m.classify(cand('ベアード', ['Baird Beer Nakameguro Taproom']), [p], '中目黒', NAKAMEGURO)
    assert st2 == m.VERIFIED


def test_never_swaps_to_top_ranked_different_shop():
    """Places の1位が別店舗でも採用しない（現行の「先頭の営業中店舗を採用」をしない）"""
    results = [place('PX', '鳥よし 中目黒'), place('PY', '焼鳥 とりかつ')]
    st, p, d = m.classify(cand('焼鳥 串若丸'), results, '中目黒', NAKAMEGURO)
    assert st == m.NOT_FOUND and p is None, d


def test_chooses_matching_result_even_if_not_first():
    results = [place('PX', '鳥よし 中目黒'), place('PZ', '串若丸')]
    st, p, _ = m.classify(cand('炭火焼鳥 串若丸'), results, '中目黒', NAKAMEGURO)
    assert st == m.VERIFIED and p['place_id'] == 'PZ'


def test_same_name_branch_in_other_area_is_rejected():
    far = place('PF', '串若丸', addr='日本、大阪府大阪市北区梅田1丁目', lat=34.70, lng=135.50)
    st, p, d = m.classify(cand('串若丸'), [far], '中目黒', NAKAMEGURO)
    assert st == m.NOT_FOUND or st == m.AMBIGUOUS
    assert st != m.VERIFIED and p is None, d


def test_two_matching_branches_in_area_is_ambiguous():
    a = place('PA', '串若丸 中目黒店')
    b = place('PB', '串若丸 祐天寺店', addr='東京都目黒区祐天寺1丁目', lat=35.637, lng=139.690)
    st, p, d = m.classify(cand('串若丸'), [a, b], '中目黒', NAKAMEGURO)
    assert st == m.AMBIGUOUS and p is None and d['reason'] == 'multiple_verified_places'


def test_closed_shop_is_closed():
    st, p, _ = m.classify(cand('串若丸'), [place('PC', '串若丸', status='CLOSED_PERMANENTLY')], '中目黒', NAKAMEGURO)
    assert st == m.CLOSED and p is None
    st, _, _ = m.classify(cand('串若丸'), [place('PC', '串若丸', status='CLOSED_TEMPORARILY')], '中目黒', NAKAMEGURO)
    assert st == m.CLOSED


def test_non_food_place_not_verified():
    st, _, _ = m.classify(cand('串若丸'), [place('PH', '串若丸', types=('lodging',))], '中目黒', NAKAMEGURO)
    assert st == m.AMBIGUOUS


def test_partial_similarity_is_ambiguous_not_verified():
    # 別支店（中目黒 vs 碑文谷）は VERIFIED にしない
    st, p, _ = m.classify(cand('鳥よし 中目黒'), [place('PS', '鳥よし 碑文谷')], '中目黒', NAKAMEGURO)
    assert st != m.VERIFIED and p is None
    st, p, _ = m.classify(cand('とり茂'), [place('PS', 'とり喜')], '中目黒', NAKAMEGURO)
    assert st != m.VERIFIED


def test_address_contains_area_without_geocode():
    p = place('P1', '串若丸', addr='東京都目黒区上目黒2丁目 中目黒駅前', lat=None, lng=None)
    p['geometry'] = {}
    st, _, _ = m.classify(cand('串若丸'), [p], '中目黒', None)
    assert st == m.VERIFIED


def test_empty_results_not_found():
    st, p, _ = m.classify(cand('串若丸'), [], '中目黒', NAKAMEGURO)
    assert st == m.NOT_FOUND and p is None
