# -*- coding: utf-8 -*-
"""
ショップ推薦エンジン v2 のオーケストレーション（DESIGN.md §1, §5, §7）。

  LLM ストリーム（plan → candidate …）
    ├─ plan 受信 → Geocoding（1回）・Freshness Search（required のときだけ）を開始
    └─ candidate 受信 → その場で Places 照合を並列開始
  照合結果は推薦順にしか確定しない（順位が後から変わらない）。VERIFIED だけをカードにする。

on_event(name, payload) にイベントを渡す（Step 4 で Socket.IO に接続する）。
"""
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor

from . import matching
from .recommender import (DEFAULT_CANDIDATES, DEFAULT_MODEL, RecommenderError,
                          freshness_search, stream_recommendations)

TARGET_CARDS = 5
PLACES_MAX_WORKERS = 8


class EngineConfig:
    def __init__(self, model=DEFAULT_MODEL, n_candidates=DEFAULT_CANDIDATES, thinking_budget=None,
                 llm_timeout_sec=20.0, target_cards=TARGET_CARDS, run_freshness=True,
                 freshness_model=None, language='ja'):
        self.model = model
        self.n_candidates = n_candidates
        self.thinking_budget = thinking_budget
        self.llm_timeout_sec = llm_timeout_sec
        self.target_cards = target_cards
        self.run_freshness = run_freshness
        self.freshness_model = freshness_model or model
        self.language = language


def build_card(cand, place, places_client, recommend_rank, display_rank, detail):
    loc = (place.get('geometry') or {}).get('location') or {}
    pid = place.get('place_id')
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
        'image': places_client.photo_url(place),
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
        self.freshness = None
        self.done = threading.Event()
        self.llm_finished = False
        self.geo_future = None
        self.fresh_thread = None

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
        if self.geo_future is None:
            return None
        try:
            return self.geo_future.result(timeout=self.places.timeout + 1)
        except Exception:
            return None

    def _verify(self, cand):
        self._mark('T3')
        area = cand.get('area') or (self.plan or {}).get('area', '')
        center = self._area_center()
        try:
            results = self.places.text_search(f"{cand['name']} {area}".strip(), center, self.cfg.language)
            status, place, detail = matching.classify(cand, results, area, center)
            if status == matching.NOT_FOUND and cand.get('name_variants'):
                alt = self.places.text_search(f"{cand['name_variants'][0]} {area}".strip(), center, self.cfg.language)
                status2, place2, detail2 = matching.classify(cand, alt, area, center)
                detail['retry'] = detail2
                if status2 != matching.NOT_FOUND:
                    status, place, detail = status2, place2, detail2
        except Exception as e:
            status, place, detail = matching.ERROR, None, {'error': f'{type(e).__name__}: {str(e)[:200]}'}
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
                    card = build_card(c, pl, self.places, c['rank'], len(self.cards) + 1, dt)
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

    # ---------------- 実行 ----------------
    def run(self):
        self.t['T0'] = self.now()
        self._emit('recommendation_started', {})
        status = 'ok'
        error = None
        fresh_thread = None
        pool = ThreadPoolExecutor(max_workers=PLACES_MAX_WORKERS, thread_name_prefix='verify')
        geo_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix='geo')
        llm_t = {}
        try:
            for item in stream_recommendations(self.client, self.types, self.user_request, self.cfg.model,
                                               self.cfg.n_candidates, self.cfg.thinking_budget,
                                               self.cfg.llm_timeout_sec, llm_t, self.now):
                if item['type'] == 'plan' and self.plan is None:
                    self.plan = item
                    self.geo_future = geo_pool.submit(self.places.geocode, item['area'], self.cfg.language)
                    fr = item['freshness']
                    if fr['required'] and self.cfg.run_freshness:
                        fresh_thread = threading.Thread(target=self._run_freshness, args=(fr,), daemon=True)
                        self.fresh_thread = fresh_thread
                        fresh_thread.start()
                elif item['type'] == 'candidate':
                    with self.lock:
                        self.candidates.append(item)
                    if self.geo_future is None:   # plan が来なかった場合は候補のエリアで1回だけ
                        self.geo_future = geo_pool.submit(self.places.geocode, item['area'], self.cfg.language)
                    pool.submit(self._verify, item)
                    if len(self.cards) >= self.cfg.target_cards:
                        break
                elif item['type'] == 'end':
                    break
        except RecommenderError as e:
            status, error = e.reason, e.detail
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
        if fresh_thread is not None:
            fresh_thread.join(timeout=0)  # 待たない（Step 1 は記録のみ）
        return self._result(final, error)

    def _run_freshness(self, fr):
        ft = {}
        res = freshness_search(self.client, self.types, fr['query'] or self.user_request, self.user_request,
                               self.cfg.freshness_model, ft, self.now)
        with self.lock:
            self.t['Fs'] = ft.get('Fs')
            self.t['Fe'] = ft.get('Fe')
            self.freshness = dict(res, reason=fr['reason'], query=fr['query'], central=fr['central'])

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
                'timings': self.timings(),
                'cards': list(self.cards),
                'candidates': list(self.candidates),
                'verifications': verifications,
                'freshness': self.freshness,
                'llm_bad_lines': getattr(self, 'llm_bad_lines', []),
            }


def recommend(user_request, client, types_mod, places_client, config=None, on_event=None, request_id=None):
    return RecommendationRun(user_request, client, types_mod, places_client, config, on_event, request_id).run()
