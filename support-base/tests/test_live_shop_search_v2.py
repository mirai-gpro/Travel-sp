"""live_api_handler の新方式 search_shops（NON_BLOCKING・2 段）のテスト（Live API・Socket.IO は偽物）"""
import asyncio
import os
import sys
import threading
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("GEMINI_API_KEY", "test-dummy")

from google.genai import types  # noqa: E402
import live_api_handler as L  # noqa: E402
from shop_search_v2 import ShopSearchError  # noqa: E402


class FakeSocket:
    def __init__(self):
        self.events = []

    def emit(self, name, data, room=None):
        self.events.append((name, data))


class FakeSession:
    def __init__(self):
        self.tool_responses = []
        self.texts = []

    async def send_tool_response(self, function_responses):
        self.tool_responses.extend(function_responses)

    async def send_realtime_input(self, text=None):
        self.texts.append(text)


class FakeSearch:
    def __init__(self, first, second=None, fail=None, gate=None):
        self.first, self.second, self.fail, self.gate = first, second, fail, gate
        self.closed = False

    def initial(self):
        if self.fail:
            raise self.fail
        return self.first

    def additions(self):
        if self.gate:
            self.gate.wait(5)
        return self.second

    def close(self):
        self.closed = True


class FC:
    def __init__(self, req="恵比寿 焼き鳥", id_="call-1"):
        self.name, self.id, self.args = "search_shops", id_, {"user_request": req}


def shop(name, recent=None):
    return {"place_id": name, "name": name, "area": "恵比寿", "category": "焼き鳥", "description": f"{name}の説明",
            "recent": recent}


def first(names, pending=True):
    return {"search_id": "sid", "stage": "initial", "shops": [shop(n) for n in names], "recent_pending": pending}


def second(names):
    return {"search_id": "sid", "stage": "additions",
            "shops": [shop(n, {"event_type": "renamed", "event_date": "2026-09-01"}) for n in names]}


class TestLiveV2(unittest.TestCase):
    def make(self, search):
        self.sock = FakeSocket()
        h = L.LiveAPISession("s", "concierge", "ja", "prompt", self.sock, "sid-client",
                             shop_search_v2_start=lambda req, lang: search)
        return h

    def run_search(self, h, session, intro_text="1軒目は、鳥幸です。恵比寿の焼き鳥店です。"):
        """検索を開始し、1 段目の tool_response が届いたら読み上げターンの完了を模擬する"""
        async def go():
            h._active_session = session
            await h._start_shop_search_v2(FC(), session)
            for _ in range(200):
                if session.tool_responses or h._shop_search_task.done():
                    break
                await asyncio.sleep(0.01)
            if intro_text is not None:
                h.ai_transcript_buffer = intro_text
                h._process_turn_complete()
            await h._shop_search_task
        asyncio.run(go())

    def test_config_uses_non_blocking_only_for_v2(self):
        h = self.make(FakeSearch(first([])))
        decl = h._build_config()["tools"][0].function_declarations[0]
        self.assertEqual(decl.behavior, types.Behavior.NON_BLOCKING)
        old = L.LiveAPISession("s", "concierge", "ja", "p", FakeSocket(), "c")
        self.assertEqual(old._build_config()["tools"][0].function_declarations[0].behavior, types.Behavior.BLOCKING)

    def test_two_stage_delivery(self):
        search = FakeSearch(first(["鳥幸", "喜鈴"]), second(["酒場くし亭"]))
        h = self.make(search)
        s = FakeSession()
        self.run_search(h, s)
        names = [e[0] for e in self.sock.events]
        self.assertEqual(names, ["shop_search_start", "shop_search_result", "shop_search_append"])
        self.assertEqual([x["name"] for x in self.sock.events[1][1]["shops"]], ["鳥幸", "喜鈴"])
        self.assertEqual(self.sock.events[2][1]["search_id"], "sid")
        r1, r2 = s.tool_responses
        self.assertEqual((r1.will_continue, r1.scheduling), (True, types.FunctionResponseScheduling.WHEN_IDLE))
        self.assertEqual((r2.will_continue, r2.scheduling), (False, types.FunctionResponseScheduling.WHEN_IDLE))
        self.assertEqual(r1.id, "call-1")
        self.assertEqual([x["number"] for x in r1.response["shops"]], [1, 2])
        self.assertIn("少々お待ちください", r1.response["result"])
        self.assertEqual(r2.response["shops"][0]["number"], 3)                       # 番号は続きから
        self.assertEqual(r2.response["shops"][0]["recent"], "2026-09-01 店名変更")
        self.assertIn("全部で3軒", r2.response["result"])
        self.assertEqual(s.texts, [L.SHOP_SEARCH_STARTED_NUDGE])
        self.assertTrue(h._shop_intro_turn_pending)

    def test_no_additions(self):
        h = self.make(FakeSearch(first(["鳥幸"]), second([])))
        s = FakeSession()
        self.run_search(h, s)
        self.assertNotIn("shop_search_append", [e[0] for e in self.sock.events])
        self.assertIn("追加のお店は見つかりませんでした", s.tool_responses[1].response["result"])
        self.assertFalse(s.tool_responses[1].will_continue)

    def test_not_pending_single_response(self):
        h = self.make(FakeSearch(first(["鳥幸"], pending=False)))
        s = FakeSession()
        self.run_search(h, s)
        self.assertEqual(len(s.tool_responses), 1)
        self.assertFalse(s.tool_responses[0].will_continue)
        self.assertIn("以上、1軒", s.tool_responses[0].response["result"])

    def test_initial_failure(self):
        search = FakeSearch(None, fail=ShopSearchError("knowledge", "timeout"))
        h = self.make(search)
        s = FakeSession()
        self.run_search(h, s)
        self.assertEqual(self.sock.events[-1], ("shop_search_result", {"shops": [], "response": ""}))
        self.assertIn("見つかりませんでした", s.tool_responses[0].response["result"])
        self.assertFalse(s.tool_responses[0].will_continue)
        self.assertTrue(search.closed)

    def test_additions_wait_for_intro_then_reconnect(self):
        """2 段目は 1 段目の読み上げ完了まで渡さない。読み上げが長く再接続する時は、再接続後の最初のメッセージで渡す"""
        h = self.make(FakeSearch(first(["鳥幸"]), second(["鳥泉"])))
        old = FakeSession()

        async def go():
            h._active_session = old
            await h._start_shop_search_v2(FC(), old)
            for _ in range(200):
                if h._shop_v2_hold and h._shop_v2_hold["ready"] is not None:
                    break
                await asyncio.sleep(0.01)
            self.assertEqual(len(old.tool_responses), 1)               # 2 段目はまだ渡していない
            h.ai_transcript_buffer = "1軒目は、鳥幸です。" + "説明" * 300   # 500 文字超 → 再接続
            h._process_turn_complete()
            self.assertTrue(h.needs_reconnect)
            await h._shop_search_task
        asyncio.run(go())
        self.assertEqual(len(old.tool_responses), 1)
        self.assertTrue(h._resume_message.startswith(L.SHOP_SEARCH_RESULT_AFTER_RECONNECT))
        self.assertIn("鳥泉", h._resume_message)
        self.assertTrue(h._shop_intro_turn_pending)                     # 再接続後の読み上げを待つ

    def test_nudge_turn_does_not_count_as_intro(self):
        h = self.make(FakeSearch(first(["鳥幸"]), second(["鳥泉"])))
        s = FakeSession()
        old_max = L.SHOP_INTRO_WAIT_MAX_SEC
        L.SHOP_INTRO_WAIT_MAX_SEC = 0.3
        try:
            async def go():
                h._active_session = s
                await h._start_shop_search_v2(FC(), s)
                for _ in range(200):
                    if s.tool_responses:
                        break
                    await asyncio.sleep(0.01)
                h.ai_transcript_buffer = "お店をお探ししますね。"        # 検索開始の一言（読み上げではない）
                h._process_turn_complete()
                await asyncio.sleep(0.1)
                self.assertEqual(len(s.tool_responses), 1)
                await h._shop_search_task                                # 上限時間を過ぎたら渡す
            asyncio.run(go())
        finally:
            L.SHOP_INTRO_WAIT_MAX_SEC = old_max
        self.assertEqual(len(s.tool_responses), 2)
        self.assertFalse(s.tool_responses[1].will_continue)

    def test_intro_before_additions_then_reconnected(self):
        gate = threading.Event()
        h = self.make(FakeSearch(first(["鳥幸"]), second(["鳥泉"]), gate=gate))
        old, new = FakeSession(), FakeSession()

        async def go():
            h._active_session = old
            await h._start_shop_search_v2(FC(), old)
            for _ in range(200):
                if old.tool_responses:
                    break
                await asyncio.sleep(0.01)
            h.ai_transcript_buffer = "1軒目は、鳥幸です。" + "説明" * 300
            h._process_turn_complete()                                   # 読み上げ完了 → 再接続
            h._active_session = new                                      # 再接続済み
            h.needs_reconnect = False
            await h._start_shop_search_v2(FC(id_="call-2"), new)         # 検索中の再呼び出し
            gate.set()
            await h._shop_search_task
        asyncio.run(go())
        self.assertEqual(new.tool_responses[0].scheduling, types.FunctionResponseScheduling.SILENT)
        self.assertEqual(len([r for r in old.tool_responses if r.id == "call-1"]), 1)
        self.assertTrue(any(t.startswith(L.SHOP_SEARCH_RESULT_AFTER_RECONNECT) and "鳥泉" in t for t in new.texts))

    def test_no_initial_shops_additions_without_wait(self):
        h = self.make(FakeSearch(first([]), second(["鳥泉"])))
        s = FakeSession()
        self.run_search(h, s, intro_text=None)
        self.assertEqual(len(s.tool_responses), 2)
        self.assertIn("少し待って", s.tool_responses[0].response["result"])
        self.assertEqual(s.tool_responses[1].response["shops"][0]["number"], 1)

if __name__ == "__main__":
    unittest.main()
