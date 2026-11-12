# -*- coding: utf-8 -*-
"""
外部API連携モジュール
- HotPepper API
- TripAdvisor API
- Google Geocoding API
- Google Places API  
- ショップ情報エンリッチメント
"""
import os
import re
import logging
import requests

# ロギング
logger = logging.getLogger(__name__)

# ========================================
# API Keys & Constants
# ========================================

# Google Places API
GOOGLE_PLACES_API_KEY = os.getenv('GOOGLE_PLACES_API_KEY', '')

# Google Geocoding API(Places APIと同じキーを使用)
GOOGLE_GEOCODING_API_KEY = os.getenv('GOOGLE_GEOCODING_API_KEY', GOOGLE_PLACES_API_KEY)

# ホットペッパーAPI
HOTPEPPER_API_KEY = os.getenv('HOTPEPPER_API_KEY', 'c22031a566715e40')

# TripAdvisor Content API
TRIPADVISOR_API_KEY = os.getenv('TRIPADVISOR_API_KEY', '')
MY_DOMAIN_URL = "https://unfix.co.jp"
USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"

# エリアコード
HOTPEPPER_AREA_CODES = {
    '東京': 'Z011',
    '神奈川': 'Z012',
    '埼玉': 'Z013',
    '千葉': 'Z014',
    '大阪': 'Z023',
    '京都': 'Z026',
    '兵庫': 'Z024',
    '愛知': 'Z033',
    '福岡': 'Z091',
    '北海道': 'Z011',
}

# ========================================
# ホットペッパーAPI 連携
# ========================================

def search_hotpepper(shop_name: str, area: str = '', geo_info: dict = None) -> str:
    """
    ホットペッパーAPIで店舗を検索して店舗ページURLを返す
    """
    if not HOTPEPPER_API_KEY:
        logger.warning("[Hotpepper API] APIキーが設定されていません")
        return None

    # Geocoding APIの結果から都道府県を取得
    large_area = 'Z011'  # デフォルト東京
    if geo_info:
        region = geo_info.get('region', '')
        # "東京都" → "東京" に変換してエリアコードを取得
        pref = region.rstrip('都道府県') if region else ''
        large_area = HOTPEPPER_AREA_CODES.get(pref, 'Z011')

    try:
        url = 'http://webservice.recruit.co.jp/hotpepper/gourmet/v1/'
        params = {
            'key': HOTPEPPER_API_KEY,
            'keyword': shop_name,
            'large_area': large_area,
            'format': 'json',
            'count': 1
        }

        logger.info(f"[Hotpepper API] 検索: {shop_name} (エリア: {large_area})")

        response = requests.get(url, params=params, timeout=10)
        data = response.json()

        results = data.get('results', {})
        shops = results.get('shop', [])

        if shops:
            shop_url = shops[0].get('urls', {}).get('pc', '')
            logger.info(f"[Hotpepper API] 取得成功: {shop_name} -> {shop_url}")
            return shop_url
        else:
            logger.info(f"[Hotpepper API] 結果なし: {shop_name}")
            return None

    except Exception as e:
        logger.error(f"[Hotpepper API] エラー: {e}")
        return None

# ========================================
# TripAdvisor Content API 連携
# ========================================
def search_tripadvisor_location(shop_name: str, lat: float = None, lng: float = None, language: str = 'en') -> dict:
    """
    TripAdvisor Location Search APIで店舗のlocation_idを検索
    """
    if not TRIPADVISOR_API_KEY:
        logger.warning("[TripAdvisor API] APIキーが設定されていません")
        return None

    try:
        url = 'https://api.content.tripadvisor.com/api/v1/location/search'

        params = {
            'key': TRIPADVISOR_API_KEY,
            'searchQuery': shop_name,
            'language': language
        }

        # 座標がある場合は追加
        if lat is not None and lng is not None:
            params['latLong'] = f"{lat},{lng}"

        # 【修正】Referer (https付き) と User-Agent (ブラウザ偽装) を指定
        headers = {
            'accept': 'application/json',
            'Referer': MY_DOMAIN_URL,
            'User-Agent': USER_AGENT
        }

        logger.info(f"[TripAdvisor API] Location Search: {shop_name} ({language})")

        response = requests.get(url, params=params, headers=headers, timeout=10)

        if response.status_code == 200:
            data = response.json()
            if data.get('data') and len(data['data']) > 0:
                location = data['data'][0]
                location_id = location.get('location_id')
                logger.info(f"[TripAdvisor API] Location found: {location_id}")
                return {
                    'location_id': location_id,
                    'name': location.get('name'),
                    'address': location.get('address_obj', {}).get('address_string', '')
                }
            else:
                logger.info(f"[TripAdvisor API] Location not found for: {shop_name}")
                return None
        else:
            logger.warning(f"[TripAdvisor API] Search failed: {response.status_code} - {response.text}")
            return None

    except Exception as e:
        logger.error(f"[TripAdvisor API] Error: {e}")
        return None


def get_tripadvisor_details(location_id: str, language: str = 'en') -> dict:
    """
    TripAdvisor Location Details APIで評価情報を取得
    """
    if not TRIPADVISOR_API_KEY or not location_id:
        return None

    try:
        url = f'https://api.content.tripadvisor.com/api/v1/location/{location_id}/details'

        params = {
            'key': TRIPADVISOR_API_KEY,
            'language': language
        }

        # 【修正】ここにも User-Agent を追加
        headers = {
            'accept': 'application/json',
            'Referer': MY_DOMAIN_URL,
            'User-Agent': USER_AGENT
        }

        logger.info(f"[TripAdvisor API] Getting details for location: {location_id}")

        response = requests.get(url, params=params, headers=headers, timeout=10)

        if response.status_code == 200:
            data = response.json()
            rating = data.get('rating')
            num_reviews = data.get('num_reviews', 0)
            web_url = data.get('web_url')

            logger.info(f"[TripAdvisor API] Details: rating={rating}, reviews={num_reviews}")

            return {
                'rating': float(rating) if rating else None,
                'num_reviews': num_reviews,
                'web_url': web_url,
                'location_id': location_id
            }
        else:
            logger.warning(f"[TripAdvisor API] Details failed: {response.status_code} - {response.text}")
            return None

    except Exception as e:
        logger.error(f"[TripAdvisor API] Error: {e}")
        return None


def get_tripadvisor_data(shop_name: str, lat: float = None, lng: float = None, language: str = 'en') -> dict:
    """
    TripAdvisor APIで店舗情報を取得(検索 + 詳細)
    """
    # Location IDを検索
    location_data = search_tripadvisor_location(shop_name, lat, lng, language)
    if not location_data:
        return None

    # 詳細情報を取得
    details = get_tripadvisor_details(location_data['location_id'], language)
    if not details:
        return None

    return {
        'rating': details['rating'],
        'num_reviews': details['num_reviews'],
        'web_url': details['web_url'],
        'location_id': details['location_id']
    }

# ========================================
# Google Geocoding API 連携
# ========================================

def get_region_from_area(area: str, language: str = 'ja') -> dict:
    """
    Geocoding APIでエリアの地域情報(国、都道府県/州、座標)を取得
    """
    if not area:
        return None

    if not GOOGLE_GEOCODING_API_KEY:
        logger.warning("[Geocoding API] APIキーが設定されていません")
        return None

    try:
        url = 'https://maps.googleapis.com/maps/api/geocode/json'
        params = {
            'address': area,
            'key': GOOGLE_GEOCODING_API_KEY,
            'language': language
        }

        logger.info(f"[Geocoding API] エリア検索: {area}")

        response = requests.get(url, params=params, timeout=10)
        data = response.json()

        if data.get('status') != 'OK' or not data.get('results'):
            logger.warning(f"[Geocoding API] 結果なし: {area} (status: {data.get('status')})")
            return None

        result = data['results'][0]
        address_components = result.get('address_components', [])

        # 国と都道府県/州を抽出
        country = None
        country_code = None
        region = None

        for component in address_components:
            types = component.get('types', [])

            if 'country' in types:
                country = component.get('long_name')
                country_code = component.get('short_name')

            if 'administrative_area_level_1' in types:
                region = component.get('long_name')

        # 座標を取得
        location = result.get('geometry', {}).get('location', {})
        lat = location.get('lat')
        lng = location.get('lng')

        geo_result = {
            'country': country,
            'country_code': country_code,
            'region': region,
            'formatted_address': result.get('formatted_address', ''),
            'lat': lat,
            'lng': lng
        }

        logger.info(f"[Geocoding API] 取得成功: {area} → country={country}, region={region}, lat={lat}, lng={lng}")
        return geo_result

    except requests.exceptions.Timeout:
        logger.error(f"[Geocoding API] タイムアウト: {area}")
        return None
    except Exception as e:
        logger.error(f"[Geocoding API] エラー: {e}")
        return None


# ========================================
# Google Places API 連携
# ========================================

def get_place_details(place_id: str, language: str = 'ja') -> dict:
    """
    Place Details APIで電話番号と国コードを取得
    """
    if not GOOGLE_PLACES_API_KEY or not place_id:
        return {'phone': None, 'country_code': None, 'photos': None, 'formatted_address': None}

    try:
        details_url = 'https://maps.googleapis.com/maps/api/place/details/json'
        params = {
            'place_id': place_id,
            'fields': 'formatted_phone_number,international_phone_number,address_components,photos,formatted_address',
            'key': GOOGLE_PLACES_API_KEY,
            'language': language
        }

        response = requests.get(details_url, params=params, timeout=10)
        data = response.json()

        if data.get('status') != 'OK':
            logger.warning(f"[Place Details API] 取得失敗: {data.get('status')} - {place_id}")
            return {'phone': None, 'country_code': None, 'photos': None, 'formatted_address': None}

        result = data.get('result', {})

        # 電話番号取得(国内形式を優先、なければ国際形式)
        phone = result.get('formatted_phone_number') or result.get('international_phone_number')

        # 国コード取得
        country_code = None
        if result.get('address_components'):
            for component in result['address_components']:
                if 'country' in component.get('types', []):
                    country_code = component.get('short_name')
                    break

        # 写真取得
        photos = result.get('photos')
        
        # 住所取得
        formatted_address = result.get('formatted_address')

        if phone or photos or formatted_address:
            logger.info(f"[Place Details API] 取得成功: 電話={phone}, 国={country_code}, 写真={'あり' if photos else 'なし'}, 住所={'あり' if formatted_address else 'なし'}")

        return {
            'phone': phone, 
            'country_code': country_code,
            'photos': photos,
            'formatted_address': formatted_address
        }


    except requests.exceptions.Timeout:
        logger.error(f"[Place Details API] タイムアウト: {place_id}")
        return {'phone': None, 'country_code': None, 'photos': None, 'formatted_address': None}
    except Exception as e:
        logger.error(f"[Place Details API] エラー: {e}")
        return {'phone': None, 'country_code': None, 'photos': None, 'formatted_address': None}


def search_place(shop_name: str, area: str = '', geo_info: dict = None, language: str = 'ja') -> dict:
    """
    Google Places APIで店舗を検索(国コード検証付き)
    """
    if not GOOGLE_PLACES_API_KEY:
        logger.warning("[Places API] APIキーが設定されていません")
        return None

    # Geocoding APIの結果から都道府県/州を取得
    region = geo_info.get('region', '') if geo_info else ''
    expected_country = geo_info.get('country_code', 'JP') if geo_info else 'JP'

    # 検索クエリを構築
    if region:
        query = f"{shop_name} {area} {region}".strip()
    else:
        query = f"{shop_name} {area}".strip()
    logger.info(f"[Places API] 📍 検索開始: shop_name='{shop_name}', area='{area}', region='{region}', expected_country={expected_country}")

    try:
        search_url = 'https://maps.googleapis.com/maps/api/place/textsearch/json'
        params = {
            'query': query,
            'key': GOOGLE_PLACES_API_KEY,
            'language': language,
            'type': 'restaurant'
        }

        # Geocoding APIの座標があれば位置バイアスを追加
        if geo_info and geo_info.get('lat') and geo_info.get('lng'):
            params['location'] = f"{geo_info['lat']},{geo_info['lng']}"

            # 国によって検索半径を変える
            if expected_country == 'JP':
                params['radius'] = 3000
                params['region'] = 'jp'
            else:
                params['radius'] = 50000

        logger.info(f"[Places API] 検索クエリ: {query}")

        response = requests.get(search_url, params=params, timeout=10)
        data = response.json()

        if data.get('status') != 'OK':
            logger.warning(f"[Places API] 検索失敗: {data.get('status')} - {query}")
            return None

        if not data.get('results'):
            logger.info(f"[Places API] 結果なし: {query}")
            return None

        results_count = len(data.get('results', []))
        logger.info(f"[Places API] 📊 検索結果: {results_count}件ヒット")

        # ✅ business_status でフィルタリング（廃業・閉店を除外）
        place = None
        for candidate in data['results']:
            business_status = candidate.get('business_status', 'OPERATIONAL')
            candidate_name = candidate.get('name', '不明')

            if business_status == 'OPERATIONAL':
                place = candidate
                logger.info(f"[Places API] ✅ 営業中: {candidate_name}")
                break
            elif business_status == 'CLOSED_PERMANENTLY':
                logger.warning(f"[Places API] ❌ 閉店・廃業のためスキップ: {candidate_name}")
            elif business_status == 'CLOSED_TEMPORARILY':
                logger.warning(f"[Places API] ⏸️ 一時休業のためスキップ: {candidate_name}")
            else:
                logger.warning(f"[Places API] ❓ 不明なステータス({business_status})のためスキップ: {candidate_name}")

        if not place:
            logger.warning(f"[Places API] 営業中の店舗が見つかりません: {query}")
            return None

        place_id = place['place_id']

        logger.info(f"[Places API] 🏆 選択した店舗: name='{place.get('name')}', address='{place.get('formatted_address', '')[:50]}...'")
        maps_url = f"https://www.google.com/maps/place/?q=place_id:{place_id}"

        # 座標を取得
        geometry = place.get('geometry', {})
        location = geometry.get('location', {})
        lat = location.get('lat')
        lng = location.get('lng')

        # ✅ Place Details APIで電話番号、国コード、写真、住所を取得
        details = get_place_details(place_id, language)
        actual_country = details.get('country_code')

        # 📷 画像URLを生成(Text Search API → Place Details API の順で試行)
        photo_url = None
        photos_source = place.get('photos') or details.get('photos')
        if photos_source:
            photo_reference = photos_source[0]['photo_reference']
            photo_url = (
                f"https://maps.googleapis.com/maps/api/place/photo"
                f"?maxwidth=800"
                f"&photo_reference={photo_reference}"
                f"&key={GOOGLE_PLACES_API_KEY}"
            )
            logger.info(f"[Places API] 📷 写真取得元: {'Text Search' if place.get('photos') else 'Place Details'}")
        else:
            logger.warning(f"[Places API] ⚠️ 写真データなし: {place.get('name')}")



        logger.info(f"[Places API] 🌍 国コード検証: expected={expected_country}, actual={actual_country}")

        # ✅ 国コード検証
        if actual_country and expected_country and actual_country != expected_country:
            logger.warning(f"[Places API] 国コード不一致: {place.get('name')} "
                          f"(期待: {expected_country}, 実際: {actual_country}) - スキップ")
            return None

        result = {
            'place_id': place_id,
            'name': place.get('name'),
            'rating': place.get('rating'),
            'user_ratings_total': place.get('user_ratings_total'),
            'formatted_address': place.get('formatted_address') or details.get('formatted_address'),
            'country_code': actual_country,
            'lat': lat,
            'lng': lng,
            'photo_url': photo_url,
            'maps_url': maps_url,
            'phone': details.get('phone')
        }

        logger.info(f"[Places API] 取得成功: {result['name']} (国: {actual_country}, 電話: {result['phone']})")
        return result

    except requests.exceptions.Timeout:
        logger.error(f"[Places API] タイムアウト: {query}")
        return None
    except Exception as e:
        logger.error(f"[Places API] エラー: {e}")
        return None

# ========================================
# ショップ情報 拡張ロジック (刷新版)
# ========================================

def enrich_shops_with_photos(shops: list, area: str = '', language: str = 'ja') -> list:
    """
    ショップリストに外部APIデータを追加 (place_id重複排除付き、国コード検証強化版)
    - 基本: トリップアドバイザーを表示
    - 例外(日本語かつ日本国内): 国内3サイトを表示し、トリップアドバイザーは非表示
    """
    enriched_shops = []
    seen_place_ids = set()  # ✅ 重複チェック用
    duplicate_count = 0
    validation_failed_count = 0
    
    logger.info(f"[Enrich] é–‹å§‹: area='{area}', language={language}, shops={len(shops)}ä»¶")

    # Geocodingはã'ãã¾ã§è£œåŠ©æƒ…å ±ã¨ã—ã¦å–å¾—(失敗しても止まらない)
    geo_info = None
    if area:
        try:
            geo_info = get_region_from_area(area, language)
            if geo_info:
                logger.info(f"[Enrich] Geocoding成功: {geo_info.get('formatted_address', '')} "
                           f"(国: {geo_info.get('country_code', '')}, "
                           f"座標: {geo_info.get('lat', '')}, {geo_info.get('lng', '')})")
        except Exception as e:
            logger.error(f"[Enrich] Geocoding Error: {e}")

    # LLMが回答した店舗名をログ出力
    logger.info(f"[Enrich] LLMの回答店舗:")
    for i, shop in enumerate(shops, 1):
        logger.info(f"[Enrich]   {i}. {shop.get('name', '')}")

    for i, shop in enumerate(shops, 1):
        shop_name = shop.get('name', '')
        if not shop_name:
            continue

        logger.info(f"[Enrich] ----------")
        logger.info(f"[Enrich] {i}/{len(shops)} 検索: '{shop_name}'")

        # -------------------------------------------------------
        # 1. Google Places APIで基本情報を取得(国コード検証付き)
        # -------------------------------------------------------
        # 店舗ごとのエリアを使用(LLMのJSONから取得)
        shop_area = shop.get('area', '') or area  # LLMのareaを優先、なければグローバルのareaを使用
        logger.info(f"[Enrich] → 使用エリア: '{shop_area}'")
        place_data = search_place(shop_name, shop_area, geo_info, language)
        
        if not place_data:
            logger.warning(f"[Enrich] Places APIで見つからない。除外します: {shop_name}")
            validation_failed_count += 1
            continue  # ★append()せずにスキップ★

        place_id = place_data.get('place_id')
        place_name = place_data.get('name')
        
        logger.info(f"[Enrich] → 検索結果: '{place_name}'")
        logger.info(f"[Enrich] → place_id: {place_id}")
        logger.info(f"[Enrich] → photo_url: {place_data.get('photo_url', 'なし')}")

        # ✅ place_id重複チェック
        if place_id in seen_place_ids:
            duplicate_count += 1
            logger.warning(f"[Enrich] → ❌ 重複検出!æ—¢ã«è¿½åŠ æ¸ˆã¿(スキップ)")
            logger.warning(f"[Enrich]    LLM店舗名: '{shop_name}' → Google店舗名: '{place_name}'")
            continue
        
        # ✅ place_idを記録
        seen_place_ids.add(place_id)
        logger.info(f"[Enrich] → ✅ è¿½åŠ æ±ºå®š")

        # 国コードの取得
        shop_country = place_data.get('country_code', '')
        
        # -------------------------------------------------------
        # 2. ロジック判定(フラグ設定)
        # -------------------------------------------------------
        # デフォルト設定 (基本はTripAdvisorを表示)
        show_tripadvisor = True
        show_domestic_sites = False

        # 【例外ルール】言語が日本語(ja) かつ 日本国内(JP) ã®å ´åˆ
        if language == 'ja' and shop_country == 'JP':
            show_tripadvisor = False      # トリップアドバイザーは出さない
            show_domestic_sites = True    # 国内3サイトを出す
        
        # 将来的な拡張(例:台湾・韓国でも食べログを出す場合)
        # if language == 'ja' and shop_country in ['TW', 'KR']:
        #     show_domestic_sites = True
        
        logger.info(f"[Enrich] 判定結果: {shop_name} (Country: {shop_country}, Lang: {language}) "
                   f"-> TripAdvisor: {show_tripadvisor}, Domestic: {show_domestic_sites}")

        # -------------------------------------------------------
        # 3. データの注入
        # -------------------------------------------------------
        # Google Placesの共通データ
        if place_data.get('name'): 
            shop['name'] = place_data['name']
        if place_data.get('photo_url'): 
            shop['image'] = place_data['photo_url']
        if place_data.get('rating'): 
            shop['rating'] = place_data['rating']
        if place_data.get('user_ratings_total'): 
            shop['reviewCount'] = place_data['user_ratings_total']
        if place_data.get('formatted_address'): 
            shop['location'] = place_data['formatted_address']
        if place_data.get('maps_url'): 
            shop['maps_url'] = place_data['maps_url']
        if place_data.get('phone'): 
            shop['phone'] = place_data['phone']
        if place_data.get('place_id'): 
            shop['place_id'] = place_data['place_id']

        # A. 国内3サイトのリンク生成 (例外ルール適用時)
        if show_domestic_sites:
            try:
                # TripAdvisorフィールドを明示的に削除
                shop.pop('tripadvisor_url', None)
                shop.pop('tripadvisor_rating', None)
                shop.pop('tripadvisor_reviews', None)

                # ホットペッパー
                hotpepper_url = None
                try:
                    hotpepper_url = search_hotpepper(shop_name, area, geo_info)
                    if not hotpepper_url:
                        # 名前を変えて再トライ
                        places_name = place_data.get('name', '')
                        if places_name and places_name != shop_name:
                            hotpepper_url = search_hotpepper(places_name, area, geo_info)
                except Exception:
                    pass

                shop['hotpepper_url'] = hotpepper_url if hotpepper_url else f"https://www.google.com/search?q={shop_name}+{area}+ホットペッパーグルメ"

                # 食べログ
                try:
                    places_name = place_data.get('name', '')
                    region_name = geo_info.get('region', '') if geo_info else '東京'
                    # 都道府県コード変換(簡易版)
                    pref_code_map = {'東京': 'tokyo', '神奈川': 'kanagawa', '大阪': 'osaka', '京都': 'kyoto', '兵庫': 'hyogo', '北海道': 'hokkaido', '愛知': 'aichi', '福岡': 'fukuoka'}
                    pref = region_name.rstrip('都道府県') if region_name else '東京'
                    pref_code = pref_code_map.get(pref, 'tokyo')

                    tabelog_search_query = requests.utils.quote(places_name if places_name else shop_name)
                    shop['tabelog_url'] = f"https://tabelog.com/{pref_code}/rstLst/?sw={tabelog_search_query}"
                except Exception:
                    shop['tabelog_url'] = f"https://tabelog.com/tokyo/rstLst/?sw={shop_name}"

                # ぐるなび
                shop['gnavi_url'] = f"https://www.google.com/search?q={shop_name}+{area}+ぐるなび"

            except Exception as e:
                logger.error(f"[Enrich] Domestic Sites Error: {e}")

        # B. トリップアドバイザーのリンク生成 (デフォルト適用時)
        if show_tripadvisor:
            try:
                lat = place_data.get('lat')
                lng = place_data.get('lng')
                
                if TRIPADVISOR_API_KEY:
                    # 言語マッピング
                    tripadvisor_lang_map = {'ja': 'ja', 'en': 'en', 'zh': 'zh', 'ko': 'ko'}
                    search_lang = tripadvisor_lang_map.get(language, 'en')
                    
                    # 検索実行
                    tripadvisor_data = get_tripadvisor_data(shop_name, lat, lng, search_lang)

                    # 0件かつ日本語の場合、英語で再トライ(ヒット率向上策)
                    if not tripadvisor_data and search_lang == 'ja':
                        logger.info(f"[TripAdvisor] 日本語でヒットせず。英語で再検索: {shop_name}")
                        tripadvisor_data = get_tripadvisor_data(shop_name, lat, lng, 'en')

                    if tripadvisor_data:
                        shop['tripadvisor_url'] = tripadvisor_data.get('web_url')
                        shop['tripadvisor_rating'] = tripadvisor_data.get('rating')
                        shop['tripadvisor_reviews'] = tripadvisor_data.get('num_reviews')
                        logger.info(f"[TripAdvisor] リンク生成成功: {shop_name}")
            except Exception as e:
                logger.error(f"[Enrich] TripAdvisor Error: {e}")

        enriched_shops.append(shop)

    logger.info(f"[Enrich] ========== 完了 ==========")
    logger.info(f"[Enrich] 出力: {len(enriched_shops)}件")
    logger.info(f"[Enrich] 重複除外: {duplicate_count}件")
    logger.info(f"[Enrich] 検証失敗: {validation_failed_count}件")
    logger.info(f"[Enrich] 合計入力: {len(shops)}件")

    return enriched_shops


# ========================================
# ショップ情報 拡張ロジック（並列版）
# 店舗の選び方・照合・採用条件は enrich_shops_with_photos() と同じ。
# 変えたのは実行の順序だけ：
#   - Places の照合（search_place）を店舗ごとに並列で走らせる
#   - 結果は LLM の推薦順に並べ直してから、重複除外・カードへの反映を行う
#   - ホットペッパー / TripAdvisor（外部 API）はカード表示の後に取得して差し替える
# ========================================

FAST_ENRICH_MAX_PARALLEL = 5


def _hotpepper_fallback_url(shop_name: str, area: str) -> str:
    """enrich_shops_with_photos() でホットペッパーが見つからないときの URL と同じ"""
    return f"https://www.google.com/search?q={shop_name}+{area}+ホットペッパーグルメ"


def apply_place_core(shop: dict, shop_name: str, place_data: dict, area: str,
                     geo_info: dict, language: str):
    """
    enrich_shops_with_photos() の「2. ロジック判定」「3. データの注入」のうち、
    外部 API を呼ばない部分（値は同じ）。ホットペッパーは仮の URL を入れておき、
    fetch_place_extras() の結果で差し替える。
    戻り値: (show_tripadvisor, show_domestic_sites)
    """
    shop_country = place_data.get('country_code', '')

    show_tripadvisor = True
    show_domestic_sites = False
    if language == 'ja' and shop_country == 'JP':
        show_tripadvisor = False
        show_domestic_sites = True

    logger.info(f"[Enrich] 判定結果: {shop_name} (Country: {shop_country}, Lang: {language}) "
               f"-> TripAdvisor: {show_tripadvisor}, Domestic: {show_domestic_sites}")

    if place_data.get('name'):
        shop['name'] = place_data['name']
    if place_data.get('photo_url'):
        shop['image'] = place_data['photo_url']
    if place_data.get('rating'):
        shop['rating'] = place_data['rating']
    if place_data.get('user_ratings_total'):
        shop['reviewCount'] = place_data['user_ratings_total']
    if place_data.get('formatted_address'):
        shop['location'] = place_data['formatted_address']
    if place_data.get('maps_url'):
        shop['maps_url'] = place_data['maps_url']
    if place_data.get('phone'):
        shop['phone'] = place_data['phone']
    if place_data.get('place_id'):
        shop['place_id'] = place_data['place_id']

    if show_domestic_sites:
        try:
            shop.pop('tripadvisor_url', None)
            shop.pop('tripadvisor_rating', None)
            shop.pop('tripadvisor_reviews', None)

            # ホットペッパーは表示の後に取得する。取れなかったときと同じ URL を先に入れておく
            shop['hotpepper_url'] = _hotpepper_fallback_url(shop_name, area)

            # 食べログ
            try:
                places_name = place_data.get('name', '')
                region_name = geo_info.get('region', '') if geo_info else '東京'
                pref_code_map = {'東京': 'tokyo', '神奈川': 'kanagawa', '大阪': 'osaka', '京都': 'kyoto', '兵庫': 'hyogo', '北海道': 'hokkaido', '愛知': 'aichi', '福岡': 'fukuoka'}
                pref = region_name.rstrip('都道府県') if region_name else '東京'
                pref_code = pref_code_map.get(pref, 'tokyo')

                tabelog_search_query = requests.utils.quote(places_name if places_name else shop_name)
                shop['tabelog_url'] = f"https://tabelog.com/{pref_code}/rstLst/?sw={tabelog_search_query}"
            except Exception:
                shop['tabelog_url'] = f"https://tabelog.com/tokyo/rstLst/?sw={shop_name}"

            # ぐるなび
            shop['gnavi_url'] = f"https://www.google.com/search?q={shop_name}+{area}+ぐるなび"

        except Exception as e:
            logger.error(f"[Enrich] Domestic Sites Error: {e}")

    return show_tripadvisor, show_domestic_sites


def fetch_place_extras(shop_name: str, area: str, geo_info: dict, place_data: dict, language: str,
                       show_tripadvisor: bool, show_domestic_sites: bool) -> dict:
    """
    enrich_shops_with_photos() のホットペッパー / TripAdvisor の取得（外部 API）。
    カードに反映する項目だけを返す（値の決め方は同じ）。
    """
    updates = {}

    if show_domestic_sites:
        hotpepper_url = None
        try:
            hotpepper_url = search_hotpepper(shop_name, area, geo_info)
            if not hotpepper_url:
                places_name = place_data.get('name', '')
                if places_name and places_name != shop_name:
                    hotpepper_url = search_hotpepper(places_name, area, geo_info)
        except Exception:
            pass
        updates['hotpepper_url'] = hotpepper_url if hotpepper_url else _hotpepper_fallback_url(shop_name, area)

    if show_tripadvisor:
        try:
            lat = place_data.get('lat')
            lng = place_data.get('lng')

            if TRIPADVISOR_API_KEY:
                tripadvisor_lang_map = {'ja': 'ja', 'en': 'en', 'zh': 'zh', 'ko': 'ko'}
                search_lang = tripadvisor_lang_map.get(language, 'en')

                tripadvisor_data = get_tripadvisor_data(shop_name, lat, lng, search_lang)

                if not tripadvisor_data and search_lang == 'ja':
                    logger.info(f"[TripAdvisor] 日本語でヒットせず。英語で再検索: {shop_name}")
                    tripadvisor_data = get_tripadvisor_data(shop_name, lat, lng, 'en')

                if tripadvisor_data:
                    updates['tripadvisor_url'] = tripadvisor_data.get('web_url')
                    updates['tripadvisor_rating'] = tripadvisor_data.get('rating')
                    updates['tripadvisor_reviews'] = tripadvisor_data.get('num_reviews')
                    logger.info(f"[TripAdvisor] リンク生成成功: {shop_name}")
        except Exception as e:
            logger.error(f"[Enrich] TripAdvisor Error: {e}")

    return updates


class StreamingShopExtractor:
    """
    LLM の応答を受信しながら、"shops" 配列の中で書き終わった店舗オブジェクトを順に取り出す。
    取り出した店舗は Places の照合を前倒しで始めるためだけに使う。
    採用する店舗の一覧は、受信完了後に従来と同じ方法で解析した結果が正とする。
    """
    _SHOPS_KEY = re.compile(r'"shops"\s*:\s*\[')

    def __init__(self, on_shop):
        self._on_shop = on_shop
        self._pos = None      # 次に読む位置（"shops": [ の直後から）
        self._count = 0

    def feed(self, text: str):
        if self._pos is None:
            m = self._SHOPS_KEY.search(text)
            if not m:
                return
            self._pos = m.end()
        while True:
            i = self._pos
            n = len(text)
            while i < n and text[i] in ' \t\r\n,':
                i += 1
            if i >= n or text[i] != '{':
                return  # まだ届いていない、または配列の終わり
            end = self._object_end(text, i)
            if end < 0:
                return  # 書き途中
            self._pos = end
            try:
                import json as _json
                shop = _json.loads(text[i:end])
            except ValueError:
                return  # 解析できない場合は前倒しをやめる（受信完了後の解析で処理する）
            if isinstance(shop, dict):
                index = self._count
                self._count += 1
                try:
                    self._on_shop(index, shop)
                except Exception as e:
                    logger.error(f"[FastEnrich] 前倒し照合の開始に失敗: {e}")

    @staticmethod
    def _object_end(text: str, start: int) -> int:
        depth = 0
        in_str = False
        esc = False
        for j in range(start, len(text)):
            c = text[j]
            if in_str:
                if esc:
                    esc = False
                elif c == '\\':
                    esc = True
                elif c == '"':
                    in_str = False
                continue
            if c == '"':
                in_str = True
            elif c == '{':
                depth += 1
            elif c == '}':
                depth -= 1
                if depth == 0:
                    return j + 1
        return -1


class ParallelShopEnricher:
    """
    enrich_shops_with_photos() と同じ結果を、店舗ごとの並列処理で作る。

    - start(): 検索開始と同時に、エリア抽出と Geocoding を始める（従来は LLM の後に直列で実行）
    - submit(): LLM の受信中に、書き終わった店舗から Places の照合（search_place）を始める
    - 照合が推薦順の先頭から揃った分だけ、途中経過として on_partial() に渡す（カードの段階表示）
    - finalize(): 受信完了後の店舗一覧（従来と同じ解析結果）で、推薦順に重複除外・反映を行い確定する
    - fetch_extras(): 確定後にホットペッパー / TripAdvisor を並列で取得し、カードの値を差し替える
    """

    def __init__(self, user_request: str, language: str, on_partial=None, t0: float = None):
        import copy
        import threading
        import time as _time
        from concurrent.futures import ThreadPoolExecutor
        self._copy = copy
        self._time = _time
        self._t0 = t0 if t0 is not None else _time.monotonic()
        self._user_request = user_request
        self._language = language
        self._on_partial = on_partial
        self._lock = threading.Lock()
        self._pool = ThreadPoolExecutor(max_workers=FAST_ENRICH_MAX_PARALLEL)
        self._geo_pool = ThreadPoolExecutor(max_workers=1)
        self._geo_future = None
        self._streamed = {}      # index -> 受信中に取り出した店舗（照合に使った内容の写し）
        self._futures = {}       # index -> search_place の Future
        self._next = 0           # 段階表示で次に確定させる推薦順位
        self._partial_shops = []
        self._partial_seen = set()
        self._closed = False
        self._first_partial_logged = False

    def _elapsed(self) -> str:
        return f"+{self._time.monotonic() - self._t0:.1f}s"

    # ---------- エリアと Geocoding（従来と同じ関数・同じ入力） ----------
    def start(self):
        self._geo_future = self._geo_pool.submit(self._resolve_area_and_geo)

    def _resolve_area_and_geo(self):
        area = extract_area_from_text(self._user_request, self._language)
        geo_info = None
        if area:
            try:
                geo_info = get_region_from_area(area, self._language)
                if geo_info:
                    logger.info(f"[Enrich] Geocoding成功: {geo_info.get('formatted_address', '')} "
                               f"(国: {geo_info.get('country_code', '')}, "
                               f"座標: {geo_info.get('lat', '')}, {geo_info.get('lng', '')})")
            except Exception as e:
                logger.error(f"[Enrich] Geocoding Error: {e}")
        logger.info(f"[ShopSearchTiming] area='{area}' geocode完了 {self._elapsed()}")
        return area, geo_info

    def area_and_geo(self):
        if self._geo_future is None:
            self.start()
        return self._geo_future.result()

    # ---------- Places の照合（店舗単位で並列） ----------
    def _search(self, shop: dict):
        area, geo_info = self.area_and_geo()
        shop_name = shop.get('name', '')
        shop_area = shop.get('area', '') or area
        logger.info(f"[Enrich] 検索: '{shop_name}' → 使用エリア: '{shop_area}'")
        return search_place(shop_name, shop_area, geo_info, self._language)

    def submit(self, index: int, shop: dict):
        """LLM の受信中に呼ばれる。書き終わった店舗の照合を前倒しで始める"""
        if not shop.get('name'):
            return
        with self._lock:
            if self._closed or index in self._futures:
                return
            self._streamed[index] = self._copy.deepcopy(shop)
            fut = self._pool.submit(self._search, self._streamed[index])
            self._futures[index] = fut
        logger.info(f"[ShopSearchTiming] 店舗{index + 1}の照合開始 '{shop.get('name', '')}' {self._elapsed()}")
        fut.add_done_callback(lambda _f: self._advance())

    def _advance(self):
        """推薦順の先頭から照合が揃った分を、途中経過として表示する（重複除外は従来と同じく推薦順）"""
        with self._lock:
            if self._closed:
                return
            added = False
            while self._next in self._futures and self._futures[self._next].done():
                index = self._next
                self._next += 1
                try:
                    place_data = self._futures[index].result()
                except Exception:
                    place_data = None
                if not place_data:
                    continue
                place_id = place_data.get('place_id')
                if place_id in self._partial_seen:
                    continue
                self._partial_seen.add(place_id)
                area, geo_info = self.area_and_geo()
                shop = self._copy.deepcopy(self._streamed[index])
                apply_place_core(shop, shop.get('name', ''), place_data, area, geo_info, self._language)
                self._partial_shops.append(shop)
                added = True
            if added and self._on_partial:
                if not self._first_partial_logged:
                    self._first_partial_logged = True
                    logger.info(f"[ShopSearchTiming] 最初のカード表示 {self._elapsed()}")
                try:
                    self._on_partial([self._copy.deepcopy(s) for s in self._partial_shops])
                except Exception as e:
                    logger.error(f"[FastEnrich] 途中経過の送信に失敗: {e}")

    # ---------- 確定（従来と同じ解析結果を、推薦順に処理する） ----------
    def finalize(self, shops: list) -> list:
        with self._lock:
            self._closed = True  # 以降は途中経過を送らない
        area, geo_info = self.area_and_geo()

        logger.info(f"[Enrich] 開始: area='{area}', language={self._language}, shops={len(shops)}件")
        logger.info(f"[Enrich] LLMの回答店舗:")
        for i, shop in enumerate(shops, 1):
            logger.info(f"[Enrich]   {i}. {shop.get('name', '')}")

        # 受信中に始めた照合は、確定の店舗と内容が同じときだけ使う。違えばやり直す
        futures = []
        reused = 0
        for index, shop in enumerate(shops):
            if not shop.get('name', ''):
                futures.append(None)
                continue
            fut = self._futures.get(index)
            if fut is not None and self._streamed.get(index) == shop:
                reused += 1
            else:
                fut = self._pool.submit(self._search, shop)
            futures.append(fut)
        logger.info(f"[ShopSearchTiming] 前倒しの照合を再利用: {reused}/{len(shops)}件")

        enriched_shops = []
        seen_place_ids = set()
        duplicate_count = 0
        validation_failed_count = 0
        self._extras_plan = []

        for i, (shop, fut) in enumerate(zip(shops, futures), 1):
            if fut is None:
                continue
            shop_name = shop.get('name', '')
            try:
                place_data = fut.result()
            except Exception as e:
                logger.error(f"[Enrich] 照合の例外: {e}")
                place_data = None

            if not place_data:
                logger.warning(f"[Enrich] Places APIで見つからない。除外します: {shop_name}")
                validation_failed_count += 1
                continue

            place_id = place_data.get('place_id')
            place_name = place_data.get('name')
            logger.info(f"[Enrich] {i}/{len(shops)} '{shop_name}' → '{place_name}' ({place_id})")

            if place_id in seen_place_ids:
                duplicate_count += 1
                logger.warning(f"[Enrich] → 重複のためスキップ: LLM店舗名 '{shop_name}' → Google店舗名 '{place_name}'")
                continue
            seen_place_ids.add(place_id)

            show_tripadvisor, show_domestic_sites = apply_place_core(
                shop, shop_name, place_data, area, geo_info, self._language)
            self._extras_plan.append((shop, shop_name, place_data, show_tripadvisor, show_domestic_sites))
            enriched_shops.append(shop)

        logger.info(f"[Enrich] ========== 完了 ==========")
        logger.info(f"[Enrich] 出力: {len(enriched_shops)}件 / 重複除外: {duplicate_count}件 / "
                   f"検証失敗: {validation_failed_count}件 / 合計入力: {len(shops)}件")
        logger.info(f"[ShopSearchTiming] 全カード確定 {self._elapsed()}")
        return enriched_shops

    def close(self):
        with self._lock:
            self._closed = True
        self._pool.shutdown(wait=False)
        self._geo_pool.shutdown(wait=False)

    # ---------- 表示の後に取る付加情報（ホットペッパー / TripAdvisor） ----------
    def fetch_extras(self) -> bool:
        """確定した店舗に付加情報を並列で取得して反映する。値が変わった店舗があれば True"""
        plan = getattr(self, '_extras_plan', [])
        if not plan:
            return False
        area, geo_info = self.area_and_geo()
        futs = [self._pool.submit(fetch_place_extras, shop_name, area, geo_info, place_data,
                                  self._language, show_ta, show_dom)
                for (_shop, shop_name, place_data, show_ta, show_dom) in plan]
        changed = False
        for (shop, _name, _pd, _ta, _dom), fut in zip(plan, futs):
            try:
                updates = fut.result()
            except Exception as e:
                logger.error(f"[Enrich] 付加情報の例外: {e}")
                continue
            for key, value in updates.items():
                if shop.get(key) != value:
                    shop[key] = value
                    changed = True
        logger.info(f"[ShopSearchTiming] 付加情報の取得完了 {self._elapsed()} (変更あり={changed})")
        return changed


def extract_area_from_text(text: str, language: str = 'ja') -> str:
    """
    テキストからエリア名を抽出(Geocoding APIで動的に検証)
    """
    jp_chars = r'[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF\uFF66-\uFF9Fa-zA-Z]'
    patterns = [
        rf'({jp_chars}{{2,10}})の{jp_chars}',
        rf'({jp_chars}{{2,10}})で{jp_chars}',
        rf'({jp_chars}{{2,10}})にある',
        rf'({jp_chars}{{2,10}})周辺',
    ]

    for pattern in patterns:
        match = re.search(pattern, text)
        if match:
            candidate = match.group(1)
            geo_info = get_region_from_area(candidate, language)
            if geo_info and geo_info.get('region'):
                logger.info(f"[Extract Area] エリア抽出成功: '{candidate}' from '{text}'")
                return candidate

    logger.info(f"[Extract Area] エリア抽出失敗: '{text}'")
    return ''


def extract_shops_from_response(text: str) -> list:
    """
    LLMの応答テキストからショップ情報を抽出
    """
    shops = []
    pattern = r'(\d+)\.\s*\*\*([^*]+)\*\*\s*(?:\([^)]+\))?\s*[-:]:]\s*([^\n]+)'
    matches = re.findall(pattern, text)

    for match in matches:
        full_name = match[1].strip()
        description = match[2].strip()

        name = full_name
        name_match = re.match(r'^([^(]+)[(]([^)]+)[)]', full_name)
        if name_match:
            name = name_match.group(1).strip()

        shops.append({
            'name': name,
            'description': description,
            'category': 'レストラン'
        })

    logger.info(f"[Extract] {len(shops)}件のショップを抽出")
