# -*- coding: utf-8 -*-
"""
Places 候補選択 LLM（Gate D1.6）

- 推薦 LLM と同じ gemini-3.8-flash / thinking_level=low、REST Interactions API、非ストリーミング
- 1 検索につき 1 回だけ。最大 7 店舗 × 最大 5 候補をまとめて送り、店舗ごとに「同一と判断できる候補 1 件」か null を選ばせる
- 候補リスト外の店舗を作らせない。tools は指定しない（Google 検索なし）。推薦順位・推薦理由は変更しない
- 応答は 1 度だけ厳格に parse。件数・rank・候補 ID（その店舗の候補に含まれるか）・null と判定の整合を検証し、
  不正なら選択エラー（推測で補完しない）

注意: 実際の Places 応答をこの LLM に送ることは、Google Maps Platform 規約上の許容を確認できていない。
      本番経路は contracts.SELECTION_ENV_FLAG が on のときだけ有効（既定 OFF）。
"""
import json
import time

import requests

from . import contracts as c
from .llm_identity_verifier import IdentityError
from .recommender import _classify_http, count_search_calls, extract_text
from .redact import redact, register_secret

DEFAULT_TIMEOUT_SEC = 25.0

INSTRUCTION = (
    '推薦された各店舗について、Places検索候補から実際に同一店舗と判断できるものを1件選択する。'
    '店名の表記揺れ、正式名称と通称、屋号変更、支店名、所在地を総合的に考慮する。'
    '検索順位は同一性の保証ではない。別店舗・別支店を選んではならない。'
    '該当する店舗がなければselected_candidate_idをnullとする。候補リスト外の店舗を作成・推薦しない。'
    '各 rank について必ず 1 件ずつ結果を返す。selected_candidate_id はその rank の places_candidates の candidate_id のみ。'
    '候補を選んだ場合 judgment は SAME、null の場合 judgment は NOT_FOUND とする。'
)

SELECTION_SCHEMA = {
    'type': 'object',
    'properties': {
        'results': {'type': 'array', 'items': {
            'type': 'object',
            'properties': {
                'rank': {'type': 'integer'},
                'selected_candidate_id': {'type': ['integer', 'null']},
                'judgment': {'type': 'string', 'enum': ['SAME', 'NOT_FOUND']},
                'reason': {'type': 'string'},
            },
            'required': ['rank', 'selected_candidate_id', 'judgment', 'reason'],
        }},
    },
    'required': ['results'],
}


class SelectionError(IdentityError):
    """候補選択の失敗（error_type は selection_*）"""


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
        cands = r.get('places_candidates') or []
        if not 1 <= len(cands) <= c.SELECTION_MAX_CANDIDATES:
            raise SelectionError('selection_invalid_input', f'rank={r.get("rank")} の候補数が 1〜5 の範囲外')
        for cd in cands:
            if cd.get('candidate_id') in ids:
                raise SelectionError('selection_invalid_input', f'candidate_id 重複: {cd.get("candidate_id")}')
            ids.add(cd.get('candidate_id'))


def parse_results(text: str, recommendations: list) -> dict:
    """{rank: (candidate_id or None, reason)}"""
    if not text or not text.strip():
        raise SelectionError('selection_invalid_output', 'モデル出力テキストが空')
    try:
        obj = json.loads(text)
    except json.JSONDecodeError as e:
        raise SelectionError('selection_invalid_json', f'JSON解析不可: {e.msg} (pos {e.pos})')
    results = obj.get('results') if isinstance(obj, dict) else None
    if not isinstance(results, list):
        raise SelectionError('selection_invalid_output', 'results が配列ではない')
    allowed = {r['rank']: {cd['candidate_id'] for cd in r['places_candidates']} for r in recommendations}
    if len(results) != len(recommendations):
        raise SelectionError('selection_count_mismatch', f'結果 {len(results)} 件 / 入力 {len(recommendations)} 件')
    out = {}
    for res in results:
        if not isinstance(res, dict):
            raise SelectionError('selection_invalid_output', '結果がオブジェクトではない')
        rank, cid, j, reason = res.get('rank'), res.get('selected_candidate_id'), res.get('judgment'), res.get('reason')
        if not isinstance(rank, int) or isinstance(rank, bool) or rank not in allowed:
            raise SelectionError('selection_rank_mismatch', f'入力に無い rank: {rank!r}')
        if rank in out:
            raise SelectionError('selection_rank_duplicate', f'rank の重複: {rank}')
        if cid is not None and (not isinstance(cid, int) or isinstance(cid, bool) or cid not in allowed[rank]):
            raise SelectionError('selection_unknown_candidate', f'rank={rank} の候補に無い candidate_id: {cid!r}')
        if (cid is None) != (j == 'NOT_FOUND') or j not in ('SAME', 'NOT_FOUND'):
            raise SelectionError('selection_inconsistent', f'rank={rank}: candidate_id={cid!r} と judgment={j!r} が不整合')
        if not isinstance(reason, str):
            raise SelectionError('selection_invalid_output', f'rank={rank} の reason が文字列ではない')
        out[rank] = (cid, reason)
    return out


class LlmCandidateSelector:
    def __init__(self, api_key: str, http_post=None, timeout_sec: float = DEFAULT_TIMEOUT_SEC, now=time.monotonic):
        if not api_key:
            raise c.ConfigError('GEMINI_RECOMMEND_API_KEY が設定されていません')
        self._api_key = api_key
        register_secret(api_key)
        self._post = http_post or requests.post
        self.timeout_sec = timeout_sec
        self._now = now

    def select(self, recommendations: list):
        """returns ({rank: (candidate_id|None, reason)}, duration_ms, google_search_calls)。1 回の API 呼び出し"""
        validate_input(recommendations)
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
        return parse_results(extract_text(data), recommendations), duration_ms, count_search_calls(data)
