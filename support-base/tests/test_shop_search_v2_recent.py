"""B: recent_updates のテスト"""
import json
import os
import sys
import unittest
from datetime import date

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import shop_search_v2 as v2  # noqa: E402
from fakes import FakeGemini, FakeResponse  # noqa: E402

TODAY = date(2026, 11, 8)


class Obj:
    def __init__(self, **kw):
        self.__dict__.update(kw)


def grounding():
    return Obj(web_search_queries=["恵比寿 焼き鳥 新店 2026"],
               grounding_chunks=[Obj(web=Obj(uri="https://vertexaisearch.example/r1", title="news.example")),
                                 Obj(web=None)],
               search_entry_point=Obj(rendered_content="<div>suggestions</div>"))


def updates_text(items, fenced=True):
    body = json.dumps({"updates": items}, ensure_ascii=False)
    return f"調査結果です。\n```json\n{body}\n```\n以上" if fenced else body


def item(name, event_type="opened", event_date="2026-05", area="恵比寿"):
    return {"name": name, "area": area, "genre": "焼き鳥", "event_type": event_type,
            "event_date": event_date, "source_url": "https://news.example/a", "reason": "新店"}


class TestRecent(unittest.TestCase):
    def run_b(self, route):
        g = FakeGemini({"gemini-2.5-flash+search": route})
        return v2.recent_updates(g, "恵比寿 焼き鳥", "ja", TODAY), g

    def test_normal_with_grounding_and_fenced_json(self):
        res, g = self.run_b(FakeResponse(updates_text([item("新店A"), item("改装B", "renovated", "2026-10-01")]),
                                         grounding=grounding()))
        self.assertEqual(res["status"], "ok")
        self.assertEqual([u["name"] for u in res["updates"]], ["新店A", "改装B"])
        self.assertEqual([u["cand_id"] for u in res["updates"]], ["r1", "r2"])
        self.assertTrue(all(u["source_type"] == "search" for u in res["updates"]))
        self.assertEqual(res["queries"], ["恵比寿 焼き鳥 新店 2026"])
        self.assertEqual(res["sources"], [{"uri": "https://vertexaisearch.example/r1", "title": "news.example"}])
        self.assertEqual(res["search_entry_point"], "<div>suggestions</div>")
        cfg = g.models.calls[0]["config"]
        self.assertEqual(g.models.calls[0]["model"], "gemini-2.5-flash")
        self.assertTrue(cfg.tools and cfg.tools[0].google_search is not None)
        self.assertIsNone(cfg.response_mime_type)       # 検索併用時は JSON モードを使わない
        self.assertIn("2025-11-08", cfg.system_instruction)   # 12 か月の範囲
        self.assertIn("2026-11-08", cfg.system_instruction)

    def test_window_and_validation(self):
        items = [item("古い店", event_date="2025-10-31"),           # 範囲外（12 か月より前）
                 item("未来の店", event_date="2026-12-01"),          # 範囲外（未来）
                 item("日付不明", event_date=""),                    # 日付不明は残す（記録する）
                 item("種別不正", event_type="closed"),
                 {"name": "", "area": "恵比寿", "event_type": "opened"},
                 "not-a-dict"]
        res, _ = self.run_b(updates_text(items, fenced=False))
        self.assertEqual([u["name"] for u in res["updates"]], ["日付不明"])
        self.assertFalse(res["updates"][0]["event_date_known"])

    def test_max_items(self):
        res, _ = self.run_b(updates_text([item(f"店{i}") for i in range(9)]))
        self.assertEqual(len(res["updates"]), v2.RECENT_MAX)

    def test_failures_do_not_raise(self):
        for route in (TimeoutError("deadline"), "検索結果は見つかりませんでした。", json.dumps({"x": 1})):
            res, _ = self.run_b(route)
            self.assertEqual(res["status"], "failed")
            self.assertTrue(res["reason"])
            self.assertEqual(res["updates"], [])

    def test_empty_is_ok(self):
        res, _ = self.run_b(updates_text([]))
        self.assertEqual(res["status"], "ok")
        self.assertEqual(res["updates"], [])

    def test_extract_json_handles_braces_in_strings(self):
        text = 'x {"updates": [{"name": "店{特}", "reason": "a}b"}]} y'
        self.assertEqual(v2._extract_json_object(text)["updates"][0]["name"], "店{特}")


if __name__ == "__main__":
    unittest.main()
