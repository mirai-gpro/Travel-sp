# -*- coding: utf-8 -*-
"""
Gate M3 事後分析（API 呼び出しなし）。保存済み結果 JSON と独立判定ラベルだけを使う。

  python -m new_shop_recommendation.poc.gate_m3_analyze <results.json> <labels.tsv> [S10]

出力:
  1. 試行ごとの「正しい店舗数 / 不足数 / 原因 / 改善対象工程」（10 秒時点・既定は S10）
  2. 原因の集計
  3. 試行ごとの詳細（推薦A の全候補・照合経路・判定・確定時刻・推薦B の説明文）… 条件適合の評価用
  4. SAME 経路で X / ? になった店舗の判定理由と検索範囲
  5. 段階表示した場合の差し替え（上位候補の後着でカードが押し出される）発生数
  6. D 方式の採用カード（比較用）

原因コード（1 試行に複数付く）:
  FEWER_CARDS    10 秒時点でカードが 5 枚未満
  WRONG_SAME     採用カードが X（別店舗）・経路 SAME（軽量判定の誤採用）
  WRONG_LLM      採用カードが X・経路 LLM（選択 LLM の誤選択）
  UNKNOWN        採用カードが ?（判定不能。正解に含めない）
  CLOSED         採用カードが Z（閉業）
  MISS_LIGHT     不採用店舗の検索 1 位が O（軽量判定が DIFFERENT で取りこぼし）
  MISS_LLM       不採用店舗の検索 1 位が O（選択 LLM が none / 誤った候補を選び取りこぼし）
  NOT_FOUND      不採用店舗の検索 1 位が X/?/Z または候補なし（Maps 上で推薦店を確認できず）
  LATE           正しい店舗が 10 秒より後に確定（時間無制限なら採用されていた）
  DUPLICATE      place_id 重複で後順位を除外
  CAP_PUSHED     10 秒以内に確定した O の店舗が 5 枚上限で押し出された（上位に X/?/Z があった場合）
"""
import json
import sys

from new_shop_recommendation.poc import gate_m3_score as sc
from new_shop_recommendation.poc import m3_core as m3

DEADLINE_MS = 10000
STAGE = {
    'FEWER_CARDS': '（下記の内訳）', 'WRONG_SAME': '軽量判定・検索範囲', 'WRONG_LLM': '選択LLM', 'UNKNOWN': '評価（判定不能）',
    'CLOSED': '軽量判定（閉業）', 'MISS_LIGHT': '軽量判定', 'MISS_LLM': '選択LLM', 'NOT_FOUND': '推薦A（実在性）・検索',
    'LATE': '照合の所要時間', 'DUPLICATE': '推薦A（同一店の重複）', 'CAP_PUSHED': '上位カードの誤り',
}


def lab_of(lab, rec, pid):
    return lab.get((rec, pid), 'unlabeled') if pid else None


def analyze_trial(r, lab, deadline=DEADLINE_MS):
    stores = sorted([s for s in r['stores'] if s.get('rank') is not None], key=lambda s: s['rank'])
    a = m3.adopt(stores, deadline)
    card_ids = {id(s) for s in a['cards']}
    cards = [(s, lab_of(lab, s['rec'], s['place_id'])) for s in a['cards']]
    n_ok = sum(1 for _s, l in cards if l == 'O')
    causes = []
    if len(cards) < 5:
        causes.append('FEWER_CARDS')
    for s, l in cards:
        path = (s.get('path') or '').split(':')[0]
        if l == 'X':
            causes.append('WRONG_SAME' if path == 'same' else 'WRONG_LLM')
        elif l == '?':
            causes.append('UNKNOWN')
        elif l == 'Z':
            causes.append('CLOSED')
        elif l == 'unlabeled':
            causes.append('UNLABELED')
    seen, rows = set(), []
    for s in stores:
        path = (s.get('path') or '')
        base = path.split(':')[0]
        pid = s.get('place_id')
        lbl = lab_of(lab, s['rec'], pid)
        t1 = lab_of(lab, s['rec'], s.get('top1')) if not pid else None
        note = ''
        late = s.get('t_done') is None or s['t_done'] > deadline
        if pid:
            if pid in seen and not late:
                note = 'DUPLICATE'
            elif id(s) in card_ids:
                note = 'CARD'
            elif late:
                note = 'LATE' if lbl == 'O' else 'late'
            elif lbl == 'O':
                note = 'CAP_PUSHED' if len(cards) == 5 and any(l != 'O' for _c, l in cards) else 'spare'
            else:
                note = 'spare'
            if not late:
                seen.add(pid)
        else:
            if t1 == 'O':
                note = 'MISS_LIGHT' if base == 'all_different' else 'MISS_LLM'
            else:
                note = 'NOT_FOUND'
        rows.append({'rank': s['rank'], 'rec': s['rec'], 'hint': s.get('hint'), 'path': path, 'label': lbl,
                     'top1_label': t1, 'note': note, 't_done': s.get('t_done'), 'verdicts': s.get('verdicts') or []})
        if note in ('DUPLICATE', 'LATE', 'CAP_PUSHED', 'MISS_LIGHT', 'MISS_LLM'):
            causes.append(note)
    if 'FEWER_CARDS' in causes:
        # 5 枚未満の内訳: 不採用（Maps 確認不可）・取りこぼし・期限超過・重複
        for x in rows:
            if x['note'] == 'NOT_FOUND':
                causes.append('NOT_FOUND')
    return {'n_ok': n_ok, 'short': 5 - n_ok, 'n_cards': len(cards), 'cards': cards, 'rows': rows,
            'causes': causes, 't_set': a['t_set']}


def replacement_events(r, deadline=DEADLINE_MS):
    """確定順にカードを即時表示した場合、上位候補の後着で既表示カードが 5 枚から押し出される回数"""
    stores = [s for s in r['stores'] if s.get('rank') is not None and s.get('t_done') is not None
              and s['t_done'] <= deadline]
    shown, events, seen = [], 0, set()
    for s in sorted(stores, key=lambda x: x['t_done']):
        if not s.get('place_id') or s['place_id'] in seen:
            continue
        seen.add(s['place_id'])
        shown.append(s)
        shown.sort(key=lambda x: x['rank'])
        if len(shown) > 5:
            shown.pop()          # 最下位を押し出す（その店がすでに表示されていた場合のみ差し替え）
            events += 1
    return events


def main():
    results = json.load(open(sys.argv[1], encoding='utf-8'))
    lab = sc.load_labels(sys.argv[2])
    key = sys.argv[3] if len(sys.argv) > 3 else 'S10'
    trials = [(t['trial'], t['q'], t[key]) for t in results if key in t and 'error' not in t[key]]
    out = [(tr, q, r, analyze_trial(r, lab)) for tr, q, r in trials]

    print(f'## 1. {key} 試行別（10 秒時点）')
    print('| 試行 | クエリ | カード数 | 正しい | 不足 | 5件確定(ms) | 原因 | 改善対象工程 |')
    print('|---:|---|---:|---:|---:|---:|---|---|')
    for tr, q, r, a in out:
        cs = sorted(set(a['causes']), key=a['causes'].index)
        cnt = a['causes']
        tset = a['t_set'] if a['short'] == 0 else '-'
        cause_txt = ', '.join(f'{c}×{cnt.count(c)}' for c in cs) or '-'
        stage = ' / '.join(dict.fromkeys(STAGE.get(c, c) for c in cs if c != 'FEWER_CARDS'))
        print(f'| {tr} | {q} | {a["n_cards"]} | {a["n_ok"]} | {a["short"]} | {tset} | '
              f'{cause_txt} | {stage or "-"} |')

    print(f'\n## 2. 原因の集計（未達試行のみ）')
    agg = {}
    for _tr, _q, _r, a in out:
        if a['short'] > 0:
            for c in a['causes']:
                agg[c] = agg.get(c, 0) + 1
    print(f'未達 {sum(1 for *_x, a in out if a["short"] > 0)}/{len(out)} 試行: {agg}')
    allc = {}
    for _tr, _q, _r, a in out:
        for c in a['causes']:
            allc[c] = allc.get(c, 0) + 1
    print(f'全試行: {allc}')

    print(f'\n## 3. 試行別の詳細（推薦A 全候補 / 経路 / 判定 / 確定ms / 推薦B）')
    for tr, q, r, a in out:
        sc_ = r.get('scope') or {}
        print(f'\n### 試行{tr} {q} | 範囲={sc_.get("area")} 半径={round(sc_.get("radius_km") or 0, 1)}km({sc_.get("radius_reason")}) '
              f'| B完了={r["b"]["t_done"]}ms B={r["b"]["error"] or "OK"} | A完了={r["a"].get("completed_ms")}ms')
        items = r['b'].get('items') or {}
        for x in a['rows']:
            sp, rs = (items.get(str(x['rank'])) or ['', ''])[:2]
            print(f'  {x["rank"]:>2} {x["rec"]}（{x["hint"]}） | {x["path"]} | 判定={x["label"] or "-"} '
                  f'1位={x["top1_label"] or "-"} | {x["note"]} | t={x["t_done"]} | {",".join(x["verdicts"][:3])}')
            if x['note'] == 'CARD':
                print(f'       B: {sp} / {rs}')

    print(f'\n## 4. SAME 経路で X / ? になった店舗')
    for tr, q, r, a in out:
        for x in a['rows']:
            if x['path'] == 'same' and x['label'] in ('X', '?'):
                sc_ = r.get('scope') or {}
                print(f'  試行{tr} {q} | {x["rank"]}位 {x["rec"]}（{x["hint"]}） | {x["label"]} | {x["note"]} | '
                      f'{x["verdicts"]} | 範囲={sc_.get("area")} {round(sc_.get("radius_km") or 0, 1)}km({sc_.get("radius_reason")})')

    print(f'\n## 5. 確定順に即時表示した場合の差し替え')
    ev = [(tr, replacement_events(r)) for tr, _q, r, _a in out]
    print(f'差し替え発生 {sum(1 for _t, e in ev if e)}/{len(ev)} 試行、合計 {sum(e for _t, e in ev)} 回: '
          f'{[(t, e) for t, e in ev if e]}')

    print('\n## 6. D 方式の採用カード（比較用・時間無制限）')
    for t in results:
        d = t.get('D')
        if not d or 'error' in d:
            continue
        cards = m3.adopt(d['stores'], None)['cards']
        print(f'  試行{t["trial"]} {t["q"]} | ' + ' / '.join(
            f'{s["rank"]}.{s["rec"]}[{lab_of(lab, s["rec"], s["place_id"])}]' for s in cards))


if __name__ == '__main__':
    main()
