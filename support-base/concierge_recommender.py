# -*- coding: utf-8 -*-
"""
コンシェルジュの推薦（R2.0 §7）

- 店を選ぶのは LLM（R・R4）。Places は同じ店かを確かめるだけ（concierge_places）。
- 音声もキーボードも Live の search_shops から recommend_shops() だけを呼ぶ。
- 実在を確認した 5 店がそろったときだけ complete。未確認の店で埋めない。
- Google 検索は R の中でモデルが必要と判断したときだけ使う（方法B）。D-1 の承認まで GROUNDING_ENABLED は偽。
- 自動のやり直し、別モデル・旧方式への切り替えはしない。
"""
import json
import logging
import threading
from concurrent.futures import ThreadPoolExecutor

from google.genai import types

import api_integrations
import concierge_places as places

logger = logging.getLogger(__name__)

# §4.1（D-3）
RECOMMEND_MODEL = 'gemini-3.6-flash'
# LLM が返らない異常を止めるための打ち切り。目標の「20 秒以内に表示」とは別のもの（R2.0 §9.5）
LLM_TIMEOUT_MS = 20000
# 思考の量（R2.0 §7.2）。これだけで速くなるとはみなさない。品質は受入試験で判定する
THINKING_LEVEL = types.ThinkingLevel.LOW
# Google 検索（方法B）。D-1 の承認まで本番で有効にしない（R2.0 §7.7）
GROUNDING_ENABLED = False

MAX_CANDIDATES = 8       # 初回の候補の上限（12 から 8 に変更。5 店の確定率や時間を保証するものではない）
MAX_SUPPLEMENT = 8       # R4
CONFIRM_COUNT = 5

# 新店の経路（F1）。R2.0 では呼ばない（鮮度は R の中で扱う）。削除は A-3 の承認後
FRESH_ENABLED = False

# 結果の状態
COMPLETE = 'complete'
NOT_FOUND = 'not_found'
ERROR = 'error'
SUPERSEDED = 'superseded'

LANGUAGE_NAMES = {'ja': '日本語', 'en': 'English', 'zh': '中文', 'ko': '한국어'}

# 候補の項目（R2.0 §7.3）。照合に使う 5 項目と、カード・紹介に使う 5 項目
_CANDIDATE_ITEM = {
    'type': 'object',
    'properties': {
        'name': {'type': 'string'},
        'aliases': {'type': 'array', 'items': {'type': 'string'}},
        'branch': {'type': 'string'},
        'area': {'type': 'string'},
        'locality': {'type': 'string'},
        'genre': {'type': 'string'},
        'specialty': {'type': 'string'},
        'atmosphere': {'type': 'string'},
        'price_estimate': {'type': 'string'},
        'reason': {'type': 'string'},
    },
    'required': ['name', 'aliases', 'branch', 'area', 'locality', 'genre', 'specialty',
                 'atmosphere', 'price_estimate', 'reason'],
}

_FRESH_ITEM = {
    'type': 'object',
    'properties': dict(_CANDIDATE_ITEM['properties'], opened={'type': 'string'}),
    'required': _CANDIDATE_ITEM['required'] + ['opened'],
}

# enum は使わない（以前の PoC で enum を含むと 400 になった）
R1_SCHEMA = {
    'type': 'object',
    'properties': {
        'area': {'type': 'string'},
        'candidates': {'type': 'array', 'maxItems': MAX_CANDIDATES, 'items': _CANDIDATE_ITEM},
    },
    'required': ['area', 'candidates'],
}

R4_SCHEMA = {
    'type': 'object',
    'properties': {'candidates': {'type': 'array', 'maxItems': MAX_SUPPLEMENT, 'items': _CANDIDATE_ITEM}},
    'required': ['candidates'],
}

F1_SCHEMA = {
    'type': 'object',
    'properties': {'candidates': {'type': 'array', 'maxItems': MAX_CANDIDATES, 'items': _FRESH_ITEM}},
    'required': ['candidates'],
}

# ---- プロンプト（R2.0 §7.2） ----

_CANDIDATE_RULES = """【候補の規則】
1. 実在し、今も営業していると確信できる店だけを挙げる。確信できない店は挙げない。
2. 料理の質・専門性・個性・定評と、依頼の条件への適合を総合して、推薦したい順に並べる。人気順や近さだけで並べない。
3. 依頼に雰囲気の指定があれば最優先で守る。合わない店は、ほかの条件を満たしていても挙げない。
4. 条件に合わない店は挙げない。同じチェーンの店を重ねない。
5. name は店の正式名称、branch は支店名（なければ空）、aliases は今使われている別表記（旧店名は入れない）。
6. area は最寄り駅または地域名、locality は住所に含まれる市区町村名や町名。店の確認に使うので正確に書く。
7. 評価点・営業時間・URL は書かない。price_estimate は一人あたりの予算の目安。
8. 短く書く。specialty はその店ならではの料理や専門性を短い句 1 つ、atmosphere は店の雰囲気を短い句 1 つ、reason は依頼に合う推薦理由を一文で書く。文章は{language}で書く。
9. 条件に合う店が少なければ、無理に数をそろえない。"""

# Google 検索を有効にしたときだけ足す（R2.0 §7.2）
_SEARCH_RULE = """
【Google 検索】
新しく開店した店や最近の話題など、あなたの知識では古い可能性がある依頼のときだけ検索する。検索結果の順位や人気をそのまま推薦の順にしない。"""

R1_INSTRUCTION = """あなたは飲食店の推薦担当です。利用者の依頼に合う優良店を、あなた自身の知識で、推薦したい順に最大{max}件挙げます。
area には依頼のエリア名を書く（なければ空）。依頼に書かれていない条件を推測で補わない。
""" + _CANDIDATE_RULES + """{search}
出力は指定された JSON スキーマのみ。"""

R4_INSTRUCTION = """あなたは飲食店の推薦担当です。利用者の依頼に合う優良店を、あなた自身の知識で、推薦したい順に最大{max}件挙げます。「試した店」に含まれる店は挙げない。
""" + _CANDIDATE_RULES + """{search}
出力は指定された JSON スキーマのみ。"""

F1_INSTRUCTION = """あなたは飲食店の推薦担当です。Google 検索で、与えられた条件に合う最近開店した飲食店を探し、優先順に最大{max}件挙げます。
各候補に開店時期（opened）を書く。料理の特色・利用目的への適合・推薦理由も書き、定評・専門性・質・適合で並べる。人気順や検索結果の順に並べない。
""" + _CANDIDATE_RULES + """
出力は指定された JSON スキーマのみ。"""


class RecommendError(Exception):
    pass


def _lang(language: str) -> str:
    return LANGUAGE_NAMES.get(language, LANGUAGE_NAMES['ja'])


def _search_rule() -> str:
    return _SEARCH_RULE if GROUNDING_ENABLED else ''


def _call_json(gemini_client, instruction: str, contents: str, schema: dict, use_search: bool = False) -> dict:
    kwargs = dict(
        system_instruction=instruction,
        response_mime_type='application/json',
        response_json_schema=schema,
        thinking_config=types.ThinkingConfig(thinking_level=THINKING_LEVEL),
        http_options=types.HttpOptions(timeout=LLM_TIMEOUT_MS),
    )
    if use_search:
        # 検索と JSON スキーマの同時使用は、3.6-flash では実機で確かめる（R2.0 U-1）
        kwargs['tools'] = [types.Tool(google_search=types.GoogleSearch())]
    try:
        response = gemini_client.models.generate_content(
            model=RECOMMEND_MODEL, contents=contents, config=types.GenerateContentConfig(**kwargs))
    except Exception as e:
        # 既存のエラー文に HTTP ステータスも入れる（R2.0 §7.2。新しいログは足さない）
        code = getattr(e, 'code', None)
        raise RecommendError(f'{RECOMMEND_MODEL} 呼び出し失敗 ({type(e).__name__}{f" {code}" if code else ""})')
    text = getattr(response, 'text', None)
    if not text:
        raise RecommendError('応答が空')
    try:
        data = json.loads(text)
    except ValueError:
        raise RecommendError('応答が JSON ではない')
    if not isinstance(data, dict):
        raise RecommendError('応答がオブジェクトではない')
    return data


def _valid_candidates(items) -> list:
    if not isinstance(items, list):
        raise RecommendError('candidates が配列ではない')
    return [c for c in items if isinstance(c, dict) and (c.get('name') or '').strip()]


def generate_candidates(gemini_client, user_request: str, language: str):
    """R：候補の生成。(依頼のエリア名, 候補) を返す"""
    data = _call_json(
        gemini_client,
        R1_INSTRUCTION.format(max=MAX_CANDIDATES, language=_lang(language), search=_search_rule()),
        f'依頼: {user_request}',
        R1_SCHEMA,
        use_search=GROUNDING_ENABLED,
    )
    area = data.get('area')
    return (area if isinstance(area, str) else ''), _valid_candidates(data.get('candidates'))


def supplement_candidates(gemini_client, user_request: str, tried_names: list, language: str) -> list:
    """R4：補充（1 回だけ）。入力は元の依頼と試した店の名前"""
    data = _call_json(
        gemini_client,
        R4_INSTRUCTION.format(max=MAX_SUPPLEMENT, language=_lang(language), search=_search_rule()),
        f'依頼: {user_request}\n試した店: {json.dumps(tried_names, ensure_ascii=False)}',
        R4_SCHEMA,
        use_search=GROUNDING_ENABLED,
    )
    return _valid_candidates(data.get('candidates'))


def fresh_candidates(gemini_client, conditions: dict, language: str) -> list:
    """F1：新店の候補（Google 検索 1 回）。応答の本文は保存せず、ログには件数だけを書く"""
    data = _call_json(
        gemini_client,
        F1_INSTRUCTION.format(max=MAX_CANDIDATES, language=_lang(language)),
        f'条件: {json.dumps(conditions, ensure_ascii=False)}',
        F1_SCHEMA,
        use_search=True,
    )
    items = _valid_candidates(data.get('candidates'))
    logger.info(f'[Recommend] F1 の候補: {len(items)}件')
    return items


def conversation_item(order: int, c: dict, place_id: str, source: str) -> dict:
    """確定店の会話用の項目（§7）。LLM（C1・Live）にはこれだけを渡す"""
    item = {
        'order': order,
        'name': c.get('name', ''),
        'area': c.get('area', ''),
        'genre': c.get('genre', ''),
        'specialty': c.get('specialty', ''),
        'atmosphere': c.get('atmosphere', ''),
        'price_estimate': c.get('price_estimate', ''),
        'reason': c.get('reason', ''),
        'source': source,
        'place_id': place_id,
    }
    if source == 'fresh':
        item['opened'] = c.get('opened', '')
    return item


# 紹介の要点（talking_points）の見出し。値は推薦の項目をそのまま使い、新しく作らない
_TALKING_LABELS = {
    'ja': (('specialty', '看板料理'), ('atmosphere', '雰囲気'), ('reason', 'おすすめ理由'),
           ('price_estimate', '予算目安')),
    'en': (('specialty', 'Signature dish'), ('atmosphere', 'Atmosphere'), ('reason', 'Why we recommend it'),
           ('price_estimate', 'Budget')),
}


def talking_points(item: dict, language: str = 'ja') -> list:
    """
    確定店の紹介の要点（Live が紹介に使う箇条書き）。
    既存の推薦の項目（specialty・atmosphere・reason・price_estimate）から組み立てるだけで、
    LLM や外部 API は呼ばない。空の項目は入れない。
    """
    labels = _TALKING_LABELS.get(language, _TALKING_LABELS['en'])
    sep = '：' if language == 'ja' else ': '
    points = []
    for key, label in labels:
        value = (item.get(key) or '').strip()
        if value:
            points.append(f'{label}{sep}{value}')
    return points


def _result(status: str, reason_code: str = None, source: str = None, found_count: int = 0,
            shops: list = None, cards: list = None, card_geos: list = None) -> dict:
    return {
        'status': status,
        'reason_code': reason_code,
        'source': source,
        'found_count': found_count,
        'shops': shops or [],
        'cards': cards or [],
        # 表示後にリンクを取るときの位置の情報（cards と同じ順。R2.0 §8.4）
        'card_geos': card_geos or [],
    }


def recommend_shops(user_request: str, language: str = 'ja', origin: str = 'text', gemini_client=None,
                   area: str = '') -> dict:
    """
    推薦の唯一の入口（R2.0 §7）。
    area は search_shops で確認したエリア名。あれば Geocoding を R と並行して始める（§7.4）。
    戻り値：status（complete・not_found・error）、reason_code、source、found_count、
            shops（確定店の会話用の項目。complete のときだけ 5 件）、cards（画面用。complete のときだけ）。
    確定（SupportSession への保存）は呼び出し側が commit_shops で行う。
    """
    if gemini_client is None:
        from support_core import gemini_client as default_client
        gemini_client = default_client
    logger.info(f'[Recommend] 開始 origin={origin} language={language}')
    source = 'knowledge'

    # 位置：同じ地名は 1 回だけ Geocoding する。照合のワーカーからも呼ばれるのでロックする
    geo_cache = {}
    geo_lock = threading.Lock()

    def geo_of(name: str):
        key = (name or '').strip()
        if not key:
            return None
        with geo_lock:
            if key in geo_cache:
                return geo_cache[key]
        try:
            value = api_integrations.get_region_from_area(key, language)
        except Exception as e:
            logger.error(f'[Recommend] Geocoding の例外: {type(e).__name__}')
            value = None
        with geo_lock:
            return geo_cache.setdefault(key, value)

    # Geocoding を R と並行して始める（with は使わない。抜けるときに待つため）
    geo_future = None
    if (area or '').strip():
        geo_ex = ThreadPoolExecutor(max_workers=1)
        geo_future = geo_ex.submit(geo_of, area)
        geo_ex.shutdown(wait=False)

    try:
        r_area, candidates = generate_candidates(gemini_client, user_request, language)
    except RecommendError as e:
        logger.error(f'[Recommend] R 失敗: {e}')
        return _result(ERROR, 'llm')
    if not candidates:
        return _result(NOT_FOUND, 'no_candidates', source)

    # 先に始めた Geocoding を受け取る（Geocoding 自体の時間切れは 10 秒）。なければ R のエリア名で引く
    main_geo = geo_future.result() if geo_future else geo_of(r_area)

    def geo_for(c):
        return main_geo or geo_of(c.get('area', ''))

    confirmed = []          # [(候補, 結果, 位置)]
    seen_place_ids = set()
    seen_chains = set()
    tried_names = []
    counts = {'awaited': 0, 'no_response': 0}

    def accept(c, verdict, place):
        """照合の結果を順位の順に受け取る（メインスレッドだけで呼ばれる）。確定数を返す"""
        counts['awaited'] += 1
        if verdict == places.NO_RESPONSE:
            counts['no_response'] += 1
        elif verdict == places.SAME and len(confirmed) < CONFIRM_COUNT:
            chain = places.normalize(c.get('name', ''))
            if place['place_id'] not in seen_place_ids and chain not in seen_chains:
                seen_place_ids.add(place['place_id'])
                seen_chains.add(chain)
                confirmed.append((c, place, geo_for(c)))
        return len(confirmed)

    def run(stage_candidates):
        tried_names.extend(c.get('name', '') for c in stage_candidates)
        places.match_in_order(stage_candidates, geo_for, language, accept, CONFIRM_COUNT)

    def all_no_response() -> bool:
        return counts['awaited'] > 0 and counts['no_response'] == counts['awaited']

    run(candidates[:MAX_CANDIDATES])
    if len(confirmed) < CONFIRM_COUNT:
        if all_no_response():
            # Places が応答しない状態で候補を足しても確認できないので、R4 は呼ばない（§7.5）
            logger.error('[Recommend] Places の応答を 1 件も受け取れなかった')
            return _result(ERROR, 'places', source)
        try:
            extra = supplement_candidates(gemini_client, user_request, tried_names, language)
        except RecommendError as e:
            logger.error(f'[Recommend] R4 失敗: {e}')
            return _result(ERROR, 'llm', source, len(confirmed))
        tried = {places.normalize(n) for n in tried_names}
        extra = [c for c in extra if places.normalize(c.get('name', '')) not in tried]
        run(extra[:MAX_SUPPLEMENT])

    # 最終結果の判定（§7.5 の表。初回と R4 を合わせて 1 回だけ）
    found = len(confirmed)
    if found < CONFIRM_COUNT:
        if all_no_response():
            logger.error('[Recommend] Places の応答を 1 件も受け取れなかった')
            return _result(ERROR, 'places', source)
        reason = 'places_partial' if counts['no_response'] else 'too_few_verified'
        logger.info(f'[Recommend] 確認できた店は {found}件。5 店に届かず not_found（{reason}）')
        return _result(NOT_FOUND, reason, source, found)

    shops = [conversation_item(i, c, place['place_id'], source)
             for i, (c, place, _) in enumerate(confirmed, start=1)]
    # 5 店が確定した後だけ、紹介の要点を足す（確定店・順位・place_id は変えない）
    for item in shops:
        item['talking_points'] = talking_points(item, language)
    cards = places.build_cards(
        [(item, place, geo) for item, (_, place, geo) in zip(shops, confirmed)], language)
    logger.info(f'[Recommend] complete: {found}店')
    return _result(COMPLETE, None, source, found, shops, cards, [geo for _, _, geo in confirmed])
