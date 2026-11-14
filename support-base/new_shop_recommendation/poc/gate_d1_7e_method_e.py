# -*- coding: utf-8 -*-
"""
Gate D1.7E — 方式 E（Agent Tools 検索 1 位を直接採用・選択 LLM なし）の隔離 PoC

  python -m new_shop_recommendation.poc.gate_d1_7e_method_e --repeat 3

1 試行の流れ（推薦 LLM は 1 回だけ。A・D・E は同じ推薦結果を使う）:
  推薦 LLM → エリア解決
  A: 33秒版（Legacy Text Search 1 位 + Place Details）
  Agent Tools searchText を 7 店舗並列で 1 回だけ実行し、その同じ結果から
    D: 選択 LLM（Gate D1.7 と同じ LlmGroundedSelector）→ 選ばれた place ID の Place Details
    E: 検索 1 位を採用 → 1 位の Place Details（D と同じ details_for_card: 営業状態・国コード）
  A・D・E とも採用規則は 33秒版と同じ（推薦順位維持・place_id 重複は後順位を不採用・最大 5 件）

方式 A・D・E のコード（legacy_places / agent_tools_places / llm_grounded_selector）は変更しない。
店舗の正誤はプログラムで判定しない。末尾の「照合リスト」（推薦店名 × 採用 place の重複なし一覧）を、
元の推薦店と実店舗が同一かどうかで独立に確認する。
"""
import argparse
import os
import statistics
import sys
import time
from concurrent.futures import ThreadPoolExecutor

from new_shop_recommendation import agent_tools_places as at
from new_shop_recommendation import contracts as c
from new_shop_recommendation import legacy_places
from new_shop_recommendation.llm_candidate_selector import SelectionError
from new_shop_recommendation.llm_grounded_selector import LlmGroundedSelector
from new_shop_recommendation.recommender import RecommendationClient
from new_shop_recommendation.redact import contains_secret, redact, register_secret

OUT = []
QUERIES = [
    '横浜で美味しい焼き鳥屋を5軒', '銀座で評判の老舗の天ぷら店', '渋谷で落ち着いて過ごせるカフェ',
    '新宿で接待向けの個室がある和食 予算1人1万5千円 4名', '吉祥寺で子連れの家族でも行きやすいイタリアン',
    '東京駅から徒歩5分以内の美味しいラーメン', '中目黒 焼き鳥 予算1人5000円 2名', '札幌すすきので美味しいジンギスカン',
    '京都の祇園で記念日に行くカウンター割烹 予算1人2万円 2名', '大阪 梅田 串カツ 立ち飲み',
]


def say(s=''):
    s = redact(s)
    OUT.append(s)
    print(s, flush=True)


def stats(v):
    v = sorted(x for x in v if x is not None)
    if not v:
        return '—'
    p95 = v[min(len(v) - 1, int(round(0.95 * (len(v) - 1))))]
    return f'p50 {statistics.median(v):.0f} / p95 {p95:.0f} / 最大 {v[-1]:.0f} ms（n={len(v)}）'


def ms_since(t):
    return int((time.monotonic() - t) * 1000)


def pmap(fn, items):
    with ThreadPoolExecutor(max_workers=c.PLACES_MAX_PARALLEL) as pool:
        return list(pool.map(fn, items))


# 除外理由（計測用。採用ロジックそのものは 33秒版の規則のまま）
ADOPTED = 'adopted'
DUPLICATE = 'duplicate'          # place_id 重複で後順位を不採用
CAP = 'cap'                      # 5 件上限による押し出し
NO_CANDIDATES = 'no_candidates'  # 検索結果 0 件
SELECTION_NONE = 'selection_none'    # D: 選択 LLM が該当なし
SELECTION_ERROR = 'selection_error'  # D: 選択 LLM のエラー


def adopt_with_reasons(entries):
    """
    entries: 推薦順位順の [(rank, place_or_None, reason_if_none)]
    33秒版の採用規則（推薦順位のまま・place_id 重複は後順位を不採用・最大 5 件）を適用し、
    {rank: {'place': place|None, 'reason': adopted|duplicate|cap|<事前の除外理由>}} を返す
    """
    out, seen, n = {}, set(), 0
    for rank, place, why in entries:
        if not place:
            out[rank] = {'place': None, 'reason': why or 'unknown'}
        elif place['place_id'] in seen:
            out[rank] = {'place': None, 'reason': DUPLICATE}
        elif n >= c.DISPLAY_COUNT:
            out[rank] = {'place': None, 'reason': CAP}
        else:
            seen.add(place['place_id'])
            n += 1
            out[rank] = {'place': place, 'reason': ADOPTED}
    return out


def cards_of(adopted):
    return {r: v['place'] for r, v in adopted.items() if v['place']}


def search_reason(status):
    return NO_CANDIDATES if status in ('OK', 'ZERO_RESULTS') else f'search_error:{status}'


def shared_detail_targets(d_pick, e_pick):
    """D・E が選んだ place を place_id で重複排除（同じ place_id の Place Details は 1 回だけ取得）"""
    targets = {}
    for p in list(d_pick.values()) + list(e_pick.values()):
        targets.setdefault(p['place_id'], p)
    return targets


def fetch_shared_details(targets, geo, fetch=None):
    """{place_id: (details|None, reason)}。fetch は agent_tools_places.details_for_card と同じ形"""
    fetch = fetch or at.details_for_card
    pids = list(targets)
    return dict(zip(pids, pmap(lambda pid: fetch(targets[pid], geo), pids))) if pids else {}


def run_trial(rec_client, selector, mkey, q):
    t0 = time.monotonic()
    llm = rec_client.recommend(q)
    rec_ms = ms_since(t0)
    t = time.monotonic()
    area = legacy_places.resolve_area(q, 'ja')
    geo = legacy_places.region_info(area, 'ja')
    area_ms = ms_since(t)
    cands = llm.candidates

    # ---- A（33秒版）
    t = time.monotonic()
    a_search = pmap(lambda cd: legacy_places.search_place_candidates(cd.name, cd.area_hint, area, geo, 'ja'), cands)
    a_ts = ms_since(t)
    t = time.monotonic()
    a_det = pmap(lambda s: legacy_places.fetch_selected_details(s[0][0], geo, 'ja') if s[0] else None, a_search)
    a_dt = ms_since(t)

    # ---- Agent Tools 検索（D と E で共用。1 回だけ）
    t = time.monotonic()
    at_res = pmap(lambda cd: at.search_text(mkey, cd.name, cd.area_hint, area, geo), cands)
    at_ms = ms_since(t)

    # ---- D の選択（Gate D1.7 と同じ選択 LLM 1 回）
    nid, recs, idmap = 1, [], {}
    for cd, r in zip(cands, at_res):
        e = {'rank': cd.rank, 'recommended_name': cd.name, 'recommended_area': cd.area_hint,
             'maps_summary': r['summary'], 'maps_places': []}
        for pos, p in enumerate(r['places'], 1):
            e['maps_places'].append({'candidate_id': nid, 'citation': pos - 1})
            idmap[nid] = (pos, p)
            nid += 1
        if e['maps_places']:
            recs.append(e)
    sel, sel_ms, sel_err = {}, None, None
    if recs:
        try:
            sel, sel_ms, _ = selector.select(recs)
        except SelectionError as e:
            sel_err = e.error_type
    d_pick = {rank: idmap[cid][1] for rank, (cid, _r) in sel.items() if cid is not None}
    d_pos = {rank: idmap[cid][0] for rank, (cid, _r) in sel.items() if cid is not None}
    # ---- E の選択（選択 LLM なし: 検索 1 位）
    e_pick = {cd.rank: r['places'][0] for cd, r in zip(cands, at_res) if r['places']}

    # ---- Place Details（D・E 共通。同じ place_id は 1 回だけ）
    targets = shared_detail_targets(d_pick, e_pick)
    t = time.monotonic()
    det = fetch_shared_details(targets, geo)
    de_dt = ms_since(t)

    a_entries, d_entries, e_entries = [], [], []
    for cd, (a_c, a_st), ad, r in zip(cands, a_search, a_det, at_res):
        a_entries.append((cd.rank, ad, search_reason(a_st) if not a_c else 'country_mismatch'))
        if not r['places']:
            d_entries.append((cd.rank, None, search_reason(r['status'])))
            e_entries.append((cd.rank, None, search_reason(r['status'])))
            continue
        if sel_err:
            d_entries.append((cd.rank, None, SELECTION_ERROR))
        elif cd.rank not in d_pick:
            d_entries.append((cd.rank, None, SELECTION_NONE))
        else:
            d_d, d_why = det[d_pick[cd.rank]['place_id']]
            d_entries.append((cd.rank, d_d, d_why))
        e_d, e_why = det[e_pick[cd.rank]['place_id']]
        e_entries.append((cd.rank, e_d, e_why))
    a_ad, d_ad, e_ad = adopt_with_reasons(a_entries), adopt_with_reasons(d_entries), adopt_with_reasons(e_entries)
    a_cards, d_cards, e_cards = cards_of(a_ad), cards_of(d_ad), cards_of(e_ad)

    shared = sum(1 for rk, p in d_pick.items() if rk in e_pick and e_pick[rk]['place_id'] == p['place_id'])
    m = {'q': q, 'rec_ms': rec_ms, 'area_ms': area_ms, 'a_ts': a_ts, 'a_dt': a_dt, 'at_ms': at_ms,
         'sel_ms': sel_ms, 'sel_err': sel_err, 'de_dt': de_dt,
         'a_n': len(a_cards), 'd_n': len(d_cards), 'e_n': len(e_cards), 'gsearch': llm.google_search_calls,
         'at_calls': len(cands), 'de_det_calls': len(targets), 'de_det_shared': shared,
         'a_det_calls': sum(1 for s in a_search if s[0])}
    base = rec_ms + area_ms
    m['a_total'] = base + a_ts + a_dt
    m['d_total'] = base + at_ms + (sel_ms or 0) + de_dt
    m['e_total'] = base + at_ms + de_dt      # 共通取得の時間（D のみの place を含む）。E 単独より長めに出る
    rows = []
    for cd, r in zip(cands, at_res):
        rows.append({'rank': cd.rank, 'rec': cd.name, 'hint': cd.area_hint,
                     'A': a_cards.get(cd.rank), 'D': d_cards.get(cd.rank), 'E': e_cards.get(cd.rank),
                     'A_reason': a_ad[cd.rank]['reason'], 'D_reason': d_ad[cd.rank]['reason'],
                     'E_reason': e_ad[cd.rank]['reason'],
                     'd_pos': d_pos.get(cd.rank), 'n_at': len(r['places']), 'at_status': r['status']})
    return m, rows


def pos_s(r):
    return '(%d位)' % r['d_pos'] if r['d_pos'] else ''


def nm(p):
    return (p or {}).get('name') or '-'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--repeat', type=int, default=1)
    args = ap.parse_args()
    gkey = os.environ.get('GEMINI_RECOMMEND_API_KEY', '')
    mkey = os.environ.get('MAPS_AGENT_TOOLS_API_KEY', '')
    if not gkey or not mkey:
        sys.exit('GEMINI_RECOMMEND_API_KEY と MAPS_AGENT_TOOLS_API_KEY が必要です')
    for k in (gkey, mkey, os.environ.get('GOOGLE_PLACES_API_KEY', '')):
        register_secret(k)
    say(f'git_sha={os.environ.get("GIT_SHA", "unknown")}  model={c.MODEL_ID}  thinking={c.THINKING_LEVEL}  Google検索=なし  '
        f'Agent Tools=v1:searchText（ja / JP / pageSize {at.PAGE_SIZE}）  A / D / E は同じ推薦結果、D / E は同じ Agent Tools 結果')

    pre = at.search_text(mkey, '茶亭 羽當', '渋谷', '渋谷', legacy_places.region_info('渋谷', 'ja'))
    say(f'事前確認: searchText → {pre["status"]}（HTTP {pre["http_status"]}）')
    if pre['status'].startswith('ERROR'):
        say('Agent Tools を呼び出せないため停止します')
        return

    rec_client, selector = RecommendationClient(gkey), LlmGroundedSelector(gkey)
    metrics, all_rows, de_diff, review = [], [], [], {}
    plan = [q for _ in range(args.repeat) for q in QUERIES]
    for i, q in enumerate(plan, 1):
        try:
            m, rows = run_trial(rec_client, selector, mkey, q)
        except c.RecommendationError as e:
            say(f'\n({i}) [{q}] 推薦LLM失敗: {e.error_type}')
            metrics.append({'q': q, 'rec_fail': e.error_type})
            time.sleep(2)
            continue
        metrics.append(m)
        say(f'\n({i}) [{q}] 推薦LLM={m["rec_ms"]}ms | A 合計={m["a_total"]} カード={m["a_n"]} | '
            f'D AgentTools={m["at_ms"]} 選択LLM={m["sel_ms"]} Details(D・E共通)={m["de_dt"]} 合計={m["d_total"]} カード={m["d_n"]} | '
            f'E 合計={m["e_total"]} カード={m["e_n"]}' + (f' 選択エラー={m["sel_err"]}' if m['sel_err'] else ''))
        for r in rows:
            r['trial'] = i
            diff = (r['D'] or {}).get('place_id') != (r['E'] or {}).get('place_id')
            flag = '  ★D≠E' if diff else ''
            say(f'    {r["rank"]}. 推薦「{r["rec"]}」 A「{nm(r["A"])}」 D「{nm(r["D"])}」'
                f'{pos_s(r)} E「{nm(r["E"])}」 AT候補{r["n_at"]}件{flag}'
                f'  理由 A={r["A_reason"]} D={r["D_reason"]} E={r["E_reason"]}')
            if diff:
                de_diff.append(r)
            for k in 'ADE':
                p = r[k]
                if p:
                    key = (r['rec'], p['place_id'])
                    v = review.setdefault(key, {'rec': r['rec'], 'hint': r['hint'], 'name': p.get('name'),
                                                'addr': p.get('formatted_address') or '', 'url': p.get('maps_url') or
                                                f'https://www.google.com/maps/place/?q=place_id:{p["place_id"]}',
                                                'by': set(), 'trials': set()})
                    v['by'].add(k)
                    v['trials'].add(i)
        all_rows.extend(rows)
        time.sleep(2)
    report(metrics, all_rows, de_diff, review)
    say(f'\n出力への API キー残存: {"あり（要確認）" if contains_secret(chr(10).join(OUT)) else "なし"}')


def report(metrics, all_rows, de_diff, review):
    ok = [m for m in metrics if 'rec_fail' not in m]
    n = len(ok)
    say('\n================ 集計 ================')
    say(f'試行 {len(metrics)} 回 / 推薦LLM失敗 {len(metrics) - n} 回 / D 選択エラー {sum(1 for m in ok if m["sel_err"])} 回')
    if not n:
        return
    say('| 項目 | A 33秒版 | D 選択LLMあり | E 検索1位（LLMなし） |')
    say('|---|---:|---:|---:|')
    for label, f in (('5店舗完成', lambda k: f'{sum(1 for m in ok if m[k] >= 5)}/{n}'),
                     ('平均カード件数', lambda k: f'{statistics.mean(m[k] for m in ok):.2f}'),
                     ('カード0件', lambda k: f'{sum(1 for m in ok if m[k] == 0)}/{n}')):
        say(f'| {label} | {f("a_n")} | {f("d_n")} | {f("e_n")} |')
    for label, k in (('合計時間', 'total'),):
        say(f'| {label} p50 | {statistics.median(m["a_" + k] for m in ok):.0f} ms | '
            f'{statistics.median(m["d_" + k] for m in ok):.0f} ms | {statistics.median(m["e_" + k] for m in ok):.0f} ms |')
    say('\n【処理時間】')
    say(f'  推薦LLM（共通）: {stats([m["rec_ms"] for m in ok])}')
    say(f'  エリア解決（共通）: {stats([m["area_ms"] for m in ok])}')
    say(f'  A Text Search / Details: {stats([m["a_ts"] for m in ok])} / {stats([m["a_dt"] for m in ok])}')
    say(f'  Agent Tools searchText（D・E 共通）: {stats([m["at_ms"] for m in ok])}')
    say(f'  D 選択LLM: {stats([m["sel_ms"] for m in ok])}')
    say(f'  Place Details（D・E 共通取得）: {stats([m["de_dt"] for m in ok])}')
    say(f'  合計 A: {stats([m["a_total"] for m in ok])}')
    say(f'  合計 D: {stats([m["d_total"] for m in ok])}')
    say(f'  合計 E: {stats([m["e_total"] for m in ok])}')
    say('  ※ D・E の Place Details は共通取得（同じ place_id は 1 回）。E の合計には D だけが選んだ place の取得時間も含む')
    diffs = [m['d_total'] - m['e_total'] for m in ok]
    say(f'  D − E（選択LLMの削除で短縮される時間）: {stats(diffs)}')

    say('\n【不採用・除外の理由（推薦店舗単位）】')
    reasons = sorted({r[k + '_reason'] for r in all_rows for k in 'ADE'})
    say('| 理由 | A | D | E |')
    say('|---|---:|---:|---:|')
    for why in reasons:
        say(f'| {why} | ' + ' | '.join(str(sum(1 for r in all_rows if r[k + '_reason'] == why)) for k in 'ADE') + ' |')

    say('\n【D と E で採用店舗が違ったケース（全件）】')
    say(f'  件数: {len(de_diff)}')
    for r in de_diff:
        why = f'（理由 D={r["D_reason"]} / E={r["E_reason"]}）'
        say(f'  ({r["trial"]}) {r["rank"]}. 推薦「{r["rec"]}」（{r["hint"]}） D「{nm(r["D"])}」'
            f'{pos_s(r)} / E「{nm(r["E"])}」{why}')
        for k in 'DE':
            if r[k]:
                say(f'       {k}: {r[k].get("formatted_address") or "-"}')

    say('\n【照合リスト（推薦店名 × 採用 place、重複なし）— 元の推薦店と実店舗が同一かを独立に確認する】')
    say(f'  件数: {len(review)}')
    for i, (key, v) in enumerate(sorted(review.items(), key=lambda kv: min(kv[1]['trials'])), 1):
        say(f'  R{i:03d} 推薦「{v["rec"]}」（{v["hint"]}） → 「{v["name"]}」 {v["addr"][:70]}  採用={"".join(sorted(v["by"]))} '
            f'試行={",".join(str(t) for t in sorted(v["trials"]))}')

    say('\n【API 呼び出し数（第 2 部）】')
    say(f'  推薦LLM {n} / Agent Tools {sum(m["at_calls"] for m in ok)} / 選択LLM {sum(1 for m in ok if m["sel_ms"] is not None)} / '
        f'Details A {sum(m["a_det_calls"] for m in ok)}・D/E 共通 {sum(m["de_det_calls"] for m in ok)}'
        f'（うち D と E が同じ place_id で共有 {sum(m["de_det_shared"] for m in ok)} 件）')
    say('  キャッシュ: なし（試行をまたぐ再利用はしない）。共通化: 推薦LLM＝A/D/E、Agent Tools＝D/E、Details＝D/E（同一 place_id）')


if __name__ == '__main__':
    main()
