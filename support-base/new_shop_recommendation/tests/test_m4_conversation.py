# -*- coding: utf-8 -*-
"""M4 プレビュー専用: R2.0 の会話（concierge_v11）と search_shops の説明の切り替え（既定は従来のまま）"""
import os
import subprocess
import sys

import pytest

HERE = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, HERE)
lah = pytest.importorskip('live_api_handler')


def test_v11_prompt_is_verbatim_486dace_and_has_no_fixed_hearing():
    for lang in ('ja', 'en'):
        cur = open(os.path.join(HERE, 'prompts', f'concierge_v11_{lang}.txt'), encoding='utf-8').read()
        try:
            src = subprocess.run(['git', 'show', f'486dace:support-base/prompts/concierge_v11_{lang}.txt'], cwd=HERE,
                                 capture_output=True, text=True, check=True).stdout
        except Exception:
            pytest.skip('git 履歴（486dace）にアクセスできない環境')
        assert cur == src
    ja = open(os.path.join(HERE, 'prompts', 'concierge_v11_ja.txt'), encoding='utf-8').read()
    assert 'この条件で探してもよろしいですか？' in ja and '予算・人数・雰囲気・利用目的・日程は必須ではない' in ja
    assert 'ステップ1' not in ja and 'ヒアリング順序' not in ja
    built = lah.build_system_instruction('concierge', None, {'concierge': {'ja': ja}}, 'ja')
    assert '{user_context}' not in built and '初期あいさつ' in built


def _tools(mode):
    s = lah.LiveAPISession.__new__(lah.LiveAPISession)
    s.mode, s.system_prompt, s.conversation_history = mode, 'x', []
    for k in ('language', 'voice_model', 'live_voice'):
        setattr(s, k, 'ja' if k == 'language' else '')
    try:
        cfg = s._build_config()
    except AttributeError as e:
        pytest.skip(f'_build_config の前提属性が不足: {e}')
    return cfg['tools'][0].function_declarations


def test_search_shops_description_switch(monkeypatch):
    monkeypatch.delenv('NEW_SHOP_FLOW', raising=False)
    assert _tools('concierge')[0].description == lah.SEARCH_SHOPS_DECLARATION.description          # 既定は従来
    monkeypatch.setenv('NEW_SHOP_FLOW', 'S10')
    assert _tools('concierge')[0].description.startswith('お客様が条件の確認に承諾したときだけ呼ぶ')
    assert _tools('chat')[0].description == lah.SEARCH_SHOPS_DECLARATION.description               # chat は従来のまま
