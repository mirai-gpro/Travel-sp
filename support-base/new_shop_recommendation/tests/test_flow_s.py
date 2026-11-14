# -*- coding: utf-8 -*-
"""M4 T2: S10 フローの結合テスト（偽の API。時刻は 1/50 に縮めて実スレッドで動かす。外部 API なし）"""
import json
import logging
import os
import sys
import threading
import time

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from new_shop_recommendation import contracts as c  # noqa: E402
from new_shop_recommendation import flow_s as F  # noqa: E402

SCALE = 1 / 50.0          # M3 の時刻（ms）→ テストの実時間（秒）は ms/1000*SCALE


def sl(ms):
    time.sleep(ms / 1000.0 * SCALE)


class FakeApis:
    """
    stores: [{'name','area','t_name'(店名が出る ms),'match'(照合の所要 ms),'kind': 'same'|'llm'|'none'|'branch'|'closed',
              'pid'}]
    """

    def __init__(self, stores, b_delay_ms=4000, b_per_item_ms=900, a_error=None):
        self.stores, self.b_delay, self.b_per, self.a_error = stores, b_delay_ms, b_per_item_ms, a_error
        self.by_name = {s['name']: s for s in stores}
        self.calls = {'search': 0, 'details': 0, 'select': 0, 'a': 0, 'b': 0}
        self.lock = threading.Lock()

    def _n(self, k):
        with self.lock:
            self.calls[k] += 1

    def geocode(self, text):
        if text != '横浜':
            return None
        return {'lat': 35.444, 'lng': 139.638, 'viewport': {'northeast': {'lat': 35.47, 'lng': 139.66},
                                                           'southwest': {'lat': 35.42, 'lng': 139.61}},
                'prefecture': '神奈川県', 'country_code': 'JP', 'types': ['locality', 'political'],
                'component_names': ['横浜市', '神奈川県']}

    def search(self, rec, scope):
        self._n('search')
        s = self.by_name[rec['name']]
        sl(s['match'] * 0.5)
        if s['kind'] == 'none':
            return {'status': 'ZERO_RESULTS', 'summary': '', 'places': []}
        return {'status': 'OK', 'summary': 'SUMMARY-TEXT', 'places': [
            {'place_id': s['pid'], 'place_url': f'https://maps.google.com/?cid={s["pid"]}',
             'attribution': {'title': 'Google Maps', 'url': 'https://maps.google.com'}}]}

    def details(self, place):
        self._n('details')
        s = next(x for x in self.stores if x.get('pid') == place['place_id'])
        sl(s['match'] * 0.5)
        name = {'same': s['name'], 'llm': s['name'] + ' 別表記', 'branch': '串かつ松葉 ルクア大阪店',
                'closed': s['name']}[s['kind']]
        return {'place_id': s['pid'], 'name': name, 'address': '日本、神奈川県横浜市中区1-1', 'formatted_address': '神奈川県横浜市中区1-1',
                'types': ['restaurant', 'food'], 'business_status': 'CLOSED_PERMANENTLY' if s['kind'] == 'closed' else 'OPERATIONAL',
                'lat': 35.444, 'lng': 139.638, 'rating': 4.0, 'user_ratings_total': 10, 'country_code': 'JP', 'phone': None,
                'maps_url': place['place_url'], 'maps_attribution': place['attribution']}

    def select(self, rec, search_result):
        self._n('select')
        sl(2900)
        return 0

    def stream(self, body, on_text, should_stop):
        if '各店の名称と駅・地区だけ' in body['input']:
            self._n('a')
            if self.a_error:
                return self.a_error
            on_text('{"freshness_intent": "not_needed", "candidates": [')
            t = 0
            for i, s in enumerate(self.stores, 1):
                sl(max(0, s['t_name'] - t))
                t = s['t_name']
                if should_stop():
                    return None
                on_text(('' if i == 1 else ', ') + json.dumps({'rank': i, 'name': s['name'], 'area_hint': s['area']},
                                                               ensure_ascii=False))
            on_text(']}')
            return None
        self._n('b')
        lst = json.loads(body['input'].split('【推薦店舗】\n', 1)[1])
        sl(self.b_delay)
        on_text('{"candidates": [')
        for i, it in enumerate(lst):
            sl(self.b_per)
            on_text(('' if i == 0 else ', ') + json.dumps({'rank': it['rank'], 'name': it['name'], 'specialty': f'特徴{it["rank"]}',
                                                           'reason': f'理由{it["rank"]}'}, ensure_ascii=False))
        on_text(']}')
        return None


def store(i, kind='same', t_name=None, match=1200):
    return {'name': f'焼鳥 店{i}', 'area': '関内', 't_name': t_name if t_name is not None else 2500 + 280 * (i - 1),
            'match': match, 'kind': kind, 'pid': f'P{i}'}


class Rec:
    def __init__(self):
        self.ev, self.lock = [], threading.Lock()

    def __call__(self, name, payload):
        with self.lock:
            self.ev.append((name, json.loads(json.dumps(payload, ensure_ascii=False))))

    def stage(self, st):
        return [p for n, p in self.ev if n == F.STAGE_EVENT and p['stage'] == st]

    def details(self):
        return [p for n, p in self.ev if n == F.DETAIL_EVENT]


def run(stores, deadline=10.0, **kw):
    apis = FakeApis(stores, **kw)
    flow = F.FlowS(apis, deadline_sec=deadline * SCALE)
    rec = Rec()
    res = flow.run('横浜で美味しい焼き鳥屋を5軒', emit=rec, request_id='RID')
    return res, rec, apis, flow


def test_two_stage_preview_then_rank_ordered_final_and_details_after():
    stores = [store(1, match=4800)] + [store(i) for i in range(2, 11)]       # 1 位だけ照合が遅い（M3 試行 6 型）
    res, rec, apis, flow = run(stores)
    pv, fin = rec.stage('preview'), rec.stage('final')
    assert len(pv) == 1 and len(fin) == 1
    assert pv[0]['cards'][0]['stage'] == 'preview' and pv[0]['cards'][0]['place_id'] == 'P2'   # 先に判定された 2 位
    assert [cd['place_id'] for cd in fin[0]['cards']] == ['P1', 'P2', 'P3', 'P4', 'P5']        # 推薦順位どおり
    assert fin[0]['status'] == c.COMPLETE and fin[0]['shortfall'] == 0 and fin[0]['reason'] == 'top5_decided'
    assert pv[0]['t_ms'] <= fin[0]['t_ms']
    assert all(cd['maps_attribution'] and cd['maps_url'] for cd in fin[0]['cards'] + pv[0]['cards'])   # 出典
    assert all(cd['detail_pending'] for cd in fin[0]['cards'])                                 # 説明は後から
    assert res['narration'] == [{'number': i, 'name': f'焼鳥 店{i}', 'area': '関内'} for i in range(1, 6)]   # 方式 D
    assert res['narration_mode'] == 'D' and res['status'] == c.COMPLETE
    flow.last_a_thread.join(5)
    det = rec.details()
    assert sorted(d['place_id'] for d in det) == ['P1', 'P2', 'P3', 'P4', 'P5']               # 最終カードの説明だけ
    assert all(d['reason'] == f'理由{d["recommend_rank"]}' for d in det)


def test_deadline_sends_confirmed_only_and_reports_shortfall():
    stores = [store(1, match=20000), store(2), store(3, 'none'), store(4, 'none'), store(5), store(6, 'none')]
    res, rec, apis, flow = run(stores)
    fin = rec.stage('final')[0]
    assert fin['reason'] == 'deadline' and [cd['place_id'] for cd in fin['cards']] == ['P2', 'P5']
    assert fin['shortfall'] == 3 and res['status'] == c.PARTIAL and res['shortfall'] == 3        # 不足を隠さない
    assert 9000 <= fin['t_ms'] / SCALE <= 11500


def test_all_decided_before_deadline_with_fewer_than_five():
    stores = [store(1), store(2, 'none'), store(3, 'closed'), store(4)]
    res, rec, apis, flow = run(stores)
    fin = rec.stage('final')[0]
    assert fin['reason'] == 'all_decided' and [cd['place_id'] for cd in fin['cards']] == ['P1', 'P4']
    assert fin['t_ms'] / SCALE < 9000


def test_llm_path_and_r2_branch_conflict_rejected():
    stores = [store(1, 'llm'), {**store(2, 'branch'), 'name': '松葉地下店'}] + [store(i) for i in range(3, 8)]
    res, rec, apis, flow = run(stores)
    m = res['metrics']['stores']
    assert m[1]['path'] == 'llm' and m[2]['path'] == 'llm_pick_rejected:branch_conflict'
    assert [cd['place_id'] for cd in rec.stage('final')[0]['cards']] == ['P1', 'P3', 'P4', 'P5', 'P6']


def test_a_error_returns_error_without_cards():
    res, rec, apis, flow = run([store(1)], a_error='http_401')
    assert res['status'] == c.ERROR and res['cards'] == [] and res['narration'] == [] and rec.ev == []


def test_logs_have_no_maps_content(caplog):
    caplog.set_level(logging.INFO, logger='new_shop_recommendation.flow_s')
    res, rec, apis, flow = run([store(i) for i in range(1, 7)])
    flow.last_a_thread.join(5)
    text = '\n'.join(r.getMessage() for r in caplog.records)
    assert '[NewShopRec][S10]' in text and 'P1' in text
    assert '横浜市中区' not in text and 'SUMMARY-TEXT' not in text and '別表記' not in text


# ------------------------------------------------------------------ T1: 表示制御と M3 分析（gate_m3_analyze.two_stage）の一致
def _replay_display(stores, deadline_ms=10000):
    """確定時刻順に Display へ入力し、先行カード・最終カード・最終時刻を返す（締め切りは時刻で判定）"""
    d = F.Display(deadline_ms)
    for s in stores:
        d.on_name(s['rank'])
    d.on_a_done()
    pv = fin = t_fin = None
    for s in sorted(stores, key=lambda x: (x['t_done'], x['rank'])):
        if s['t_done'] > deadline_ms:
            break
        p, f = d.on_decided(s)
        pv = pv or p
        if f is not None:
            fin, t_fin = f, s['t_done']
            break
    if fin is None:
        fin, t_fin = d.on_deadline(), deadline_ms
    return pv, fin, t_fin


@pytest.mark.parametrize('seed', range(200))
def test_display_matches_m3_two_stage_analysis(seed):
    import random
    from new_shop_recommendation.poc import gate_m3_analyze as an
    rnd = random.Random(seed)
    stores = []
    for r in range(1, 11):
        pid = None if rnd.random() < 0.3 else f'p{rnd.randint(1, 12)}'
        stores.append({'rank': r, 'place_id': pid, 't_done': rnd.randint(2500, 11500)})
    pv, fin, t_fin = _replay_display(stores)
    ts = an.two_stage({'stores': stores})
    assert [s['place_id'] for s in fin] == [s['place_id'] for s in ts['final']]
    assert (pv['place_id'] if pv else None) == (ts['preview'][0]['place_id'] if ts['preview'] else None)
    if len(fin) == 5:
        assert t_fin == ts['t_final']


# ------------------------------------------------------------------ T4 比較試験用モジュール（プレビュー専用）
def test_bench_disabled_by_default_and_token(monkeypatch):
    from new_shop_recommendation import m4_bench as mb
    monkeypatch.delenv('NEW_SHOP_FLOW', raising=False)
    monkeypatch.setenv('M4_BENCH_TOKEN', 'tok-123')
    assert not mb.enabled()
    monkeypatch.setenv('NEW_SHOP_FLOW', 'S10')
    assert mb.enabled() and mb.token_ok('tok-123') and not mb.token_ok('tok-124') and not mb.token_ok(None)
    monkeypatch.delenv('M4_BENCH_TOKEN')
    assert not mb.enabled() and not mb.token_ok('')


def test_bench_run_s10_returns_ids_and_llm_text_only():
    from new_shop_recommendation import m4_bench as mb
    apis = FakeApis([store(i) for i in range(1, 8)], b_delay_ms=1000, b_per_item_ms=200)
    out = mb.run_s10('横浜で美味しい焼き鳥屋を5軒', F.FlowS(apis, deadline_sec=10 * SCALE))
    assert out['status'] == c.COMPLETE and [s['place_id'] for s in out['stores']] == ['P1', 'P2', 'P3', 'P4', 'P5']
    assert all(s['description'].startswith('理由') for s in out['stores'])
    dumped = json.dumps(out, ensure_ascii=False)
    assert '横浜市中区' not in dumped and 'SUMMARY-TEXT' not in dumped and '別表記' not in dumped
