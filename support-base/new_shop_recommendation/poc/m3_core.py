# -*- coding: utf-8 -*-
"""
Gate M3（フロー S 統合 PoC）の中核ロジック（計測専用。推薦エンジン・本番フローには組み込まない）

- 推薦A: 店名リスト（rank・name・area_hint のみ）。推薦の観点・順位付けの指示は現行 BASE_INSTRUCTION と同じ文言を使い、
         件数（7 / 10）と「説明文は別工程」の 2 点だけを置き換える
- 推薦B: 推薦A の店舗（名前・順位は変更不可）について specialty・reason を生成
- 店舗単位の照合: Agent Tools searchText（最大 5 候補）→ Place Details → 軽量判定（v0.2 で固定）→
         SAME は採用 / AMBIGUOUS が残れば店舗単位の選択 LLM / それ以外は不採用（穴埋めしない）
- 地理範囲: 依頼文の範囲を尊重（「徒歩 N 分」なら徒歩圏、それ以外は検索エリアの Geocoding viewport から決める）
"""
import json
import math
import re
import statistics
import time
import unicodedata

from new_shop_recommendation import contracts as c
from new_shop_recommendation import recommender
from new_shop_recommendation.poc import light_identity as L

# ------------------------------------------------------------------ 推薦A（店名リスト）
A_MAX_OUTPUT_TOKENS = 1024
B_MAX_OUTPUT_TOKENS = 4096


def a_instruction(n: int) -> str:
    base = recommender.BASE_INSTRUCTION
    repl = [
        ('学習済み知識に基づき最大7候補、推薦順に選定してください。', f'学習済み知識に基づき最大{n}候補、推薦順に選定してください。'),
        ('最初の5店を表示候補、残り2店を実在確認に失敗した際の予備候補とします。',
         f'最初の5店を表示候補、残り{n - 5}店を実在確認に失敗した際の予備候補とします。'),
        ('各店の名称、駅・地区、得意料理や特徴、他店との違いが分かる具体的な推薦理由を返してください。',
         '各店の名称と駅・地区だけを返してください（得意料理や推薦理由は別の工程で作成します）。'),
        ('店舗の存在が不確かな場合に、7件へ無理に水増ししないでください。', f'店舗の存在が不確かな場合に、{n}件へ無理に水増ししないでください。'),
    ]
    for old, new in repl:
        if old not in base:
            raise RuntimeError(f'BASE_INSTRUCTION に想定の文言がありません: {old}')
        base = base.replace(old, new)
    return base


A_SCHEMA = {
    'type': 'object',
    'properties': {
        'freshness_intent': {'type': 'string', 'enum': list(c.FRESHNESS_VALUES)},
        'candidates': {'type': 'array', 'items': {
            'type': 'object',
            'properties': {'rank': {'type': 'integer'}, 'name': {'type': 'string'}, 'area_hint': {'type': 'string'}},
            'required': ['rank', 'name', 'area_hint'],
        }},
    },
    'required': ['freshness_intent', 'candidates'],
}


def a_body(q: str, n: int) -> dict:
    return {
        'model': c.MODEL_ID,
        'input': f'{a_instruction(n)}\n\n【ユーザーの依頼】\n{q}',
        'response_format': {'type': 'text', 'mime_type': 'application/json', 'schema': A_SCHEMA},
        'generation_config': {'thinking_level': c.THINKING_LEVEL, 'max_output_tokens': A_MAX_OUTPUT_TOKENS},
        'stream': True,
        'store': False,
    }


def validate_a(text: str, n: int):
    """推薦A の全文検証（件数 1〜n・rank 連番・空でない店名・重複なし）。returns [ {rank,name,area_hint} ]"""
    try:
        obj = json.loads(text)
    except ValueError as e:
        raise c.RecommendationError('a_invalid_json', str(e)[:120])
    items = obj.get('candidates') if isinstance(obj, dict) else None
    if not isinstance(items, list) or not 1 <= len(items) <= n:
        raise c.RecommendationError('a_invalid_count', f'{len(items) if isinstance(items, list) else "?"} 件')
    out, seen = [], set()
    for i, it in enumerate(items, 1):
        if not isinstance(it, dict) or it.get('rank') != i or not isinstance(it.get('name'), str) \
                or not it['name'].strip() or not isinstance(it.get('area_hint'), str):
            raise c.RecommendationError('a_invalid_item', f'{i} 件目')
        key = ''.join(it['name'].split())
        if key in seen:
            raise c.RecommendationError('a_duplicate', it['name'])
        seen.add(key)
        out.append({'rank': i, 'name': it['name'].strip(), 'area_hint': it['area_hint'].strip()})
    return out


def odd_name_flags(name: str):
    """不自然な店名の目印（集計用。採否には使わない）"""
    flags = []
    for ch in name:
        cp = ord(ch)
        if not (ch.isascii() or 0x3000 <= cp <= 0x30FF or 0x4E00 <= cp <= 0x9FFF or 0xFF00 <= cp <= 0xFFEF
                or 0x3400 <= cp <= 0x4DBF or ch in '・『』「」（）【】〜々〆ヶ'):
            flags.append('foreign_script')
            break
    if 'ではなく' in name or '系列' in name:
        flags.append('meta_text')
    if len(name) > 40:
        flags.append('too_long')
    return flags


# ------------------------------------------------------------------ 推薦B（説明文）
B_INSTRUCTION = (
    'あなたは日本および対象地域の飲食店に詳しいグルメコンシェルジュです。'
    '以下の【推薦店舗】は、ユーザーの依頼に合う店として推薦順に選定済みです。'
    '各店について、得意料理や特徴（specialty）と、他店との違いが分かる具体的な推薦理由（reason）を、学習済み知識に基づき作成してください。'
    '味・調理技術・素材・専門性・評判・その人の条件への適合性を重視してください。'
    '店舗の追加・削除、店名や順位の変更はしないでください。'
    '料金・受賞歴・営業状態などを根拠なく創作しないでください。'
    '各店舗について必ず1件ずつ、rankとnameは入力のまま返してください。'
)
B_SCHEMA = {
    'type': 'object',
    'properties': {'items': {'type': 'array', 'items': {
        'type': 'object',
        'properties': {'rank': {'type': 'integer'}, 'name': {'type': 'string'},
                       'specialty': {'type': 'string'}, 'reason': {'type': 'string'}},
        'required': ['rank', 'name', 'specialty', 'reason'],
    }}},
    'required': ['items'],
}


def b_body(q: str, stores: list) -> dict:
    lst = [{'rank': s['rank'], 'name': s['name'], 'area_hint': s['area_hint']} for s in stores]
    return {
        'model': c.MODEL_ID,
        'input': f'{B_INSTRUCTION}\n\n【ユーザーの依頼】\n{q}\n\n【推薦店舗】\n' + json.dumps(lst, ensure_ascii=False),
        'response_format': {'type': 'text', 'mime_type': 'application/json', 'schema': B_SCHEMA},
        'generation_config': {'thinking_level': c.THINKING_LEVEL, 'max_output_tokens': B_MAX_OUTPUT_TOKENS},
        'stream': False,
        'store': False,
    }


def validate_b(text: str, stores: list):
    """推薦B の検証: 推薦A と同じ店舗・同じ順位・同じ店名で 1 件ずつ。returns {rank: (specialty, reason)}"""
    try:
        obj = json.loads(text)
    except ValueError as e:
        raise c.RecommendationError('b_invalid_json', str(e)[:120])
    items = obj.get('items') if isinstance(obj, dict) else None
    if not isinstance(items, list) or len(items) != len(stores):
        raise c.RecommendationError('b_count_mismatch', f'{len(items) if isinstance(items, list) else "?"}/{len(stores)}')
    want = {s['rank']: s['name'] for s in stores}
    out = {}
    for it in items:
        r = it.get('rank') if isinstance(it, dict) else None
        if r not in want or r in out:
            raise c.RecommendationError('b_rank_mismatch', str(r))
        if (it.get('name') or '').strip() != want[r]:
            raise c.RecommendationError('b_name_changed', f'rank {r}')
        sp, rs = it.get('specialty'), it.get('reason')
        if not isinstance(sp, str) or not isinstance(rs, str) or not rs.strip():
            raise c.RecommendationError('b_invalid_item', f'rank {r}')
        out[r] = (sp.strip(), rs.strip())
    return out


# ------------------------------------------------------------------ 地理範囲（依頼の範囲を尊重）
WALK_RE = re.compile(r'徒歩\s*(\d+)\s*分')
WALK_KM_PER_MIN = 0.08          # 不動産表示の徒歩 1 分 = 80m
WALK_DETOUR = 1.5               # 直線距離と道のりの差の余裕
MIN_WALK_KM = 0.6
AREA_MIN_KM, AREA_MAX_KM, AREA_DEFAULT_KM = 1.5, 10.0, 3.0


def haversine_km(a, b):
    return L.haversine_km(a, b)


def scope_radius_km(q: str, viewport=None):
    """returns (radius_km, reason)。「徒歩 N 分」→ 徒歩圏、それ以外 → Geocoding viewport の対角の半分（1.5〜10km）"""
    m = WALK_RE.search(unicodedata.normalize('NFKC', q))
    if m:
        return max(MIN_WALK_KM, int(m.group(1)) * WALK_KM_PER_MIN * WALK_DETOUR), f'walk_{m.group(1)}min'
    if viewport:
        ne, sw = viewport.get('northeast') or {}, viewport.get('southwest') or {}
        if ne and sw:
            half = haversine_km((ne['lat'], ne['lng']), (sw['lat'], sw['lng'])) / 2
            return min(AREA_MAX_KM, max(AREA_MIN_KM, half)), 'viewport'
    return AREA_DEFAULT_KM, 'default'


def area_candidates(q: str, extracted: str):
    """Geocoding に渡すエリア候補: 既存の extract_area_from_text の結果 → 依頼文の先頭語（で/から/の/空白まで）"""
    out = [extracted] if extracted else []
    head = re.split(r'で|から|の|\s', unicodedata.normalize('NFKC', q), maxsplit=1)[0]
    if head and head not in out:
        out.append(head)
    return out


# ------------------------------------------------------------------ 店舗単位の照合
HARD_REJECT = {'closed', 'not_a_store', 'prefecture_mismatch', 'area_mismatch'}


def match_store(rec, scope, deps, now=time.monotonic, t0=None):
    """
    rec: {'rank','name','area_hint'}  scope: {'prefecture','center','radius_km','area','geo'}
    deps: search(rec) / details_many(places) / select(rec, search_result) / judge(rec_name, detail, scope)
    returns dict（時刻は t0 からの ms）
    """
    t0 = t0 if t0 is not None else now()
    ms = lambda: int((now() - t0) * 1000)  # noqa: E731
    out = {'rank': rec['rank'], 'rec': rec['name'], 'hint': rec['area_hint'], 't_start': ms(), 'path': None,
           'pos': None, 'place_id': None, 'place': None, 'verdicts': [], 'sel_ms': None, 'sel_err': None,
           'n_cand': 0, 'top1': None, 'calls': {'agent_tools': 0, 'details': 0, 'selection': 0}}
    r = deps.search(rec)
    out['calls']['agent_tools'] += 1
    out['t_search'] = ms()
    places = r.get('places') or []
    out['n_cand'] = len(places)
    if not places:
        out.update(path='no_candidates' if r.get('status') in ('OK', 'ZERO_RESULTS') else f'search_error',
                   t_done=ms())
        return out
    out['top1'] = places[0]['place_id']
    dets = deps.details_many(places)
    out['top1_place'] = dets[0] if dets and not (dets[0] or {}).get('error') else None   # 表示・独立判定用（保存しない）
    out['calls']['details'] += len(places)
    out['t_details'] = ms()
    verdicts = []
    for d in dets:
        if d is None or d.get('error'):
            verdicts.append((L.AMBIGUOUS, 'details_error'))
        else:
            verdicts.append(deps.judge(rec['name'], d, scope))
    out['verdicts'] = [f'{v}:{why}' for v, why in verdicts]
    same = [i for i, (v, _w) in enumerate(verdicts) if v == L.SAME]
    amb = [i for i, (v, w) in enumerate(verdicts) if v == L.AMBIGUOUS and w != 'details_error']
    pick = None
    if same:
        pick, out['path'] = same[0], 'same'
    elif amb:
        ts = now()
        out['calls']['selection'] += 1
        try:
            idx = deps.select(rec, r)
            out['sel_ms'] = int((now() - ts) * 1000)
        except c.RecommendationError as e:
            out['sel_ms'] = int((now() - ts) * 1000)
            out['sel_err'] = e.error_type
            idx = None
        if out['sel_err']:
            out['path'] = 'selection_error'
        elif idx is None:
            out['path'] = 'llm_none'
        elif verdicts[idx][0] == L.DIFFERENT:
            out['path'] = f'llm_pick_rejected:{verdicts[idx][1]}'
        else:
            pick, out['path'] = idx, 'llm'
    else:
        out['path'] = 'all_different'
    if pick is not None:
        out['pos'] = pick + 1
        out['place_id'] = places[pick]['place_id']
        out['place'] = dets[pick]
        out['attribution'] = places[pick].get('attribution')
        out['place_url'] = places[pick].get('place_url')
    out['t_done'] = ms()
    return out


def adopt(stores, deadline_ms=None):
    """
    推薦順位のまま・place_id 重複は後順位を不採用・最大 5 件。deadline_ms までに確定した店舗だけ。
    returns {'cards': [store...], 't_first': ms, 't_set': ms}
      t_first: 最初のカード確定時刻
      t_set:   表示する 5 件（または最終集合）が確定する時刻 = その集合の最下位順位までの全店舗が判定済みになった時刻
    """
    done = [s for s in stores if s.get('t_done') is not None and (deadline_ms is None or s['t_done'] <= deadline_ms)]
    cards, seen = [], set()
    for s in sorted(done, key=lambda x: x['rank']):
        if s.get('place_id') and s['place_id'] not in seen and len(cards) < c.DISPLAY_COUNT:
            seen.add(s['place_id'])
            cards.append(s)
    t_first = min((s['t_done'] for s in done if s.get('place_id')), default=None)
    t_set = None
    if cards:
        last_rank = cards[-1]['rank']
        t_set = max(s['t_done'] for s in done if s['rank'] <= last_rank)
    return {'cards': cards, 't_first': t_first, 't_set': t_set}


def judge_with_scope(rec_name, d, scope):
    center = scope.get('center')
    return L.judge(rec_name, {'name': d.get('name'), 'address': d.get('address'), 'types': d.get('types'),
                              'business_status': d.get('business_status'), 'lat': d.get('lat'), 'lng': d.get('lng')},
                   scope.get('prefecture'), area_center=center, max_km=scope.get('radius_km') or AREA_DEFAULT_KM)


def p(v, q):
    """百分位（p50 は中央値、それ以外は最近傍順位）。None は除外"""
    v = sorted(x for x in v if x is not None)
    if not v:
        return None
    if q == 50:
        return statistics.median(v)
    return v[min(len(v) - 1, int(round(q / 100 * (len(v) - 1))))]
