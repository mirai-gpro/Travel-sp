# -*- coding: utf-8 -*-
"""同一店舗判定（identity.judge）のテスト。指示書 6.2 の判定表・8.1 の項目"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from new_shop_recommendation import contracts as c  # noqa: E402
from new_shop_recommendation import identity as idt  # noqa: E402

YOKOHAMA = '日本、〒220-0005 神奈川県横浜市西区南幸２丁目１'
NAKAMEGURO_ADDR = '日本、〒153-0051 東京都目黒区上目黒１丁目'
YUTENJI_ADDR = '日本、〒153-0052 東京都目黒区祐天寺１丁目'


def P(pid, name, addr=YOKOHAMA, types=('restaurant', 'food'), primary='yakitori_restaurant', status='OPERATIONAL'):
    p = {'id': pid, 'displayName': {'text': name, 'languageCode': 'ja'}, 'formattedAddress': addr,
         'location': {'latitude': 35.46, 'longitude': 139.62}, 'types': list(types), 'primaryType': primary,
         'googleMapsUri': f'https://maps.google.com/?cid={pid}'}
    if status is not None:
        p['businessStatus'] = status
    return p


def C(name, area='横浜駅西口'):
    return c.Candidate(rank=1, name=name, area_hint=area, specialty='つくね', reason='理由')


def test_notation_variants_verified():
    for llm, places in [('焼鳥 地葉', '地葉'), ('炭火焼鳥 串若丸', 'やきとり 串若丸'), ('ＫＵＲＡ', 'KURA'),
                        ('トリカツ', 'とりかつ'), ('鳥 しき', '鳥しき'),
                        ('ベアードビール', 'Baird Beer (ベアードビール)'), ('美鶏', '美鶏 横浜西口店')]:
        st, reason, p, _ = idt.judge(C(llm), [P('X', places)])
        assert st == c.VERIFIED, (llm, places, reason)
        assert p['id'] == 'X'


def test_first_result_is_other_shop_second_is_correct():
    st, _, p, ev = idt.judge(C('焼鳥 地葉'), [P('A', '鳥よし'), P('B', '地葉')])
    assert st == c.VERIFIED and p['id'] == 'B'
    assert [e['place_id'] for e in ev] == ['A', 'B'] and ev[0]['name_match'] is False


def test_never_takes_top_result_of_different_name():
    st, reason, p, _ = idt.judge(C('焼鳥 地葉'), [P('A', '鳥よし'), P('B', '焼鳥 さいとう')])
    assert st == c.NOT_VERIFIED and p is None and reason == 'name_mismatch'


def test_partial_containment_is_not_identity():
    st, _, p, _ = idt.judge(C('串若丸'), [P('A', '串若')])
    assert st == c.NOT_VERIFIED and p is None
    st, _, p, _ = idt.judge(C('鳥しき'), [P('A', '鳥しげ')])
    assert st == c.NOT_VERIFIED and p is None


def test_branch_conflict_and_correct_branch_selected():
    cand = C('鳥よし 中目黒店', area='中目黒')
    st, reason, p, _ = idt.judge(cand, [P('Y', '鳥よし 祐天寺店', addr=YUTENJI_ADDR)])
    assert st == c.NOT_VERIFIED and reason == 'branch_conflict' and p is None
    st, _, p, _ = idt.judge(cand, [P('Y', '鳥よし 祐天寺店', addr=YUTENJI_ADDR), P('N', '鳥よし 中目黒店', addr=NAKAMEGURO_ADDR)])
    assert st == c.VERIFIED and p['id'] == 'N'


def test_annex_is_different_shop():
    st, _, p, _ = idt.judge(C('喜鈴'), [P('A', '喜鈴 別邸'), P('M', '喜鈴')])
    assert st == c.VERIFIED and p['id'] == 'M'
    st, reason, _, _ = idt.judge(C('喜鈴'), [P('A', '喜鈴 別邸')])
    assert st == c.NOT_VERIFIED and reason == 'branch_conflict'


def test_multiple_same_name_places_ambiguous():
    st, reason, p, _ = idt.judge(C('鳥貴族', area='横浜'), [P('A', '鳥貴族 横浜西口店'), P('B', '鳥貴族 横浜東口店')])
    assert st == c.AMBIGUOUS and reason == 'multiple_matching_places' and p is None


def test_closed_and_unknown_status():
    st, _, p, _ = idt.judge(C('地葉'), [P('A', '地葉', status='CLOSED_PERMANENTLY')])
    assert st == c.CLOSED and p is None
    st, _, _, _ = idt.judge(C('地葉'), [P('A', '地葉', status='CLOSED_TEMPORARILY')])
    assert st == c.CLOSED
    st, reason, p, _ = idt.judge(C('地葉'), [P('A', '地葉', status=None)])
    assert st == c.NOT_VERIFIED and reason == 'business_status_unknown' and p is None


def test_area_unconfirmed_and_other_city():
    st, reason, _, _ = idt.judge(C('地葉', area='横浜駅西口'), [P('A', '地葉', addr='日本、大阪府大阪市北区梅田1丁目')])
    assert st == c.NOT_VERIFIED and reason == 'area_unconfirmed'
    # 「中目黒」は住所に「目黒」として現れる
    st, _, _, _ = idt.judge(C('地葉', area='中目黒駅'), [P('A', '地葉', addr=NAKAMEGURO_ADDR)])
    assert st == c.VERIFIED


def test_genre_conflict():
    st, reason, _, _ = idt.judge(C('地葉'), [P('A', '地葉', types=('lodging',), primary='hotel')])
    assert st == c.NOT_VERIFIED and reason == 'genre_conflict'


def test_no_results():
    st, reason, p, ev = idt.judge(C('地葉'), [])
    assert st == c.NOT_VERIFIED and reason == 'no_results' and p is None and ev == []


def test_evidence_contains_only_ids_and_judgements():
    _, _, _, ev = idt.judge(C('地葉'), [P('A', '地葉')])
    assert set(ev[0]) <= {'place_id', 'name_match', 'branch_conflict', 'area_confirmed', 'food_type',
                          'business_status', 'note'}
