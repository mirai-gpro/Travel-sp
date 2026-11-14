# -*- coding: utf-8 -*-
"""
Gate M3 の集計（正誤つき）。計測結果（gate_m3_flow_s が保存した JSON）と独立判定ラベルから算出する。

  python -m new_shop_recommendation.poc.gate_m3_score <results.json> <labels.tsv>

ラベル TSV: 推薦店名<TAB>place_id<TAB>O|X|?|Z   （O=推薦店と同一の実店舗 / X=別店舗 / ?=判定不能 / Z=同一店舗だが閉業）
閉業店（Z）のカードは正解に含めない（別店舗とも数えず、閉業カードとして別に数える）。
ラベルの無いカードは「未判定」として別に数え、正解には含めない。
"""
import json
import sys

from new_shop_recommendation.poc import m3_core as m3

DEADLINE_MS, FIRST_MS = 10000, 5000
METHODS = ('33', 'D', 'S7', 'S10')


def load_labels(path):
    lab = {}
    for line in open(path, encoding='utf-8'):
        if not line.strip() or line.startswith('#'):
            continue
        rec, pid, v = line.rstrip('\n').split('\t')[:3]
        lab[(rec, pid)] = v.strip()
    return lab


def label_of(lab, s):
    return lab.get((s['rec'], s['place_id']), 'unlabeled')


def trial_metrics(stores, lab, deadline=None):
    a = m3.adopt(stores, deadline)
    ls = [label_of(lab, s) for s in a['cards']]
    ok_times = [s['t_done'] for s, l in zip(a['cards'], ls) if l == 'O']
    complete = len(a['cards']) == 5 and all(l == 'O' for l in ls)
    return {'n': len(a['cards']), 'o': ls.count('O'), 'x': ls.count('X'), 'q': ls.count('?'), 'z': ls.count('Z'),
            'u': ls.count('unlabeled'), 'complete': complete, 't_set': a['t_set'] if complete else None,
            't_first_ok': min(ok_times) if ok_times else None}


def score(results, lab):
    out = {}
    for key in METHODS:
        rs = [t[key] for t in results if key in t and 'error' not in t[key]]
        errs = sum(1 for t in results if key in t and 'error' in t[key])
        if not rs and not errs:
            continue
        dl = [trial_metrics(r['stores'], lab, DEADLINE_MS) for r in rs]
        nd = [trial_metrics(r['stores'], lab, None) for r in rs]
        n = len(rs) + errs
        out[key] = {
            'trials': n, 'errors': errs,
            'wrong_10s': sum(m['x'] for m in dl), 'wrong_all': sum(m['x'] for m in nd),
            'unknown_all': sum(m['q'] for m in nd), 'unlabeled_all': sum(m['u'] for m in nd),
            'closed_all': sum(m['z'] for m in nd),
            'correct_cards_all': sum(m['o'] for m in nd),
            'complete_10s': sum(1 for m in dl if m['complete']), 'complete_all': sum(1 for m in nd if m['complete']),
            'first_ok_5s': sum(1 for m in dl if m['t_first_ok'] is not None and m['t_first_ok'] <= FIRST_MS),
            'first_ok': [m['t_first_ok'] for m in dl], 't_set': [m['t_set'] for m in dl if m['t_set'] is not None],
        }
    return out


def identity_breakdown(results, lab, key):
    """軽量判定の汎化評価（S 方式）: 採用経路ごとの O/X/?、不採用店舗の検索 1 位の正誤（取りこぼし）"""
    by_path, miss = {}, {}
    for t in results:
        r = t.get(key)
        if not r or 'error' in r:
            continue
        for s in r['stores']:
            path = (s.get('path') or '').split(':')[0]
            if s.get('place_id'):
                l = lab.get((s['rec'], s['place_id']), 'unlabeled')
                by_path.setdefault(path, {}).setdefault(l, 0)
                by_path[path][l] += 1
            elif s.get('top1'):
                l = lab.get((s['rec'], s['top1']), 'unlabeled')
                v = ((s.get('verdicts') or [''])[0] or '').split(':')[-1]
                miss.setdefault(f'{path}/{v}', {}).setdefault(l, 0)
                miss[f'{path}/{v}'][l] += 1
    return by_path, miss


def bad_cards(results, lab, key):
    """採用カードのうち X（別店舗）・Z（閉業）・?（判定不能）を列挙（試行・順位・推薦店名・経路）"""
    rows = []
    for t in results:
        r = t.get(key)
        if not r or 'error' in r:
            continue
        for s in m3.adopt(r['stores'], None)['cards']:
            l = label_of(lab, s)
            if l in ('X', 'Z', '?', 'unlabeled'):
                rows.append((t.get('trial'), t.get('q'), s.get('rank'), s['rec'], l, s.get('path'), s.get('t_done')))
    return rows


def main():
    results = json.load(open(sys.argv[1], encoding='utf-8'))
    lab = load_labels(sys.argv[2])
    sc = score(results, lab)
    print('| 方式 | 試行 | 別店舗（10秒・全） | 判定不能 | 閉業 | 未判定 | 正しい5件 10秒以内 | 正しい5件（時間無制限） | 初回の正しいカード≤5秒 | 初回 p50/p95 | 正しい5件確定 p50/p95/最大 |')
    print('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|')
    for key, s in sc.items():
        f = s['first_ok']
        ts = s['t_set']
        print(f'| {key} | {s["trials"]}（エラー{s["errors"]}） | {s["wrong_10s"]} / {s["wrong_all"]} | {s["unknown_all"]} | '
              f'{s["closed_all"]} | {s["unlabeled_all"]} | {s["complete_10s"]}/{s["trials"]} | {s["complete_all"]}/{s["trials"]} | '
              f'{s["first_ok_5s"]}/{s["trials"]} | {m3.p(f, 50)} / {m3.p(f, 95)} | '
              f'{m3.p(ts, 50)} / {m3.p(ts, 95)} / {max(ts) if ts else None} |')
    for key in ('S7', 'S10'):
        bp, miss = identity_breakdown(results, lab, key)
        if bp or miss:
            print(f'\n[{key}] 採用経路ごとの正誤: {bp}')
            print(f'[{key}] 不採用店舗の検索 1 位（経路/判定理由: 正誤）: {miss}')
    for key in sc:
        rows = bad_cards(results, lab, key)
        print(f'\n[{key}] 採用カードのうち 別店舗/閉業/判定不能/未判定（時間無制限）: {len(rows)} 件')
        for tr, q, rank, rec, l, path, td in rows:
            print(f'  試行{tr} {q} | {rank}位 {rec} | {l} | 経路={path} | 確定={td}ms')


if __name__ == '__main__':
    main()
