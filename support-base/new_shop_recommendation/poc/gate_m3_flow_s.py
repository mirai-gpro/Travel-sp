# -*- coding: utf-8 -*-
"""
Gate M3 — フロー S 統合 PoC（計測専用。製品コード・フロント・本番フローは変更しない）

  python -m new_shop_recommendation.poc.gate_m3_flow_s --repeat 3 [--no-33]

1 試行（同じクエリ）で次の 4 方式を順に実行し、それぞれ推薦開始を t=0 として計測する。
  33  : 元の 33秒版本番の推薦（gemini-2.5-flash + Google 検索・本番と同じ SEARCH_ONLY_PROMPT）→ 33秒版 Places 照合（品質の基準）
  D   : 現行 7 件一括推薦 → Agent Tools（7 並列）→ 選択 LLM（7 店舗一括）→ Details
  S7  : 推薦A（店名のみ 7 件・ストリーミング）→ 店名確定ごとに店舗単位照合（Agent Tools → Details → 軽量判定 → 必要時だけ店舗単位の選択 LLM）
        ＋ 推薦A 完了後に推薦B（説明文）
  S10 : S7 と同じで推薦A を 10 件
結果ファイル（M3_RESULTS、既定 ~/m3_results.json）には LLM の出力・place ID・時刻・判定・呼び出し数だけを保存する
（Places の店名・住所などは保存しない。画面表示のみ）。正誤は独立判定ラベルで gate_m3_score が集計する。
"""
import argparse
import json
import os
import statistics
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, wait

import requests

import api_integrations as legacy
from new_shop_recommendation import agent_tools_places as at
from new_shop_recommendation import contracts as c
from new_shop_recommendation import legacy_places
from new_shop_recommendation.llm_candidate_selector import SelectionError
from new_shop_recommendation.llm_grounded_selector import LlmGroundedSelector
from new_shop_recommendation.poc import light_identity as L
from new_shop_recommendation.poc import m3_core as m3
from new_shop_recommendation.poc.stream_json import CandidateStreamTracker, SseReader
from new_shop_recommendation.recommender import RecommendationClient, _classify_http, extract_text
from new_shop_recommendation.redact import contains_secret, redact, register_secret

HERE = os.path.dirname(os.path.abspath(__file__))
QUERIES = [
    '横浜で美味しい焼き鳥屋を5軒', '銀座で評判の老舗の天ぷら店', '渋谷で落ち着いて過ごせるカフェ',
    '新宿で接待向けの個室がある和食 予算1人1万5千円 4名', '吉祥寺で子連れの家族でも行きやすいイタリアン',
    '東京駅から徒歩5分以内の美味しいラーメン', '中目黒 焼き鳥 予算1人5000円 2名', '札幌すすきので美味しいジンギスカン',
    '京都の祇園で記念日に行くカウンター割烹 予算1人2万円 2名', '大阪 梅田 串カツ 立ち飲み',
]
GEOCODE_URL = 'https://maps.googleapis.com/maps/api/geocode/json'
DETAILS_URL = 'https://maps.googleapis.com/maps/api/place/details/json'
DETAILS_FIELDS = 'name,formatted_address,types,business_status,geometry/location'
GENERATE_33_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent'
DEADLINE_MS, FIRST_MS = 10000, 5000
STORE_WAIT_SEC = 30
OUT = []
LOCK = threading.Lock()


def say(s=''):
    s = redact(s)
    with LOCK:
        OUT.append(s)
        print(s, flush=True)


class Counter:
    def __init__(self):
        self.d, self.lock = {}, threading.Lock()

    def add(self, k, n=1):
        with self.lock:
            self.d[k] = self.d.get(k, 0) + n


def usage_tokens(u):
    u = u or {}
    return (u.get('total_input_tokens') or u.get('promptTokenCount') or 0,
            u.get('total_output_tokens') or u.get('candidatesTokenCount') or 0,
            u.get('total_thought_tokens') or u.get('thoughtsTokenCount') or 0)


# ------------------------------------------------------------------ 外部 API（すべて計測専用の薄いラッパー）
class Apis:
    def __init__(self, gkey, mkey):
        self.gkey, self.mkey = gkey, mkey
        self.calls = Counter()
        self.tokens = Counter()
        self.details_pool = ThreadPoolExecutor(max_workers=30, thread_name_prefix='det')
        self.store_pool = ThreadPoolExecutor(max_workers=12, thread_name_prefix='store')
        self.misc_pool = ThreadPoolExecutor(max_workers=6, thread_name_prefix='misc')

    def headers(self):
        return {'Content-Type': 'application/json', 'x-goog-api-key': self.gkey, 'Api-Revision': c.INTERACTIONS_API_REVISION}

    def add_usage(self, kind, u):
        i, o, th = usage_tokens(u)
        self.tokens.add(f'{kind}_in', i)
        self.tokens.add(f'{kind}_out', o)
        self.tokens.add(f'{kind}_thought', th)

    def geocode(self, area):
        self.calls.add('geocoding')
        try:
            d = legacy.requests.get(GEOCODE_URL, params={'address': area, 'key': legacy.GOOGLE_GEOCODING_API_KEY,
                                                          'language': 'ja', 'region': 'jp'}, timeout=10).json()
        except Exception:
            return None
        if d.get('status') != 'OK' or not d.get('results'):
            return None
        r = d['results'][0]
        pref = next((x.get('long_name') for x in r.get('address_components') or []
                     if 'administrative_area_level_1' in x.get('types', [])), None)
        cc = next((x.get('short_name') for x in r.get('address_components') or [] if 'country' in x.get('types', [])), None)
        loc = (r.get('geometry') or {}).get('location') or {}
        return {'lat': loc.get('lat'), 'lng': loc.get('lng'), 'viewport': (r.get('geometry') or {}).get('viewport'),
                'prefecture': pref, 'country_code': cc}

    def scope_for(self, q):
        extracted = legacy_places.resolve_area(q, 'ja')
        self.calls.add('geocoding_extract')
        for area in m3.area_candidates(q, extracted):
            g = self.geocode(area)
            if g and g.get('lat') and g.get('country_code') == 'JP':
                radius, why = m3.scope_radius_km(q, g.get('viewport'))
                return {'area': area, 'prefecture': g['prefecture'], 'center': (g['lat'], g['lng']),
                        'radius_km': radius, 'radius_reason': why,
                        'geo': {'lat': g['lat'], 'lng': g['lng'], 'region': g['prefecture'] or '', 'country_code': 'JP'}}
        return {'area': extracted, 'prefecture': None, 'center': None, 'radius_km': None, 'radius_reason': 'no_geocode',
                'geo': None}

    def details_full(self, place):
        self.calls.add('place_details')
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
        return {'name': r.get('name'), 'address': r.get('formatted_address') or '', 'types': r.get('types') or [],
                'business_status': r.get('business_status'), 'lat': loc.get('lat'), 'lng': loc.get('lng')}

    def details_many(self, places):
        return list(self.details_pool.map(self.details_full, places))

    def search(self, rec, scope):
        self.calls.add('agent_tools')
        return at.search_text(self.mkey, rec['name'], rec['area_hint'], scope.get('area') or '', scope.get('geo'))

    def select_one(self, rec, search_result):
        """店舗単位の選択 LLM（1 店舗・最大 5 候補）。returns 候補の添字 or None"""
        self.calls.add('selection_llm_store')
        sel = LlmGroundedSelector(self.gkey)
        recs = [{'rank': rec['rank'], 'recommended_name': rec['name'], 'recommended_area': rec['area_hint'],
                 'maps_summary': search_result.get('summary') or '',
                 'maps_places': [{'candidate_id': i + 1, 'citation': i} for i in range(len(search_result['places']))]}]
        try:
            out, _ms, _s = sel.select(recs)
        finally:
            self.add_usage('selection', sel.last_usage)
        cid = out[rec['rank']][0]
        return None if cid is None else cid - 1

    def post_json(self, kind, body, timeout=40):
        """推薦B（非ストリーミング）。returns (text, ms, error)"""
        self.calls.add(kind)
        t = time.monotonic()
        try:
            r = requests.post(c.INTERACTIONS_URL, json=body, headers=self.headers(), timeout=timeout)
        except requests.exceptions.RequestException as e:
            return None, int((time.monotonic() - t) * 1000), f'network:{type(e).__name__}'
        ms = int((time.monotonic() - t) * 1000)
        if r.status_code != 200:
            return None, ms, f'{_classify_http(r.status_code)}:{r.status_code}'
        data = r.json()
        self.add_usage(kind, data.get('usage'))
        if data.get('status') != 'completed':
            return None, ms, f'not_completed:{data.get("status")}'
        return extract_text(data), ms, None


# ------------------------------------------------------------------ 推薦A（ストリーミング）
def stream_a(apis, q, n, on_store, t0):
    """推薦A をストリーミングで受け、店名が確定した店舗から on_store(rec) を呼ぶ（推薦完了を待たない）"""
    apis.calls.add('recommend_a')
    tr, sse = CandidateStreamTracker(required_str=('name', 'area_hint')), SseReader()
    m = {'first_event_ms': None, 'first_text_ms': None, 'completed_ms': None, 'end_ms': None, 'error': None,
         'usage': {}, 'early': [], 'full': [], 'duplicates': 0, 'odd': []}
    dispatched, seen, step_types = set(), set(), {}
    ms = lambda: int((time.monotonic() - t0) * 1000)  # noqa: E731

    def dispatch_new():
        for cd in tr.candidates:
            if cd['early_t'] is not None and cd['index'] not in dispatched:
                dispatched.add(cd['index'])
                f = cd['fields']
                key = ''.join(f['name'].split())
                if key in seen:
                    m['duplicates'] += 1
                    continue
                seen.add(key)
                flags = m3.odd_name_flags(f['name'])
                if flags:
                    m['odd'].append((f['name'], flags))
                on_store({'rank': cd['index'], 'name': f['name'].strip(), 'area_hint': (f.get('area_hint') or '').strip(),
                          't_name': cd['early_t']})

    try:
        r = requests.post(c.INTERACTIONS_URL, json=m3.a_body(q, n), headers=dict(apis.headers(), Accept='text/event-stream'),
                          timeout=(10, 60), stream=True)
    except requests.exceptions.RequestException as e:
        m['error'] = f'network:{type(e).__name__}'
        return m, tr
    if r.status_code != 200:
        m['error'] = f'http_{r.status_code}'
        return m, tr
    try:
        for chunk in r.iter_content(chunk_size=None):
            if not chunk:
                continue
            for name, data in sse.feed(chunk):
                t = ms()
                if m['first_event_ms'] is None:
                    m['first_event_ms'] = t
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
                        if m['first_text_ms'] is None:
                            m['first_text_ms'] = t
                        tr.feed(d.get('text') or '', t)
                        dispatch_new()
                elif et == 'interaction.completed':
                    m['completed_ms'] = t
                    m['usage'] = (ev.get('interaction') or {}).get('usage') or {}
                elif et == 'error':
                    m['error'] = f'stream_error:{(ev.get("error") or {}).get("code")}'
    except requests.exceptions.RequestException as e:
        m['error'] = m['error'] or f'stream_cut:{type(e).__name__}'
    m['end_ms'] = ms()
    m['early'] = [cd['early_t'] for cd in tr.candidates]
    m['full'] = [cd['full_t'] for cd in tr.candidates]
    apis.add_usage(f'recommend_a{n}', m['usage'])
    return m, tr


# ------------------------------------------------------------------ 方式
def run_s(apis, q, n):
    t0 = time.monotonic()
    ms = lambda: int((time.monotonic() - t0) * 1000)  # noqa: E731
    scope_f = apis.misc_pool.submit(apis.scope_for, q)
    futures, stores_in = [], []

    class Deps:
        search = staticmethod(lambda rec: apis.search(rec, scope_f.result()))
        details_many = staticmethod(apis.details_many)
        select = staticmethod(apis.select_one)
        judge = staticmethod(m3.judge_with_scope)

    def task(rec):
        scope = scope_f.result()
        res = m3.match_store(rec, scope, Deps, t0=t0)
        res['t_name'] = rec['t_name']
        return res

    def on_store(rec):
        stores_in.append(rec)
        futures.append(apis.store_pool.submit(task, rec))

    am, tr = stream_a(apis, q, n, on_store, t0)
    a_err, a_list = am['error'], None
    try:
        a_list = m3.validate_a(tr.text(), n)
    except c.RecommendationError as e:
        a_err = a_err or e.error_type
    # 推薦B: 推薦A の全店舗（重複除外後）について説明文を生成（推薦A 完了後すぐ開始。照合と並行）
    b_res = {'t_start': ms(), 't_done': None, 'error': None, 'items': {}}
    b_stores = [s for s in stores_in]

    def run_b():
        if not b_stores:
            b_res['error'] = 'no_stores'
            return
        text, _bms, err = apis.post_json('recommend_b', m3.b_body(q, b_stores))
        b_res['t_done'] = ms()
        if err:
            b_res['error'] = err
            return
        try:
            b_res['items'] = m3.validate_b(text, b_stores)
        except c.RecommendationError as e:
            b_res['error'] = e.error_type

    b_f = apis.misc_pool.submit(run_b)
    done, not_done = wait(futures, timeout=STORE_WAIT_SEC)
    stores = []
    for f in futures:
        if f in done:
            try:
                stores.append(f.result())
            except Exception as e:
                stores.append({'rank': None, 'path': f'exception:{type(e).__name__}', 't_done': None})
    b_f.result(timeout=60)
    scope = scope_f.result()
    return {'method': f'S{n}', 'a': am, 'a_err': a_err, 'a_list': a_list, 'stores': stores, 'b': b_res, 'scope': scope,
            'unfinished': len(not_done)}


def run_d(apis, q):
    """方式 D（現行一括推薦 → Agent Tools 7 並列 → 選択 LLM 一括 → Details）"""
    t0 = time.monotonic()
    ms = lambda: int((time.monotonic() - t0) * 1000)  # noqa: E731
    scope_f = apis.misc_pool.submit(apis.scope_for, q)
    apis.calls.add('recommend_d')
    try:
        llm = RecommendationClient(apis.gkey).recommend(q)
    except c.RecommendationError as e:
        return {'method': 'D', 'error': e.error_type, 'stores': [], 't_rec': ms()}
    apis.add_usage('recommend_d', llm.usage)
    t_rec = ms()
    scope = scope_f.result()
    recs = [{'rank': cd.rank, 'name': cd.name, 'area_hint': cd.area_hint} for cd in llm.candidates]
    res = list(apis.store_pool.map(lambda r: apis.search(r, scope), recs))
    t_at = ms()
    nid, sel_in, idmap = 1, [], {}
    for r, s in zip(recs, res):
        e = {'rank': r['rank'], 'recommended_name': r['name'], 'recommended_area': r['area_hint'],
             'maps_summary': s.get('summary') or '', 'maps_places': []}
        for i, pl in enumerate(s.get('places') or []):
            e['maps_places'].append({'candidate_id': nid, 'citation': i})
            idmap[nid] = (r['rank'], i)
            nid += 1
        if e['maps_places']:
            sel_in.append(e)
    picks, sel_err, t_sel = {}, None, None
    if sel_in:
        apis.calls.add('selection_llm_batch')
        sel = LlmGroundedSelector(apis.gkey)
        try:
            out, _m, _s = sel.select(sel_in)
            picks = {rank: idmap[cid][1] for rank, (cid, _r) in out.items() if cid is not None}
        except SelectionError as e:
            sel_err = e.error_type
        apis.add_usage('selection', sel.last_usage)
        t_sel = ms()
    chosen = [(r, res[i]['places'][picks[r['rank']]]) for i, r in enumerate(recs) if r['rank'] in picks]
    dets = list(apis.details_pool.map(lambda x: apis.details_full(x[1]), chosen))
    t_done = ms()
    stores = []
    det_by_rank = {r['rank']: (pl, d) for (r, pl), d in zip(chosen, dets)}
    for r, s in zip(recs, res):
        st = {'rank': r['rank'], 'rec': r['name'], 'hint': r['area_hint'], 'n_cand': len(s.get('places') or []),
              'top1': (s.get('places') or [{}])[0].get('place_id') if s.get('places') else None,
              'place_id': None, 'place': None, 'path': None, 'pos': None, 't_done': t_done}
        if r['rank'] in det_by_rank:
            pl, d = det_by_rank[r['rank']]
            # D の採用規則（D1.7 と同じ: 閉店・国コード不一致は不採用）
            if d.get('error') or (d.get('business_status') and d['business_status'] != 'OPERATIONAL'):
                st['path'] = 'details_reject'
            else:
                st.update(place_id=pl['place_id'], place=d, path='llm', pos=picks[r['rank']] + 1)
        else:
            st['path'] = 'no_candidates' if not s.get('places') else ('selection_error' if sel_err else 'llm_none')
        stores.append(st)
    return {'method': 'D', 'stores': stores, 't_rec': t_rec, 't_at': t_at, 't_sel': t_sel, 'sel_err': sel_err,
            'scope': scope, 'recs': recs, 'rec_reasons': {cd.rank: (cd.specialty, cd.reason) for cd in llm.candidates}}


def parse_33_json(text):
    """33秒版本番と同じ JSON 抽出（最初の { から対応する } まで）"""
    t = (text or '').strip()
    start = t.find('{')
    if start < 0:
        return None
    depth = 0
    for i in range(start, len(t)):
        if t[i] == '{':
            depth += 1
        elif t[i] == '}':
            depth -= 1
            if depth == 0:
                try:
                    return json.loads(t[start:i + 1])
                except ValueError:
                    return None
    return None


def run_33(apis, q):
    """元の 33秒版本番の推薦（品質の基準）。gemini-2.5-flash + Google 検索 → 33秒版 Places 照合"""
    t0 = time.monotonic()
    ms = lambda: int((time.monotonic() - t0) * 1000)  # noqa: E731
    prompt = open(os.path.join(HERE, 'm3_33s_search_only_prompt.txt'), encoding='utf-8').read()
    body = {'systemInstruction': {'parts': [{'text': prompt}]},
            'contents': [{'role': 'user', 'parts': [{'text': f'検索条件: {q}'}]}],
            'tools': [{'google_search': {}}]}
    apis.calls.add('recommend_33')
    try:
        r = requests.post(GENERATE_33_URL, json=body, headers={'Content-Type': 'application/json', 'x-goog-api-key': apis.gkey},
                          timeout=90)
    except requests.exceptions.RequestException as e:
        return {'method': '33', 'error': f'network:{type(e).__name__}', 'stores': []}
    t_rec = ms()
    if r.status_code != 200:
        return {'method': '33', 'error': redact(f'http_{r.status_code}:{(r.text or "")[:160]}'), 'stores': [], 't_rec': t_rec}
    data = r.json()
    apis.add_usage('recommend_33', data.get('usageMetadata'))
    text = ''.join(p.get('text', '') for cd in (data.get('candidates') or [])[:1]
                   for p in ((cd.get('content') or {}).get('parts') or []))
    obj = parse_33_json(text) or {}
    shops = obj.get('shops') or []
    area = legacy_places.resolve_area(q, 'ja')
    geo = legacy_places.region_info(area, 'ja')
    found = list(apis.store_pool.map(lambda s: legacy_places.lookup(s.get('name', ''), s.get('area', ''), area, geo, 'ja'),
                                     shops))
    apis.calls.add('legacy_places_33', len(shops))
    t_done = ms()
    stores = []
    for i, (s, pdat) in enumerate(zip(shops, found), 1):
        stores.append({'rank': i, 'rec': s.get('name', ''), 'hint': s.get('area', ''), 'path': 'legacy_places',
                       'place_id': (pdat or {}).get('place_id'),
                       'place': {'name': (pdat or {}).get('name'), 'address': (pdat or {}).get('formatted_address') or ''}
                       if pdat else None, 't_done': t_done,
                       'description': s.get('description', ''), 'specialty': s.get('specialty', '')})
    return {'method': '33', 'stores': stores, 't_rec': t_rec, 'n_shops': len(shops), 'parse_ok': bool(obj)}


# ------------------------------------------------------------------ 出力
def place_line(s, scope=None):
    d = s.get('place') or {}
    dist = ''
    if scope and scope.get('center') and d.get('lat') is not None:
        dist = f' {m3.haversine_km(scope["center"], (d["lat"], d["lng"])):.1f}km'
    return f'「{d.get("name") or "-"}」{(d.get("address") or "")[:40]}{dist}'


def print_trial(i, q, res):
    say(f'\n({i}) [{q}]')
    for key in ('33', 'D', 'S7', 'S10'):
        r = res.get(key)
        if not r:
            continue
        if r.get('error'):
            say(f'  [{key}] エラー: {r["error"]}')
            continue
        a10 = m3.adopt(r['stores'], DEADLINE_MS)
        aall = m3.adopt(r['stores'])
        head = f'  [{key}] 初回カード={a10["t_first"]} 5件確定={a10["t_set"] if len(a10["cards"]) == 5 else "未達"} ' \
               f'カード(10秒)={len(a10["cards"])} カード(全)={len(aall["cards"])}'
        if key.startswith('S'):
            a = r['a']
            ear = a['early']
            pick = lambda k: ear[k - 1] if len(ear) >= k else None  # noqa: E731
            head += (f' | 推薦A 1件目={pick(1)} 5件目={pick(5)} 7件目={pick(7)} 10件目={pick(10)} 完了={a["completed_ms"]}'
                     f' 件数={len(ear)} 重複={a["duplicates"]} A検証={r["a_err"] or "OK"}'
                     f' | 推薦B 完了={r["b"]["t_done"]} B検証={r["b"]["error"] or "OK"}'
                     f' | 範囲={r["scope"].get("radius_km") and round(r["scope"]["radius_km"], 1)}km({r["scope"].get("radius_reason")})')
            if a['odd']:
                head += f' 不自然な店名={[x[0] for x in a["odd"]]}'
        elif key == 'D':
            head += f' | 推薦={r["t_rec"]} AgentTools={r["t_at"]} 選択LLM={r["t_sel"]}'
        else:
            head += f' | 推薦(Google検索)={r.get("t_rec")} 店舗数={r.get("n_shops")}'
        say(head)
        for s in sorted([x for x in r['stores'] if x.get('rank') is not None], key=lambda x: x['rank']):
            say(f'    {s["rank"]}. 「{s["rec"]}」 → {s.get("path")}{"@" + str(s["pos"]) if s.get("pos") else ""} '
                f'{place_line(s, r.get("scope")) if s.get("place_id") else ""} t={s.get("t_done")}'
                + (f' 選択LLM={s["sel_ms"]}ms' if s.get('sel_ms') is not None else '')
                + (f' 選択エラー={s["sel_err"]}' if s.get('sel_err') else ''))


def print_quality_sample(t):
    """品質比較用（各クエリの 1 回目のみ）: 33秒版・D・S7・S10 の上位 3 店の説明（推薦 LLM の出力。80 文字で省略）"""
    say('  ── 説明文の比較（上位 3 店）')
    r = t.get('33')
    if r and not r.get('error'):
        for s in r['stores'][:3]:
            say(f'    33  {s["rank"]}. {s["rec"]}: {(s.get("description") or "")[:80]}')
    r = t.get('D')
    if r and not r.get('error'):
        for rk in sorted(r['rec_reasons'])[:3]:
            sp, rs = r['rec_reasons'][rk]
            say(f'    D   {rk}. {next(x["name"] for x in r["recs"] if x["rank"] == rk)}: [{sp[:20]}] {rs[:70]}')
    for key in ('S7', 'S10'):
        r = t.get(key)
        if r and not r.get('error'):
            names = {s['rank']: s['name'] for s in (r['a_list'] or [])}
            for rk in sorted(r['b']['items'])[:3]:
                sp, rs = r['b']['items'][rk]
                say(f'    {key:<3} {rk}. {names.get(rk, "?")}: [{sp[:20]}] {rs[:70]}')


def summarize(results, apis):
    say('\n================ M3 集計（正誤なし。正誤は独立判定ラベルで gate_m3_score が集計） ================')
    for key in ('33', 'D', 'S7', 'S10'):
        rs = [t[key] for t in results if t.get(key) and not t[key].get('error')]
        if not rs:
            continue
        a10 = [m3.adopt(r['stores'], DEADLINE_MS) for r in rs]
        first = [a['t_first'] for a in a10]
        t5 = [a['t_set'] for a in a10 if len(a['cards']) == 5]
        say(f'[{key}] 試行 {len(rs)}  初回カード p50 {m3.p(first, 50)} / p95 {m3.p(first, 95)} / 最大 '
            f'{max([x for x in first if x is not None], default=None)} ms  初回≤5秒 {sum(1 for x in first if x is not None and x <= FIRST_MS)}/{len(rs)}'
            f'  10秒で5件 {len(t5)}/{len(rs)}  5件確定 p50 {m3.p(t5, 50)} / p95 {m3.p(t5, 95)} ms')
        if key.startswith('S'):
            ea = [r['a']['early'] for r in rs]
            for k in (1, 5, 7, 10):
                v = [e[k - 1] if len(e) >= k else None for e in ea]
                if any(x is not None for x in v):
                    say(f'    推薦A {k}件目: p50 {m3.p(v, 50)} / p95 {m3.p(v, 95)} / 最大 {max([x for x in v if x is not None])} ms')
            say(f'    推薦A 完了: p50 {m3.p([r["a"]["completed_ms"] for r in rs], 50)} ms  A検証エラー '
                f'{sum(1 for r in rs if r["a_err"])}  重複 {sum(r["a"]["duplicates"] for r in rs)}  '
                f'不自然な店名 {sum(len(r["a"]["odd"]) for r in rs)}')
            paths = {}
            for r in rs:
                for s in r['stores']:
                    k = (s.get('path') or '').split(':')[0]
                    paths[k] = paths.get(k, 0) + 1
            say(f'    店舗単位の結果: {paths}')
            sel = [s['sel_ms'] for r in rs for s in r['stores'] if s.get('sel_ms') is not None]
            serr = [s['sel_err'] for r in rs for s in r['stores'] if s.get('sel_err')]
            say(f'    店舗単位の選択LLM: {len(sel)} 回  p50 {m3.p(sel, 50)} / p95 {m3.p(sel, 95)} / 最大 {max(sel, default=None)} ms  エラー {serr or "なし"}')
            bt = [r['b']['t_done'] for r in rs]
            ok10 = sum(1 for r in rs if r['b']['t_done'] is not None and r['b']['t_done'] <= DEADLINE_MS and not r['b']['error'])
            say(f'    推薦B 完了: p50 {m3.p(bt, 50)} / p95 {m3.p(bt, 95)} ms  10秒以内に完成 {ok10}/{len(rs)}  '
                f'エラー {[r["b"]["error"] for r in rs if r["b"]["error"]] or "なし"}')
            un = sum(r['unfinished'] for r in rs)
            if un:
                say(f'    {STORE_WAIT_SEC}秒以内に終わらなかった店舗: {un}')
    say(f'\n呼び出し数: {apis.calls.d}')
    say(f'Gemini トークン: {apis.tokens.d}')
    n = len(results)
    at_calls = apis.calls.d.get('agent_tools', 0)
    say(f'Agent Tools 概算: {at_calls} 件 × $7/1,000 ≈ ${at_calls * 0.007:.2f}（{n} 試行・全方式合計、無料枠適用前）')


def review_list(results):
    """独立判定用の一覧（推薦店 × 採用 place、および S の不採用店舗の検索 1 位）。place_id 付き"""
    rows = {}
    for t in results:
        for key in ('33', 'D', 'S7', 'S10'):
            r = t.get(key)
            if not r or r.get('error'):
                continue
            for s in r['stores']:
                if s.get('place_id'):
                    k = (s['rec'], s['place_id'])
                    v = rows.setdefault(k, {'place': s.get('place') or {}, 'by': set(), 'trials': set(), 'kind': 'adopted',
                                            'verdict': None, 'scope': r.get('scope')})
                    v['by'].add(key)
                    v['trials'].add(t['trial'])
                    v['kind'] = 'adopted'
                elif key.startswith('S') and s.get('top1') and s.get('top1_place'):
                    k = (s['rec'], s['top1'])     # 不採用だった店舗の検索 1 位（取りこぼしの判定用）
                    v = rows.setdefault(k, {'place': s['top1_place'], 'by': set(), 'trials': set(), 'kind': 'top1',
                                            'verdict': (s.get('verdicts') or [None])[0], 'scope': r.get('scope')})
                    v['by'].add(key + '不採用')
                    v['trials'].add(t['trial'])
    say('\n【独立判定リスト（推薦店 × 採用 place、S で不採用だった店舗の検索 1 位）】ラベル: 推薦店名<TAB>place_id<TAB>O/X/?')
    for i, ((rec, pid), v) in enumerate(sorted(rows.items(), key=lambda kv: min(kv[1]['trials'])), 1):
        d = v['place']
        say(f'  P{i:03d} 「{rec}」 → 「{d.get("name")}」 {(d.get("address") or "")[:50]} types={",".join((d.get("types") or [])[:3])} '
            f'{d.get("business_status") or ""} 採用={",".join(sorted(v["by"], key=str))} 試行={",".join(map(str, sorted(v["trials"])))} '
            + (f'判定={v["verdict"]} ' if v['kind'] == 'top1' else '') + f'place_id={pid}')
    return rows


def strip_for_save(results):
    """保存用: Places の内容（店名・住所・座標など）を除き、place ID と LLM 出力・時刻・判定だけ残す"""
    out = []
    for t in results:
        tt = {'trial': t['trial'], 'q': t['q']}
        for key in ('33', 'D', 'S7', 'S10'):
            r = t.get(key)
            if not r:
                continue
            if r.get('error'):
                tt[key] = {'error': r['error']}
                continue
            stores = [{k: s.get(k) for k in ('rank', 'rec', 'hint', 'path', 'pos', 'place_id', 'top1', 't_name', 't_done',
                                              'sel_ms', 'sel_err', 'verdicts', 'n_cand')} for s in r['stores']]
            e = {'stores': stores}
            if key.startswith('S'):
                e['a'] = {k: r['a'][k] for k in ('early', 'full', 'first_text_ms', 'completed_ms', 'duplicates', 'error')}
                e['a_err'] = r['a_err']
                e['a_list'] = r['a_list']
                e['b'] = {'t_done': r['b']['t_done'], 'error': r['b']['error'],
                          'items': {str(k): v for k, v in r['b']['items'].items()}}
                e['scope'] = {k: r['scope'].get(k) for k in ('area', 'radius_km', 'radius_reason', 'prefecture')}
            elif key == 'D':
                e['rec_reasons'] = {str(k): v for k, v in r['rec_reasons'].items()}
            else:
                e['descriptions'] = {str(s['rank']): s.get('description') for s in r['stores']}
            tt[key] = e
        out.append(tt)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--repeat', type=int, default=1)
    ap.add_argument('--no-33', action='store_true')
    args = ap.parse_args()
    gkey = os.environ.get('GEMINI_RECOMMEND_API_KEY', '')
    mkey = os.environ.get('MAPS_AGENT_TOOLS_API_KEY', '')
    if not gkey or not mkey:
        sys.exit('GEMINI_RECOMMEND_API_KEY と MAPS_AGENT_TOOLS_API_KEY が必要です')
    for k in (gkey, mkey, os.environ.get('GOOGLE_PLACES_API_KEY', '')):
        register_secret(k)
    apis = Apis(gkey, mkey)
    say(f'git_sha={os.environ.get("GIT_SHA", "unknown")}  推薦/説明/選択={c.MODEL_ID} thinking={c.THINKING_LEVEL}  '
        f'軽量判定=v0.2 固定（light_identity）  締め切り {DEADLINE_MS}ms / 初回 {FIRST_MS}ms  方式={"D,S7,S10" if args.no_33 else "33,D,S7,S10"}')
    results = []
    path = os.path.expanduser(os.environ.get('M3_RESULTS', '~/m3_results.json'))
    plan = [q for _ in range(args.repeat) for q in QUERIES]
    for i, q in enumerate(plan, 1):
        t = {'trial': i, 'q': q}
        if not args.no_33:
            t['33'] = run_33(apis, q)
            time.sleep(1)
        t['D'] = run_d(apis, q)
        time.sleep(1)
        t['S7'] = run_s(apis, q, 7)
        time.sleep(1)
        t['S10'] = run_s(apis, q, 10)
        results.append(t)
        print_trial(i, q, t)
        if i <= len(QUERIES):
            print_quality_sample(t)
        with open(path, 'w', encoding='utf-8') as f:          # 試行ごとに保存（途中で切断されても残す）
            json.dump(strip_for_save(results), f, ensure_ascii=False)
        time.sleep(1)
    summarize(results, apis)
    review_list(results)
    say(f'\n結果ファイル: {path}（LLM 出力・place ID・時刻・判定のみ。Places の内容は含めない）')
    say(f'出力への API キー残存: {"あり（要確認）" if contains_secret(chr(10).join(OUT)) else "なし"}')
    for pool in (apis.details_pool, apis.store_pool, apis.misc_pool):
        pool.shutdown(wait=False, cancel_futures=True)


if __name__ == '__main__':
    main()
