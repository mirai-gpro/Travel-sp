# -*- coding: utf-8 -*-
"""M4 F9: E2E ログ集計"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from new_shop_recommendation.m4 import e2e  # noqa: E402

LOG = '''core-controller.ts:300 [TRACE AUDIO] perf=900.0ms playback=0.0ms
core-controller.ts:480 [M4] {"ev":"start","perf":1000.0}
core-controller.ts:490 [M4] {"ev":"stage_recv","stage":"preview","rid":"RID1","n":1,"perf":4400.0}
ShopCardList.astro:900 [M4] {"ev":"preview_render","rid":"RID1","n":1,"created":1,"removed":0,"moved":0,"perf":4420.0}
core-controller.ts:490 [M4] {"ev":"stage_recv","stage":"final","rid":"RID1","n":5,"status":"COMPLETE","shortfall":0,"perf":8100.0}
ShopCardList.astro:900 [M4] {"ev":"final_render","rid":"RID1","n":5,"created":4,"removed":0,"moved":1,"perf":8130.0}
core-controller.ts:500 [M4] {"ev":"result_recv","rid":"RID1","n":5,"status":"COMPLETE","perf":8200.0}
core-controller.ts:350 [TRACE AUDIO] perf=9500.0ms playback=0.0ms
core-controller.ts:370 [TRACE EXPR] perf=9600.0ms playback=0.0ms chunk=0 frames=30 fps=30
core-controller.ts:350 [TRACE AUDIO] perf=9800.0ms playback=120.0ms
ShopCardList.astro:900 [M4] {"ev":"detail_render","rid":"RID1","place_id":"P3","perf":15000.0}
'''


def test_browser_metrics():
    s = e2e.searches(e2e.parse_browser(LOG.splitlines()))
    assert len(s) == 1
    s = s[0]
    assert (s['rid'], s['preview_render'], s['final_render'], s['result_recv']) == ('RID1', 3420, 7130, 7200)
    assert (s['audio_recv'], s['audio_play'], s['expr_recv'], s['detail_last']) == (8500, 8800, 8600, 14000)
    assert (s['n_final'], s['shortfall'], s['removed'], s['moved']) == (5, 0, 0, 1)


def test_backend_metrics():
    m = {'request_id': 'RID1', 'events': {'preview_sent': 3300, 'final_sent': 7000}, 'final_status': 'COMPLETE',
         'stores': {'1': {'path': 'same'}}}
    entries = [{'textPayload': '[NewShopRec] tool_call_received t=100.000'},
               {'textPayload': '[NewShopRec][S10] ' + json.dumps(m)},
               {'textPayload': '[NewShopRec] function_response_sent request_id=RID1 status=COMPLETE items=5 t=107.250'}]
    b = e2e.parse_backend(entries)['RID1']
    assert b['preview_sent'] == 3300 and b['final_sent'] == 7000 and b['tool_response_s'] == 7.25 and b['paths'] == {'1': 'same'}
