# -*- coding: utf-8 -*-
"""
M4 F4: 推薦の分割（M3 承認済み。本番採用は未承認）
  推薦A: 店名リスト（rank・name・area_hint だけ、最大 10 件、stream）。推薦の観点・順位付けの指示は現行 BASE_INSTRUCTION と同じ
  推薦B: 推薦A の店舗（店名・順位は変更不可）の specialty・reason・category・highlights・tips（カード表示専用。stream）
  概要S: 各店の概要（1 文）。カード冒頭に表示し、Live はこれを読み上げる（推薦B と並行。stream）
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
    'あわせて、料理ジャンル（category、例: 焼き鳥）、おすすめポイント（highlights、短い語句で最大3つ）、'
    '来店のポイント（tips、1文）も作成してください。'
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
                       'specialty': {'type': 'string'}, 'reason': {'type': 'string'},
                       'category': {'type': 'string'}, 'highlights': {'type': 'array', 'items': {'type': 'string'}},
                       'tips': {'type': 'string'}},
        'required': ['rank', 'name', 'specialty', 'reason', 'category', 'highlights', 'tips'],
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
    """推薦B の 1 項目の検証（店名・順位の変更は拒否）。returns (rank, {'specialty','reason','category','highlights','tips'})"""
    r, name = _check_rank_name(obj, stores_by_rank, 'b')
    sp, rs = obj.get('specialty'), obj.get('reason')
    if not isinstance(sp, str) or not isinstance(rs, str) or not rs.strip():
        raise c.RecommendationError('b_invalid_item', f'rank {r}')
    hl = [h.strip() for h in (obj.get('highlights') or []) if isinstance(h, str) and h.strip()][:3]
    return r, {'specialty': sp.strip(), 'reason': rs.strip(), 'category': (obj.get('category') or '').strip(),
               'highlights': hl or ([sp.strip()] if sp.strip() else []), 'tips': (obj.get('tips') or '').strip()}


def _check_rank_name(obj, stores_by_rank, kind):
    if not isinstance(obj, dict):
        raise c.RecommendationError(f'{kind}_invalid_item', 'not_object')
    r = obj.get('rank')
    if r not in stores_by_rank:
        raise c.RecommendationError(f'{kind}_rank_mismatch', str(r))
    if (obj.get('name') or '').strip() != stores_by_rank[r]['name']:
        raise c.RecommendationError(f'{kind}_name_changed', f'rank {r}')
    return r, stores_by_rank[r]['name']


# ------------------------------------------------------------------ 概要（カード冒頭の 1 文。Live はこれを読み上げる）
SUMMARY_MAX_CHARS = 60
S_INSTRUCTION = (
    'あなたは日本および対象地域の飲食店に詳しいグルメコンシェルジュです。'
    '以下の【推薦店舗】は、ユーザーの依頼に合う店として推薦順に選定済みです。'
    '各店について、ユーザーの依頼に合う理由が一言で分かる概要（summary）を、話し言葉で読み上げやすい40字程度の1文で作成してください。'
    '学習済み知識に基づき、料金・受賞歴・営業状態などを根拠なく創作しないでください。'
    '店舗の追加・削除、店名や順位の変更はしないでください。各店舗について必ず1件ずつ、rankとnameは入力のまま返してください。'
)
S_SCHEMA = {
    'type': 'object',
    'properties': {'candidates': {'type': 'array', 'items': {
        'type': 'object',
        'properties': {'rank': {'type': 'integer'}, 'name': {'type': 'string'}, 'summary': {'type': 'string'}},
        'required': ['rank', 'name', 'summary'],
    }}},
    'required': ['candidates'],
}


def s_body(q: str, stores: list) -> dict:
    lst = [{'rank': s['rank'], 'name': s['name'], 'area_hint': s['area_hint']} for s in stores]
    return {
        'model': c.MODEL_ID,
        'input': f'{S_INSTRUCTION}\n\n【ユーザーの依頼】\n{q}\n\n【推薦店舗】\n' + json.dumps(lst, ensure_ascii=False),
        'response_format': {'type': 'text', 'mime_type': 'application/json', 'schema': S_SCHEMA},
        'generation_config': {'thinking_level': c.THINKING_LEVEL, 'max_output_tokens': 1024},
        'stream': True,
        'store': False,
    }


def check_s_item(obj, stores_by_rank: dict):
    r, _name = _check_rank_name(obj, stores_by_rank, 's')
    sm = obj.get('summary')
    if not isinstance(sm, str) or not sm.strip():
        raise c.RecommendationError('s_invalid_item', f'rank {r}')
    return r, sm.strip()[:SUMMARY_MAX_CHARS]
