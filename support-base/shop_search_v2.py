"""
Places-first ショップ検索（コンシェルジュ Live 用）

流れ:
  1. Places API (New) Text Search で候補を取得（店舗探索・実在確認の一次情報源）
  2. 実在・営業状態・飲食店であることを検証し、Place ID で重複を除去
  3. Gemini 3.8 Flash が「検証済み候補だけ」から最大 5 件を選び、短い紹介文を作る
  4. 店名・住所・地図 URL・評価・価格帯などの事実項目は、サーバー側で Places の値を入れる

失敗は ShopSearchError として呼び出し元に伝える。
旧方式（gemini-2.5-flash + Google 検索）や、検証していない店への切り替えは行わない。

API キー・写真 URL・会話内容はログに出さない。
"""

import json
import logging
import os
import time
import uuid

import requests
from google.genai import types

logger = logging.getLogger(__name__)

PLACES_TEXT_SEARCH_URL = "https://places.googleapis.com/v1/places:searchText"
PLACES_API_BASE = "https://places.googleapis.com/v1"

# 検索用モデル（Places の検証済み候補から選定するだけ。Google 検索は使わない）
SELECTION_MODEL = "gemini-3.8-flash"
# thinking_level は low / medium を同一条件で比較する（minimal は 3.8 Flash ではエラー）
SELECTION_THINKING_LEVEL = os.getenv("SHOP_V2_THINKING_LEVEL", "low")
# Text Search の取得項目: "atmosphere"（Enterprise + Atmosphere）/ "pro"（比較用）
FIELD_PROFILE = os.getenv("SHOP_V2_FIELD_PROFILE", "atmosphere")
# editorialSummary / reviewSummary を Gemini の入力に含めるか。
# Google Maps Platform の利用条件の確認が済むまで既定は含めない（ユーザー判断で有効化）。
ALLOW_SUMMARY_INPUT = os.getenv("SHOP_V2_ALLOW_SUMMARY_INPUT", "0") == "1"

MAX_SHOPS = 5
PLACES_PAGE_SIZE = 20
PLACES_TIMEOUT_SEC = 8
LLM_TIMEOUT_MS = 20000
PHOTO_MAX_WIDTH_PX = 800

# --- Text Search (New) の FieldMask（SKU: Pro / Enterprise / Enterprise + Atmosphere） ---
PRO_FIELDS = [
    "places.id",                       # Essentials (IDs Only)
    "places.movedPlaceId",             # Essentials (IDs Only)
    "places.displayName",
    "places.formattedAddress",
    "places.businessStatus",
    "places.location",
    "places.googleMapsUri",
    "places.primaryType",
    "places.primaryTypeDisplayName",
    "places.types",
    "places.photos",
]
ENTERPRISE_FIELDS = [
    "places.rating",
    "places.userRatingCount",
    "places.priceLevel",
    "places.priceRange",
]
ATMOSPHERE_FIELDS = [
    "places.editorialSummary",
    "places.reviewSummary",
    "places.goodForGroups",
    "places.goodForChildren",
    "places.reservable",
    "places.servesLunch",
    "places.servesDinner",
    "places.servesBeer",
    "places.servesWine",
    "places.servesCocktails",
    "places.outdoorSeating",
    "places.allowsDogs",
]
# 候補ごとに Gemini に渡す属性（Atmosphere の真偽値項目）
ATTRIBUTE_KEYS = [f.split(".", 1)[1] for f in ATMOSPHERE_FIELDS
                  if f not in ("places.editorialSummary", "places.reviewSummary")]

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

LANGUAGE_NAMES = {"ja": "日本語", "en": "English", "zh": "中文", "ko": "한국어"}

SELECTION_SCHEMA = {
    "type": "object",
    "properties": {
        "shops": {
            "type": "array",
            "maxItems": MAX_SHOPS,
            "items": {
                "type": "object",
                "properties": {
                    "place_id": {"type": "string"},
                    "area": {"type": "string"},
                    "description": {"type": "string"},
                    "highlights": {"type": "array", "items": {"type": "string"}, "maxItems": 3},
                },
                "required": ["place_id", "area", "description", "highlights"],
            },
        }
    },
    "required": ["shops"],
}

SELECTION_INSTRUCTION = """あなたはレストラン推薦の選定担当です。
ユーザーの検索条件と、Google マップで実在・営業中を確認した候補リスト（JSON）が与えられます。

【ルール】
1. 候補リストの place_id の中からだけ選ぶ。リストにない店は絶対に出さない。
2. 条件に合う店を、合う順に最大{max_shops}件選ぶ。合う店が少なければ少なくてよい。無理に{max_shops}件にしない。合う店がなければ空配列にする。
3. 判断と紹介文には、候補リストに書かれている情報だけを使う。書かれていない設備・個室・価格・雰囲気・営業時間・メニューを推測で書かない。
4. 候補に価格帯の情報がない場合、予算条件に合うと断定しない。
5. エリアの条件がある場合、住所がそのエリアにない候補は選ばない。
6. area は住所から読み取れる地域名（駅名や地名）を短く書く。
7. description は{language}で1〜2文。highlights は候補の情報に書かれている特徴だけを最大3つ、{language}で書く。
出力は指定された JSON スキーマのみ。"""


class ShopSearchError(Exception):
    """検索の失敗（stage: places / llm / validation）。未検証の店で穴埋めしないために使う。"""

    def __init__(self, stage: str, reason: str):
        super().__init__(f"{stage}: {reason}")
        self.stage = stage
        self.reason = reason


def field_mask(profile: str) -> str:
    if profile == "pro":
        fields = PRO_FIELDS
    elif profile == "atmosphere":
        fields = PRO_FIELDS + ENTERPRISE_FIELDS + ATMOSPHERE_FIELDS
    else:
        raise ValueError(f"unknown field profile: {profile}")
    return ",".join(fields)


# ------------------------------------------------------------
# 1. Places API (New) Text Search
# ------------------------------------------------------------
def places_text_search(api_key: str, text_query: str, language: str, profile: str,
                       session=None) -> list:
    """Text Search (New) を 1 回呼び、places 配列を返す。失敗は ShopSearchError。"""
    if not api_key:
        raise ShopSearchError("places", "GOOGLE_PLACES_API_KEY が未設定")
    http = session or requests
    body = {"textQuery": text_query, "languageCode": language, "pageSize": PLACES_PAGE_SIZE}
    headers = {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": api_key,
        "X-Goog-FieldMask": field_mask(profile),
    }
    try:
        resp = http.post(PLACES_TEXT_SEARCH_URL, json=body, headers=headers,
                         timeout=PLACES_TIMEOUT_SEC)
    except requests.exceptions.Timeout:
        raise ShopSearchError("places", "Text Search タイムアウト")
    except requests.exceptions.RequestException as e:
        # 例外メッセージは URL 等を含み得るので型名だけを残す
        raise ShopSearchError("places", f"Text Search 通信エラー ({type(e).__name__})")
    if resp.status_code != 200:
        status = ""
        try:
            status = resp.json().get("error", {}).get("status", "")
        except ValueError:
            pass
        raise ShopSearchError("places", f"Text Search HTTP {resp.status_code} {status}".strip())
    try:
        data = resp.json()
    except ValueError:
        raise ShopSearchError("places", "Text Search の応答が JSON ではない")
    places = data.get("places", [])
    if not isinstance(places, list):
        raise ShopSearchError("places", "Text Search の places が配列ではない")
    return places


# ------------------------------------------------------------
# 2. 実在・営業状態・飲食店の検証と重複除去
# ------------------------------------------------------------
def verify_places(places: list):
    """(verified, rejected_counts) を返す。verified は Places の place dict（順序は Places の順）。"""
    verified = []
    seen = set()
    rejected = {}

    def reject(reason):
        rejected[reason] = rejected.get(reason, 0) + 1

    for p in places:
        if not isinstance(p, dict):
            reject("malformed")
            continue
        pid = p.get("id")
        name = (p.get("displayName") or {}).get("text")
        address = p.get("formattedAddress")
        if not pid or not name or not address:
            reject("missing_core_field")
            continue
        if p.get("movedPlaceId"):
            reject("moved")
            continue
        status = p.get("businessStatus")
        if status != "OPERATIONAL":
            reject(f"status_{status or 'missing'}")
            continue
        types_ = set(p.get("types") or [])
        if p.get("primaryType"):
            types_.add(p["primaryType"])
        if not (types_ & FOOD_TYPES):
            reject("not_food")
            continue
        if pid in seen:
            reject("duplicate_place_id")
            continue
        seen.add(pid)
        verified.append(p)
    return verified, rejected


def format_price_range(price_range) -> str | None:
    """Places の priceRange（Money）を表示用文字列にする。無ければ None。"""
    if not isinstance(price_range, dict):
        return None
    start = (price_range.get("startPrice") or {})
    end = (price_range.get("endPrice") or {})
    cur = start.get("currencyCode") or end.get("currencyCode")
    s_units = start.get("units")
    e_units = end.get("units")
    if not s_units and not e_units:
        return None

    def num(units):
        try:
            return f"{int(units):,}"
        except (TypeError, ValueError):
            return None

    s = num(s_units) if s_units else None
    e = num(e_units) if e_units else None
    if cur == "JPY":
        if s and e:
            return f"{s}円〜{e}円"
        if s:
            return f"{s}円〜"
        return f"〜{e}円"
    if s and e:
        return f"{cur} {s}〜{e}"
    if s:
        return f"{cur} {s}〜"
    return f"{cur} 〜{e}"


def _summary_text(value) -> str | None:
    if not isinstance(value, dict):
        return None
    text = value.get("text")
    if isinstance(text, dict):
        text = text.get("text")
    return text if isinstance(text, str) and text.strip() else None


def candidate_for_llm(p: dict) -> dict:
    """Gemini に渡す候補（Places の値だけ。無い項目は入れない＝不明）。"""
    c = {
        "place_id": p["id"],
        "name": p["displayName"]["text"],
        "address": p["formattedAddress"],
        "type": (p.get("primaryTypeDisplayName") or {}).get("text") or p.get("primaryType") or "",
    }
    if p.get("rating") is not None:
        c["rating"] = p["rating"]
    if p.get("userRatingCount") is not None:
        c["rating_count"] = p["userRatingCount"]
    pr = format_price_range(p.get("priceRange"))
    if pr:
        c["price_range"] = pr
    if p.get("priceLevel"):
        c["price_level"] = p["priceLevel"]
    attrs = {k: p[k] for k in ATTRIBUTE_KEYS if isinstance(p.get(k), bool)}
    if attrs:
        c["attributes"] = attrs
    if ALLOW_SUMMARY_INPUT:
        es = _summary_text(p.get("editorialSummary"))
        if es:
            c["editorial_summary"] = es
        rs = _summary_text(p.get("reviewSummary"))
        if rs:
            c["review_summary"] = rs
    return c


# ------------------------------------------------------------
# 3. Gemini 3.8 Flash による選定
# ------------------------------------------------------------
def select_with_llm(gemini_client, user_request: str, candidates: list, language: str,
                    thinking_level: str = None) -> list:
    """検証済み候補から選定させ、[{place_id, area, description, highlights}] を返す。"""
    lang_name = LANGUAGE_NAMES.get(language, LANGUAGE_NAMES["ja"])
    instruction = SELECTION_INSTRUCTION.format(max_shops=MAX_SHOPS, language=lang_name)
    contents = (
        f"検索条件: {user_request}\n\n"
        f"候補リスト:\n{json.dumps(candidates, ensure_ascii=False)}"
    )
    config = types.GenerateContentConfig(
        system_instruction=instruction,
        response_mime_type="application/json",
        response_json_schema=SELECTION_SCHEMA,
        thinking_config=types.ThinkingConfig(thinking_level=thinking_level or SELECTION_THINKING_LEVEL),
        http_options=types.HttpOptions(timeout=LLM_TIMEOUT_MS),
    )
    try:
        response = gemini_client.models.generate_content(
            model=SELECTION_MODEL, contents=contents, config=config
        )
    except Exception as e:
        raise ShopSearchError("llm", f"{SELECTION_MODEL} 呼び出し失敗 ({type(e).__name__}: {str(e)[:120]})")
    text = getattr(response, "text", None)
    if not text:
        raise ShopSearchError("llm", "応答が空")
    try:
        data = json.loads(text)
    except ValueError:
        raise ShopSearchError("llm", "応答が JSON ではない")
    shops = data.get("shops") if isinstance(data, dict) else None
    if not isinstance(shops, list):
        raise ShopSearchError("llm", "応答に shops 配列がない")
    return shops


def validate_selection(selection: list, verified_by_id: dict):
    """(accepted, rejected_ids) を返す。候補外・重複・型不正は採用しない。最大 MAX_SHOPS 件。"""
    accepted = []
    rejected = []
    seen = set()
    for item in selection:
        if not isinstance(item, dict):
            rejected.append("<malformed>")
            continue
        pid = item.get("place_id")
        if pid not in verified_by_id:
            rejected.append(str(pid))
            continue
        if pid in seen:
            rejected.append(str(pid))
            continue
        desc = item.get("description")
        if not isinstance(desc, str) or not desc.strip():
            rejected.append(str(pid))
            continue
        hl = item.get("highlights")
        highlights = [h.strip() for h in hl if isinstance(h, str) and h.strip()][:3] if isinstance(hl, list) else []
        area = item.get("area") if isinstance(item.get("area"), str) else ""
        seen.add(pid)
        accepted.append({"place_id": pid, "area": area.strip(),
                         "description": desc.strip(), "highlights": highlights})
        if len(accepted) >= MAX_SHOPS:
            break
    return accepted, rejected


# ------------------------------------------------------------
# 4. 確定スナップショット（ShopCardList の ShopData 互換）
# ------------------------------------------------------------
def build_shop(p: dict, sel: dict) -> dict:
    """事実項目は Places の値、紹介文は選定結果。取得できない項目は None。"""
    return {
        "place_id": p["id"],
        "name": p["displayName"]["text"],
        "area": sel["area"],
        "category": (p.get("primaryTypeDisplayName") or {}).get("text") or "",
        "description": sel["description"],
        "highlights": sel["highlights"],
        "location": p["formattedAddress"],
        "maps_url": p.get("googleMapsUri"),
        "rating": p.get("rating"),
        "reviewCount": p.get("userRatingCount"),
        "priceRange": format_price_range(p.get("priceRange")),
        "reservable": p.get("reservable") if isinstance(p.get("reservable"), bool) else None,
        "image": None,
        "tips": None,
        "verification": {"provider": "google_places_new", "business_status": p.get("businessStatus")},
    }


def search_shops(user_request: str, language: str, gemini_client, places_api_key: str,
                 profile: str = None, thinking_level: str = None, session=None) -> dict:
    """
    Places-first 検索。戻り値:
      {search_id, status: "verified" | "no_verified_candidates" | "no_match",
       shops: [...], photo_refs: {place_id: photo dict}, timings: {...}, stats: {...}}
    失敗（API 障害・不正応答）は ShopSearchError を送出する。
    """
    profile = profile or FIELD_PROFILE
    search_id = str(uuid.uuid4())
    t0 = time.monotonic()

    places = places_text_search(places_api_key, user_request, language, profile, session=session)
    t_places = time.monotonic()
    verified, rejected = verify_places(places)

    timings = {"places_ms": round((t_places - t0) * 1000)}
    stats = {"profile": profile, "candidates": len(places), "verified": len(verified),
             "rejected": rejected, "llm_rejected_ids": 0}

    if not verified:
        timings["total_ms"] = round((time.monotonic() - t0) * 1000)
        logger.info(f"[ShopSearchV2] search_id={search_id} 検証済み候補 0 件 "
                    f"candidates={len(places)} rejected={rejected} timings={timings}")
        return {"search_id": search_id, "status": "no_verified_candidates", "shops": [],
                "photo_refs": {}, "timings": timings, "stats": stats}

    verified_by_id = {p["id"]: p for p in verified}
    candidates = [candidate_for_llm(p) for p in verified]
    selection = select_with_llm(gemini_client, user_request, candidates, language,
                                thinking_level=thinking_level)
    t_llm = time.monotonic()
    accepted, llm_rejected = validate_selection(selection, verified_by_id)
    stats["llm_rejected_ids"] = len(llm_rejected)
    stats["selected"] = len(accepted)

    shops = [build_shop(verified_by_id[s["place_id"]], s) for s in accepted]
    photo_refs = {}
    for s in shops:
        photos = verified_by_id[s["place_id"]].get("photos") or []
        if photos and isinstance(photos[0], dict) and photos[0].get("name"):
            photo_refs[s["place_id"]] = photos[0]

    timings["llm_ms"] = round((t_llm - t_places) * 1000)
    timings["total_ms"] = round((time.monotonic() - t0) * 1000)
    status = "verified" if shops else "no_match"
    logger.info(f"[ShopSearchV2] search_id={search_id} status={status} profile={profile} "
                f"thinking={thinking_level or SELECTION_THINKING_LEVEL} candidates={len(places)} "
                f"verified={len(verified)} selected={len(shops)} llm_rejected={len(llm_rejected)} "
                f"rejected={rejected} timings={timings}")
    return {"search_id": search_id, "status": status, "shops": shops,
            "photo_refs": photo_refs, "timings": timings, "stats": stats}


# ------------------------------------------------------------
# 5. 非同期で取る補助情報（写真・電話番号）
# ------------------------------------------------------------
def fetch_photo(api_key: str, photo: dict, session=None) -> dict | None:
    """
    写真の photoUri を取得する（skipHttpRedirect=true）。
    戻り値: {image, attributions:[{displayName, uri}]}。失敗時は None（写真は任意項目）。
    photoUri をブラウザに渡す。API キーはヘッダーで送り、URL・ログに含めない。
    """
    name = photo.get("name") if isinstance(photo, dict) else None
    if not api_key or not name:
        return None
    http = session or requests
    try:
        resp = http.get(
            f"{PLACES_API_BASE}/{name}/media",
            params={"maxWidthPx": PHOTO_MAX_WIDTH_PX, "skipHttpRedirect": "true"},
            headers={"X-Goog-Api-Key": api_key},
            timeout=PLACES_TIMEOUT_SEC,
        )
    except requests.exceptions.RequestException as e:
        logger.warning(f"[ShopSearchV2] 写真取得失敗 ({type(e).__name__})")
        return None
    if resp.status_code != 200:
        logger.warning(f"[ShopSearchV2] 写真取得失敗 HTTP {resp.status_code}")
        return None
    try:
        uri = resp.json().get("photoUri")
    except ValueError:
        return None
    if not uri:
        return None
    attributions = []
    for a in photo.get("authorAttributions") or []:
        if isinstance(a, dict) and a.get("displayName"):
            attributions.append({"displayName": a["displayName"], "uri": a.get("uri") or ""})
    return {"image": uri, "attributions": attributions}


def fetch_phone(api_key: str, place_id: str, language: str, session=None) -> str | None:
    """予約操作時に電話番号を取得する（Place Details: nationalPhoneNumber）。失敗時は None。"""
    if not api_key or not place_id:
        return None
    http = session or requests
    try:
        resp = http.get(
            f"{PLACES_API_BASE}/places/{place_id}",
            params={"languageCode": language},
            headers={"X-Goog-Api-Key": api_key,
                     "X-Goog-FieldMask": "nationalPhoneNumber,internationalPhoneNumber"},
            timeout=PLACES_TIMEOUT_SEC,
        )
    except requests.exceptions.RequestException as e:
        logger.warning(f"[ShopSearchV2] 電話番号取得失敗 ({type(e).__name__})")
        return None
    if resp.status_code != 200:
        logger.warning(f"[ShopSearchV2] 電話番号取得失敗 HTTP {resp.status_code}")
        return None
    try:
        data = resp.json()
    except ValueError:
        return None
    return data.get("nationalPhoneNumber") or data.get("internationalPhoneNumber")
