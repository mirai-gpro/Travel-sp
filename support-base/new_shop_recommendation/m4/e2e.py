# -*- coding: utf-8 -*-
"""
M4 F9: E2E 計測の集計（API 呼び出しなし）

  python -m new_shop_recommendation.m4.e2e <browser_console.log> [backend_logs.json]

入力
  browser_console.log : プレビュー画面の DevTools コンソールを保存したテキスト（[M4]・[TRACE AUDIO]・[TRACE EXPR] の行を使う）
  backend_logs.json   : gcloud logging read --format=json の出力（[NewShopRec] の行を使う。省略可）

検索ごと（ブラウザの [M4] start ＝ shop_search_start 受信で区切る）の指標（ms、ブラウザは start からの経過）:
  preview_render  先行カードの描画完了（E6 先行）       final_render  最終カードの描画完了（E6 最終）
  result_recv     最終の shop_search_result 受信（この直後にバックエンドが tool_response を送る）
  audio_recv      result_recv 後の最初の live_audio 受信（E10）
  audio_play      その後、再生位置が進み始めた時刻（E11、[TRACE AUDIO] の playback 値で判定）
  expr_recv       result_recv 後の最初の live_expression 受信（E12、UIKA FULL133 への既存連携）
  detail_last     最後の詳しい説明の描画（E13）
バックエンド（request_id ごと、E1 基準）: preview_sent / final_sent（S10 の t0 基準）、tool_call→tool_response の秒数
"""
import json
import re
import sys

M4_RE = re.compile(r'\[M4\] (\{.*\})')
AUDIO_RE = re.compile(r'\[TRACE AUDIO\] perf=([\d.]+)ms playback=([\d.\-]+)ms')
EXPR_RE = re.compile(r'\[TRACE EXPR\] perf=([\d.]+)ms playback=([\d.\-]+)ms')


def parse_browser(lines):
    """returns 時刻順のイベント [(perf, kind, data)]"""
    ev = []
    for ln in lines:
        m = M4_RE.search(ln)
        if m:
            try:
                d = json.loads(m.group(1))
            except ValueError:
                continue
            ev.append((float(d.get('perf', 0)), d.get('ev'), d))
            continue
        m = AUDIO_RE.search(ln)
        if m:
            ev.append((float(m.group(1)), 'audio', {'playback': float(m.group(2))}))
            continue
        m = EXPR_RE.search(ln)
        if m:
            ev.append((float(m.group(1)), 'expr', {'playback': float(m.group(2))}))
    ev.sort(key=lambda x: x[0])
    return ev


def searches(ev):
    """[M4] start で区切った検索ごとの指標"""
    out, cur = [], None
    for perf, kind, d in ev:
        if kind == 'start':
            if cur:
                out.append(cur)
            cur = {'t0': perf, 'rid': None, 'preview_render': None, 'final_render': None, 'result_recv': None,
                   'audio_recv': None, 'audio_play': None, 'expr_recv': None, 'detail_last': None, 'n_final': None,
                   'status': None, 'shortfall': None, 'removed': None, 'moved': None, '_pb0': None}
            continue
        if cur is None:
            continue
        rel = round(perf - cur['t0'])
        if kind == 'stage_recv':
            cur['rid'] = d.get('rid') or cur['rid']
            if d.get('stage') == 'final':
                cur['status'], cur['shortfall'] = d.get('status'), d.get('shortfall')
        elif kind == 'preview_render' and cur['preview_render'] is None:
            cur['preview_render'] = rel
        elif kind == 'final_render' and cur['final_render'] is None:
            cur['final_render'], cur['n_final'] = rel, d.get('n')
            cur['removed'], cur['moved'] = d.get('removed'), d.get('moved')
        elif kind == 'result_recv' and cur['result_recv'] is None:
            cur['result_recv'] = rel
        elif kind == 'detail_render':
            cur['detail_last'] = rel
        elif kind == 'audio' and cur['result_recv'] is not None:
            if cur['audio_recv'] is None:
                cur['audio_recv'], cur['_pb0'] = rel, d['playback']
            elif cur['audio_play'] is None and d['playback'] > cur['_pb0']:
                cur['audio_play'] = rel
        elif kind == 'expr' and cur['result_recv'] is not None and cur['expr_recv'] is None:
            cur['expr_recv'] = rel
    if cur:
        out.append(cur)
    for s in out:
        s.pop('_pb0', None)
    return out


def parse_backend(entries):
    """gcloud logging read の JSON。returns {request_id: {...}}"""
    by_rid, calls, sent = {}, [], []
    for e in entries:
        msg = e.get('textPayload') or (e.get('jsonPayload') or {}).get('message') or ''
        if '[NewShopRec][S10] ' in msg:
            try:
                m = json.loads(msg.split('[NewShopRec][S10] ', 1)[1])
            except ValueError:
                continue
            ev = m.get('events') or {}
            by_rid[m['request_id']] = {
                'preview_sent': ev.get('preview_sent'), 'final_sent': ev.get('final_sent'), 'a_first_name': ev.get('a_first_name'),
                'first_adopted': ev.get('first_adopted'), 'b_done': ev.get('b_done'),
                'final_status': m.get('final_status'), 'final_reason': m.get('final_reason'),
                'final_place_ids': m.get('final_place_ids'), 'scope': m.get('scope'), 'a_error': m.get('a_error'),
                'b_error': m.get('b_error'),
                'paths': {k: (v or {}).get('path') for k, v in (m.get('stores') or {}).items()}}
        elif 'tool_call_received t=' in msg:
            calls.append(float(msg.rsplit('t=', 1)[1]))
        elif 'function_response_sent request_id=' in msg:
            rid = re.search(r'request_id=(\S+)', msg).group(1)
            sent.append((rid, float(msg.rsplit('t=', 1)[1])))
    for rid, t in sent:
        prev = [c for c in calls if c <= t]
        if rid in by_rid and prev:
            by_rid[rid]['tool_response_s'] = round(t - max(prev), 3)
    return by_rid


def pct(v, q):
    v = sorted(x for x in v if x is not None)
    if not v:
        return None
    k = max(0, min(len(v) - 1, int(round(q / 100 * len(v) + 0.5)) - 1))
    return v[k]


def main():
    ss = searches(parse_browser(open(sys.argv[1], encoding='utf-8', errors='replace').read().splitlines()))
    be = {}
    if len(sys.argv) > 2:
        be = parse_backend(json.load(open(sys.argv[2], encoding='utf-8')))
    print('| # | request_id | 先行描画 | 最終描画 | 件数/不足 | 消失/移動 | 結果受信 | 音声受信 | 再生開始 | 表情受信 | 説明最終 | BE 先行 | BE 最終 | BE tool_call→response(s) |')
    print('|---:|---|---:|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---:|')
    for i, s in enumerate(ss, 1):
        b = be.get(s['rid'] or '', {})
        print(f'| {i} | {(s["rid"] or "-")[:8]} | {s["preview_render"]} | {s["final_render"]} | {s["n_final"]}/{s["shortfall"]} | '
              f'{s["removed"]}/{s["moved"]} | {s["result_recv"]} | {s["audio_recv"]} | {s["audio_play"]} | {s["expr_recv"]} | '
              f'{s["detail_last"]} | {b.get("preview_sent")} | {b.get("final_sent")} | {b.get("tool_response_s")} |')
    n = len(ss)
    pv = [s['preview_render'] for s in ss]
    fn = [s['final_render'] for s in ss]
    print(f'\n検索 {n} 件: 先行描画 ≤5 秒 {sum(1 for x in pv if x is not None and x <= 5000)}/{n}（p50 {pct(pv, 50)} / p95 {pct(pv, 95)}）、'
          f'最終描画 ≤10 秒 {sum(1 for x in fn if x is not None and x <= 10000)}/{n}（p50 {pct(fn, 50)} / p95 {pct(fn, 95)}）')
    for k, name in (('audio_recv', '音声受信'), ('audio_play', '再生開始'), ('expr_recv', '表情受信')):
        v = [s[k] for s in ss]
        print(f'{name}: {sum(1 for x in v if x is not None)}/{n} 件、p50 {pct(v, 50)} / p95 {pct(v, 95)}')
    print('※ 正しい店舗か・条件に合うかは、最終カードの place ID を独立判定して別に集計する（ブラウザの時刻は shop_search_start 受信からの経過）')


if __name__ == '__main__':
    main()
