"""
shop_search_v2 の決定的テスト（外部 API は呼ばない）

実行: cd support-base && python -m unittest discover -s tests -v
"""
import json
import logging
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import requests  # noqa: E402
import shop_search_v2 as v2  # noqa: E402

API_KEY = "TEST-PLACES-KEY-DO-NOT-LOG"


def place(pid, name, status="OPERATIONAL", types_=("yakitori_restaurant", "restaurant", "food"),
          address="日本、〒150-0013 東京都渋谷区恵比寿1-1-1", **extra):
    p = {
        "id": pid,
        "displayName": {"text": name, "languageCode": "ja"},
        "formattedAddress": address,
        "businessStatus": status,
        "types": list(types_),
        "primaryType": types_[0] if types_ else None,
        "primaryTypeDisplayName": {"text": "焼き鳥店", "languageCode": "ja"},
        "googleMapsUri": f"https://maps.google.com/?cid={pid}",
        "photos": [{"name": f"places/{pid}/photos/p1", "authorAttributions": [
            {"displayName": "撮影者A", "uri": "https://maps.google.com/contrib/1", "photoUri": "x"}]}],
    }
    if status is None:
        del p["businessStatus"]
    p.update(extra)
    return p


class FakeResp:
    def __init__(self, status=200, data=None, raw=None):
        self.status_code = status
        self._data = data
        self._raw = raw

    def json(self):
        if self._raw is not None:
            return json.loads(self._raw)
        return self._data


class FakeSession:
    def __init__(self, post_resp=None, post_exc=None, get_resp=None):
        self.post_resp, self.post_exc, self.get_resp = post_resp, post_exc, get_resp
        self.posts, self.gets = [], []

    def post(self, url, json=None, headers=None, timeout=None):
        self.posts.append({"url": url, "json": json, "headers": headers, "timeout": timeout})
        if self.post_exc:
            raise self.post_exc
        return self.post_resp

    def get(self, url, params=None, headers=None, timeout=None):
        self.gets.append({"url": url, "params": params, "headers": headers})
        return self.get_resp


class FakeModels:
    def __init__(self, text=None, exc=None):
        self.text, self.exc, self.calls = text, exc, []

    def generate_content(self, model=None, contents=None, config=None):
        self.calls.append({"model": model, "contents": contents, "config": config})
        if self.exc:
            raise self.exc

        class R:
            pass
        r = R()
        r.text = self.text
        return r


class FakeGemini:
    def __init__(self, text=None, exc=None):
        self.models = FakeModels(text, exc)


def sel(*items):
    return json.dumps({"shops": [
        {"place_id": i, "area": "恵比寿", "description": f"{i} の紹介", "highlights": ["h1"]}
        for i in items]}, ensure_ascii=False)


class LogCapture(logging.Handler):
    def __init__(self):
        super().__init__()
        self.messages = []

    def emit(self, record):
        self.messages.append(record.getMessage())


class TestVerify(unittest.TestCase):
    def test_status_and_type_filters(self):
        places = [
            place("A", "店A"),
            place("B", "店B", status="CLOSED_PERMANENTLY"),
            place("C", "店C", status="CLOSED_TEMPORARILY"),
            place("D", "店D", status=None),
            place("E", "店E", status="BUSINESS_STATUS_UNSPECIFIED"),
            place("F", "店F", status="FUTURE_OPENING"),
            place("G", "ホテルG", types_=("hotel", "lodging")),
            place("H", "店H", movedPlaceId="H2"),
            place("A", "店A"),  # Place ID 重複
            {"id": "I", "displayName": {"text": "住所なし"}},
            "not-a-dict",
        ]
        verified, rejected = v2.verify_places(places)
        self.assertEqual([p["id"] for p in verified], ["A"])
        self.assertEqual(rejected["status_CLOSED_PERMANENTLY"], 1)
        self.assertEqual(rejected["status_CLOSED_TEMPORARILY"], 1)
        self.assertEqual(rejected["status_missing"], 1)
        self.assertEqual(rejected["status_BUSINESS_STATUS_UNSPECIFIED"], 1)
        self.assertEqual(rejected["status_FUTURE_OPENING"], 1)
        self.assertEqual(rejected["not_food"], 1)
        self.assertEqual(rejected["moved"], 1)
        self.assertEqual(rejected["duplicate_place_id"], 1)
        self.assertEqual(rejected["missing_core_field"], 1)
        self.assertEqual(rejected["malformed"], 1)

    def test_same_name_different_place_kept_with_address(self):
        places = [place("A1", "鳥幸", address="東京都渋谷区恵比寿1"),
                  place("A2", "鳥幸", address="大阪府大阪市北区梅田1")]
        verified, _ = v2.verify_places(places)
        self.assertEqual([p["id"] for p in verified], ["A1", "A2"])
        cands = [v2.candidate_for_llm(p) for p in verified]
        self.assertEqual({c["address"] for c in cands},
                         {"東京都渋谷区恵比寿1", "大阪府大阪市北区梅田1"})


class TestPlacesRequest(unittest.TestCase):
    def test_request_shape(self):
        s = FakeSession(post_resp=FakeResp(data={"places": []}))
        v2.places_text_search(API_KEY, "恵比寿 焼き鳥", "ja", "atmosphere", session=s)
        req = s.posts[0]
        self.assertEqual(req["url"], v2.PLACES_TEXT_SEARCH_URL)
        self.assertEqual(req["json"], {"textQuery": "恵比寿 焼き鳥", "languageCode": "ja", "pageSize": 20})
        mask = req["headers"]["X-Goog-FieldMask"].split(",")
        for f in ("places.id", "places.businessStatus", "places.googleMapsUri",
                  "places.rating", "places.priceRange", "places.reservable"):
            self.assertIn(f, mask)
        self.assertEqual(req["headers"]["X-Goog-Api-Key"], API_KEY)
        self.assertEqual(req["timeout"], v2.PLACES_TIMEOUT_SEC)

    def test_pro_profile_has_no_enterprise_fields(self):
        mask = v2.field_mask("pro").split(",")
        self.assertNotIn("places.rating", mask)
        self.assertNotIn("places.reservable", mask)

    def test_timeout_and_http_errors(self):
        s = FakeSession(post_exc=requests.exceptions.Timeout("https://x?key=" + API_KEY))
        with self.assertRaises(v2.ShopSearchError) as cm:
            v2.places_text_search(API_KEY, "q", "ja", "pro", session=s)
        self.assertEqual(cm.exception.stage, "places")
        self.assertNotIn(API_KEY, str(cm.exception))

        s = FakeSession(post_exc=requests.exceptions.ConnectionError("conn ?key=" + API_KEY))
        with self.assertRaises(v2.ShopSearchError) as cm:
            v2.places_text_search(API_KEY, "q", "ja", "pro", session=s)
        self.assertNotIn(API_KEY, str(cm.exception))

        s = FakeSession(post_resp=FakeResp(403, {"error": {"status": "PERMISSION_DENIED"}}))
        with self.assertRaises(v2.ShopSearchError) as cm:
            v2.places_text_search(API_KEY, "q", "ja", "pro", session=s)
        self.assertIn("403", cm.exception.reason)

        s = FakeSession(post_resp=FakeResp(200, raw="not json"))
        with self.assertRaises(v2.ShopSearchError):
            v2.places_text_search(API_KEY, "q", "ja", "pro", session=s)

    def test_missing_key(self):
        with self.assertRaises(v2.ShopSearchError):
            v2.places_text_search("", "q", "ja", "pro", session=FakeSession())


class TestSearchFlow(unittest.TestCase):
    def run_search(self, places, llm_text=None, llm_exc=None):
        s = FakeSession(post_resp=FakeResp(data={"places": places}))
        g = FakeGemini(text=llm_text, exc=llm_exc)
        return v2.search_shops("恵比寿 焼き鳥 デート", "ja", g, API_KEY,
                               profile="atmosphere", session=s), g

    def test_normal_order_and_facts_from_places(self):
        places = [place("A", "店A", rating=4.2, userRatingCount=120,
                        priceRange={"startPrice": {"currencyCode": "JPY", "units": "6000"},
                                    "endPrice": {"currencyCode": "JPY", "units": "8000"}},
                        reservable=True),
                  place("B", "店B"), place("C", "店C")]
        res, g = self.run_search(places, sel("C", "A"))
        self.assertEqual(res["status"], "verified")
        self.assertEqual([s["place_id"] for s in res["shops"]], ["C", "A"])
        a = res["shops"][1]
        self.assertEqual(a["name"], "店A")
        self.assertEqual(a["rating"], 4.2)
        self.assertEqual(a["reviewCount"], 120)
        self.assertEqual(a["priceRange"], "6,000円〜8,000円")
        self.assertEqual(a["maps_url"], "https://maps.google.com/?cid=A")
        self.assertIs(a["reservable"], True)
        self.assertIsNone(res["shops"][0]["rating"])        # 無い項目は None（捏造しない）
        self.assertIsNone(res["shops"][0]["priceRange"])
        self.assertIn("A", res["photo_refs"])
        self.assertTrue(res["search_id"])
        self.assertEqual(g.models.calls[0]["model"], "gemini-3.8-flash")
        cfg = g.models.calls[0]["config"]
        self.assertEqual(cfg.response_mime_type, "application/json")
        self.assertEqual(cfg.thinking_config.thinking_level.value, "LOW")

    def test_zero_verified_means_zero_cards_and_no_llm_call(self):
        res, g = self.run_search([place("B", "店B", status="CLOSED_PERMANENTLY")], sel("B"))
        self.assertEqual(res["status"], "no_verified_candidates")
        self.assertEqual(res["shops"], [])
        self.assertEqual(g.models.calls, [])

    def test_zero_places(self):
        res, g = self.run_search([], sel())
        self.assertEqual(res["shops"], [])
        self.assertEqual(g.models.calls, [])

    def test_llm_out_of_candidate_and_duplicates_dropped(self):
        res, _ = self.run_search([place("A", "店A"), place("B", "店B")],
                                 sel("X", "A", "A", "B", "CLOSED"))
        self.assertEqual([s["place_id"] for s in res["shops"]], ["A", "B"])
        self.assertEqual(res["stats"]["llm_rejected_ids"], 3)

    def test_llm_more_than_five_truncated(self):
        places = [place(f"P{i}", f"店{i}") for i in range(8)]
        res, _ = self.run_search(places, sel(*[f"P{i}" for i in range(8)]))
        self.assertEqual(len(res["shops"]), 5)

    def test_llm_selects_nothing(self):
        res, _ = self.run_search([place("A", "店A")], sel())
        self.assertEqual(res["status"], "no_match")
        self.assertEqual(res["shops"], [])

    def test_llm_invalid_json_and_exception_are_errors(self):
        with self.assertRaises(v2.ShopSearchError) as cm:
            self.run_search([place("A", "店A")], "not json")
        self.assertEqual(cm.exception.stage, "llm")
        with self.assertRaises(v2.ShopSearchError) as cm:
            self.run_search([place("A", "店A")], llm_exc=TimeoutError("deadline"))
        self.assertEqual(cm.exception.stage, "llm")
        with self.assertRaises(v2.ShopSearchError):
            self.run_search([place("A", "店A")], json.dumps({"other": 1}))

    def test_llm_cannot_override_facts(self):
        text = json.dumps({"shops": [{"place_id": "A", "area": "恵比寿", "description": "d",
                                      "highlights": [], "name": "偽名", "rating": 5.0}]})
        res, _ = self.run_search([place("A", "店A")], text)
        self.assertEqual(res["shops"][0]["name"], "店A")
        self.assertIsNone(res["shops"][0]["rating"])

    def test_summary_not_sent_to_llm_by_default(self):
        p = place("A", "店A", editorialSummary={"text": "要約"},
                  reviewSummary={"text": {"text": "口コミ要約"}}, goodForGroups=True)
        c = v2.candidate_for_llm(p)
        self.assertNotIn("editorial_summary", c)
        self.assertNotIn("review_summary", c)
        self.assertEqual(c["attributes"], {"goodForGroups": True})

    def test_api_key_never_logged(self):
        cap = LogCapture()
        logging.getLogger("shop_search_v2").addHandler(cap)
        logging.getLogger("shop_search_v2").setLevel(logging.DEBUG)
        try:
            self.run_search([place("A", "店A")], sel("A"))
            v2.fetch_photo(API_KEY, {"name": "places/A/photos/p1"},
                           session=FakeSession(get_resp=FakeResp(500)))
        finally:
            logging.getLogger("shop_search_v2").removeHandler(cap)
        self.assertTrue(cap.messages)
        for m in cap.messages:
            self.assertNotIn(API_KEY, m)


class TestPriceFormat(unittest.TestCase):
    def test_formats(self):
        f = v2.format_price_range
        self.assertEqual(f({"startPrice": {"currencyCode": "JPY", "units": "3000"}}), "3,000円〜")
        self.assertEqual(f({"endPrice": {"currencyCode": "JPY", "units": "2000"}}), "〜2,000円")
        self.assertEqual(f({"startPrice": {"currencyCode": "USD", "units": "20"},
                            "endPrice": {"currencyCode": "USD", "units": "30"}}), "USD 20〜30")
        self.assertIsNone(f(None))
        self.assertIsNone(f({}))


class TestAsyncHelpers(unittest.TestCase):
    def test_fetch_photo(self):
        s = FakeSession(get_resp=FakeResp(data={"photoUri": "https://lh3.googleusercontent.com/x"}))
        r = v2.fetch_photo(API_KEY, {"name": "places/A/photos/p1", "authorAttributions": [
            {"displayName": "撮影者A", "uri": "https://maps.google.com/contrib/1"}]}, session=s)
        self.assertEqual(r["image"], "https://lh3.googleusercontent.com/x")
        self.assertEqual(r["attributions"], [{"displayName": "撮影者A",
                                              "uri": "https://maps.google.com/contrib/1"}])
        g = s.gets[0]
        self.assertEqual(g["url"], "https://places.googleapis.com/v1/places/A/photos/p1/media")
        self.assertEqual(g["params"], {"maxWidthPx": 800, "skipHttpRedirect": "true"})
        self.assertNotIn(API_KEY, json.dumps(g["params"]))     # キーは URL に入れない
        self.assertNotIn(API_KEY, r["image"])

    def test_fetch_photo_failure_is_none(self):
        self.assertIsNone(v2.fetch_photo(API_KEY, {"name": "n"}, session=FakeSession(get_resp=FakeResp(403))))
        self.assertIsNone(v2.fetch_photo(API_KEY, {}, session=FakeSession()))

    def test_fetch_phone(self):
        s = FakeSession(get_resp=FakeResp(data={"nationalPhoneNumber": "03-0000-0000"}))
        self.assertEqual(v2.fetch_phone(API_KEY, "A", "ja", session=s), "03-0000-0000")
        self.assertEqual(s.gets[0]["headers"]["X-Goog-FieldMask"],
                         "nationalPhoneNumber,internationalPhoneNumber")
        self.assertIsNone(v2.fetch_phone(API_KEY, "A", "ja", session=FakeSession(get_resp=FakeResp(404))))


if __name__ == "__main__":
    unittest.main()
