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
