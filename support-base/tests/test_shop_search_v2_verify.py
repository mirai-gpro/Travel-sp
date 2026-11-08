"""統合・順位づけ・Places 照合（今までのロジック）・全体の流れ・補助情報のテスト"""
import json
import logging
import os
import sys
import unittest
from datetime import date

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from unittest.mock import patch  # noqa: E402
import shop_search_v2 as v2  # noqa: E402
from fakes import FakeGemini, FakeHttpResp, knowledge_json  # noqa: E402

API_KEY = "TEST-PLACES-KEY-DO-NOT-LOG"
TODAY = date(2026, 11, 8)


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


def legacy_place(pid, name, **extra):
    """api_integrations.search_place の戻り値の形"""
    p = {"place_id": pid, "name": name, "rating": None, "user_ratings_total": None,
         "formatted_address": "東京都渋谷区恵比寿1-1-1", "country_code": "JP", "lat": 35.6, "lng": 139.7,
         "photo_url": f"https://maps.googleapis.com/maps/api/place/photo?photo_reference=x&key={API_KEY}",
         "maps_url": f"https://www.google.com/maps/place/?q=place_id:{pid}", "phone": None}
    p.update(extra)
    return p


def cand(name, area="恵比寿", cid="k1", source_type="knowledge", **kw):
    c = {"cand_id": cid, "name": name, "area": area, "genre": "焼き鳥", "reason": "理由", "source_type": source_type}
    c.update(kw)
    return c


class TestLegacyVerify(unittest.TestCase):
    """照合は今までの api_integrations.search_place をそのまま使う"""

    def test_found_and_not_found(self):
        calls = []

        def fake_search_place(name, area, geo_info, language):
            calls.append((name, area, geo_info, language))
            return legacy_place("A", "鳥幸 恵比寿店") if name == "鳥幸" else None
        with patch.object(v2.legacy, "search_place", fake_search_place):
            results, rejected = v2.verify_candidates(
                [cand("鳥幸"), cand("幻の店", cid="k2"), cand("鳥しき", area="", cid="k3")],
                "恵比寿", {"country_code": "JP"}, "ja")
        self.assertEqual([r["ok"] for r in results], [True, False, False])
        self.assertEqual(rejected, {"not_found": 2})
        self.assertIn(("鳥幸", "恵比寿", {"country_code": "JP"}, "ja"), calls)
        self.assertIn(("鳥しき", "恵比寿", {"country_code": "JP"}, "ja"), calls)   # 候補のエリアが空なら検索条件のエリア

    def test_exception_is_rejected_not_raised(self):
        def boom(*a):
            raise RuntimeError("x")
        with patch.object(v2.legacy, "search_place", boom):
            results, rejected = v2.verify_candidates([cand("鳥幸")], "", None, "ja")
        self.assertFalse(results[0]["ok"])
        self.assertEqual(rejected, {"error_RuntimeError": 1})

    def test_area_context_uses_legacy(self):
        with patch.object(v2.legacy, "extract_area_from_text", lambda t, l: "恵比寿"), \
             patch.object(v2.legacy, "get_region_from_area", lambda a, l: {"country_code": "JP", "region": "東京都"}):
            self.assertEqual(v2.area_context("恵比寿の焼き鳥", "ja"), ("恵比寿", {"country_code": "JP", "region": "東京都"}))
        with patch.object(v2.legacy, "extract_area_from_text", lambda t, l: ""), \
             patch.object(v2.legacy, "get_region_from_area", lambda a, l: self.fail("呼ばない")):
            self.assertEqual(v2.area_context("q", "ja"), ("", None))


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


class TestGates(unittest.TestCase):
    """採否判定（①ジャンル ②すり替わり）。診断で実際に出た例を使う"""

    def test_name_overlaps(self):
        ok = [("喜鈴 恵比寿", "喜鈴(キリン)", "恵比寿"), ("恵比寿 鳥幸", "えびす坂 鳥幸", "恵比寿"),
              ("中目黒いぐち 恵比寿店", "中目黒 いぐち 恵比寿店", "恵比寿"),
              ("鳥貴族 渋谷道玄坂店", "鳥貴族 渋谷道玄坂店", "渋谷"),
              ("銀座 久兵衛 本店", "銀座久兵衛 銀座 本店", "銀座"),                       # 10 クエリ計測で出た例
              ("大阪焼肉・ホルモン ふたご 梅田店", "大阪焼肉・ホルモン ふたご 北新地店", "梅田")]
        ng = [("地鶏やおまへん 恵比寿店", "食鶏 しまや 恵比寿", "恵比寿"),
              ("鳥貴族 渋谷明治通り店", "鳥貴族 原宿明治通り店", "渋谷"),
              ("恵比寿 串亭", "酒場くし亭 恵比寿本店", "恵比寿"), ("恵比寿", "恵比寿 何か", "恵比寿"),
              ("焼鳥 市松", "中目黒 いぐち 恵比寿店", "恵比寿"), ("Kenchin", "Keninji Gion Maruyama", "Gion"),
              ("鮨 銀座おのでら 登り龍", "鮨 銀座おのでら 登龍門", "銀座")]
        for c, p_, a in ok:
            self.assertTrue(v2.name_overlaps(c, p_, (a,)), (c, p_))
        for c, p_, a in ng:
            self.assertFalse(v2.name_overlaps(c, p_, (a,)), (c, p_))

    def run_gate(self, cand_name, place_name, types, genre_types):
        ctx = {"mode": "observe", "genre_types": genre_types, "places_api_key": API_KEY}
        with patch.object(v2, "fetch_place_types", lambda *a: types):
            return v2.evaluate_gates(cand(cand_name), legacy_place("P", place_name), "恵比寿", None, "ja", ctx)

    def test_cases_from_poc(self):
        yaki = ["yakitori_restaurant", "chicken_restaurant"]
        g = self.run_gate("恵比寿 串亭", "酒場くし亭 恵比寿本店", ["japanese_izakaya_restaurant", "restaurant"], yaki)
        self.assertEqual((g["identity"], g["genre"], g["verdict"]), ("mismatch", "ng", "reject_genre"))
        g = self.run_gate("焼鳥 市松", "中目黒 いぐち 恵比寿店", ["yakitori_restaurant"], yaki)   # 結果 1 件でも別店
        self.assertEqual((g["identity"], g["verdict"]), ("mismatch", "reject_substituted"))
        g = self.run_gate("地鶏やおまへん 恵比寿店", "食鶏 しまや 恵比寿", ["yakitori_restaurant"], yaki)
        self.assertEqual(g["verdict"], "reject_substituted")
        g = self.run_gate("魚まみれ眞吉 恵比寿店", "魚まみれ眞吉 恵比寿店", ["japanese_izakaya_restaurant", "food"], yaki)
        self.assertEqual((g["identity"], g["genre"], g["verdict"]), ("name_match", "ng", "reject_genre"))
        g = self.run_gate("喜鈴 恵比寿", "喜鈴(キリン)", ["restaurant", "food"], yaki)
        self.assertEqual((g["genre"], g["verdict"]), ("unknown", "adopt"))               # 細かいタイプが無い店は外さない
        g = self.run_gate("喜鈴 恵比寿", "喜鈴(キリン)", None, [])                       # タイプを取れない時も外さない
        self.assertEqual((g["genre"], g["verdict"]), ("unknown", "adopt"))

    def test_fetch_place_types_header_and_failure(self):
        s = PlacesSession({})
        s.get_resp = FakeHttpResp(200, {"types": ["yakitori_restaurant", "restaurant"]})
        self.assertEqual(v2.fetch_place_types(API_KEY, "PID", session=s), ["yakitori_restaurant", "restaurant"])
        self.assertEqual(s.gets[0]["headers"]["X-Goog-FieldMask"], "types")
        self.assertNotIn(API_KEY, s.gets[0]["url"])
        s.get_resp = FakeHttpResp(403)
        self.assertIsNone(v2.fetch_place_types(API_KEY, "PID", session=s))


class TestFlow(unittest.TestCase):
    def setUp(self):
        self.patches = [patch.object(v2.legacy, "extract_area_from_text", lambda t, l: ""),
                        patch.object(v2.legacy, "get_region_from_area", lambda a, l: None)]
        for p_ in self.patches:
            p_.start()

    def tearDown(self):
        for p_ in self.patches:
            p_.stop()

    def with_places(self, table):
        return patch.object(v2.legacy, "search_place", lambda name, area, g, l: table.get(name))

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
        table = {"鳥幸": legacy_place("A", "鳥幸 恵比寿店", rating=4.3, user_ratings_total=200, phone="03-1"),
                 "新店X": legacy_place("N", "新店X")}
        with self.with_places(table):
            res = v2.search_shops("恵比寿 焼き鳥 デート", "ja", g, today=TODAY)
        self.assertEqual(res["status"], "verified")
        self.assertEqual([x["name"] for x in res["shops"]], ["新店X", "鳥幸 恵比寿店"])   # 順位順・名前は Places
        a = res["shops"][1]
        self.assertEqual((a["rating"], a["reviewCount"], a["phone"]), (4.3, 200, "03-1"))
        self.assertIsNone(a["image"])                       # キー入り写真 URL は渡さない
        self.assertEqual(res["shops"][0]["recent"]["event_type"], "opened")
        self.assertEqual(res["stats"]["rejected"], {"not_found": 2})
        self.assertEqual({d["name"] for d in res["rejected_detail"]}, {"幻の店", "鳥しき"})
        self.assertEqual([(m["cand"], m["place"]) for m in res["matched"]], [("新店X", "新店X"), ("鳥幸", "鳥幸 恵比寿店")])
        for k in ("a_ms", "b_ms", "area_ms", "rank_ms", "places_ms", "total_ms"):
            self.assertIn(k, res["timings"])

    def test_gates_observe_and_enforce(self):
        def gem():
            return FakeGemini({"gemini-3.8-flash": json.dumps({"genre_types": ["yakitori_restaurant"], "candidates": [
                {"name": n, "area": "恵比寿", "genre": "焼き鳥", "reason": ""} for n in ("鳥幸", "地鶏やおまへん")]},
                ensure_ascii=False)})
        table = {"鳥幸": legacy_place("A", "鳥幸"), "地鶏やおまへん": legacy_place("B", "食鶏 しまや")}
        with self.with_places(table), \
             patch.object(v2, "fetch_place_types", lambda *a: ["yakitori_restaurant"]):
            obs = v2.search_shops("q", "ja", gem(), API_KEY, today=TODAY, use_recent=False, gates="observe")
            enf = v2.search_shops("q", "ja", gem(), API_KEY, today=TODAY, use_recent=False, gates="enforce")
        self.assertEqual([x["name"] for x in obs["shops"]], ["鳥幸", "食鶏 しまや"])     # observe は外さない
        self.assertEqual(obs["stats"]["would_reject"], {"reject_substituted": 1})
        self.assertEqual(obs["stats"]["genre_types"], ["yakitori_restaurant"])
        self.assertEqual([x["name"] for x in enf["shops"]], ["鳥幸"])
        self.assertEqual(enf["stats"]["rejected"], {"reject_substituted": 1})
        self.assertEqual(enf["rejected_detail"][0]["place"], "食鶏 しまや")
        with self.assertRaises(ValueError):
            v2.search_shops("q", "ja", gem(), today=TODAY, gates="x")

    def test_recent_failure_is_recorded_and_a_used(self):
        g = FakeGemini({"gemini-3.8-flash": knowledge_json(("鳥幸", "恵比寿")),
                        "gemini-2.5-flash+search": TimeoutError("deadline")})
        with self.with_places({"鳥幸": legacy_place("A", "鳥幸")}):
            res = v2.search_shops("q", "ja", g, today=TODAY)
        self.assertEqual(res["recent_check"]["status"], "failed")
        self.assertEqual([x["name"] for x in res["shops"]], ["鳥幸"])

    def test_zero_verified_is_zero_cards(self):
        g = FakeGemini({"gemini-3.8-flash": knowledge_json(("幻の店", "恵比寿")),
                        "gemini-2.5-flash+search": json.dumps({"updates": []})})
        with self.with_places({}):
            res = v2.search_shops("q", "ja", g, today=TODAY)
        self.assertEqual(res["status"], "no_verified")
        self.assertEqual(res["shops"], [])

    def test_no_candidates(self):
        g = FakeGemini({"gemini-3.8-flash": json.dumps({"candidates": []}),
                        "gemini-2.5-flash+search": json.dumps({"updates": []})})
        called = []
        with patch.object(v2.legacy, "search_place", lambda *a: called.append(a)):
            res = v2.search_shops("q", "ja", g, today=TODAY)
        self.assertEqual(res["status"], "no_candidates")
        self.assertEqual(called, [])

    def test_knowledge_failure_raises(self):
        g = FakeGemini({"gemini-3.8-flash": TimeoutError("x"),
                        "gemini-2.5-flash+search": json.dumps({"updates": []})})
        with self.with_places({}), self.assertRaises(v2.ShopSearchError) as cm:
            v2.search_shops("q", "ja", g, today=TODAY)
        self.assertEqual(cm.exception.stage, "knowledge")

    def test_max_five_and_place_id_dedupe(self):
        names = [(f"店{i}", "恵比寿") for i in range(8)]
        g = FakeGemini({"gemini-3.8-flash": knowledge_json(*names)})
        table = {f"店{i}": legacy_place(f"P{i}", f"店{i}") for i in range(8)}
        table["店1"] = legacy_place("P0", "店0")      # 別候補が同じ Place ID に照合された
        with self.with_places(table):
            res = v2.search_shops("q", "ja", g, today=TODAY, use_recent=False)
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
            with self.with_places({"鳥幸": legacy_place("A", "鳥幸")}):
                v2.search_shops("q", "ja", g, today=TODAY)
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


if __name__ == "__main__":
    unittest.main()
