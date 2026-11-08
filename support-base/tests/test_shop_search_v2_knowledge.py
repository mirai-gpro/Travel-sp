"""A: knowledge_candidates のテスト（実行: cd support-base && python -m unittest discover -s tests -v）"""
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import shop_search_v2 as v2  # noqa: E402
from fakes import FakeGemini, knowledge_json  # noqa: E402


class TestKnowledge(unittest.TestCase):
    def test_normal(self):
        g = FakeGemini({"gemini-3.5-flash-lite": knowledge_json(("鳥幸", "恵比寿"), ("鳥しき", "目黒"))})
        res = v2.knowledge_candidates(g, "恵比寿 焼き鳥 デート", "ja")
        self.assertEqual([c["name"] for c in res], ["鳥幸", "鳥しき"])
        self.assertEqual([c["cand_id"] for c in res], ["k1", "k2"])
        self.assertTrue(all(c["source_type"] == "knowledge" for c in res))
        call = g.models.calls[0]
        self.assertEqual(call["model"], "gemini-3.5-flash-lite")
        self.assertFalse(getattr(call["config"], "tools", None))           # Google 検索なし
        self.assertEqual(call["config"].response_mime_type, "application/json")
        self.assertEqual(call["config"].thinking_config.thinking_level.value, "LOW")
        self.assertIn("恵比寿 焼き鳥 デート", call["contents"])
        self.assertIn("yakitori_restaurant", call["config"].system_instruction)          # タイプ一覧は指示文で渡す
        self.assertNotIn("enum", json.dumps(call["config"].response_json_schema))       # enum は 400 になったため使わない

    def test_genre_types_filtered_to_official_list(self):
        text = {"genre_types": ["yakitori_restaurant", "made_up_type", "chicken_restaurant"], "genre_exact": True,
                "candidates": [{"name": "鳥幸", "area": "恵比寿", "genre": "焼き鳥", "reason": ""}]}
        g = FakeGemini({"gemini-3.5-flash-lite": json.dumps(text, ensure_ascii=False)})
        cands, types = v2.knowledge_call(g, "q", "ja")
        self.assertEqual(types, ["yakitori_restaurant", "chicken_restaurant"])
        self.assertEqual([c["name"] for c in cands], ["鳥幸"])

    def test_genre_types_dropped_when_not_exact(self):
        # 串揚げは Places に専用タイプが無い。近いタイプだけでは判定しない（PoC で「串揚げ 豊」が bar 扱いで外れたため）
        for exact in (False, None):
            text = {"genre_types": ["japanese_restaurant"], "candidates": []}
            if exact is not None:
                text["genre_exact"] = exact
            _, types = v2.knowledge_call(FakeGemini({"gemini-3.5-flash-lite": json.dumps(text)}), "q", "ja")
            self.assertEqual(types, [])

    def test_more_than_max_truncated_and_incomplete_items_skipped(self):
        cands = [(f"店{i}", "恵比寿") for i in range(10)]
        text = json.loads(knowledge_json(*cands))
        text["candidates"].insert(0, {"name": "", "area": "恵比寿", "genre": "", "reason": ""})
        text["candidates"].insert(1, {"name": "エリアなし", "area": "", "genre": "", "reason": ""})
        text["candidates"].insert(2, "not-a-dict")
        g = FakeGemini({"gemini-3.5-flash-lite": json.dumps(text, ensure_ascii=False)})
        res = v2.knowledge_candidates(g, "q", "ja")
        self.assertEqual(len(res), v2.KNOWLEDGE_MAX)
        self.assertEqual(res[0]["name"], "店0")

    def test_errors(self):
        for route in ("not json", json.dumps({"x": 1}), json.dumps([1, 2]), "",
                      TimeoutError("deadline")):
            with self.assertRaises(v2.ShopSearchError) as cm:
                v2.knowledge_candidates(FakeGemini({"gemini-3.5-flash-lite": route}), "q", "ja")
            self.assertEqual(cm.exception.stage, "knowledge")

    def test_empty_candidates_is_not_error(self):
        res = v2.knowledge_candidates(FakeGemini({"gemini-3.5-flash-lite": json.dumps({"candidates": []})}), "q", "ja")
        self.assertEqual(res, [])


if __name__ == "__main__":
    unittest.main()
