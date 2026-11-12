# -*- coding: utf-8 -*-
"""
speed-clean: Live の search_shops 処理（live_api_handler）の検索ID隔離・後送り・計測分類のテスト。

- 初回カード（shop_search_result）と後送りリンク（shop_links_update）が同じ search_id で紐づく
- 新しい検索が始まったら、旧検索のリンク更新は送られない（取消し・破棄の両方）
- Gemini 503 等の失敗は outcome=upstream_error、0件は no_result として記録され、成功扱いにならない
- 全店 Places 照合失敗時は旧版どおり元候補（raw_shops）でカード送信し、リンク後送りはしない
- tool_response（LiveAPI の読み上げ内容）は旧版の _build_shop_tool_response と同じ

実行: cd support-base && python -m pytest -q tests/test_speed_clean_live_isolation.py
"""
import asyncio
import logging
import os
import sys
import time
from types import SimpleNamespace
from unittest import mock

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

# import 時の TTS 事前生成でネットワークに出ないようにする
with mock.patch('google.cloud.texttospeech.TextToSpeechClient', side_effect=RuntimeError('no tts in test')):
    import live_api_handler as lah  # noqa: E402
import api_integrations as ai  # noqa: E402


class FakeSocketIO:
    def __init__(self):
        self.events = []

    def emit(self, event, data=None, room=None):
        self.events.append((event, data, room))

    def of(self, name):
        return [d for (e, d, _r) in self.events if e == name]


class FakeLiveSession:
    def __init__(self):
        self.tool_responses = []

    async def send_tool_response(self, function_responses=None):
        self.tool_responses.append(function_responses)


def make_session(callback):
    s = lah.LiveAPISession.__new__(lah.LiveAPISession)
    s.language = 'ja'
    s.mode = 'concierge'
    s.client_sid = 'sid-1'
    s.socketio = FakeSocketIO()
    s._shop_search_callback = callback
    s._shop_intro_turn_pending = False
    s._shop_search_id = None
    s._shop_links_task = None
    return s


def tool_call(user_request):
    fc = SimpleNamespace(name='search_shops', id='fc-1', args={'user_request': user_request})
    return SimpleNamespace(function_calls=[fc])


def raw(name):
    return {'name': name, 'area': '中目黒', 'category': '焼き鳥', 'description': f'{name}の説明',
            'priceRange': '5,000円'}


def ok_callback(names):
    def cb(user_request, lang, search_mode, search_id=None, timing=None):
        timing['gemini_sec'] = 0.01
        timing['gemini_status'] = 'ok'
        return {'response': 'msg', 'shops': [raw(n) for n in names], 'area': '中目黒'}
    return cb


def fake_core(link_delay=0.0, empty=False):
    def core(shops, area, language, timing=None):
        if empty:
            return [], []
        enriched, jobs = [], []
        for i, s in enumerate(shops):
            s = dict(s)
            s['place_id'] = f"P_{s['name']}"
            s['tabelog_url'] = 'https://tabelog/x'
            enriched.append(s)

            def job(n=s['name']):
                time.sleep(link_delay)
                return {'hotpepper_url': f'https://hp/{n}'}
            jobs.append((s['place_id'], job))
        return enriched, jobs
    return core


async def _drain(session):
    t = session._shop_links_task
    if t is not None:
        try:
            await t
        except asyncio.CancelledError:
            pass


def test_card_and_links_share_search_id_and_tool_response_unchanged():
    async def main():
        s = make_session(ok_callback(['A', 'B']))
        live = FakeLiveSession()
        with mock.patch.object(ai, 'enrich_shops_core_parallel', fake_core()):
            await s._handle_tool_call(tool_call('中目黒の焼き鳥'), live)
            await _drain(s)
        return s, live
    s, live = asyncio.run(main())
    start = s.socketio.of('shop_search_start')
    result = s.socketio.of('shop_search_result')
    links = s.socketio.of('shop_links_update')
    assert len(start) == len(result) == len(links) == 1
    sid = start[0]['search_id']
    assert sid and result[0]['search_id'] == sid and links[0]['search_id'] == sid
    assert [x['name'] for x in result[0]['shops']] == ['A', 'B']
    # 初回カードには後送り項目が無く、更新は place_id で紐づく
    assert all('hotpepper_url' not in x for x in result[0]['shops'])
    assert links[0]['updates'] == [
        {'place_id': 'P_A', 'fields': {'hotpepper_url': 'https://hp/A'}},
        {'place_id': 'P_B', 'fields': {'hotpepper_url': 'https://hp/B'}},
    ]
    # 順序: start → result → links
    order = [e for (e, _d, _r) in s.socketio.events]
    assert order == ['shop_search_start', 'shop_search_result', 'shop_links_update']
    # tool_response は旧版と同じ関数で、同じ shops から作られる
    fr = live.tool_responses[0][0]
    assert fr.name == 'search_shops' and fr.id == 'fc-1'
    assert fr.response == s._build_shop_tool_response(result[0]['shops'])
    assert s._shop_intro_turn_pending is True


def test_new_search_cancels_and_discards_old_links():
    async def main():
        s = make_session(ok_callback(['A']))
        live = FakeLiveSession()
        with mock.patch.object(ai, 'enrich_shops_core_parallel', fake_core(link_delay=0.3)):
            await s._handle_tool_call(tool_call('1回目'), live)
            first_task = s._shop_links_task
            assert first_task is not None and not first_task.done()
        # 2回目の検索（リンク取得は速い）
        s._shop_search_callback = ok_callback(['B'])
        with mock.patch.object(ai, 'enrich_shops_core_parallel', fake_core(link_delay=0.0)):
            await s._handle_tool_call(tool_call('2回目'), live)
            await _drain(s)
        await asyncio.sleep(0.5)  # 旧検索のワーカースレッドが終わるまで待つ
        return s, first_task
    s, first_task = asyncio.run(main())
    starts = s.socketio.of('shop_search_start')
    first_id, second_id = starts[0]['search_id'], starts[1]['search_id']
    assert first_id != second_id
    assert first_task.cancelled()
    links = s.socketio.of('shop_links_update')
    assert [l['search_id'] for l in links] == [second_id]
    assert links[0]['updates'][0]['place_id'] == 'P_B'


def test_stale_links_discarded_even_if_not_cancelled():
    """取消しが効かなかった場合でも、送信直前の search_id 照合で破棄される"""
    async def main():
        s = make_session(None)
        s._shop_search_id = 'new-search'
        jobs = [('P_A', lambda: {'hotpepper_url': 'https://hp/A'})]
        await s._deliver_shop_links('old-search', jobs, time.monotonic())
        return s
    s = asyncio.run(main())
    assert s.socketio.of('shop_links_update') == []


def test_gemini_503_is_upstream_error_not_success(caplog):
    def cb(user_request, lang, search_mode, search_id=None, timing=None):
        timing['gemini_sec'] = 8.7
        timing['gemini_status'] = 'http_503'
        return None

    async def main():
        s = make_session(cb)
        await s._handle_tool_call(tool_call('中目黒 焼き鳥 予算1人5000円 2名'), FakeLiveSession())
        return s
    with caplog.at_level(logging.INFO, logger=lah.logger.name):
        s = asyncio.run(main())
    res = s.socketio.of('shop_search_result')
    assert res[0]['shops'] == [] and res[0]['search_id'] == s.socketio.of('shop_search_start')[0]['search_id']
    assert s.socketio.of('shop_links_update') == []
    summaries = [r.getMessage() for r in caplog.records if 'summary' in r.getMessage()]
    assert len(summaries) == 1
    assert 'outcome=upstream_error' in summaries[0] and 'gemini_status=http_503' in summaries[0]
    assert 'outcome=success' not in summaries[0]


def test_zero_shops_is_no_result(caplog):
    def cb(user_request, lang, search_mode, search_id=None, timing=None):
        timing['gemini_status'] = 'ok'
        return {'response': '見つかりませんでした', 'shops': []}

    async def main():
        s = make_session(cb)
        await s._handle_tool_call(tool_call('x'), FakeLiveSession())
        return s
    with caplog.at_level(logging.INFO, logger=lah.logger.name):
        s = asyncio.run(main())
    assert s.socketio.of('shop_search_result')[0]['response'] == '見つかりませんでした'
    summaries = [r.getMessage() for r in caplog.records if 'summary' in r.getMessage()]
    assert 'outcome=no_result' in summaries[0]


def test_all_places_fail_falls_back_to_raw_without_links(caplog):
    async def main():
        s = make_session(ok_callback(['A', 'B', 'C']))
        with mock.patch.object(ai, 'enrich_shops_core_parallel', fake_core(empty=True)):
            await s._handle_tool_call(tool_call('x'), FakeLiveSession())
            await _drain(s)
        return s
    with caplog.at_level(logging.INFO, logger=lah.logger.name):
        s = asyncio.run(main())
    res = s.socketio.of('shop_search_result')[0]
    assert [x['name'] for x in res['shops']] == ['A', 'B', 'C']
    assert res['shops'] == [raw('A'), raw('B'), raw('C')]
    assert s.socketio.of('shop_links_update') == []
    summaries = [r.getMessage() for r in caplog.records if 'summary' in r.getMessage()]
    assert 'outcome=success' in summaries[0] and 'fallback_raw=True' in summaries[0]


def test_callback_signature_matches_app():
    """app_customer_support.shop_search_callback と同じ引数で呼ばれること（search_id / timing はキーワード）"""
    seen = {}

    def cb(user_request, lang, search_mode, search_id=None, timing=None):
        seen.update(user_request=user_request, lang=lang, mode=search_mode,
                    search_id=search_id, timing_is_dict=isinstance(timing, dict))
        return None

    async def main():
        s = make_session(cb)
        await s._handle_tool_call(tool_call('req'), FakeLiveSession())
        return s
    s = asyncio.run(main())
    assert seen == {'user_request': 'req', 'lang': 'ja', 'mode': 'concierge',
                    'search_id': s.socketio.of('shop_search_start')[0]['search_id'],
                    'timing_is_dict': True}
