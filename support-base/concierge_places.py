# -*- coding: utf-8 -*-
"""
コンシェルジュの照合と表示用データ（R1.4 最終版 §3.2〜§3.4・§4.4・§8.4）

- Places（旧版 Text Search）は「今その名前でその場所に営業しているか」を確かめるだけに使う。
- 同一性判定に LLM は使わない。結果をすべて 5 条件（名前・支店・場所・業態・営業）で調べる。
- 採用するのは「同じ店」だけで、別の店への置き換えはしない。
- Places の値は LLM にも外部リンクの問い合わせにも使わない（問い合わせは LLM の店名と地域）。
- 既存の api_integrations の関数は変更せず呼ぶ。
"""
import logging
import math
import re
import unicodedata
from concurrent.futures import ThreadPoolExecutor

import requests

import api_integrations

logger = logging.getLogger(__name__)

# 旧版 Places Text Search（api_integrations.search_place と同じエンドポイント）
TEXT_SEARCH_URL = 'https://maps.googleapis.com/maps/api/place/textsearch/json'
PHOTO_URL = 'https://maps.googleapis.com/maps/api/place/photo'

# 各要求の待ち時間は現行（search_place）と同じ 10 秒（§3.2）
REQUEST_TIMEOUT_SEC = 10
# 1 段あたり同時に呼ぶ Places の数（§3.2）
MAX_PARALLEL = 8
# 位置バイアスの半径は現行（search_place）と同じ
RADIUS_JP_M = 3000
RADIUS_OTHER_M = 50000
# 写真は現行と同じ作り方（§4.4。URL に API キーが含まれる問題は §13.3 H-2）
PHOTO_MAX_WIDTH = 800

# 飲食店系の種類（旧版 Places の types）。対象の種類は実装前に公式一覧で確定する（U-05）
FOOD_TYPES = frozenset({
    'restaurant', 'food', 'cafe', 'bar', 'bakery', 'meal_takeaway', 'meal_delivery',
})

# 判定（§3.3）
SAME = 'same'
AMBIGUOUS = 'ambiguous'
CLOSED = 'closed'
NOT_FOUND = 'not_found'

_SYMBOLS = re.compile(r'[\W_]+', re.UNICODE)


def normalize(text: str) -> str:
    """NFKC 正規化・小文字化し、空白と記号を除き、カタカナをひらがなに揃える（§3.3）"""
    if not text:
        return ''
    s = unicodedata.normalize('NFKC', str(text)).lower()
    s = _SYMBOLS.sub('', s)
    return ''.join(chr(ord(c) - 0x60) if 'ァ' <= c <= 'ヶ' else c for c in s)


def name_matches(candidate_names, place_name: str) -> bool:
    """name か aliases のどれかが Places の名前に含まれるか、その逆（2 文字以上）"""
    p = normalize(place_name)
    if len(p) < 2:
        return False
    for n in candidate_names:
        c = normalize(n)
        if len(c) < 2:
            continue
        if c in p or p in c:
            return True
    return False


def _distance_m(lat1, lng1, lat2, lng2) -> float:
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def _radius_m(geo: dict) -> int:
    return RADIUS_JP_M if (geo or {}).get('country_code', 'JP') == 'JP' else RADIUS_OTHER_M


def location_matches(result: dict, geo: dict, locality: str) -> bool:
    """座標がエリアの座標から半径の内側、または locality が住所に含まれる"""
    address = normalize(result.get('formatted_address', ''))
    loc = normalize(locality)
    if loc and len(loc) >= 2 and loc in address:
        return True
    point = (result.get('geometry') or {}).get('location') or {}
    if geo and geo.get('lat') is not None and geo.get('lng') is not None \
            and point.get('lat') is not None and point.get('lng') is not None:
        return _distance_m(geo['lat'], geo['lng'], point['lat'], point['lng']) <= _radius_m(geo)
    return False


def branch_matches(result: dict, branch: str) -> bool:
    """候補に支店名があれば、Places の名前か住所にある"""
    b = normalize(branch)
    if not b:
        return True
    return b in normalize(result.get('name', '')) or b in normalize(result.get('formatted_address', ''))


def type_matches(result: dict) -> bool:
    return bool(FOOD_TYPES.intersection(result.get('types') or []))


def is_operational(result: dict) -> bool:
    return result.get('business_status') == 'OPERATIONAL'


def judge(candidate: dict, results: list, geo: dict):
    """
    同一性判定（§3.3）。(判定, 採用する結果 or None) を返す。
    5 条件を満たす結果が 1 件だけなら「同じ店」。複数なら支店と locality で 1 件に絞れるときだけ
    「同じ店」、絞れなければ「曖昧」。名前・場所が合うが営業中でないものだけなら「閉店」。
    """
    names = [candidate.get('name', '')] + list(candidate.get('aliases') or [])
    branch = candidate.get('branch', '')
    locality = candidate.get('locality', '')

    name_loc = []
    seen = set()
    for r in results or []:
        pid = r.get('place_id')
        if not pid or pid in seen:
            continue
        seen.add(pid)
        if name_matches(names, r.get('name', '')) and location_matches(r, geo, locality):
            name_loc.append(r)

    full = [r for r in name_loc if branch_matches(r, branch) and type_matches(r) and is_operational(r)]
    if len(full) == 1:
        return SAME, full[0]
    if len(full) > 1:
        b = normalize(branch)
        loc = normalize(locality)
        if not b and not loc:
            return AMBIGUOUS, None
        narrowed = [r for r in full
                    if (not b or b in normalize(r.get('name', '')) or b in normalize(r.get('formatted_address', '')))
                    and (not loc or loc in normalize(r.get('formatted_address', '')))]
        if len(narrowed) == 1:
            return SAME, narrowed[0]
        return AMBIGUOUS, None
    if name_loc and all(not is_operational(r) for r in name_loc):
        return CLOSED, None
    return NOT_FOUND, None


def text_search(candidate: dict, geo: dict, language: str):
    """
    旧版 Text Search に「店名 支店 エリア」を渡す。
    (結果のリスト, 応答を受け取れたか) を返す。時間切れは「見つからない」と同じ扱い（§3.2）。
    """
    api_key = api_integrations.GOOGLE_PLACES_API_KEY
    if not api_key:
        logger.warning('[ConciergePlaces] Places の API キーが設定されていません')
        return [], False
    query = ' '.join(x for x in [candidate.get('name', ''), candidate.get('branch', ''),
                                 candidate.get('area', '')] if x).strip()
    params = {'query': query, 'key': api_key, 'language': language, 'type': 'restaurant'}
    if geo and geo.get('lat') is not None and geo.get('lng') is not None:
        params['location'] = f"{geo['lat']},{geo['lng']}"
        params['radius'] = _radius_m(geo)
        if geo.get('country_code', 'JP') == 'JP':
            params['region'] = 'jp'
    try:
        data = requests.get(TEXT_SEARCH_URL, params=params, timeout=REQUEST_TIMEOUT_SEC).json()
    except requests.exceptions.Timeout:
        logger.warning(f'[ConciergePlaces] 時間切れ: {query}')
        return [], True
    except Exception as e:
        logger.error(f'[ConciergePlaces] Text Search の例外: {type(e).__name__}')
        return [], False
    status = data.get('status')
    if status == 'OK':
        return data.get('results') or [], True
    if status == 'ZERO_RESULTS':
        return [], True
    logger.warning(f'[ConciergePlaces] Text Search の応答: {status}')
    return [], False


def match_candidates(candidates: list, geo_for, language: str):
    """
    候補を並列に照合する。geo_for(candidate) は位置の情報を返す関数。
    [(候補, 判定, 結果)] を候補の順で返し、あわせて Places の応答を 1 つでも受け取れたかを返す。
    """
    def one(c):
        geo = geo_for(c)
        results, ok = text_search(c, geo, language)
        verdict, place = judge(c, results, geo)
        logger.info(f"[ConciergePlaces] {c.get('name', '')}: {verdict}")
        return c, verdict, place, ok

    if not candidates:
        return [], False
    with ThreadPoolExecutor(max_workers=min(MAX_PARALLEL, len(candidates))) as ex:
        out = list(ex.map(one, candidates))
    return [(c, v, p) for c, v, p, _ in out], any(ok for *_, ok in out)


def _photo_url(place: dict, details: dict):
    photos = place.get('photos') or (details or {}).get('photos')
    if not photos:
        return None
    ref = photos[0].get('photo_reference')
    if not ref:
        return None
    return (f"{PHOTO_URL}?maxwidth={PHOTO_MAX_WIDTH}"
            f"&photo_reference={ref}&key={api_integrations.GOOGLE_PLACES_API_KEY}")


def _external_links(name: str, area: str, geo: dict, country: str, lat, lng, language: str) -> dict:
    """出し分けは現行（enrich_shops_with_photos）どおり。問い合わせには LLM の店名と地域を使う"""
    links = {}
    if language == 'ja' and country == 'JP':
        hotpepper = None
        try:
            hotpepper = api_integrations.search_hotpepper(name, area, geo)
        except Exception:
            hotpepper = None
        links['hotpepper_url'] = hotpepper or f"https://www.google.com/search?q={name}+{area}+ホットペッパーグルメ"
        pref_code_map = {'東京': 'tokyo', '神奈川': 'kanagawa', '大阪': 'osaka', '京都': 'kyoto', '兵庫': 'hyogo',
                         '北海道': 'hokkaido', '愛知': 'aichi', '福岡': 'fukuoka'}
        region_name = (geo or {}).get('region') or '東京'
        pref_code = pref_code_map.get(region_name.rstrip('都道府県'), 'tokyo')
        links['tabelog_url'] = f"https://tabelog.com/{pref_code}/rstLst/?sw={requests.utils.quote(name)}"
        links['gnavi_url'] = f"https://www.google.com/search?q={name}+{area}+ぐるなび"
        return links
    if api_integrations.TRIPADVISOR_API_KEY:
        try:
            lang_map = {'ja': 'ja', 'en': 'en', 'zh': 'zh', 'ko': 'ko'}
            search_lang = lang_map.get(language, 'en')
            ta = api_integrations.get_tripadvisor_data(name, lat, lng, search_lang)
            if not ta and search_lang == 'ja':
                ta = api_integrations.get_tripadvisor_data(name, lat, lng, 'en')
            if ta:
                links['tripadvisor_url'] = ta.get('web_url')
                links['tripadvisor_rating'] = ta.get('rating')
                links['tripadvisor_reviews'] = ta.get('num_reviews')
        except Exception as e:
            logger.error(f'[ConciergePlaces] TripAdvisor の例外: {type(e).__name__}')
    return links


def build_card(item: dict, place: dict, geo: dict, language: str) -> dict:
    """
    確定店 1 件のカード（§8.4。既存の ShopCardList の項目名）。
    item は会話用の項目（推薦の結果）、place は同一性判定を通った Text Search の結果。
    """
    details = api_integrations.get_place_details(place['place_id'], language) or {}
    point = (place.get('geometry') or {}).get('location') or {}
    lat, lng = point.get('lat'), point.get('lng')
    highlights = [x for x in [item.get('specialty'), item.get('atmosphere')] if x]
    highlights += [x for x in (item.get('fit') or []) if x][:max(0, 3 - len(highlights))]
    price = item.get('price_estimate') or ''
    card = {
        'name': item.get('name', ''),
        'area': item.get('area', ''),
        'category': item.get('genre', ''),
        'description': item.get('reason', ''),
        'highlights': highlights,
        'priceRange': f"{price}（目安）" if price else '',
        'image': _photo_url(place, details),
        'rating': place.get('rating'),
        'reviewCount': place.get('user_ratings_total'),
        'location': place.get('formatted_address') or details.get('formatted_address'),
        'phone': details.get('phone'),
        'maps_url': f"https://www.google.com/maps/place/?q=place_id:{place['place_id']}",
        'latitude': lat,
        'longitude': lng,
        'place_id': place['place_id'],
    }
    card.update(_external_links(item.get('name', ''), item.get('area', ''), geo,
                                details.get('country_code'), lat, lng, language))
    return card


def build_cards(items_with_places: list, language: str) -> list:
    """確定店のカードを並列に作る。items_with_places は [(会話用の項目, 結果, 位置の情報)]"""
    if not items_with_places:
        return []
    with ThreadPoolExecutor(max_workers=min(MAX_PARALLEL, len(items_with_places))) as ex:
        return list(ex.map(lambda t: build_card(t[0], t[1], t[2], language), items_with_places))
