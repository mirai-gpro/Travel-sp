# -*- coding: utf-8 -*-
"""Gate D1.7E 計測ランナーの計測処理（採用規則・除外理由・Place Details 共通化）のテスト（外部 API なし）"""
import os
import sys
import threading

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from new_shop_recommendation import contracts as c  # noqa: E402
from new_shop_recommendation.poc import gate_d1_7e_method_e as g  # noqa: E402


def P(pid):
    return {'place_id': pid, 'name': f'N_{pid}'}


# ------------------------------------------------------------------ 採用規則と除外理由
def test_adopt_with_reasons_order_duplicate_cap_and_pre_reasons():
    entries = [(1, P('a'), 'ok'), (2, None, 'closed'), (3, P('a'), 'ok'), (4, P('b'), 'ok'), (5, P('c'), 'ok'),
               (6, P('d'), 'ok'), (7, P('e'), 'ok'), (8, P('f'), 'ok'), (9, None, 'country_mismatch')]
    out = g.adopt_with_reasons(entries)
    assert {r: v['reason'] for r, v in out.items()} == {
        1: 'adopted', 2: 'closed', 3: 'duplicate', 4: 'adopted', 5: 'adopted', 6: 'adopted', 7: 'adopted',
        8: 'cap', 9: 'country_mismatch'}
    assert [r for r, v in out.items() if v['place']] == [1, 4, 5, 6, 7]       # 推薦順位のまま最大 5 件
    assert len(g.cards_of(out)) == c.DISPLAY_COUNT


def test_adopt_matches_legacy_rule():
    """理由付き版の採用結果は、33秒版の採用規則（旧 adopt と同じ: 順位順・重複後順位不採用・最大 5）と一致する"""
    seq = [P('a'), None, P('a'), P('b'), P('c'), None, P('d'), P('e'), P('f')]
    expected, seen = {}, set()
    for rank, d in enumerate(seq, 1):
        if d and d['place_id'] not in seen and len(expected) < 5:
            seen.add(d['place_id'])
            expected[rank] = d
    got = g.cards_of(g.adopt_with_reasons([(i, d, 'x') for i, d in enumerate(seq, 1)]))
    assert got == expected


def test_shared_detail_targets_dedup():
    t = g.shared_detail_targets({1: P('a'), 2: P('b')}, {1: P('a'), 2: P('x'), 3: P('b')})
    assert sorted(t) == ['a', 'b', 'x']


# ------------------------------------------------------------------ 1 試行の計測（D・E の Details 共通化）
class Cand:
    def __init__(self, rank, name):
        self.rank, self.name, self.area_hint, self.specialty, self.reason = rank, name, '', '', ''


class Rec:
    def recommend(self, q):
        return c.LlmOutput('not_needed', [Cand(i, f'S{i}') for i in range(1, 8)], 9000, 0, 'completed')


AT_PLACES = {           # rank → Agent Tools の候補（place_id 順）
    1: ['P1', 'X1'], 2: ['X2', 'P2'], 3: [], 4: ['P4'], 5: ['P1'], 6: ['P6'], 7: ['P7'],
}
D_CHOICE = {1: 'P1', 2: 'P2', 4: None, 5: 'P1', 6: 'P6', 7: 'P7'}   # D の選択（None=該当なし）
DETAILS = {'P1': 'ok', 'X1': 'ok', 'X2': 'ok', 'P2': 'ok', 'P4': 'closed', 'P6': 'country_mismatch', 'P7': 'ok'}


class Sel:
    def select(self, recs):
        out = {}
        for r in recs:
            want = D_CHOICE[r['rank']]
            cid = None
            for i, cd in enumerate(r['maps_places']):
                if want and AT_PLACES[r['rank']][i] == want:
                    cid = cd['candidate_id']
            out[r['rank']] = (cid, 'r')
        return out, 4800, 0


@pytest.fixture
def fakes(monkeypatch):
    calls = {'details': [], 'lock': threading.Lock()}
    monkeypatch.setattr(g.legacy_places, 'resolve_area', lambda q, l: '横浜')
    monkeypatch.setattr(g.legacy_places, 'region_info', lambda a, l: {'country_code': 'JP'})
    monkeypatch.setattr(g.legacy_places, 'search_place_candidates',
                        lambda name, hint, area, geo, lang: ([], 'ZERO_RESULTS') if name == 'S3'
                        else ([{'place_id': 'L' + name}], 'OK'))
    monkeypatch.setattr(g.legacy_places, 'fetch_selected_details',
                        lambda p, geo, lang: None if p['place_id'] == 'LS6' else {'place_id': p['place_id'], 'name': 'L'})

    def search_text(key, name, hint, area, geo):
        rank = int(name[1:])
        return {'status': 'OK' if AT_PLACES[rank] else 'ZERO_RESULTS', 'summary': 's',
                'places': [{'place_id': pid, 'place_url': 'u', 'attribution': {}} for pid in AT_PLACES[rank]]}

    def details(place, geo):
        with calls['lock']:
            calls['details'].append(place['place_id'])
        why = DETAILS[place['place_id']]
        return ({'place_id': place['place_id'], 'name': 'N_' + place['place_id']}, 'ok') if why == 'ok' else (None, why)
    monkeypatch.setattr(g.at, 'search_text', search_text)
    monkeypatch.setattr(g.at, 'details_for_card', details)
    return calls


def test_run_trial_shares_details_and_records_reasons(fakes):
    m, rows = g.run_trial(Rec(), Sel(), 'k', 'q')
    # 同じ place_id の Place Details は 1 回だけ（P1 は D・E・rank5 で共通）
    assert sorted(fakes['details']) == sorted({'P1', 'X2', 'P2', 'P4', 'P6', 'P7'})
    assert m['de_det_calls'] == 6 and m['de_det_shared'] == 4          # rank1・5・6・7 で D と E が同じ place
    by = {r['rank']: r for r in rows}
    assert [by[k]['D_reason'] for k in range(1, 8)] == [
        'adopted', 'adopted', 'no_candidates', 'selection_none', 'duplicate', 'country_mismatch', 'adopted']
    assert [by[k]['E_reason'] for k in range(1, 8)] == [
        'adopted', 'adopted', 'no_candidates', 'closed', 'duplicate', 'country_mismatch', 'adopted']
    assert [by[k]['A_reason'] for k in range(1, 8)] == [
        'adopted', 'adopted', 'no_candidates', 'adopted', 'adopted', 'country_mismatch', 'adopted']
    assert by[2]['D']['place_id'] == 'P2' and by[2]['E']['place_id'] == 'X2' and by[2]['d_pos'] == 2
    assert m['d_n'] == 3 and m['e_n'] == 3 and m['a_n'] == 5
    assert m['d_total'] == m['e_total'] + 4800                        # 差は選択 LLM の時間のみ（Details は共通）


def test_run_trial_selection_error_reason(fakes, monkeypatch):
    class Bad:
        def select(self, recs):
            raise g.SelectionError('selection_timeout', 'x')
    m, rows = g.run_trial(Rec(), Bad(), 'k', 'q')
    by = {r['rank']: r for r in rows}
    assert by[1]['D_reason'] == 'selection_error' and by[3]['D_reason'] == 'no_candidates'
    assert m['d_n'] == 0 and m['e_n'] == 3 and sorted(fakes['details']) == sorted({'P1', 'X2', 'P4', 'P6', 'P7'})
