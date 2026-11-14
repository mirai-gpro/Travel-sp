# -*- coding: utf-8 -*-
"""
Gate M1 — 推薦 LLM ストリーミング計測（計測専用。製品コードは変更しない）

  python -m new_shop_recommendation.poc.gate_m1_streaming --repeat 3

- 推薦リクエストは recommender.build_request_body(q) をそのまま使い、stream だけ true にする
  （gemini-3.8-flash / thinking low / 現行プロンプト・JSON Schema / 最大 7 店舗 / tools なし）
- SSE（interaction.created → step.start → step.delta → step.stop → interaction.completed → done）を受信時刻つきで処理
- 店舗ごとに early（rank・name・area_hint の値が確定）と full（店舗オブジェクトが閉じて独立に検証可能）を区別して記録
- 終了後、全文を既存の parse_and_validate（製品と同じ出力検証）で検証し、逐次確定した店舗と一致するか確認する
時刻はすべて「API 送信開始」からの経過 ms（バックエンド内の計測。ブラウザ表示・配信・Live 音声は含まない）
"""
import argparse
import json
import os
import statistics
import sys
import time

import requests

from new_shop_recommendation import contracts as c
from new_shop_recommendation.poc.stream_json import CandidateStreamTracker, SseReader
from new_shop_recommendation.recommender import build_request_body, parse_and_validate
from new_shop_recommendation.redact import contains_secret, redact, register_secret

OUT = []
QUERIES = [
    '横浜で美味しい焼き鳥屋を5軒', '銀座で評判の老舗の天ぷら店', '渋谷で落ち着いて過ごせるカフェ',
    '新宿で接待向けの個室がある和食 予算1人1万5千円 4名', '吉祥寺で子連れの家族でも行きやすいイタリアン',
    '東京駅から徒歩5分以内の美味しいラーメン', '中目黒 焼き鳥 予算1人5000円 2名', '札幌すすきので美味しいジンギスカン',
    '京都の祇園で記念日に行くカウンター割烹 予算1人2万円 2名', '大阪 梅田 串カツ 立ち飲み',
]
TIMEOUT = (10, 60)   # 接続 10 秒・受信間隔 60 秒


def say(s=''):
    s = redact(s)
    OUT.append(s)
    print(s, flush=True)


def stream_body(q: str) -> dict:
    body = build_request_body(q)
    body['stream'] = True
    return body


def run_stream(api_key: str, q: str, post=None, now=time.monotonic):
    """1 試行。returns dict（時刻は送信開始からの ms）"""
    post = post or requests.post
    headers = {'Content-Type': 'application/json', 'x-goog-api-key': api_key,
               'Api-Revision': c.INTERACTIONS_API_REVISION, 'Accept': 'text/event-stream'}
    m = {'q': q, 'first_event_ms': None, 'first_text_ms': None, 'thought_start_ms': None, 'thought_stop_ms': None,
         'output_start_ms': None, 'completed_ms': None, 'done_ms': None, 'end_ms': None, 'status': None,
         'usage': {}, 'error': None, 'events': {}}
    tracker, sse = CandidateStreamTracker(), SseReader()
    step_types = {}
    t0 = now()

    def ms():
        return int((now() - t0) * 1000)

    try:
        r = post(c.INTERACTIONS_URL, json=stream_body(q), headers=headers, timeout=TIMEOUT, stream=True)
    except requests.exceptions.RequestException as e:
        m['error'] = f'network:{type(e).__name__}'
        return m, tracker
    if r.status_code != 200:
        m['error'] = redact(f'http_{r.status_code}:{(r.text or "")[:200]}')
        return m, tracker

    def handle(name, data):
        t = ms()
        if m['first_event_ms'] is None:
            m['first_event_ms'] = t
        m['events'][name or '?'] = m['events'].get(name or '?', 0) + 1
        if data == '[DONE]' or name == 'done':
            m['done_ms'] = t
            return
        try:
            ev = json.loads(data)
        except ValueError:
            m['error'] = m['error'] or 'invalid_sse_json'
            return
        et = ev.get('event_type') or name
        if et == 'step.start':
            st = (ev.get('step') or {}).get('type')
            step_types[ev.get('index')] = st
            if st == 'thought' and m['thought_start_ms'] is None:
                m['thought_start_ms'] = t
            if st == 'model_output' and m['output_start_ms'] is None:
                m['output_start_ms'] = t
        elif et == 'step.stop':
            if step_types.get(ev.get('index')) == 'thought':
                m['thought_stop_ms'] = t
        elif et == 'step.delta':
            d = ev.get('delta') or {}
            if d.get('type') == 'text' and step_types.get(ev.get('index'), 'model_output') == 'model_output':
                if m['first_text_ms'] is None:
                    m['first_text_ms'] = t
                tracker.feed(d.get('text') or '', t)
        elif et == 'interaction.completed':
            m['completed_ms'] = t
            inter = ev.get('interaction') or {}
            m['status'] = inter.get('status')
            m['usage'] = inter.get('usage') or {}
        elif et == 'error':
            err = ev.get('error') or {}
            m['error'] = f'stream_error:{err.get("code")}:{str(err.get("message"))[:120]}'

    try:
        for chunk in r.iter_content(chunk_size=None):
            if not chunk:
                continue
            for name, data in sse.feed(chunk):
                handle(name, data)
        for name, data in sse.flush():
            handle(name, data)
    except requests.exceptions.RequestException as e:
        m['error'] = m['error'] or f'stream_cut:{type(e).__name__}'
    m['end_ms'] = ms()
    return m, tracker


def evaluate(m, tracker):
    """出力検証（製品と同じ parse_and_validate）と逐次確定分との一致確認"""
    s = tracker.summary()
    ev = {'validate_error': None, 'n_final': 0, 'stream_matches_final': None, **s}
    if not s['root_closed']:
        ev['validate_error'] = 'truncated'
    try:
        _fi, cands = parse_and_validate(tracker.text())
        ev['n_final'] = len(cands)
        streamed = [(cd['obj'] or {}).get('name', '').strip() for cd in tracker.candidates if cd['full_t'] is not None]
        ev['stream_matches_final'] = streamed == [cd.name for cd in cands]
    except c.RecommendationError as e:
        ev['validate_error'] = ev['validate_error'] or e.error_type
    return ev


def stats(v):
    v = sorted(x for x in v if x is not None)
    if not v:
        return '—'
    p95 = v[min(len(v) - 1, int(round(0.95 * (len(v) - 1))))]
    return f'p50 {statistics.median(v):.0f} / p95 {p95:.0f} / 最大 {v[-1]:.0f} ms（n={len(v)}）'


def pct(v, q):
    v = sorted(x for x in v if x is not None)
    if not v:
        return None
    return statistics.median(v) if q == 50 else v[min(len(v) - 1, int(round(q / 100 * (len(v) - 1))))]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--repeat', type=int, default=1)
    args = ap.parse_args()
    key = os.environ.get('GEMINI_RECOMMEND_API_KEY', '')
    if not key:
        sys.exit('GEMINI_RECOMMEND_API_KEY が必要です')
    register_secret(key)
    say(f'git_sha={os.environ.get("GIT_SHA", "unknown")}  model={c.MODEL_ID}  thinking={c.THINKING_LEVEL}  '
        f'stream=true  tools=なし  プロンプト/スキーマ=recommender.build_request_body（変更なし）')
    rows = []
    plan = [q for _ in range(args.repeat) for q in QUERIES]
    for i, q in enumerate(plan, 1):
        m, tr = run_stream(key, q)
        ev = evaluate(m, tr)
        cands = tr.candidates
        early = [cd['early_t'] for cd in cands]
        full = [cd['full_t'] for cd in cands]
        rows.append({'m': m, 'ev': ev, 'early': early, 'full': full})
        u = m['usage']
        say(f'\n({i}) [{q}] 最初のSSE={m["first_event_ms"]} 思考={m["thought_start_ms"]}→{m["thought_stop_ms"]} '
            f'最初のテキスト={m["first_text_ms"]} 完了={m["completed_ms"]} 終了={m["end_ms"]} ms  status={m["status"]}'
            + (f'  エラー={m["error"]}' if m['error'] else ''))
        say('    店舗の確定時刻 early(名前・地区)/full(全項目): ' +
            ' | '.join(f'{k + 1}:{e}/{f}' for k, (e, f) in enumerate(zip(early, full))))
        say(f'    出力検証={ev["validate_error"] or "OK"} 件数={ev["n_final"]} 逐次確定と最終の一致={ev["stream_matches_final"]} '
            f'構文異常={ev["syntax_errors"] or "なし"}  tokens: 出力={u.get("total_output_tokens")} '
            f'思考={u.get("total_thought_tokens")} 入力={u.get("total_input_tokens")}')
        say('    店舗: ' + ' / '.join(f'{(cd["obj"] or cd["fields"]).get("name", "?")}' for cd in cands))
        time.sleep(2)
    report(rows)
    say(f'\n出力への API キー残存: {"あり（要確認）" if contains_secret(chr(10).join(OUT)) else "なし"}')


def report(rows):
    n = len(rows)
    say('\n================ M1 集計 ================')
    say(f'試行 {n} 回')

    def col(key):
        return [r['m'][key] for r in rows]

    say(f'  API送信→最初のSSEイベント: {stats(col("first_event_ms"))}')
    say(f'  思考ステップ終了: {stats(col("thought_stop_ms"))}')
    say(f'  最初のテキストチャンク（TTFT）: {stats(col("first_text_ms"))}')
    for k in range(7):
        e = [r['early'][k] if len(r['early']) > k else None for r in rows]
        f = [r['full'][k] if len(r['full']) > k else None for r in rows]
        say(f'  {k + 1}店舗目 early（rank・name・area_hint）: {stats(e)}')
        say(f'  {k + 1}店舗目 full （全必須項目・独立検証可）: {stats(f)}')
    say(f'  全出力の終了（interaction.completed）: {stats(col("completed_ms"))}')
    ok7 = sum(1 for r in rows if r['ev']['validate_error'] is None and r['ev']['n_final'] == 7)
    okany = sum(1 for r in rows if r['ev']['validate_error'] is None)
    say(f'\n  出力検証 OK: {okany}/{n}（うち 7 店舗: {ok7}/{n}）')
    errs = {}
    for r in rows:
        k = r['m']['error'] or r['ev']['validate_error']
        if k:
            errs[k] = errs.get(k, 0) + 1
    say(f'  不正・途中切断・順位不整合・重複など: {errs or "なし"}')
    mism = sum(1 for r in rows if r['ev']['stream_matches_final'] is False)
    say(f'  逐次確定した店舗と最終検証結果の不一致: {mism} 件')
    outs = [r['m']['usage'].get('total_output_tokens') for r in rows]
    th = [r['m']['usage'].get('total_thought_tokens') for r in rows]
    say(f'  出力トークン: p50 {pct(outs, 50)} / 最大 {max([x for x in outs if x is not None], default=None)}  '
        f'思考トークン: p50 {pct(th, 50)} / 最大 {max([x for x in th if x is not None], default=None)}')

    say('\n【判定基準】')
    for label, idx in (('early', 'early'), ('full', 'full')):
        first = [r[idx][0] if r[idx] else None for r in rows]
        fifth = [r[idx][4] if len(r[idx]) > 4 else None for r in rows]
        p50_1, p95_5 = pct(first, 50), pct(fifth, 95)
        within5 = sum(1 for x in first if x is not None and x <= 5000)
        say(f'  [{label}] 1店舗目 p50={p50_1} ms（基準 ≤4000: {"達成" if p50_1 is not None and p50_1 <= 4000 else "未達"}） / '
            f'5店舗目 p95={p95_5} ms（基準 ≤8000: {"達成" if p95_5 is not None and p95_5 <= 8000 else "未達"}） / '
            f'1店舗目が5秒以内の試行 {within5}/{n}')
    say(f'  7店舗の生成成功率: {ok7}/{n}')


if __name__ == '__main__':
    main()
