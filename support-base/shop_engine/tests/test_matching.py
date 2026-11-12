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


# ---------------------------------------------------------------
# 修正5: 同名の別支店・近接した別店舗・表記揺れ・店名変更
# ---------------------------------------------------------------
YUTENJI = dict(addr='日本、〒153-0052 東京都目黒区祐天寺1丁目', lat=35.6372, lng=139.6912)   # 中目黒から約1km


def test_same_name_other_branch_nearby_is_not_verified():
    """候補が「中目黒店」を名指し、Places には近くの「祐天寺店」しか無い → 2km 以内でも同一店舗にしない"""
    st, p, d = m.classify(cand('鳥よし 中目黒店'), [place('PY', '鳥よし 祐天寺店', **YUTENJI)], '中目黒', NAKAMEGURO)
    assert st == m.AMBIGUOUS and p is None
    assert d['evaluated'][0]['branch_conflict'] is True


def test_named_branch_chosen_among_same_name_branches():
    results = [place('PY', '鳥よし 祐天寺店', **YUTENJI), place('PN', '鳥よし 中目黒店')]
    st, p, _ = m.classify(cand('鳥よし 中目黒店'), results, '中目黒', NAKAMEGURO)
    assert st == m.VERIFIED and p['place_id'] == 'PN'


def test_annex_and_numbered_branch_are_different_shops():
    """別館・2号店は同じ屋号の別店舗。候補が本館なら本館だけを VERIFIED にする"""
    results = [place('PA', 'おみ乃 別館'), place('PM', 'おみ乃')]
    st, p, _ = m.classify(cand('おみ乃'), results, '中目黒', NAKAMEGURO)
    assert st == m.VERIFIED and p['place_id'] == 'PM'
    st, p, _ = m.classify(cand('おみ乃'), [place('P2', 'おみ乃 2号店')], '中目黒', NAKAMEGURO)
    assert st == m.AMBIGUOUS and p is None
    st, p, _ = m.classify(cand('おみ乃 別館'), [place('PM', 'おみ乃')], '中目黒', NAKAMEGURO)
    assert st == m.AMBIGUOUS and p is None


def test_nearby_different_shops_with_similar_names_not_verified():
    """同じエリアにある、名前が似ているだけの別店舗"""
    for llm_name, other in [('鳥しき', '鳥しげ'), ('とり茂', 'とり喜'), ('串若丸', '串若'),
                            ('焼鳥 はちまん', '焼鳥 はちや'), ('Bar Kura', 'Bar Kurara')]:
        st, p, d = m.classify(cand(llm_name), [place('PO', other, types=('restaurant', 'bar'))], '中目黒', NAKAMEGURO)
        assert st != m.VERIFIED and p is None, (llm_name, other, d)


def test_notation_variants_kana_width_symbols():
    for llm_name, places_name in [('トリカツ', 'とりかつ'),            # カタカナ／ひらがな
                                  ('ＫＵＲＡ', 'KURA'),               # 全角／半角
                                  ('鳥 しき', '鳥しき'),               # 空白
                                  ('Pizzeria Eight', 'ピッツェリア エイト'),  # 英字と片仮名 → 別表記が無ければ一致しない
                                  ]:
        st, _, _ = m.classify(cand(llm_name), [place('P', places_name)], '中目黒', NAKAMEGURO)
        if llm_name == 'Pizzeria Eight':
            assert st != m.VERIFIED          # 翻字は推測しない（LLM の name_variants に頼る）
        else:
            assert st == m.VERIFIED, (llm_name, places_name)
    st, _, _ = m.classify(cand('Pizzeria Eight', ['ピッツェリア エイト']), [place('P', 'ピッツェリアエイト 中目黒店')],
                          '中目黒', NAKAMEGURO)
    assert st == m.VERIFIED


def test_renamed_shop_verified_only_via_llm_variants():
    """店名変更: LLM が旧名・新名の両方を出していれば照合できる。片方だけなら推測で同一視しない"""
    new_place = [place('PR', '焼鳥 はなび')]
    st, p, _ = m.classify(cand('鳥はる', ['焼鳥 はなび']), new_place, '中目黒', NAKAMEGURO)       # 旧名＋新名を別表記
    assert st == m.VERIFIED and p['place_id'] == 'PR'
    st, p, _ = m.classify(cand('焼鳥 はなび', ['鳥はる']), new_place, '中目黒', NAKAMEGURO)       # 新名＋旧名を別表記
    assert st == m.VERIFIED
    st, p, _ = m.classify(cand('鳥はる'), new_place, '中目黒', NAKAMEGURO)                         # 旧名だけ
    assert st == m.NOT_FOUND and p is None


def test_location_uses_address_first_and_center_only_when_needed():
    calls = []

    def center():
        calls.append(1)
        return NAKAMEGURO
    p_addr = place('P1', '串若丸', addr='東京都目黒区上目黒1丁目 中目黒駅前')
    st, _, d = m.classify(cand('串若丸'), [p_addr], '中目黒', center)
    assert st == m.VERIFIED and calls == [] and d['evaluated'][0]['location_method'] == 'address'
    st, _, d = m.classify(cand('串若丸'), [place('P2', '串若丸')], '中目黒', center)
    assert st == m.VERIFIED and calls == [1] and d['evaluated'][0]['location_method'] == 'distance'
    # 名前が遠い結果では中心座標を取りに行かない
    calls.clear()
    m.classify(cand('串若丸'), [place('P3', '全然違う店')], '中目黒', center)
    assert calls == []
