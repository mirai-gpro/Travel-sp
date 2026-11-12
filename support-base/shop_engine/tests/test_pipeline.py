# -*- coding: utf-8 -*-
"""
パイプラインのテスト（外部 API なし）。
- ストリーミング: 1件目の候補が届いた時点で照合を始め、全文を待たない
- 照合は並列でも、カードは推薦順でしか確定しない（後から順位が変わらない）
- VERIFIED 以外はカードにしない。足りなければ次順位で補い、未検証で埋めない
- 503 / 0件 / 解析不能行の扱い、Freshness は required のときだけ
"""
import json
import os
import sys
import threading
import time
from types import SimpleNamespace

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from google.genai import types  # noqa: E402

from shop_engine import matching  # noqa: E402
from shop_engine.pipeline import EngineConfig, RecommendationRun  # noqa: E402
from shop_engine.recommender import LineParser  # noqa: E402

CENTER = (35.6441, 139.6990)


def plan_line(required=False, central=False, query=''):
    return json.dumps({'type': 'plan', 'area': '中目黒', 'genre': '焼き鳥', 'count': 5,
                       'freshness': {'required': required, 'central': central, 'reason': 'r', 'query': query}},
                      ensure_ascii=False)


def cand_line(rank, name, variants=()):
    return json.dumps({'type': 'candidate', 'rank': rank, 'name': name, 'name_variants': list(variants),
                       'area': '中目黒', 'category': '焼き鳥', 'reason': f'{name}の理由', 'specialty': 'つくね',
                       'price_range': '5,000円'}, ensure_ascii=False)


class FakeModels:
    """行を chunk_delay 秒ごとに少しずつ返すストリーム。chunk は行の途中で切れる"""

    def __init__(self, lines, chunk_delay=0.05, exc=None, exc_after=None, grounded_text='最新メモ'):
        self.text = '\n'.join(lines) + '\n'
        self.chunk_delay = chunk_delay
        self.exc = exc
        self.exc_after = exc_after
        self.grounded_text = grounded_text
        self.stream_calls = []
        self.grounded_calls = []

    def generate_content_stream(self, model=None, contents=None, config=None):
        self.stream_calls.append(SimpleNamespace(model=model, config=config, contents=contents))
        if self.exc and self.exc_after is None:
            raise self.exc
        step = 37  # 行の途中で切る

        def gen():
            sent = 0
            for i in range(0, len(self.text), step):
                time.sleep(self.chunk_delay)
                if self.exc and self.exc_after is not None and sent >= self.exc_after:
                    raise self.exc
                sent += 1
                yield SimpleNamespace(text=self.text[i:i + step])
        return gen()

    def generate_content(self, model=None, contents=None, config=None):
        self.grounded_calls.append(SimpleNamespace(model=model, config=config))
        time.sleep(0.05)
        return SimpleNamespace(text=self.grounded_text)


class FakePlaces:
    timeout = 1.0

    def __init__(self, db, delays=None):
        self.db = db              # query の店名部分 -> results
        self.delays = delays or {}
        self.queries = []
        self.lock = threading.Lock()
        self.first_query_at = None

    def geocode(self, area, language='ja'):
        return CENTER

    def text_search(self, query, area_center=None, language='ja'):
        name = query.rsplit(' ', 1)[0]
        with self.lock:
            self.queries.append(query)
            if self.first_query_at is None:
                self.first_query_at = time.monotonic()
        time.sleep(self.delays.get(name, 0.01))
        v = self.db.get(name, [])
        if isinstance(v, Exception):
            raise v
        return v

    def photo_url(self, place):
        return f"photo:{place['place_id']}"


def P(pid, name, status='OPERATIONAL'):
    return {'place_id': pid, 'name': name, 'formatted_address': '東京都目黒区上目黒1丁目',
            'geometry': {'location': {'lat': 35.6445, 'lng': 139.6985}}, 'types': ['restaurant', 'food'],
            'business_status': status, 'rating': 4.1, 'user_ratings_total': 100}


def run(models, places, cfg=None):
    events = []
    lock = threading.Lock()

    def on_event(name, payload):
        with lock:
            events.append((name, payload, time.monotonic()))
    client = SimpleNamespace(models=models)
    r = RecommendationRun('中目黒 焼き鳥 予算5000円', client, types, places, cfg or EngineConfig(), on_event)
    result = r.run()
    if r.fresh_thread:
        r.fresh_thread.join(2)
    return result, events, r


NAMES = ['串若丸', 'つかだ', 'ももたろう', 'スエヒロガリ', 'なゝ樹', '鳥しき', 'とり茂', '鳥よし']


def full_db(names=NAMES):
    return {n: [P(f'P{i}', n)] for i, n in enumerate(names, 1)}


def test_cards_in_recommend_order_despite_reverse_verification_speed():
    # 先頭ほど照合が遅い
    delays = {n: 0.4 - 0.05 * i for i, n in enumerate(NAMES)}
    models = FakeModels([plan_line()] + [cand_line(i, n) for i, n in enumerate(NAMES, 1)] + ['{"type":"end"}'])
    result, events, _ = run(models, FakePlaces(full_db(), delays))
    cards = [p for (n, p, _) in events if n == 'shop_card_ready']
    assert [c['display_rank'] for c in cards] == [1, 2, 3, 4, 5]
    assert [c['card']['llm_name'] for c in cards] == NAMES[:5]
    assert result['status'] == 'ok' and len(result['cards']) == 5
    assert [n for (n, _, _) in events][0] == 'recommendation_started'
    assert [n for (n, _, _) in events][-1] == 'recommendation_completed'


def test_verification_starts_before_llm_finishes():
    models = FakeModels([plan_line()] + [cand_line(i, n) for i, n in enumerate(NAMES, 1)] + ['{"type":"end"}'],
                        chunk_delay=0.05)
    places = FakePlaces(full_db())
    result, events, r = run(models, places)
    t = result['timings']
    assert t['T1c'] < t['T2']           # 1件目の候補は LLM 完了より前に届く
    assert t['T3'] < t['T2']            # 照合も LLM 完了前に始まる
    assert t['T5'] < t['T2']            # 初回カードも LLM 完了前に確定
    for k in ('T0', 'T1', 'T1p', 'T1c', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'):
        assert k in t


def test_unverified_candidates_are_skipped_and_backfilled_in_order():
    db = full_db()
    db['つかだ'] = [P('PX', '別の店')]                     # すり替え候補 → NOT_FOUND
    db['ももたろう'] = [P('P3', 'ももたろう', status='CLOSED_PERMANENTLY')]
    db['スエヒロガリ'] = RuntimeError('places_status_OVER_QUERY_LIMIT')
    models = FakeModels([plan_line()] + [cand_line(i, n) for i, n in enumerate(NAMES, 1)] + ['{"type":"end"}'])
    result, events, _ = run(models, FakePlaces(db))
    assert [c['llm_name'] for c in result['cards']] == ['串若丸', 'なゝ樹', '鳥しき', 'とり茂', '鳥よし']
    assert [c['recommend_rank'] for c in result['cards']] == [1, 5, 6, 7, 8]
    assert [c['display_rank'] for c in result['cards']] == [1, 2, 3, 4, 5]
    st = {v['name']: v['status'] for v in result['verifications']}
    assert st['つかだ'] == matching.NOT_FOUND and st['ももたろう'] == matching.CLOSED
    assert st['スエヒロガリ'] == matching.ERROR
    assert all(c['place_id'] != 'PX' for c in result['cards'])


def test_short_when_not_enough_verified_never_padded():
    db = {n: [] for n in NAMES}
    db['串若丸'] = [P('P1', '串若丸')]
    db['鳥よし'] = [P('P8', '鳥よし')]
    models = FakeModels([plan_line()] + [cand_line(i, n) for i, n in enumerate(NAMES, 1)] + ['{"type":"end"}'])
    result, events, _ = run(models, FakePlaces(db))
    assert result['status'] == 'short'
    assert [c['llm_name'] for c in result['cards']] == ['串若丸', '鳥よし']
    done = [p for (n, p, _) in events if n == 'recommendation_completed'][0]
    assert done['count'] == 2 and done['status'] == 'short'


def test_duplicate_place_id_kept_once():
    db = full_db()
    db['つかだ'] = [P('P1', '串若丸 つかだ')]   # 名前が近く同じ place_id に解決されても2枚目は出さない
    db['つかだ'][0]['name'] = 'つかだ'
    db['つかだ'][0]['place_id'] = 'P1'
    models = FakeModels([plan_line()] + [cand_line(i, n) for i, n in enumerate(NAMES, 1)] + ['{"type":"end"}'])
    result, _, _ = run(models, FakePlaces(db))
    ids = [c['place_id'] for c in result['cards']]
    assert len(ids) == len(set(ids)) == 5


def test_upstream_503_is_error_not_success():
    class ServerError(Exception):
        code = 503
    models = FakeModels([plan_line()], exc=ServerError('503 UNAVAILABLE'))
    result, events, _ = run(models, FakePlaces({}))
    assert result['status'] == 'upstream_error'
    names = [n for (n, _, _) in events]
    assert 'recommendation_error' in names and 'shop_card_ready' not in names


def test_error_midstream_keeps_already_verified_cards_and_reports_status():
    class ServerError(Exception):
        code = 503
    lines = [plan_line()] + [cand_line(i, n) for i, n in enumerate(NAMES, 1)] + ['{"type":"end"}']
    models = FakeModels(lines, exc=ServerError('503'), exc_after=12)
    result, events, _ = run(models, FakePlaces(full_db()))
    assert result['status'] == 'upstream_error'
    # 途中までに届いた候補の確定カードだけ（未検証で埋めない）
    assert all(c['verification']['status'] == 'VERIFIED' for c in result['cards'])


def test_garbage_lines_ignored_and_recorded():
    lines = ['```json', plan_line(), 'ここに説明文', cand_line(1, '串若丸'), '{broken', cand_line(2, 'つかだ'),
             '{"type":"end"}', '```']
    result, _, _ = run(FakeModels(lines), FakePlaces(full_db()))
    assert [c['llm_name'] for c in result['cards']] == ['串若丸', 'つかだ']
    assert 'ここに説明文' in result['llm_bad_lines'] and '{broken' in result['llm_bad_lines']


def test_no_candidates():
    result, events, _ = run(FakeModels([plan_line(), '{"type":"end"}']), FakePlaces({}))
    assert result['status'] == 'no_candidates'


def test_freshness_only_when_required_and_grounding_only_there():
    m1 = FakeModels([plan_line(False)] + [cand_line(1, '串若丸')] + ['{"type":"end"}'])
    run(m1, FakePlaces(full_db()))
    assert m1.grounded_calls == []
    assert not m1.stream_calls[0].config.tools          # 推薦呼び出しは検索ツールなし
    m2 = FakeModels([plan_line(True, False, '中目黒 焼き鳥 新店')] + [cand_line(1, '串若丸')] + ['{"type":"end"}'])
    result, _, r = run(m2, FakePlaces(full_db()))
    assert len(m2.grounded_calls) == 1
    assert m2.grounded_calls[0].config.tools[0].google_search is not None
    assert r.freshness['status'] == 'ok' and r.freshness['query'] == '中目黒 焼き鳥 新店'
    # Step 1 では Freshness はカードに反映しない
    assert [c['llm_name'] for c in result['cards']] == ['串若丸']


def test_alias_retry_only_on_not_found():
    db = {'ベアード': [], 'Baird Beer Nakameguro Taproom': [P('PB', 'Baird Beer Nakameguro Taproom')]}
    db['Baird Beer Nakameguro Taproom'][0]['types'] = ['bar', 'food']
    models = FakeModels([plan_line(), cand_line(1, 'ベアード', ['Baird Beer Nakameguro Taproom']), '{"type":"end"}'])
    places = FakePlaces(db)
    result, _, _ = run(models, places)
    assert [c['place_id'] for c in result['cards']] == ['PB']
    assert places.queries == ['ベアード 中目黒', 'Baird Beer Nakameguro Taproom 中目黒']


def test_line_parser_handles_split_chunks():
    p = LineParser()
    out = p.feed('{"type":"pl') + p.feed('an","area":"a"}\n{"type":"end"') + p.feed('}')
    out += p.flush()
    assert [o['type'] for o in out] == ['plan', 'end']
