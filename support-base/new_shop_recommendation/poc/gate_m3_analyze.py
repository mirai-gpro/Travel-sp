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


def _decided_adopted(r, deadline=DEADLINE_MS):
    """10 秒以内に判定が終わった店舗（判定時刻順）"""
    return sorted([s for s in r['stores'] if s.get('rank') is not None and s.get('t_done') is not None
                   and s['t_done'] <= deadline], key=lambda x: (x['t_done'], x['rank']))


def replacement_events(r, deadline=DEADLINE_MS):
    """
    暫定表示（判定済みの採用店舗のうち推薦順位の上位 5 件を常に表示）をした場合の表示事象。
      replaced : 既に表示されていたカードが表示から外れた回数（真の差し替え）
      hidden   : 新しく確定した店舗が、上位 5 件に入らず表示されなかった回数（5 枚上限による非表示）
      inserted : 新しいカードが既存カードより上の順位に入り、既存カードの位置が下がった回数（差し替えではない）
      same_pid : 表示中の店と同じ place ID の別表記が確定した回数（表示は変えない）
      t_first  : 最初のカード表示時刻、t_five: 5 枚目が表示された時刻、
      shown_ever: 一度でも表示された店舗（rank の集合）
    """
    best = {}                     # place_id -> 最上位の rank（重複は上位を残す）
    visible = []                  # 表示中の place_id（順位順）
    out = {'replaced': 0, 'hidden': 0, 'inserted': 0, 'same_pid': 0, 't_first': None, 't_five': None,
           'replaced_ranks': [], 'shown_ever': set()}
    for s in _decided_adopted(r, deadline):
        pid = s.get('place_id')
        if not pid:
            continue
        if pid in best:
            if s['rank'] < best[pid]:
                best[pid] = s['rank']
            out['same_pid'] += 1
            continue
        best[pid] = s['rank']
        new_vis = [p for p, _ in sorted(best.items(), key=lambda kv: kv[1])[:5]]
        removed = [p for p in visible if p not in new_vis]
        out['replaced'] += len(removed)
        out['replaced_ranks'] += [best[p] for p in removed]
        if pid not in new_vis:
            out['hidden'] += 1
        elif visible and s['rank'] < max(best[p] for p in visible):
            out['inserted'] += 1
        visible = new_vis
        if visible and out['t_first'] is None:
            out['t_first'] = s['t_done']
        if len(visible) == 5 and out['t_five'] is None:
            out['t_five'] = s['t_done']
        out['shown_ever'] |= {best[p] for p in visible}
    return out


def append_only(r, deadline=DEADLINE_MS):
    """追記のみ表示（判定順に最大 5 件。差し替えなし、順位は保証しない）: [(store, 表示時刻)]"""
    shown, seen = [], set()
    for s in _decided_adopted(r, deadline):
        pid = s.get('place_id')
        if not pid or pid in seen:
            continue
        seen.add(pid)
        shown.append((s, s['t_done']))
        if len(shown) == 5:
            break
    return shown


def whatif(r, lab, reject_llm_x=False, fix_llm_miss=False, unknown_as_o=False, deadline=DEADLINE_MS):
    """
    既存データ上の上限計算（判定規則そのものではない。ラベルを使ったオラクル）:
      reject_llm_x : 選択 LLM 経路で X になった採用を「不採用」にしていた場合
      fix_llm_miss : 選択 LLM が none を返したが検索 1 位が O の店舗を、同じ時刻に採用していた場合
      unknown_as_o : 判定不能（?）をすべて O とみなした場合
    returns trial_metrics（10 秒）
    """
    st = []
    for s in r['stores']:
        s = dict(s)
        path = (s.get('path') or '').split(':')[0]
        if reject_llm_x and s.get('place_id') and path == 'llm' and lab_of(lab, s['rec'], s['place_id']) == 'X':
            s['place_id'] = None
        if fix_llm_miss and not s.get('place_id') and path == 'llm_none' and lab_of(lab, s['rec'], s.get('top1')) == 'O':
            s['place_id'] = s['top1']
        st.append(s)
    lb = {k: ('O' if (unknown_as_o and v == '?') else v) for k, v in lab.items()}
    return sc.trial_metrics(st, lb, deadline)


def prefix_stable(r, deadline=DEADLINE_MS):
    """上位が全て判定済みになってから表示する方式（差し替えなし）の各カード表示時刻。
    10 秒までに判定が終わらない店舗は 10 秒時点で「不採用」と確定させる"""
    stores = sorted([s for s in r['stores'] if s.get('rank') is not None], key=lambda x: x['rank'])
    t_block, shown, seen = 0, [], set()
    for s in stores:
        td = s.get('t_done')
        late = td is None or td > deadline
        t_block = max(t_block, deadline if late else td)
        if late or not s.get('place_id') or s['place_id'] in seen:
            continue
        seen.add(s['place_id'])
        shown.append((s, t_block))
        if len(shown) == 5:
            break
    return shown


def two_stage(r, multi=False, deadline=DEADLINE_MS):
    """
    二段階表示: 先行カード（判定順。multi=False は 1 枚、True は最大 5 枚）を「確認中」として出し、
    推薦順位の上位 5 件が確定した時点（上位確定後表示の 5 枚目の時刻。5 件揃わなければ締め切り）で
    推薦順位どおりの最終 5 件に並べ直す。
    returns {'t_preview','t_final','final','disappeared','moved','preview'}
      disappeared: 先行表示したが最終 5 件に入らず消えたカード数
      moved      : 先行表示したカードのうち、最終の位置が先行時の位置と異なるもの
    """
    ao = append_only(r, deadline)
    pre = ao[:5] if multi else ao[:1]
    ps = prefix_stable(r, deadline)
    final = [s for s, _t in ps]
    t_final = ps[4][1] if len(ps) == 5 else (deadline if ps else None)
    fin_ids = [s['place_id'] for s in final]
    dis = sum(1 for s, _t in pre if s['place_id'] not in fin_ids)
    moved = sum(1 for i, (s, _t) in enumerate(pre) if s['place_id'] in fin_ids and fin_ids.index(s['place_id']) != i)
    return {'t_preview': pre[0][1] if pre else None, 't_final': t_final, 'final': final, 'disappeared': dis,
            'moved': moved, 'preview': [s for s, _t in pre]}


def print_two_stage(out, lab):
    n = len(out)
    print('\n## 5c. 二段階表示（先行カード → 推薦順位どおりの最終 5 件）')
    print('| 方式 | 先行≤5秒 | 先行 p50/p95 | 先行カードが O | 最終確定 p50/p95 | 消えたカード | 位置が変わったカード | 最終 5 枚が全て O |')
    print('|---|---:|---:|---:|---:|---:|---:|---:|')
    for name, multi in (('先行 1 枚', False), ('先行 最大 5 枚', True)):
        v = [two_stage(r, multi) for _tr, _q, r, _a in out]
        tp = [x['t_preview'] for x in v]
        tf = [x['t_final'] for x in v]
        pre_ok = sum(1 for x in v if x['preview'] and _lbl(lab, x['preview'][0]) == 'O')
        dis = sum(x['disappeared'] for x in v)
        dis_lab = {}
        for x in v:
            ids = [s['place_id'] for s in x['final']]
            for s in x['preview']:
                if s['place_id'] not in ids:
                    l = _lbl(lab, s)
                    dis_lab[l] = dis_lab.get(l, 0) + 1
        ok5 = sum(1 for x in v if len(x['final']) == 5 and all(_lbl(lab, s) == 'O' for s in x['final']))
        print(f'| {name} | {sum(1 for t in tp if t is not None and t <= 5000)}/{n} | {m3.p(tp, 50)} / {m3.p(tp, 95)} | '
              f'{pre_ok}/{n} | {m3.p(tf, 50)} / {m3.p(tf, 95)} | {dis} {dis_lab} | {sum(x["moved"] for x in v)} | {ok5}/{n} |')


def _lbl(lab, s):
    return lab_of(lab, s['rec'], s['place_id'])


def print_display(out, lab):
    """§5: 表示方式の比較（10 秒・同じ 30 試行の保存データ）"""
    n = len(out)
    rows = {'暫定表示（上位 5 件を常に表示・差し替えあり）': [], '上位確定後表示（差し替えなし・順位保証）': [],
            '追記のみ（判定順・差し替えなし・順位保証なし）': []}
    tot = {'replaced': 0, 'hidden': 0, 'inserted': 0, 'same_pid': 0}
    rep_trials, rep_lab, per = 0, {}, []
    for tr, _q, r, _a in out:
        ev = replacement_events(r)
        for k in tot:
            tot[k] += ev[k]
        if ev['replaced']:
            rep_trials += 1
        for rk in ev['replaced_ranks']:
            s = next(x for x in r['stores'] if x.get('rank') == rk)
            l = _lbl(lab, s)
            rep_lab[l] = rep_lab.get(l, 0) + 1
        fin = m3.adopt(r['stores'], DEADLINE_MS)['cards']
        rows['暫定表示（上位 5 件を常に表示・差し替えあり）'].append(
            (ev['t_first'], ev['t_five'], [_lbl(lab, s) for s in fin],
             _lbl(lab, next(x for x in r['stores'] if x.get('place_id') and x.get('t_done') == ev['t_first'])) if ev['t_first'] else None))
        ps = prefix_stable(r)
        rows['上位確定後表示（差し替えなし・順位保証）'].append(
            (ps[0][1] if ps else None, ps[4][1] if len(ps) == 5 else None, [_lbl(lab, s) for s, _t in ps],
             _lbl(lab, ps[0][0]) if ps else None))
        ao = append_only(r)
        rows['追記のみ（判定順・差し替えなし・順位保証なし）'].append(
            (ao[0][1] if ao else None, ao[4][1] if len(ao) == 5 else None, [_lbl(lab, s) for s, _t in ao],
             _lbl(lab, ao[0][0]) if ao else None))
        per.append(f'{tr}:{ev["replaced"]}/{ev["hidden"]}')
    print('\n## 5. 表示方式の比較（S10・10 秒・保存データ）')
    print(f'暫定表示の事象: 真の差し替え {tot["replaced"]} 回（{rep_trials}/{n} 試行、外れたカードの正誤 {rep_lab}）'
          f' / 5 枚上限で非表示 {tot["hidden"]} 回 / 上位挿入による位置ずれ {tot["inserted"]} 回 / 同一 place の別表記 {tot["same_pid"]} 回')
    print('  試行:差し替え/非表示 ' + ' '.join(per))
    print('| 方式 | 初回カード≤5秒 | 初回 p50/p95 | 初回カードが O | 5 枚目表示≤10秒 | 5 枚目 p50/p95 | 最終 5 枚が全て O |')
    print('|---|---:|---:|---:|---:|---:|---:|')
    for name, v in rows.items():
        f = [x[0] for x in v]
        five = [x[1] for x in v]
        print(f'| {name} | {sum(1 for x in f if x is not None and x <= 5000)}/{n} | {m3.p(f, 50)} / {m3.p(f, 95)} | '
              f'{sum(1 for x in v if x[3] == "O")}/{n} | {sum(1 for x in five if x is not None)}/{n} | '
              f'{m3.p(five, 50)} / {m3.p(five, 95)} | {sum(1 for x in v if len(x[2]) == 5 and all(l == "O" for l in x[2]))}/{n} |')


def print_whatif(out, lab):
    """§7: 改善の上限（ラベルを使ったオラクル。判定規則の効果そのものではない）"""
    n = len(out)
    cases = [('現状', {}), ('選択 LLM の X 採用を不採用', {'reject_llm_x': True}),
             ('選択 LLM の取りこぼしを採用', {'fix_llm_miss': True}),
             ('上記 2 つ', {'reject_llm_x': True, 'fix_llm_miss': True}),
             ('判定不能を全て O（上限）', {'unknown_as_o': True}),
             ('上記 3 つ', {'reject_llm_x': True, 'fix_llm_miss': True, 'unknown_as_o': True})]
    print('\n## 7. 改善の上限（S10・10 秒・正しい 5 件の試行数）')
    for name, kw in cases:
        ok = [tr for tr, _q, r, _a in out if whatif(r, lab, **kw)['complete']]
        print(f'  {name}: {len(ok)}/{n} 未達={[tr for tr, *_x in out if tr not in ok]}')


def main_m4():
    results = json.load(open(sys.argv[1], encoding='utf-8'))
    lab = sc.load_labels(sys.argv[2])
    trials = [(t['trial'], t['q'], t['S10']) for t in results if 'S10' in t and 'error' not in t['S10']]
    out = [(tr, q, r, analyze_trial(r, lab)) for tr, q, r in trials]
    print_display(out, lab)
    print_two_stage(out, lab)
    print_whatif(out, lab)
    print('\n## 8. 試行 20〜30 の採用カード（10 秒・順位 / 推薦名 / 判定 / 経路 / 確定ms）')
    for tr, q, r, a in out:
        if tr >= 20:
            print(f'  試行{tr} {q} | ' + ' / '.join(f'{s["rank"]}.{s["rec"]}[{l}|{(s.get("path") or "").split(":")[0]}|{s["t_done"]}]'
                                                   for s, l in a['cards']))
    print('\n## 9. 未達試行の不採用店舗（10 秒・順位 / 推薦名 / 経路 / 検索1位の判定 / 判定理由）')
    for tr, q, r, a in out:
        if a['short'] > 0:
            miss = [x for x in a['rows'] if x['note'] in ('NOT_FOUND', 'MISS_LIGHT', 'MISS_LLM')]
            print(f'  試行{tr} | ' + ' / '.join(f'{x["rank"]}.{x["rec"]}[{x["path"].split(":")[0]}|1位={x["top1_label"]}|'
                                              f'{(x["verdicts"] or ["-"])[0].split(":")[-1]}]' for x in miss))


def main():
    if len(sys.argv) > 3 and sys.argv[3] == 'M4':
        return main_m4()
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

    print_display(out, lab)

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
