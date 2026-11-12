# -*- coding: utf-8 -*-
"""
speed-clean: shop_search_callback（app_customer_support）のテスト。

- Gemini 呼び出しのモデル名・Google 検索ツール・システムプロンプト・入力が 33秒版(8d30e55) と同一
- extract_area_from_text（Geocoding）が Gemini と並行して開始され、同じ引数で1回だけ呼ばれる
- 返り値（response / shops / summary / area 等）が旧版と同じ規則で作られる
  （area は shops がある場合のみ付与。0件・エラー時の返り値も旧版と同じ）
- Gemini 503 は timing に http_503 として記録され、返り値は旧版どおり None

実行: cd support-base && python -m pytest -q tests/test_speed_clean_callback.py
"""
import ast
import json
import os
import re
import subprocess
import sys
import threading
import time
from types import SimpleNamespace
from unittest import mock

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
os.environ.setdefault('GEMINI_API_KEY', 'dummy-for-test')

import google.cloud.texttospeech as _tts  # noqa: E402
import google.cloud.speech as _speech  # noqa: E402
import google.cloud.storage as _storage  # noqa: E402

with mock.patch.object(_tts, 'TextToSpeechClient', mock.MagicMock()), \
        mock.patch.object(_speech, 'SpeechClient', mock.MagicMock()), \
        mock.patch.object(_storage, 'Client', mock.MagicMock()):
    import app_customer_support as app  # noqa: E402

BASE_SHA = '8d30e554f004957996a871b79b2c0b177a5e3e47'


def _search_only_prompt_from_source(src: str) -> str:
    m = re.search(r"SEARCH_ONLY_PROMPT = \((.*?)\n        \)\n", src, re.S)
    assert m
    return ast.literal_eval('(' + m.group(1) + '\n)')


def get_callback():
    captured = {}

    class CaptureSession:
        def __init__(self, **kw):
            captured.update(kw)
            self.session_count = 0

    with mock.patch.object(app, 'request', SimpleNamespace(sid='test-sid')), \
            mock.patch.object(app, 'emit', lambda *a, **k: None), \
            mock.patch.object(app, 'LiveAPISession', CaptureSession), \
            mock.patch.object(app, 'build_system_instruction', lambda *a, **k: ''), \
            mock.patch.object(app.threading, 'Thread', mock.MagicMock()):
        app.handle_live_start({'mode': 'concierge', 'language': 'ja'})
    app.active_live_sessions.pop('test-sid', None)
    return captured['shop_search_callback']


GEMINI_JSON = {
    'message': '中目黒の焼き鳥を5軒ご紹介します。',
    'shops': [{'name': f'店{i}', 'area': '中目黒'} for i in range(1, 6)],
}


class FakeModels:
    def __init__(self, delay=0.0, text=None, exc=None):
        self.delay, self.text, self.exc = delay, text, exc
        self.calls = []
        self.t_start = self.t_end = None

    def generate_content(self, model=None, contents=None, config=None):
        self.calls.append(SimpleNamespace(model=model, contents=contents, config=config))
        self.t_start = time.monotonic()
        time.sleep(self.delay)
        self.t_end = time.monotonic()
        if self.exc:
            raise self.exc
        return SimpleNamespace(text=self.text)


class FakeArea:
    def __init__(self, delay=0.0, value='中目黒', exc=None):
        self.delay, self.value, self.exc = delay, value, exc
        self.calls = []
        self.t_start = self.t_end = None

    def __call__(self, text, language='ja'):
        self.calls.append((text, language, threading.current_thread().name))
        self.t_start = time.monotonic()
        time.sleep(self.delay)
        self.t_end = time.monotonic()
        if self.exc:
            raise self.exc
        return self.value


def run_cb(models, area, user_request='中目黒の美味しい焼き鳥'):
    cb = get_callback()
    timing = {}
    with mock.patch.object(app, 'gemini_client', SimpleNamespace(models=models)), \
            mock.patch.object(app, 'extract_area_from_text', area):
        t0 = time.monotonic()
        result = cb(user_request, 'ja', 'concierge', search_id='sid123', timing=timing)
        elapsed = time.monotonic() - t0
    return result, timing, elapsed


def test_gemini_request_identical_to_33s_version():
    models = FakeModels(text=json.dumps(GEMINI_JSON, ensure_ascii=False))
    run_cb(models, FakeArea())
    call = models.calls[0]
    assert call.model == 'gemini-2.5-flash'
    assert call.contents == [{'role': 'user', 'parts': [{'text': '検索条件: 中目黒の美味しい焼き鳥'}]}]
    tools = call.config.tools
    assert len(tools) == 1 and tools[0].google_search is not None
    try:
        base_src = subprocess.run(['git', 'show', f'{BASE_SHA}:support-base/app_customer_support.py'],
                                  cwd=HERE, capture_output=True, check=True, text=True).stdout
    except (subprocess.CalledProcessError, FileNotFoundError):
        pytest.skip('git 履歴が無い環境')
    assert call.config.system_instruction == _search_only_prompt_from_source(base_src)


def test_area_extraction_runs_in_parallel_with_gemini_and_result_same():
    models = FakeModels(delay=0.4, text='前置き ' + json.dumps(GEMINI_JSON, ensure_ascii=False) + ' 後書き')
    area = FakeArea(delay=0.3)
    result, timing, elapsed = run_cb(models, area)
    # 旧版と同じ返り値
    assert result == {
        'response': GEMINI_JSON['message'],
        'shops': GEMINI_JSON['shops'],
        'summary': '5軒のお店を提案しました。',
        'should_confirm': True,
        'is_followup': False,
        'area': '中目黒',
    }
    # 同じ引数で1回だけ、Gemini の完了前に開始
    assert [(c[0], c[1]) for c in area.calls] == [('中目黒の美味しい焼き鳥', 'ja')]
    assert area.t_start < models.t_end
    assert elapsed < 0.4 + 0.3 - 0.1  # 直列なら 0.7 秒以上
    assert timing['gemini_status'] == 'ok'
    assert 'area_sec' in timing and 'area_wait_after_gemini_sec' in timing


def test_zero_shops_has_no_area_like_base():
    models = FakeModels(text=json.dumps({'message': 'なし', 'shops': []}, ensure_ascii=False))
    result, _timing, _ = run_cb(models, FakeArea())
    assert result == {'response': 'なし', 'shops': [], 'summary': None,
                      'should_confirm': True, 'is_followup': False}


def test_gemini_503_returns_none_and_is_classified():
    class ServerError(Exception):
        def __init__(self):
            super().__init__('503 UNAVAILABLE')
            self.code = 503
    models = FakeModels(delay=0.05, exc=ServerError())
    result, timing, _ = run_cb(models, FakeArea())
    assert result is None
    assert timing['gemini_status'] == 'http_503'
    assert timing['gemini_sec'] >= 0.05


def test_area_exception_behaves_like_base():
    """旧版では extract_area_from_text の例外は callback の except に入り None を返す"""
    models = FakeModels(text=json.dumps(GEMINI_JSON, ensure_ascii=False))
    result, timing, _ = run_cb(models, FakeArea(exc=RuntimeError('geo boom')))
    assert result is None
    assert timing['gemini_status'] == 'ok'  # Gemini は成功しているので upstream_error にはしない


def test_classify_gemini_error():
    e504 = Exception('x'); e504.code = 504
    e429 = Exception('x'); e429.code = 429

    class ReadTimeout(Exception):
        pass
    assert app._classify_gemini_error(e504) == 'http_504'
    assert app._classify_gemini_error(e429) == 'http_429'
    assert app._classify_gemini_error(ReadTimeout('t')) == 'timeout'
    assert app._classify_gemini_error(ValueError('v')) == 'error_ValueError'
