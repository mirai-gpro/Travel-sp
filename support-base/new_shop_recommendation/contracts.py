# -*- coding: utf-8 -*-
"""
新ショップ推薦エンジンの入出力契約・状態・定数。

上位仕様: 「Travel-sp 新ショップ推薦エンジン — Claude Code詳細実装指示書（確定版）」2026-11-13
- 推薦 LLM: gemini-3.8-flash / thinking_level=low / REST Interactions API / 非ストリーミング一括
- Google 検索・外部ツールは使わない（リクエストに tools キーを含めない）
- Places API (New) は実在・同一店舗・営業状態・カード情報の確認にだけ使う
"""
from dataclasses import dataclass, field
from typing import List, Optional

# ---------------------------------------------------------------- 確定設定（自動切替しない）
MODEL_ID = 'gemini-3.8-flash'
THINKING_LEVEL = 'low'
MAX_OUTPUT_TOKENS = 3072
CANDIDATE_LIMIT = 7          # 推薦 5 + 予備 2
DISPLAY_COUNT = 5
INTERACTIONS_URL = 'https://generativelanguage.googleapis.com/v1beta/interactions'
INTERACTIONS_API_REVISION = '2026-05-20'   # steps 形式の応答スキーマに固定（公式 May 2026 移行ガイド）

PLACES_SEARCH_TEXT_URL = 'https://places.googleapis.com/v1/places:searchText'
# '*' は使わない。いずれも Text Search Pro SKU の項目
PLACES_FIELD_MASK = ('places.id,places.displayName,places.formattedAddress,places.location,'
                     'places.primaryType,places.types,places.businessStatus,places.googleMapsUri,'
                     'places.photos')
PLACES_PAGE_SIZE = 5
PLACES_MAX_PARALLEL = 7

# 推薦 LLM の生成スキーマ（指示書 4.1 と同一）
RECOMMENDATION_SCHEMA = {
    'type': 'object',
    'properties': {
        'freshness_intent': {'type': 'string', 'enum': ['not_needed', 'useful', 'essential']},
        'candidates': {'type': 'array', 'items': {
            'type': 'object',
            'properties': {
                'rank': {'type': 'integer'},
                'name': {'type': 'string'},
                'area_hint': {'type': 'string'},
                'specialty': {'type': 'string'},
                'reason': {'type': 'string'},
            },
            'required': ['rank', 'name', 'area_hint', 'specialty', 'reason'],
        }},
    },
    'required': ['freshness_intent', 'candidates'],
}
FRESHNESS_VALUES = ('not_needed', 'useful', 'essential')

# ---------------------------------------------------------------- 状態
COMPLETE = 'COMPLETE'        # 5 件
PARTIAL = 'PARTIAL'          # 1〜4 件
EMPTY = 'EMPTY'              # 0 件
ERROR = 'ERROR'
TIMED_OUT = 'TIMED_OUT'

VERIFIED = 'VERIFIED'
AMBIGUOUS = 'AMBIGUOUS'
NOT_VERIFIED = 'NOT_VERIFIED'
CLOSED = 'CLOSED'
API_ERROR = 'API_ERROR'


class ConfigError(Exception):
    """必要な設定（API キー等）が無い。旧キー等で黙って代替しない"""


class RecommendationError(Exception):
    """推薦 LLM 呼び出しの失敗。error_type で原因を分類する（秘密情報は含めない）"""

    def __init__(self, error_type: str, detail: str = '', http_status: Optional[int] = None):
        super().__init__(f'{error_type}: {detail}')
        self.error_type = error_type
        self.detail = detail
        self.http_status = http_status


@dataclass
class Candidate:
    rank: int
    name: str
    area_hint: str
    specialty: str
    reason: str


@dataclass
class LlmOutput:
    freshness_intent: str
    candidates: List[Candidate]
    duration_ms: int
    google_search_calls: int
    interaction_status: str
    usage: dict = field(default_factory=dict)


@dataclass
class Verification:
    candidate: Candidate
    status: str                      # VERIFIED / AMBIGUOUS / NOT_VERIFIED / CLOSED / API_ERROR
    reason: str                      # 判定理由（機械可読な短いコード）
    place: Optional[dict] = None     # VERIFIED のときだけ（カード用。LLM・Live には渡さない）
    evidence: List[dict] = field(default_factory=list)   # Places 各結果の判定根拠（place_id と判定のみ）
    duration_ms: int = 0
