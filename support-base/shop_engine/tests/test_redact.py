# -*- coding: utf-8 -*-
"""修正3: API キーが画面出力・JSON・エラー文字列に残らないこと"""
import json
import os
import sys
from types import SimpleNamespace

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

import requests  # noqa: E402

import test_pipeline as tp  # noqa: E402
from shop_engine import redact as rd  # noqa: E402
from shop_engine.places import PlacesClient  # noqa: E402

PKEY = 'AIzaSyTESTPLACESKEY0123456789abcdef'


def test_redact_registered_secret_and_key_param():
    rd.register_secret(PKEY)
    msg = f"HTTPSConnectionPool(host='maps.googleapis.com'): /maps/api/place/textsearch/json?query=x&key={PKEY}&language=ja"
    out = rd.redact(msg)
    assert PKEY not in out and 'key=' + rd.MASK in out
    assert rd.find_leaks(out) == []
    assert rd.find_leaks(msg) != []
    other = 'https://x/?a=1&key=SOMEOTHERKEYVALUE123'
    assert 'SOMEOTHERKEYVALUE123' not in rd.redact(other)
    assert rd.find_leaks(other) == ['key_param']


def test_places_error_with_key_in_url_is_redacted_in_result():
    def failing_get(url, params=None, timeout=None):
        raise requests.exceptions.ConnectionError(f"Max retries exceeded with url: {url}?query=x&key={params['key']}")
    pc = PlacesClient(PKEY, http_get=failing_get, timeout=1.0)
    pc.geocode = lambda area, language='ja': tp.CENTER
    models = tp.FakeModels([tp.plan_line(), tp.cand_line(1, '串若丸'), '{"type":"end"}'], chunk_delay=0.001)
    result, events, _ = tp.run(models, pc)
    dumped = json.dumps(result, ensure_ascii=False) + json.dumps([e[1] for e in events], ensure_ascii=False)
    assert PKEY not in dumped
    assert rd.find_leaks(dumped) == []
    assert result['verifications'][0]['status'] == 'ERROR'


def test_cards_have_no_photo_url_with_key():
    db = tp.full_db()
    for v in db.values():
        v[0]['photos'] = [{'photo_reference': 'REF123'}]
    result, _, _ = tp.run(tp.FakeModels([tp.plan_line(), tp.cand_line(1, '串若丸'), '{"type":"end"}'], chunk_delay=0.001),
                          tp.FakePlaces(db))
    card = result['cards'][0]
    assert 'image' not in card and card['photo_reference'] == 'REF123'
    assert 'key=' not in json.dumps(result)


def test_gemini_error_message_redacted():
    gkey = 'AIzaSyTESTGEMINIKEY0123456789abcdef'
    rd.register_secret(gkey)

    class Boom(Exception):
        code = 503
    models = tp.FakeModels([tp.plan_line()], exc=Boom(f'503 UNAVAILABLE for key {gkey}'))
    result, events, _ = tp.run(models, tp.FakePlaces({}))
    assert gkey not in json.dumps(result) and gkey not in json.dumps([e[1] for e in events])


def test_no_google_search_tool_in_engine_source():
    """修正2: Step 1〜2 のエンジンのコードに Google 検索ツールの呼び出しが存在しない"""
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    for fn in ('recommender.py', 'pipeline.py', 'places.py', 'matching.py', 'poc_bench.py'):
        src = open(os.path.join(root, fn), encoding='utf-8').read()
        assert 'GoogleSearch(' not in src and 'google_search=' not in src, fn
