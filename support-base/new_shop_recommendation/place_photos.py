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


def format_price_range(pr):
    """Places API (New) の priceRange（例: {startPrice:{units:'2000'}, endPrice:{units:'3000'}}）→ 「¥2,000〜¥3,000」"""
    if not isinstance(pr, dict):
        return ''

    def yen(p):
        try:
            return f"¥{int((p or {}).get('units')):,}"
        except (TypeError, ValueError):
            return ''
    a, b = yen(pr.get('startPrice')), yen(pr.get('endPrice'))
    return f'{a}〜{b}' if a and b else (f'{a}〜' if a else (f'〜{b}' if b else ''))


def fetch_place_extra(api_key, place_id, http=requests):
    """
    カードに足す Places (New) の情報: 写真（photoUri・撮影者表記）、価格帯（priceRange）、業種名（primaryTypeDisplayName）。
    returns {'image','attributions','price_range','type_name'}（取れた項目だけ）or None
    """
    if not api_key or not place_id:
        return None
    try:
        resp = http.get(f'{PLACES_API_BASE}/places/{place_id}',
                        headers={'X-Goog-Api-Key': api_key, 'X-Goog-FieldMask': 'photos,priceRange,primaryTypeDisplayName',
                                 'Accept-Language': 'ja'}, timeout=TIMEOUT_SEC)
    except requests.exceptions.RequestException as e:
        logger.warning(f'[NewShopRec][photo] 写真情報の取得失敗 ({type(e).__name__})')
        return None
    if resp.status_code != 200:
        logger.warning(f'[NewShopRec][photo] 写真情報の取得失敗 HTTP {resp.status_code}')
        return None
    try:
        data = resp.json() or {}
    except ValueError:
        return None
    out = {}
    photos = data.get('photos') or []
    ph = fetch_photo(api_key, photos[0], http=http) if photos else None
    if ph:
        out.update(ph)
    pr = format_price_range(data.get('priceRange'))
    if pr:
        out['price_range'] = pr
    tn = (data.get('primaryTypeDisplayName') or {}).get('text')
    if tn:
        out['type_name'] = tn
    return out or None


def fetch_shop_photo(api_key, place_id, http=requests):
    """互換用: 写真だけ（{'image','attributions'} or None）"""
    ex = fetch_place_extra(api_key, place_id, http=http) or {}
    return {'image': ex['image'], 'attributions': ex.get('attributions') or []} if ex.get('image') else None
