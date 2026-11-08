"""
コンシェルジュ Live 用ショップ検索（LLM の知識ベースが主体）

流れ（仕様書 v1.1 §3）:
  A: Gemini 3.8 Flash（Google 検索なし）が、LLM の知識から条件に合う候補を短い JSON で列挙
  B: Google 検索で直近 12 か月の開店・改装・移転・業態変更を調べて候補を補う（A と並列）
  → A/B の候補を統合・重複除去し、LLM が順位づけ
  → Google Places (New) で候補を 1 件ずつ並列に照合（実在・名称・地域・営業状態）
  → 照合できた店だけを確定リストにする（最大 5 件。足りなければ少なく、0 件なら 0 件）

推薦するのは LLM。Places は「推薦店を選ぶエンジン」にはせず、実在確認とカードの事実項目にだけ使う。
失敗は ShopSearchError として呼び出し元に伝え、照合していない店では穴埋めしない。
API キー・写真 URL・会話内容はログに出さない。
"""

import json
import logging
import time

from google.genai import types

logger = logging.getLogger(__name__)

# A: 知識ベースの候補生成（Google 検索なし）
KNOWLEDGE_MODEL = "gemini-3.8-flash"
# 3.8 Flash の thinking_level（low / medium / high。minimal はエラー）
THINKING_LEVEL = "low"
LLM_TIMEOUT_MS = 30000

KNOWLEDGE_MIN = 5
KNOWLEDGE_MAX = 8

LANGUAGE_NAMES = {"ja": "日本語", "en": "English", "zh": "中文", "ko": "한국어"}


class ShopSearchError(Exception):
    """検索の失敗（stage: knowledge / rank / places など）。照合していない店で穴埋めしないために使う。"""

    def __init__(self, stage: str, reason: str):
        super().__init__(f"{stage}: {reason}")
        self.stage = stage
        self.reason = reason


def _lang(language: str) -> str:
    return LANGUAGE_NAMES.get(language, LANGUAGE_NAMES["ja"])


def _call_json_llm(client, stage: str, model: str, instruction: str, contents: str, schema: dict):
    """JSON スキーマ付きで LLM を呼び、dict を返す。失敗は ShopSearchError。"""
    config = types.GenerateContentConfig(
        system_instruction=instruction,
        response_mime_type="application/json",
        response_json_schema=schema,
        thinking_config=types.ThinkingConfig(thinking_level=THINKING_LEVEL),
        http_options=types.HttpOptions(timeout=LLM_TIMEOUT_MS),
    )
    try:
        response = client.models.generate_content(model=model, contents=contents, config=config)
    except Exception as e:
        raise ShopSearchError(stage, f"{model} 呼び出し失敗 ({type(e).__name__}: {str(e)[:120]})")
    text = getattr(response, "text", None)
    if not text:
        raise ShopSearchError(stage, "応答が空")
    try:
        data = json.loads(text)
    except ValueError:
        raise ShopSearchError(stage, "応答が JSON ではない")
    if not isinstance(data, dict):
        raise ShopSearchError(stage, "応答が JSON オブジェクトではない")
    return data


def _clean_str(value) -> str:
    return value.strip() if isinstance(value, str) else ""


# ------------------------------------------------------------
# A: LLM の知識ベースによる候補
# ------------------------------------------------------------
KNOWLEDGE_SCHEMA = {
    "type": "object",
    "properties": {
        "candidates": {
            "type": "array",
            "maxItems": KNOWLEDGE_MAX,
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "area": {"type": "string"},
                    "genre": {"type": "string"},
                    "reason": {"type": "string"},
                },
                "required": ["name", "area", "genre", "reason"],
            },
        }
    },
    "required": ["candidates"],
}

KNOWLEDGE_INSTRUCTION = """あなたはグルメに詳しいレストランのコンシェルジュです。
ユーザーの希望条件に合う実在のレストランを、あなたの知識から選び、合う順に{min_n}〜{max_n}件挙げてください。

【ルール】
1. 実在すると確信できる店だけを挙げる。存在に自信がない店、閉店したかもしれない店は挙げない。
2. name は店の正式名称（支店がある場合は支店名まで）。area はその店の最寄り駅または地名。
3. genre は料理ジャンル。reason は条件に合う理由を{language}で1文。
4. 価格・評価・口コミ数などの数値、営業時間、住所は書かない。
5. 条件に合う店が少なければ、件数は少なくてよい。無理に件数をそろえない。
出力は指定された JSON スキーマのみ。"""


def knowledge_candidates(client, user_request: str, language: str) -> list:
    """
    A: LLM の知識から候補を列挙する。
    戻り値: [{cand_id, name, area, genre, reason, source_type: "knowledge"}]（最大 KNOWLEDGE_MAX 件）
    """
    instruction = KNOWLEDGE_INSTRUCTION.format(min_n=KNOWLEDGE_MIN, max_n=KNOWLEDGE_MAX,
                                               language=_lang(language))
    data = _call_json_llm(client, "knowledge", KNOWLEDGE_MODEL, instruction,
                          f"希望条件: {user_request}", KNOWLEDGE_SCHEMA)
    items = data.get("candidates")
    if not isinstance(items, list):
        raise ShopSearchError("knowledge", "応答に candidates 配列がない")
    out = []
    for item in items:
        if not isinstance(item, dict):
            continue
        name = _clean_str(item.get("name"))
        area = _clean_str(item.get("area"))
        if not name or not area:
            continue
        out.append({
            "cand_id": f"k{len(out) + 1}",
            "name": name,
            "area": area,
            "genre": _clean_str(item.get("genre")),
            "reason": _clean_str(item.get("reason")),
            "source_type": "knowledge",
        })
        if len(out) >= KNOWLEDGE_MAX:
            break
    return out


# ------------------------------------------------------------
# B: Google 検索による直近 12 か月の更新情報（A と並列で実行する補足）
# ------------------------------------------------------------
# 候補 S1: gemini-2.5-flash + Google Search Grounding（無料プランでも利用枠あり。2026-12-01 停止予定）
RECENT_MODEL = "gemini-2.5-flash"
RECENT_MAX = 5
RECENT_WINDOW_DAYS = 365
RECENT_EVENT_TYPES = ("opened", "renovated", "moved", "concept_change")

RECENT_INSTRUCTION = """あなたはレストランの最新情報の調査担当です。
Google 検索で、ユーザーの希望条件（エリア・料理ジャンル・利用シーン）に合う店のうち、
{start} から {today} までの間に「新規開店・改装（リニューアル）・移転・業態変更」があった店を調べてください。

【ルール】
1. 検索で根拠が見つかった店だけを挙げる。最大{max_n}件。見つからなければ空配列。
2. event_type は opened / renovated / moved / concept_change のいずれか。
3. event_date は実際の開店・改装等の日付（YYYY-MM-DD または YYYY-MM）。記事の公開日ではない。分からなければ空文字。
4. source_url は根拠にしたページの URL。reason は{language}で1文。
5. 価格・評価などの数値は書かない。
出力は次の JSON だけ（前後に文章を付けない）:
{{"updates": [{{"name": "", "area": "", "genre": "", "event_type": "", "event_date": "", "source_url": "", "reason": ""}}]}}"""


def _extract_json_object(text: str):
    """文章中の最初の JSON オブジェクトを取り出す（Google 検索併用時は JSON モードが使えないため）。"""
    if not isinstance(text, str):
        return None
    start = text.find("{")
    while start >= 0:
        depth = 0
        in_str = False
        esc = False
        for i in range(start, len(text)):
            ch = text[i]
            if in_str:
                if esc:
                    esc = False
                elif ch == "\\":
                    esc = True
                elif ch == '"':
                    in_str = False
                continue
            if ch == '"':
                in_str = True
            elif ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    try:
                        return json.loads(text[start:i + 1])
                    except ValueError:
                        break
        start = text.find("{", start + 1)
    return None


def _parse_event_date(value: str):
    """YYYY-MM-DD / YYYY-MM を date にする（YYYY-MM は月初）。読めなければ None。"""
    from datetime import date
    if not isinstance(value, str):
        return None
    v = value.strip()
    try:
        if len(v) >= 10:
            return date.fromisoformat(v[:10])
        if len(v) == 7:
            return date.fromisoformat(v + "-01")
    except ValueError:
        return None
    return None


def _grounding_info(response) -> dict:
    """grounding_metadata から検索語・出典（uri/title）・Search Suggestions の HTML を取り出す。"""
    info = {"queries": [], "sources": [], "search_entry_point": None}
    cands = getattr(response, "candidates", None) or []
    gm = getattr(cands[0], "grounding_metadata", None) if cands else None
    if gm is None:
        return info
    info["queries"] = list(getattr(gm, "web_search_queries", None) or [])
    for ch in getattr(gm, "grounding_chunks", None) or []:
        web = getattr(ch, "web", None)
        if web is not None and getattr(web, "uri", None):
            info["sources"].append({"uri": web.uri, "title": getattr(web, "title", "") or ""})
    sep = getattr(gm, "search_entry_point", None)
    if sep is not None and getattr(sep, "rendered_content", None):
        info["search_entry_point"] = sep.rendered_content
    return info


def recent_updates(client, user_request: str, language: str, today) -> dict:
    """
    B: 直近 12 か月の開店・改装・移転・業態変更を Google 検索で調べる。
    失敗しても例外にはせず status="failed" を返す（A の結果は使う。ただし「最新情報の確認が未完了」と記録する）。
    戻り値: {status: "ok" | "failed", reason, updates: [...], queries, sources, search_entry_point}
    """
    from datetime import timedelta
    start = today - timedelta(days=RECENT_WINDOW_DAYS)
    instruction = RECENT_INSTRUCTION.format(start=start.isoformat(), today=today.isoformat(),
                                            max_n=RECENT_MAX, language=_lang(language))
    config = types.GenerateContentConfig(
        system_instruction=instruction,
        tools=[types.Tool(google_search=types.GoogleSearch())],
        http_options=types.HttpOptions(timeout=LLM_TIMEOUT_MS),
    )
    result = {"status": "failed", "reason": "", "updates": [], "queries": [], "sources": [],
              "search_entry_point": None}
    try:
        response = client.models.generate_content(model=RECENT_MODEL,
                                                  contents=f"希望条件: {user_request}", config=config)
    except Exception as e:
        result["reason"] = f"{RECENT_MODEL} 呼び出し失敗 ({type(e).__name__}: {str(e)[:120]})"
        return result
    result.update(_grounding_info(response))
    data = _extract_json_object(getattr(response, "text", None))
    if not isinstance(data, dict) or not isinstance(data.get("updates"), list):
        result["reason"] = "応答から updates の JSON を読み取れない"
        return result

    updates = []
    for item in data["updates"]:
        if not isinstance(item, dict):
            continue
        name = _clean_str(item.get("name"))
        area = _clean_str(item.get("area"))
        event_type = _clean_str(item.get("event_type"))
        if not name or not area or event_type not in RECENT_EVENT_TYPES:
            continue
        event_date = _clean_str(item.get("event_date"))
        d = _parse_event_date(event_date)
        if d is not None and not (start <= d <= today):
            continue   # 12 か月の範囲外は採用しない
        updates.append({
            "cand_id": f"r{len(updates) + 1}",
            "name": name,
            "area": area,
            "genre": _clean_str(item.get("genre")),
            "reason": _clean_str(item.get("reason")),
            "event_type": event_type,
            "event_date": event_date,
            "event_date_known": d is not None,
            "source_url": _clean_str(item.get("source_url")),
            "source_type": "search",
        })
        if len(updates) >= RECENT_MAX:
            break
    result["updates"] = updates
    result["status"] = "ok"
    return result
