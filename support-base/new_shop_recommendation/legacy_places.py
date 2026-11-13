# -*- coding: utf-8 -*-
"""
33秒版本番（8d30e554 / Cloud Run travel-sp-base-00060-car）の Places 照合をそのまま使うアダプター

本番の api_integrations.py の関数を変更せずに呼び出す（書き写しによる差異を作らない）:
  - extract_area_from_text(user_request, lang)   … 33秒版 callback と同じエリア決定
  - get_region_from_area(area, lang)            … 33秒版 enrich_shops_with_photos と同じ Geocoding
  - search_place(name, shop_area, geo_info, lang) … 33秒版の検索・候補採用（先頭の営業中店舗、Details、国コード照合）
採用後の店舗情報の反映（店名の上書き・評価・住所・地図・電話・place_id）は
enrich_shops_with_photos の「Google Placesの共通データ」部分と同じ規則で行う。
新しい照合ルール・スコア・すり替え対策は追加しない。
"""
import api_integrations as legacy


def resolve_area(user_request: str, language: str) -> str:
    """33秒版 shop_search_callback: area = extract_area_from_text(user_request, lang)"""
    return legacy.extract_area_from_text(user_request, language)


def region_info(area: str, language: str):
    """33秒版 enrich_shops_with_photos 冒頭: area があれば get_region_from_area（失敗しても止めない）"""
    if not area:
        return None
    try:
        return legacy.get_region_from_area(area, language)
    except Exception:
        return None


def lookup(name: str, shop_area: str, area: str, geo_info, language: str):
    """33秒版 enrich_shops_with_photos: shop_area = shop.get('area', '') or area → search_place(...)"""
    return legacy.search_place(name, shop_area or area, geo_info, language)


def reflect_place_data(card: dict, place_data: dict) -> dict:
    """
    33秒版 enrich_shops_with_photos「Google Placesの共通データ」と同じ反映。
    ただし photo_url（API キーを URL に含む）は反映しない（指示書 6.3-5: キー入り Legacy 写真 URL をフロントに出さない）。
    """
    if place_data.get('name'):
        card['name'] = place_data['name']
    if place_data.get('rating'):
        card['rating'] = place_data['rating']
    if place_data.get('user_ratings_total'):
        card['reviewCount'] = place_data['user_ratings_total']
    if place_data.get('formatted_address'):
        card['location'] = place_data['formatted_address']
    if place_data.get('maps_url'):
        card['maps_url'] = place_data['maps_url']
    if place_data.get('phone'):
        card['phone'] = place_data['phone']
    if place_data.get('place_id'):
        card['place_id'] = place_data['place_id']
    return card


# ---------------------------------------------------------------- Gate D1.6: 複数候補取得（search_place と同じ検索条件）
TEXTSEARCH_URL = 'https://maps.googleapis.com/maps/api/place/textsearch/json'
CANDIDATE_LIMIT = 5


def search_place_candidates(name: str, shop_area: str, area: str, geo_info, language: str, limit: int = CANDIDATE_LIMIT):
    """
    33秒版 search_place と同じエンドポイント・同じクエリ・同じパラメータで Text Search を 1 回だけ呼び、
    営業中（business_status が無ければ OPERATIONAL 扱い。search_place と同じ）の結果を検索順位順に最大 limit 件返す。
    店名一致・エリア一致・スコア付けはしない。Place Details はここでは呼ばない（選択後に fetch_selected_details）。
    returns (candidates: list[dict], status: 'OK'|'ZERO_RESULTS'|'ERROR:<...>')
    """
    if not legacy.GOOGLE_PLACES_API_KEY:
        return [], 'ERROR:no_api_key'
    shop_area = shop_area or area
    region = geo_info.get('region', '') if geo_info else ''
    expected_country = geo_info.get('country_code', 'JP') if geo_info else 'JP'
    query = (f"{name} {shop_area} {region}" if region else f"{name} {shop_area}").strip()
    params = {'query': query, 'key': legacy.GOOGLE_PLACES_API_KEY, 'language': language, 'type': 'restaurant'}
    if geo_info and geo_info.get('lat') and geo_info.get('lng'):
        params['location'] = f"{geo_info['lat']},{geo_info['lng']}"
        if expected_country == 'JP':
            params['radius'] = 3000
            params['region'] = 'jp'
        else:
            params['radius'] = 50000
    try:
        data = legacy.requests.get(TEXTSEARCH_URL, params=params, timeout=10).json()
    except Exception as e:
        return [], f'ERROR:{type(e).__name__}'
    if data.get('status') != 'OK' or not data.get('results'):
        return [], data.get('status') or 'ERROR:unknown'
    out = []
    for cand in data['results']:
        if cand.get('business_status', 'OPERATIONAL') == 'OPERATIONAL':
            out.append(cand)
            if len(out) >= limit:
                break
    return out, 'OK'


def fetch_selected_details(place: dict, geo_info, language: str):
    """
    選択された 1 店舗だけ Place Details を取得し、33秒版 search_place の採用後処理と同じ規則で店舗情報を作る
    （国コード照合で不一致なら None）。キー入りの写真 URL は作らない。
    """
    place_id = place['place_id']
    expected_country = geo_info.get('country_code', 'JP') if geo_info else 'JP'
    details = legacy.get_place_details(place_id, language)
    actual_country = details.get('country_code')
    if actual_country and expected_country and actual_country != expected_country:
        return None
    loc = (place.get('geometry') or {}).get('location') or {}
    return {
        'place_id': place_id,
        'name': place.get('name'),
        'rating': place.get('rating'),
        'user_ratings_total': place.get('user_ratings_total'),
        'formatted_address': place.get('formatted_address') or details.get('formatted_address'),
        'country_code': actual_country,
        'lat': loc.get('lat'),
        'lng': loc.get('lng'),
        'maps_url': f"https://www.google.com/maps/place/?q=place_id:{place_id}",
        'phone': details.get('phone'),
    }
