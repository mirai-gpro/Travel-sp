# -*- coding: utf-8 -*-
"""
新ショップ推薦オーケストレーター（1 検索リクエスト単位）

  推薦 LLM 一括（1 回）→ 全候補を Places (New) で並列照合 → LLM 順位のまま VERIFIED を上から最大 5 件
  → 同じ選定結果からカード（UI 用）と読み上げデータ（Live 用）を作る

禁止事項（実装していないこと）: 再ランキング、評価値による並べ替え、Google 検索や別 LLM による補充、
未検証店舗の表示、旧推薦方式へのフォールバック。
"""
import json
import logging
import os
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, wait

from . import contracts as c
from .place_verifier import verify_candidate
from .redact import redact

logger = logging.getLogger(__name__)

PLACES_BATCH_MARGIN_SEC = 2.0


def build_card(v: c.Verification, display_rank: int, request_id: str) -> dict:
    """既存 ShopCardList が読む項目に変換。店名・住所・地図リンク等は Places 由来（UI 専用）"""
    p = v.place or {}
    loc = p.get('location') or {}
    return {
        'name': ((p.get('displayName') or {}).get('text')) or v.candidate.name,
        'llm_name': v.candidate.name,
        'category': '',
        'description': v.candidate.reason,
        'highlights': [v.candidate.specialty] if v.candidate.specialty else [],
        'area': v.candidate.area_hint,
        'location': p.get('formattedAddress') or '',
        'latitude': loc.get('latitude'),
        'longitude': loc.get('longitude'),
        'maps_url': p.get('googleMapsUri') or '',
        'place_id': p.get('id'),
        'recommend_rank': v.candidate.rank,
        'display_rank': display_rank,
        'verification': c.VERIFIED,
        'request_id': request_id,
    }


def build_narration_item(v: c.Verification) -> dict:
    """Live 読み上げ用。LLM 由来の店名・地区・特徴・推薦理由のみ（Maps 由来の情報は含めない）"""
    return {'name': v.candidate.name, 'area': v.candidate.area_hint, 'category': v.candidate.specialty,
            'description': v.candidate.reason, 'price_range': ''}


def _credential_kind(key: str) -> str:
    if not key:
        return 'none'
    return 'AQ' if key.startswith('AQ') else 'other'


class ShopRecommendationOrchestrator:
    def __init__(self, recommender, places_client, credential_kind: str = 'unknown',
                 max_parallel: int = c.PLACES_MAX_PARALLEL, now=time.monotonic, wall=time.time):
        self.recommender = recommender
        self.places = places_client
        self.credential_kind = credential_kind
        self.max_parallel = max(1, min(int(max_parallel), c.PLACES_MAX_PARALLEL))
        self._now = now
        self._wall = wall

    def run(self, user_request: str, language_code: str = 'ja', region_code: str = 'JP',
            request_id: str = None) -> dict:
        request_id = request_id or uuid.uuid4().hex
        m = {'request_id': request_id, 'git_sha': os.environ.get('GIT_SHA', 'unknown'), 'model_id': c.MODEL_ID,
             'thinking_level': c.THINKING_LEVEL, 'credential_kind': self.credential_kind,
             'llm_started': None, 'llm_finished': None, 'llm_duration_ms': None, 'llm_candidate_count': 0,
             'google_search_calls': None, 'freshness_intent': None, 'places_started': None,
             'places_finished': None, 'places_duration_ms': None, 'verified_count': 0,
             'rejected_counts_by_reason': {}, 'final_status': None, 'error_type': None}
        t0 = self._now()

        # ---- 1. 推薦 LLM（1 回・非ストリーミング）
        m['llm_started'] = self._wall()
        try:
            llm = self.recommender.recommend(user_request)
        except c.RecommendationError as e:
            m['llm_finished'] = self._wall()
            m['final_status'] = c.TIMED_OUT if e.error_type == 'timeout' else c.ERROR
            m['error_type'] = e.error_type
            return self._finish(m, t0, [], [], [], error_detail=redact(e.detail))
        m['llm_finished'] = self._wall()
        m['llm_duration_ms'] = llm.duration_ms
        m['llm_candidate_count'] = len(llm.candidates)
        m['google_search_calls'] = llm.google_search_calls
        m['freshness_intent'] = llm.freshness_intent

        # ---- 2. Places (New) 全候補を同時に照合（LLM の JSON 完成後に開始）
        m['places_started'] = self._wall()
        tp = self._now()
        verifications = [None] * len(llm.candidates)
        pool = ThreadPoolExecutor(max_workers=min(self.max_parallel, len(llm.candidates)),
                                  thread_name_prefix='places-new')
        try:
            futs = {pool.submit(verify_candidate, self.places, cand, language_code, region_code): i
                    for i, cand in enumerate(llm.candidates)}
            done, not_done = wait(futs, timeout=self.places.timeout_sec + PLACES_BATCH_MARGIN_SEC)
            for f in done:
                verifications[futs[f]] = f.result()
            for f in not_done:
                i = futs[f]
                verifications[i] = c.Verification(llm.candidates[i], c.API_ERROR, 'places_batch_timeout')
        finally:
            pool.shutdown(wait=False, cancel_futures=True)
        m['places_finished'] = self._wall()
        m['places_duration_ms'] = int((self._now() - tp) * 1000)

        # ---- 3. LLM 順位のまま VERIFIED を上から採用（place_id 重複は後の方を除外）
        selected = []
        seen = set()
        rejected = {}
        for v in verifications:              # verifications は LLM の rank 順
            if v.status == c.VERIFIED:
                pid = (v.place or {}).get('id')
                if pid in seen:
                    v.status, v.reason = c.NOT_VERIFIED, 'duplicate_place_id'
                elif len(selected) < c.DISPLAY_COUNT:
                    seen.add(pid)
                    selected.append(v)
                    continue
                else:
                    continue                 # 予備で VERIFIED だが 5 件確定後のため不使用（棄却ではない）
            key = f'{v.status}:{v.reason}' if v.status != c.API_ERROR else f'{c.API_ERROR}'
            rejected[key] = rejected.get(key, 0) + 1
        m['verified_count'] = len(selected)
        m['rejected_counts_by_reason'] = rejected
        n = len(selected)
        m['final_status'] = c.COMPLETE if n >= c.DISPLAY_COUNT else (c.PARTIAL if n > 0 else c.EMPTY)

        cards = [build_card(v, i + 1, request_id) for i, v in enumerate(selected)]
        narration = [build_narration_item(v) for v in selected]
        return self._finish(m, t0, cards, narration, verifications)

    def _finish(self, m, t0, cards, narration, verifications, error_detail=None):
        m['total_duration_ms'] = int((self._now() - t0) * 1000)
        logger.info('[NewShopRec] ' + redact(json.dumps(m, ensure_ascii=False)))
        return {
            'request_id': m['request_id'],
            'status': m['final_status'],
            'error_type': m['error_type'],
            'error_detail': error_detail,
            'cards': cards,
            'narration': narration,
            'verifications': [
                {'rank': v.candidate.rank, 'name': v.candidate.name, 'area_hint': v.candidate.area_hint,
                 'status': v.status, 'reason': v.reason, 'place_id': (v.place or {}).get('id'),
                 'places_ms': v.duration_ms, 'evidence': v.evidence}
                for v in verifications if v is not None],
            'metrics': m,
        }


def build_from_env():
    """Cloud Run 環境変数から構築。GEMINI_RECOMMEND_API_KEY が無ければ ConfigError（既存 GEMINI_API_KEY で代替しない）"""
    from .place_verifier import PlacesNewClient
    from .recommender import RecommendationClient
    gkey = os.environ.get('GEMINI_RECOMMEND_API_KEY', '')
    pkey = os.environ.get('GOOGLE_PLACES_API_KEY', '')
    return ShopRecommendationOrchestrator(RecommendationClient(gkey), PlacesNewClient(pkey),
                                          credential_kind=_credential_kind(gkey))
