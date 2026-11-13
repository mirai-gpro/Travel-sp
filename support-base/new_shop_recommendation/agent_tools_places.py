# -*- coding: utf-8 -*-
"""
Gate D1.7: Maps Experience Agent Tools（search_places の REST 版 v1:searchText）による店舗候補取得

公式仕様（developers.google.com/maps/ai/maps-experience-agent-tools、2026-11-11 リリースノート）:
  POST https://mapstools.googleapis.com/v1:searchText   ヘッダ X-Goog-Api-Key
  リクエスト: textQuery（必須）/ languageCode / regionCode / pageSize（1〜5 は Essentials SKU）/ locationBias.circle
  レスポンス: summary（自然文の要約。[0] 形式の引用が places の添字に対応）/ places[]:
             place（places/{id}）, id, googleMapsLinks.placeUrl, attribution{title,url}, location / contentToken
  ※ places[] には店名・住所が含まれない。店舗の同一性は summary（Grounded 用の Google Maps Content）で判断する。

規約（Service Specific Terms §10、利用ポリシー）に沿った扱い:
  - summary は LLM のグラウンディングにだけ使う。プログラム側で summary から店名等を抜き出さない（§10.3.1）
  - place ID は他の Google Maps Platform API で利用可（公式: "You can use the returned place IDs with other
    Google Maps Platform APIs"）。カード情報は place ID で Place Details を取得して作る
  - カードには attribution（title・url）と googleMapsLinks.placeUrl を必ず保持する（§10.2.1 のソースリンク）
  - summary・places は保存しない（ログ・ファイルに出さない）
"""
import time

import requests

import api_integrations as legacy

from .redact import redact

SEARCH_TEXT_URL = 'https://mapstools.googleapis.com/v1:searchText'
DETAILS_URL = 'https://maps.googleapis.com/maps/api/place/details/json'
PAGE_SIZE = 5                 # 1〜5 は Essentials SKU（6 以上は Pro）
LANGUAGE = 'ja'
REGION = 'JP'
JP_RADIUS_M = 3000            # 33秒版 Text Search と同じ半径（日本）
OTHER_RADIUS_M = 50000        # 公式上限 50,000 m（33秒版の日本以外と同じ）
DETAILS_FIELDS = ('name,rating,user_ratings_total,formatted_address,address_components,'
                  'formatted_phone_number,international_phone_number,geometry/location,business_status')


def build_query(name: str, shop_area: str, area: str, geo_info) -> str:
    """33秒版 search_place と同じ検索文（店名 + 店エリア（無ければ検索エリア）+ 地域）"""
    shop_area = shop_area or area
    region = geo_info.get('region', '') if geo_info else ''
    return (f'{name} {shop_area} {region}' if region else f'{name} {shop_area}').strip()


def build_body(query: str, geo_info) -> dict:
    body = {'textQuery': query, 'languageCode': LANGUAGE, 'regionCode': REGION, 'pageSize': PAGE_SIZE}
    if geo_info and geo_info.get('lat') and geo_info.get('lng'):
        radius = JP_RADIUS_M if geo_info.get('country_code', 'JP') == 'JP' else OTHER_RADIUS_M
        body['locationBias'] = {'circle': {'center': {'latitude': geo_info['lat'], 'longitude': geo_info['lng']},
                                           'radiusMeters': radius}}
    return body


def parse_response(data: dict) -> dict:
    places = []
    for p in (data.get('places') or [])[:PAGE_SIZE]:
        pid = p.get('id') or (p.get('place') or '').split('/')[-1]
        if not pid:
            continue
        links = p.get('googleMapsLinks') or {}
        att = p.get('attribution') or {}
        places.append({'place_id': pid, 'place_url': links.get('placeUrl'),
                       'attribution': {'title': att.get('title'), 'url': att.get('url')}})
    return {'summary': data.get('summary') or '', 'places': places}


def search_text(api_key: str, name: str, shop_area: str, area: str, geo_info, http_post=None, timeout: float = 10.0):
    """returns dict(status='OK'|'ZERO_RESULTS'|'ERROR:<type>', summary, places, ms, http_status)"""
    post = http_post or requests.post
    t0 = time.monotonic()
    out = {'summary': '', 'places': [], 'http_status': None}
    try:
        r = post(SEARCH_TEXT_URL, json=build_body(build_query(name, shop_area, area, geo_info), geo_info),
                 headers={'Content-Type': 'application/json', 'X-Goog-Api-Key': api_key}, timeout=timeout)
    except requests.exceptions.Timeout:
        return {**out, 'status': 'ERROR:timeout', 'ms': int((time.monotonic() - t0) * 1000)}
    except requests.exceptions.RequestException as e:
        return {**out, 'status': f'ERROR:{type(e).__name__}', 'ms': int((time.monotonic() - t0) * 1000)}
    ms = int((time.monotonic() - t0) * 1000)
    out['http_status'] = r.status_code
    if r.status_code != 200:
        reason = ''
        try:
            err = r.json().get('error') or {}
            reason = (err.get('status') or '') + ':' + ','.join(
                d.get('reason', '') for d in err.get('details') or [] if isinstance(d, dict))
        except Exception:
            pass
        return {**out, 'status': redact(f'ERROR:HTTP{r.status_code}:{reason}'), 'ms': ms}
    try:
        parsed = parse_response(r.json())
    except ValueError:
        return {**out, 'status': 'ERROR:invalid_json', 'ms': ms}
    return {**out, **parsed, 'status': 'OK' if parsed['places'] else 'ZERO_RESULTS', 'ms': ms}


def details_for_card(place: dict, geo_info, language: str = LANGUAGE, http_get=None):
    """
    選択された place ID だけ Place Details（Legacy、33秒版と同じエンドポイント）を取得してカード情報を作る。
    33秒版と同じく国コード不一致は不採用。営業中でない（business_status が OPERATIONAL 以外）も不採用
    （33秒版の Text Search で閉店を除外していたのと同じ扱い）。
    returns (place_dict | None, reason)
    """
    get = http_get or legacy.requests.get
    try:
        data = get(DETAILS_URL, params={'place_id': place['place_id'], 'fields': DETAILS_FIELDS,
                                        'key': legacy.GOOGLE_PLACES_API_KEY, 'language': language}, timeout=10).json()
    except Exception as e:
        return None, f'details_error:{type(e).__name__}'
    if data.get('status') != 'OK':
        return None, f'details_error:{data.get("status")}'
    res = data.get('result') or {}
    if res.get('business_status', 'OPERATIONAL') != 'OPERATIONAL':
        return None, 'closed'
    country = next((cmp.get('short_name') for cmp in res.get('address_components') or []
                    if 'country' in cmp.get('types', [])), None)
    expected = geo_info.get('country_code', 'JP') if geo_info else 'JP'
    if country and expected and country != expected:
        return None, 'country_mismatch'
    loc = (res.get('geometry') or {}).get('location') or {}
    return {
        'place_id': place['place_id'],
        'name': res.get('name'),
        'rating': res.get('rating'),
        'user_ratings_total': res.get('user_ratings_total'),
        'formatted_address': res.get('formatted_address'),
        'country_code': country,
        'lat': loc.get('lat'),
        'lng': loc.get('lng'),
        'maps_url': place.get('place_url'),           # Agent Tools の googleMapsLinks.placeUrl（ソースリンク）
        'maps_attribution': place.get('attribution'),  # 表示必須の attribution（title・url）
        'phone': res.get('formatted_phone_number') or res.get('international_phone_number'),
    }, 'ok'
