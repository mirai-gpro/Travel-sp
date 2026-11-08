"""
shop_search_v2 の PoC 計測（Cloud Shell 等で手動実行。本番コードからは呼ばれない）

  probe : gemini-3.8-flash の応答を 3 回だけ試す（短い文 / +thinking low / 実際の候補生成）。
          504 などの原因切り分け用。各呼び出しの時間・トークン数・エラーを表示する。
  A     : PoC A = A（知識候補）→ 順位づけ → Places 照合（今までの search_place）
  diag  : 置き換わりの原因調査。今までの search_place をそのまま呼び、Text Search が返した全件
          （順位・店名・営業状態・住所）・件数と、採用された 1 件とその Places (New) 店舗タイプを表示する
  B     : PoC B = A ∥ B（2.5-flash + Google 検索）→ 統合・順位づけ → Places 照合
  run の --gates observe（既定）で、照合できた店ごとに採否判定（①ジャンル ②すり替わり）を記録する

使い方（キーは環境変数で渡す。表示もログ出力もしない）:
  python tools/poc_shop_search_v2.py probe
  python tools/poc_shop_search_v2.py run --pocs A,B --runs 1
  python tools/poc_shop_search_v2.py run --pocs B --queries 0,4 --llm-timeout 60
  python tools/poc_shop_search_v2.py diag "恵比寿 串亭@恵比寿" "鳥貴族 渋谷明治通り店@渋谷"

出力: 1 回ごとに 1 行（JSON）。最後に PoC ごとの p50 / p95。
"""
import argparse
import json
import os
import statistics
import sys
import time
from datetime import date

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from google import genai  # noqa: E402
from google.genai import types  # noqa: E402
import shop_search_v2 as v2  # noqa: E402

# 仕様書 v1.1 §7 の評価ケース
QUERIES = [
    ("famous", "ja", "銀座 寿司 カウンター 記念日 2名 予算1人3万円"),
    ("date", "ja", "恵比寿 焼き鳥 デート 2名 予算1人8000円"),
    ("settai_private", "ja", "渋谷 イタリアン 個室 接待 4名 予算1人1万円"),
    ("recent", "ja", "表参道 2026年にオープンした カフェ"),
    ("recent", "ja", "梅田 最近リニューアルした 焼肉 6名"),
    ("same_name", "ja", "鳥貴族 渋谷 飲み会 4名"),
    ("neighbor", "ja", "神楽坂 フレンチ ランチ 2名"),
    ("closed_risk", "ja", "新宿 ゴールデン街 バー 一人"),
    ("multilang", "en", "Kyoto Gion kaiseki dinner for 2"),
    ("overseas", "ja", "ホノルル ステーキ 2名"),
]


def usage(resp):
    u = getattr(resp, "usage_metadata", None)
    if not u:
        return None
    return {k: getattr(u, k, None) for k in
            ("prompt_token_count", "candidates_token_count", "thoughts_token_count", "total_token_count")}


def probe(client, timeout_s, gap_s, model):
    http = types.HttpOptions(timeout=timeout_s * 1000)
    # gemini-2.x は thinking_level に対応しないため指定しない（比較用）
    think = (None if model.startswith("gemini-2")
             else types.ThinkingConfig(thinking_level="low"))
    steps = [
        ("minimal", "こんにちは。一言で返事してください。", types.GenerateContentConfig(http_options=http)),
        ("minimal-low", "こんにちは。一言で返事してください。",
         types.GenerateContentConfig(http_options=http, thinking_config=think)),
        ("knowledge", f"希望条件: {QUERIES[1][2]}",
         types.GenerateContentConfig(
             system_instruction=v2.knowledge_instruction("ja"),
             response_mime_type="application/json", response_json_schema=v2.KNOWLEDGE_SCHEMA,
             thinking_config=think, http_options=http)),
    ]
    for i, (label, contents, cfg) in enumerate(steps):
        if i:
            time.sleep(gap_s)
        t0 = time.monotonic()
        try:
            resp = client.models.generate_content(model=model, contents=contents, config=cfg)
            out = {"model": model, "step": label, "ok": True, "sec": round(time.monotonic() - t0, 2),
                   "usage": usage(resp), "text_len": len(resp.text or "")}
        except Exception as e:
            out = {"model": model, "step": label, "ok": False, "sec": round(time.monotonic() - t0, 2),
                   "error": f"{type(e).__name__}: {str(e)[:160]}"}
        print(json.dumps(out, ensure_ascii=False), flush=True)


DIAG_DEFAULT = ["恵比寿 串亭@恵比寿", "地鶏やおまへん 恵比寿店@恵比寿", "鳥貴族 渋谷明治通り店@渋谷",
                "喜鈴 恵比寿@恵比寿", "中目黒いぐち 恵比寿店@恵比寿"]


def diag(items, language):
    """今までの search_place の Text Search 応答を横取りして全件表示する（search_place 自体は変更しない）"""
    import requests
    legacy = v2.legacy
    captured = []
    orig_get = requests.get

    def spy_get(url, *a, **kw):
        resp = orig_get(url, *a, **kw)
        if "textsearch" in url:
            try:
                captured.append(resp.json())
            except ValueError:
                captured.append({"status": f"HTTP {resp.status_code}"})
        return resp

    for item in items:
        name, _, area = item.partition("@")
        geo = legacy.get_region_from_area(area, language) if area else None
        # 1) 今までの照合と同じ条件（候補名 + エリア + 都道府県、位置バイアスあり）  2) 候補名だけ
        for label, args in (("legacy", (name, area, geo, language)), ("name_only", (name, "", None, language))):
            captured.clear()
            requests.get = spy_get
            try:
                place = legacy.search_place(*args)
            finally:
                requests.get = orig_get
            data = captured[0] if captured else {}
            region = (geo or {}).get("region", "") if label == "legacy" else ""
            types = (v2.fetch_place_types(os.environ.get("GOOGLE_PLACES_API_KEY", ""), place["place_id"])
                     if place and place.get("place_id") else None)
            out = {"cand": name, "variant": label,
                   "query": " ".join(x for x in (name, area if label == "legacy" else "", region) if x),
                   "status": data.get("status"),
                   "adopted": (place or {}).get("name"),
                   "adopted_types": types,
                   "result_count": len(data.get("results") or []),
                   "name_match": v2.name_overlaps(name, (place or {}).get("name") or "", (area,)),
                   "results": [{"rank": i + 1, "name": r.get("name"),
                                "business_status": r.get("business_status", "(なし)"),
                                "address": (r.get("formatted_address") or "")[:40],
                                "types": (r.get("types") or [])[:3]}
                               for i, r in enumerate((data.get("results") or [])[:8])]}
            print(json.dumps(out, ensure_ascii=False), flush=True)


def pct(values, q):
    if not values:
        return None
    s = sorted(values)
    return s[max(0, min(len(s) - 1, round(q * (len(s) - 1))))]


def run(client, places_key, pocs, q_idx, runs, gap_s, gates="observe"):
    results = {p: [] for p in pocs}
    for r in range(runs):
        for qi in q_idx:
            kind, lang, query = QUERIES[qi]
            for poc in pocs:
                row = {"poc": poc, "query_no": qi, "kind": kind, "run": r}
                t0 = time.monotonic()
                try:
                    res = v2.search_shops(query, lang, client, places_key, today=date.today(),
                                          use_recent=(poc == "B"), gates=gates)
                    rc = res["recent_check"]
                    row.update(ok=True, status=res["status"], timings=res["timings"], stats=res["stats"],
                               recent={"status": rc["status"], "reason": rc.get("reason", ""),
                                       "updates": [{k: u.get(k) for k in ("name", "event_type", "event_date")}
                                                   for u in rc["updates"]],
                                       "queries": rc.get("queries", []), "sources": len(rc.get("sources", []))},
                               shops=[{"name": s["name"], "source": s["source_type"],
                                       "recent": (s.get("recent") or {}).get("event_type"),
                                       "rating": s["rating"], "price": s["priceRange"]} for s in res["shops"]],
                               matched=res.get("matched", []),
                               rejected=res.get("rejected_detail", []))
                except v2.ShopSearchError as e:
                    row.update(ok=False, error_stage=e.stage, error=e.reason,
                               total_ms=round((time.monotonic() - t0) * 1000))
                results[poc].append(row)
                print(json.dumps(row, ensure_ascii=False), flush=True)
                time.sleep(gap_s)

    print("\n=== 集計（ms） ===")
    for poc in pocs:
        rows = [x for x in results[poc] if x.get("ok")]
        print(f"PoC {poc}: 成功 {len(rows)} / {len(results[poc])}")
        for key in ("a_ms", "b_ms", "area_ms", "rank_ms", "places_ms", "total_ms"):
            vals = [x["timings"][key] for x in rows if key in x["timings"]]
            if vals:
                print(f"  {key:9} n={len(vals):3} p50={statistics.median(vals)} p95={pct(vals, 0.95)}")
        verdicts = {}
        for x in rows:
            for m in x.get("matched", []) + x.get("rejected", []):
                v = (m.get("gate") or {}).get("verdict")
                if v:
                    verdicts[v] = verdicts.get(v, 0) + 1
        if verdicts:
            print(f"  採否判定 {verdicts}")
        cards = [len(x["shops"]) for x in rows]
        if cards:
            print(f"  カード件数 平均={round(statistics.mean(cards), 2)} / 0件={cards.count(0)}")


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    p1 = sub.add_parser("probe")
    p1.add_argument("--timeout", type=int, default=90)
    p1.add_argument("--gap", type=int, default=10)
    p1.add_argument("--model", default=v2.KNOWLEDGE_MODEL, help="比較用。本番の設定は変えない")
    p3 = sub.add_parser("diag")
    p3.add_argument("items", nargs="*", help="「候補名@エリア」を並べる。省略時は前回置き換わった 3 件 + 対照 2 件")
    p3.add_argument("--lang", default="ja")
    p2 = sub.add_parser("run")
    p2.add_argument("--pocs", default="A,B")
    p2.add_argument("--queries", default="all")
    p2.add_argument("--query", action="append", default=[], help="任意の検索条件（日本語）。指定すると --queries より優先")
    p2.add_argument("--runs", type=int, default=1)
    p2.add_argument("--gap", type=int, default=3, help="検索ごとの間隔（秒）。429 回避用")
    p2.add_argument("--llm-timeout", type=int, default=None, help="LLM のタイムアウト（秒）。既定は v2 の値")
    p2.add_argument("--knowledge-model", default=None, help="A と順位づけのモデル（比較用。本番の設定は変えない）")
    p2.add_argument("--recent-model", default=None, help="B のモデル（比較用。本番の設定は変えない）")
    p2.add_argument("--gates", choices=("off", "observe", "enforce"), default="observe",
                    help="採否判定。observe=判定して記録のみ（既定） / enforce=判定で不採用にする / off")
    args = ap.parse_args()

    places_key = os.environ.get("GOOGLE_PLACES_API_KEY", "")
    gemini_key = os.environ.get("GEMINI_API_KEY", "")
    if args.cmd == "diag":
        if not places_key:
            print("GOOGLE_PLACES_API_KEY を環境変数で渡してください", file=sys.stderr)
            sys.exit(2)
        diag(args.items or DIAG_DEFAULT, args.lang)
        return
    if not gemini_key or (args.cmd == "run" and not places_key):
        print("GEMINI_API_KEY（run では GOOGLE_PLACES_API_KEY も）を環境変数で渡してください", file=sys.stderr)
        sys.exit(2)
    client = genai.Client(api_key=gemini_key)

    if args.cmd == "probe":
        probe(client, args.timeout, args.gap, args.model)
        return
    if args.llm_timeout:
        v2.LLM_TIMEOUT_MS = args.llm_timeout * 1000
    if args.knowledge_model:
        v2.KNOWLEDGE_MODEL = args.knowledge_model
        v2.RANK_MODEL = args.knowledge_model
    if args.recent_model:
        v2.RECENT_MODEL = args.recent_model
    print(json.dumps({"knowledge_model": v2.KNOWLEDGE_MODEL, "rank_model": v2.RANK_MODEL,
                      "recent_model": v2.RECENT_MODEL, "llm_timeout_ms": v2.LLM_TIMEOUT_MS}), flush=True)
    if args.query:
        QUERIES[:] = [("custom", "ja", q) for q in args.query]
        q_idx = range(len(QUERIES))
    else:
        q_idx = range(len(QUERIES)) if args.queries == "all" else [int(x) for x in args.queries.split(",")]
    pocs = [p for p in args.pocs.split(",") if p in ("A", "B")]
    run(client, places_key, pocs, q_idx, args.runs, args.gap, args.gates)


if __name__ == "__main__":
    main()
