# -*- coding: utf-8 -*-
"""
[C] Place Verifier の外部 API 呼び出し（DESIGN.md §4.1）。
Places の結果は照合と表示にだけ使い、LLM には渡さない。
"""
import requests

TEXTSEARCH_URL = 'https://maps.googleapis.com/maps/api/place/textsearch/json'
GEOCODE_URL = 'https://maps.googleapis.com/maps/api/geocode/json'
PHOTO_URL = 'https://maps.googleapis.com/maps/api/place/photo'
REQUEST_TIMEOUT_SEC = 5.0   # 暫定（PoC で決める）


class PlacesClient:
    def __init__(self, api_key, http_get=None, timeout=REQUEST_TIMEOUT_SEC):
        self.api_key = api_key
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

    def text_search(self, query, area_center=None, language='ja'):
        """results のリスト。API エラーは例外"""
        params = {'query': query, 'key': self.api_key, 'language': language, 'region': 'jp'}
        if area_center:
            params['location'] = f'{area_center[0]},{area_center[1]}'
            params['radius'] = 3000
        r = self.get(TEXTSEARCH_URL, params=params, timeout=self.timeout)
        data = r.json()
        status = data.get('status')
        if status == 'ZERO_RESULTS':
            return []
        if status != 'OK':
            raise RuntimeError(f'places_status_{status}')
        return data.get('results') or []

    def photo_url(self, place):
        photos = place.get('photos') or []
        if not photos:
            return None
        ref = photos[0].get('photo_reference')
        if not ref:
            return None
        return f'{PHOTO_URL}?maxwidth=800&photo_reference={ref}&key={self.api_key}'
