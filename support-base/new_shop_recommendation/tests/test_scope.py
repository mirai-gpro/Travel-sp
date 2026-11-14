# -*- coding: utf-8 -*-
"""M4 R1: 検索範囲の決定（偽の Geocoding。外部 API なし）"""
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from new_shop_recommendation import scope as S  # noqa: E402


def vp(lat, lng, d):
    return {'northeast': {'lat': lat + d, 'lng': lng + d}, 'southwest': {'lat': lat - d, 'lng': lng - d}}


def G(lat, lng, d, pref, names, types=('locality', 'political')):
    return {'lat': lat, 'lng': lng, 'viewport': vp(lat, lng, d), 'prefecture': pref, 'country_code': 'JP',
            'types': list(types), 'component_names': list(names)}


GEO = {
    '銀座': G(35.671, 139.765, 0.006, '東京都', ['銀座', '中央区', '東京都']),
    '新宿': G(35.690, 139.700, 0.02, '東京都', ['新宿区', '東京都']),
    '吉祥寺': G(35.703, 139.580, 0.01, '東京都', ['吉祥寺本町', '武蔵野市', '東京都']),
    '東京駅': G(35.681, 139.767, 0.003, '東京都', ['丸の内', '千代田区', '東京都'], ('train_station', 'transit_station')),
    '中目黒': G(35.644, 139.699, 0.006, '東京都', ['上目黒', '目黒区', '東京都']),
    '札幌すすきの': G(43.055, 141.353, 0.005, '北海道', ['すすきの', '中央区', '札幌市', '北海道'], ('colloquial_area', 'political')),
    '京都': G(35.012, 135.768, 0.15, '京都府', ['京都市', '京都府']),
    '祇園': G(35.004, 135.775, 0.005, '京都府', ['祇園町', '東山区', '京都市', '京都府'], ('sublocality', 'political')),
    '京都 祇園': G(35.004, 135.775, 0.005, '京都府', ['祇園町', '東山区', '京都市', '京都府'], ('sublocality', 'political')),
    '大阪': G(34.69, 135.50, 0.15, '大阪府', ['大阪市', '大阪府']),
    '梅田': G(34.702, 135.497, 0.006, '大阪府', ['梅田', '北区', '大阪市', '大阪府'], ('sublocality', 'political')),
    '大阪 梅田': G(34.702, 135.497, 0.006, '大阪府', ['梅田', '北区', '大阪市', '大阪府'], ('sublocality', 'political')),
    '横浜': G(35.444, 139.638, 0.08, '神奈川県', ['横浜市', '神奈川県']),
    '渋谷': G(35.659, 139.700, 0.015, '東京都', ['渋谷区', '東京都']),
    # 曖昧一致で別の地名に解決された例（地名ではない語）
    '評判': G(35.0, 135.0, 0.01, '京都府', ['京都市', '京都府']),
    '老舗': None,
    '接待向け': G(35.68, 139.76, 1.0, '東京都', ['日本'], ('country', 'political')),
}


def geo(text):
    return GEO.get(text)


@pytest.mark.parametrize('q,area,why', [
    ('銀座で評判の老舗の天ぷら店', '銀座', 'single'),
    ('新宿で接待向けの個室がある和食 予算1人1万5千円 4名', '新宿', 'single'),
    ('吉祥寺で子連れの家族でも行きやすいイタリアン', '吉祥寺', 'single'),
    ('札幌すすきので美味しいジンギスカン', '札幌すすきの', 'single'),
    ('京都の祇園で記念日に行くカウンター割烹 予算1人2万円 2名', '京都 祇園', 'combined'),
    ('大阪 梅田 串カツ 立ち飲み', '大阪 梅田', 'combined'),
    ('中目黒 焼き鳥 予算1人5000円 2名', '中目黒', 'single'),
    ('横浜で美味しい焼き鳥屋を5軒', '横浜', 'single'),
])
def test_m3_queries_resolve_to_user_area(q, area, why):
    s = S.resolve_scope(q, geo)
    assert s['area'] == area and s['scope_reason'] == why
    assert s['radius_km'] <= 10.0


def test_walk_radius_and_station():
    s = S.resolve_scope('東京駅から徒歩5分以内の美味しいラーメン', geo)
    assert s['area'] == '東京駅' and s['radius_km'] == pytest.approx(0.6) and s['radius_reason'] == 'walk_5min'


def test_fine_area_radius_is_small():
    s = S.resolve_scope('大阪 梅田 串カツ 立ち飲み', geo)
    assert s['radius_km'] == pytest.approx(1.5)                     # M3 は「大阪」で 10km だった


def test_candidates_do_not_split_trailing_no():
    assert '札幌すすき' not in S.candidates('札幌すすきので美味しいジンギスカン')
    assert {'京都の祇園', '京都', '祇園'} <= set(S.candidates('京都の祇園で記念日'))


def test_no_place_name():
    s = S.resolve_scope('美味しいお店', geo)
    assert s['area'] == '' and s['scope_reason'] == 'no_place_name' and s['center'] is None


def test_single_char_area_and_building():
    geo2 = dict(GEO)
    geo2['名古屋'] = G(35.18, 136.90, 0.1, '愛知県', ['名古屋市', '愛知県'])
    geo2['栄'] = G(35.17, 136.91, 0.006, '愛知県', ['栄', '中区', '名古屋市', '愛知県'], ('sublocality', 'political'))
    geo2['名古屋 栄'] = geo2['栄']
    s = S.resolve_scope('名古屋 栄 ひつまぶし 予算1人5000円', geo2.get)
    assert s['area'] == '名古屋 栄' and s['scope_reason'] == 'combined'
    hotel = dict(G(35.680, 139.733, 0.002, '東京都', ['紀尾井町', '千代田区', '東京都'], ('establishment', 'lodging', 'point_of_interest')),
                 formatted_address='日本、〒102-8578 東京都千代田区紀尾井町4-1', partial_match=False)
    geo2['ホテルニューオータニ東京'] = hotel
    s2 = S.resolve_scope('ホテルニューオータニ東京の中で接待に使える鉄板焼き 4名', geo2.get)
    assert s2['area'] == 'ホテルニューオータニ東京' and s2['radius_km'] == pytest.approx(1.5)
    assert not S.is_place_name('接待に使える鉄板焼き', dict(hotel, partial_match=True))


def test_partial_area_is_split_to_finer_place():
    # M4 事前確認の実地結果: 「札幌すすきの」が札幌市（半径 10km）に解決されていた
    geo3 = dict(GEO)
    geo3['札幌すすきの'] = G(43.06, 141.35, 0.15, '北海道', ['札幌市', '北海道'])
    geo3['すすきの'] = G(43.055, 141.353, 0.005, '北海道', ['すすきの', '中央区', '札幌市', '北海道'], ('neighborhood', 'political'))
    geo3['札幌 すすきの'] = geo3['すすきの']
    s = S.resolve_scope('札幌すすきので美味しいジンギスカン', geo3.get)
    assert s['area'] == '札幌 すすきの' and s['radius_km'] == pytest.approx(1.5) and s['scope_reason'] == 'combined'


def test_route_name():
    geo4 = dict(GEO)
    geo4['那覇'] = G(26.21, 127.68, 0.06, '沖縄県', ['那覇市', '沖縄県'])
    geo4['国際通り'] = G(26.215, 127.69, 0.004, '沖縄県', ['国際通り', '那覇市', '沖縄県'], ('route',))
    geo4['那覇 国際通り'] = geo4['国際通り']
    s = S.resolve_scope('那覇の国際通りで沖縄料理 3名', geo4.get)
    assert s['area'] == '那覇 国際通り' and s['radius_km'] == pytest.approx(1.5)
