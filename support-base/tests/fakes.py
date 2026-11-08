"""shop_search_v2 のテスト用の偽 API（外部サービスは呼ばない）"""
import json


class FakeResponse:
    def __init__(self, text=None, grounding=None):
        self.text = text
        self.candidates = []
        if grounding is not None:
            class Cand:
                pass
            c = Cand()
            c.grounding_metadata = grounding
            self.candidates = [c]


class FakeModels:
    """model 名（と tools の有無）ごとに、返す応答または例外を決める。"""

    def __init__(self, routes):
        self.routes = routes   # {key: text | Exception | FakeResponse}
        self.calls = []

    def generate_content(self, model=None, contents=None, config=None):
        has_tools = bool(getattr(config, "tools", None))
        key = f"{model}+search" if has_tools else model
        self.calls.append({"model": model, "key": key, "contents": contents, "config": config})
        route = self.routes.get(key)
        if isinstance(route, list):
            route = route.pop(0)
        if isinstance(route, Exception):
            raise route
        if isinstance(route, FakeResponse):
            return route
        return FakeResponse(route)


class FakeGemini:
    def __init__(self, routes):
        self.models = FakeModels(routes)


def knowledge_json(*cands):
    return json.dumps({"candidates": [
        {"name": n, "area": a, "genre": "焼き鳥", "reason": f"{n} の理由"} for n, a in cands]},
        ensure_ascii=False)


class FakeHttpResp:
    def __init__(self, status=200, data=None, raw=None):
        self.status_code = status
        self._data = data
        self._raw = raw

    def json(self):
        if self._raw is not None:
            return json.loads(self._raw)
        return self._data
