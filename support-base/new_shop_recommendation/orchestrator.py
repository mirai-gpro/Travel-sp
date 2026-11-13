# -*- coding: utf-8 -*-
"""
新ショップ推薦オーケストレーター（1 検索リクエスト単位）

  推薦 LLM 一括（1 回）→ 33秒版本番と同じ Places 照合（legacy_places: extract_area_from_text →
  get_region_from_area → 候補ごとに search_place。候補ごとの呼び出しは並列）→ LLM 順位のまま採用を上から最大 5 件
  → 同じ選定結果からカード（UI 用）と読み上げデータ（Live 用）を作る
  ※ VERIFIED は「33秒版の search_place が店舗を返した」ことを意味する

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
from . import legacy_places
from .redact import redact

logger = logging.getLogger(__name__)

# search_place は内部で Text Search + Place Details（各 timeout=10 秒）を順に呼ぶ
PLACES_BATCH_TIMEOUT_SEC = 25.0


def select_display(verifications, accept=None):
    """
    33秒版 enrich_shops_with_photos と同じ採用規則（LLM 順、見つからない店は除外、place_id 重複は後の方を除外）で
    最大 DISPLAY_COUNT 件を選ぶ。accept を渡すと、その条件を満たす候補だけを対象にする（同一性判定 SAME のみ等）。
    verifications は変更しない。returns (selected, rejected_counts)
    """
    selected, seen, rejected = [], set(), {}
    for v in verifications:
        if v.status == c.VERIFIED:
            if accept is not None and not accept(v):
                key = 'IDENTITY:not_same'
            else:
                pid = (v.place or {}).get('place_id')
                if pid in seen:
                    key = 'NOT_VERIFIED:duplicate_place_id'
                elif len(selected) < c.DISPLAY_COUNT:
                    seen.add(pid)
                    selected.append(v)
                    continue
                else:
                    continue                 # 5 件確定後の予備（棄却ではない）
        else:
            key = f'{v.status}:{v.reason}' if v.status != c.API_ERROR else f'{c.API_ERROR}'
        rejected[key] = rejected.get(key, 0) + 1
    return selected, rejected


def build_card(v: c.Verification, display_rank: int, request_id: str) -> dict:
    """LLM 由来の項目に、33秒版と同じ規則で Places の情報を反映（店名は Places 名で上書き）"""
    card = {
        'name': v.candidate.name,
        'llm_name': v.candidate.name,
        'category': '',
        'description': v.candidate.reason,
        'highlights': [v.candidate.specialty] if v.candidate.specialty else [],
        'area': v.candidate.area_hint,
        'recommend_rank': v.candidate.rank,
        'display_rank': display_rank,
        'verification': c.VERIFIED,
        'request_id': request_id,
    }
    return legacy_places.reflect_place_data(card, v.place or {})


def build_narration_item(v: c.Verification) -> dict:
    """Live 読み上げ用。LLM 由来の店名・地区・特徴・推薦理由のみ（Maps 由来の情報は含めない）"""
    return {'name': v.candidate.name, 'area': v.candidate.area_hint, 'category': v.candidate.specialty,
            'description': v.candidate.reason, 'price_range': ''}


def _credential_kind(key: str) -> str:
    if not key:
        return 'none'
    return 'AQ' if key.startswith('AQ') else 'other'


class ShopRecommendationOrchestrator:
    def __init__(self, recommender, credential_kind: str = 'unknown', identity_verifier=None, candidate_selector=None,
                 max_parallel: int = c.PLACES_MAX_PARALLEL, now=time.monotonic, wall=time.time):
        self.recommender = recommender
        self.identity_verifier = identity_verifier   # None なら同一性判定なし（従来方式）
        self.candidate_selector = candidate_selector # Gate D1.6: Places 上位 5 候補から LLM が選択（None なら従来方式）
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

        # ---- 2. 33秒版と同じ Places 照合（LLM の JSON 完成後に開始）
        m['places_started'] = self._wall()
        tp = self._now()
        area = legacy_places.resolve_area(user_request, language_code)          # 33秒版 callback と同じ
        geo_info = legacy_places.region_info(area, language_code)               # 33秒版 enrich 冒頭と同じ
        m['area_resolve_ms'] = int((self._now() - tp) * 1000)
        m['area'] = area
        if self.candidate_selector:
            return self._run_selection(m, t0, tp, llm, area, geo_info, language_code, request_id)
        verifications = [None] * len(llm.candidates)

        def _lookup(cand):
            t = self._now()
            try:
                pd = legacy_places.lookup(cand.name, cand.area_hint, area, geo_info, language_code)
            except Exception as e:      # search_place 自体は例外を内部で None にするが、念のため
                return c.Verification(cand, c.API_ERROR, redact(f'{type(e).__name__}'),
                                      duration_ms=int((self._now() - t) * 1000))
            if not pd:
                return c.Verification(cand, c.NOT_VERIFIED, 'places_not_found',
                                      duration_ms=int((self._now() - t) * 1000))
            return c.Verification(cand, c.VERIFIED, 'legacy_search_place', place=pd,
                                  duration_ms=int((self._now() - t) * 1000))

        pool = ThreadPoolExecutor(max_workers=min(self.max_parallel, len(llm.candidates)),
                                  thread_name_prefix='places-legacy')
        try:
            futs = {pool.submit(_lookup, cand): i for i, cand in enumerate(llm.candidates)}
            done, not_done = wait(futs, timeout=PLACES_BATCH_TIMEOUT_SEC)
            for f in done:
                verifications[futs[f]] = f.result()
            for f in not_done:
                i = futs[f]
                verifications[i] = c.Verification(llm.candidates[i], c.API_ERROR, 'places_batch_timeout')
        finally:
            pool.shutdown(wait=False, cancel_futures=True)
        m['places_finished'] = self._wall()
        m['places_duration_ms'] = int((self._now() - tp) * 1000)

        # ---- 3. 同一性判定 LLM（Gate D1.5 PoC。既定 OFF。1 検索につき 1 回・最大 7 組を一括）
        identity = {}
        m['identity_enabled'] = bool(self.identity_verifier)
        m['identity_calls'] = 0
        m['identity_duration_ms'] = None
        m['identity_google_search_calls'] = None
        if self.identity_verifier:
            found = [v for v in verifications if v.status == c.VERIFIED]
            pairs = [{'id': v.candidate.rank, 'recommended_name': v.candidate.name,
                      'recommended_area': v.candidate.area_hint,
                      'matched_name': (v.place or {}).get('name') or '',
                      'matched_area': (v.place or {}).get('formatted_address') or ''} for v in found]
            if pairs:
                m['identity_calls'] = 1
                ti = self._now()
                try:
                    identity, dur, searches = self.identity_verifier.verify(pairs)
                    m['identity_duration_ms'] = dur
                    m['identity_google_search_calls'] = searches
                except c.RecommendationError as e:
                    m['identity_duration_ms'] = int((self._now() - ti) * 1000)
                    a_sel, _ = select_display(verifications)
                    m['legacy_card_count'] = len(a_sel)
                    m['final_status'] = c.ERROR
                    m['error_type'] = e.error_type
                    return self._finish(m, t0, [], [], verifications, error_detail=redact(e.detail), identity={})
            counts = {c.SAME: 0, c.DIFFERENT: 0, c.UNCERTAIN: 0}
            for j_, _r in identity.values():
                counts[j_] += 1
            m['identity_same'], m['identity_different'], m['identity_uncertain'] = (
                counts[c.SAME], counts[c.DIFFERENT], counts[c.UNCERTAIN])

        # ---- 4. 33秒版 enrich と同じ: LLM 順に、見つからない店は除外、place_id 重複は後の方を除外
        a_selected, a_rejected = select_display(verifications)                    # A: 従来方式
        m['legacy_card_count'] = len(a_selected)
        if self.identity_verifier:                                                # B: SAME のみ
            selected, rejected = select_display(
                verifications, accept=lambda v: identity.get(v.candidate.rank, (None,))[0] == c.SAME)
        else:
            selected, rejected = a_selected, a_rejected
        m['identity_card_count'] = len(selected) if self.identity_verifier else None
        m['verified_count'] = len(selected)
        m['rejected_counts_by_reason'] = rejected
        n = len(selected)
        m['final_status'] = c.COMPLETE if n >= c.DISPLAY_COUNT else (c.PARTIAL if n > 0 else c.EMPTY)

        cards = [build_card(v, i + 1, request_id) for i, v in enumerate(selected)]
        narration = [build_narration_item(v) for v in selected]
        result = self._finish(m, t0, cards, narration, verifications, identity=identity)
        result['legacy_cards'] = [build_card(v, i + 1, request_id) for i, v in enumerate(a_selected)]
        return result

    def _run_selection(self, m, t0, tp, llm, area, geo_info, language_code, request_id):
        """
        Gate D1.6（方式 C）: 各推薦店舗について 33秒版と同じ Text Search を 1 回（並列）→ 上位 5 候補 →
        選択 LLM を 1 回だけ呼び、店舗ごとに同一と判断できる候補 1 件か null を選ばせる →
        選ばれた店舗だけ Place Details（33秒版と同じ国コード照合）→ 33秒版と同じ採用規則で最大 5 件
        """
        n = len(llm.candidates)
        searched = [None] * n
        ts = self._now()
        pool = ThreadPoolExecutor(max_workers=min(self.max_parallel, n), thread_name_prefix='places-cands')
        try:
            futs = {pool.submit(legacy_places.search_place_candidates, cd.name, cd.area_hint, area, geo_info,
                                language_code): i for i, cd in enumerate(llm.candidates)}
            done, not_done = wait(futs, timeout=PLACES_BATCH_TIMEOUT_SEC)
            for f in done:
                try:
                    searched[futs[f]] = f.result()
                except Exception as e:
                    searched[futs[f]] = ([], f'ERROR:{type(e).__name__}')
            for f in not_done:
                searched[futs[f]] = ([], 'ERROR:places_batch_timeout')
        finally:
            pool.shutdown(wait=False, cancel_futures=True)
        m['places_search_ms'] = int((self._now() - ts) * 1000)

        # 候補 ID は検索内で一意（1 から通し番号）。place との対応はプログラム側で保持
        next_id, id_map, recs, meta = 1, {}, [], {}
        for cd, (cands, st) in zip(llm.candidates, searched):
            entry = {'rank': cd.rank, 'recommended_name': cd.name, 'recommended_area': cd.area_hint,
                     'places_candidates': []}
            meta[cd.rank] = {'search_status': st, 'n_candidates': len(cands),
                             'top1_name': cands[0].get('name') if cands else None, 'positions': {}}
            for pos, p in enumerate(cands, 1):
                id_map[next_id] = p
                meta[cd.rank]['positions'][next_id] = pos
                entry['places_candidates'].append({'candidate_id': next_id, 'name': p.get('name') or '',
                                                   'area': p.get('formatted_address') or ''})
                next_id += 1
            if entry['places_candidates']:
                recs.append(entry)
        m['places_candidates_total'] = len(id_map)
        m['selection_calls'] = 0
        selection = {}
        if recs:
            m['selection_calls'] = 1
            try:
                selection, dur, searches = self.candidate_selector.select(recs)
                m['selection_duration_ms'] = dur
                m['selection_google_search_calls'] = searches
            except c.RecommendationError as e:
                m['final_status'], m['error_type'] = c.ERROR, e.error_type
                return self._finish(m, t0, [], [], [], error_detail=redact(e.detail))

        # 選ばれた店舗だけ Place Details（並列）
        chosen = {rank: id_map[cid] for rank, (cid, _r) in selection.items() if cid is not None}
        td = self._now()
        details = {}
        if chosen:
            dpool = ThreadPoolExecutor(max_workers=min(self.max_parallel, len(chosen)), thread_name_prefix='details')
            try:
                dfuts = {dpool.submit(legacy_places.fetch_selected_details, p, geo_info, language_code): rank
                         for rank, p in chosen.items()}
                ddone, dnot = wait(dfuts, timeout=PLACES_BATCH_TIMEOUT_SEC)
                for f in ddone:
                    try:
                        details[dfuts[f]] = f.result()
                    except Exception:
                        details[dfuts[f]] = 'ERROR'
                for f in dnot:
                    details[dfuts[f]] = 'ERROR'
            finally:
                dpool.shutdown(wait=False, cancel_futures=True)
        m['details_ms'] = int((self._now() - td) * 1000)
        m['places_finished'] = self._wall()
        m['places_duration_ms'] = int((self._now() - tp) * 1000)

        verifications, pos_counts = [], {}
        for cd in llm.candidates:
            md = meta[cd.rank]
            if md['n_candidates'] == 0:
                v = c.Verification(cd, c.NOT_VERIFIED if md['search_status'] in ('OK', 'ZERO_RESULTS') else c.API_ERROR,
                                   'no_places_candidates')
            else:
                cid, reason = selection.get(cd.rank, (None, ''))
                pos = None
                if cid is None:
                    v = c.Verification(cd, c.NOT_VERIFIED, 'selection_not_found')
                else:
                    pos = md['positions'][cid]
                    pos_counts[pos] = pos_counts.get(pos, 0) + 1
                    d = details.get(cd.rank)
                    if d == 'ERROR':
                        v = c.Verification(cd, c.API_ERROR, 'details_error')
                    elif d is None:
                        v = c.Verification(cd, c.NOT_VERIFIED, 'country_mismatch')
                    else:
                        v = c.Verification(cd, c.VERIFIED, f'selected_position_{pos}', place=d)
                md['selected_position'] = pos
                md['selection_reason'] = reason
            verifications.append(v)
        m['selection_positions'] = pos_counts
        m['selection_not_found'] = sum(1 for v in verifications if v.reason == 'selection_not_found')

        selected, rejected = select_display(verifications)
        m['verified_count'] = len(selected)
        m['rejected_counts_by_reason'] = rejected
        k = len(selected)
        m['final_status'] = c.COMPLETE if k >= c.DISPLAY_COUNT else (c.PARTIAL if k > 0 else c.EMPTY)
        cards = [build_card(v, i + 1, request_id) for i, v in enumerate(selected)]
        narration = [build_narration_item(v) for v in selected]
        result = self._finish(m, t0, cards, narration, verifications)
        for vv in result['verifications']:
            md = meta[vv['rank']]
            vv.update({'top1_name': md['top1_name'], 'n_candidates': md['n_candidates'],
                       'selected_position': md.get('selected_position'), 'selection_reason': md.get('selection_reason')})
        result['places_candidates'] = {r: [(p.get('place_id'), p.get('name'), p.get('formatted_address'))
                                           for p in [id_map[cid] for cid in meta[r]['positions']]] for r in meta}
        return result

    def _finish(self, m, t0, cards, narration, verifications, error_detail=None, identity=None):
        identity = identity or {}
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
                 'status': v.status, 'reason': v.reason, 'place_id': (v.place or {}).get('place_id'),
                 'places_ms': v.duration_ms,
                 'matched_name': (v.place or {}).get('name'),
                 'identity': identity.get(v.candidate.rank, (None, None))[0],
                 'identity_reason': identity.get(v.candidate.rank, (None, None))[1]}
                for v in verifications if v is not None],
            'metrics': m,
        }


def build_from_env():
    """
    Cloud Run 環境変数から構築。GEMINI_RECOMMEND_API_KEY が無ければ ConfigError（既存 GEMINI_API_KEY で代替しない）。
    Places / Geocoding は 33秒版と同じく api_integrations が GOOGLE_PLACES_API_KEY を使う。
    """
    from .recommender import RecommendationClient
    from .redact import register_secret
    gkey = os.environ.get('GEMINI_RECOMMEND_API_KEY', '')
    register_secret(os.environ.get('GOOGLE_PLACES_API_KEY', ''))
    identity = None
    if os.environ.get(c.IDENTITY_ENV_FLAG, 'off') == 'on':   # 既定 OFF（規約確認前は ON にしない）
        from .llm_identity_verifier import LlmIdentityVerifier
        identity = LlmIdentityVerifier(gkey)
    selector = None
    if os.environ.get(c.SELECTION_ENV_FLAG, 'off') == 'on':   # 既定 OFF（規約確認前は ON にしない）
        from .llm_candidate_selector import LlmCandidateSelector
        selector = LlmCandidateSelector(gkey)
    return ShopRecommendationOrchestrator(RecommendationClient(gkey), credential_kind=_credential_kind(gkey),
                                          identity_verifier=identity, candidate_selector=selector)
