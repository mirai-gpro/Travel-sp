# -*- coding: utf-8 -*-
"""
[C] Place Verifier の外部 API 呼び出し（DESIGN.md §4.1）。
Places の結果は照合と表示にだけ使い、LLM には渡さない。
"""
import requests

from .redact import register_secret

TEXTSEARCH_URL = 'https://maps.googleapis.com/maps/api/place/textsearch/json'
GEOCODE_URL = 'https://maps.googleapis.com/maps/api/geocode/json'
REQUEST_TIMEOUT_SEC = 5.0   # 暫定（PoC で決める）


class PlacesClient:
    def __init__(self, api_key, http_get=None, timeout=REQUEST_TIMEOUT_SEC):
        self.api_key = api_key
        register_secret(api_key)
        self.get = http_get or requests.get
        self.timeout = timeout

    def geocode(self, area, language='ja'):
        """(lat, lng) or None"""
        if not area or not self.api_key:
            return None
        r = self.get(GEOCODE_URL, params={'address': area, 'key': self.api_key, 'language': language,
                                          'region': 'jp'}, timeout=self.timeout)
        data = r.json()
        if data.get('status') != 'OK' or not data.get('results'):
            return None
        loc = data['results'][0].get('geometry', {}).get('location', {})
        if loc.get('lat') is None:
            return None
        return (loc['lat'], loc['lng'])

    def text_search(self, query, language='ja'):
        """results のリスト。API エラーは例外。
        位置バイアス（location/radius）は付けない: Geocoding の完了を待たずに照会を始めるため（修正1）。
        エリアはクエリ文字列に含める。位置の確認は照合（matching.location_ok）で行う。"""
        params = {'query': query, 'key': self.api_key, 'language': language, 'region': 'jp'}
        r = self.get(TEXTSEARCH_URL, params=params, timeout=self.timeout)
        data = r.json()
        status = data.get('status')
        if status == 'ZERO_RESULTS':
            return []
        if status != 'OK':
            raise RuntimeError(f'places_status_{status}')
        return data.get('results') or []

    @staticmethod
    def photo_reference(place):
        """写真の参照 ID のみを返す。API キー入りの写真 URL は作らない（修正3。配信方法は Step 4 で決める）"""
        photos = place.get('photos') or []
        return (photos[0].get('photo_reference') if photos else None) or None
