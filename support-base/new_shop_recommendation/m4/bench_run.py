# -*- coding: utf-8 -*-
"""
M4 T4: 33 秒版と S10 の比較試験（隔離したプレビュー・リビジョンの /api/m4/bench を呼ぶだけ。本番キーは扱わない）

  python -m new_shop_recommendation.m4.bench_run <tag_url> <token_file> [repeat=3]

- 未使用 10 クエリ × repeat 回 × {33, S10} を順番に実行し、~/m4_bench.json に保存する（LLM の出力・place ID・時刻のみ）
- 人による品質判定（T5）用に、方式を伏せた評価シート ~/m4_eval_sheet.tsv と対応表 ~/m4_eval_key.tsv を作る
  評価シートの列: 評価ID / クエリ / 推薦名 / 推薦の地区 / Google マップのリンク（place ID）/ 同一性(O,X,?,Z) /
                  ジャンル / 地域 / 予算 / 人数・個室 / 利用目的 / 説明の事実性 / 説明文
"""
import json
import os
import random
import sys
import time

import requests

from new_shop_recommendation.m4.queries import M4_QUERIES

MAPS_LINK = 'https://www.google.com/maps/search/?api=1&query=Google&query_place_id={}'


def call(url, token, q, method):
    t = time.time()
    try:
        r = requests.post(f'{url}/api/m4/bench', json={'query': q, 'method': method},
                          headers={'X-M4-Bench-Token': token}, timeout=150)
    except requests.exceptions.RequestException as e:
        return {'method': method, 'error': f'network:{type(e).__name__}', 'stores': [], 'wall_s': round(time.time() - t, 1)}
    if r.status_code != 200:
        return {'method': method, 'error': f'http_{r.status_code}', 'stores': [], 'wall_s': round(time.time() - t, 1)}
    d = r.json()
    d['wall_s'] = round(time.time() - t, 1)
    return d


def adopted(res):
    """カードとして表示される店舗（33 秒版は Places で見つかった上位 5 件、S10 は最終カード）"""
    if res.get('method') == '33':
        return [s for s in res.get('stores') or [] if s.get('place_id')][:5]
    return res.get('stores') or []


def main():
    url, token_file = sys.argv[1].rstrip('/'), sys.argv[2]
    repeat = int(sys.argv[3]) if len(sys.argv) > 3 else 3
    token = open(token_file).read().strip()
    home = os.path.expanduser('~')
    out_path = os.path.join(home, 'm4_bench.json')
    results = []
    for rep in range(1, repeat + 1):
        for qi, q in enumerate(M4_QUERIES, 1):
            for method in ('33', 'S10'):
                res = call(url, token, q, method)
                results.append({'rep': rep, 'qi': qi, 'q': q, 'method': method, 'result': res})
                json.dump(results, open(out_path, 'w'), ensure_ascii=False)
                n = len(adopted(res))
                extra = (f' 先行={res.get("t_preview")} 最終={res.get("t_final")} 状態={res.get("status")} 不足={res.get("shortfall")}'
                         if method == 'S10' else f' 推薦={res.get("t_rec")} 完了={res.get("t_done")}')
                print(f'[{rep}-{qi:02d}] {method:>3} {q[:24]} | カード {n} 件 | {res.get("error") or "OK"}{extra} | {res.get("wall_s")}s',
                      flush=True)
    # ---- 方式を伏せた評価シート
    rows, key = [], []
    for it in results:
        for s in adopted(it['result']):
            rows.append((it['q'], s))
            key.append((it['method'], it['rep'], it['qi'], s.get('rank'), s.get('place_id')))
    order = list(range(len(rows)))
    random.Random(20261114).shuffle(order)
    order.sort(key=lambda i: M4_QUERIES.index(rows[i][0]))
    with open(os.path.join(home, 'm4_eval_sheet.tsv'), 'w', encoding='utf-8') as f, \
            open(os.path.join(home, 'm4_eval_key.tsv'), 'w', encoding='utf-8') as k:
        f.write('評価ID\tクエリ\t推薦名\t推薦の地区\tGoogleマップ\t同一性(O/X/?/Z)\tジャンル\t地域\t予算\t人数・個室\t利用目的\t説明の事実性\t説明文\n')
        k.write('評価ID\t方式\t回\tクエリ番号\t順位\tplace_id\n')
        for n, i in enumerate(order, 1):
            q, s = rows[i]
            desc = ((s.get('specialty') or '') + ' / ' + (s.get('description') or '')).replace('\t', ' ').replace('\n', ' ')
            f.write(f'E{n:04d}\t{q}\t{s.get("rec")}\t{s.get("hint")}\t{MAPS_LINK.format(s.get("place_id"))}\t\t\t\t\t\t\t\t{desc}\n')
            k.write('E{:04d}\t{}\t{}\t{}\t{}\t{}\n'.format(n, *key[i]))
    print(f'\n保存: {out_path}（{len(results)} 件）、評価シート ~/m4_eval_sheet.tsv（{len(rows)} 行・方式を伏せています）、対応表 ~/m4_eval_key.tsv')


if __name__ == '__main__':
    main()
