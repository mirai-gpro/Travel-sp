# -*- coding: utf-8 -*-
"""
Places API (New) による実在・同一店舗の確認（推薦はしない・順位は変えない）

- POST https://places.googleapis.com/v1/places:searchText（FieldMask を明示。'*' は使わない）
- 1 候補につき 1 回の Text Search。返ってきた全結果を identity.judge で照合（1 位を無条件採用しない）
- API キーはヘッダー（X-Goog-Api-Key）で渡し、URL・ログ・結果に含めない
"""
import time

import requests

from . import contracts as c
from . import identity
from .redact import redact, register_secret

DEFAULT_TIMEOUT_SEC = 8.0


class PlacesNewClient:
    def __init__(self, api_key: str, http_post=None, timeout_sec: float = DEFAULT_TIMEOUT_SEC):
        if not api_key:
            raise c.ConfigError('GOOGLE_PLACES_API_KEY が設定されていません')
        self._api_key = api_key
        register_secret(api_key)
        self._post = http_post or requests.post
        self.timeout_sec = timeout_sec

    def search_text(self, text_query: str, language_code: str = 'ja', region_code: str = 'JP') -> list:
        r = self._post(c.PLACES_SEARCH_TEXT_URL, timeout=self.timeout_sec,
                       headers={'Content-Type': 'application/json', 'X-Goog-Api-Key': self._api_key,
                                'X-Goog-FieldMask': c.PLACES_FIELD_MASK},
                       json={'textQuery': text_query, 'languageCode': language_code, 'regionCode': region_code,
                             'pageSize': c.PLACES_PAGE_SIZE})
        if r.status_code != 200:
            raise RuntimeError(redact(f'places_http_{r.status_code}: {r.text[:200]}'))
        return r.json().get('places') or []


def build_query(candidate: c.Candidate) -> str:
    """「LLM 店名 + area_hint」。Live の user_request は自由文のため地域だけを機械的に切り出さない"""
    return f'{candidate.name} {candidate.area_hint}'.strip()


def verify_candidate(client: PlacesNewClient, candidate: c.Candidate, language_code='ja', region_code='JP',
                     now=time.monotonic) -> c.Verification:
    t0 = now()
    try:
        places = client.search_text(build_query(candidate), language_code, region_code)
    except requests.exceptions.Timeout:
        return c.Verification(candidate, c.API_ERROR, 'places_timeout', duration_ms=int((now() - t0) * 1000))
    except Exception as e:
        return c.Verification(candidate, c.API_ERROR, redact(f'places_error: {type(e).__name__}: {str(e)[:120]}'),
                              duration_ms=int((now() - t0) * 1000))
    status, reason, place, evidence = identity.judge(candidate, places)
    return c.Verification(candidate, status, reason, place=place, evidence=evidence,
                          duration_ms=int((now() - t0) * 1000))
