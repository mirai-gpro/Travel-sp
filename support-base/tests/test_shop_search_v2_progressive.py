"""2 段表示（ProgressiveSearch）のテスト"""
import json
import os
import sys
import threading
import unittest
from datetime import date
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import shop_search_v2 as v2  # noqa: E402
from fakes import FakeGemini  # noqa: E402
from test_shop_search_v2_verify import legacy_place  # noqa: E402

TODAY = date(2026, 11, 8)
K = v2.KNOWLEDGE_MODEL


def a_json(*names, genre_types=("yakitori_restaurant",)):
    return json.dumps({"genre_types": list(genre_types), "genre_exact": True, "candidates": [
        {"name": n, "area": "恵比寿", "genre": "焼き鳥", "reason": f"{n}の理由"} for n in names]}, ensure_ascii=False)


def b_json(*items):
    return json.dumps({"updates": [{"name": n, "area": "恵比寿", "genre": "焼き鳥", "event_type": ev,
                                    "event_date": "2026-09", "source_url": "https://news.example/x", "reason": "最新"}
                                   for n, ev in items]}, ensure_ascii=False)


class TestProgressive(unittest.TestCase):
    def setUp(self):
        self.patches = [patch.object(v2.legacy, "extract_area_from_text", lambda t, l: "恵比寿"),
                        patch.object(v2.legacy, "get_region_from_area", lambda a, l: {"country_code": "JP"}),
                        patch.object(v2, "fetch_place_types", lambda *a: ["yakitori_restaurant"])]
        for p_ in self.patches:
            p_.start()

    def tearDown(self):
        for p_ in self.patches:
            p_.stop()

    def places(self, table):
        return patch.object(v2.legacy, "search_place", lambda name, area, g, l: table.get(name))

    def test_two_stages(self):
        g = FakeGemini({K: a_json("鳥幸", "地鶏やおまへん", "喜鈴"),
                        "gemini-2.5-flash+search": b_json(("鳥幸", "renovated"), ("酒場くし亭", "renamed"),
                                                          ("鳥泉", "opened"), ("喜鈴別名", "opened"))})
        table = {"鳥幸": legacy_place("A", "鳥幸"), "地鶏やおまへん": legacy_place("X", "食鶏 しまや"),
                 "喜鈴": legacy_place("K", "喜鈴"), "酒場くし亭": legacy_place("C", "酒場くし亭"),
                 "鳥泉": legacy_place("T", "恵比寿 鳥泉"), "喜鈴別名": legacy_place("K", "喜鈴別名")}
        with self.places(table):
            ps = v2.ProgressiveSearch("恵比寿 焼き鳥", "ja", g, "key", today=TODAY)
            first = ps.initial()
            second = ps.additions()
        self.assertEqual([s["name"] for s in first["shops"]], ["鳥幸", "喜鈴"])        # すり替わりは除外
        self.assertTrue(first["recent_pending"])
        self.assertEqual(first["search_id"], second["search_id"])
        # B の「鳥幸」は 1 段目と同じ店なので除く。place_id が 1 段目と同じ店（K）も除く
        self.assertEqual([s["name"] for s in second["shops"]], ["酒場くし亭", "恵比寿 鳥泉"])
        self.assertEqual(second["shops"][0]["recent"]["event_type"], "renamed")
        self.assertIn("duplicate_place", [d["reason"] for d in second["rejected_detail"]])
        for k in ("a_ms", "b_ms", "places_ms", "initial_ms", "additions_ms"):
            self.assertIn(k, second["timings"])

    def test_initial_does_not_wait_for_b(self):
        gate = threading.Event()

        g = FakeGemini({K: a_json("鳥幸")})
        orig = g.models.generate_content

        def gen(model=None, contents=None, config=None):
            if getattr(config, "tools", None):
                gate.wait(5)
                return orig(model=model, contents=contents, config=config)
            return orig(model=model, contents=contents, config=config)
        g.models.routes["gemini-2.5-flash+search"] = b_json(("鳥泉", "opened"))
        g.models.generate_content = gen
        with self.places({"鳥幸": legacy_place("A", "鳥幸"), "鳥泉": legacy_place("T", "鳥泉")}):
            ps = v2.ProgressiveSearch("q", "ja", g, "key", today=TODAY)
            first = ps.initial()                       # B はまだ終わっていない
            self.assertNotIn("b_ms", first["timings"])
            gate.set()
            second = ps.additions()
        self.assertEqual([s["name"] for s in first["shops"]], ["鳥幸"])
        self.assertEqual([s["name"] for s in second["shops"]], ["鳥泉"])

    def test_b_failure_and_limits(self):
        g = FakeGemini({K: a_json(*[f"店{i}" for i in range(8)]),
                        "gemini-2.5-flash+search": TimeoutError("deadline")})
        with self.places({f"店{i}": legacy_place(f"P{i}", f"店{i}") for i in range(8)}):
            ps = v2.ProgressiveSearch("q", "ja", g, "key", today=TODAY)
            first = ps.initial()
            second = ps.additions()
        self.assertEqual(len(first["shops"]), v2.MAX_SHOPS)
        self.assertEqual(second["shops"], [])
        self.assertEqual(second["recent_check"]["status"], "failed")

    def test_additions_capped(self):
        g = FakeGemini({K: a_json("鳥幸"),
                        "gemini-2.5-flash+search": b_json(*[(f"新店{i}", "opened") for i in range(5)])})
        table = {"鳥幸": legacy_place("A", "鳥幸")}
        table.update({f"新店{i}": legacy_place(f"N{i}", f"新店{i}") for i in range(5)})
        with self.places(table):
            ps = v2.ProgressiveSearch("q", "ja", g, "key", today=TODAY)
            ps.initial()
            second = ps.additions()
        self.assertEqual(len(second["shops"]), v2.ADDITION_MAX)

    def test_knowledge_failure_raises_and_no_recent(self):
        g = FakeGemini({K: TimeoutError("x"), "gemini-2.5-flash+search": b_json()})
        ps = v2.ProgressiveSearch("q", "ja", g, "key", today=TODAY)
        with self.assertRaises(v2.ShopSearchError):
            ps.initial()
        ps2 = v2.ProgressiveSearch("q", "ja", FakeGemini({K: a_json()}), "key", today=TODAY, use_recent=False)
        self.assertFalse(ps2.initial()["recent_pending"])
        self.assertEqual(ps2.additions()["shops"], [])


if __name__ == "__main__":
    unittest.main()
