# -*- coding: utf-8 -*-
"""
設計 v0.2 のオフライン評価（API 呼び出しなし。既存の実測データだけを使う）

  python -m new_shop_recommendation.poc.eval_v02_offline

1. 品質: 照合済み 132 件（推薦店 118）に軽量判定（light_identity）を適用し、方式 D・E と比較する。
   候補は「Agent Tools 検索 1 位」（D1.7E で D・E が採用した店舗。どちらも 1 位を採用していた）。
   ラベルの無い店舗は正解と推定しない（判定不能として別枠）。
2. 速度: M1 の店舗ごとの確定時刻（30 試行）と D1.7E の Agent Tools・Details・選択 LLM の実測値を組み合わせた
   モンテカルロ（中央値の単純加算ではない）。店舗ごとの成否は D1.7E の各試行に登場した推薦店の評価結果を使う。
"""
import json
import os
import random
import statistics

from new_shop_recommendation.poc import gate_m2_resolve_names as m2
from new_shop_recommendation.poc import light_identity as L

HERE = os.path.dirname(os.path.abspath(__file__))
# 地区チェックの代替（オフラインでは座標が無いため、検索エリアの市区で判定。統合 PoC では中心からの距離で判定する）
ALLOWED_MUNICIPALITIES = {0: ['横浜市'], 1: ['中央区'], 2: ['渋谷区'], 3: ['新宿区', '渋谷区'], 4: ['武蔵野市'],
                          5: ['千代田区', '中央区'], 6: ['目黒区', '渋谷区'], 7: ['札幌市中央区'],
                          8: ['東山区', '下京区', '中京区'], 9: ['大阪市北区']}
DEADLINE_MS, FIRST_MS = 10000, 5000


def load_pairs():
    addr = {}
    for line in open(os.path.join(HERE, 'm2_pair_addresses.tsv'), encoding='utf-8'):
        if line.startswith('R'):
            rid, a = line.rstrip('\n').split('\t')
            addr[rid] = a
    pairs = []
    for line in open(os.path.join(HERE, 'm2_labeled_pairs.tsv'), encoding='utf-8'):
        if line.startswith('R'):
            rid, q, tr, rec, hint, card, by, v = line.rstrip('\n').split('\t')
            pairs.append({'rid': rid, 'qidx': int(q), 'trials': {int(t) for t in tr.split(',')}, 'rec': rec,
                          'hint': hint, 'card': card, 'by': by, 'label': v, 'addr': addr[rid]})
    return pairs


def judge_pair(p):
    return L.judge(p['rec'], {'name': p['card'], 'address': p['addr']}, m2.REGION[p['qidx']],
                   allowed_municipalities=ALLOWED_MUNICIPALITIES[p['qidx']])


def group_outcomes(pairs):
    """推薦店（クエリ × 店名）ごとに各方式の結果を求める。値: 'O' / 'X' / '?' / None（カードなし）"""
    groups = {}
    for p in pairs:
        g = groups.setdefault((p['qidx'], p['rec']), {'qidx': p['qidx'], 'rec': p['rec'], 'trials': set(),
                                                      'pairs': [], 'has_o': False})
        g['trials'] |= p['trials']
        g['pairs'].append(p)
        g['has_o'] |= p['label'] == 'O'
    for g in groups.values():
        def card_label(method):
            ls = [p['label'] for p in g['pairs'] if method in p['by']]
            return 'X' if 'X' in ls else ('O' if 'O' in ls else ('?' if '?' in ls else None))
        g['D'], g['E'], g['A'] = card_label('D'), card_label('E'), card_label('A')
        # Agent Tools 検索 1 位 = E の採用店（E が上限で押し出された場合は D の採用店。D は全件 1 位を採用していた）
        top = [p for p in g['pairs'] if 'E' in p['by']] or [p for p in g['pairs'] if 'D' in p['by']]
        g['top1'] = top[0] if top else None
        if g['top1'] is None:
            g['light'], g['light_reason'] = None, 'no_agent_tools_candidate_in_log'
        else:
            j, why = judge_pair(g['top1'])
            g['light_judgment'], g['light_reason'] = j, why
            g['light'] = g['top1']['label'] if j == L.SAME else None
        g['light_esc'] = g['light'] if g.get('light_judgment') != L.AMBIGUOUS else g['D']
    return list(groups.values())


def tally(groups, key):
    o = sum(1 for g in groups if g[key] == 'O')
    x = sum(1 for g in groups if g[key] == 'X')
    q = sum(1 for g in groups if g[key] == '?')
    miss = sum(1 for g in groups if g['has_o'] and g[key] != 'O')
    return o, x, q, miss


# ------------------------------------------------------------------ 速度（モンテカルロ）
def simulate(groups, data, mode, iters=20000, seed=7, esc_ms=None):
    """
    mode: 'light' 軽量判定のみ / 'light_esc' 曖昧だけ選択 LLM / 'D' 全店舗選択 LLM / 'E' 1 位即採用
    esc_ms: None=実測の選択 LLM 時間（7 店舗一括の値）を店舗ごとに使う / 数値=その時間で固定（仮定）
    """
    rnd = random.Random(seed)
    by_trial = {t: [g for g in groups if t in g['trials']] for t in range(1, 31)}
    early, at, det, sel = data['m1_early'], data['d17e_agent_tools'], data['d17e_details'], data['d17e_selection_llm']
    res = {'first': [], 'complete5': 0, 'wrong': [], 'five_cards': 0, 't5': [], 'n': iters}
    for _ in range(iters):
        e = rnd.choice(early)
        comp = list(by_trial[rnd.randint(1, 30)])
        slots = comp + [None] * max(0, 7 - len(comp))
        slots = slots[:7]
        rnd.shuffle(slots)                     # 推薦順位はログから復元できないため無作為に並べる
        cards = []                             # (rank, time, label)
        for k, g in enumerate(slots):
            if g is None or g['top1'] is None:
                continue                       # 候補なし（どの方式もカードにしなかった推薦店）
            t = e[k] + rnd.choice(at) + rnd.choice(det)
            if mode == 'E':
                lab = g['E'] if g['E'] is not None else g['D']
            elif mode == 'D':
                t += esc_ms if esc_ms is not None else rnd.choice(sel)
                lab = g['D']
            else:
                j = g['light_judgment']
                if j == L.SAME:
                    lab = g['top1']['label']
                elif j == L.AMBIGUOUS and mode == 'light_esc':
                    t += esc_ms if esc_ms is not None else rnd.choice(sel)
                    lab = g['D']
                else:
                    lab = None
            if lab is not None:
                cards.append((k, t, lab))
        ready = sorted([c for c in cards if c[1] <= DEADLINE_MS], key=lambda c: c[0])[:5]   # 推薦順位で最大 5 件
        if cards:
            res['first'].append(min(c[1] for c in cards))
        res['wrong'].append(sum(1 for c in ready if c[2] == 'X'))
        if len(ready) == 5:
            res['five_cards'] += 1
            if all(c[2] == 'O' for c in ready):
                res['complete5'] += 1
                res['t5'].append(max(c[1] for c in ready))
    return res


def pct(v, q):
    v = sorted(v)
    if not v:
        return None
    return v[min(len(v) - 1, int(round(q / 100 * (len(v) - 1))))]


def main():
    pairs = load_pairs()
    groups = group_outcomes(pairs)
    print('================ 品質（推薦店単位。照合済み 132 件／推薦店 118） ================')
    print('ペア単位の軽量判定:')
    from collections import Counter
    pc = Counter((judge_pair(p)[0], p['label']) for p in pairs)
    for j in (L.SAME, L.AMBIGUOUS, L.DIFFERENT):
        print(f'  {j:9s}: O={pc[(j, "O")]} X={pc[(j, "X")]} ?={pc[(j, "?")]}')
    known = sum(1 for g in groups if g['has_o'])
    print(f'\n推薦店 {len(groups)}（正しい実店舗が判明 {known}）。候補 = Agent Tools 検索 1 位（D/E の採用店）')
    print('| 方式 | 正しい店舗を採用 | 別店舗を採用 | 判定不能を採用 | 取りこぼし（実在判明分） |')
    print('|---|---:|---:|---:|---:|')
    for label, key in (('軽量判定のみ（SAME 即採用）', 'light'), ('軽量判定＋曖昧は選択LLM', 'light_esc'),
                       ('方式 D（全件 選択LLM）', 'D'), ('方式 E（1 位即採用）', 'E')):
        o, x, q, miss = tally(groups, key)
        print(f'| {label} | {o} | {x} | {q} | {miss} |')
    jc = Counter(g.get('light_judgment', '候補なし') for g in groups)
    print(f'\n推薦店ごとの軽量判定: {dict(jc)}')
    print('軽量判定で SAME（即採用）だが判定不能ラベルの推薦店（正解扱いしない）:')
    for g in groups:
        if g.get('light_judgment') == L.SAME and g['top1']['label'] == '?':
            print(f'   {g["rec"]} → {g["top1"]["card"]}')
    print('軽量判定で AMBIGUOUS（選択 LLM へ）:')
    for g in groups:
        if g.get('light_judgment') == L.AMBIGUOUS:
            print(f'   [{g["light_reason"]}] {g["rec"]} → {g["top1"]["card"]}（ラベル {g["top1"]["label"]} / D={g["D"]}）')
    print('軽量判定で DIFFERENT（不採用）のうち、D が正しい店舗を採用していた推薦店:')
    for g in groups:
        if g.get('light_judgment') == L.DIFFERENT and g['D'] == 'O':
            print(f'   [{g["light_reason"]}] {g["rec"]} → {g["top1"]["card"]}')

    data = json.load(open(os.path.join(HERE, 'v02_timing_data.json'), encoding='utf-8'))
    print('\n================ 速度（モンテカルロ 20,000 回。M1 × D1.7E の実測値を組み合わせ） ================')
    print('仮定: Agent Tools・Details は 7 並列のバッチ実測値を店舗ごとの時間として使う（店舗単独より長めに出る）。')
    print('      選択 LLM は 7 店舗一括の実測値を店舗ごとに使う（店舗単独の時間は未計測）。推薦順位は無作為。')
    print('| 方式 | 初回カード p50 / p95 | 初回 ≤5 秒 | 10 秒で 5 件 | 10 秒で正しい 5 件 | 5 件中の別店舗（平均） | 正しい 5 件確定 p50 / p95 |')
    print('|---|---:|---:|---:|---:|---:|---:|')
    for label, mode, esc in (('軽量判定のみ', 'light', None), ('軽量判定＋曖昧は選択LLM（実測値）', 'light_esc', None),
                             ('軽量判定＋曖昧は選択LLM（仮定 2.5 秒）', 'light_esc', 2500),
                             ('方式 D をパイプライン化（実測値）', 'D', None), ('方式 E をパイプライン化', 'E', None)):
        r = simulate(groups, data, mode, esc_ms=esc)
        n = r['n']
        f = r['first']
        print(f'| {label} | {pct(f, 50) / 1000:.1f} / {pct(f, 95) / 1000:.1f} 秒 | '
              f'{100 * sum(1 for x in f if x <= FIRST_MS) / n:.0f}% | {100 * r["five_cards"] / n:.0f}% | '
              f'{100 * r["complete5"] / n:.0f}% | {statistics.mean(r["wrong"]):.2f} | '
              + (f'{pct(r["t5"], 50) / 1000:.1f} / {pct(r["t5"], 95) / 1000:.1f} 秒 |' if r['t5'] else '— |'))
    print('\n※ 各推薦試行で照合ラベルの無い推薦店は「候補なし（カードなし）」として扱う。'
          '\n※ 品質判定は同じ 132 件で規則を調整しているため、未知のデータでの精度ではない（統合 PoC で検証する）。')


if __name__ == '__main__':
    main()
