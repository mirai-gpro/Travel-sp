# -*- coding: utf-8 -*-
"""poc_bench を模擬 Gemini / Places で実行し、出力に API キーが無いこと・検索未実行・T5/T6 注記を確認する"""
import io
import json
import os
import runpy
import sys
from contextlib import redirect_stdout
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

import test_pipeline as tp  # noqa: E402

GKEY = 'AIzaSyBENCHGEMINIKEY000000000000000'
PKEY = 'AIzaSyBENCHPLACESKEY000000000000000'


def test_bench_output_and_json_have_no_keys(tmp_path, monkeypatch):
    monkeypatch.setenv('GEMINI_API_KEY', GKEY)
    monkeypatch.setenv('GOOGLE_PLACES_API_KEY', PKEY)
    lines = [tp.plan_line(True, True, '中目黒 新店')] + [tp.cand_line(i, n) for i, n in enumerate(tp.NAMES, 1)] + \
        ['{"type":"end"}']
    models = tp.FakeModels(lines, chunk_delay=0.001)
    db = tp.full_db()
    for v in db.values():
        v[0]['photos'] = [{'photo_reference': 'REF'}]
    db['つかだ'] = RuntimeError(f'places error url=...textsearch/json?query=x&key={PKEY}')

    class KeyedFakePlaces(tp.FakePlaces):
        def __init__(self, key):
            super().__init__(db)
            from shop_engine.redact import register_secret
            register_secret(key)

    qfile = tmp_path / 'q.txt'
    qfile.write_text('中目黒 焼き鳥\n', encoding='utf-8')
    out = tmp_path / 'out.json'
    import google.genai as g
    buf = io.StringIO()
    with mock.patch.object(g, 'Client', lambda api_key=None: SimpleNamespace(models=models)), \
            mock.patch('shop_engine.places.PlacesClient', KeyedFakePlaces), redirect_stdout(buf):
        sys.argv = ['poc_bench', '--queries', str(qfile), '--out', str(out)]
        runpy.run_module('shop_engine.poc_bench', run_name='__main__')
    text = buf.getvalue()
    saved = out.read_text(encoding='utf-8')
    for blob in (text, saved):
        assert GKEY not in blob and PKEY not in blob
        assert 'key=AIza' not in blob
    assert models.grounded_calls == []
    data = json.loads(saved)
    assert data['google_search_executed'] is False and 'サーバー側' in data['timing_note']
    assert 'T5(初回カード確定・サーバー)' in text and 'Google 検索は未実行' in text
    assert data['runs'][0]['freshness_decision']['required'] is True
