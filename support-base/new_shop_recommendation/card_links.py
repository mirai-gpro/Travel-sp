# -*- coding: utf-8 -*-
"""
M4: ショップカードの外部リンク（33 秒版 api_integrations.enrich_shops_with_photos の「3. データの注入」A・B と同じ規則）
  日本語かつ日本国内 → ホットペッパー（API で検索、無ければ Google 検索リンク）・食べログ（検索リンク）・ぐるなび（Google 検索リンク）
  それ以外           → TripAdvisor（API で検索。日本語で無ければ英語で再検索）
api_integrations の関数（search_hotpepper・get_tripadvisor_data）をそのまま呼ぶ。キーはリビジョン内の既存の設定を使う。
"""
import logging

import requests

logger = logging.getLogger(__name__)
PREF_CODE_MAP = {'東京': 'tokyo', '神奈川': 'kanagawa', '大阪': 'osaka', '京都': 'kyoto', '兵庫': 'hyogo', '北海道': 'hokkaido',
                 '愛知': 'aichi', '福岡': 'fukuoka'}


def links_for(shop_name, places_name, area, geo_info, country, lat=None, lng=None, language='ja', legacy=None):
    """returns {'hotpepper_url','tabelog_url','gnavi_url'} or {'tripadvisor_url','tripadvisor_rating','tripadvisor_reviews'}"""
    if legacy is None:
        import api_integrations as legacy
    out = {}
    if language == 'ja' and country == 'JP':
        hp = None
        try:
            hp = legacy.search_hotpepper(shop_name, area, geo_info)
            if not hp and places_name and places_name != shop_name:
                hp = legacy.search_hotpepper(places_name, area, geo_info)
        except Exception:
            pass
        out['hotpepper_url'] = hp if hp else f"https://www.google.com/search?q={shop_name}+{area}+ホットペッパーグルメ"
        try:
            region_name = geo_info.get('region', '') if geo_info else '東京'
            pref = region_name.rstrip('都道府県') if region_name else '東京'
            q = requests.utils.quote(places_name if places_name else shop_name)
            out['tabelog_url'] = f"https://tabelog.com/{PREF_CODE_MAP.get(pref, 'tokyo')}/rstLst/?sw={q}"
        except Exception:
            out['tabelog_url'] = f"https://tabelog.com/tokyo/rstLst/?sw={shop_name}"
        out['gnavi_url'] = f"https://www.google.com/search?q={shop_name}+{area}+ぐるなび"
        return out
    try:
        if getattr(legacy, 'TRIPADVISOR_API_KEY', None):
            lang = {'ja': 'ja', 'en': 'en', 'zh': 'zh', 'ko': 'ko'}.get(language, 'en')
            d = legacy.get_tripadvisor_data(shop_name, lat, lng, lang)
            if not d and lang == 'ja':
                d = legacy.get_tripadvisor_data(shop_name, lat, lng, 'en')
            if d:
                out.update(tripadvisor_url=d.get('web_url'), tripadvisor_rating=d.get('rating'),
                           tripadvisor_reviews=d.get('num_reviews'))
    except Exception as e:
        logger.error(f'[NewShopRec][links] TripAdvisor Error: {type(e).__name__}')
    return out
