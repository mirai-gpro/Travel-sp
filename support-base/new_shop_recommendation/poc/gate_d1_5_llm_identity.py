# -*- coding: utf-8 -*-
"""
Gate D1.5 — 同一性判定 LLM（gemini-3.8-flash / thinking low）の PoC 計測

  python -m new_shop_recommendation.poc.gate_d1_5_llm_identity --repeat 3
  python -m new_shop_recommendation.poc.gate_d1_5_llm_identity --repeat 3 --real   # 規約確認済みの場合のみ

モード:
  fixture（常に実行）: 独立に作成した架空の店舗ペア（identity_fixtures.json）を 7 組ずつ 1 回で判定し、
                       判定精度と同一性判定 LLM の処理時間を測る。実際の Places データではない。
  real   （既定で無効）: 実 Places 応答を判定 LLM に送る A/B 比較。Google Maps Platform 規約上の許容が
                       確認できていないため、環境変数 PLACES_TO_LLM_TOS_CONFIRMED=yes と --real の両方が
                       必要。それ以外では実行しない。
環境変数: GEMINI_RECOMMEND_API_KEY（必須）、GOOGLE_PLACES_API_KEY（real のみ）
"""
import argparse
import json
import os
import statistics
import sys
import time

from new_shop_recommendation import contracts as c
from new_shop_recommendation.llm_identity_verifier import IdentityError, LlmIdentityVerifier
from new_shop_recommendation.redact import contains_secret, redact, register_secret

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = []


def say(s=''):
    s = redact(s)
    OUT.append(s)
    print(s)


def stats(v):
    v = sorted(x for x in v if x is not None)
    if not v:
        return '—'
    p95 = v[min(len(v) - 1, int(round(0.95 * (len(v) - 1))))]
    return f'p50 {statistics.median(v):.0f} / p95 {p95:.0f} / 最大 {v[-1]:.0f} ms（n={len(v)}）'


def run_fixtures(verifier, repeat):
    data = json.load(open(os.path.join(HERE, 'identity_fixtures.json'), encoding='utf-8'))
    say('\n=== fixture モード: 独立作成の架空ペア（実際の Places データではない）===')
    durations, errors, rows = [], [], []
    for r in range(repeat):
        for st in data['sets']:
            pairs = [{'id': i, **{k: p[k] for k in ('recommended_name', 'recommended_area', 'matched_name', 'matched_area')}}
                     for i, p in enumerate(st['pairs'], 1)]
            try:
                res, dur, searches = verifier.verify(pairs)
            except IdentityError as e:
                errors.append((st['name'], e.error_type, e.detail[:200]))
                say(f'  [{st["name"]}] (#{r + 1}) 照合エラー: {e.error_type} {e.detail[:200]}')
                continue
            durations.append(dur)
            say(f'  [{st["name"]}] (#{r + 1}) 1 回で {len(pairs)} 組判定  {dur} ms  検索呼び出し={searches}')
            for i, p in enumerate(st['pairs'], 1):
                j, reason = res[i]
                rows.append({'set': st['name'], 'kind': p['kind'], 'rec': p['recommended_name'], 'got': j,
                             'expected': p['expected'], 'reason': reason, 'match': p['matched_name']})
    n = len(rows)
    ok = sum(1 for x in rows if x['got'] in x['expected'])
    serious = [x for x in rows if x['got'] == c.SAME and c.SAME not in x['expected']]
    false_neg = [x for x in rows if x['got'] == c.DIFFERENT and c.DIFFERENT not in x['expected']]
    same_to_unc = [x for x in rows if x['got'] == c.UNCERTAIN and x['expected'] == [c.SAME]]
    say('\n【fixture 判定精度】')
    say(f'  判定数 {n} / 許容内 {ok}（{100.0 * ok / max(n, 1):.1f}%）')
    say(f'  重大な誤判定（別店舗を SAME）: {len(serious)} 件')
    say(f'  同一店舗を DIFFERENT: {len(false_neg)} 件')
    say(f'  同一店舗（SAME のみ許容）を UNCERTAIN（採用減）: {len(same_to_unc)} 件')
    say(f'  照合エラー: {len(errors)} 回 {[e[1] for e in errors]}')
    say(f'  同一性判定 LLM 処理時間（7 組 1 回）: {stats(durations)}')
    for title, lst in [('重大な誤判定', serious), ('同一店舗を DIFFERENT', false_neg), ('SAME→UNCERTAIN', same_to_unc)]:
        if lst:
            say(f'  ── {title} の例（最大 5 件）')
            for x in lst[:5]:
                say(f'     {x["rec"]} ⇔ {x["match"]}（{x["kind"]}）→ {x["got"]}: {x["reason"][:80]}')
    return durations


QUERIES = [
    '横浜で美味しい焼き鳥屋を5軒', '銀座で評判の老舗の天ぷら店', '渋谷で落ち着いて過ごせるカフェ',
    '新宿で接待向けの個室がある和食 予算1人1万5千円 4名', '吉祥寺で子連れの家族でも行きやすいイタリアン',
    '東京駅から徒歩5分以内の美味しいラーメン', '中目黒 焼き鳥 予算1人5000円 2名', '札幌すすきので美味しいジンギスカン',
    '京都の祇園で記念日に行くカウンター割烹 予算1人2万円 2名', '大阪 梅田 串カツ 立ち飲み',
]


def run_real(gkey, repeat):
    from new_shop_recommendation.orchestrator import ShopRecommendationOrchestrator
    from new_shop_recommendation.recommender import RecommendationClient
    orch = ShopRecommendationOrchestrator(RecommendationClient(gkey), credential_kind='AQ',
                                          identity_verifier=LlmIdentityVerifier(gkey))
    say('\n=== real モード: 実 Places 応答を判定 LLM に送る A/B（規約確認済みとして実行）===')
    rows = []
    for r in range(repeat):
        for q in QUERIES:
            res = orch.run(q)
            m = res['metrics']
            et = res['error_type'] or ''
            m['_rec_fail'] = res['status'] in (c.ERROR, c.TIMED_OUT) and not et.startswith('identity_')
            m['_identity_fail'] = et.startswith('identity_')
            rows.append(m)
            say(f'\n[{q}] (#{r + 1}) status={res["status"]} error={et or "-"}')
            if m['_rec_fail']:
                say(f'  推薦LLM失敗のため A/B 対象外: {(res.get("error_detail") or "")[:200]}')
                time.sleep(2)
                continue
            say(f'  推薦LLM={m.get("llm_duration_ms")}ms 候補={m.get("llm_candidate_count")} Places={m.get("places_duration_ms")}ms '
                f'同一性LLM={m.get("identity_duration_ms")}ms（呼び出し{m.get("identity_calls")}回） 合計={m.get("total_duration_ms")}ms '
                f'検索呼び出し={m.get("google_search_calls")}/{m.get("identity_google_search_calls")}')
            say(f'  SAME={m.get("identity_same")} DIFFERENT={m.get("identity_different")} UNCERTAIN={m.get("identity_uncertain")}'
                f'  カード A(従来)={m.get("legacy_card_count")} B(SAME のみ)={m.get("identity_card_count") if not m["_identity_fail"] else "照合エラー"}')
            for v in res['verifications']:
                if v.get('identity') and v['identity'] != c.SAME:
                    say(f'    {v["rank"]}. {v["name"]} ⇔ {v["matched_name"]} → {v["identity"]}: {(v["identity_reason"] or "")[:80]}')
            say('  A のカード（従来）: ' + ' / '.join(f'{x["llm_name"]}→{x["name"]}' for x in res.get('legacy_cards', [])))
            say('  B のカード（SAME）: ' + ' / '.join(f'{x["llm_name"]}→{x["name"]}' for x in res['cards']))
            time.sleep(2)
    valid = [x for x in rows if not x['_rec_fail']]
    n = len(valid)
    b_cards = [0 if x['_identity_fail'] else (x.get('identity_card_count') or 0) for x in valid]
    a_cards = [x.get('legacy_card_count') or 0 for x in valid]
    say('\n【A/B 比較（同じ試行のデータ）】')
    say(f'  試行 {len(rows)} 回 / 推薦LLM失敗で対象外 {len(rows) - n} 回 / 同一性判定エラー {sum(1 for x in valid if x["_identity_fail"])} 回（B は 0 件扱い）')
    say('| 項目 | A 従来方式 | B SAME のみ |')
    say('|---|---:|---:|')
    say(f'| 5店舗完成 | {sum(1 for k in a_cards if k >= 5)}/{n} | {sum(1 for k in b_cards if k >= 5)}/{n} |')
    say(f'| 平均カード件数 | {statistics.mean(a_cards) if a_cards else 0:.2f} | {statistics.mean(b_cards) if b_cards else 0:.2f} |')
    say(f'| カード0件 | {sum(1 for k in a_cards if k == 0)}/{n} | {sum(1 for k in b_cards if k == 0)}/{n} |')
    tot = {k: sum((x.get(f'identity_{k}') or 0) for x in valid) for k in ('same', 'different', 'uncertain')}
    say(f'  判定の合計: SAME {tot["same"]} / DIFFERENT {tot["different"]} / UNCERTAIN {tot["uncertain"]}')
    say(f'  推薦LLM: {stats([x.get("llm_duration_ms") for x in valid])}')
    say(f'  Places: {stats([x.get("places_duration_ms") for x in valid])}')
    say(f'  同一性判定 LLM 追加時間: {stats([x.get("identity_duration_ms") for x in valid if not x["_identity_fail"]])}')
    say(f'  合計（B）: {stats([x.get("total_duration_ms") for x in valid])}')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--repeat', type=int, default=1)
    ap.add_argument('--real', action='store_true')
    args = ap.parse_args()
    gkey = os.environ.get('GEMINI_RECOMMEND_API_KEY', '')
    if not gkey:
        sys.exit('GEMINI_RECOMMEND_API_KEY が設定されていません')
    register_secret(gkey)
    register_secret(os.environ.get('GOOGLE_PLACES_API_KEY', ''))
    say(f'git_sha={os.environ.get("GIT_SHA", "unknown")}  model={c.MODEL_ID}  thinking={c.THINKING_LEVEL}  '
        f'Google検索=なし（tools 未指定）  同一性判定=1 検索につき 1 回・最大 {c.IDENTITY_MAX_PAIRS} 組')
    run_fixtures(LlmIdentityVerifier(gkey), args.repeat)
    if args.real:
        if os.environ.get('PLACES_TO_LLM_TOS_CONFIRMED') != 'yes':
            say('\nreal モードは実行しません: Places 応答を LLM に送ることの規約上の許容が未確認'
                '（PLACES_TO_LLM_TOS_CONFIRMED=yes が未設定）')
        else:
            run_real(gkey, args.repeat)
    else:
        say('\nreal モード（実 Places データ）: 未実行（規約上の許容が未確認のため既定で無効）')
    say(f'\n出力への API キー残存: {"あり（要確認）" if contains_secret(chr(10).join(OUT)) else "なし"}')


if __name__ == '__main__':
    main()
