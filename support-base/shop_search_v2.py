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
