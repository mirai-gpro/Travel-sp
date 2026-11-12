# -*- coding: utf-8 -*-
"""
PoC Step 1+2 ベンチ（DESIGN.md §8）。実際の Gemini / Places を呼び、時間と照合結果を記録する。
本番の Cloud Run・トラフィック・設定には一切触れない。
- Google 検索は実行しない（Step 1〜2。LLM の freshness 判断と理由を記録するだけ）
- 画面出力・JSON には API キーを含めない（保存前に検査し、見つかれば保存せず異常終了）
- T5 / T6 はサーバー側のカード確定時刻であり、ブラウザでの表示時刻ではない

  python -m shop_engine.poc_bench --list-models
  python -m shop_engine.poc_bench --models gemini-2.5-flash --thinking-budgets 0,none --repeat 2

環境変数: GEMINI_API_KEY, GOOGLE_PLACES_API_KEY
"""
import argparse
import json
import os
import statistics
import sys
import time
from datetime import datetime, timezone

DEFAULT_QUERIES = [
    '中目黒 イタリアン 美味しい店',
    '中目黒 焼き鳥 美味しい店',
    '中目黒 焼き鳥 予算1人5000円 2名',
    '横浜 焼き鳥 美味しい店',
    '新宿 接待向けの和食',
    '渋谷 最近オープンしたカフェ',
    '京都 評判の良い老舗料理店',
    '横浜 最近リニューアルしたレストラン',
]


def pct(values, p):
    if not values:
        return None
    v = sorted(values)
    k = max(0, min(len(v) - 1, int(round(p / 100.0 * (len(v) - 1)))))
    return v[k]


def fmt(x):
    return '—' if x is None else f'{x:.2f}'


_print = print


def list_models(client):
    names = []
    for m in client.models.list():
        actions = getattr(m, 'supported_actions', None) or []
        if 'generateContent' in actions or not actions:
            names.append(m.name.replace('models/', ''))
    return sorted(names)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--list-models', action='store_true')
    ap.add_argument('--models', default='gemini-2.5-flash')
    ap.add_argument('--thinking-budgets', default='none', help="カンマ区切り。'none' は指定しない（モデル既定）")
    ap.add_argument('--candidates', type=int, default=8)
    ap.add_argument('--repeat', type=int, default=1)
    ap.add_argument('--queries', default='', help='1行1件のファイル。省略時は既定の評価クエリ')
    ap.add_argument('--out', default='')
    args = ap.parse_args()

    from google import genai
    from google.genai import types

    from shop_engine.pipeline import TIMING_NOTE, EngineConfig, RecommendationRun
    from shop_engine.places import PlacesClient
    from shop_engine.redact import find_leaks, redact, register_secret

    gkey = os.environ.get('GEMINI_API_KEY')
    pkey = os.environ.get('GOOGLE_PLACES_API_KEY')
    if not gkey or not pkey:
        sys.exit('GEMINI_API_KEY / GOOGLE_PLACES_API_KEY が設定されていません')
    register_secret(gkey)
    register_secret(pkey)
    client = genai.Client(api_key=gkey)

    global _print
    _print = lambda *a: print(*(redact(x) for x in a))  # noqa: E731  画面出力も必ず伏せ字化

    if args.list_models:
        print('利用可能なモデル（generateContent 対応）:')
        for n in list_models(client):
            print('  ', n)
        return

    queries = DEFAULT_QUERIES
    if args.queries:
        with open(args.queries, encoding='utf-8') as f:
            queries = [l.strip() for l in f if l.strip()]
    budgets = [None if b.strip() == 'none' else int(b) for b in args.thinking_budgets.split(',')]
    models = [m.strip() for m in args.models.split(',') if m.strip()]
    places = PlacesClient(pkey)

    runs = []
    for model in models:
        for budget in budgets:
            for q in queries:
                for rep in range(args.repeat):
                    cfg = EngineConfig(model=model, n_candidates=args.candidates, thinking_budget=budget)
                    r = RecommendationRun(q, client, types, places, cfg)
                    res = r.run()
                    res['repeat'] = rep + 1
                    runs.append(res)
                    print_run(res)
                    time.sleep(1)

    print_summary(runs)
    out = args.out or f"shop_engine_poc_{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}.json"
    payload = json.dumps({'git_sha': os.environ.get('POC_GIT_SHA', ''), 'google_search_executed': False,
                          'timing_note': TIMING_NOTE, 'runs': runs}, ensure_ascii=False, indent=1)
    leaks = find_leaks(payload)
    if leaks:
        sys.exit(f'JSON に API キーらしき値が残っているため保存しません（{leaks}）')
    with open(out, 'w', encoding='utf-8') as f:
        f.write(payload)
    _print(f'\n詳細(JSON): {out}')


def print_run(res):
    t = res['timings']
    fr = (res.get('plan') or {}).get('freshness') or {}
    _print('\n' + '=' * 100)
    _print(f"[{res['model']} think={res['thinking_budget']}] {res['user_request']} (#{res['repeat']}) "
          f"status={res['status']} cards={len(res['cards'])} error={res.get('error') or '-'}")
    _print(f"  T1(最初の応答)={fmt(t.get('T1'))} T1p(plan)={fmt(t.get('T1p'))} T1c(候補1)={fmt(t.get('T1c'))} "
          f"T2(LLM完了)={fmt(t.get('T2'))} T3={fmt(t.get('T3'))} T4={fmt(t.get('T4'))} "
          f"T5(初回カード確定・サーバー)={fmt(t.get('T5'))} T6(5件目確定・サーバー)={fmt(t.get('T6'))} T7(完了)={fmt(t.get('T7'))}")
    _print(f"  freshness 判断（記録のみ・Google 検索は未実行）: required={fr.get('required')} central={fr.get('central')} "
           f"query='{fr.get('query', '')}' reason='{fr.get('reason', '')}'")
    _print('  カード（表示順）:')
    for c in res['cards']:
        _print(f"    {c['display_rank']}. {c['name']}  ← LLM:{c['llm_name']}（推薦{c['recommend_rank']}位, S={c['verification']['score']}）"
              f" | {c['category']} | {c['priceRange']}")
        _print(f"       理由: {c['description'][:120]}")
    _print('  全候補の照合:')
    for v in res['verifications']:
        d = v['detail'] or {}
        ev = d.get('evaluated') or []
        top = ', '.join(f"{e['place_name']}(S={e['score']},L={e['location']},d={e['distance_km']})" for e in ev[:3])
        st = '未照合（5件確定後のため不要）' if v['status'] == 'PENDING' else v['status']
        _print(f"    {v['rank']}. {v['name']} → {st}  [{top or d.get('error', '')}]")
    if res.get('llm_bad_lines'):
        _print(f"  解析できなかった行: {len(res['llm_bad_lines'])}")


def print_summary(runs):
    from shop_engine.pipeline import TIMING_NOTE
    _print('\n' + '#' * 100)
    _print('集計（success = 5件確定。upstream_error / timeout / error / short / no_candidates は分けて数える）')
    keys = sorted({(r['model'], str(r['thinking_budget'])) for r in runs})
    _print('| モデル | think | 回数 | ok | short | 失敗 | 初回候補T1c 中央/p95/最大 | 初回カード確定T5(サーバー) 中央/p95/最大 | 5件目確定T6(サーバー) 中央/p95/最大 | VERIFIED率 | 検索要と判断(未実行) |')
    _print('|---|---|---:|---:|---:|---:|---|---|---|---:|---:|')
    for model, budget in keys:
        rs = [r for r in runs if r['model'] == model and str(r['thinking_budget']) == budget]
        ok = [r for r in rs if r['status'] == 'ok']
        short = [r for r in rs if r['status'] == 'short']
        fail = [r for r in rs if r['status'] not in ('ok', 'short')]
        good = ok + short

        def trio(k, src):
            v = [r['timings'][k] for r in src if k in r['timings']]
            return f"{fmt(statistics.median(v) if v else None)}/{fmt(pct(v, 95))}/{fmt(max(v) if v else None)}"
        ver = [v['status'] for r in good for v in r['verifications'] if v['status'] != 'PENDING']
        rate = f"{100.0 * ver.count('VERIFIED') / len(ver):.0f}%" if ver else '—'
        fr = sum(1 for r in rs if ((r.get('plan') or {}).get('freshness') or {}).get('required'))
        _print(f"| {model} | {budget} | {len(rs)} | {len(ok)} | {len(short)} | {len(fail)} | {trio('T1c', good)} | "
              f"{trio('T5', good)} | {trio('T6', ok)} | {rate} | {fr} |")
    _print('注: 時間はサーバー内の秒（T0 起点）。' + TIMING_NOTE + '。ブラウザでの表示時刻は Step 4 で別途計測する。')
    _print('注: Google 検索は実行していない。「検索要と判断」は LLM の判断回数（Step 3 で検証）。')


if __name__ == '__main__':
    main()
