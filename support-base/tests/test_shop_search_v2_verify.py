"""統合・順位づけ・Places 照合・全体の流れ・補助情報のテスト"""
import json
import logging
import os
import sys
import unittest
from datetime import date

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import requests  # noqa: E402
import shop_search_v2 as v2  # noqa: E402
from fakes import FakeGemini, FakeHttpResp, knowledge_json  # noqa: E402

API_KEY = "TEST-PLACES-KEY-DO-NOT-LOG"
TODAY = date(2026, 11, 8)


def place(pid, name, address="日本、〒150-0013 東京都渋谷区恵比寿1-1-1", status="OPERATIONAL",
          types_=("yakitori_restaurant", "restaurant", "food"), **extra):
    p = {"id": pid, "displayName": {"text": name}, "formattedAddress": address,
         "businessStatus": status, "types": list(types_), "primaryType": types_[0],
         "primaryTypeDisplayName": {"text": "焼き鳥店"},
         "googleMapsUri": f"https://maps.google.com/?cid={pid}",
         "photos": [{"name": f"places/{pid}/photos/p1",
                     "authorAttributions": [{"displayName": "撮影者", "uri": "https://maps.google.com/c/1"}]}]}
    if status is None:
        del p["businessStatus"]
    p.update(extra)
    return p


class PlacesSession:
    """textQuery ごとに返す places（または例外）を決める偽の Places API。"""

    def __init__(self, table, default=None):
        self.table, self.default, self.posts, self.gets = table, default or [], [], []
        self.get_resp = None

    def post(self, url, json=None, headers=None, timeout=None):
        self.posts.append({"url": url, "json": json, "headers": headers})
        r = self.table.get(json["textQuery"], self.default)
        if isinstance(r, Exception):
            raise r
        if isinstance(r, FakeHttpResp):
            return r
        return FakeHttpResp(200, {"places": r})

    def get(self, url, params=None, headers=None, timeout=None):
        self.gets.append({"url": url, "params": params, "headers": headers})
        return self.get_resp


def cand(name, area="恵比寿", cid="k1", source_type="knowledge", **kw):
    c = {"cand_id": cid, "name": name, "area": area, "genre": "焼き鳥", "reason": "理由", "source_type": source_type}
    c.update(kw)
    return c


class TestNameArea(unittest.TestCase):
    def test_name_matches(self):
        m = v2.name_matches
        self.assertTrue(m("鳥幸", "鳥幸"))
        self.assertTrue(m("ＴＯＲＩ　ＴＯＫＹＯ", "TORI TOKYO"))         # 全角・空白
        self.assertTrue(m("鳥貴族", "鳥貴族 渋谷店"))                     # 前方一致（支店）
        self.assertTrue(m("叙々苑", "叙々苑 六本木ヒルズ店"))
        self.assertTrue(m("焼鳥 鳥しき", "鳥しき"))                       # 包含（長さ比 0.5 以上）
        self.assertFalse(m("鳥", "鳥幸"))                                 # 1 文字
        self.assertFalse(m("鳥幸", "やきとり鳥幸本店の別館ビル店"))        # 包含だが長さ比が小さい
        self.assertFalse(m("鳥幸", "鳥しき"))
        self.assertFalse(m("", "鳥幸"))

    def test_area_matches(self):
        p = place("A", "鳥幸", address="東京都渋谷区恵比寿西1-2-3")
        self.assertTrue(v2.area_matches("恵比寿", p))
        self.assertTrue(v2.area_matches("恵比寿駅", p))
        self.assertTrue(v2.area_matches("恵比寿駅周辺", p))
        self.assertFalse(v2.area_matches("梅田", p))
        self.assertTrue(v2.area_matches("六本木", place("B", "叙々苑 六本木ヒルズ店", address="東京都港区")))
        self.assertFalse(v2.area_matches("", p))


class TestVerify(unittest.TestCase):
    def verify(self, c, places):
        s = PlacesSession({f"{c['name']} {c['area']}": places})
        return v2.verify_candidate(API_KEY, c, "ja", session=s), s

    def test_exact_match(self):
        r, s = self.verify(cand("鳥幸"), [place("A", "鳥幸")])
        self.assertTrue(r["ok"])
        self.assertEqual(r["place"]["id"], "A")
        req = s.posts[0]
        self.assertEqual(req["json"], {"textQuery": "鳥幸 恵比寿", "languageCode": "ja", "pageSize": 5})
        self.assertEqual(req["headers"]["X-Goog-FieldMask"], v2.VERIFY_FIELDS)

    def test_first_operational_is_not_taken_blindly(self):
        # 検索結果の最初が別の店でも、店名が一致しなければ採用しない
        r, _ = self.verify(cand("鳥幸"), [place("X", "鳥しき"), place("Y", "やきとん")])
        self.assertEqual(r["reason"], "no_name_match")

    def test_area_mismatch(self):
        r, _ = self.verify(cand("鳥幸"), [place("A", "鳥幸", address="大阪府大阪市北区梅田1")])
        self.assertEqual(r["reason"], "area_mismatch")

    def test_status_and_type(self):
        for status, reason in (("CLOSED_PERMANENTLY", "status_CLOSED_PERMANENTLY"),
                               ("CLOSED_TEMPORARILY", "status_CLOSED_TEMPORARILY"),
                               ("FUTURE_OPENING", "status_FUTURE_OPENING"),
                               (None, "status_missing")):
            r, _ = self.verify(cand("鳥幸"), [place("A", "鳥幸", status=status)])
            self.assertEqual(r["reason"], reason)
        r, _ = self.verify(cand("鳥幸"), [place("A", "鳥幸", types_=("hotel", "lodging"))])
        self.assertEqual(r["reason"], "not_food")
        r, _ = self.verify(cand("鳥幸"), [place("A", "鳥幸", movedPlaceId="A2")])
        self.assertEqual(r["reason"], "moved")

    def test_ambiguous_same_area_branches(self):
        r, _ = self.verify(cand("鳥貴族", area="渋谷"),
                           [place("A", "鳥貴族 渋谷店", address="東京都渋谷区道玄坂1"),
                            place("B", "鳥貴族 渋谷南口店", address="東京都渋谷区渋谷3")])
        self.assertEqual(r["reason"], "ambiguous")

    def test_exact_name_resolves_multiple(self):
        r, _ = self.verify(cand("鳥貴族 渋谷店", area="渋谷"),
                           [place("A", "鳥貴族 渋谷店", address="東京都渋谷区道玄坂1"),
                            place("B", "鳥貴族 渋谷南口店", address="東京都渋谷区渋谷3")])
        self.assertTrue(r["ok"])
        self.assertEqual(r["place"]["id"], "A")

    def test_same_name_different_area_resolved_by_area(self):
        r, _ = self.verify(cand("鳥幸"),
                           [place("O", "鳥幸", address="大阪府大阪市北区梅田1"),
                            place("E", "鳥幸", address="東京都渋谷区恵比寿1")])
        self.assertTrue(r["ok"])
        self.assertEqual(r["place"]["id"], "E")

    def test_no_results_and_http_error(self):
        r, _ = self.verify(cand("鳥幸"), [])
        self.assertEqual(r["reason"], "no_name_match")
        r, _ = self.verify(cand("鳥幸"), FakeHttpResp(403, {"error": {"status": "PERMISSION_DENIED"}}))
        self.assertEqual(r["reason"], "places_error")

    def test_all_places_errors_raise(self):
        s = PlacesSession({}, default=requests.exceptions.Timeout("https://x?key=" + API_KEY))
        with self.assertRaises(v2.ShopSearchError) as cm:
            v2.verify_candidates(API_KEY, [cand("鳥幸"), cand("鳥しき", cid="k2")], "ja", session=s)
        self.assertEqual(cm.exception.stage, "places")
        self.assertNotIn(API_KEY, str(cm.exception))

    def test_missing_key(self):
        with self.assertRaises(v2.ShopSearchError):
            v2.verify_candidates("", [cand("鳥幸")], "ja", session=PlacesSession({}))


class TestMergeRank(unittest.TestCase):
    def test_merge_dedupe_and_recent_attached(self):
        k = [cand("鳥幸", cid="k1"), cand("鳥しき", area="目黒", cid="k2")]
        r = [cand("ＴＯＲＩ幸", cid="r0", source_type="search", event_type="opened",
                  event_date="2026-05", source_url="u")]   # 別名なので重複ではない
        r2 = [cand("鳥 幸", cid="r1", source_type="search", event_type="renovated",
                   event_date="2026-06", source_url="u2")]  # 正規化で鳥幸と同じ
        merged = v2.merge_candidates(k, r + r2)
        self.assertEqual([m["cand_id"] for m in merged], ["k1", "k2", "r0"])
        self.assertEqual(merged[0]["recent"]["event_type"], "renovated")
        self.assertEqual(merged[2]["recent"]["event_type"], "opened")

    def test_no_recent_means_no_rank_call(self):
        g = FakeGemini({})
        merged = [cand("鳥幸", cid="k1"), cand("鳥しき", cid="k2")]
        self.assertEqual(v2.rank_candidates(g, "q", merged, "ja"), merged)
        self.assertEqual(g.models.calls, [])

    def test_rank_with_recent(self):
        merged = [cand("鳥幸", cid="k1"), cand("新店", cid="r1", source_type="search")]
        text = json.dumps({"ranked": [{"cand_id": "r1", "reason": "新しい理由"}, {"cand_id": "zzz", "reason": ""},
                                      {"cand_id": "k1", "reason": ""}, {"cand_id": "r1", "reason": "dup"}]},
                          ensure_ascii=False)
        g = FakeGemini({"gemini-3.8-flash": text})
        ranked = v2.rank_candidates(g, "q", merged, "ja")
        self.assertEqual([c["cand_id"] for c in ranked], ["r1", "k1"])
        self.assertEqual(ranked[0]["reason"], "新しい理由")
        self.assertEqual(ranked[1]["reason"], "理由")      # 空の理由は元の理由のまま

    def test_rank_errors(self):
        merged = [cand("新店", cid="r1", source_type="search")]
        for route in ("not json", json.dumps({"ranked": [{"cand_id": "zzz", "reason": ""}]}),
                      TimeoutError("x")):
            with self.assertRaises(v2.ShopSearchError) as cm:
                v2.rank_candidates(FakeGemini({"gemini-3.8-flash": route}), "q", merged, "ja")
            self.assertEqual(cm.exception.stage, "rank")


class TestFlow(unittest.TestCase):
    def test_full_flow(self):
        g = FakeGemini({
            "gemini-3.8-flash": [knowledge_json(("鳥幸", "恵比寿"), ("幻の店", "恵比寿"), ("鳥しき", "恵比寿")),
                                 json.dumps({"ranked": [{"cand_id": "r1", "reason": "新店"},
                                                        {"cand_id": "k1", "reason": ""},
                                                        {"cand_id": "k2", "reason": ""},
                                                        {"cand_id": "k3", "reason": ""}]}, ensure_ascii=False)],
            "gemini-2.5-flash+search": json.dumps({"updates": [
                {"name": "新店X", "area": "恵比寿", "genre": "焼き鳥", "event_type": "opened",
                 "event_date": "2026-09", "source_url": "https://news.example/x", "reason": "開店"}]},
                ensure_ascii=False),
        })
        s = PlacesSession({
            "鳥幸 恵比寿": [place("A", "鳥幸", rating=4.3, userRatingCount=200,
                                  priceRange={"startPrice": {"currencyCode": "JPY", "units": "6000"},
                                              "endPrice": {"currencyCode": "JPY", "units": "8000"}})],
            "幻の店 恵比寿": [],                                               # 架空（ハルシネーション）
            "鳥しき 恵比寿": [place("C", "鳥しき", status="CLOSED_PERMANENTLY")],  # 閉店
            "新店X 恵比寿": [place("N", "新店X")],
        })
        res = v2.search_shops("恵比寿 焼き鳥 デート", "ja", g, API_KEY, today=TODAY, session=s)
        self.assertEqual(res["status"], "verified")
        self.assertEqual([x["name"] for x in res["shops"]], ["新店X", "鳥幸"])   # 順位順・未確認は出さない
        a = res["shops"][1]
        self.assertEqual((a["rating"], a["reviewCount"], a["priceRange"]), (4.3, 200, "6,000円〜8,000円"))
        self.assertIsNone(res["shops"][0]["rating"])
        self.assertEqual(res["shops"][0]["recent"]["event_type"], "opened")
        self.assertEqual(res["shops"][0]["source_type"], "search")
        self.assertEqual(res["recent_check"]["status"], "ok")
        self.assertEqual(res["stats"]["rejected"], {"no_name_match": 1, "status_CLOSED_PERMANENTLY": 1})
        self.assertEqual(set(res["photo_refs"]), {"A", "N"})
        for k in ("a_ms", "b_ms", "rank_ms", "places_ms", "total_ms"):
            self.assertIn(k, res["timings"])

    def test_recent_failure_is_recorded_and_a_used(self):
        g = FakeGemini({"gemini-3.8-flash": knowledge_json(("鳥幸", "恵比寿")),
                        "gemini-2.5-flash+search": TimeoutError("deadline")})
        s = PlacesSession({"鳥幸 恵比寿": [place("A", "鳥幸")]})
        res = v2.search_shops("q", "ja", g, API_KEY, today=TODAY, session=s)
        self.assertEqual(res["recent_check"]["status"], "failed")
        self.assertEqual([x["name"] for x in res["shops"]], ["鳥幸"])

    def test_zero_verified_is_zero_cards(self):
        g = FakeGemini({"gemini-3.8-flash": knowledge_json(("幻の店", "恵比寿")),
                        "gemini-2.5-flash+search": json.dumps({"updates": []})})
        res = v2.search_shops("q", "ja", g, API_KEY, today=TODAY, session=PlacesSession({}))
        self.assertEqual(res["status"], "no_verified")
        self.assertEqual(res["shops"], [])

    def test_no_candidates(self):
        g = FakeGemini({"gemini-3.8-flash": json.dumps({"candidates": []}),
                        "gemini-2.5-flash+search": json.dumps({"updates": []})})
        s = PlacesSession({})
        res = v2.search_shops("q", "ja", g, API_KEY, today=TODAY, session=s)
        self.assertEqual(res["status"], "no_candidates")
        self.assertEqual(s.posts, [])

    def test_knowledge_failure_raises(self):
        g = FakeGemini({"gemini-3.8-flash": TimeoutError("x"),
                        "gemini-2.5-flash+search": json.dumps({"updates": []})})
        with self.assertRaises(v2.ShopSearchError) as cm:
            v2.search_shops("q", "ja", g, API_KEY, today=TODAY, session=PlacesSession({}))
        self.assertEqual(cm.exception.stage, "knowledge")

    def test_max_five_and_place_id_dedupe(self):
        names = [(f"店{i}", "恵比寿") for i in range(8)]
        g = FakeGemini({"gemini-3.8-flash": knowledge_json(*names)})
        table = {f"店{i} 恵比寿": [place(f"P{i}", f"店{i}")] for i in range(8)}
        table["店1 恵比寿"] = [place("P0", "店1")]     # 別候補が同じ Place ID に照合された
        res = v2.search_shops("q", "ja", g, API_KEY, today=TODAY, use_recent=False,
                              session=PlacesSession(table))
        ids = [x["place_id"] for x in res["shops"]]
        self.assertEqual(len(ids), 5)
        self.assertEqual(len(set(ids)), 5)
        self.assertEqual(res["recent_check"]["status"], "skipped")

    def test_api_key_never_logged(self):
        logs = []

        class H(logging.Handler):
            def emit(self, record):
                logs.append(record.getMessage())
        h = H()
        lg = logging.getLogger("shop_search_v2")
        lg.addHandler(h)
        lg.setLevel(logging.DEBUG)
        try:
            g = FakeGemini({"gemini-3.8-flash": knowledge_json(("鳥幸", "恵比寿")),
                            "gemini-2.5-flash+search": json.dumps({"updates": []})})
            v2.search_shops("q", "ja", g, API_KEY, today=TODAY,
                            session=PlacesSession({"鳥幸 恵比寿": [place("A", "鳥幸")]}))
            s = PlacesSession({})
            s.get_resp = FakeHttpResp(500)
            v2.fetch_photo(API_KEY, {"name": "places/A/photos/p1"}, session=s)
        finally:
            lg.removeHandler(h)
        self.assertTrue(logs)
        self.assertFalse([m for m in logs if API_KEY in m])


class TestAsyncHelpers(unittest.TestCase):
    def test_fetch_photo(self):
        s = PlacesSession({})
        s.get_resp = FakeHttpResp(200, {"photoUri": "https://lh3.googleusercontent.com/x"})
        r = v2.fetch_photo(API_KEY, {"name": "places/A/photos/p1", "authorAttributions": [
            {"displayName": "撮影者", "uri": "https://maps.google.com/c/1"}]}, session=s)
        self.assertEqual(r, {"image": "https://lh3.googleusercontent.com/x",
                             "attributions": [{"displayName": "撮影者", "uri": "https://maps.google.com/c/1"}]})
        self.assertEqual(s.gets[0]["params"], {"maxWidthPx": 800, "skipHttpRedirect": "true"})
        self.assertNotIn(API_KEY, json.dumps(s.gets[0]["params"]) + s.gets[0]["url"])
        s.get_resp = FakeHttpResp(403)
        self.assertIsNone(v2.fetch_photo(API_KEY, {"name": "n"}, session=s))

    def test_fetch_phone(self):
        s = PlacesSession({})
        s.get_resp = FakeHttpResp(200, {"nationalPhoneNumber": "03-0000-0000"})
        self.assertEqual(v2.fetch_phone(API_KEY, "A", "ja", session=s), "03-0000-0000")
        self.assertEqual(s.gets[0]["headers"]["X-Goog-FieldMask"], "nationalPhoneNumber,internationalPhoneNumber")
        s.get_resp = FakeHttpResp(404)
        self.assertIsNone(v2.fetch_phone(API_KEY, "A", "ja", session=s))

    def test_price_format(self):
        f = v2.format_price_range
        self.assertEqual(f({"startPrice": {"currencyCode": "JPY", "units": "3000"}}), "3,000円〜")
        self.assertEqual(f({"endPrice": {"currencyCode": "JPY", "units": "2000"}}), "〜2,000円")
        self.assertEqual(f({"startPrice": {"currencyCode": "USD", "units": "20"},
                            "endPrice": {"currencyCode": "USD", "units": "30"}}), "USD 20〜30")
        self.assertIsNone(f(None))


if __name__ == "__main__":
    unittest.main()
