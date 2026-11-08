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
import unicodedata
import uuid
from concurrent.futures import ThreadPoolExecutor

import requests
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


# ------------------------------------------------------------
# 統合・重複除去・順位づけ
# ------------------------------------------------------------
RANK_MODEL = "gemini-3.8-flash"
MAX_SHOPS = 5

_PUNCT = set(" 　・･'’\"「」『』()（）[]［］.,、。-‐－&＆/／")
_AREA_SUFFIXES = ("駅周辺", "周辺", "エリア", "駅")


def normalize_name(text: str) -> str:
    """比較用の正規化（NFKC・小文字・空白と記号を除去）。"""
    t = unicodedata.normalize("NFKC", text or "").lower()
    return "".join(ch for ch in t if ch not in _PUNCT and not ch.isspace())


def normalize_area(text: str) -> str:
    a = normalize_name(text)
    for suf in _AREA_SUFFIXES:
        if a.endswith(suf) and len(a) > len(suf):
            a = a[: -len(suf)]
            break
    return a


def merge_candidates(knowledge: list, recent: list) -> list:
    """A の後に B を並べ、(店名, エリア) が同じものは 1 つにまとめる（B の更新情報は A 側に付ける）。"""
    merged = []
    index = {}
    for c in list(knowledge) + list(recent):
        key = (normalize_name(c["name"]), normalize_area(c["area"]))
        if key in index:
            base = index[key]
            if c.get("source_type") == "search" and base.get("source_type") == "knowledge":
                base["recent"] = {k: c.get(k) for k in ("event_type", "event_date", "source_url")}
            continue
        item = dict(c)
        if c.get("source_type") == "search":
            item["recent"] = {k: c.get(k) for k in ("event_type", "event_date", "source_url")}
        index[key] = item
        merged.append(item)
    return merged


RANK_SCHEMA = {
    "type": "object",
    "properties": {
        "ranked": {
            "type": "array",
            "maxItems": KNOWLEDGE_MAX,
            "items": {
                "type": "object",
                "properties": {"cand_id": {"type": "string"}, "reason": {"type": "string"}},
                "required": ["cand_id", "reason"],
            },
        }
    },
    "required": ["ranked"],
}

RANK_INSTRUCTION = """あなたはレストランのコンシェルジュです。
ユーザーの希望条件と、店の候補リスト（あなたの知識による候補と、直近の開店・改装などの情報がある候補）が与えられます。
希望条件に合う順に候補を並べてください。

【ルール】
1. 候補リストの cand_id だけを使う。
2. 希望条件に合わない候補は入れない。最大{max_n}件。
3. 直近の開店・改装の情報は、希望条件に合う場合の判断材料にする（新しいことだけで上位にしない）。
4. reason は{language}で1文。候補リストにない価格・評価などの数値は書かない。
出力は指定された JSON スキーマのみ。"""


def rank_candidates(client, user_request: str, merged: list, language: str) -> list:
    """
    統合した候補を LLM が順位づけする。B の候補が無い場合は A の順位（LLM が条件に合う順に出したもの）をそのまま使う。
    戻り値: 順位順の候補リスト（reason は順位づけの理由で上書き）。
    """
    if not any(c.get("source_type") == "search" for c in merged):
        return list(merged)
    by_id = {c["cand_id"]: c for c in merged}
    payload = [{k: c.get(k) for k in ("cand_id", "name", "area", "genre", "reason", "recent")
                if c.get(k)} for c in merged]
    data = _call_json_llm(client, "rank", RANK_MODEL,
                          RANK_INSTRUCTION.format(max_n=KNOWLEDGE_MAX, language=_lang(language)),
                          f"希望条件: {user_request}\n\n候補リスト:\n{json.dumps(payload, ensure_ascii=False)}",
                          RANK_SCHEMA)
    items = data.get("ranked")
    if not isinstance(items, list):
        raise ShopSearchError("rank", "応答に ranked 配列がない")
    ranked = []
    seen = set()
    for it in items:
        cid = it.get("cand_id") if isinstance(it, dict) else None
        if cid not in by_id or cid in seen:
            continue
        seen.add(cid)
        c = dict(by_id[cid])
        r = _clean_str(it.get("reason"))
        if r:
            c["reason"] = r
        ranked.append(c)
    if not ranked and merged:
        raise ShopSearchError("rank", "順位づけの結果に有効な候補がない")
    return ranked


# ------------------------------------------------------------
# Google Places (New) による実在確認（候補ごとに並列）
# ------------------------------------------------------------
PLACES_TEXT_SEARCH_URL = "https://places.googleapis.com/v1/places:searchText"
PLACES_API_BASE = "https://places.googleapis.com/v1"
PLACES_TIMEOUT_SEC = 8
PLACES_PAGE_SIZE = 5
PLACES_MAX_WORKERS = 8
PHOTO_MAX_WIDTH_PX = 800

# 照合とカードの事実項目に使う項目（Text Search Pro + Enterprise の rating / userRatingCount / priceRange）
VERIFY_FIELDS = ",".join([
    "places.id", "places.movedPlaceId", "places.displayName", "places.formattedAddress",
    "places.businessStatus", "places.location", "places.googleMapsUri", "places.primaryType",
    "places.primaryTypeDisplayName", "places.types", "places.photos",
    "places.rating", "places.userRatingCount", "places.priceRange",
])

# 飲食店として扱う型（Places の Table A「Food and Drink」+ Table B の "food"）
FOOD_TYPES = frozenset("""
acai_shop afghani_restaurant african_restaurant american_restaurant argentinian_restaurant
asian_fusion_restaurant asian_restaurant australian_restaurant austrian_restaurant bagel_shop
bakery bangladeshi_restaurant bar bar_and_grill barbecue_restaurant basque_restaurant
bavarian_restaurant beer_garden belgian_restaurant bistro brazilian_restaurant
breakfast_restaurant brewery brewpub british_restaurant brunch_restaurant buffet_restaurant
burmese_restaurant burrito_restaurant cafe cafeteria cajun_restaurant cake_shop
californian_restaurant cambodian_restaurant candy_store cantonese_restaurant
caribbean_restaurant cat_cafe chicken_restaurant chicken_wings_restaurant chilean_restaurant
chinese_noodle_restaurant chinese_restaurant chocolate_factory chocolate_shop cocktail_bar
coffee_roastery coffee_shop coffee_stand colombian_restaurant confectionery
croatian_restaurant cuban_restaurant czech_restaurant danish_restaurant deli
dessert_restaurant dessert_shop dim_sum_restaurant diner dog_cafe donut_shop
dumpling_restaurant dutch_restaurant eastern_european_restaurant ethiopian_restaurant
european_restaurant falafel_restaurant family_restaurant fast_food_restaurant
filipino_restaurant fine_dining_restaurant fish_and_chips_restaurant fondue_restaurant
food_court french_restaurant fusion_restaurant gastropub german_restaurant greek_restaurant
gyro_restaurant halal_restaurant hamburger_restaurant hawaiian_restaurant hookah_bar
hot_dog_restaurant hot_dog_stand hot_pot_restaurant hungarian_restaurant ice_cream_shop
indian_restaurant indonesian_restaurant irish_pub irish_restaurant israeli_restaurant
italian_restaurant japanese_curry_restaurant japanese_izakaya_restaurant japanese_restaurant
juice_shop kebab_shop korean_barbecue_restaurant korean_restaurant latin_american_restaurant
lebanese_restaurant lounge_bar malaysian_restaurant meal_delivery meal_takeaway
mediterranean_restaurant mexican_restaurant middle_eastern_restaurant
mongolian_barbecue_restaurant moroccan_restaurant noodle_shop north_indian_restaurant
oyster_bar_restaurant pakistani_restaurant pastry_shop persian_restaurant peruvian_restaurant
pizza_delivery pizza_restaurant polish_restaurant portuguese_restaurant pub ramen_restaurant
restaurant romanian_restaurant russian_restaurant salad_shop sandwich_shop
scandinavian_restaurant seafood_restaurant shawarma_restaurant snack_bar soul_food_restaurant
soup_restaurant south_american_restaurant south_indian_restaurant southwestern_us_restaurant
spanish_restaurant sports_bar sri_lankan_restaurant steak_house sushi_restaurant
swiss_restaurant taco_restaurant taiwanese_restaurant tapas_restaurant tea_house
tex_mex_restaurant thai_restaurant tibetan_restaurant tonkatsu_restaurant turkish_restaurant
ukrainian_restaurant vegan_restaurant vegetarian_restaurant vietnamese_restaurant
western_restaurant wine_bar winery yakiniku_restaurant yakitori_restaurant
food
""".split())


def name_matches(candidate_name: str, place_name: str) -> bool:
    """候補名と Places の店名が明確に一致するか（完全一致・前方一致・長さ比 0.5 以上の包含）。"""
    a = normalize_name(candidate_name)
    b = normalize_name(place_name)
    if not a or not b:
        return False
    if a == b:
        return True
    short, long_ = (a, b) if len(a) <= len(b) else (b, a)
    if len(short) < 2:
        return False
    if long_.startswith(short):
        return True
    return short in long_ and len(short) / len(long_) >= 0.5


def area_matches(candidate_area: str, place: dict) -> bool:
    """候補のエリア名が、Places の住所または店名（支店名）に含まれるか。"""
    area = normalize_area(candidate_area)
    if not area:
        return False
    address = normalize_name(place.get("formattedAddress", ""))
    name = normalize_name((place.get("displayName") or {}).get("text", ""))
    return area in address or area in name


def _is_food(place: dict) -> bool:
    types_ = set(place.get("types") or [])
    if place.get("primaryType"):
        types_.add(place["primaryType"])
    return bool(types_ & FOOD_TYPES)


def _places_text_search(api_key: str, text_query: str, language: str, session=None) -> list:
    http = session or requests
    try:
        resp = http.post(
            PLACES_TEXT_SEARCH_URL,
            json={"textQuery": text_query, "languageCode": language, "pageSize": PLACES_PAGE_SIZE},
            headers={"Content-Type": "application/json", "X-Goog-Api-Key": api_key,
                     "X-Goog-FieldMask": VERIFY_FIELDS},
            timeout=PLACES_TIMEOUT_SEC,
        )
    except requests.exceptions.Timeout:
        raise ShopSearchError("places", "Text Search タイムアウト")
    except requests.exceptions.RequestException as e:
        # 例外メッセージは URL 等を含み得るので型名だけを残す
        raise ShopSearchError("places", f"Text Search 通信エラー ({type(e).__name__})")
    if resp.status_code != 200:
        status = ""
        try:
            status = (resp.json() or {}).get("error", {}).get("status", "")
        except ValueError:
            pass
        raise ShopSearchError("places", f"Text Search HTTP {resp.status_code} {status}".strip())
    try:
        places = (resp.json() or {}).get("places", [])
    except ValueError:
        raise ShopSearchError("places", "Text Search の応答が JSON ではない")
    return places if isinstance(places, list) else []


def verify_candidate(api_key: str, cand: dict, language: str, session=None) -> dict:
    """
    1 候補を Places で照合する。戻り値: {ok: bool, reason, place}
    採用条件: 店名が明確に一致 / エリアが一致 / OPERATIONAL / 飲食店 / 移転なし / 該当が 1 店に絞れる。
    """
    try:
        places = _places_text_search(api_key, f"{cand['name']} {cand['area']}", language, session)
    except ShopSearchError as e:
        return {"ok": False, "reason": "places_error", "detail": e.reason, "place": None}
    named = [p for p in places if isinstance(p, dict) and p.get("id")
             and p.get("formattedAddress")
             and name_matches(cand["name"], (p.get("displayName") or {}).get("text", ""))]
    if not named:
        return {"ok": False, "reason": "no_name_match", "place": None}
    in_area = [p for p in named if area_matches(cand["area"], p)]
    if not in_area:
        return {"ok": False, "reason": "area_mismatch", "place": None}
    eligible = []
    last_reason = ""
    for p in in_area:
        if p.get("movedPlaceId"):
            last_reason = "moved"
        elif p.get("businessStatus") != "OPERATIONAL":
            last_reason = f"status_{p.get('businessStatus') or 'missing'}"
        elif not _is_food(p):
            last_reason = "not_food"
        elif p["id"] not in {e["id"] for e in eligible}:
            eligible.append(p)
    if not eligible:
        return {"ok": False, "reason": last_reason or "not_eligible", "place": None}
    if len(eligible) > 1:
        exact = [p for p in eligible
                 if normalize_name(p["displayName"]["text"]) == normalize_name(cand["name"])]
        if len(exact) != 1:
            return {"ok": False, "reason": "ambiguous", "place": None}
        eligible = exact
    return {"ok": True, "reason": "", "place": eligible[0]}


def verify_candidates(api_key: str, ranked: list, language: str, session=None) -> tuple:
    """順位順の候補を並列に照合する。戻り値: (results: 候補と同じ順の照合結果, rejected 集計)。"""
    if not api_key:
        raise ShopSearchError("places", "GOOGLE_PLACES_API_KEY が未設定")
    if not ranked:
        return [], {}
    with ThreadPoolExecutor(max_workers=min(PLACES_MAX_WORKERS, len(ranked))) as ex:
        results = list(ex.map(lambda c: verify_candidate(api_key, c, language, session), ranked))
    rejected = {}
    for r in results:
        if not r["ok"]:
            rejected[r["reason"]] = rejected.get(r["reason"], 0) + 1
    if rejected.get("places_error", 0) == len(ranked):
        raise ShopSearchError("places", "全候補の照合で Places API がエラー")
    return results, rejected


def format_price_range(price_range) -> str | None:
    """Places の priceRange（Money）を表示用文字列にする。無ければ None。"""
    if not isinstance(price_range, dict):
        return None
    start = price_range.get("startPrice") or {}
    end = price_range.get("endPrice") or {}
    cur = start.get("currencyCode") or end.get("currencyCode")

    def num(units):
        try:
            return f"{int(units):,}"
        except (TypeError, ValueError):
            return None

    s = num(start.get("units")) if start.get("units") else None
    e = num(end.get("units")) if end.get("units") else None
    if not s and not e:
        return None
    if cur == "JPY":
        if s and e:
            return f"{s}円〜{e}円"
        return f"{s}円〜" if s else f"〜{e}円"
    if s and e:
        return f"{cur} {s}〜{e}"
    return f"{cur} {s}〜" if s else f"{cur} 〜{e}"


def build_shop(cand: dict, place: dict) -> dict:
    """カード用（ShopCardList の ShopData 互換）。事実項目は Places、理由は LLM。無い項目は None。"""
    recent = cand.get("recent")
    return {
        "place_id": place["id"],
        "name": place["displayName"]["text"],
        "area": cand["area"],
        "category": (place.get("primaryTypeDisplayName") or {}).get("text") or cand.get("genre") or "",
        "description": cand.get("reason") or "",
        "highlights": [],
        "location": place["formattedAddress"],
        "maps_url": place.get("googleMapsUri"),
        "rating": place.get("rating"),
        "reviewCount": place.get("userRatingCount"),
        "priceRange": format_price_range(place.get("priceRange")),
        "image": None,
        "tips": None,
        "source_type": cand.get("source_type"),
        "recent": recent,
        "verified": True,
        "verification": {"provider": "google_places_new", "business_status": place.get("businessStatus")},
    }


# ------------------------------------------------------------
# 全体の流れ
# ------------------------------------------------------------
def search_shops(user_request: str, language: str, gemini_client, places_api_key: str,
                 today=None, use_recent: bool = True, session=None) -> dict:
    """
    A ∥ B → 統合・順位づけ → Places 並列照合 → 確定リスト（最大 5 件）。
    戻り値: {search_id, status: verified | no_candidates | no_verified, shops, photo_refs,
             recent_check: {status, reason, updates, sources, queries, search_entry_point},
             timings: {a_ms, b_ms, rank_ms, places_ms, total_ms}, stats}
    A・順位づけ・Places 全滅は ShopSearchError。B の失敗は recent_check.status=failed として記録する。
    """
    from datetime import date
    today = today or date.today()
    search_id = str(uuid.uuid4())
    t0 = time.monotonic()
    timings = {}

    def timed(key, fn, *args):
        s = time.monotonic()
        try:
            return fn(*args)
        finally:
            timings[key] = round((time.monotonic() - s) * 1000)

    ex = ThreadPoolExecutor(max_workers=2)
    try:
        fa = ex.submit(timed, "a_ms", knowledge_candidates, gemini_client, user_request, language)
        fb = (ex.submit(timed, "b_ms", recent_updates, gemini_client, user_request, language, today)
              if use_recent else None)
        knowledge = fa.result()
        recent = fb.result() if fb else {"status": "skipped", "reason": "", "updates": [],
                                          "queries": [], "sources": [], "search_entry_point": None}
    finally:
        ex.shutdown(wait=False)

    merged = merge_candidates(knowledge, recent["updates"])
    stats = {"knowledge": len(knowledge), "recent": len(recent["updates"]), "merged": len(merged)}
    if not merged:
        timings["total_ms"] = round((time.monotonic() - t0) * 1000)
        logger.info(f"[ShopSearchV2] search_id={search_id} 候補 0 件 recent={recent['status']} timings={timings}")
        return {"search_id": search_id, "status": "no_candidates", "shops": [], "photo_refs": {},
                "recent_check": recent, "timings": timings, "stats": stats}

    ranked = timed("rank_ms", rank_candidates, gemini_client, user_request, merged, language)
    results, rejected = timed("places_ms", verify_candidates, places_api_key, ranked, language, session)

    shops, photo_refs, seen = [], {}, set()
    for cand, r in zip(ranked, results):
        if not r["ok"] or r["place"]["id"] in seen:
            continue
        seen.add(r["place"]["id"])
        shop = build_shop(cand, r["place"])
        shops.append(shop)
        photos = r["place"].get("photos") or []
        if photos and isinstance(photos[0], dict) and photos[0].get("name"):
            photo_refs[shop["place_id"]] = photos[0]
        if len(shops) >= MAX_SHOPS:
            break

    timings["total_ms"] = round((time.monotonic() - t0) * 1000)
    stats.update(ranked=len(ranked), verified=len(shops), rejected=rejected)
    status = "verified" if shops else "no_verified"
    logger.info(f"[ShopSearchV2] search_id={search_id} status={status} recent={recent['status']} "
                f"stats={stats} timings={timings}")
    return {"search_id": search_id, "status": status, "shops": shops, "photo_refs": photo_refs,
            "recent_check": recent, "timings": timings, "stats": stats}


# ------------------------------------------------------------
# カード表示後に取る補助情報（写真・電話番号）
# ------------------------------------------------------------
def fetch_photo(api_key: str, photo: dict, session=None) -> dict | None:
    """
    写真の photoUri（skipHttpRedirect=true）と撮影者情報を取る。失敗時は None（写真は任意項目）。
    API キーはヘッダーで送り、URL・ログ・戻り値に含めない。
    """
    name = photo.get("name") if isinstance(photo, dict) else None
    if not api_key or not name:
        return None
    http = session or requests
    try:
        resp = http.get(f"{PLACES_API_BASE}/{name}/media",
                        params={"maxWidthPx": PHOTO_MAX_WIDTH_PX, "skipHttpRedirect": "true"},
                        headers={"X-Goog-Api-Key": api_key}, timeout=PLACES_TIMEOUT_SEC)
    except requests.exceptions.RequestException as e:
        logger.warning(f"[ShopSearchV2] 写真取得失敗 ({type(e).__name__})")
        return None
    if resp.status_code != 200:
        logger.warning(f"[ShopSearchV2] 写真取得失敗 HTTP {resp.status_code}")
        return None
    try:
        uri = (resp.json() or {}).get("photoUri")
    except ValueError:
        return None
    if not uri:
        return None
    attributions = [{"displayName": a["displayName"], "uri": a.get("uri") or ""}
                    for a in (photo.get("authorAttributions") or [])
                    if isinstance(a, dict) and a.get("displayName")]
    return {"image": uri, "attributions": attributions}


def fetch_phone(api_key: str, place_id: str, language: str, session=None) -> str | None:
    """予約操作時に電話番号を取る（Place Details）。失敗時は None。"""
    if not api_key or not place_id:
        return None
    http = session or requests
    try:
        resp = http.get(f"{PLACES_API_BASE}/places/{place_id}", params={"languageCode": language},
                        headers={"X-Goog-Api-Key": api_key,
                                 "X-Goog-FieldMask": "nationalPhoneNumber,internationalPhoneNumber"},
                        timeout=PLACES_TIMEOUT_SEC)
    except requests.exceptions.RequestException as e:
        logger.warning(f"[ShopSearchV2] 電話番号取得失敗 ({type(e).__name__})")
        return None
    if resp.status_code != 200:
        logger.warning(f"[ShopSearchV2] 電話番号取得失敗 HTTP {resp.status_code}")
        return None
    try:
        data = resp.json() or {}
    except ValueError:
        return None
    return data.get("nationalPhoneNumber") or data.get("internationalPhoneNumber")
