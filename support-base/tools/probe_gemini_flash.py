"""
gemini-3.8-flash の応答時間・トークン数を切り分けるための診断スクリプト（手動実行用）

各ステップを 1 回ずつ実行し、経過時間・usage_metadata・エラーを表示する:
  1. minimal   : 短い文だけ（スキーマなし・thinking 指定なし）
  2. minimal-low: 短い文 + thinking_level=low
  3. selection : 実際の選定プロンプト（Places 候補 + JSON スキーマ + thinking_level=low）
クライアント側のタイムアウトは --timeout 秒（既定 90 秒）。各呼び出しの間は --gap 秒あける。

使い方:
  GOOGLE_PLACES_API_KEY=... GEMINI_API_KEY=... python tools/probe_gemini_flash.py
"""
import argparse
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from google import genai  # noqa: E402
from google.genai import types  # noqa: E402
import shop_search_v2 as v2  # noqa: E402


def usage(resp):
    u = getattr(resp, "usage_metadata", None)
    if not u:
        return None
    return {k: getattr(u, k, None) for k in
            ("prompt_token_count", "candidates_token_count", "thoughts_token_count", "total_token_count")}


def call(client, label, model, contents, config):
    t0 = time.monotonic()
    try:
        resp = client.models.generate_content(model=model, contents=contents, config=config)
        out = {"step": label, "ok": True, "sec": round(time.monotonic() - t0, 2),
               "usage": usage(resp), "text_len": len(resp.text or "")}
    except Exception as e:
        out = {"step": label, "ok": False, "sec": round(time.monotonic() - t0, 2),
               "error": f"{type(e).__name__}: {str(e)[:160]}"}
    print(json.dumps(out, ensure_ascii=False), flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default=v2.SELECTION_MODEL)
    ap.add_argument("--timeout", type=int, default=90)
    ap.add_argument("--gap", type=int, default=10)
    ap.add_argument("--query", default="恵比寿 焼き鳥")
    args = ap.parse_args()
    places_key = os.environ.get("GOOGLE_PLACES_API_KEY", "")
    client = genai.Client(api_key=os.environ.get("GEMINI_API_KEY", ""))
    http = types.HttpOptions(timeout=args.timeout * 1000)

    call(client, "minimal", args.model, "こんにちは。一言で返事してください。",
         types.GenerateContentConfig(http_options=http))
    time.sleep(args.gap)
    call(client, "minimal-low", args.model, "こんにちは。一言で返事してください。",
         types.GenerateContentConfig(http_options=http,
                                     thinking_config=types.ThinkingConfig(thinking_level="low")))
    time.sleep(args.gap)

    places = v2.places_text_search(places_key, args.query, "ja", "atmosphere")
    verified, _ = v2.verify_places(places)
    candidates = [v2.candidate_for_llm(p) for p in verified]
    print(json.dumps({"step": "places", "candidates": len(candidates),
                      "candidate_json_chars": len(json.dumps(candidates, ensure_ascii=False))}),
          flush=True)
    contents = (f"検索条件: {args.query}\n\n"
                f"候補リスト:\n{json.dumps(candidates, ensure_ascii=False)}")
    cfg = types.GenerateContentConfig(
        system_instruction=v2.SELECTION_INSTRUCTION.format(max_shops=v2.MAX_SHOPS, language="日本語"),
        response_mime_type="application/json",
        response_json_schema=v2.SELECTION_SCHEMA,
        thinking_config=types.ThinkingConfig(thinking_level="low"),
        http_options=http,
    )
    call(client, "selection", args.model, contents, cfg)


if __name__ == "__main__":
    main()
