# -*- coding: utf-8 -*-
"""
推薦 LLM クライアント（REST Interactions API・非ストリーミング・1 リクエスト 1 回）

- gemini-3.8-flash / generation_config.thinking_level=low / max_output_tokens=3072
- response_format で JSON Schema を指定。tools キーは付けない（Google 検索なし）
- 応答は 1 度だけ厳格に JSON parse し、検証に失敗したらエラーとして返す
  （正規表現での補完・別 LLM での再生成・別モデルへの切替はしない）
- SDK（google-genai 1.68.0）は Live と共用のため使わず、requests で直接呼ぶ
"""
import json
import time

import requests

from . import contracts as c
from .redact import redact, register_secret

BASE_INSTRUCTION = (
    'あなたは日本および対象地域の飲食店に詳しいグルメコンシェルジュです。'
    'ユーザーの依頼に合う飲食店を、学習済み知識に基づき最大7候補、推薦順に選定してください。'
    '最初の5店を表示候補、残り2店を実在確認に失敗した際の予備候補とします。'
    '味・調理技術・素材・専門性・評判・その人の条件への適合性を重視し、知名度順の単純羅列は避けてください。'
    '各店の名称、駅・地区、得意料理や特徴、他店との違いが分かる具体的な推薦理由を返してください。'
    '店舗の存在が不確かな場合に、7件へ無理に水増ししないでください。'
    '料金・受賞歴・営業状態などを根拠なく創作しないでください。'
    '実在・同一店・住所・営業状況は後段のPlacesが確認します。'
    'rankは1からの連番です。同一店舗の重複は避けてください。'
    '最新情報を補完すると品質が上がるかの判断はfreshness_intentに出力しますが、'
    '今回はGoogle検索や外部ツールを利用せず、学習済み知識のみで選びます。'
)

DEFAULT_TIMEOUT_SEC = 30.0


def build_input(user_request: str) -> str:
    """固定指示 + Live の user_request（ユーザー条件は削らずそのまま渡す）"""
    return f'{BASE_INSTRUCTION}\n\n【ユーザーの依頼】\n{user_request}'


def build_request_body(user_request: str) -> dict:
    # tools キーは意図的に含めない（Google 検索・外部ツールなし）
    return {
        'model': c.MODEL_ID,
        'input': build_input(user_request),
        'response_format': {'type': 'text', 'mime_type': 'application/json', 'schema': c.RECOMMENDATION_SCHEMA},
        'generation_config': {'thinking_level': c.THINKING_LEVEL, 'max_output_tokens': c.MAX_OUTPUT_TOKENS},
        'stream': False,
        'store': False,
    }


def _classify_http(status: int) -> str:
    if status == 429:
        return 'rate_limited'
    if status == 503:
        return 'unavailable'
    if status == 504:
        return 'deadline_exceeded'
    if 500 <= status < 600:
        return 'upstream_error'
    if status in (401, 403):
        return 'auth_error'
    return 'client_error'


def extract_text(data: dict) -> str:
    """output_text があればそれ、無ければ steps[].type=model_output の content[].type=text を連結"""
    ot = data.get('output_text')
    if isinstance(ot, str) and ot.strip():
        return ot
    parts = []
    for step in data.get('steps') or []:
        if isinstance(step, dict) and step.get('type') == 'model_output':
            for item in step.get('content') or []:
                if isinstance(item, dict) and item.get('type') == 'text' and isinstance(item.get('text'), str):
                    parts.append(item['text'])
    return ''.join(parts)


def count_search_calls(data: dict) -> int:
    """steps 内の google_search_call の数（tools を渡していないので 0 のはず。記録・検査用）"""
    n = 0

    def walk(o):
        nonlocal n
        if isinstance(o, dict):
            if o.get('type') == 'google_search_call':
                n += 1
            for v in o.values():
                walk(v)
        elif isinstance(o, list):
            for v in o:
                walk(v)
    walk(data.get('steps') or [])
    return n


def parse_and_validate(text: str):
    """1 度だけ厳格に parse して検証する。問題があれば RecommendationError(invalid_output_*)"""
    if not text or not text.strip():
        raise c.RecommendationError('invalid_output_empty', 'モデル出力テキストが空')
    try:
        obj = json.loads(text)
    except json.JSONDecodeError as e:
        raise c.RecommendationError('invalid_output_json', f'JSON解析不可: {e.msg} (pos {e.pos})')
    if not isinstance(obj, dict):
        raise c.RecommendationError('invalid_output_schema', 'トップレベルがオブジェクトではない')
    fi = obj.get('freshness_intent')
    if fi not in c.FRESHNESS_VALUES:
        raise c.RecommendationError('invalid_output_schema', f'freshness_intent が不正: {fi!r}')
    cands = obj.get('candidates')
    if not isinstance(cands, list):
        raise c.RecommendationError('invalid_output_schema', 'candidates が配列ではない')
    if not 1 <= len(cands) <= c.CANDIDATE_LIMIT:
        raise c.RecommendationError('invalid_output_count', f'候補数が 1〜{c.CANDIDATE_LIMIT} の範囲外: {len(cands)}')
    out = []
    seen = set()
    for i, item in enumerate(cands, start=1):
        if not isinstance(item, dict):
            raise c.RecommendationError('invalid_output_schema', f'{i} 件目がオブジェクトではない')
        for k in ('name', 'area_hint', 'specialty', 'reason'):
            if not isinstance(item.get(k), str):
                raise c.RecommendationError('invalid_output_schema', f'{i} 件目の {k} が文字列ではない')
        rank = item.get('rank')
        if not isinstance(rank, int) or isinstance(rank, bool):
            raise c.RecommendationError('invalid_output_schema', f'{i} 件目の rank が整数ではない')
        if rank != i:
            raise c.RecommendationError('invalid_output_rank', f'rank が 1 からの連番ではない（{i} 件目が {rank}）')
        name = item['name'].strip()
        if not name:
            raise c.RecommendationError('invalid_output_empty_name', f'{i} 件目の店名が空')
        key = ''.join(name.split())
        if key in seen:
            raise c.RecommendationError('invalid_output_duplicate', f'店名の重複: {name}')
        seen.add(key)
        out.append(c.Candidate(rank=rank, name=name, area_hint=item['area_hint'].strip(),
                               specialty=item['specialty'].strip(), reason=item['reason'].strip()))
    return fi, out


class RecommendationClient:
    def __init__(self, api_key: str, http_post=None, timeout_sec: float = DEFAULT_TIMEOUT_SEC,
                 now=time.monotonic):
        if not api_key:
            raise c.ConfigError('GEMINI_RECOMMEND_API_KEY が設定されていません')
        self._api_key = api_key
        register_secret(api_key)
        self._post = http_post or requests.post
        self.timeout_sec = timeout_sec
        self._now = now

    def recommend(self, user_request: str) -> c.LlmOutput:
        body = build_request_body(user_request)
        headers = {'Content-Type': 'application/json', 'x-goog-api-key': self._api_key,
                   'Api-Revision': c.INTERACTIONS_API_REVISION}
        t0 = self._now()
        try:
            r = self._post(c.INTERACTIONS_URL, json=body, headers=headers, timeout=self.timeout_sec)
        except requests.exceptions.Timeout as e:
            raise c.RecommendationError('timeout', redact(f'{type(e).__name__}'))
        except requests.exceptions.RequestException as e:
            raise c.RecommendationError('network_error', redact(f'{type(e).__name__}: {str(e)[:200]}'))
        duration_ms = int((self._now() - t0) * 1000)
        if r.status_code != 200:
            raise c.RecommendationError(_classify_http(r.status_code),
                                        redact(f'HTTP {r.status_code}: {r.text[:300]}'), r.status_code)
        try:
            data = r.json()
        except ValueError:
            raise c.RecommendationError('invalid_response', 'HTTP 200 だが応答が JSON ではない', 200)
        status = data.get('status')
        if status != 'completed':
            raise c.RecommendationError('interaction_not_completed', f'status={status}', 200)
        searches = count_search_calls(data)
        freshness, cands = parse_and_validate(extract_text(data))
        return c.LlmOutput(freshness_intent=freshness, candidates=cands, duration_ms=duration_ms,
                           google_search_calls=searches, interaction_status=status,
                           usage=data.get('usage') or {})
