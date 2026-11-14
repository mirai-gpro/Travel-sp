# -*- coding: utf-8 -*-
"""
M4 事前確認（フロント実装の前に確定する項目）
  1. M3 保存データ 30 試行で、二段階・先行 1 枚（設計書 §2 ④）の値を確定する（API 呼び出しなし）
  2. R1（検索範囲）を、M3 の 10 クエリと M4 の未使用 10 クエリで実地確認する（Geocoding だけを呼ぶ。推薦・照合はしない）

  python -m new_shop_recommendation.m4.precheck <m3_results.json> <m3_labels.tsv>
"""
import json
import sys

from new_shop_recommendation import scope as S
from new_shop_recommendation.flow_s import HttpApis
from new_shop_recommendation.poc import gate_m3_analyze as an
from new_shop_recommendation.poc import gate_m3_score as sc
from new_shop_recommendation.poc.gate_m3_flow_s import QUERIES as M3_QUERIES
from new_shop_recommendation.m4.queries import M4_QUERIES


def two_stage_all(results, lab):
    trials = [(t['trial'], t['q'], t['S10']) for t in results if 'S10' in t and 'error' not in t['S10']]
    out = [(tr, q, r, an.analyze_trial(r, lab)) for tr, q, r in trials]
    an.print_two_stage(out, lab)
    print('\n  試行別（先行カード: 時刻ms/正誤/最終に残ったか、最終: 時刻ms/5 件全て O か、位置が変わった枚数）')
    for tr, _q, r, _a in out:
        x = an.two_stage(r)
        p = x['preview'][0] if x['preview'] else None
        ids = [s['place_id'] for s in x['final']]
        fin_ok = len(x['final']) == 5 and all(an._lbl(lab, s) == 'O' for s in x['final'])
        print(f'  {tr}: 先行 {x["t_preview"]}/{an._lbl(lab, p) if p else "-"}/{"残" if p and p["place_id"] in ids else "消"}'
              f' 最終 {x["t_final"]}/{"5O" if fin_ok else "x"} 移動{x["moved"]}')


def scope_check():
    apis = HttpApis('', '')
    print('\n## R1 検索範囲の実地確認（Geocoding のみ）')
    print('| 区分 | クエリ | 地名 | 半径km | 根拠 | 認めた地名 |')
    print('|---|---|---|---:|---|---|')
    for kind, qs in (('M3', M3_QUERIES), ('M4', M4_QUERIES)):
        for q in qs:
            s = S.resolve_scope(q, apis.geocode)
            print(f'| {kind} | {q} | {s["area"] or "（なし）"} | {round(s["radius_km"], 1)} | {s["radius_reason"]}/{s["scope_reason"]} | '
                  f'{"・".join(s["places"])} |')


def main():
    results = json.load(open(sys.argv[1], encoding='utf-8'))
    lab = sc.load_labels(sys.argv[2])
    print('## §5c 二段階表示（M3 保存データ・S10・30 試行・10 秒）')
    two_stage_all(results, lab)
    scope_check()


if __name__ == '__main__':
    main()
