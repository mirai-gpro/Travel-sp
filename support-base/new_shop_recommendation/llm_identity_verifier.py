# -*- coding: utf-8 -*-
"""
同一性判定 LLM（Gate D1.5 PoC）

- 推薦 LLM と同じ gemini-3.8-flash / thinking_level=low、REST Interactions API、非ストリーミング
- 推薦とは別の 1 リクエストで、最大 7 組（推薦店 × 取得店）を一括判定する。1 件ずつは問い合わせない
- tools は指定しない（Google 検索なし）。新しい店舗の推薦はさせない
- 応答は 1 度だけ厳格に parse し、件数・ID・判定値・形式を検証。不正なら照合エラー（推測で補完しない）

注意: 実際の Places 応答（店名・住所）をこの LLM に送ることは、Google Maps Platform 規約上の許容を
確認できていない（contracts.IDENTITY_ENV_FLAG を参照）。PoC では独立に作成した模擬ペアで検証する。
"""
import json
import time

import requests

from . import contracts as c
from .recommender import _classify_http, count_search_calls, extract_text
from .redact import redact, register_secret

DEFAULT_TIMEOUT_SEC = 20.0

INSTRUCTION = (
    '飲食店の同一性判定を行う。与えられた推薦店舗と取得店舗について、店名、別表記、屋号、地域、支店名などから'
    '同一店舗かどうか判断する。単なる文字列一致ではなく、名称の省略・表記揺れを考慮する。'
    'ただし、同名異店や別支店を同一と決めつけない。不明な場合はUNCERTAINを返す。新たな店舗推薦は行わない。'
    '判定は SAME（同一店舗）・DIFFERENT（異なる店舗）・UNCERTAIN（同一と判断する根拠が不十分）のいずれか。'
    '入力の各 id について必ず 1 件ずつ、同じ id で結果を返すこと。'
)


class IdentityError(c.RecommendationError):
    """同一性判定の失敗（error_type は identity_*）"""


def build_input(pairs: list) -> str:
    return f'{INSTRUCTION}\n\n【判定対象】\n' + json.dumps({'pairs': pairs}, ensure_ascii=False)


def build_request_body(pairs: list) -> dict:
    # tools キーは意図的に含めない（Google 検索なし）。構造化出力の形式は recommender と同じ
    return {
        'model': c.MODEL_ID,
        'input': build_input(pairs),
        'response_format': {'type': 'text', 'mime_type': 'application/json', 'schema': c.IDENTITY_SCHEMA},
        'generation_config': {'thinking_level': c.THINKING_LEVEL, 'max_output_tokens': c.IDENTITY_MAX_OUTPUT_TOKENS},
        'stream': False,
        'store': False,
    }


def validate_pairs(pairs: list):
    if not isinstance(pairs, list) or not 1 <= len(pairs) <= c.IDENTITY_MAX_PAIRS:
        raise IdentityError('identity_invalid_input', f'判定対象は 1〜{c.IDENTITY_MAX_PAIRS} 組（{len(pairs) if isinstance(pairs, list) else "?"}）')
    ids = [p.get('id') for p in pairs]
    if len(set(ids)) != len(ids) or not all(isinstance(i, int) and not isinstance(i, bool) for i in ids):
        raise IdentityError('identity_invalid_input', 'id が整数でない、または重複')
    for p in pairs:
        for k in ('recommended_name', 'recommended_area', 'matched_name', 'matched_area'):
            if not isinstance(p.get(k), str):
                raise IdentityError('identity_invalid_input', f'id={p.get("id")} の {k} が文字列ではない')


def parse_results(text: str, pairs: list) -> dict:
    """{id: (judgment, reason)}。件数・ID の一致・重複・判定値・形式を検証"""
    if not text or not text.strip():
        raise IdentityError('identity_invalid_output', 'モデル出力テキストが空')
    try:
        obj = json.loads(text)
    except json.JSONDecodeError as e:
        raise IdentityError('identity_invalid_json', f'JSON解析不可: {e.msg} (pos {e.pos})')
    results = obj.get('results') if isinstance(obj, dict) else None
    if not isinstance(results, list):
        raise IdentityError('identity_invalid_output', 'results が配列ではない')
    expected = {p['id'] for p in pairs}
    if len(results) != len(pairs):
        raise IdentityError('identity_count_mismatch', f'結果 {len(results)} 件 / 入力 {len(pairs)} 組')
    out = {}
    for r in results:
        if not isinstance(r, dict):
            raise IdentityError('identity_invalid_output', '結果がオブジェクトではない')
        rid, j, reason = r.get('id'), r.get('judgment'), r.get('reason')
        if not isinstance(rid, int) or isinstance(rid, bool) or rid not in expected:
            raise IdentityError('identity_id_mismatch', f'入力に無い id: {rid!r}')
        if rid in out:
            raise IdentityError('identity_id_duplicate', f'id の重複: {rid}')
        if j not in c.IDENTITY_VALUES:
            raise IdentityError('identity_invalid_judgment', f'id={rid} の判定値が不正: {j!r}')
        if not isinstance(reason, str):
            raise IdentityError('identity_invalid_output', f'id={rid} の reason が文字列ではない')
        out[rid] = (j, reason)
    return out


class LlmIdentityVerifier:
    def __init__(self, api_key: str, http_post=None, timeout_sec: float = DEFAULT_TIMEOUT_SEC, now=time.monotonic):
        if not api_key:
            raise c.ConfigError('GEMINI_RECOMMEND_API_KEY が設定されていません')
        self._api_key = api_key
        register_secret(api_key)
        self._post = http_post or requests.post
        self.timeout_sec = timeout_sec
        self._now = now

    def verify(self, pairs: list):
        """returns (results {id: (judgment, reason)}, duration_ms, google_search_calls)。1 回の API 呼び出し"""
        validate_pairs(pairs)
        headers = {'Content-Type': 'application/json', 'x-goog-api-key': self._api_key,
                   'Api-Revision': c.INTERACTIONS_API_REVISION}
        t0 = self._now()
        try:
            r = self._post(c.INTERACTIONS_URL, json=build_request_body(pairs), headers=headers, timeout=self.timeout_sec)
        except requests.exceptions.Timeout:
            raise IdentityError('identity_timeout', 'timeout')
        except requests.exceptions.RequestException as e:
            raise IdentityError('identity_network_error', redact(f'{type(e).__name__}: {str(e)[:200]}'))
        duration_ms = int((self._now() - t0) * 1000)
        if r.status_code != 200:
            raise IdentityError('identity_' + _classify_http(r.status_code),
                                redact(f'HTTP {r.status_code}: {r.text[:300]}'), r.status_code)
        try:
            data = r.json()
        except ValueError:
            raise IdentityError('identity_invalid_response', 'HTTP 200 だが応答が JSON ではない', 200)
        if data.get('status') != 'completed':
            raise IdentityError('identity_not_completed', f'status={data.get("status")}', 200)
        results = parse_results(extract_text(data), pairs)
        return results, duration_ms, count_search_calls(data)
