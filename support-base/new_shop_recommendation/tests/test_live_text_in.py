# -*- coding: utf-8 -*-
"""
キーボード入力を Live に送る（R2.0 7481c6c の live_text_in を S10 のバックエンドへ移したもの）。
外部 API・本物の Live には接続しない。テストの中身は R2.0 の test_concierge_live.py の 3 件と同じ
"""
import asyncio
import os
import sys
import threading
from types import SimpleNamespace
from unittest import mock

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


def test_enqueue_text_from_another_thread_keeps_order():
    l = lah.LiveAPISession.__new__(lah.LiveAPISession)

    async def scenario():
        l.text_queue_to_gemini = asyncio.Queue()
        l._loop = asyncio.get_running_loop()
        l.is_running = True
        t = threading.Thread(target=lambda: [l.enqueue_text(x) for x in ('a', 'b', 'c')])
        t.start()
        t.join()
        return [await asyncio.wait_for(l.text_queue_to_gemini.get(), 1) for _ in range(3)]

    assert asyncio.run(scenario()) == ['a', 'b', 'c']
    l.is_running = False
    assert l.enqueue_text('d') is False


def test_live_text_in_enqueues_text():
    live_session = mock.Mock(is_running=True)
    live_session.enqueue_text.return_value = True
    emit = mock.Mock()
    app.active_live_sessions['client-3'] = live_session
    try:
        with mock.patch.object(app, 'request', SimpleNamespace(sid='client-3')), \
                mock.patch.object(app, 'emit', emit):
            app.handle_live_text_in({'text': '  恵比寿でイタリアン  '})
            app.handle_live_text_in({'text': '   '})
    finally:
        app.active_live_sessions.pop('client-3', None)
    live_session.enqueue_text.assert_called_once_with('恵比寿でイタリアン')
    emit.assert_not_called()


def test_live_text_in_without_live_is_rejected():
    emit = mock.Mock()
    with mock.patch.object(app, 'request', SimpleNamespace(sid='client-4')), \
            mock.patch.object(app, 'emit', emit):
        app.handle_live_text_in({'text': 'x'})
    emit.assert_called_once_with('live_text_rejected', {'reason': 'not_running'})


def test_live_text_in_not_ready_is_rejected():
    live_session = mock.Mock(is_running=True)
    live_session.enqueue_text.return_value = False
    emit = mock.Mock()
    app.active_live_sessions['client-5'] = live_session
    try:
        with mock.patch.object(app, 'request', SimpleNamespace(sid='client-5')), \
                mock.patch.object(app, 'emit', emit):
            app.handle_live_text_in({'text': 'x'})
    finally:
        app.active_live_sessions.pop('client-5', None)
    emit.assert_called_once_with('live_text_rejected', {'reason': 'not_ready'})
