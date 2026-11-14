# -*- coding: utf-8 -*-
"""
M4 R1: 検索範囲（地名・中心・半径）の決定。ユーザーが指定した範囲を優先する。

M3 で判明した誤り:
  「銀座で評判の老舗」「新宿で接待向け」「吉祥寺で子連れ」「札幌すすき」のように地名以外を含む／途中で切れた文字列を
  Geocoding に渡していた。また「京都の祇園」「大阪 梅田」は粗い方（京都・大阪 → 半径 10km）になっていた。

方式（キーワード一覧は使わず、Geocoding の結果で地名かどうかを確かめる）:
  1. 依頼文を空白と「で」「から」「にある」「周辺」で区切り、各区切りをさらに「の」で前後に分けた候補も作る
     （語末の「の」は区切らない: すすきの）
  2. 各候補を Geocoding し、次をすべて満たすものだけを「地名」と認める
       - 日本の結果
       - 種別が行政区画・地区・駅などの地理的なもの（店舗・施設だけの結果は不可）
       - 結果の住所要素の名称と候補が、どちらかに含まれる関係にある（末尾の都道府県市区町村駅は除いて比較）。
         曖昧一致で別の地名に解決されたものを除く
  3. 認めた地名を依頼文の順に連結して Geocoding し、結果が各地名の範囲内にあればそれを採用する（例: 京都 祇園 → 祇園）。
     範囲外なら、他のすべての地名の範囲内にある最も狭い地名を採用する
  4. 半径: 「徒歩 N 分」→ 徒歩圏（M3 と同じ）、それ以外 → 採用した地名の viewport の対角の半分（1.5〜10km、M3 と同じ）
"""
import math
import re
import unicodedata
from concurrent.futures import ThreadPoolExecutor

WALK_RE = re.compile(r'徒歩\s*(\d+)\s*分')
WALK_KM_PER_MIN = 0.08          # 不動産表示の徒歩 1 分 = 80m（M3 と同じ）
WALK_DETOUR = 1.5
MIN_WALK_KM = 0.6
AREA_MIN_KM, AREA_MAX_KM, AREA_DEFAULT_KM = 1.5, 10.0, 3.0
SPLIT_RE = re.compile(r'\s+|で|から|にある|周辺')
GEO_TYPES = {'locality', 'sublocality', 'sublocality_level_1', 'sublocality_level_2', 'sublocality_level_3',
             'sublocality_level_4', 'neighborhood', 'colloquial_area', 'administrative_area_level_1',
             'administrative_area_level_2', 'ward', 'political', 'train_station', 'transit_station',
             'subway_station', 'light_rail_station'}


def haversine_km(a, b):
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 6371 * 2 * math.asin(math.sqrt(h))


def candidates(q: str):
    """依頼文から地名候補（依頼文の順・重複なし）"""
    t = unicodedata.normalize('NFKC', q or '')
    out = []
    for seg in SPLIT_RE.split(t):
        seg = seg.strip()
        if not seg:
            continue
        parts = [seg]
        if 'の' in seg[:-1]:
            parts += [p for p in re.split(r'の(?!$)', seg) if p]
        for p in parts:
            if len(p) >= 2 and not WALK_RE.search(p) and p not in out:
                out.append(p)
    return out


def _viewport_contains(vp, pt, margin_km=0.5):
    if not vp or not pt:
        return False
    ne, sw = vp.get('northeast') or {}, vp.get('southwest') or {}
    if not ne or not sw:
        return False
    lat_m, lng_m = margin_km / 111.0, margin_km / (111.0 * max(0.2, math.cos(math.radians(pt[0]))))
    return sw['lat'] - lat_m <= pt[0] <= ne['lat'] + lat_m and sw['lng'] - lng_m <= pt[1] <= ne['lng'] + lng_m


def _vp_size_km(vp):
    ne, sw = (vp or {}).get('northeast') or {}, (vp or {}).get('southwest') or {}
    if not ne or not sw:
        return float('inf')
    return haversine_km((ne['lat'], ne['lng']), (sw['lat'], sw['lng']))


SUFFIX_RE = re.compile(r'(都|道|府|県|市|区|町|村|駅)$')


def _bare(s):
    s = unicodedata.normalize('NFKC', s or '').strip()
    return SUFFIX_RE.sub('', s) if len(s) > 2 else s


def is_place_name(cand: str, g) -> bool:
    """
    Geocoding 結果 g が候補文字列 cand を地名として表しているか。
    住所要素の名称（末尾の 都道府県市区町村駅 を除いたもの）と候補が、どちらかに含まれる関係にある場合だけ認める
    （例: 東京駅 ⇔ 東京都、札幌すすきの ⇔ すすきの）。曖昧一致で無関係の地名に解決された結果を除くため。
    """
    if not g or g.get('country_code') != 'JP' or g.get('lat') is None:
        return False
    if not set(g.get('types') or []) & GEO_TYPES:
        return False
    c = _bare(cand)
    for n in g.get('component_names') or []:
        b = _bare(n)
        if len(b) >= 2 and len(c) >= 2 and (b in c or c in b):
            return True
    return False


def radius_km(q: str, viewport):
    m = WALK_RE.search(unicodedata.normalize('NFKC', q or ''))
    if m:
        return max(MIN_WALK_KM, int(m.group(1)) * WALK_KM_PER_MIN * WALK_DETOUR), f'walk_{m.group(1)}min'
    if viewport:
        size = _vp_size_km(viewport)
        if size != float('inf'):
            return min(AREA_MAX_KM, max(AREA_MIN_KM, size / 2)), 'viewport'
    return AREA_DEFAULT_KM, 'default'


def resolve_scope(q: str, geocode, max_workers: int = 6) -> dict:
    """
    geocode(text) -> {'lat','lng','viewport','prefecture','country_code','types','component_names'} | None
    returns {'area','prefecture','center','radius_km','radius_reason','places','geo'}
    """
    cands = candidates(q)
    with ThreadPoolExecutor(max_workers=max(1, min(max_workers, len(cands) or 1)), thread_name_prefix='scope') as ex:
        geos = list(ex.map(geocode, cands)) if cands else []
    places = [(cd, g) for cd, g in zip(cands, geos) if is_place_name(cd, g)]
    # 「京都の祇園」の候補「京都の祇園」「京都」「祇園」のうち、他の候補に含まれる長い候補は、構成する地名がすべて認められた場合だけ残す
    places = [(cd, g) for cd, g in places
              if not any(o != cd and o in cd for o, _g in places)]
    chosen, reason = None, 'none'
    if len(places) == 1:
        chosen, reason = places[0], 'single'
    elif places:
        combo = ' '.join(cd for cd, _g in places)
        g = geocode(combo)
        if g and g.get('country_code') == 'JP' and g.get('lat') is not None and all(
                _viewport_contains(pg.get('viewport'), (g['lat'], g['lng'])) for _cd, pg in places):
            chosen, reason = (combo, g), 'combined'
        else:
            inside = [(cd, pg) for cd, pg in places
                      if all(_viewport_contains(og.get('viewport'), (pg['lat'], pg['lng'])) for oc, og in places if oc != cd)]
            pool = inside or places
            chosen = min(pool, key=lambda x: _vp_size_km(x[1].get('viewport')))
            reason = 'narrowest_inside' if inside else 'narrowest'
    if not chosen:
        r, why = radius_km(q, None)
        return {'area': '', 'prefecture': None, 'center': None, 'radius_km': r, 'radius_reason': why,
                'places': [], 'geo': None, 'scope_reason': 'no_place_name'}
    area, g = chosen
    r, why = radius_km(q, g.get('viewport'))
    return {'area': area, 'prefecture': g.get('prefecture'), 'center': (g['lat'], g['lng']), 'radius_km': r,
            'radius_reason': why, 'places': [cd for cd, _g in places], 'scope_reason': reason,
            'geo': {'lat': g['lat'], 'lng': g['lng'], 'region': g.get('prefecture') or '', 'country_code': 'JP'}}
