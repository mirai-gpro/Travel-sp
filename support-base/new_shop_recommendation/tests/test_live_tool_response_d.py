# -*- coding: utf-8 -*-
"""M4 F6: 方式 D の tool_response（Live に渡す内容）。Live の音声・表情処理には触れない"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

import pytest  # noqa: E402

lah = pytest.importorskip('live_api_handler')


def build(result):
    return lah.LiveAPISession._build_new_shop_tool_response(lah.LiveAPISession.__new__(lah.LiveAPISession), result)


def test_option_d_only_name_area_and_request():
    nar = [{'number': i, 'name': f'店{i}', 'area': '関内'} for i in range(1, 6)]
    r = build({'status': 'COMPLETE', 'narration': nar, 'narration_mode': 'D', 'request': '横浜 焼き鳥', 'shortfall': 0})
    assert r['shops'] == nar                                        # 店名・地区・番号だけ（説明・価格・Maps の情報なし）
    assert '横浜 焼き鳥' in r['result'] and '渡した項目以外の特徴・料理・価格・受賞歴・営業時間は述べないでください' in r['result']
    assert '5軒には届きませんでした' not in r['result']


def test_option_d_partial_reports_shortfall():
    nar = [{'number': 1, 'name': '店1', 'area': '関内'}, {'number': 2, 'name': '店2', 'area': '関内'}]
    r = build({'status': 'PARTIAL', 'narration': nar, 'narration_mode': 'D', 'request': 'q', 'shortfall': 3})
    assert '確認できたお店は2軒で、5軒には届きませんでした' in r['result'] and len(r['shops']) == 2


def test_default_flow_unchanged():
    nar = [{'name': 'a', 'area': 'b', 'category': 'c', 'description': 'd', 'price_range': ''}]
    r = build({'status': 'COMPLETE', 'narration': nar})
    assert r['shops'][0]['description'] == 'd' and 'エリア・ジャンル・説明・予算を含めること' in r['result']
    assert build({'status': 'ERROR'})['result'].startswith('お店の検索中にエラー')
