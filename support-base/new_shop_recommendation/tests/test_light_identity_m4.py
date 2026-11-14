# -*- coding: utf-8 -*-
"""M4 R2〜R4: 軽量判定の修正（製品版 light_identity）。M3 再現用の poc 版は変更しない"""
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from new_shop_recommendation import light_identity as L  # noqa: E402
from new_shop_recommendation.poc import light_identity as P  # noqa: E402


def cand(name, types=('restaurant', 'food'), status='OPERATIONAL', addr=''):
    return {'name': name, 'address': addr, 'types': list(types), 'business_status': status}


# ------------------------------------------------------------------ R2
@pytest.mark.parametrize('rec,name,want', [
    ('松葉地下店', '串かつ松葉 ルクア大阪店', True),                       # M3 試行 30（選択 LLM の誤採用）
    ('鳥ぎん 横浜関内店', '鳥ぎん みなとみらい店', True),
    ('珈琲専門店 シャルマン 桜丘店', 'シャルマン 本店', False),             # 本店は通称と区別できないため矛盾としない
    ('串かつ 松葉 新梅田食道街店', '串かつ松葉 総本店', False),            # 同一店（総本店は新梅田食道街）
    ('串かつ だるま ルクア大阪店', '元祖串かつ だるま ルクアイーレ店', False),  # 同一店（共通の「ルクア」）
    ('ABOUT LIFE COFFEE BREWERS 渋谷一丁目', 'ABOUT LIFE COFFEE BREWERS 渋谷一丁目店', False),
    ('斑鳩', '東京駅 斑鳩', False),                                         # 推薦名に支店名なし
])
def test_r2_branch_conflict_clear(rec, name, want):
    assert L.branch_conflict_clear(rec, name) is want


# ------------------------------------------------------------------ R3
@pytest.mark.parametrize('rec,name', [
    ('天ぷら 新宿 綱八 京王店', '天ぷら新宿つな八 京王新宿店'),
    ('美濃吉 新宿住友店', '日本料理 京懐石 みのきち 新宿住友店'),
    ('中目黒 炭火焼鳥 塚田', '焼鳥つかだ 中目黒店'),
])
def test_r3_kana_kanji_goes_to_llm_not_same(rec, name):
    assert P.judge(rec, cand(name), None)[0] == 'DIFFERENT'          # v0.2 は別店舗と判定していた
    assert L.judge(rec, cand(name), None) == ('AMBIGUOUS', 'kana_kanji')   # 同一店とは確定しない


def test_r3_keeps_unrelated_different():
    assert L.judge('焼鳥 幸羽', cand('焼鳥 美鶏'), None) == ('DIFFERENT', 'name_unrelated')
    assert L.reading_variant_possible('綱八', 'つな八') and not L.reading_variant_possible('つな八', '綱八')


# ------------------------------------------------------------------ R4
def test_r4_quoted_name_must_match():
    rec = 'ジンギスカン 羊飼いの店 『白老亭』'
    other = cand('ジンギスカン 羊飼いの店 『いただきます。』')
    assert P.judge(rec, other, None)[0] == 'SAME'                       # v0.2 は括弧外の共通部分で SAME だった
    assert L.judge(rec, other, None) == ('AMBIGUOUS', 'quoted_name_mismatch')


@pytest.mark.parametrize('rec', ['ジンギスカン 羊飼いの店 『いただきます。』', 'ジンギスカン 羊飼いの店 『いただきま〜す』',
                                 'ジンギスカン 羊飼いの店 『いただきまーす』', 'いただきます。'])
def test_r4_keeps_correct_quoted_matches(rec):
    assert L.judge(rec, cand('ジンギスカン 羊飼いの店 『いただきます。』'), None)[0] == 'SAME'
