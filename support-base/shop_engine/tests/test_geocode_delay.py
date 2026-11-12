# -*- coding: utf-8 -*-
"""
修正1: Geocoding が遅延しても、候補の Places 照合（text_search）は待たずに開始されること。
住所にエリア名が含まれる店は Geocoding を待たずに確定し、住所で判定できない店だけが中心座標を待つ。
"""
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

import test_pipeline as tp  # noqa: E402

GEO_DELAY = 2.0


class SlowGeoPlaces(tp.FakePlaces):
    def __init__(self, db, geo_delay=GEO_DELAY, geo_result=tp.CENTER):
        super().__init__(db)
        self.geo_delay = geo_delay
        self.geo_result = geo_result
        self.geo_done_at = None
        self.timeout = 5.0

    def geocode(self, area, language='ja'):
        time.sleep(self.geo_delay)
        self.geo_done_at = time.monotonic()
        return self.geo_result


def lines():
    return [tp.plan_line()] + [tp.cand_line(i, n) for i, n in enumerate(tp.NAMES, 1)] + ['{"type":"end"}']


def test_places_search_starts_before_geocode_finishes():
    places = SlowGeoPlaces(tp.full_db())
    t_start = time.monotonic()
    result, events, _ = tp.run(tp.FakeModels(lines(), chunk_delay=0.005), places)
    assert places.first_query_at is not None
    # 最初の Places 照会は Geocoding 完了（約2秒後）より前に始まる
    assert places.first_query_at - t_start < 1.0
    assert places.first_query_at < places.geo_done_at
    # 住所にエリア名（目黒区上目黒…に「中目黒」は無い）→ 距離判定が必要な店は中心座標を待つ
    assert result['status'] == 'ok' and len(result['cards']) == 5


def test_cards_not_blocked_by_geocode_when_address_contains_area():
    db = tp.full_db()
    for v in db.values():
        for p in v:
            p['formatted_address'] = '東京都目黒区上目黒1丁目 中目黒駅前'
    places = SlowGeoPlaces(db)
    result, _, _ = tp.run(tp.FakeModels(lines(), chunk_delay=0.005), places)
    assert result['status'] == 'ok'
    # 住所で位置が確認できるので、初回カードは Geocoding 完了を待たない
    assert result['timings']['T5'] < GEO_DELAY - 0.5


def test_geocode_failure_falls_back_to_address_only():
    places = SlowGeoPlaces(tp.full_db(), geo_delay=0.0, geo_result=None)
    result, _, _ = tp.run(tp.FakeModels(lines(), chunk_delay=0.005), places)
    # 住所に「中目黒」が無く、中心座標も無いので位置を確認できない → VERIFIED にしない
    assert result['cards'] == []
    assert all(v['status'] != 'VERIFIED' for v in result['verifications'])
