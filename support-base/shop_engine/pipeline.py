# -*- coding: utf-8 -*-
"""
ショップ推薦エンジン v2 のオーケストレーション（DESIGN.md §1, §5, §7）。

  LLM ストリーム（plan → candidate …）
    ├─ plan 受信 → Geocoding を開始（照合はこれを待たない。修正1）
    └─ candidate 受信 → その場で Places 照合を並列開始
  照合結果は推薦順にしか確定しない（順位が後から変わらない）。VERIFIED だけをカードにする。

Step 1〜2 では Google 検索を実行しない（修正2）。plan.freshness は LLM の判断として記録するだけ。
on_event(name, payload) にイベントを渡す（Step 4 で Socket.IO に接続する）。
T5 / T6 はサーバー側でカードを確定した時刻であり、ブラウザでの表示時刻ではない。
"""
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor

from . import matching
from .recommender import DEFAULT_CANDIDATES, DEFAULT_MODEL, RecommenderError, stream_recommendations
from .redact import redact

TARGET_CARDS = 5
PLACES_MAX_WORKERS = 8
TIMING_NOTE = 'T5/T6 はサーバー側のカード確定時刻（ブラウザでの表示時刻ではない。転送・描画時間は含まない）'


class EngineConfig:
    def __init__(self, model=DEFAULT_MODEL, n_candidates=DEFAULT_CANDIDATES, thinking_budget=None,
                 llm_timeout_sec=20.0, target_cards=TARGET_CARDS, language='ja'):
        self.model = model
        self.n_candidates = n_candidates
        self.thinking_budget = thinking_budget
        self.llm_timeout_sec = llm_timeout_sec
        self.target_cards = target_cards
        self.language = language


def build_card(cand, place, recommend_rank, display_rank, detail):
    """カードデータ。API キーを含む値（写真 URL 等）は入れない（修正3）"""
    loc = (place.get('geometry') or {}).get('location') or {}
    pid = place.get('place_id')
    photos = place.get('photos') or []
    return {
        'name': place.get('name') or cand['name'],
        'llm_name': cand['name'],
        'category': cand.get('category', ''),
        'description': cand.get('reason', ''),
        'priceRange': cand.get('price_range', ''),
        'highlights': [cand['specialty']] if cand.get('specialty') else [],
        'area': cand.get('area', ''),
        'location': place.get('formatted_address', ''),
        'latitude': loc.get('lat'),
        'longitude': loc.get('lng'),
        'rating': place.get('rating'),
        'reviewCount': place.get('user_ratings_total'),
        'maps_url': f'https://www.google.com/maps/place/?q=place_id:{pid}' if pid else '',
        'place_id': pid,
        'photo_reference': (photos[0].get('photo_reference') if photos else None) or None,
        'recommend_rank': recommend_rank,
        'display_rank': display_rank,
        'verification': {'status': matching.VERIFIED, 'score': (detail.get('chosen') or {}).get('score')},
    }


class RecommendationRun:
    def __init__(self, user_request, client, types_mod, places_client, config=None, on_event=None,
                 request_id=None, now=time.monotonic):
        self.user_request = user_request
        self.client = client
        self.types = types_mod
        self.places = places_client
        self.cfg = config or EngineConfig()
        self.on_event = on_event or (lambda name, payload: None)
        self.request_id = request_id or uuid.uuid4().hex
        self.now = now
        self.t = {}
        self.lock = threading.Lock()
        self.candidates = []          # 推薦順
        self.results = {}             # rank -> (status, place, detail)
        self.next_rank = 1
        self.cards = []
        self.seen_place_ids = set()
        self.plan = None
        self.done = threading.Event()
        self.llm_finished = False
        self.geo_future = None
        self.geo_area = None
        self.llm_bad_lines = []

    # ---------------- 計測 ----------------
    def _mark(self, key):
        with self.lock:
            self.t.setdefault(key, self.now())

    def timings(self):
        t0 = self.t.get('T0')
        out = {}
        for k, v in self.t.items():
            if isinstance(v, (int, float)) and t0 is not None:
                out[k] = round(v - t0, 3)
        return out

    def _emit(self, name, payload):
        payload = dict(payload, request_id=self.request_id)
        try:
            self.on_event(name, payload)
        except Exception:
            pass

    # ---------------- 照合 ----------------
    def _area_center(self):
        """中心座標（Geocoding 結果）。照合で距離判定が必要になったときだけ呼ばれる"""
        if self.geo_future is None:
            return None
        try:
            center = self.geo_future.result(timeout=self.places.timeout + 1)
        except Exception:
            center = None
        with self.lock:
            self.t.setdefault('Tgeo', self.now())
        return center

    def _verify(self, cand):
        self._mark('T3')
        area = cand.get('area') or (self.plan or {}).get('area', '')
        try:
            # Geocoding を待たずに照会を開始する（修正1）
            results = self.places.text_search(f"{cand['name']} {area}".strip(), self.cfg.language)
            status, place, detail = matching.classify(cand, results, area, self._area_center)
            if status == matching.NOT_FOUND and cand.get('name_variants'):
                alt = self.places.text_search(f"{cand['name_variants'][0]} {area}".strip(), self.cfg.language)
                status2, place2, detail2 = matching.classify(cand, alt, area, self._area_center)
                detail['retry'] = detail2
                if status2 != matching.NOT_FOUND:
                    status, place, detail = status2, place2, detail2
        except Exception as e:
            status, place, detail = matching.ERROR, None, {'error': redact(f'{type(e).__name__}: {str(e)[:300]}')}
        self._mark('T4')
        self._on_verified(cand, status, place, detail)

    def _on_verified(self, cand, status, place, detail):
        to_emit = []
        with self.lock:
            self.results[cand['rank']] = (status, place, detail)
            self._emit('candidate_verified', {'recommend_rank': cand['rank'], 'name': cand['name'],
                                              'status': status})
            # 推薦順に確定（DESIGN.md §5）
            while (len(self.cards) < self.cfg.target_cards and self.next_rank in self.results):
                st, pl, dt = self.results[self.next_rank]
                c = self.candidates[self.next_rank - 1]
                if st == matching.VERIFIED and pl.get('place_id') not in self.seen_place_ids:
                    self.seen_place_ids.add(pl.get('place_id'))
                    card = build_card(c, pl, c['rank'], len(self.cards) + 1, dt)
                    self.cards.append(card)
                    to_emit.append(card)
                    if len(self.cards) == 1:
                        self.t.setdefault('T5', self.now())
                    if len(self.cards) == self.cfg.target_cards:
                        self.t.setdefault('T6', self.now())
                elif st == matching.VERIFIED:
                    dt['duplicate_of_earlier'] = True
                self.next_rank += 1
            for card in to_emit:
                self._emit('shop_card_ready', {'display_rank': card['display_rank'], 'place_id': card['place_id'],
                                               'card': card})
            self._check_done_locked()

    def _check_done_locked(self):
        if len(self.cards) >= self.cfg.target_cards:
            self.done.set()
        elif self.llm_finished and len(self.results) >= len(self.candidates):
            self.done.set()

    def _start_geocode(self, pool, area):
        if self.geo_future is None and area:
            self.geo_area = area
            self.geo_future = pool.submit(self.places.geocode, area, self.cfg.language)

    # ---------------- 実行 ----------------
    def run(self):
        self.t['T0'] = self.now()
        self._emit('recommendation_started', {})
        status = 'ok'
        error = None
        pool = ThreadPoolExecutor(max_workers=PLACES_MAX_WORKERS, thread_name_prefix='verify')
        geo_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix='geo')
        llm_t = {}
        try:
            for item in stream_recommendations(self.client, self.types, self.user_request, self.cfg.model,
                                               self.cfg.n_candidates, self.cfg.thinking_budget,
                                               self.cfg.llm_timeout_sec, llm_t, self.now):
                if item['type'] == 'plan' and self.plan is None:
                    self.plan = item   # freshness は記録のみ。Google 検索は実行しない（修正2）
                    self._start_geocode(geo_pool, item['area'])
                elif item['type'] == 'candidate':
                    with self.lock:
                        self.candidates.append(item)
                    self._start_geocode(geo_pool, item['area'])   # plan が来なかった場合
                    pool.submit(self._verify, item)
                    if len(self.cards) >= self.cfg.target_cards:
                        break
                elif item['type'] == 'end':
                    break
        except RecommenderError as e:
            status, error = e.reason, redact(e.detail)
        finally:
            for k in ('T1', 'T1p', 'T1c', 'T2'):
                if k in llm_t:
                    self.t[k] = llm_t[k]
            self.llm_bad_lines = llm_t.get('bad_lines', [])
            with self.lock:
                self.llm_finished = True
                self._check_done_locked()

        if not self.candidates:
            pool.shutdown(wait=False)
            geo_pool.shutdown(wait=False)
            self.t['T7'] = self.now()
            final = status if status != 'ok' else 'no_candidates'
            if final in ('upstream_error', 'timeout', 'error'):
                self._emit('recommendation_error', {'reason': final, 'detail': error})
            else:
                self._emit('recommendation_completed', {'count': 0, 'status': final, 'cards': []})
            return self._result(final, error)

        self.done.wait(timeout=self.places.timeout * 3 + 5)
        pool.shutdown(wait=False)
        geo_pool.shutdown(wait=False)
        self.t['T7'] = self.now()
        with self.lock:
            cards = list(self.cards)
        final = status if status != 'ok' else ('ok' if len(cards) >= self.cfg.target_cards else 'short')
        self._emit('recommendation_completed', {'count': len(cards), 'status': final, 'cards': cards})
        return self._result(final, error)

    def _result(self, status, error):
        with self.lock:
            verifications = []
            for c in self.candidates:
                st, pl, dt = self.results.get(c['rank'], ('PENDING', None, {}))
                verifications.append({'rank': c['rank'], 'name': c['name'], 'name_variants': c['name_variants'],
                                      'area': c['area'], 'status': st, 'detail': dt})
            return {
                'request_id': self.request_id,
                'user_request': self.user_request,
                'model': self.cfg.model,
                'thinking_budget': self.cfg.thinking_budget,
                'n_candidates': self.cfg.n_candidates,
                'status': status,
                'error': error,
                'plan': self.plan,
                'freshness_decision': (self.plan or {}).get('freshness'),
                'google_search_executed': False,
                'timings': self.timings(),
                'timing_note': TIMING_NOTE,
                'cards': list(self.cards),
                'candidates': list(self.candidates),
                'verifications': verifications,
                'llm_bad_lines': list(self.llm_bad_lines),
            }


def recommend(user_request, client, types_mod, places_client, config=None, on_event=None, request_id=None):
    return RecommendationRun(user_request, client, types_mod, places_client, config, on_event, request_id).run()
