# -*- coding: utf-8 -*-
"""
M4 F1: S10 フロー（設計書 DESIGN_M4_INTEGRATION.md v0.2 §5）。プレビュー専用の設定（NEW_SHOP_FLOW=S10）のときだけ使う。

  推薦A（店名 10 件・stream）── 店名が 1 件確定するたびに店舗単位の照合（並列）
     Agent Tools searchText → Place Details → 軽量判定（R2〜R4 済み）
       SAME: 採用 / AMBIGUOUS: 選択 LLM（1 店舗。summary はここでだけ使う。R2 の支店矛盾は不採用）/ DIFFERENT: 不採用
  表示: 二段階・先行 1 枚
     最初に採用が決まった 1 枚を「確認中」で送る（stage=preview）
     推薦順位 1〜k 位がすべて判定済みで採用 5 件が揃った時点、推薦A の全店舗の判定が終わった時点、
     または 10 秒の締め切りで、推薦順位どおりの最終カードを送る（stage=final）。揃わなければ確認できた店舗だけ（不足を隠さない）
  推薦B（詳細説明・stream）: 推薦A 完了時に開始し、最終カードの説明を項目が完成するたびに送る（カード専用。Live には渡さない）
  Live: 最終確定の時点で返す結果の narration（方式 D: 推薦A の店名・地区のみ）を、呼び出し側が tool_response として 1 回送る

ログには place ID と時刻だけを残す（店名・住所などの Google Maps の内容は残さない）。
"""
import json
import logging
import os
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor

import requests

from . import agent_tools_places as at
from . import contracts as c
from . import light_identity as L
from . import scope as S
from . import split_prompts as SP
from .orchestrator import build_card
from .redact import redact
from .stream_json import CandidateStreamTracker, SseReader

logger = logging.getLogger(__name__)

DEADLINE_SEC = 10.0
DETAILS_URL = 'https://maps.googleapis.com/maps/api/place/details/json'
GEOCODE_URL = 'https://maps.googleapis.com/maps/api/geocode/json'
DETAILS_FIELDS = ('name,rating,user_ratings_total,formatted_address,address_components,types,'
                  'formatted_phone_number,international_phone_number,geometry/location,business_status')
HARD_REJECT = {'closed', 'not_a_store', 'prefecture_mismatch', 'area_mismatch'}
STAGE_EVENT = 'shop_search_stage'
DETAIL_EVENT = 'shop_card_detail'


# ------------------------------------------------------------------ 外部 API（既定の実装。テストでは差し替える）
class HttpApis:
    def __init__(self, gemini_key: str, maps_agent_key: str):
        self.gkey, self.mkey = gemini_key, maps_agent_key

    def _headers(self, stream=False):
        h = {'Content-Type': 'application/json', 'x-goog-api-key': self.gkey, 'Api-Revision': c.INTERACTIONS_API_REVISION}
        if stream:
            h['Accept'] = 'text/event-stream'
        return h

    def geocode(self, text):
        import api_integrations as legacy
        try:
            d = legacy.requests.get(GEOCODE_URL, params={'address': text, 'key': legacy.GOOGLE_GEOCODING_API_KEY,
                                                          'language': 'ja', 'region': 'jp'}, timeout=5).json()
        except Exception:
            return None
        if d.get('status') != 'OK' or not d.get('results'):
            return None
        r = d['results'][0]
        comps = r.get('address_components') or []
        pref = next((x.get('long_name') for x in comps if 'administrative_area_level_1' in x.get('types', [])), None)
        cc = next((x.get('short_name') for x in comps if 'country' in x.get('types', [])), None)
        loc = (r.get('geometry') or {}).get('location') or {}
        names = [x.get('long_name') for x in comps if x.get('long_name')] + \
                [x.get('short_name') for x in comps if x.get('short_name')]
        return {'lat': loc.get('lat'), 'lng': loc.get('lng'), 'viewport': (r.get('geometry') or {}).get('viewport'),
                'prefecture': pref, 'country_code': cc, 'types': r.get('types') or [], 'component_names': names,
                'formatted_address': r.get('formatted_address') or '', 'partial_match': bool(r.get('partial_match'))}

    def search(self, rec, scope):
        return at.search_text(self.mkey, rec['name'], rec['area_hint'], scope.get('area') or '', scope.get('geo'))

    def details(self, place):
        """判定とカードの両方に使う Place Details（1 回）。returns dict（error キーがあれば失敗）"""
        import api_integrations as legacy
        try:
            d = legacy.requests.get(DETAILS_URL, params={'place_id': place['place_id'], 'fields': DETAILS_FIELDS,
                                                         'key': legacy.GOOGLE_PLACES_API_KEY, 'language': 'ja'},
                                    timeout=10).json()
        except Exception as e:
            return {'error': type(e).__name__}
        if d.get('status') != 'OK':
            return {'error': d.get('status')}
        r = d.get('result') or {}
        loc = (r.get('geometry') or {}).get('location') or {}
        country = next((x.get('short_name') for x in r.get('address_components') or [] if 'country' in x.get('types', [])), None)
        return {'place_id': place['place_id'], 'name': r.get('name'), 'address': r.get('formatted_address') or '',
                'formatted_address': r.get('formatted_address'), 'types': r.get('types') or [],
                'business_status': r.get('business_status'), 'lat': loc.get('lat'), 'lng': loc.get('lng'),
                'rating': r.get('rating'), 'user_ratings_total': r.get('user_ratings_total'), 'country_code': country,
                'phone': r.get('formatted_phone_number') or r.get('international_phone_number'),
                'maps_url': place.get('place_url'), 'maps_attribution': place.get('attribution')}

    def select(self, rec, search_result):
        """店舗単位の選択 LLM（1 店舗・最大 5 候補・summary でグラウンディング）。returns 候補の添字 or None"""
        from .llm_grounded_selector import LlmGroundedSelector
        sel = LlmGroundedSelector(self.gkey)
        recs = [{'rank': rec['rank'], 'recommended_name': rec['name'], 'recommended_area': rec['area_hint'],
                 'maps_summary': search_result.get('summary') or '',
                 'maps_places': [{'candidate_id': i + 1, 'citation': i} for i in range(len(search_result['places']))]}]
        out, _ms, _s = sel.select(recs)
        cid = out[rec['rank']][0]
        return None if cid is None else cid - 1

    def stream(self, body, on_text, should_stop):
        """Interactions API を stream=true で呼び、モデル出力のテキスト断片ごとに on_text(text) を呼ぶ。returns error or None"""
        try:
            r = requests.post(c.INTERACTIONS_URL, json=body, headers=self._headers(stream=True), timeout=(10, 60), stream=True)
        except requests.exceptions.RequestException as e:
            return f'network:{type(e).__name__}'
        if r.status_code != 200:
            return f'http_{r.status_code}'
        sse, step_types, err = SseReader(), {}, None
        try:
            for chunk in r.iter_content(chunk_size=None):
                if should_stop():
                    break
                if not chunk:
                    continue
                for name, data in sse.feed(chunk):
                    if data == '[DONE]' or name == 'done':
                        continue
                    try:
                        ev = json.loads(data)
                    except ValueError:
                        continue
                    et = ev.get('event_type') or name
                    if et == 'step.start':
                        step_types[ev.get('index')] = (ev.get('step') or {}).get('type')
                    elif et == 'step.delta':
                        d = ev.get('delta') or {}
                        if d.get('type') == 'text' and step_types.get(ev.get('index'), 'model_output') == 'model_output':
                            on_text(d.get('text') or '')
                    elif et == 'error':
                        err = f'stream_error:{(ev.get("error") or {}).get("code")}'
        except requests.exceptions.RequestException as e:
            err = err or f'stream_cut:{type(e).__name__}'
        finally:
            r.close()
        return err


# ------------------------------------------------------------------ 表示（二段階・先行 1 枚）
class Display:
    """店舗の判定結果を受け、先行カード・最終カードの送信時期を決める（スレッド安全）"""

    def __init__(self, deadline_ms):
        self.lock = threading.Lock()
        self.decided = {}            # rank -> store（判定済み。採用なら place_id あり）
        self.a_done = False
        self.a_ranks = set()
        self.preview = None
        self.final = None
        self.deadline_ms = deadline_ms

    def _final_cards(self, force):
        cards, seen = [], set()
        for rank in sorted(self.a_ranks):
            s = self.decided.get(rank)
            if s is None:
                if force:
                    continue                 # 締め切り: 判定が終わっていない店舗は不採用として扱う
                return None                  # 上位が未判定 → まだ確定しない
            if s.get('place_id') and s['place_id'] not in seen:
                seen.add(s['place_id'])
                cards.append(s)
                if len(cards) == c.DISPLAY_COUNT:
                    return cards
        if force or (self.a_done and all(r in self.decided for r in self.a_ranks)):
            return cards
        return None

    def on_name(self, rank):
        with self.lock:
            self.a_ranks.add(rank)

    def on_decided(self, store):
        """returns (preview_store or None, final_cards or None)"""
        with self.lock:
            if self.final is not None:
                return None, None
            self.decided[store['rank']] = store
            pv = None
            if self.preview is None and store.get('place_id'):
                self.preview = store
                pv = store
            fc = self._final_cards(force=False)
            if fc is not None:
                self.final = fc
            return pv, fc

    def on_a_done(self):
        with self.lock:
            self.a_done = True
            if self.final is not None:
                return None
            fc = self._final_cards(force=False)
            if fc is not None:
                self.final = fc
            return fc

    def on_deadline(self):
        with self.lock:
            if self.final is not None:
                return None
            self.final = self._final_cards(force=True)
            return self.final


# ------------------------------------------------------------------ 店舗単位の照合
def judge_with_scope(rec_name, d, scope):
    """
    軽量判定（閉業・業態・都道府県・店名）と、R1 の範囲検証（地域・駅・通り・施設内・不明）を合わせた判定。
    範囲外 → DIFFERENT。範囲を確認できない（施設内か不明・地域不明）→ 店名が一致しても AMBIGUOUS（選択 LLM で確認）
    """
    v = L.judge(rec_name, d, scope.get('prefecture'))          # 地区の距離判定は下の geo_verdict で行う
    if v[0] == L.DIFFERENT:
        return v
    g = S.geo_verdict(scope, d)
    if g[0] == L.DIFFERENT:
        return g
    if g[0] == L.AMBIGUOUS and v[0] == L.SAME:
        return L.AMBIGUOUS, g[1]
    return v


def match_store(rec, scope, apis, details_pool, ms):
    """returns store dict: rank, rec, hint, path, place_id, place(カード用・ログに出さない), verdicts, t_done, sel_ms"""
    out = {'rank': rec['rank'], 'rec': rec['name'], 'hint': rec['area_hint'], 'path': None, 'place_id': None,
           'place': None, 'verdicts': [], 'sel_ms': None, 't_start': ms(), 'n_cand': 0}
    try:
        r = apis.search(rec, scope)
    except Exception as e:
        out.update(path=f'search_error:{type(e).__name__}', t_done=ms())
        return out
    places = r.get('places') or []
    out['n_cand'] = len(places)
    if not places:
        out.update(path='no_candidates' if r.get('status') in ('OK', 'ZERO_RESULTS') else 'search_error', t_done=ms())
        return out
    dets = list(details_pool.map(apis.details, places))
    verdicts = []
    for d in dets:
        if d is None or d.get('error'):
            verdicts.append((L.AMBIGUOUS, 'details_error'))
        elif d.get('country_code') and d['country_code'] != 'JP':
            verdicts.append((L.DIFFERENT, 'country_mismatch'))
        else:
            verdicts.append(judge_with_scope(rec['name'], d, scope))
    out['verdicts'] = [f'{v}:{w}' for v, w in verdicts]
    same = [i for i, (v, _w) in enumerate(verdicts) if v == L.SAME]
    amb = [i for i, (v, w) in enumerate(verdicts) if v == L.AMBIGUOUS and w != 'details_error']
    pick = None
    if same:
        pick, out['path'] = same[0], 'same'
    elif amb:
        ts = ms()
        try:
            idx = apis.select(rec, r)
        except c.RecommendationError as e:
            idx, out['path'] = None, f'selection_error:{e.error_type}'
        out['sel_ms'] = ms() - ts
        if out['path']:
            pass
        elif idx is None or not 0 <= idx < len(dets):
            out['path'] = 'llm_none'
        elif verdicts[idx][0] == L.DIFFERENT:
            out['path'] = f'llm_pick_rejected:{verdicts[idx][1]}'
        elif L.branch_conflict_clear(rec['name'], dets[idx].get('name')):
            out['path'] = 'llm_pick_rejected:branch_conflict'          # M4 R2
        else:
            pick, out['path'] = idx, 'llm'
    else:
        out['path'] = 'all_different'
    if pick is not None:
        out['place_id'] = places[pick]['place_id']
        out['place'] = dets[pick]
        out['geo'] = S.geo_verdict(scope, dets[pick])[1]      # in_area / on_road / in_facility / geo_unverified など
    out['t_done'] = ms()
    return out


def make_card(store, display_rank, request_id, stage, desc=None):
    cd = c.Candidate(rank=store['rank'], name=store['rec'], area_hint=store['hint'],
                     specialty=(desc or ('', ''))[0], reason=(desc or ('', ''))[1])
    card = build_card(c.Verification(cd, c.VERIFIED, store['path'], place=store['place']), display_rank, request_id)
    card['maps_attribution'] = store['place'].get('maps_attribution')   # Google Maps の出典（表示必須）
    card['maps_url'] = store['place'].get('maps_url') or card.get('maps_url')
    card['stage'] = stage
    card['detail_pending'] = desc is None
    card['geo_check'] = store.get('geo')                    # 地理条件の検証結果（未確認なら画面に明示する）
    return card


# ------------------------------------------------------------------ フロー本体
class FlowS:
    def __init__(self, apis, n=SP.A_COUNT, deadline_sec=DEADLINE_SEC, now=time.monotonic, store_workers=12,
                 details_workers=30):
        self.apis = apis
        self.n = n
        self.deadline_sec = deadline_sec
        self._now = now
        self.store_workers = store_workers
        self.details_workers = details_workers

    def run(self, user_request: str, emit=None, request_id: str = None) -> dict:
        request_id = request_id or uuid.uuid4().hex
        emit = emit or (lambda ev, payload: None)
        t0 = self._now()
        ms = lambda: int((self._now() - t0) * 1000)  # noqa: E731
        deadline_ms = int(self.deadline_sec * 1000)
        disp = Display(deadline_ms)
        done_evt = threading.Event()
        lock = threading.Lock()
        m = {'request_id': request_id, 'flow': f'S{self.n}', 'git_sha': os.environ.get('GIT_SHA', 'unknown'),
             'events': {}, 'stores': {}, 'a_error': None, 'b_error': None, 'scope': None}
        stores_in, desc, final_box = {}, {}, {}
        store_pool = ThreadPoolExecutor(max_workers=self.store_workers, thread_name_prefix='s10-store')
        details_pool = ThreadPoolExecutor(max_workers=self.details_workers, thread_name_prefix='s10-det')
        misc_pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix='s10-misc')

        def mark(k, v=None):
            with lock:
                m['events'].setdefault(k, ms() if v is None else v)

        def send_preview(st):
            card = make_card(st, 1, request_id, 'preview', desc.get(st['rank']))
            emit(STAGE_EVENT, {'request_id': request_id, 'stage': 'preview', 'cards': [card], 't_ms': ms()})
            mark('preview_sent')

        def finalize(cards, why):
            fc = [make_card(st, i + 1, request_id, 'final', desc.get(st['rank'])) for i, st in enumerate(cards)]
            status = c.COMPLETE if len(fc) >= c.DISPLAY_COUNT else (c.PARTIAL if fc else c.EMPTY)
            final_box.update(cards=fc, stores=cards, status=status, why=why)
            for st in cards:
                if st['rank'] in desc:
                    mark(f'detail_{st["rank"]}')        # 最終カードに説明を含めて送った
            sk = (scope_f.result() if scope_f.done() else {}).get('kind') or 'unknown'
            final_box['scope_kind'] = sk
            emit(STAGE_EVENT, {'request_id': request_id, 'stage': 'final', 'cards': fc, 'status': status,
                               'shortfall': max(0, c.DISPLAY_COUNT - len(fc)), 'reason': why, 'scope_kind': sk,
                               't_ms': ms()})
            mark('final_sent')
            done_evt.set()

        def handle(pv, fc, why):
            if pv is not None:
                send_preview(pv)
            if fc is not None:
                finalize(fc, 'top5_decided' if len(fc) >= c.DISPLAY_COUNT and why != 'deadline' else why)

        scope_f = misc_pool.submit(S.resolve_scope, user_request, self.apis.geocode)

        def task(rec):
            sc = scope_f.result()
            st = match_store(rec, sc, self.apis, details_pool, ms)
            with lock:
                m['stores'][rec['rank']] = {k: st.get(k) for k in ('path', 'place_id', 't_start', 't_done', 'sel_ms', 'n_cand')}
                m['stores'][rec['rank']]['t_name'] = rec['t_name']
                m['stores'][rec['rank']]['verdicts'] = st['verdicts']
            if st.get('place_id'):
                mark('first_adopted', st['t_done'])
            pv, fc = disp.on_decided(st)
            handle(pv, fc, 'all_decided')

        # ---- 推薦A（stream）
        tr, dispatched, seen = CandidateStreamTracker(required_str=('name', 'area_hint')), set(), set()

        def on_a_text(text):
            t = ms()
            mark('a_first_text', t)
            tr.feed(text, t)
            for cd in tr.candidates:
                if cd['early_t'] is None or cd['index'] in dispatched or cd['index'] > self.n:
                    continue
                dispatched.add(cd['index'])
                f = cd['fields']
                key = ''.join(f['name'].split())
                if key in seen:
                    continue                  # 推薦A 内の同名の重複は照合しない
                seen.add(key)
                rec = {'rank': cd['index'], 'name': f['name'].strip(), 'area_hint': (f.get('area_hint') or '').strip(),
                       't_name': cd['early_t']}
                if done_evt.is_set():
                    continue                  # 最終確定後に届いた店名は照合しない
                stores_in[rec['rank']] = rec
                disp.on_name(rec['rank'])
                mark('a_first_name', t)
                store_pool.submit(task, rec)

        def deadline_watch():
            if not done_evt.wait(self.deadline_sec):
                fc = disp.on_deadline()
                if fc is not None:
                    finalize(fc, 'deadline')

        threading.Thread(target=deadline_watch, name='s10-deadline', daemon=True).start()

        def run_b(b_stores):
            by_rank = {st['rank']: st for st in b_stores}
            btr = CandidateStreamTracker(required_str=('name', 'specialty', 'reason'))
            sent = set()

            def on_b_text(text):
                t = ms()
                mark('b_first_text', t)
                btr.feed(text, t)
                for cd in btr.candidates:
                    if cd['obj'] is None or cd['index'] in sent:
                        continue
                    sent.add(cd['index'])
                    try:
                        rank, sp, rs = SP.check_b_item(cd['obj'], by_rank)
                    except c.RecommendationError as e:
                        m['b_error'] = m['b_error'] or e.error_type
                        continue
                    desc[rank] = (sp, rs)
                    send_detail(rank, t)

            err = self.apis.stream(SP.b_body(user_request, b_stores), on_b_text, lambda: False)
            m['b_error'] = m['b_error'] or err
            mark('b_done')
            for st in final_box.get('stores') or []:        # 最終確定より後に揃った分（未送信のもの）
                send_detail(st['rank'], ms())
            logger.info('[NewShopRec][S10] ' + redact(json.dumps(m, ensure_ascii=False)))

        def send_detail(rank, t):
            for st in final_box.get('stores') or []:
                if st['rank'] == rank and rank in desc and f'detail_{rank}' not in m['events']:
                    mark(f'detail_{rank}', t)
                    sp, rs = desc[rank]
                    emit(DETAIL_EVENT, {'request_id': request_id, 'place_id': st['place_id'], 'recommend_rank': rank,
                                        'specialty': sp, 'reason': rs, 't_ms': t})

        def run_a():
            a_err = self.apis.stream(SP.a_body(user_request, self.n), on_a_text, done_evt.is_set)
            mark('a_done')
            m['a_error'] = a_err
            if not stores_in:
                done_evt.set()
                misc_pool.shutdown(wait=False)
                return
            handle(None, disp.on_a_done(), 'all_decided')
            b_stores = [stores_in[r] for r in sorted(stores_in)]
            try:
                run_b(b_stores)
            finally:
                for p in (store_pool, details_pool, misc_pool):     # 照合中の店舗は最後まで動かしてから閉じる
                    p.shutdown(wait=False)

        a_thread = threading.Thread(target=run_a, name='s10-a', daemon=True)
        a_thread.start()
        self.last_a_thread = a_thread
        done_evt.wait(self.deadline_sec + 1.0)
        sc = scope_f.result() if scope_f.done() else {}
        m['scope'] = {k: sc.get(k) for k in ('area', 'kind', 'radius_km', 'radius_reason', 'scope_reason', 'prefecture')}
        if not stores_in and not final_box:
            m['final_status'] = c.ERROR if m['a_error'] else c.EMPTY
            logger.info('[NewShopRec][S10] ' + redact(json.dumps(m, ensure_ascii=False)))
            return {'request_id': request_id, 'status': m['final_status'], 'error_type': m['a_error'],
                    'cards': [], 'narration': [], 'narration_mode': 'D', 'request': user_request, 'shortfall': c.DISPLAY_COUNT,
                    'final_reason': 'error', 'metrics': m}
        fc, cards = final_box.get('stores') or [], final_box.get('cards') or []
        m['final_status'] = final_box.get('status')
        m['final_reason'] = final_box.get('why')
        m['final_place_ids'] = [st['place_id'] for st in fc]
        narration = [{'number': i + 1, 'name': st['rec'], 'area': st['hint']} for i, st in enumerate(fc)]
        return {'request_id': request_id, 'status': final_box.get('status') or c.EMPTY, 'error_type': m['a_error'],
                'cards': cards, 'narration': narration, 'narration_mode': 'D', 'request': user_request,
                'geo_unverified': final_box.get('scope_kind') == 'unknown',
                'shortfall': max(0, c.DISPLAY_COUNT - len(cards)), 'final_reason': final_box.get('why'), 'metrics': m}


def build_from_env():
    """NEW_SHOP_FLOW=S10 のときだけ使う。GEMINI_RECOMMEND_API_KEY と MAPS_AGENT_TOOLS_API_KEY が必要"""
    from .redact import register_secret
    gkey = os.environ.get('GEMINI_RECOMMEND_API_KEY', '')
    mkey = os.environ.get('MAPS_AGENT_TOOLS_API_KEY', '')
    if not gkey:
        raise c.ConfigError('GEMINI_RECOMMEND_API_KEY が設定されていません')
    if not mkey:
        raise c.ConfigError('MAPS_AGENT_TOOLS_API_KEY が設定されていません')
    register_secret(gkey)
    register_secret(mkey)
    register_secret(os.environ.get('GOOGLE_PLACES_API_KEY', ''))
    return FlowS(HttpApis(gkey, mkey))


FLOW_ENV = 'NEW_SHOP_FLOW'


def enabled() -> bool:
    return os.environ.get(FLOW_ENV, '').upper() == 'S10'
