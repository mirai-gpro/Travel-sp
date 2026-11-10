# -*- coding: utf-8 -*-
"""
コンシェルジュの推薦（R1.4 最終版 §3・§4）

- 店を選ぶのは LLM（R1・R4）。Places は同じ店かを確かめるだけ（concierge_places）。
- キーボード（/api/chat）も音声（Live の search_shops）も recommend_shops() だけを呼ぶ。
- 5 店そろったときだけ complete。3〜4 店は確定しない（R1.0 DATA-02。RC-1）。
- 通常の推薦では Google 検索を使わない。新店の依頼だけ F1 で補う（D-1 まで無効）。
- 自動のやり直し、別モデル・旧方式への切り替えはしない（§9）。

プロンプトの文面は草案で、実装前の承認（D-4）を受けて確定する。
モデルは §4.1 の推奨（D-3）。
"""
import json
import logging

from google.genai import types

import api_integrations
import concierge_places as places

logger = logging.getLogger(__name__)

# §4.1（D-3）
RECOMMEND_MODEL = 'gemini-3.6-flash'
# LLM の待ち時間。shop_search_v2.LLM_TIMEOUT_MS と同じ値（推奨値。受入で見直す）
LLM_TIMEOUT_MS = 20000

MAX_CANDIDATES = 12      # §3.1（推奨値。受入で見直す）
MAX_SUPPLEMENT = 8       # §3.2 R4
STAGE1 = 7               # §3.2 第 1 段は優先順 1〜7 位
CONFIRM_COUNT = 5        # §3.4

# 新店の経路（F1）。D-1 の確認が済むまで無効（§3.6）。本番設定は変えない
FRESH_ENABLED = False

# 結果の状態（§3.5）
COMPLETE = 'complete'
NOT_FOUND = 'not_found'
ERROR = 'error'
SUPERSEDED = 'superseded'

LANGUAGE_NAMES = {'ja': '日本語', 'en': 'English', 'zh': '中文', 'ko': '한국어'}

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
        'fit': {'type': 'array', 'items': {'type': 'string'}},
        'reason': {'type': 'string'},
        'freshness_concern': {'type': 'boolean'},
    },
    'required': ['name', 'aliases', 'branch', 'area', 'locality', 'genre', 'specialty',
                 'atmosphere', 'price_estimate', 'fit', 'reason', 'freshness_concern'],
}

_FRESH_ITEM = {
    'type': 'object',
    'properties': dict(_CANDIDATE_ITEM['properties'], opened={'type': 'string'}),
    'required': _CANDIDATE_ITEM['required'] + ['opened'],
}

# enum は使わない（以前の PoC で enum を含むと 400 になった。§3.1）
R1_SCHEMA = {
    'type': 'object',
    'properties': {
        'conditions': {
            'type': 'object',
            'properties': {
                'area': {'type': 'string'},
                'cuisine': {'type': 'string'},
                'budget': {'type': 'string'},
                'occasion': {'type': 'string'},
                'atmosphere': {'type': 'string'},
                'party_size': {'type': 'string'},
                'must_have': {'type': 'array', 'items': {'type': 'string'}},
                'avoid': {'type': 'array', 'items': {'type': 'string'}},
                'recency_requested': {'type': 'boolean'},
                'prefecture': {'type': 'string'},
            },
            'required': ['area', 'cuisine', 'budget', 'occasion', 'atmosphere', 'party_size',
                         'must_have', 'avoid', 'recency_requested', 'prefecture'],
        },
        'candidates': {'type': 'array', 'maxItems': MAX_CANDIDATES, 'items': _CANDIDATE_ITEM},
    },
    'required': ['conditions', 'candidates'],
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

# ---- プロンプト（草案。D-4 の承認で確定する） ----

_CANDIDATE_RULES = """【候補の規則】
1. 実在を確信できる店だけを挙げる。確信できない店は挙げない。
2. 定評・専門性・料理の質・利用場面への適合・個性を総合して並べる。人気順や近さだけで並べない。
3. 条件に合わない店は挙げない。同じチェーンの店を重ねない。
4. name は店の正式名称、branch は支店名（なければ空）、aliases は今使われている別表記（旧店名は入れない）。
5. area は最寄り駅または地域名、locality は住所に含まれる市区町村名や町名。
6. 評価点・営業時間・URL は書かない。price_estimate は一人あたりの予算の目安。
7. fit は条件ごとの適合を短く、reason は推薦理由を 2〜3 文で書く。文章は{language}で書く。
8. 閉店・移転・改称の可能性があると思う店は freshness_concern を true にする。
9. 条件に合う店が少なければ、無理に数をそろえない。"""

R1_INSTRUCTION = """あなたは飲食店の推薦担当です。利用者の依頼から条件を取り出し、あなた自身の知識で、条件に合う優良店の候補を優先順に最大{max}件挙げます。
【条件の規則】
依頼に書かれていない条件は空のままにし、推測で補わない。recency_requested は、利用者が新しく開店した店・最近できた店を求めているときだけ true にする。
""" + _CANDIDATE_RULES + """
出力は指定された JSON スキーマのみ。"""

R4_INSTRUCTION = """あなたは飲食店の推薦担当です。与えられた条件に合う優良店の候補を、あなた自身の知識で優先順に最大{max}件挙げます。「試した店」に含まれる店は挙げない。
""" + _CANDIDATE_RULES + """
出力は指定された JSON スキーマのみ。"""

F1_INSTRUCTION = """あなたは飲食店の推薦担当です。Google 検索で、与えられた条件に合う最近開店した飲食店を探し、優先順に最大{max}件挙げます。
各候補に開店時期（opened）を書く。料理の特色・利用目的への適合・推薦理由も書き、定評・専門性・質・適合で並べる。人気順や検索結果の順に並べない。
""" + _CANDIDATE_RULES + """
出力は指定された JSON スキーマのみ。"""


class RecommendError(Exception):
    pass


def _lang(language: str) -> str:
    return LANGUAGE_NAMES.get(language, LANGUAGE_NAMES['ja'])


def _call_json(gemini_client, instruction: str, contents: str, schema: dict, use_search: bool = False) -> dict:
    kwargs = dict(
        system_instruction=instruction,
        response_mime_type='application/json',
        response_json_schema=schema,
        http_options=types.HttpOptions(timeout=LLM_TIMEOUT_MS),
    )
    if use_search:
        # JSON スキーマ指定と Google 検索を同時に使えるかは U-09 で確かめる
        kwargs['tools'] = [types.Tool(google_search=types.GoogleSearch())]
    try:
        response = gemini_client.models.generate_content(
            model=RECOMMEND_MODEL, contents=contents, config=types.GenerateContentConfig(**kwargs))
    except Exception as e:
        raise RecommendError(f'{RECOMMEND_MODEL} 呼び出し失敗 ({type(e).__name__})')
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
    """R1：条件の構造化と候補生成"""
    data = _call_json(
        gemini_client,
        R1_INSTRUCTION.format(max=MAX_CANDIDATES, language=_lang(language)),
        f'依頼: {user_request}',
        R1_SCHEMA,
    )
    conditions = data.get('conditions')
    if not isinstance(conditions, dict):
        raise RecommendError('conditions がない')
    return conditions, _valid_candidates(data.get('candidates'))


def supplement_candidates(gemini_client, conditions: dict, tried_names: list, language: str) -> list:
    """R4：補充（1 回だけ）"""
    data = _call_json(
        gemini_client,
        R4_INSTRUCTION.format(max=MAX_SUPPLEMENT, language=_lang(language)),
        f'条件: {json.dumps(conditions, ensure_ascii=False)}\n試した店: {json.dumps(tried_names, ensure_ascii=False)}',
        R4_SCHEMA,
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
        'fit': list(c.get('fit') or []),
        'source': source,
        'place_id': place_id,
    }
    if source == 'fresh':
        item['opened'] = c.get('opened', '')
    return item


def _result(status: str, reason_code: str = None, source: str = None, found_count: int = 0,
            shops: list = None, cards: list = None) -> dict:
    return {
        'status': status,
        'reason_code': reason_code,
        'source': source,
        'found_count': found_count,
        'shops': shops or [],
        'cards': cards or [],
    }


def recommend_shops(user_request: str, language: str = 'ja', origin: str = 'text', gemini_client=None) -> dict:
    """
    推薦の唯一の入口（§3、P-05）。
    戻り値：status（complete・not_found・error）、reason_code、source、found_count、
            shops（確定店の会話用の項目。complete のときだけ 5 件）、cards（画面用。complete のときだけ）。
    確定（SupportSession への保存）は呼び出し側が commit_shops で行う。
    """
    if gemini_client is None:
        from support_core import gemini_client as default_client
        gemini_client = default_client
    logger.info(f'[Recommend] 開始 origin={origin} language={language}')

    try:
        conditions, candidates = generate_candidates(gemini_client, user_request, language)
    except RecommendError as e:
        logger.error(f'[Recommend] R1 失敗: {e}')
        return _result(ERROR, 'llm')

    source = 'knowledge'
    if conditions.get('recency_requested'):
        if not FRESH_ENABLED:
            logger.info('[Recommend] 新店の依頼。F1 は無効（D-1）')
            return _result(NOT_FOUND, 'fresh_disabled')
        source = 'fresh'
        try:
            candidates = fresh_candidates(gemini_client, conditions, language)
        except RecommendError as e:
            logger.error(f'[Recommend] F1 失敗: {e}')
            return _result(ERROR, 'llm')

    if not candidates:
        return _result(NOT_FOUND, 'no_candidates', source)

    # 位置：条件の area を座標にする。取れなければ候補ごとの area。同じ地名は 1 回だけ
    geo_cache = {}

    def geo_of(area: str):
        key = (area or '').strip()
        if not key:
            return None
        if key not in geo_cache:
            try:
                geo_cache[key] = api_integrations.get_region_from_area(key, language)
            except Exception as e:
                logger.error(f'[Recommend] Geocoding の例外: {type(e).__name__}')
                geo_cache[key] = None
        return geo_cache[key]

    main_geo = geo_of(conditions.get('area', ''))

    def geo_for(c):
        return main_geo or geo_of(c.get('area', ''))

    confirmed = []          # [(候補, 結果, 位置)]
    seen_place_ids = set()
    seen_chains = set()
    tried_names = []
    any_response = False
    attempted = 0

    def run_stage(stage_candidates):
        nonlocal any_response, attempted
        # 鮮度に疑いのある候補は照合せず、確定しない（§3.4）
        targets = [c for c in stage_candidates if not c.get('freshness_concern')]
        tried_names.extend(c.get('name', '') for c in stage_candidates)
        attempted += len(targets)
        matched, ok = places.match_candidates(targets, geo_for, language)
        any_response = any_response or ok
        # 採用は常に LLM の優先順（§3.4）
        for c, verdict, place in matched:
            if len(confirmed) >= CONFIRM_COUNT:
                break
            if verdict != places.SAME:
                continue
            chain = places.normalize(c.get('name', ''))
            if place['place_id'] in seen_place_ids or chain in seen_chains:
                continue
            seen_place_ids.add(place['place_id'])
            seen_chains.add(chain)
            confirmed.append((c, place, geo_for(c)))

    def places_down() -> bool:
        return attempted > 0 and not any_response

    run_stage(candidates[:STAGE1])
    if places_down():
        logger.error('[Recommend] Places の応答を 1 件も受け取れなかった')
        return _result(ERROR, 'places', source)
    if len(confirmed) < CONFIRM_COUNT and len(candidates) > STAGE1:
        run_stage(candidates[STAGE1:MAX_CANDIDATES])
    if len(confirmed) < CONFIRM_COUNT and source == 'knowledge':
        try:
            extra = supplement_candidates(gemini_client, conditions, tried_names, language)
        except RecommendError as e:
            logger.error(f'[Recommend] R4 失敗: {e}')
            return _result(ERROR, 'llm', source, len(confirmed))
        extra = [c for c in extra if places.normalize(c.get('name', '')) not in
                 {places.normalize(n) for n in tried_names}]
        run_stage(extra[:MAX_SUPPLEMENT])

    if places_down():
        logger.error('[Recommend] Places の応答を 1 件も受け取れなかった')
        return _result(ERROR, 'places', source)

    found = len(confirmed)
    if found < CONFIRM_COUNT:
        logger.info(f'[Recommend] 確認できた店は {found}件。5 店に届かず not_found')
        return _result(NOT_FOUND, 'too_few_verified', source, found)

    shops = [conversation_item(i, c, place['place_id'], source)
             for i, (c, place, _) in enumerate(confirmed, start=1)]
    cards = places.build_cards(
        [(item, place, geo) for item, (_, place, geo) in zip(shops, confirmed)], language)
    logger.info(f'[Recommend] complete: {found}店')
    return _result(COMPLETE, None, source, found, shops, cards)
