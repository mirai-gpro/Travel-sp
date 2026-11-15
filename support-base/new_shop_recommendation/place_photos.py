# -*- coding: utf-8 -*-
"""
M4: ショップカードの写真（Places API (New)）。preview-shop-v2（9ca50bb）の実装を S10 用に移したもの。
- Place Details (New) の photos から 1 枚目を選び、Place Photo (New) の photoUri（skipHttpRedirect=true）を得る
- API キーはヘッダーで送り、URL・ログ・戻り値に含めない（33 秒版の写真 URL はキーを含んでいたため使わない）
- 撮影者表記（authorAttributions）を返す。Google の規約により写真と一緒に表示する
- 取れなければ None（カードは既定の画像のまま）
"""
import logging

import requests

logger = logging.getLogger(__name__)
PLACES_API_BASE = 'https://places.googleapis.com/v1'
TIMEOUT_SEC = 8
PHOTO_MAX_WIDTH_PX = 800


def fetch_photo(api_key, photo, http=requests):
    name = photo.get('name') if isinstance(photo, dict) else None
    if not api_key or not name:
        return None
    try:
        resp = http.get(f'{PLACES_API_BASE}/{name}/media', params={'maxWidthPx': PHOTO_MAX_WIDTH_PX, 'skipHttpRedirect': 'true'},
                        headers={'X-Goog-Api-Key': api_key}, timeout=TIMEOUT_SEC)
    except requests.exceptions.RequestException as e:
        logger.warning(f'[NewShopRec][photo] 写真取得失敗 ({type(e).__name__})')
        return None
    if resp.status_code != 200:
        logger.warning(f'[NewShopRec][photo] 写真取得失敗 HTTP {resp.status_code}')
        return None
    try:
        uri = (resp.json() or {}).get('photoUri')
    except ValueError:
        return None
    if not uri or not str(uri).startswith('https://'):
        return None
    attributions = [{'displayName': a['displayName'], 'uri': a.get('uri') or ''}
                    for a in (photo.get('authorAttributions') or []) if isinstance(a, dict) and a.get('displayName')]
    return {'image': uri, 'attributions': attributions}


def fetch_shop_photo(api_key, place_id, http=requests):
    """店の 1 枚目の写真（photoUri と撮影者表記）。returns {'image','attributions'} or None"""
    if not api_key or not place_id:
        return None
    try:
        resp = http.get(f'{PLACES_API_BASE}/places/{place_id}', headers={'X-Goog-Api-Key': api_key, 'X-Goog-FieldMask': 'photos'},
                        timeout=TIMEOUT_SEC)
    except requests.exceptions.RequestException as e:
        logger.warning(f'[NewShopRec][photo] 写真情報の取得失敗 ({type(e).__name__})')
        return None
    if resp.status_code != 200:
        logger.warning(f'[NewShopRec][photo] 写真情報の取得失敗 HTTP {resp.status_code}')
        return None
    try:
        photos = (resp.json() or {}).get('photos') or []
    except ValueError:
        return None
    return fetch_photo(api_key, photos[0], http=http) if photos else None
