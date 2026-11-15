# -*- coding: utf-8 -*-
"""
Gate D1.6 — Places 複数候補 → 選択 LLM（方式 C）の PoC 計測

  python -m new_shop_recommendation.poc.gate_d1_6_multicandidate --repeat 3

第 1 部 fixture（常に実行）:
  独立に作成した架空データ（selection_fixtures.json。実在店・実際の Places 応答ではない）で、
  同じ候補リストから A / B / C を比較する。
    A = 33秒版（1 位候補を採用）
    B = D1.5（1 位候補を同一性判定 LLM にかけ、SAME のみ採用）… 比較用のテスト専用呼び出し（別集計）
    C = D1.6（選択 LLM が 1〜5 位から 1 件 か null を選択）
第 2 部 real（常に実行。Places データを LLM に送らない）:
  実際の推薦 LLM → 33秒版と同じ Text Search（上位 5 候補）→ A（1 位 + Place Details）までを計測する。
  実 Places 応答を選択 LLM・同一性判定 LLM に送る B / C は、Google Maps Platform 規約上の許容が
  確認できていないため実行しない。
  （--real-selection と、許容の根拠となる書面の参照を PLACES_LLM_TOS_APPROVAL_REF に設定した場合のみ
    B / C も同じ試行データで実行する。ユーザーの yes 入力だけでは有効にならない。）
環境変数: GEMINI_RECOMMEND_API_KEY（必須）、GOOGLE_PLACES_API_KEY（第 2 部）
"""
import argparse
import json
import os
import statistics
import sys
import time
from concurrent.futures import ThreadPoolExecutor

from new_shop_recommendation import contracts as c
from new_shop_recommendation.llm_candidate_selector import LlmCandidateSelector, SelectionError
from new_shop_recommendation.llm_identity_verifier import IdentityError, LlmIdentityVerifier
from new_shop_recommendation.redact import contains_secret, redact, register_secret

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = []

QUERIES = [
    '横浜で美味しい焼き鳥屋を5軒', '銀座で評判の老舗の天ぷら店', '渋谷で落ち着いて過ごせるカフェ',
    '新宿で接待向けの個室がある和食 予算1人1万5千円 4名', '吉祥寺で子連れの家族でも行きやすいイタリアン',
    '東京駅から徒歩5分以内の美味しいラーメン', '中目黒 焼き鳥 予算1人5000円 2名', '札幌すすきので美味しいジンギスカン',
    '京都の祇園で記念日に行くカウンター割烹 予算1人2万円 2名', '大阪 梅田 串カツ 立ち飲み',
]
LATEST_QUERY = '2026年秋に渋谷で新しく開店したカフェ'


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


def pos_label(p):
    return '該当なし' if p is None else f'{p}位'


# =================================================================== 第 1 部: fixture
def build_recs(recs_src):
    """fixture の 1 セット → 選択 LLM 入力（candidate_id は検索内で 1 から通し番号）と id→位置 の対応"""
    nid, recs, pos_of = 1, [], {}
    for rank, r in enumerate(recs_src, 1):
        e = {'rank': rank, 'recommended_name': r['recommended_name'], 'recommended_area': r['recommended_area'],
             'places_candidates': []}
        for pos, cd in enumerate(r['candidates'], 1):
            e['places_candidates'].append({'candidate_id': nid, 'name': cd['name'], 'area': cd['area']})
            pos_of[nid] = (rank, pos)
            nid += 1
        recs.append(e)
    return recs, pos_of


def judge(choice, case):
    """choice: 採用した位置（None=不採用）→ 'correct' / 'wrong'（別店舗を採用）/ 'miss'（正解があるのに不採用）/ 'correct_none'"""
    exp = case['expected']
    if choice is None:
        return 'correct_none' if (exp is None or None in case['allowed']) else 'miss'
    return 'correct' if choice in case['allowed'] else 'wrong'


def run_fixtures(selector, identity, repeat):
    data = json.load(open(os.path.join(HERE, 'selection_fixtures.json'), encoding='utf-8'))
    say('\n================ 第 1 部: fixture（独立作成の架空データ。実際の Places データではない）================')
    rows, sel_ms, id_ms, sel_err, id_err, set_cards = [], [], [], [], [], []
    for t in range(repeat):
        for st in data['sets']:
            recs, pos_of = build_recs(st['recs'])
            c_choice, b_same = {}, {}
            try:
                res, dur, searches = selector.select(recs)
                sel_ms.append(dur)
                for rank, (cid, reason) in res.items():
                    c_choice[rank] = (pos_of[cid][1] if cid is not None else None, reason)
                say(f'\n[{st["name"]}] (#{t + 1}) 選択LLM 1 回 {dur} ms  検索呼び出し={searches}')
            except SelectionError as e:
                sel_err.append(e.error_type)
                say(f'\n[{st["name"]}] (#{t + 1}) 選択エラー: {e.error_type} {e.detail[:200]}（C は全件不採用扱い）')
            pairs = [{'id': i, 'recommended_name': r['recommended_name'], 'recommended_area': r['recommended_area'],
                      'matched_name': r['candidates'][0]['name'], 'matched_area': r['candidates'][0]['area']}
                     for i, r in enumerate(st['recs'], 1)]
            try:
                ires, idur, _s = identity.verify(pairs)
                id_ms.append(idur)
                b_same = {i: j == c.SAME for i, (j, _r) in ires.items()}
                say(f'  （比較用・テスト専用）同一性判定LLM 1 回 {idur} ms')
            except IdentityError as e:
                id_err.append(e.error_type)
                say(f'  （比較用）同一性判定エラー: {e.error_type}（B は全件不採用扱い）')
            per = {'A': [], 'B': [], 'C': []}
            for rank, case in enumerate(st['recs'], 1):
                a = 1
                b = 1 if b_same.get(rank) else None
                cpos, reason = c_choice.get(rank, (None, '選択エラー'))
                row = {'set': st['name'], 'kind': case['kind'], 'rec': case['recommended_name'],
                       'top1': case['candidates'][0]['name'], 'expected': case['expected'],
                       'A': judge(a, case), 'B': judge(b, case), 'C': judge(cpos, case), 'c_pos': cpos,
                       'final': case['candidates'][cpos - 1]['name'] if cpos else None, 'reason': reason}
                rows.append(row)
                for k, ch in (('A', a), ('B', b), ('C', cpos)):
                    per[k].append(row[k] if ch is not None else None)
                mark = '○' if row['C'] in ('correct', 'correct_none') else '×'
                say(f'  {mark} {rank}. 推薦「{row["rec"]}」 Places1位「{row["top1"]}」 → C 選択 {pos_label(cpos)}'
                    f'「{row["final"] or "-"}」（正解 {pos_label(case["expected"])}） A={row["A"]} B={row["B"]}')
            # 1 セット = 7 店舗を 1 検索とみなし、採用件数（最大 5）と「正しい店舗だけで 5 件」を数える
            set_cards.append({k: (min(5, sum(1 for x in v if x is not None)),
                                  min(5, sum(1 for x in v if x == 'correct'))) for k, v in per.items()})
    report_fixtures(rows, sel_ms, id_ms, sel_err, id_err, set_cards)


def report_fixtures(rows, sel_ms, id_ms, sel_err, id_err, set_cards):
    n = len(rows)
    say('\n【fixture A / B / C 比較（同じ候補リスト）】')
    say(f'  判定対象 {n} 店舗（正解あり {sum(1 for r in rows if r["expected"] is not None)} / 該当なし '
        f'{sum(1 for r in rows if r["expected"] is None)}）  選択エラー {len(sel_err)} 回 {sel_err}  同一性判定エラー {len(id_err)} 回 {id_err}')
    say('| 項目 | A 33秒版（1位採用） | B D1.5（1位を SAME のみ） | C D1.6（1〜5位から選択） |')
    say('|---|---:|---:|---:|')

    def cnt(k, v):
        return sum(1 for r in rows if r[k] == v)
    for label, v in (('正しい店舗を採用', 'correct'), ('別店舗を採用（すり替え）', 'wrong'),
                     ('正解があるのに不採用', 'miss'), ('該当なしを正しく不採用', 'correct_none')):
        say(f'| {label} | {cnt("A", v)} | {cnt("B", v)} | {cnt("C", v)} |')
    k = len(set_cards)
    for label, idx in (('5件完成（採用数）', 0), ('5件完成（正しい店舗のみ）', 1)):
        say(f'| {label} | ' + ' | '.join(f'{sum(1 for s in set_cards if s[m][idx] >= 5)}/{k}' for m in 'ABC') + ' |')
    say(f'| 平均採用件数（最大5） | ' + ' | '.join(f'{statistics.mean(s[m][0] for s in set_cards):.2f}' for m in 'ABC') + ' |')

    later = [r for r in rows if r['expected'] not in (None, 1)]
    rec_ok = [r for r in later if r['C'] == 'correct']
    say(f'\n① 2〜5位の正解を回収: {len(rec_ok)}/{len(later)}（A・B は構造上 0）')
    for p in (2, 3, 4, 5):
        tot = [r for r in later if r['expected'] == p]
        say(f'    正解 {p}位: {sum(1 for r in tot if r["C"] == "correct")}/{len(tot)}')
    fixed = [r for r in rows if r['A'] == 'wrong' and r['C'] in ('correct', 'correct_none')]
    say(f'② A ですり替え → C で是正: {len(fixed)}/{cnt("A", "wrong")}（正しい候補を選択 '
        f'{sum(1 for r in fixed if r["C"] == "correct")}、該当なしに是正 {sum(1 for r in fixed if r["C"] == "correct_none")}）')
    nf = [r for r in rows if r['c_pos'] is None]
    say(f'③ C の該当なし: {len(nf)} 件（うち正解ありを取りこぼし {sum(1 for r in nf if r["C"] == "miss")} 件）')
    bad = [r for r in rows if r['C'] in ('wrong', 'miss')]
    if bad:
        say('  ── C の誤り（最大 10 件）')
        for r in bad[:10]:
            say(f'     [{r["kind"]}] 推薦「{r["rec"]}」 正解 {pos_label(r["expected"])} → 選択 {pos_label(r["c_pos"])}'
                f'「{r["final"] or "-"}」: {(r["reason"] or "")[:80]}')
    say(f'④ 処理時間: 選択LLM（7店舗×最大5候補 1 回）{stats(sel_ms)}')
    say(f'           同一性判定LLM（比較用・テスト専用 1 回）{stats(id_ms)}')


# =================================================================== 第 2 部: real（Places データを LLM に送らない）
def run_real(gkey, repeat, allow_selection):
    import api_integrations as legacy
    from new_shop_recommendation import legacy_places
    from new_shop_recommendation.recommender import RecommendationClient
    rec_client = RecommendationClient(gkey)
    selector = LlmCandidateSelector(gkey) if allow_selection else None
    identity = LlmIdentityVerifier(gkey) if allow_selection else None
    say('\n================ 第 2 部: real（実 API。Places データは LLM に送らない）================')
    if not allow_selection:
        say('  B / C（実 Places データを選択 LLM・同一性判定 LLM に送る）: 未実行 — 規約上の許容が未確認')
    rows = []
    plan = [(q, False) for _ in range(repeat) for q in QUERIES] + [(LATEST_QUERY, True) for _ in range(repeat)]
    for i, (q, latest) in enumerate(plan, 1):
        m = {'query': q, 'latest': latest}
        t0 = time.monotonic()
        try:
            llm = rec_client.recommend(q)
        except c.RecommendationError as e:
            m.update({'rec_fail': e.error_type, 'total_ms': int((time.monotonic() - t0) * 1000)})
            rows.append(m)
            say(f'\n({i}) [{q}] 推薦LLM失敗: {e.error_type} {redact(e.detail)[:160]}')
            time.sleep(2)
            continue
        m.update({'llm_ms': llm.duration_ms, 'n_rec': len(llm.candidates), 'gsearch': llm.google_search_calls})
        area = legacy_places.resolve_area(q, 'ja')
        geo = legacy_places.region_info(area, 'ja')
        tp = time.monotonic()
        with ThreadPoolExecutor(max_workers=c.PLACES_MAX_PARALLEL) as pool:
            searched = list(pool.map(lambda cd: legacy_places.search_place_candidates(cd.name, cd.area_hint, area, geo, 'ja'),
                                     llm.candidates))
        m['ts_ms'] = int((time.monotonic() - tp) * 1000)
        m['n_cands'] = sum(len(x[0]) for x in searched)
        # A: 33秒版と同じく 1 位候補を採用（Place Details・国コード照合）
        td = time.monotonic()
        with ThreadPoolExecutor(max_workers=c.PLACES_MAX_PARALLEL) as pool:
            a_det = list(pool.map(lambda s: legacy_places.fetch_selected_details(s[0][0], geo, 'ja') if s[0] else None, searched))
        m['det_ms'] = int((time.monotonic() - td) * 1000)
        a_cards, seen = [], set()
        for cd, d in zip(llm.candidates, a_det):
            if d and d['place_id'] not in seen and len(a_cards) < c.DISPLAY_COUNT:
                seen.add(d['place_id'])
                a_cards.append((cd.name, d['name']))
        m['a_cards'] = len(a_cards)
        m['not_found'] = sum(1 for s in searched if not s[0])
        m['total_ms'] = int((time.monotonic() - t0) * 1000)
        say(f'\n({i}) [{q}] 推薦LLM={m["llm_ms"]}ms（{m["n_rec"]}店舗・検索呼び出し {m["gsearch"]}） '
            f'TextSearch={m["ts_ms"]}ms 候補計={m["n_cands"]} Details={m["det_ms"]}ms 合計={m["total_ms"]}ms '
            f'A カード={m["a_cards"]} Places候補0件={m["not_found"]}')
        for cd, (cands, st) in zip(llm.candidates, searched):
            say(f'    {cd.rank}. 推薦「{cd.name}」 Places1位「{cands[0].get("name") if cands else "-"}」 候補{len(cands)}件'
                + ('' if st == 'OK' else f' ({st})'))
        if allow_selection:
            run_real_selection(selector, identity, llm, searched, geo, m)
        rows.append(m)
        time.sleep(2)
    report_real(rows, allow_selection)


def run_real_selection(selector, identity, llm, searched, geo, m):
    """規約確認の根拠がある場合のみ: 同じ推薦・同じ候補から B / C を作る"""
    from new_shop_recommendation import legacy_places
    nid, recs, pmap = 1, [], {}
    for cd, (cands, _st) in zip(llm.candidates, searched):
        e = {'rank': cd.rank, 'recommended_name': cd.name, 'recommended_area': cd.area_hint, 'places_candidates': []}
        for pos, p in enumerate(cands, 1):
            e['places_candidates'].append({'candidate_id': nid, 'name': p.get('name') or '', 'area': p.get('formatted_address') or ''})
            pmap[nid] = (pos, p)
            nid += 1
        if e['places_candidates']:
            recs.append(e)
    if not recs:
        m['c_cards'] = m['b_cards'] = 0
        return
    try:
        sel, m['sel_ms'], _ = selector.select(recs)
    except SelectionError as e:
        m['sel_err'], m['c_cards'] = e.error_type, 0
        sel = {}
    pairs = [{'id': r['rank'], 'recommended_name': r['recommended_name'], 'recommended_area': r['recommended_area'],
              'matched_name': r['places_candidates'][0]['name'], 'matched_area': r['places_candidates'][0]['area']} for r in recs]
    try:
        ident, m['id_ms'], _ = identity.verify(pairs)
    except IdentityError as e:
        m['id_err'], ident = e.error_type, {}
    c_cards, b_cards, seen_c, seen_b, pos = [], [], set(), set(), {}
    for cd in llm.candidates:
        cid = sel.get(cd.rank, (None, ''))[0]
        if cid is not None:
            p_pos, p = pmap[cid]
            pos[p_pos] = pos.get(p_pos, 0) + 1
            d = legacy_places.fetch_selected_details(p, geo, 'ja')
            if d and d['place_id'] not in seen_c and len(c_cards) < c.DISPLAY_COUNT:
                seen_c.add(d['place_id'])
                c_cards.append(d['name'])
        if ident.get(cd.rank, ('', ''))[0] == c.SAME and len(b_cards) < c.DISPLAY_COUNT:
            pid = searched[cd.rank - 1][0][0]['place_id']
            if pid not in seen_b:
                seen_b.add(pid)
                b_cards.append(pid)
    m['c_cards'], m['b_cards'], m['positions'] = len(c_cards), len(b_cards), pos
    say(f'    B カード={len(b_cards)}  C カード={len(c_cards)}  選択位置={pos}  選択LLM={m.get("sel_ms")}ms')


def report_real(rows, allow_selection):
    normal = [r for r in rows if not r['latest']]
    latest = [r for r in rows if r['latest']]
    ok = [r for r in normal if 'rec_fail' not in r]
    say('\n【第 2 部 集計（通常クエリ）】')
    say(f'  試行 {len(normal)} 回 / 推薦LLM失敗 {len(normal) - len(ok)} 回 {[r["rec_fail"] for r in normal if "rec_fail" in r]}')
    if ok:
        say(f'  A（33秒版 1位採用）5件完成: {sum(1 for r in ok if r["a_cards"] >= 5)}/{len(ok)}  '
            f'平均 {statistics.mean(r["a_cards"] for r in ok):.2f} 件  Places候補0件の店舗 計 {sum(r["not_found"] for r in ok)}')
        if allow_selection:
            for k in ('b', 'c'):
                v = [r.get(f'{k}_cards', 0) for r in ok]
                say(f'  {k.upper()} 5件完成: {sum(1 for x in v if x >= 5)}/{len(ok)}  平均 {statistics.mean(v):.2f} 件')
        else:
            say('  B / C の 5件完成率: 未計測（実 Places データを LLM に送る許容が未確認のため実行していない）')
        say(f'  Google 検索呼び出し（推薦LLM）: 合計 {sum(r["gsearch"] for r in ok)}')
        say(f'  推薦LLM: {stats([r["llm_ms"] for r in ok])}')
        say(f'  Places Text Search（7店舗並列・上位5候補）: {stats([r["ts_ms"] for r in ok])}')
        say(f'  Place Details（A: 1位候補・並列）: {stats([r["det_ms"] for r in ok])}')
        say(f'  合計（推薦LLM + Places、選択LLMなし）: {stats([r["total_ms"] for r in ok])}')
    say('\n【第 2 部 最新情報クエリ】' + LATEST_QUERY)
    for r in latest:
        if 'rec_fail' in r:
            say(f'  推薦LLM失敗: {r["rec_fail"]}（{r["total_ms"]} ms）')
        else:
            say(f'  推薦 {r["n_rec"]} 店舗 / A カード {r["a_cards"]} 件 / Places候補0件 {r["not_found"]} 店舗 / 合計 {r["total_ms"]} ms')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--repeat', type=int, default=1)
    ap.add_argument('--skip-real', action='store_true')
    ap.add_argument('--real-selection', action='store_true')
    args = ap.parse_args()
    gkey = os.environ.get('GEMINI_RECOMMEND_API_KEY', '')
    if not gkey:
        sys.exit('GEMINI_RECOMMEND_API_KEY が設定されていません')
    register_secret(gkey)
    register_secret(os.environ.get('GOOGLE_PLACES_API_KEY', ''))
    say(f'git_sha={os.environ.get("GIT_SHA", "unknown")}  model={c.MODEL_ID}  thinking={c.THINKING_LEVEL}  '
        f'Google検索=なし（tools 未指定）  選択LLM=1 検索につき 1 回・最大 {c.CANDIDATE_LIMIT} 店舗 × {c.SELECTION_MAX_CANDIDATES} 候補')
    run_fixtures(LlmCandidateSelector(gkey), LlmIdentityVerifier(gkey), args.repeat)
    if not args.skip_real:
        ref = os.environ.get('PLACES_LLM_TOS_APPROVAL_REF', '').strip()
        allow = bool(args.real_selection and ref)
        if args.real_selection and not ref:
            say('\n--real-selection は無視しました: 規約上の許容の根拠（PLACES_LLM_TOS_APPROVAL_REF）が未設定')
        if allow:
            say(f'\n実 Places データを選択 LLM に送ります（許容の根拠: {ref[:120]}）')
        run_real(gkey, args.repeat, allow)
    say(f'\n出力への API キー残存: {"あり（要確認）" if contains_secret(chr(10).join(OUT)) else "なし"}')


if __name__ == '__main__':
    main()
