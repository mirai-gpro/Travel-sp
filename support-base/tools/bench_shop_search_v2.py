"""
shop_search_v2 の実測ベンチマーク（Cloud Shell 等で手動実行。本番コードからは呼ばれない）

比較する構成:
  atm-low : Text Search Enterprise+Atmosphere / thinking_level=low   （採用候補）
  pro-low : Text Search Pro                   / thinking_level=low   （取得項目の比較）
  atm-med : Text Search Enterprise+Atmosphere / thinking_level=medium（thinking の比較）

使い方（キーは環境変数で渡す。表示もログ出力もしない）:
  GOOGLE_PLACES_API_KEY=... GEMINI_API_KEY=... python tools/bench_shop_search_v2.py --runs 5
  python tools/bench_shop_search_v2.py --runs 1 --configs atm-low --queries 0,1

出力: 1 回ごとに 1 行（JSON）。最後に構成ごとの p50 / p95 と Atmosphere 項目の取得率。
"""
import argparse
import json
import os
import statistics
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from google import genai  # noqa: E402
import shop_search_v2 as v2  # noqa: E402

QUERIES = [
    ("normal", "恵比寿 焼き鳥 デート 2名 予算1人8000円"),
    ("strict", "渋谷 イタリアン 個室 接待 4名 予算1人1万円"),
    ("strict", "銀座 寿司 カウンター 記念日 2名 予算1人3万円"),
    ("normal", "新宿 ラーメン 一人"),
    ("normal", "梅田 焼肉 6名 予算1人5000円"),
    ("normal", "京都 祇園 和食 落ち着いた雰囲気 2名"),
    ("new", "表参道 最近オープンした カフェ"),
    ("same_name", "鳥貴族 渋谷"),
    ("same_name", "叙々苑 六本木"),
    ("overseas", "ホノルル ステーキ 2名"),
]

CONFIGS = {
    "atm-low": ("atmosphere", "low"),
    "pro-low": ("pro", "low"),
    "atm-med": ("atmosphere", "medium"),
}

COVERAGE_KEYS = ["rating", "priceRange", "editorialSummary", "reviewSummary",
                 "goodForGroups", "reservable", "servesDinner"]


def pct(values, q):
    if not values:
        return None
    s = sorted(values)
    k = max(0, min(len(s) - 1, round(q * (len(s) - 1))))
    return s[k]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", type=int, default=5)
    ap.add_argument("--configs", default=",".join(CONFIGS))
    ap.add_argument("--queries", default="all", help="例: 0,1,7（QUERIES の番号）")
    ap.add_argument("--language", default="ja")
    args = ap.parse_args()

    places_key = os.environ.get("GOOGLE_PLACES_API_KEY", "")
    gemini_key = os.environ.get("GEMINI_API_KEY", "")
    if not places_key or not gemini_key:
        print("GOOGLE_PLACES_API_KEY と GEMINI_API_KEY を環境変数で渡してください", file=sys.stderr)
        sys.exit(2)
    client = genai.Client(api_key=gemini_key)

    q_idx = range(len(QUERIES)) if args.queries == "all" else [int(x) for x in args.queries.split(",")]
    configs = [c for c in args.configs.split(",") if c in CONFIGS]

    results = {c: [] for c in configs}
    coverage = {c: {k: [0, 0] for k in COVERAGE_KEYS} for c in configs}
    for run in range(args.runs):
        for qi in q_idx:
            kind, query = QUERIES[qi]
            for c in configs:
                profile, thinking = CONFIGS[c]
                row = {"config": c, "query_no": qi, "kind": kind, "run": run}
                t0 = time.monotonic()
                try:
                    places = v2.places_text_search(places_key, query, args.language, profile)
                    t1 = time.monotonic()
                    verified, rejected = v2.verify_places(places)
                    row.update(places_ms=round((t1 - t0) * 1000), candidates=len(places),
                               verified=len(verified), rejected=rejected)
                    for p in verified:
                        for k in COVERAGE_KEYS:
                            coverage[c][k][1] += 1
                            if p.get(k) not in (None, "", {}, []):
                                coverage[c][k][0] += 1
                    if verified:
                        by_id = {p["id"]: p for p in verified}
                        sel = v2.select_with_llm(client, query,
                                                 [v2.candidate_for_llm(p) for p in verified],
                                                 args.language, thinking_level=thinking)
                        t2 = time.monotonic()
                        accepted, llm_rej = v2.validate_selection(sel, by_id)
                        row.update(llm_ms=round((t2 - t1) * 1000), selected=len(accepted),
                                   llm_rejected=len(llm_rej),
                                   shops=[{"name": by_id[a["place_id"]]["displayName"]["text"],
                                           "area": a["area"], "description": a["description"]}
                                          for a in accepted])
                    row["total_ms"] = round((time.monotonic() - t0) * 1000)
                    row["ok"] = True
                except v2.ShopSearchError as e:
                    row.update(ok=False, error_stage=e.stage, error=e.reason,
                               total_ms=round((time.monotonic() - t0) * 1000))
                results[c].append(row)
                print(json.dumps(row, ensure_ascii=False), flush=True)

    print("\n=== 集計（ms） ===")
    for c in configs:
        rows = [r for r in results[c] if r.get("ok")]
        fails = len(results[c]) - len(rows)
        for key in ("places_ms", "llm_ms", "total_ms"):
            vals = [r[key] for r in rows if key in r]
            p50 = statistics.median(vals) if vals else None
            print(f"{c:8} {key:9} n={len(vals):3} p50={p50} p95={pct(vals, 0.95)}")
        sel_counts = [r.get("selected", 0) for r in rows]
        print(f"{c:8} 失敗={fails} 選定件数の平均={round(statistics.mean(sel_counts), 2) if sel_counts else None}")
        cov = ", ".join(f"{k}={v[0]}/{v[1]}" for k, v in coverage[c].items())
        print(f"{c:8} 取得率: {cov}")


if __name__ == "__main__":
    main()
