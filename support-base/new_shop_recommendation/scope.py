# -*- coding: utf-8 -*-
"""
M4 R1: 検索範囲の決定と、候補店舗がその範囲に合うかの検証。ユーザーが指定した範囲を優先する。

範囲の種類（Geocoding の結果の種別で決める。キーワード一覧は使わない）:
  area     地域（行政区画・地区・通称）  中心からの半径（viewport の対角の半分、1.5〜10km。「徒歩 N 分」は徒歩圏）
  station  駅                            中心からの半径（同上。駅の viewport は小さいため通常 1.5km、徒歩指定があれば徒歩圏）
  road     道路・通り沿い                通りの範囲（viewport）＋0.3km の帯。市全域には広げない
  facility ホテル・商業施設などの施設内  施設の中の店舗であることを照合する（周辺検索に置き換えない）
             施設から 0.3km 超 → 別店舗。施設の住所（丁目・番地）または施設名が候補の住所・店名にある → 施設内と確認。
             近いが確認できない → 曖昧（選択 LLM で確認。同一店舗とは確定しない）
  unknown  地名・施設を特定できない     地理条件を検証できない。名前が一致しても曖昧扱い（無条件には採用しない）

地名候補の作り方:
  1. 依頼文を空白と「で」「から」「にある」「周辺」で区切り、各区切りをさらに「の」で前後に分けた候補も作る（語末の「の」は区切らない）
  2. 各候補を Geocoding し、地名・施設と認めたものだけを使う（曖昧一致で別の地名に解決されたものを除く）
     候補の一部だけが地名と一致した場合（例: 札幌すすきの → 札幌市）は、残り（すすきの）も確かめ、細かい方を使う
  3. 複数の地名は依頼文の順に連結して Geocoding し、各地名の範囲内なら採用する（例: 京都 祇園、那覇 国際通り）
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
STATION_TYPES = {'train_station', 'transit_station', 'subway_station', 'light_rail_station'}
POLITICAL_TYPES = {'locality', 'sublocality', 'sublocality_level_1', 'sublocality_level_2', 'sublocality_level_3',
                   'sublocality_level_4', 'neighborhood', 'colloquial_area', 'administrative_area_level_1',
                   'administrative_area_level_2', 'ward', 'political'}
FACILITY_KM = 0.3              # 施設内の店舗とみなす最大距離（これを超えると施設外）
ROAD_MARGIN_KM = 0.3           # 通り沿いの帯の幅
BUILDING_TYPES = {'premise', 'subpremise', 'establishment', 'point_of_interest', 'lodging', 'shopping_mall'}
GEO_TYPES = {'locality', 'sublocality', 'sublocality_level_1', 'sublocality_level_2', 'sublocality_level_3',
             'sublocality_level_4', 'neighborhood', 'colloquial_area', 'administrative_area_level_1',
             'administrative_area_level_2', 'ward', 'political', 'train_station', 'transit_station',
             'subway_station', 'light_rail_station', 'route'}


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
            # 空白で区切られた語は 1 文字でも候補にする（例: 名古屋 栄）
            if (len(p) >= 2 or p == seg) and not WALK_RE.search(p) and p not in out:
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


def match_info(cand: str, g):
    """
    Geocoding 結果 g が候補文字列 cand を地名として表しているか。
    returns None（地名ではない）/ ('exact', None) / ('partial', 一致した住所要素名)
      - 地理的な種別: 住所要素の名称（末尾の 都道府県市区町村駅 を除く）と候補が、どちらかに含まれる関係にある
        （候補の方が長い場合は 'partial'。例: 札幌すすきの ⊃ 札幌 → 残りの「すすきの」を別に確かめる）
      - 建物（ホテル・商業施設など）: Geocoding が部分一致（partial_match）でなく、候補が 4 文字以上
    曖昧一致で無関係の地名に解決された結果を除くための条件。
    """
    if not g or g.get('country_code') != 'JP' or g.get('lat') is None:
        return None
    types = set(g.get('types') or [])
    c = _bare(cand)
    if types & GEO_TYPES:
        partial = None
        for n in g.get('component_names') or []:
            b = _bare(n)
            if b == c or (len(b) >= 2 and len(c) >= 2 and c in b):
                return ('exact', None)
            if len(b) >= 2 and len(c) >= 2 and b in c and (partial is None or len(b) > len(partial)):
                partial = b
        return ('partial', partial) if partial else None
    if types & BUILDING_TYPES and not g.get('partial_match') and len(cand) >= 4:
        return ('exact', None)
    return None


def is_place_name(cand: str, g) -> bool:
    return match_info(cand, g) is not None


def radius_km(q: str, viewport):
    m = WALK_RE.search(unicodedata.normalize('NFKC', q or ''))
    if m:
        return max(MIN_WALK_KM, int(m.group(1)) * WALK_KM_PER_MIN * WALK_DETOUR), f'walk_{m.group(1)}min'
    if viewport:
        size = _vp_size_km(viewport)
        if size != float('inf'):
            return min(AREA_MAX_KM, max(AREA_MIN_KM, size / 2)), 'viewport'
    return AREA_DEFAULT_KM, 'default'


def _name_norm(s):
    return PUNCT_RE.sub('', unicodedata.normalize('NFKC', s or ''))


def _lcs_len(a, b):
    best = 0
    prev = [0] * (len(b) + 1)
    for i in range(1, len(a) + 1):
        cur = [0] * (len(b) + 1)
        for j in range(1, len(b) + 1):
            if a[i - 1] == b[j - 1]:
                cur[j] = prev[j - 1] + 1
                best = max(best, cur[j])
        prev = cur
    return best


def facility_name_matches(cand: str, official: str) -> bool:
    """
    施設の正式名（Place Details）と依頼の表記が同じ施設を指すか。
    どちらかに含まれる関係、または共通する連続部分が 5 文字以上で短い方の 6 割以上
    （実地: 依頼「ホテルニューオータニ東京」⇔ 正式名「ホテルニューオータニ ザ・メイン」）
    """
    a, b = _name_norm(cand), _name_norm(official)
    if len(a) < 4 or len(b) < 4:
        return False
    if a in b or b in a:
        return True
    n = _lcs_len(a, b)
    return n >= 5 and n >= 0.6 * min(len(a), len(b))


def resolve_scope(q: str, geocode, place_name=None, max_workers: int = 6) -> dict:
    """
    geocode(text) -> {'lat','lng','viewport','prefecture','country_code','types','component_names','partial_match',
                      'place_id','formatted_address'} | None
    place_name(place_id) -> 正式名 | None（施設の確認に使う。Geocoding が施設名を部分一致としか返さない場合）
    returns {'area','kind','prefecture','center','radius_km','radius_reason','places','geo',...}
    """
    cands = candidates(q)
    with ThreadPoolExecutor(max_workers=max(1, min(max_workers, len(cands) or 1)), thread_name_prefix='scope') as ex:
        geos = list(ex.map(geocode, cands)) if cands else []
    places = []
    for cd, g in zip(cands, geos):
        mi = match_info(cd, g)
        if mi is None and g and set(g.get('types') or []) & BUILDING_TYPES and not set(g.get('types') or []) & GEO_TYPES \
                and place_name and g.get('place_id') and g.get('country_code') == 'JP':
            # 施設: Geocoding は施設名を部分一致としか返さないことがある（実地: ホテルニューオータニ東京）→ Place Details の正式名で確認
            official = place_name(g['place_id'])
            if official and facility_name_matches(cd, official):
                mi = ('exact', None)
        if mi is None:
            continue
        if mi[0] == 'partial' and g.get('partial_match'):
            # Geocoding 自身が部分一致とし、候補の一部だけが地名と一致（実地: 札幌すすきの → 札幌市）。残りを確かめられた場合だけ細かい方を使う。
            # 確かめられなければ、この候補は使わない（一致した広い地名に広げない）
            rest = _bare(cd).replace(mi[1], '', 1).strip()
            g2 = geocode(rest) if len(rest) >= 2 else None
            if g2 is not None and match_info(rest, g2) is not None:
                places += [(mi[1], g), (rest, g2)]
                continue
            both = f'{mi[1]} {rest}'
            g3 = geocode(both) if len(rest) >= 2 else None
            if g3 and not g3.get('partial_match') and kind_of(g3) != 'facility' and g3.get('lat') is not None \
                    and _viewport_contains(g.get('viewport'), (g3['lat'], g3['lng'])) \
                    and _vp_size_km(g3.get('viewport')) < _vp_size_km(g.get('viewport')):
                places.append((both, g3))
            continue
        places.append((cd, g))
    # 「京都の祇園」の候補「京都の祇園」「京都」「祇園」のうち、他の候補に含まれる長い候補は、構成する地名がすべて認められた場合だけ残す
    places = [(cd, g) for cd, g in places
              if not any(o != cd and o in cd for o, _g in places)]
    # 同じ地名は 1 回だけ、依頼文に現れる順に並べる（例: 京都の祇園 → 京都・祇園）
    qn, uniq = unicodedata.normalize('NFKC', q or ''), {}
    for cd, g in places:
        uniq.setdefault(cd, g)
    places = sorted(uniq.items(), key=lambda x: (qn.find(x[0]) if x[0] in qn else len(qn), x[0]))
    chosen, reason = None, 'none'
    if len(places) == 1:
        chosen, reason = places[0], 'single'
    elif places:
        combo = ' '.join(cd for cd, _g in places)
        g = geocode(combo)
        # 連結した地名の結果は、地域・駅・通りの種別で、各地名の範囲内にある場合だけ使う
        # （実地: 「京都 祇園」が施設の種別で返り、半径 0.3km の施設扱いになっていた）
        if g and g.get('country_code') == 'JP' and g.get('lat') is not None and kind_of(g) != 'facility' and all(
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
        return {'area': '', 'kind': 'unknown', 'prefecture': None, 'center': None, 'radius_km': r, 'radius_reason': why,
                'places': [], 'geo': None, 'scope_reason': 'no_place_name'}
    area, g = chosen
    kind = kind_of(g)
    r, why = radius_km(q, g.get('viewport'))
    out = {'area': area, 'kind': kind, 'prefecture': g.get('prefecture'), 'center': (g['lat'], g['lng']), 'radius_km': r,
           'radius_reason': why, 'places': [cd for cd, _g in places], 'scope_reason': reason,
           'geo': {'lat': g['lat'], 'lng': g['lng'], 'region': g.get('prefecture') or '', 'country_code': 'JP'}}
    if kind == 'road':
        out['bbox'] = g.get('viewport')
        out['radius_reason'] = 'road_band'
    elif kind == 'facility':
        out['facility_name'] = area
        out['facility_address_key'] = address_key(g.get('formatted_address') or '', g.get('prefecture'))
        out['radius_km'], out['radius_reason'] = FACILITY_KM, 'facility'
    return out


def kind_of(g):
    types = set(g.get('types') or [])
    if 'route' in types:
        return 'road'
    if types & STATION_TYPES:
        return 'station'
    if types & POLITICAL_TYPES:
        return 'area'
    if types & BUILDING_TYPES:
        return 'facility'
    return 'area'


PUNCT_RE = re.compile(r'[\s・･\-‐ー―−–—_/|｜&＆\'’"“”.,、。!！?？:：~〜()（）]')
DASH_RE = re.compile(r'[‐‑‒–—―−ー－-]')


def norm_address(a: str) -> str:
    a = unicodedata.normalize('NFKC', a or '')
    a = re.sub(r'^日本、?\s*', '', a)
    a = re.sub(r'〒?\d{3}-?\d{4}\s*', '', a)
    a = a.replace('丁目', '-').replace('番地', '-').replace('番', '-').replace('号', '')
    a = DASH_RE.sub('-', a)
    a = re.sub(r'-+', '-', a)
    return re.sub(r'\s+', '', a)


def address_key(formatted: str, prefecture=None) -> str:
    """施設の住所から「町名＋丁目・番地」部分（例: 紀尾井町4-1、六本木6-10-1）を取り出す。取れなければ空"""
    a = norm_address(formatted)
    if prefecture:
        a = a.split(unicodedata.normalize('NFKC', prefecture), 1)[-1]
    m = re.search(r'(?:.+?[市区町村郡])?(?:.+?[区])?([^\d-]+?\d+(?:-\d+)+)', a)
    return m.group(1) if m else ''


def _in_bbox(vp, pt, margin_km):
    return _viewport_contains(vp, pt, margin_km)


def _facility_name_hit(name: str, text: str) -> bool:
    """施設名（依頼文の表記）の 5 文字以上の連続部分が、候補の住所・店名に含まれるか"""
    n, t = unicodedata.normalize('NFKC', name or ''), unicodedata.normalize('NFKC', text or '')
    for k in range(len(n), 4, -1):
        for i in range(0, len(n) - k + 1):
            if n[i:i + k] in t:
                return True
    return False


def geo_verdict(scope: dict, cand: dict):
    """
    候補店舗（Place Details: name・address・lat・lng）が検索範囲に合うか。
    returns (None, 理由) = 合う / ('AMBIGUOUS', 理由) = 確認できない / ('DIFFERENT', 理由) = 範囲外
    """
    kind = (scope or {}).get('kind') or ('unknown' if not (scope or {}).get('center') else 'area')
    if kind == 'unknown':
        return 'AMBIGUOUS', 'geo_unverified'
    if cand.get('lat') is None or cand.get('lng') is None:
        return 'AMBIGUOUS', 'no_coordinates'
    pt = (cand['lat'], cand['lng'])
    if kind == 'road':
        return (None, 'on_road') if _in_bbox(scope.get('bbox'), pt, ROAD_MARGIN_KM) else ('DIFFERENT', 'off_road')
    d = haversine_km(scope['center'], pt)
    if kind == 'facility':
        if d > FACILITY_KM:
            return 'DIFFERENT', 'outside_facility'
        key = scope.get('facility_address_key') or ''
        addr = norm_address(cand.get('address') or '')
        if (key and key in addr) or _facility_name_hit(scope.get('facility_name'), (cand.get('address') or '') + ' ' + (cand.get('name') or '')):
            return None, 'in_facility'
        return 'AMBIGUOUS', 'facility_unconfirmed'
    return (None, 'in_area') if d <= (scope.get('radius_km') or AREA_DEFAULT_KM) else ('DIFFERENT', 'area_mismatch')
