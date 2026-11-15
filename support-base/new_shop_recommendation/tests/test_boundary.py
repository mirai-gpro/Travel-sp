# -*- coding: utf-8 -*-
"""
境界アダプター（Gate C）のテスト。外部 API・本物の Live には接続しない。
- app_customer_support.shop_search_callback が新エンジンへ委譲し、旧 Gemini+Google 検索を呼ばない
- GEMINI_RECOMMEND_API_KEY が無ければ設定エラー（既存 GEMINI_API_KEY で代替しない）
- live_api_handler: shop_search_start → shop_search_result（カード）→ FunctionResponse をちょうど 1 回
  旧 enrich_shops_with_photos を呼ばない。エラー・0 件でも shop_search_result を送って待機 UI を解除させる
- カードと読み上げは同じ店・同じ順。読み上げに Maps 由来の住所・Place ID を含めない
"""
import asyncio
import json
import os
import sys
from types import SimpleNamespace
from unittest import mock

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
SB = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, SB)
os.environ.setdefault('GEMINI_API_KEY', 'AIzaEXISTINGLIVEKEY000000000000')

import google.cloud.speech as _speech  # noqa: E402
import google.cloud.storage as _storage  # noqa: E402
import google.cloud.texttospeech as _tts  # noqa: E402

with mock.patch.object(_tts, 'TextToSpeechClient', mock.MagicMock()), \
        mock.patch.object(_speech, 'SpeechClient', mock.MagicMock()), \
        mock.patch.object(_storage, 'Client', mock.MagicMock()):
    import app_customer_support as app  # noqa: E402
    import live_api_handler as lah  # noqa: E402

import api_integrations  # noqa: E402
from new_shop_recommendation import contracts as c  # noqa: E402


# ------------------------------------------------------------------ helpers
def cards_and_narration(n=5):
    cards = [{'name': f'Places表示名{i}', 'llm_name': f'店{i}', 'description': f'理由{i}', 'highlights': ['名物'],
              'location': f'日本、神奈川県横浜市{i}', 'place_id': f'pid{i}', 'maps_url': f'https://maps.google.com/?cid={i}',
              'display_rank': i, 'recommend_rank': i} for i in range(1, n + 1)]
    narration = [{'name': f'店{i}', 'area': '横浜駅西口', 'category': '名物', 'description': f'理由{i}', 'price_range': ''}
                 for i in range(1, n + 1)]
    return cards, narration


class FakeOrchestrator:
    def __init__(self, status=c.COMPLETE, n=5):
        self.status, self.n = status, n
        self.calls = []

    def run(self, user_request, language_code='ja', region_code='JP', request_id=None):
        self.calls.append((user_request, language_code, region_code))
        cards, narr = cards_and_narration(self.n) if self.status in (c.COMPLETE, c.PARTIAL) else ([], [])
        return {'request_id': 'req-1', 'status': self.status, 'error_type': None, 'cards': cards,
                'narration': narr, 'verifications': [], 'metrics': {}}


def get_callback():
    captured = {}

    class CaptureSession:
        def __init__(self, **kw):
            captured.update(kw)
            self.session_count = 0

    with mock.patch.object(app, 'request', SimpleNamespace(sid='t-sid')), \
            mock.patch.object(app, 'emit', lambda *a, **k: None), \
            mock.patch.object(app, 'LiveAPISession', CaptureSession), \
            mock.patch.object(app, 'build_system_instruction', lambda *a, **k: ''), \
            mock.patch.object(app.threading, 'Thread', mock.MagicMock()):
        app.handle_live_start({'mode': 'concierge', 'language': 'ja'})
    app.active_live_sessions.pop('t-sid', None)
    return captured['shop_search_callback']


class Boom:
    def __getattr__(self, name):
        raise AssertionError(f'旧推薦経路が呼ばれた: {name}')


# ------------------------------------------------------------------ app adapter
def test_callback_delegates_to_new_engine_and_never_uses_old_gemini_search():
    fake = FakeOrchestrator()
    cb = get_callback()
    with mock.patch.object(app, '_get_new_shop_orchestrator', lambda: fake), \
            mock.patch.object(app, 'gemini_client', Boom()), \
            mock.patch.object(app, 'extract_area_from_text', side_effect=AssertionError('old area')):
        res = cb('横浜で美味しい焼き鳥屋 予算6000円', 'ja', 'concierge')
    assert fake.calls == [('横浜で美味しい焼き鳥屋 予算6000円', 'ja', 'JP')]
    assert res['status'] == c.COMPLETE and res['request_id'] == 'req-1'
    assert [x['llm_name'] for x in res['shops']] == [n['name'] for n in res['narration']]


def test_missing_recommend_key_is_config_error_not_old_key(monkeypatch):
    monkeypatch.delenv('GEMINI_RECOMMEND_API_KEY', raising=False)
    monkeypatch.setenv('GOOGLE_PLACES_API_KEY', 'AIzaPLACESKEY0000000000000000')
    monkeypatch.setattr(app, '_new_shop_orchestrator', None)
    cb = get_callback()
    with mock.patch.object(app, 'gemini_client', Boom()):
        res = cb('横浜 焼き鳥', 'ja', 'concierge')
    assert res['status'] == 'ERROR' and res['error_type'] == 'config_missing' and res['shops'] == []


# ------------------------------------------------------------------ live handler
class FakeSocketIO:
    def __init__(self):
        self.events = []

    def emit(self, event, data=None, room=None):
        self.events.append((event, data))


class FakeLive:
    def __init__(self):
        self.responses = []

    async def send_tool_response(self, function_responses=None):
        self.responses.append(function_responses)


def make_session(callback):
    s = lah.LiveAPISession.__new__(lah.LiveAPISession)
    s.language, s.mode, s.client_sid = 'ja', 'concierge', 'sid'
    s.socketio = FakeSocketIO()
    s._shop_search_callback = callback
    s._shop_intro_turn_pending = False
    return s


def tool_call():
    return SimpleNamespace(function_calls=[SimpleNamespace(name='search_shops', id='fc-9',
                                                           args={'user_request': '横浜 焼き鳥'})])


def run_tool(callback):
    s = make_session(callback)
    live = FakeLive()
    with mock.patch.object(api_integrations, 'enrich_shops_with_photos', side_effect=AssertionError('旧 enrich')):
        asyncio.run(s._handle_tool_call(tool_call(), live))
    return s, live


def cb_from(status=c.COMPLETE, n=5, exc=None):
    def cb(user_request, lang, mode):
        if exc:
            raise exc
        cards, narr = cards_and_narration(n) if status in (c.COMPLETE, c.PARTIAL) else ([], [])
        return {'request_id': 'req-7', 'status': status, 'error_type': None, 'shops': cards,
                'narration': narr, 'response': ''}
    return cb


def test_success_sequence_cards_then_single_function_response_same_shops():
    s, live = run_tool(cb_from())
    names = [e for e, _ in s.socketio.events]
    assert names == ['shop_search_start', 'shop_search_result']
    payload = s.socketio.events[1][1]
    assert payload['request_id'] == 'req-7' and payload['status'] == c.COMPLETE and len(payload['shops']) == 5
    assert len(live.responses) == 1 and len(live.responses[0]) == 1           # ちょうど 1 回
    fr = live.responses[0][0]
    assert fr.id == 'fc-9' and fr.name == 'search_shops'
    spoken = fr.response['shops']
    assert [x['name'] for x in spoken] == [x['llm_name'] for x in payload['shops']]   # 同じ店・同じ順
    blob = json.dumps(fr.response, ensure_ascii=False)
    assert '日本、' not in blob and 'pid' not in blob and 'maps.google' not in blob    # Maps 由来を渡さない
    assert '5軒' in fr.response['result'] and s._shop_intro_turn_pending is True


def test_partial_count_matches_narration():
    s, live = run_tool(cb_from(c.PARTIAL, n=3))
    fr = live.responses[0][0]
    assert len(fr.response['shops']) == 3 and '3軒' in fr.response['result']
    assert len(s.socketio.events[1][1]['shops']) == 3


@pytest.mark.parametrize('status', [c.EMPTY, c.ERROR, c.TIMED_OUT])
def test_empty_or_error_still_releases_waiting_ui_and_reports_once(status):
    s, live = run_tool(cb_from(status))
    assert [e for e, _ in s.socketio.events] == ['shop_search_start', 'shop_search_result']
    assert s.socketio.events[1][1]['shops'] == []
    assert len(live.responses) == 1
    text = live.responses[0][0].response['result']
    if status == c.EMPTY:
        assert '見つかりませんでした' in text
    else:
        assert 'エラー' in text
    assert s._shop_intro_turn_pending is False


def test_callback_exception_releases_waiting_ui():
    s, live = run_tool(cb_from(exc=RuntimeError('boom')))
    assert [e for e, _ in s.socketio.events] == ['shop_search_start', 'shop_search_result']
    assert s.socketio.events[1][1]['status'] == 'ERROR'
    assert 'エラー' in live.responses[0][0].response['result'] and len(live.responses) == 1


def test_search_shops_declaration_unchanged():
    assert lah.SEARCH_SHOPS_DECLARATION.name == 'search_shops'
    assert lah.SEARCH_SHOPS_DECLARATION.behavior == lah.types.Behavior.BLOCKING
    assert lah.LIVE_API_MODEL == 'gemini-3.8-live'
