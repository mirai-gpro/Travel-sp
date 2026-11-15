# -*- coding: utf-8 -*-
"""
Gate D1.7（方式 D）: Maps Experience Agent Tools の結果で選択 LLM をグラウンディングし、店舗ごとに候補 1 件か null を選ぶ

- 推薦 LLM と同じ gemini-3.8-flash / thinking_level=low、REST Interactions API、非ストリーミング、store=false、tools なし
- 1 検索につき 1 回。最大 7 店舗 × 最大 5 候補
- 各店舗に渡すのは Agent Tools の summary（[i] 引用つき）と、候補 ID ⇔ 引用番号 の対応のみ。
  places[] には店名・住所が無いので、プログラム側で summary から店名を抜き出したりしない（規約 §10.3.1）
- 出力の検証は Gate D1.6 と同じ（parse_results: 件数・rank・その店舗の候補 ID・null と判定の整合）
- 推薦順位・推薦理由は変更しない。選択理由（Grounded Output）はユーザーに表示しない
"""
import json
import time

import requests

from . import contracts as c
from .llm_candidate_selector import SELECTION_SCHEMA, SelectionError, parse_results
from .recommender import _classify_http, count_search_calls, extract_text
from .redact import redact, register_secret

DEFAULT_TIMEOUT_SEC = 25.0

INSTRUCTION = (
    '推薦された各店舗について、Googleマップ検索結果から実際に同一店舗と判断できるものを1件選択する。'
    'maps_summary は Google マップの検索結果の要約で、[i] は citation が i の候補を指す。'
    '要約に書かれた店名・所在地をもとに、店名の表記揺れ、正式名称と通称、屋号変更、支店名、所在地を総合的に考慮する。'
    '検索順位は同一性の保証ではない。別店舗・別支店を選んではならない。'
    '要約に記述がない候補や、同一と判断できない場合は selected_candidate_id を null とする。候補リスト外の店舗を作成・推薦しない。'
    '各 rank について必ず 1 件ずつ結果を返す。selected_candidate_id はその rank の maps_places の candidate_id のみ。'
    '候補を選んだ場合 judgment は SAME、null の場合 judgment は NOT_FOUND とする。'
)


def build_request_body(recommendations: list) -> dict:
    return {
        'model': c.MODEL_ID,
        'input': f'{INSTRUCTION}\n\n【判定対象】\n' + json.dumps({'recommendations': recommendations}, ensure_ascii=False),
        'response_format': {'type': 'text', 'mime_type': 'application/json', 'schema': SELECTION_SCHEMA},
        'generation_config': {'thinking_level': c.THINKING_LEVEL, 'max_output_tokens': c.SELECTION_MAX_OUTPUT_TOKENS},
        'stream': False,
        'store': False,
    }


def validate_input(recommendations: list):
    if not isinstance(recommendations, list) or not 1 <= len(recommendations) <= c.CANDIDATE_LIMIT:
        raise SelectionError('selection_invalid_input', '推薦店舗は 1〜7 件')
    ranks, ids = set(), set()
    for r in recommendations:
        if r.get('rank') in ranks:
            raise SelectionError('selection_invalid_input', f'rank 重複: {r.get("rank")}')
        ranks.add(r.get('rank'))
        cands = r.get('maps_places') or []
        if not 1 <= len(cands) <= c.SELECTION_MAX_CANDIDATES:
            raise SelectionError('selection_invalid_input', f'rank={r.get("rank")} の候補数が 1〜5 の範囲外')
        for cd in cands:
            if cd.get('candidate_id') in ids:
                raise SelectionError('selection_invalid_input', f'candidate_id 重複: {cd.get("candidate_id")}')
            ids.add(cd.get('candidate_id'))


class LlmGroundedSelector:
    def __init__(self, api_key: str, http_post=None, timeout_sec: float = DEFAULT_TIMEOUT_SEC, now=time.monotonic):
        if not api_key:
            raise c.ConfigError('GEMINI_RECOMMEND_API_KEY が設定されていません')
        self._api_key = api_key
        register_secret(api_key)
        self._post = http_post or requests.post
        self.timeout_sec = timeout_sec
        self._now = now
        self.last_usage = {}

    def select(self, recommendations: list):
        """recommendations: [{rank, recommended_name, recommended_area, maps_summary, maps_places:[{candidate_id, citation}]}]
        returns ({rank: (candidate_id|None, reason)}, duration_ms, google_search_calls)"""
        validate_input(recommendations)
        as_d16 = [{'rank': r['rank'], 'places_candidates': r['maps_places']} for r in recommendations]
        headers = {'Content-Type': 'application/json', 'x-goog-api-key': self._api_key,
                   'Api-Revision': c.INTERACTIONS_API_REVISION}
        t0 = self._now()
        try:
            r = self._post(c.INTERACTIONS_URL, json=build_request_body(recommendations), headers=headers,
                           timeout=self.timeout_sec)
        except requests.exceptions.Timeout:
            raise SelectionError('selection_timeout', 'timeout')
        except requests.exceptions.RequestException as e:
            raise SelectionError('selection_network_error', redact(f'{type(e).__name__}: {str(e)[:200]}'))
        duration_ms = int((self._now() - t0) * 1000)
        if r.status_code != 200:
            raise SelectionError('selection_' + _classify_http(r.status_code),
                                 redact(f'HTTP {r.status_code}: {r.text[:300]}'), r.status_code)
        try:
            data = r.json()
        except ValueError:
            raise SelectionError('selection_invalid_response', 'HTTP 200 だが応答が JSON ではない', 200)
        if data.get('status') != 'completed':
            raise SelectionError('selection_not_completed', f'status={data.get("status")}', 200)
        self.last_usage = data.get('usage') or {}
        return parse_results(extract_text(data), as_d16), duration_ms, count_search_calls(data)
