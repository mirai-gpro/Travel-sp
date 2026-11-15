# -*- coding: utf-8 -*-
"""
Gate D1.7 — Maps Experience Agent Tools（v1:searchText）+ 選択 LLM（方式 D）の実 API 検証

  python -m new_shop_recommendation.poc.gate_d1_7_agent_tools --repeat 3

環境変数: GEMINI_RECOMMEND_API_KEY / GOOGLE_PLACES_API_KEY（A と Place Details）/ MAPS_AGENT_TOOLS_API_KEY

第 0 部 事前確認: searchText を 1 回呼び、API 有効化・キー権限を確認（失敗なら停止）
第 1 部 重点プローブ: 固定の店名（茶亭 羽當 ほか D1.6 で 1 位名が推薦名と食い違った店）を
       Legacy Text Search（A）と Agent Tools（D）で検索し、取得できた店舗を並べて比較。D は選択 LLM 1 回
第 2 部 30 試行: 通常 10 クエリ × N 回。同じ推薦結果から A（33秒版 1 位採用）と D（Agent Tools + 選択 LLM）を作り比較

規約上の扱い（Service Specific Terms §10 / Agent Tools 利用ポリシー）:
  - 選択 LLM に渡すのは Agent Tools の summary と 候補 ID⇔引用番号 のみ（Agent Tools の LLM グラウンディング用途）
  - Legacy Places の応答は LLM に送らない（A は 33秒版のまま、B・C の実データ比較は行わない）
  - 結果は画面表示のみ（ファイル保存しない）。評価目的の表示は §10.2.2(1)（評価目的で 30 日以内のキャッシュ可）の範囲
  - 店舗の正誤はプログラムで判定しない。A と D の差分を一覧にし、人が実店舗情報と照合する
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
# 重点プローブ（D1.6 の実データで Places 1 位名が推薦名と食い違った店）: (推薦名, area_hint, 検索エリア)
PROBES = [
    ('茶亭 羽當', '渋谷', '渋谷'),
    ('銀座 天賞', '銀座', '銀座'),
    ('新宿 瀬里奈', '新宿', '新宿'),
    ('やきとり 荒井屋', '横浜', '横浜'),
    ('地鶏や 徳', '横浜', '横浜'),
    ('割烹 八日', '祇園', '京都 祇園'),
    ('焼き鳥 くぼ田', '中目黒', '中目黒'),
]
PRICE_AGENT_TOOLS_ESSENTIALS = 7.00   # USD / 1,000（月 10,000 件まで無料。公式料金表 2026-11）


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


def tokens(usage):
    if not isinstance(usage, dict):
        return 0
    for k in ('total_tokens', 'totalTokenCount', 'total_token_count'):
        if isinstance(usage.get(k), int):
            return usage[k]
    return sum(v for k, v in usage.items() if isinstance(v, int) and 'token' in k and 'total' not in k)


class Calls(dict):
    def add(self, k, n=1):
        self[k] = self.get(k, 0) + n


CALLS = Calls()


# ------------------------------------------------------------------ A: 33秒版（Legacy Text Search 1 位 + Details）
def run_a(cands, area, geo):
    t = time.monotonic()
    with ThreadPoolExecutor(max_workers=c.PLACES_MAX_PARALLEL) as pool:
        searched = list(pool.map(lambda cd: legacy_places.search_place_candidates(cd.name, cd.area_hint, area, geo, 'ja'), cands))
    ts_ms = ms_since(t)
    CALLS.add('legacy_textsearch', len(cands))
    t = time.monotonic()
    with ThreadPoolExecutor(max_workers=c.PLACES_MAX_PARALLEL) as pool:
        det = list(pool.map(lambda s: legacy_places.fetch_selected_details(s[0][0], geo, 'ja') if s[0] else None, searched))
    det_ms = ms_since(t)
    CALLS.add('legacy_details', sum(1 for s in searched if s[0]))
    return searched, det, ts_ms, det_ms


# ------------------------------------------------------------------ D: Agent Tools + 選択 LLM + Details
def run_d(selector, mkey, cands, area, geo):
    t = time.monotonic()
    with ThreadPoolExecutor(max_workers=c.PLACES_MAX_PARALLEL) as pool:
        res = list(pool.map(lambda cd: at.search_text(mkey, cd.name, cd.area_hint, area, geo), cands))
    at_ms = ms_since(t)
    CALLS.add('agent_tools_searchtext', len(cands))
    nid, recs, idmap = 1, [], {}
    for cd, r in zip(cands, res):
        e = {'rank': cd.rank, 'recommended_name': cd.name, 'recommended_area': cd.area_hint,
             'maps_summary': r['summary'], 'maps_places': []}
        for pos, p in enumerate(r['places'], 1):
            e['maps_places'].append({'candidate_id': nid, 'citation': pos - 1})
            idmap[nid] = (cd.rank, pos, p)
            nid += 1
        if e['maps_places']:
            recs.append(e)
    sel, sel_ms, sel_err, sel_tok = {}, None, None, 0
    if recs:
        try:
            sel, sel_ms, _s = selector.select(recs)
            sel_tok = tokens(selector.last_usage)
        except SelectionError as e:
            sel_err = e.error_type
        CALLS.add('selection_llm')
    chosen = {rank: idmap[cid] for rank, (cid, _r) in sel.items() if cid is not None}
    t = time.monotonic()
    with ThreadPoolExecutor(max_workers=c.PLACES_MAX_PARALLEL) as pool:
        det = dict(zip(chosen, pool.map(lambda v: at.details_for_card(v[2], geo), chosen.values())))
    det_ms = ms_since(t)
    CALLS.add('d_details', len(chosen))
    return res, sel, chosen, det, at_ms, sel_ms, det_ms, sel_err, sel_tok


def adopt(order):
    """33秒版の採用規則: 推薦順位のまま、place_id 重複は後順位を不採用、最大 5 件"""
    cards, seen = [], set()
    for rank, d in order:
        if d and d['place_id'] not in seen and len(cards) < c.DISPLAY_COUNT:
            seen.add(d['place_id'])
            cards.append((rank, d))
    return cards


# ------------------------------------------------------------------ 第 0 部
def preflight(mkey):
    say('\n================ 第 0 部: Agent Tools 事前確認 ================')
    geo = legacy_places.region_info('渋谷', 'ja')
    r = at.search_text(mkey, '茶亭 羽當', '渋谷', '渋谷', geo)
    CALLS.add('agent_tools_searchtext')
    say(f'  POST {at.SEARCH_TEXT_URL} → {r["status"]}（{r["ms"]} ms, HTTP {r["http_status"]}, 候補 {len(r["places"])} 件）')
    if r['status'].startswith('ERROR'):
        say('  Agent Tools を呼び出せないため停止します（API 有効化・キーの API 制限を確認してください）')
        return False
    return True


# ------------------------------------------------------------------ 第 1 部
def probes(selector, mkey):
    say('\n================ 第 1 部: 重点プローブ（Legacy と Agent Tools の取得結果比較）================')
    say('  ※ D の選択 LLM には Agent Tools の summary と 候補 ID⇔引用番号 だけを渡す（Legacy の結果は LLM に送らない）')
    items = []
    for name, hint, area in PROBES:
        geo = legacy_places.region_info(area, 'ja')
        leg, st = legacy_places.search_place_candidates(name, hint, area, geo, 'ja')
        CALLS.add('legacy_textsearch')
        r = at.search_text(mkey, name, hint, area, geo)
        CALLS.add('agent_tools_searchtext')
        names = []
        for p in r['places']:                                       # 確認用に place ID から店名・住所を取得（Places API）
            d, why = at.details_for_card(p, geo)
            CALLS.add('d_details')
            names.append(((d or {}).get('name') or f'({why})', (d or {}).get('formatted_address') or ''))
        items.append((name, hint, area, geo, leg, st, r, names))
    recs = []
    nid, idmap = 1, {}
    for i, (name, hint, area, geo, leg, st, r, names) in enumerate(items, 1):
        e = {'rank': i, 'recommended_name': name, 'recommended_area': hint, 'maps_summary': r['summary'], 'maps_places': []}
        for pos, p in enumerate(r['places'], 1):
            e['maps_places'].append({'candidate_id': nid, 'citation': pos - 1})
            idmap[nid] = pos
            nid += 1
        if e['maps_places']:
            recs.append(e)
    sel, sel_ms = {}, None
    if recs:
        try:
            sel, sel_ms, _ = selector.select(recs)
        except SelectionError as e:
            say(f'  選択 LLM エラー: {e.error_type} {e.detail[:160]}')
        CALLS.add('selection_llm')
    say(f'  選択 LLM 1 回 {sel_ms} ms')
    for i, (name, hint, area, geo, leg, st, r, names) in enumerate(items, 1):
        say(f'\n  ■ {i}. 推薦「{name}」（{area}）')
        say(f'    A Legacy Text Search（{st}・{len(leg)} 件）: ' +
            (' / '.join(f'{k}位「{p.get("name")}」' for k, p in enumerate(leg, 1)) or 'なし'))
        say(f'    D Agent Tools（{r["status"]}・{len(r["places"])} 件・{r["ms"]} ms）:')
        for k, (nm, addr) in enumerate(names, 1):
            say(f'       {k}位「{nm}」 {addr[:60]}')
        cid = sel.get(i, (None, ''))[0]
        say(f'    D 選択: {"該当なし" if cid is None else f"{idmap[cid]}位「{names[idmap[cid] - 1][0]}」"}  '
            f'理由: {sel.get(i, (None, "-"))[1][:100]}')
        if r['places']:
            say(f'    Google Maps 出典: {r["places"][0]["attribution"].get("title")} {r["places"][0]["attribution"].get("url")}')


# ------------------------------------------------------------------ 第 2 部
def trials(rec_client, selector, mkey, repeat):
    say('\n================ 第 2 部: 30 試行（同じ推薦結果から A と D）================')
    rows = []
    plan = [q for _ in range(repeat) for q in QUERIES]
    for i, q in enumerate(plan, 1):
        t0 = time.monotonic()
        try:
            llm = rec_client.recommend(q)
        except c.RecommendationError as e:
            rows.append({'q': q, 'rec_fail': e.error_type})
            CALLS.add('recommend_llm')
            say(f'\n({i}) [{q}] 推薦LLM失敗: {e.error_type}')
            time.sleep(2)
            continue
        CALLS.add('recommend_llm')
        rec_ms = ms_since(t0)
        t = time.monotonic()
        area = legacy_places.resolve_area(q, 'ja')
        geo = legacy_places.region_info(area, 'ja')
        CALLS.add('geocoding', 1 if area else 0)
        area_ms = ms_since(t)
        cands = llm.candidates
        a_search, a_det, a_ts, a_detms = run_a(cands, area, geo)
        d_res, d_sel, d_chosen, d_det, d_at, d_sel_ms, d_detms, d_err, d_tok = run_d(selector, mkey, cands, area, geo)
        a_cards = adopt([(cd.rank, d) for cd, d in zip(cands, a_det)])
        d_cards = adopt([(cd.rank, (d_det.get(cd.rank) or (None, ''))[0]) for cd in cands])
        a_map = {r: d['place_id'] for r, d in a_cards}
        d_map = {r: d['place_id'] for r, d in d_cards}
        row = {'q': q, 'rec_ms': rec_ms, 'area_ms': area_ms, 'a_ts': a_ts, 'a_det': a_detms, 'd_at': d_at,
               'd_sel': d_sel_ms, 'd_det': d_detms, 'd_err': d_err, 'rec_tok': tokens(llm.usage), 'sel_tok': d_tok,
               'a_n': len(a_cards), 'd_n': len(d_cards), 'gsearch': llm.google_search_calls,
               'positions': {}, 'd_none': 0, 'd_no_cand': 0, 'cmp': Calls()}
        row['a_total'] = rec_ms + area_ms + a_ts + a_detms
        row['d_total'] = rec_ms + area_ms + d_at + (d_sel_ms or 0) + d_detms
        say(f'\n({i}) [{q}] 推薦LLM={rec_ms}ms | A: TextSearch={a_ts} Details={a_detms} 合計={row["a_total"]}ms カード={len(a_cards)}'
            f' | D: AgentTools={d_at} 選択LLM={d_sel_ms} Details={d_detms} 合計={row["d_total"]}ms カード={len(d_cards)}'
            + (f' 選択エラー={d_err}' if d_err else ''))
        for cd, (leg, _st), ad, dr in zip(cands, a_search, a_det, d_res):
            ch = d_chosen.get(cd.rank)
            dd, why = d_det.get(cd.rank) or (None, '')
            pos = ch[1] if ch else None
            if pos:
                row['positions'][pos] = row['positions'].get(pos, 0) + 1
            if not dr['places']:
                row['d_no_cand'] += 1
            elif not ch:
                row['d_none'] += 1
            a_pid = ad['place_id'] if ad else None
            d_pid = dd['place_id'] if dd else None
            kind = ('一致' if a_pid and a_pid == d_pid else 'A・D とも不採用' if not a_pid and not d_pid
                    else 'D のみ採用' if not a_pid else 'A のみ採用' if not d_pid else '別店舗')
            row['cmp'].add(kind)
            mark = '' if kind in ('一致', 'A・D とも不採用') else '  ★要照合'
            say(f'    {cd.rank}. 推薦「{cd.name}」 A「{(ad or {}).get("name") or "-"}」 '
                f'D {f"{pos}位" if pos else ("候補0件" if not dr["places"] else "該当なし")}'
                f'「{(dd or {}).get("name") or ("-" if not why or why == "ok" else why)}」 [{kind}]{mark}')
            if mark:
                say(f'         A: {(ad or {}).get("formatted_address") or "-"}')
                say(f'         D: {(dd or {}).get("formatted_address") or "-"}  {(dd or {}).get("maps_url") or ""}')
        rows.append(row)
        time.sleep(2)
    report(rows)


def report(rows):
    ok = [r for r in rows if 'rec_fail' not in r]
    n = len(ok)
    say('\n【第 2 部 集計】')
    say(f'  試行 {len(rows)} 回 / 推薦LLM失敗 {len(rows) - n} 回 / D 選択エラー {sum(1 for r in ok if r["d_err"])} 回')
    if not n:
        return
    say('| 項目 | A 33秒版 | D Agent Tools + 選択LLM |')
    say('|---|---:|---:|')
    say(f'| 5店舗完成 | {sum(1 for r in ok if r["a_n"] >= 5)}/{n} | {sum(1 for r in ok if r["d_n"] >= 5)}/{n} |')
    say(f'| 平均カード件数 | {statistics.mean(r["a_n"] for r in ok):.2f} | {statistics.mean(r["d_n"] for r in ok):.2f} |')
    say(f'| カード0件 | {sum(1 for r in ok if r["a_n"] == 0)}/{n} | {sum(1 for r in ok if r["d_n"] == 0)}/{n} |')
    cmp_tot = Calls()
    for r in ok:
        for k, v in r['cmp'].items():
            cmp_tot.add(k, v)
    pos_tot = Calls()
    for r in ok:
        for k, v in r['positions'].items():
            pos_tot.add(k, v)
    say(f'  推薦店舗ごとの A と D の比較（採用規則適用後）: {dict(cmp_tot)}')
    say(f'  D の選択位置: {dict(sorted(pos_tot.items()))}（2〜5位からの採用 {sum(v for k, v in pos_tot.items() if k >= 2)} 件）')
    say(f'  D 該当なし（候補あり）: {sum(r["d_none"] for r in ok)} 店舗 / D 候補0件: {sum(r["d_no_cand"] for r in ok)} 店舗')
    say(f'  Google 検索呼び出し（推薦LLM）: 合計 {sum(r["gsearch"] for r in ok)}')
    say('\n【処理時間】')
    say(f'  推薦LLM: {stats([r["rec_ms"] for r in ok])}')
    say(f'  エリア解決（Geocoding）: {stats([r["area_ms"] for r in ok])}')
    say(f'  A Legacy Text Search: {stats([r["a_ts"] for r in ok])}')
    say(f'  A Place Details: {stats([r["a_det"] for r in ok])}')
    say(f'  D Agent Tools searchText（7 並列）: {stats([r["d_at"] for r in ok])}')
    say(f'  D 選択LLM: {stats([r["d_sel"] for r in ok])}')
    say(f'  D Place Details: {stats([r["d_det"] for r in ok])}')
    say(f'  合計 A: {stats([r["a_total"] for r in ok])}')
    say(f'  合計 D: {stats([r["d_total"] for r in ok])}')
    say('\n【API 呼び出し数（第 0〜2 部の合計）と概算】')
    for k, v in sorted(CALLS.items()):
        say(f'  {k}: {v}')
    say(f'  Gemini トークン（第 2 部）: 推薦 {sum(r["rec_tok"] for r in ok)} / 選択 {sum(r["sel_tok"] for r in ok)}')
    at_calls = CALLS.get('agent_tools_searchtext', 0)
    say(f'  Agent Tools（Essentials, $7.00/1,000・月 10,000 件無料）: {at_calls} 件 ≈ ${at_calls * PRICE_AGENT_TOOLS_ESSENTIALS / 1000:.3f}'
        f'（無料枠適用前）。1 検索あたり 7 件 ≈ ${7 * PRICE_AGENT_TOOLS_ESSENTIALS / 1000:.3f}')


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
    say(f'git_sha={os.environ.get("GIT_SHA", "unknown")}  model={c.MODEL_ID}  thinking={c.THINKING_LEVEL}  '
        f'Google検索=なし  Agent Tools=v1:searchText（ja / JP / pageSize {at.PAGE_SIZE}・Essentials）  選択LLM=1 検索 1 回')
    if preflight(mkey):
        selector = LlmGroundedSelector(gkey)
        probes(selector, mkey)
        trials(RecommendationClient(gkey), selector, mkey, args.repeat)
    say(f'\n出力への API キー残存: {"あり（要確認）" if contains_secret(chr(10).join(OUT)) else "なし"}')


if __name__ == '__main__':
    main()
