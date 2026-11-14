# -*- coding: utf-8 -*-
"""設計 v0.2 の軽量同一性判定（参照実装）とオフライン評価のテスト（外部 API なし）"""
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from new_shop_recommendation.poc import eval_v02_offline as ev  # noqa: E402
from new_shop_recommendation.poc import light_identity as L  # noqa: E402

TOKYO = ['中央区', '渋谷区', '新宿区']


@pytest.mark.parametrize('rec,name,addr,expect', [
    ('茶亭 羽當', '茶亭 羽當', '東京都渋谷区渋谷', (L.SAME, 'core_name_equal')),
    ('天朝', '銀座 天あさ', '東京都中央区銀座', (L.DIFFERENT, 'name_unrelated')),                 # 別店舗
    ('日本料理 水天一碧', '鮨 水天一碧', '東京都中央区銀座', None),                                   # 別地区（下で確認）
    ('焼鳥 幸羽', '焼き鳥幸羽（こはね）', '静岡県浜松市中区千歳町', (L.DIFFERENT, 'prefecture_mismatch')),
    ('新宿 車屋', '日本料理 車屋別館', '東京都新宿区新宿', (L.AMBIGUOUS, 'annex')),
    ('トスカーナ 吉祥寺店', "Italian Bar'R TOSCANA 吉祥寺店", '東京都中央区銀座', (L.AMBIGUOUS, 'script_differs')),
    ('ラーメン 雷 東京本丸店', '雷 東京本丸店 東京駅構内', '東京都中央区銀座', (L.AMBIGUOUS, 'short_core')),
    ('炭火やきとり 伝兵衛', '炭火やきとり 伝兵衛本店', '東京都中央区銀座', (L.SAME, 'core_name_equal')),
    ('ソラのいろ NIPPON', '［SORANOIRO NIPPON ］そらのいろNIPPON［TOKYO STATION RAMEN］', '東京都中央区', (L.SAME, 'core_name_equal')),
    ('天ぷら 新宿つな八 総本店', '天ぷら新宿つな八 総本店 別館', '東京都新宿区新宿', (L.AMBIGUOUS, 'name_partial')),
])
def test_rules(rec, name, addr, expect):
    if expect is None:
        assert L.judge(rec, {'name': name, 'address': addr}, '東京都', allowed_municipalities=['新宿区']) == \
            (L.DIFFERENT, 'area_mismatch')
        return
    assert L.judge(rec, {'name': name, 'address': addr}, '東京都', allowed_municipalities=TOKYO + ['武蔵野市']) == expect


def test_closed_and_not_a_store_and_distance():
    base = {'name': '茶亭 羽當', 'address': '東京都渋谷区渋谷'}
    assert L.judge('茶亭 羽當', dict(base, business_status='CLOSED_PERMANENTLY'), '東京都')[1] == 'closed'
    assert L.judge('音音', {'name': '新宿センタービル別館', 'address': '東京都新宿区', 'types': ['premise', 'point_of_interest']},
                   '東京都')[1] == 'not_a_store'                                          # 建物は別店舗
    assert L.judge('六厘舎', {'name': '東京ラーメンストリート', 'address': '東京都千代田区',
                             'types': ['shopping_mall', 'point_of_interest']}, '東京都')[1] == 'not_a_store'
    assert L.judge('茶亭 羽當', dict(base, types=['cafe', 'food'], lat=35.6595, lng=139.7040), '東京都',
                   area_center=(35.6580, 139.7016))[0] == L.SAME
    assert L.judge('茶亭 羽當', dict(base, types=['cafe'], lat=35.6717, lng=139.7650), '東京都',
                   area_center=(35.6580, 139.7016))[1] == 'area_mismatch'                    # 約 6km 離れた銀座


def test_fixture_pairs_no_wrong_same():
    """照合済み 132 件で SAME と判定したものに別店舗（X）が無いこと（規則を同じデータで調整しているため回帰確認として）"""
    pairs = ev.load_pairs()
    assert len(pairs) == 132
    bad = [p['rid'] for p in pairs if ev.judge_pair(p)[0] == L.SAME and p['label'] == 'X']
    wrong_reject = [p['rid'] for p in pairs if ev.judge_pair(p)[0] == L.DIFFERENT and p['label'] == 'O']
    assert bad == [] and wrong_reject == []


def test_group_tally_and_simulation_reproducible():
    groups = ev.group_outcomes(ev.load_pairs())
    assert ev.tally(groups, 'light') == (67, 0, 4, 14)
    assert ev.tally(groups, 'light_esc') == (79, 1, 7, 2)
    assert ev.tally(groups, 'D') == (77, 4, 7, 4)
    data = json.load(open(os.path.join(os.path.dirname(ev.__file__), 'v02_timing_data.json'), encoding='utf-8'))
    a = ev.simulate(groups, data, 'light_esc', iters=500, seed=1)
    b = ev.simulate(groups, data, 'light_esc', iters=500, seed=1)
    assert a == b and a['n'] == 500
