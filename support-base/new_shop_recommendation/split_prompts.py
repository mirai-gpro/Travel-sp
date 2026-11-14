# -*- coding: utf-8 -*-
"""
M4 F4: 推薦の分割（M3 承認済み。本番採用は未承認）
  推薦A: 店名リスト（rank・name・area_hint だけ、最大 10 件、stream）。推薦の観点・順位付けの指示は現行 BASE_INSTRUCTION と同じ
  推薦B: 推薦A の店舗（店名・順位は変更不可）の specialty・reason（カード表示専用。Live には渡さない。stream）
M3（poc/m3_core.py）と同じ文言。推薦B は逐次反映のため、ルートの配列名を candidates にした点だけが異なる。
"""
import json

from . import contracts as c
from . import recommender

A_COUNT = 10
A_MAX_OUTPUT_TOKENS = 1024
B_MAX_OUTPUT_TOKENS = 4096


def a_instruction(n: int = A_COUNT) -> str:
    base = recommender.BASE_INSTRUCTION
    repl = [
        ('学習済み知識に基づき最大7候補、推薦順に選定してください。', f'学習済み知識に基づき最大{n}候補、推薦順に選定してください。'),
        ('最初の5店を表示候補、残り2店を実在確認に失敗した際の予備候補とします。',
         f'最初の5店を表示候補、残り{n - 5}店を実在確認に失敗した際の予備候補とします。'),
        ('各店の名称、駅・地区、得意料理や特徴、他店との違いが分かる具体的な推薦理由を返してください。',
         '各店の名称と駅・地区だけを返してください（得意料理や推薦理由は別の工程で作成します）。'),
        ('店舗の存在が不確かな場合に、7件へ無理に水増ししないでください。', f'店舗の存在が不確かな場合に、{n}件へ無理に水増ししないでください。'),
    ]
    for old, new in repl:
        if old not in base:
            raise RuntimeError(f'BASE_INSTRUCTION に想定の文言がありません: {old}')
        base = base.replace(old, new)
    return base


A_SCHEMA = {
    'type': 'object',
    'properties': {
        'freshness_intent': {'type': 'string', 'enum': list(c.FRESHNESS_VALUES)},
        'candidates': {'type': 'array', 'items': {
            'type': 'object',
            'properties': {'rank': {'type': 'integer'}, 'name': {'type': 'string'}, 'area_hint': {'type': 'string'}},
            'required': ['rank', 'name', 'area_hint'],
        }},
    },
    'required': ['freshness_intent', 'candidates'],
}


def a_body(q: str, n: int = A_COUNT) -> dict:
    return {
        'model': c.MODEL_ID,
        'input': f'{a_instruction(n)}\n\n【ユーザーの依頼】\n{q}',
        'response_format': {'type': 'text', 'mime_type': 'application/json', 'schema': A_SCHEMA},
        'generation_config': {'thinking_level': c.THINKING_LEVEL, 'max_output_tokens': A_MAX_OUTPUT_TOKENS},
        'stream': True,
        'store': False,
    }


B_INSTRUCTION = (
    'あなたは日本および対象地域の飲食店に詳しいグルメコンシェルジュです。'
    '以下の【推薦店舗】は、ユーザーの依頼に合う店として推薦順に選定済みです。'
    '各店について、得意料理や特徴（specialty）と、他店との違いが分かる具体的な推薦理由（reason）を、学習済み知識に基づき作成してください。'
    '味・調理技術・素材・専門性・評判・その人の条件への適合性を重視してください。'
    '店舗の追加・削除、店名や順位の変更はしないでください。'
    '料金・受賞歴・営業状態などを根拠なく創作しないでください。'
    '各店舗について必ず1件ずつ、rankとnameは入力のまま返してください。'
)
B_SCHEMA = {
    'type': 'object',
    'properties': {'candidates': {'type': 'array', 'items': {
        'type': 'object',
        'properties': {'rank': {'type': 'integer'}, 'name': {'type': 'string'},
                       'specialty': {'type': 'string'}, 'reason': {'type': 'string'}},
        'required': ['rank', 'name', 'specialty', 'reason'],
    }}},
    'required': ['candidates'],
}


def b_body(q: str, stores: list) -> dict:
    lst = [{'rank': s['rank'], 'name': s['name'], 'area_hint': s['area_hint']} for s in stores]
    return {
        'model': c.MODEL_ID,
        'input': f'{B_INSTRUCTION}\n\n【ユーザーの依頼】\n{q}\n\n【推薦店舗】\n' + json.dumps(lst, ensure_ascii=False),
        'response_format': {'type': 'text', 'mime_type': 'application/json', 'schema': B_SCHEMA},
        'generation_config': {'thinking_level': c.THINKING_LEVEL, 'max_output_tokens': B_MAX_OUTPUT_TOKENS},
        'stream': True,
        'store': False,
    }


def check_b_item(obj, stores_by_rank: dict):
    """推薦B の 1 項目の検証（店名・順位の変更は拒否）。returns (rank, specialty, reason) or raises RecommendationError"""
    if not isinstance(obj, dict):
        raise c.RecommendationError('b_invalid_item', 'not_object')
    r = obj.get('rank')
    if r not in stores_by_rank:
        raise c.RecommendationError('b_rank_mismatch', str(r))
    if (obj.get('name') or '').strip() != stores_by_rank[r]['name']:
        raise c.RecommendationError('b_name_changed', f'rank {r}')
    sp, rs = obj.get('specialty'), obj.get('reason')
    if not isinstance(sp, str) or not isinstance(rs, str) or not rs.strip():
        raise c.RecommendationError('b_invalid_item', f'rank {r}')
    return r, sp.strip(), rs.strip()
