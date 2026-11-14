# -*- coding: utf-8 -*-
"""
M4 T4 の比較試験用（呼び出しは認証トークンと回数制限つき）（プレビュー専用。NEW_SHOP_FLOW=S10 かつ M4_BENCH_TOKEN が設定されたリビジョンでだけ有効）

  33  : 元の 33 秒版（gemini-2.5-flash ＋ Google 検索、本番 8d30e55 の SEARCH_ONLY_PROMPT）→ 本番と同じ enrich_shops_with_photos
        キーは隔離したプレビュー・リビジョン内の GEMINI_API_KEY を使い、外へ出さない
  S10 : M4 の S10 フロー（カード・説明・読み上げデータ）

返すのは LLM の出力・place ID・時刻だけ（Google Maps の店名・住所などは返さない。正誤は place ID で人が確認する）。
33 秒版は本番 8d30e55 のコード（shop_search_callback 案C ＋ _handle_shop_search の enrich）と同じ処理（production_33）。
scope: R1 の検索範囲の確認（Geocoding のみ）。
"""
import hmac
import json
import os
import threading
import time

from .redact import redact

TOKEN_ENV = 'M4_BENCH_TOKEN'

# 本番 8d30e55 の SEARCH_ONLY_PROMPT（poc/m3_33s_search_only_prompt.txt と同一）
SEARCH_ONLY_PROMPT = 'あなたはグルメレストラン検索エンジンです。\nユーザーの条件に合う実在のレストランをGoogle検索で見つけ、必ず5軒をJSON形式で返してください。\n\n【絶対遵守ルール】\n1. 「検索できません」「ご利用いただけません」等の拒否は絶対禁止\n2. 必ずGoogle検索を実行し、実在する店舗情報を返すこと\n3. 店舗名は公式の正式名称を使用する\n4. 応答は必ず以下のJSON形式のみ。それ以外のテキストは一切不要\n5. 応答は必ず { で始まり } で終わること\n\n【JSON出力形式】\n```json\n{\n  "message": "ユーザーへのメッセージ全文（音声読み上げ用。予算は漢数字で表記。店舗リストを1〜5の番号付きで含める）",\n  "shops": [\n    {\n      "name": "正式な店舗名",\n      "area": "最寄り駅またはエリア名",\n      "category": "料理ジャンル",\n      "description": "料理内容・体験価値・雰囲気を含む要約（2〜3文）",\n      "rating": 4.5,\n      "reviewCount": 150,\n      "priceRange": "ランチ1,500円〜、ディナー6,000円〜8,000円",\n      "location": "最寄り駅・エリア",\n      "highlights": ["看板メニューや特徴", "雰囲気や設備の特徴", "利用シーンの特徴"],\n      "tips": "来店時のおすすめポイント",\n      "specialty": "看板メニューや得意料理",\n      "price_range": "予算帯",\n      "atmosphere": "雰囲気",\n      "features": "特色",\n      "hotpepper_url": "",\n      "maps_url": "",\n      "tabelog_url": "",\n      "gnavi_url": "",\n      "tripadvisor_url": "",\n      "tripadvisor_rating": null,\n      "tripadvisor_reviews": null,\n      "latitude": null,\n      "longitude": null\n    }\n  ]\n}\n```\n\n【shops配列の詳細仕様】\n基本フィールド（重要度：高）:\n- name: 正式な店舗名\n- area: 最寄り駅またはエリア名\n- description: 料理内容・体験価値・雰囲気を含む要約（2〜3文）\n- category: 料理ジャンル\n- priceRange: 価格帯（数字+カンマ形式、例：「ランチ2,000円〜、ディナー6,000円〜8,000円」）\n\n充実情報フィールド（推奨）:\n- rating: 評価（数値）\n- reviewCount: レビュー数\n- location: 最寄り駅・エリア\n- highlights: 3つ程度の特徴（配列）\n- tips: 来店時のおすすめポイント\n- specialty: 看板メニューや得意料理\n- atmosphere: 雰囲気\n- features: 特色\n\n外部リンク（取得できた場合のみ）:\n- hotpepper_url, maps_url, tabelog_url, gnavi_url, tripadvisor_url\n- tripadvisor_rating, tripadvisor_reviews\n- latitude, longitude\n\n【予算表記ルール】\n- messageフィールド内: 漢数字（五千円、一万円）で音声読み上げに対応\n- priceRangeフィールド: 数字+カンマ形式（6,000円〜8,000円）でカード表示に対応\n\n【messageの構成】\n1. 導入文（条件の要約）\n2. 店舗リスト（1〜5の番号付き、各店舗2〜3文の説明、予算は漢数字）\n3. 締め文（「気になるお店はありましたか？」等）\n'


MAX_CALLS_ENV = 'M4_BENCH_MAX_CALLS'
_guard_lock = threading.Lock()
_busy = threading.Lock()
_calls = {'n': 0}


def acquire() -> str:
    """呼び出し制限: 同時 1 件、リビジョンの起動から合計 M4_BENCH_MAX_CALLS 件（既定 150）。returns '' or 拒否理由"""
    limit = int(os.environ.get(MAX_CALLS_ENV, '150') or 150)
    with _guard_lock:
        if _calls['n'] >= limit:
            return 'call_limit_reached'
        if not _busy.acquire(blocking=False):
            return 'busy'
        _calls['n'] += 1
        return ''


def release():
    try:
        _busy.release()
    except RuntimeError:
        pass


def run_scope(q: str, flow) -> dict:
    """R1 の検索範囲の確認（Geocoding のみ。プレビュー用 Maps キーを使う）"""
    from . import scope as S
    sc = S.resolve_scope(q, flow.apis.geocode)
    return {'method': 'scope', 'query': q, **{k: sc.get(k) for k in ('area', 'kind', 'radius_km', 'radius_reason',
                                                                     'scope_reason', 'places', 'prefecture',
                                                                     'facility_address_key')}}


def enabled() -> bool:
    from . import flow_s
    return flow_s.enabled() and bool(os.environ.get(TOKEN_ENV))


def token_ok(token) -> bool:
    want = os.environ.get(TOKEN_ENV, '')
    return bool(want) and isinstance(token, str) and hmac.compare_digest(token, want)


def production_33(user_request: str, lang: str = 'ja'):
    """
    本番 8d30e55 の 33 秒版と同じ処理（app_customer_support.shop_search_callback の 案C ＋
    live_api_handler._handle_shop_search の enrich）。違いは計測用に時刻と LLM の店名を記録することだけ。
      - google-genai SDK・gemini-2.5-flash・system_instruction=SEARCH_ONLY_PROMPT・Google 検索ツール・
        contents=[{"role":"user","parts":[{"text": f"検索条件: {user_request}"}]}]・生成設定は既定のまま
      - JSON 抽出（最初の { から対応する } まで）。json.JSONDecodeError のときだけ extract_shops_from_response
      - shops があれば area = extract_area_from_text(user_request, lang)
      - enrich_shops_with_photos(raw_shops, area, lang)。結果が空なら raw_shops を表示（本番と同じ）
    returns (shops_for_cards, llm_names_by_id, t_rec_ms, t_done_ms)
    """
    from google import genai
    from google.genai import types
    import api_integrations as legacy
    t0 = time.monotonic()
    ms = lambda: int((time.monotonic() - t0) * 1000)  # noqa: E731
    gemini_client = genai.Client(api_key=os.getenv("GEMINI_API_KEY"))
    config = types.GenerateContentConfig(
        system_instruction=SEARCH_ONLY_PROMPT,
        tools=[types.Tool(google_search=types.GoogleSearch())],
    )
    response = gemini_client.models.generate_content(
        model="gemini-2.5-flash",
        contents=[{"role": "user", "parts": [{"text": f"検索条件: {user_request}"}]}],
        config=config
    )
    assistant_text = response.text
    t_rec = ms()
    shops = []
    try:
        text = assistant_text.strip()
        start = text.find('{')
        if start >= 0:
            brace_count = 0
            end = -1
            for i in range(start, len(text)):
                if text[i] == '{':
                    brace_count += 1
                elif text[i] == '}':
                    brace_count -= 1
                    if brace_count == 0:
                        end = i + 1
                        break
            if end > 0:
                data = json.loads(text[start:end])
                shops = data.get('shops', [])
    except json.JSONDecodeError:
        shops = legacy.extract_shops_from_response(assistant_text)
    if shops is None:
        shops = []
    names = {id(sh): (sh.get('name', ''), sh.get('area', ''), sh.get('specialty', ''), sh.get('description', ''))
             for sh in shops if isinstance(sh, dict)}
    if not shops:
        return [], names, t_rec, ms()
    area = legacy.extract_area_from_text(user_request, lang)
    enriched = legacy.enrich_shops_with_photos(shops, area, lang)
    out = enriched if enriched else shops
    return out, names, t_rec, ms()


def run_33(q: str) -> dict:
    if not os.environ.get('GEMINI_API_KEY'):
        return {'method': '33', 'error': 'no_gemini_api_key', 'stores': []}
    try:
        shops, names, t_rec, t_done = production_33(q)
    except Exception as e:                  # 本番では callback が None を返し、カード 0 件になる
        return {'method': '33', 'error': redact(f'exception:{type(e).__name__}'), 'stores': []}
    stores = []
    for i, sh in enumerate(shops, 1):
        llm_name, llm_area, sp, desc = names.get(id(sh), ('', '', '', ''))
        stores.append({'rank': i, 'rec': llm_name, 'hint': llm_area, 'path': 'legacy_enrich',
                       'place_id': sh.get('place_id'), 't_done': t_done, 'specialty': sp, 'description': desc})
    return {'method': '33', 'stores': stores, 't_rec': t_rec, 't_done': t_done, 'n_shops': len(names)}


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
