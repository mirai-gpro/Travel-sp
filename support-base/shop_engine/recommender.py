# -*- coding: utf-8 -*-
"""
[A] Recommender（DESIGN.md §2）。
- Step 1〜2 では Google 検索を一切実行しない（修正2）。freshness は LLM の判断と理由を記録するだけ。
- 検索ツールなしで推薦候補を NDJSON でストリーミング生成する。
- モデル名・思考設定・候補数は引数（PoC で決める。推測で既定値を変えない）。
"""
import json
import time

from .redact import redact

DEFAULT_MODEL = 'gemini-2.5-flash'   # 現行コードで使用実績のあるモデル。PoC で比較して決める
DEFAULT_CANDIDATES = 8               # 基本仕様 §4 Phase 2 の検証初期値

PROMPT_TEMPLATE = """あなたは日本のレストランに精通したグルメコンシェルジュです。
ユーザーの条件に最も合う、実在する飲食店を推薦してください。

【推薦の方針】
- 推薦の価値（料理の美味しさ・専門性・評判、条件への適合、店ごとの特徴の違い）で選び、順位を付ける。
- 単なる知名度や検索順位ではなく、このユーザーにとっての推薦価値を重視する。
- 確実に実在し、条件のエリアにある店だけを挙げる。存在が不確かな店・閉業した可能性が高い店は挙げない。
- 店名は正式名称。読み・英字表記・旧店名など別の表記があれば name_variants に入れる。

【最新情報の判断】
- 最近の開店・リニューアル・移転・話題・受賞など、最新情報を補うと推薦の質が上がる場合だけ freshness.required を true にする。
- 最新情報そのものがユーザーの要望の中心（例: 「最近オープンした」）なら freshness.central も true にする。
- 候補が足りない、自信がない、という理由で required を true にしてはいけない。
- required が true のときだけ、query に検索テーマを1つ書く。

【出力形式（厳守）】
- 1行に1つの JSON オブジェクトだけを出力する。改行を JSON の途中に入れない。マークダウン・説明文・コードフェンスは出力しない。
- 1行目は plan、続けて candidate を推薦順に {n} 件、最後に end を出力する。

{{"type":"plan","area":"エリア名","genre":"ジャンル","count":5,"freshness":{{"required":false,"central":false,"reason":"","query":""}}}}
{{"type":"candidate","rank":1,"name":"正式な店名","name_variants":["別表記"],"area":"最寄り駅またはエリア","category":"料理ジャンル","reason":"推薦理由を2〜3文で具体的に","specialty":"看板料理","price_range":"5,000〜7,000円"}}
{{"type":"end"}}

【ユーザーの条件】
{request}
"""


class RecommenderError(Exception):
    def __init__(self, reason, detail=''):
        super().__init__(f'{reason}: {detail}')
        self.reason = reason
        self.detail = detail


def classify_error(e):
    code = getattr(e, 'code', None) or getattr(e, 'status_code', None)
    if code in (503, 504) or (isinstance(code, int) and 500 <= code < 600):
        return 'upstream_error'
    if 'timeout' in type(e).__name__.lower() or 'deadline' in str(e).lower()[:200]:
        return 'timeout'
    return 'error'


def build_config(types_mod, thinking_budget=None):
    """推薦呼び出しの設定。ツール（Google 検索等）は付けない"""
    kwargs = {}
    if thinking_budget is not None:
        kwargs['thinking_config'] = types_mod.ThinkingConfig(thinking_budget=thinking_budget)
    return types_mod.GenerateContentConfig(**kwargs)


class LineParser:
    """ストリーミングで届くテキストを行に区切り、JSON 行を取り出す"""

    def __init__(self):
        self.buf = ''
        self.bad_lines = []

    def feed(self, text):
        self.buf += text or ''
        out = []
        while '\n' in self.buf:
            line, self.buf = self.buf.split('\n', 1)
            obj = self._parse(line)
            if obj is not None:
                out.append(obj)
        return out

    def flush(self):
        line, self.buf = self.buf, ''
        obj = self._parse(line)
        return [obj] if obj is not None else []

    def _parse(self, line):
        s = line.strip()
        if not s or s.startswith('```'):
            return None
        if not s.startswith('{'):
            self.bad_lines.append(redact(s[:200]))
            return None
        try:
            obj = json.loads(s)
        except json.JSONDecodeError:
            self.bad_lines.append(redact(s[:200]))
            return None
        return obj if isinstance(obj, dict) else None


def stream_recommendations(client, types_mod, user_request, model=DEFAULT_MODEL,
                           n_candidates=DEFAULT_CANDIDATES, thinking_budget=None,
                           timeout_sec=20.0, timing=None, now=time.monotonic):
    """
    plan / candidate / end を dict で順に yield する。candidate の rank は受信順で付け直す。
    timing に T1（最初のチャンク）, T1p（plan）, T1c（1件目の candidate）, T2（完了）を記録する。
    """
    timing = timing if timing is not None else {}
    prompt = PROMPT_TEMPLATE.format(n=n_candidates, request=user_request)
    config = build_config(types_mod, thinking_budget)
    parser = LineParser()
    t_start = now()
    rank = 0
    seen_names = set()
    try:
        stream = client.models.generate_content_stream(
            model=model,
            contents=[{'role': 'user', 'parts': [{'text': prompt}]}],
            config=config,
        )
        for chunk in stream:
            if 'T1' not in timing:
                timing['T1'] = now()
            if now() - t_start > timeout_sec:
                raise RecommenderError('timeout', f'>{timeout_sec}s')
            for obj in parser.feed(getattr(chunk, 'text', None) or ''):
                item = _normalize_item(obj, rank, seen_names, timing, now)
                if item is None:
                    continue
                if item['type'] == 'candidate':
                    rank = item['rank']
                yield item
        for obj in parser.flush():
            item = _normalize_item(obj, rank, seen_names, timing, now)
            if item is not None:
                if item['type'] == 'candidate':
                    rank = item['rank']
                yield item
    except RecommenderError:
        raise
    except Exception as e:  # SDK の例外（503 等）
        raise RecommenderError(classify_error(e), redact(f'{type(e).__name__}: {str(e)[:300]}'))
    finally:
        timing['T2'] = now()
        timing['bad_lines'] = parser.bad_lines


def _normalize_item(obj, rank, seen_names, timing, now):
    kind = obj.get('type')
    if kind == 'plan':
        timing.setdefault('T1p', now())
        fr = obj.get('freshness') or {}
        return {'type': 'plan', 'area': str(obj.get('area') or ''), 'genre': str(obj.get('genre') or ''),
                'count': int(obj.get('count') or 5) if str(obj.get('count') or '5').isdigit() else 5,
                'freshness': {'required': bool(fr.get('required')), 'central': bool(fr.get('central')),
                              'reason': str(fr.get('reason') or ''), 'query': str(fr.get('query') or '')}}
    if kind == 'candidate':
        name = str(obj.get('name') or '').strip()
        if not name or name in seen_names:
            return None
        seen_names.add(name)
        timing.setdefault('T1c', now())
        variants = obj.get('name_variants') or []
        if not isinstance(variants, list):
            variants = [str(variants)]
        return {'type': 'candidate', 'rank': rank + 1, 'llm_rank': obj.get('rank'), 'name': name,
                'name_variants': [str(v) for v in variants if v],
                'area': str(obj.get('area') or ''), 'category': str(obj.get('category') or ''),
                'reason': str(obj.get('reason') or ''), 'specialty': str(obj.get('specialty') or ''),
                'price_range': str(obj.get('price_range') or '')}
    if kind == 'end':
        return {'type': 'end'}
    return None

# Freshness Search（Google 検索付きの呼び出し）は Step 3 で実装する。Step 1〜2 には存在しない（修正2）。
