# -*- coding: utf-8 -*-
"""M4 T4: 33 秒版の比較コードが本番 8d30e55 と同じ処理であること、計測エンドポイントの呼び出し制限"""
import ast
import os
import subprocess
import sys
import types as pytypes

import pytest

HERE = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, HERE)

from new_shop_recommendation import m4_bench as mb  # noqa: E402

PROD_SHA = '8d30e55'


def git_show(path):
    try:
        return subprocess.run(['git', 'show', f'{PROD_SHA}:{path}'], cwd=HERE, capture_output=True, text=True,
                              check=True).stdout
    except Exception:
        pytest.skip('git 履歴（8d30e55）にアクセスできない環境')


def find_func(tree, name):
    return next(n for n in ast.walk(tree) if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name == name)


def calls(node, attr):
    return [ast.unparse(n) for n in ast.walk(node) if isinstance(n, ast.Call) and ast.unparse(n.func).endswith(attr)]


def test_prompt_model_tools_contents_identical_to_production():
    prod = find_func(ast.parse(git_show('support-base/app_customer_support.py')), 'shop_search_callback')
    prompt = next(n for n in ast.walk(prod) if isinstance(n, ast.Assign) and ast.unparse(n.targets[0]) == 'SEARCH_ONLY_PROMPT')
    assert ast.literal_eval(prompt.value) == mb.SEARCH_ONLY_PROMPT
    mine = find_func(ast.parse(open(mb.__file__, encoding='utf-8').read()), 'production_33')
    assert calls(prod, 'GenerateContentConfig') == calls(mine, 'GenerateContentConfig')
    assert calls(prod, 'models.generate_content') == [c.replace('user_request', 'user_request') for c in calls(mine, 'models.generate_content')]
    assert calls(prod, 'extract_shops_from_response') == [c.replace('legacy.', '') for c in calls(mine, 'extract_shops_from_response')]
    assert calls(prod, 'extract_area_from_text') == [c.replace('legacy.', '') for c in calls(mine, 'extract_area_from_text')]


def test_enrich_identical_to_production_live_handler():
    prod = find_func(ast.parse(git_show('support-base/live_api_handler.py')), '_handle_shop_search')
    src = ast.unparse(prod)
    assert 'run_in_executor(None, enrich_shops_with_photos, raw_shops, area, self.language)' in src
    assert 'shops = enriched if enriched else raw_shops' in src
    mine = ast.unparse(find_func(ast.parse(open(mb.__file__, encoding='utf-8').read()), 'production_33'))
    assert 'legacy.enrich_shops_with_photos(shops, area, lang)' in mine and 'out = enriched if enriched else shops' in mine
    # api_integrations（enrich・extract の本体）は 8d30e55 から変更されていない
    cur = open(os.path.join(HERE, 'api_integrations.py'), encoding='utf-8').read()
    assert cur == git_show('support-base/api_integrations.py')


@pytest.fixture
def fake_modules(monkeypatch):
    rec = {}

    class Resp:
        def __init__(self, text):
            self.text = text

    class Models:
        def generate_content(self, model, contents, config):
            rec['call'] = (model, contents, config)
            return Resp(rec['text'])

    class Client:
        def __init__(self, api_key):
            rec['key'] = api_key
            self.models = Models()

    gtypes = pytypes.SimpleNamespace(GenerateContentConfig=lambda **kw: kw, Tool=lambda **kw: kw, GoogleSearch=lambda: 'gs')
    genai = pytypes.ModuleType('google.genai')
    genai.Client, genai.types = Client, gtypes
    google = pytypes.ModuleType('google')
    google.genai = genai
    legacy = pytypes.ModuleType('api_integrations')
    legacy.extract_shops_from_response = lambda t: [{'name': 'regex店'}]
    legacy.extract_area_from_text = lambda q, lang: '横浜'

    def enrich(shops, area, lang):
        rec['enrich'] = (len(shops), area, lang)
        out = []
        for i, s in enumerate(shops):
            if i == 1:
                continue                      # 見つからない店は除く（本番と同じ）
            s['name'] = 'Places名'           # 本番は店名を Places の名前で上書きする
            s['place_id'] = f'PID{i}'
            out.append(s)
        return out
    legacy.enrich_shops_with_photos = enrich
    monkeypatch.setitem(sys.modules, 'google', google)
    monkeypatch.setitem(sys.modules, 'google.genai', genai)
    monkeypatch.setitem(sys.modules, 'google.genai.types', gtypes)
    monkeypatch.setitem(sys.modules, 'api_integrations', legacy)
    monkeypatch.setenv('GEMINI_API_KEY', 'prod-key-in-revision')
    return rec


def test_production_33_flow(fake_modules):
    fake_modules['text'] = '前置き {"message": "m", "shops": [{"name": "A店", "area": "関内"}, {"name": "B店"}, {"name": "C店"}]} 後'
    out = mb.run_33('横浜 焼き鳥')
    model, contents, config = fake_modules['call']
    assert model == 'gemini-2.5-flash' and contents == [{'role': 'user', 'parts': [{'text': '検索条件: 横浜 焼き鳥'}]}]
    assert config['system_instruction'] == mb.SEARCH_ONLY_PROMPT and config['tools'] == [{'google_search': 'gs'}]
    assert fake_modules['enrich'] == (3, '横浜', 'ja')
    assert [(s['rec'], s['place_id']) for s in out['stores']] == [('A店', 'PID0'), ('C店', 'PID2')]   # LLM の店名を記録
    assert 'prod-key' not in str(out)


def test_production_33_json_error_uses_production_regex_path(fake_modules):
    fake_modules['text'] = '{"shops": [壊れた]}'
    out = mb.run_33('q')
    assert [s['rec'] for s in out['stores']] == ['regex店']


def test_guard_limits(monkeypatch):
    monkeypatch.setenv('M4_BENCH_MAX_CALLS', '2')
    mb._calls['n'] = 0
    assert mb.acquire() == ''
    assert mb.acquire() == 'busy'                 # 同時 1 件
    mb.release()
    assert mb.acquire() == ''
    mb.release()
    assert mb.acquire() == 'call_limit_reached'   # 合計回数
    mb._calls['n'] = 0
