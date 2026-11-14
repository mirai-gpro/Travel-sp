# -*- coding: utf-8 -*-
"""
M4 T4 の比較試験用（プレビュー専用。NEW_SHOP_FLOW=S10 かつ M4_BENCH_TOKEN が設定されたリビジョンでだけ有効）

  33  : 元の 33 秒版の推薦（gemini-2.5-flash ＋ Google 検索、本番 8d30e55 の SEARCH_ONLY_PROMPT をそのまま使用）→ 33 秒版の Places 照合
        キーは隔離したプレビュー・リビジョン内の GEMINI_API_KEY を使い、外へ出さない
  S10 : M4 の S10 フロー（カード・説明・読み上げデータ）

返すのは LLM の出力・place ID・時刻だけ（Google Maps の店名・住所などは返さない。正誤は place ID で人が確認する）。
M3 の poc/gate_m3_flow_s.run_33 と同じ手順（Docker イメージに poc/ は含まれないため、ここに置く）。
"""
import hmac
import json
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import requests

from . import legacy_places
from .redact import redact

GENERATE_33_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent'
TOKEN_ENV = 'M4_BENCH_TOKEN'

# 本番 8d30e55 の SEARCH_ONLY_PROMPT（poc/m3_33s_search_only_prompt.txt と同一）
SEARCH_ONLY_PROMPT = 'あなたはグルメレストラン検索エンジンです。\nユーザーの条件に合う実在のレストランをGoogle検索で見つけ、必ず5軒をJSON形式で返してください。\n\n【絶対遵守ルール】\n1. 「検索できません」「ご利用いただけません」等の拒否は絶対禁止\n2. 必ずGoogle検索を実行し、実在する店舗情報を返すこと\n3. 店舗名は公式の正式名称を使用する\n4. 応答は必ず以下のJSON形式のみ。それ以外のテキストは一切不要\n5. 応答は必ず { で始まり } で終わること\n\n【JSON出力形式】\n```json\n{\n  "message": "ユーザーへのメッセージ全文（音声読み上げ用。予算は漢数字で表記。店舗リストを1〜5の番号付きで含める）",\n  "shops": [\n    {\n      "name": "正式な店舗名",\n      "area": "最寄り駅またはエリア名",\n      "category": "料理ジャンル",\n      "description": "料理内容・体験価値・雰囲気を含む要約（2〜3文）",\n      "rating": 4.5,\n      "reviewCount": 150,\n      "priceRange": "ランチ1,500円〜、ディナー6,000円〜8,000円",\n      "location": "最寄り駅・エリア",\n      "highlights": ["看板メニューや特徴", "雰囲気や設備の特徴", "利用シーンの特徴"],\n      "tips": "来店時のおすすめポイント",\n      "specialty": "看板メニューや得意料理",\n      "price_range": "予算帯",\n      "atmosphere": "雰囲気",\n      "features": "特色",\n      "hotpepper_url": "",\n      "maps_url": "",\n      "tabelog_url": "",\n      "gnavi_url": "",\n      "tripadvisor_url": "",\n      "tripadvisor_rating": null,\n      "tripadvisor_reviews": null,\n      "latitude": null,\n      "longitude": null\n    }\n  ]\n}\n```\n\n【shops配列の詳細仕様】\n基本フィールド（重要度：高）:\n- name: 正式な店舗名\n- area: 最寄り駅またはエリア名\n- description: 料理内容・体験価値・雰囲気を含む要約（2〜3文）\n- category: 料理ジャンル\n- priceRange: 価格帯（数字+カンマ形式、例：「ランチ2,000円〜、ディナー6,000円〜8,000円」）\n\n充実情報フィールド（推奨）:\n- rating: 評価（数値）\n- reviewCount: レビュー数\n- location: 最寄り駅・エリア\n- highlights: 3つ程度の特徴（配列）\n- tips: 来店時のおすすめポイント\n- specialty: 看板メニューや得意料理\n- atmosphere: 雰囲気\n- features: 特色\n\n外部リンク（取得できた場合のみ）:\n- hotpepper_url, maps_url, tabelog_url, gnavi_url, tripadvisor_url\n- tripadvisor_rating, tripadvisor_reviews\n- latitude, longitude\n\n【予算表記ルール】\n- messageフィールド内: 漢数字（五千円、一万円）で音声読み上げに対応\n- priceRangeフィールド: 数字+カンマ形式（6,000円〜8,000円）でカード表示に対応\n\n【messageの構成】\n1. 導入文（条件の要約）\n2. 店舗リスト（1〜5の番号付き、各店舗2〜3文の説明、予算は漢数字）\n3. 締め文（「気になるお店はありましたか？」等）\n'


def enabled() -> bool:
    from . import flow_s
    return flow_s.enabled() and bool(os.environ.get(TOKEN_ENV))


def token_ok(token) -> bool:
    want = os.environ.get(TOKEN_ENV, '')
    return bool(want) and isinstance(token, str) and hmac.compare_digest(token, want)


def parse_33_json(text):
    """33 秒版本番と同じ JSON 抽出（最初の { から対応する } まで）"""
    t = (text or '').strip()
    start = t.find('{')
    if start < 0:
        return None
    depth = 0
    for i in range(start, len(t)):
        if t[i] == '{':
            depth += 1
        elif t[i] == '}':
            depth -= 1
            if depth == 0:
                try:
                    return json.loads(t[start:i + 1])
                except ValueError:
                    return None
    return None


def run_33(q: str) -> dict:
    gkey = os.environ.get('GEMINI_API_KEY', '')
    if not gkey:
        return {'method': '33', 'error': 'no_gemini_api_key', 'stores': []}
    t0 = time.monotonic()
    ms = lambda: int((time.monotonic() - t0) * 1000)  # noqa: E731
    body = {'systemInstruction': {'parts': [{'text': SEARCH_ONLY_PROMPT}]},
            'contents': [{'role': 'user', 'parts': [{'text': f'検索条件: {q}'}]}],
            'tools': [{'google_search': {}}]}
    try:
        r = requests.post(GENERATE_33_URL, json=body, headers={'Content-Type': 'application/json', 'x-goog-api-key': gkey},
                          timeout=90)
    except requests.exceptions.RequestException as e:
        return {'method': '33', 'error': f'network:{type(e).__name__}', 'stores': []}
    t_rec = ms()
    if r.status_code != 200:
        return {'method': '33', 'error': redact(f'http_{r.status_code}'), 'stores': [], 't_rec': t_rec}
    data = r.json()
    text = ''.join(p.get('text', '') for cd in (data.get('candidates') or [])[:1]
                   for p in ((cd.get('content') or {}).get('parts') or []))
    obj = parse_33_json(text) or {}
    shops = obj.get('shops') or []
    area = legacy_places.resolve_area(q, 'ja')
    geo = legacy_places.region_info(area, 'ja')
    with ThreadPoolExecutor(max_workers=7) as ex:
        found = list(ex.map(lambda s: legacy_places.lookup(s.get('name', ''), s.get('area', ''), area, geo, 'ja'), shops))
    t_done = ms()
    stores = []
    for i, (s, pdat) in enumerate(zip(shops, found), 1):
        stores.append({'rank': i, 'rec': s.get('name', ''), 'hint': s.get('area', ''), 'path': 'legacy_places',
                       'place_id': (pdat or {}).get('place_id'), 't_done': t_done,
                       'specialty': s.get('specialty', ''), 'description': s.get('description', '')})
    return {'method': '33', 'stores': stores, 't_rec': t_rec, 't_done': t_done, 'n_shops': len(shops), 'parse_ok': bool(obj)}


def run_s10(q: str, flow) -> dict:
    """S10 をサーバー内で実行し、送信イベント（時刻つき）と最終結果を返す。説明の更新を待つため最大 40 秒待つ"""
    events, lock = [], threading.Lock()

    def emit(ev, payload):
        with lock:
            events.append((ev, payload))

    res = flow.run(q, emit=emit)
    t_end = time.monotonic() + 40
    a = getattr(flow, 'last_a_thread', None)
    if a is not None:
        a.join(max(0, t_end - time.monotonic()))
    final = next((p for ev, p in events if ev == 'shop_search_stage' and p.get('stage') == 'final'), None)
    preview = next((p for ev, p in events if ev == 'shop_search_stage' and p.get('stage') == 'preview'), None)
    details = {p['place_id']: (p['specialty'], p['reason'], p['t_ms']) for ev, p in events if ev == 'shop_card_detail'}
    cards = (final or {}).get('cards') or []
    stores = []
    for cd in cards:
        pid = cd.get('place_id')
        if pid in details:
            sp, rs, t = details[pid]
        else:                                  # 最終確定より前に説明が揃い、最終カードに含めて送った場合
            sp, rs, t = ((cd.get('highlights') or [''])[0], cd.get('description', ''),
                         None if cd.get('detail_pending') else (final or {}).get('t_ms'))
        stores.append({'rank': cd.get('recommend_rank'), 'rec': cd.get('llm_name'), 'hint': cd.get('area'),
                       'place_id': pid, 'specialty': sp, 'description': rs, 't_detail': t})
    m = res.get('metrics') or {}
    return {'method': 'S10', 'status': res.get('status'), 'shortfall': res.get('shortfall'), 'final_reason': res.get('final_reason'),
            't_preview': (preview or {}).get('t_ms'), 't_final': (final or {}).get('t_ms'), 'stores': stores,
            'narration': res.get('narration'), 'scope': m.get('scope'), 'store_paths': m.get('stores'),
            'events': m.get('events'), 'a_error': m.get('a_error'), 'b_error': m.get('b_error')}
