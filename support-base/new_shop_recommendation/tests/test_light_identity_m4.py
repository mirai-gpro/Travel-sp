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
