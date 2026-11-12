# -*- coding: utf-8 -*-
"""
[C] Place Verifier の決定的照合ルール（DESIGN.md §4.2〜4.3）。
外部 API を呼ばない純粋関数のみ。閾値は PoC で決める暫定値。
"""
import math
import re
import unicodedata

VERIFIED = 'VERIFIED'
AMBIGUOUS = 'AMBIGUOUS'
NOT_FOUND = 'NOT_FOUND'
CLOSED = 'CLOSED'
ERROR = 'ERROR'

# 暫定閾値（DESIGN.md §4.3）
NAME_VERIFIED = 0.85
NAME_AMBIGUOUS = 0.6
AREA_RADIUS_KM = 2.0
CONTAINMENT_SCORE = 0.75   # 包含のみの一致（AMBIGUOUS 帯。NAME_VERIFIED 未満）

FOOD_TYPES = {'restaurant', 'food', 'bar', 'cafe', 'bakery', 'meal_takeaway', 'meal_delivery'}

# 業態の一般語（コア名から除去。除去後 2 文字未満になる場合は除去しない）
GENERIC_WORDS = [
    '炭火焼鳥', '炭火焼き鳥', '炭火やきとり', '焼き鳥', '焼鳥', 'やきとり', 'ヤキトリ', '串焼き', '串焼',
    '鶏料理', '鳥料理', '居酒屋', '酒場', 'レストラン', 'イタリアン', 'ビストロ', 'トラットリア',
    'リストランテ', 'ピッツェリア', 'カフェ', '割烹', '料亭', '寿司', '鮨', 'すし', '和食', '日本料理',
    'restaurant', 'trattoria', 'ristorante', 'pizzeria', 'bistro', 'cafe', 'caffe', 'osteria',
]

# 別館・2号店など「同じ屋号の別店舗」を示す語（片方にだけあれば同一店舗とみなさない）
ANNEX_PATTERN = re.compile(r'(別館|新館|分店|離れ|はなれ|annex|[0-9一二三四五六七八九十]+号店)')


def _to_hiragana(s):
    # カタカナ（ァ〜ヶ）をひらがなに揃える（表記揺れ対策）
    return ''.join(chr(ord(c) - 0x60) if 'ァ' <= c <= 'ヶ' else c for c in s)


GENERIC_WORDS = sorted({_to_hiragana(unicodedata.normalize('NFKC', w).lower()) for w in GENERIC_WORDS},
                       key=len, reverse=True)

_BRACKETS = re.compile(r'[\(（【\[「『]([^\)）】\]」』]*)[\)）】\]」』]')
_SYMBOLS = re.compile(r"[\s　・･\-‐－ー―~〜～'’`\".,、。!！?？&＆/／:：;；@＠#＃*＊+＋|｜]")


def _nfkc(s):
    return unicodedata.normalize('NFKC', s or '').lower().strip()


def split_brackets(name):
    """'Baird Beer (ベアードビール)' -> ('Baird Beer', ['ベアードビール'])"""
    n = _nfkc(name)
    inner = [m.strip() for m in _BRACKETS.findall(n) if m.strip()]
    outer = _BRACKETS.sub(' ', n).strip()
    return outer, inner


def split_branch(text, area=''):
    """
    末尾の支店名を分離する。(本体, 支店名 or '')
    - 空白区切りの最終語が '店' で終わる（'中目黒店' '本店' 等）
    - または '{area}店' / '{area}本店' / '{area}支店' で終わる
    """
    t = text.strip()
    branch = ''
    area_n = _nfkc(area)
    tokens = t.split()
    if len(tokens) > 1 and tokens[-1].endswith('店'):
        branch = tokens[-1]
        t = ' '.join(tokens[:-1])
    elif area_n:
        for suffix in (area_n + '店', area_n + '本店', area_n + '支店'):
            if t.endswith(suffix) and len(t) > len(suffix):
                branch = suffix
                t = t[:-len(suffix)].strip()
                break
    return t, branch


def _strip_branch(text, area=''):
    return split_branch(text, area)[0]


def branch_info(name, area=''):
    """(支店名の正規化値 or '', 別館等の表示があるか)"""
    outer, _inner = split_brackets(name)
    _body, branch = split_branch(outer, area)
    b = _SYMBOLS.sub('', _to_hiragana(branch))
    return b, bool(ANNEX_PATTERN.search(_nfkc(name)))


def core_name(text, area=''):
    t = _strip_branch(_nfkc(text), area)
    compact = _to_hiragana(_SYMBOLS.sub('', t))
    for w in GENERIC_WORDS:
        w_c = _SYMBOLS.sub('', w)
        if w_c and w_c in compact:
            reduced = compact.replace(w_c, '')
            if len(reduced) >= 2:
                compact = reduced
    return compact


def name_forms(name, variants=None, area=''):
    """照合に使うコア名の集合（本体・括弧内・別表記）"""
    forms = set()
    for raw in [name] + list(variants or []):
        if not raw:
            continue
        outer, inner = split_brackets(raw)
        for part in [outer] + inner:
            c = core_name(part, area)
            if c:
                forms.add(c)
    return forms


def _bigrams(s):
    return [s[i:i + 2] for i in range(len(s) - 1)] if len(s) > 1 else [s]


def pair_score(a, b):
    if not a or not b:
        return 0.0
    if a == b:
        return 1.0
    short, long_ = (a, b) if len(a) <= len(b) else (b, a)
    # 包含だけの一致は VERIFIED にしない（「串若」と「串若丸」のような近接した別店舗を防ぐ）
    if len(short) >= 2 and short in long_ and len(short) / len(long_) >= 0.5:
        return CONTAINMENT_SCORE
    ba, bb = _bigrams(a), _bigrams(b)
    pool = list(bb)
    inter = 0
    for g in ba:
        if g in pool:
            pool.remove(g)
            inter += 1
    return 2.0 * inter / (len(ba) + len(bb))


def name_score(cand_forms, place_forms):
    best = 0.0
    for a in cand_forms:
        for b in place_forms:
            best = max(best, pair_score(a, b))
    return round(best, 3)


def haversine_km(lat1, lng1, lat2, lng2):
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = math.radians(lat2 - lat1), math.radians(lng2 - lng1)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def location_ok(place, area, area_center=None, radius_km=AREA_RADIUS_KM):
    """
    (一致したか, 距離km or None, 判定方法)
    area_center は (lat, lng)、None、または中心座標を返す関数。
    住所にエリア名があればそれで確定し、中心座標（Geocoding）は待たない。
    住所で確認できない場合だけ中心座標を取得して距離で判定する。
    """
    addr = _nfkc(place.get('formatted_address', '') or place.get('vicinity', ''))
    area_n = _nfkc(area)
    if area_n and area_n in addr:
        return True, None, 'address'
    center = area_center() if callable(area_center) else area_center
    loc = (place.get('geometry') or {}).get('location') or {}
    if center and loc.get('lat') is not None and loc.get('lng') is not None:
        dist = round(haversine_km(center[0], center[1], loc['lat'], loc['lng']), 3)
        return dist <= radius_km, dist, 'distance'
    return False, None, 'unavailable'


def is_food(place):
    return bool(FOOD_TYPES & set(place.get('types') or []))


def classify(candidate, places, area, area_center=None):
    """
    candidate: {'name', 'name_variants', 'area'}
    places: Text Search の results（順位は使わない）
    returns: (status, best_place or None, detail dict)
    """
    c_area = candidate.get('area') or area
    cand_forms = name_forms(candidate.get('name', ''), candidate.get('name_variants'), c_area)
    cand_branches = set()
    cand_annex = False
    for i, nm in enumerate([candidate.get('name', '')] + list(candidate.get('name_variants') or [])):
        b, annex = branch_info(nm, c_area)
        if b:
            cand_branches.add(b)
        if i == 0:
            cand_annex = annex
    evaluated = []
    for p in places[:5]:
        p_forms = name_forms(p.get('name', ''), None, c_area)
        raw_score = name_score(cand_forms, p_forms)
        p_branch, p_annex = branch_info(p.get('name', ''), c_area)
        # 支店名が両方にあって異なる、または別館・号店の表示が片方だけ → 同一店舗とみなさない
        conflict = bool((cand_branches and p_branch and p_branch not in cand_branches) or (cand_annex != p_annex))
        s = min(raw_score, NAME_AMBIGUOUS) if conflict else raw_score
        status = p.get('business_status') or 'OPERATIONAL'
        e = {'place': p, 'score': s, 'raw_score': raw_score, 'branch_conflict': conflict,
             'food': is_food(p), 'business_status': status, 'location': False, 'distance_km': None,
             'location_method': 'skipped'}
        if s >= NAME_AMBIGUOUS:   # 名前が近い結果だけ位置を確認する（不要な Geocoding 待ちをしない）
            e['location'], e['distance_km'], e['location_method'] = location_ok(p, c_area, area_center)
        evaluated.append(e)

    def summary(e):
        return {'place_id': e['place'].get('place_id'), 'place_name': e['place'].get('name'),
                'score': e['score'], 'raw_score': e['raw_score'], 'branch_conflict': e['branch_conflict'],
                'location': e['location'], 'distance_km': e['distance_km'],
                'location_method': e['location_method'], 'food': e['food'],
                'business_status': e['business_status']}

    detail = {'candidate_forms': sorted(cand_forms), 'evaluated': [summary(e) for e in evaluated]}
    strong = [e for e in evaluated if e['score'] >= NAME_VERIFIED and e['location']]
    verified = [e for e in strong if e['food'] and e['business_status'] == 'OPERATIONAL']
    verified_ids = {e['place'].get('place_id') for e in verified}

    if len(verified_ids) == 1:
        best = max(verified, key=lambda e: e['score'])
        detail['chosen'] = summary(best)
        return VERIFIED, best['place'], detail
    if len(verified_ids) > 1:
        detail['reason'] = 'multiple_verified_places'
        return AMBIGUOUS, None, detail
    closed = [e for e in strong if e['business_status'] in ('CLOSED_PERMANENTLY', 'CLOSED_TEMPORARILY')]
    if closed:
        detail['chosen'] = summary(closed[0])
        return CLOSED, None, detail
    if any(e['score'] >= NAME_AMBIGUOUS for e in evaluated):
        detail['reason'] = 'weak_match'
        return AMBIGUOUS, None, detail
    return NOT_FOUND, None, detail
