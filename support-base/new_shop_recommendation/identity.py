# -*- coding: utf-8 -*-
"""
同一店舗判定（指示書 6.2 の判定表に基づく新規実装。外部 API を呼ばない純粋関数のみ）

1 件の LLM 候補に対して、Places (New) が返した全結果を照合し、次の証拠を独立に評価する。
  - 店名: 表記揺れ（空白・記号・全角半角・かな/カナ・業態の接頭/接尾語・括弧内の別表記）を許容して一致するか。
          部分一致（片方がもう片方を含むだけ）は同一の証拠にしない。
  - 支店: 双方に支店名（「〇〇店」「本店」等）や別館・号店の表示があり、食い違えば矛盾。
  - 地域: LLM の area_hint の地名が Places の住所に含まれるか。確認できなければ VERIFIED にしない。
  - 業態: Places の types / primaryType が飲食系か。飲食系でなければ矛盾。
  - 営業状態: OPERATIONAL のみ可。閉業は CLOSED、記載なしは判定保留（VERIFIED にしない）。
  - 一意性: 上の条件をすべて満たす place_id が 1 つだけなら VERIFIED、複数なら AMBIGUOUS。
自動判定には限界があり、曖昧な場合は AMBIGUOUS / NOT_VERIFIED として除外する（すり替えを防ぐ側に倒す）。
"""
import re
import unicodedata

from . import contracts as c

# 店名の前後に付く業態・法人の一般語（前後にある場合だけ除く。除いた残りが 2 文字未満なら除かない）
_AFFIXES = sorted({
    '株式会社', '有限会社', '(株)', '炭火焼鳥', '炭火焼き鳥', '炭火やきとり', '炭火串焼', '炭火串焼き', '焼鳥', '焼き鳥',
    'やきとり', 'ヤキトリ', '串焼き', '串焼', '鳥料理', '鶏料理', '居酒屋', 'レストラン', 'イタリアン', 'ビストロ',
    'トラットリア', 'リストランテ', 'ピッツェリア', 'カフェ', '喫茶', '割烹', '料亭', '鮨', '寿司', 'すし', '天ぷら',
    '天麩羅', 'てんぷら', '日本料理', '和食', '中華料理', '中国料理', '焼肉', 'ラーメン', '蕎麦', 'そば', 'うなぎ',
    'restaurant', 'trattoria', 'ristorante', 'pizzeria', 'bistro', 'cafe', 'caffe', 'bar', 'osteria',
}, key=len, reverse=True)
_SYMBOLS = re.compile(r"[\s　・･\-‐－ー―~〜～'’`\".,、。!！?？&＆/／:：;；@＠#＃*＊+＋|｜]")
_BRACKETS = re.compile(r'[\(（【\[「『]([^\)）】\]」』]*)[\)）】\]」』]')
_ANNEX = re.compile(r'(別館|別邸|新館|分店|離れ|はなれ|annex|[0-9０-９一二三四五六七八九十]+号店)', re.IGNORECASE)
_AREA_SUFFIX = re.compile(r'(駅前|駅周辺|駅|西口|東口|南口|北口|中央口|周辺|付近|界隈|エリア|地区|方面|近辺)+$')
_PREFIX_DIRECTION = ('中', '上', '下', '東', '西', '南', '北', '新', '奥', '元')
_FOOD_TYPES = {'restaurant', 'food', 'bar', 'cafe', 'bakery', 'meal_takeaway', 'meal_delivery', 'night_club',
               'coffee_shop', 'pub', 'wine_bar', 'tea_house', 'confectionery', 'dessert_shop', 'food_court'}


def _nfkc(s):
    return unicodedata.normalize('NFKC', s or '').strip()


def _hira(s):
    return ''.join(chr(ord(ch) - 0x60) if 'ァ' <= ch <= 'ヶ' else ch for ch in s)


def _compact(s):
    return _hira(_SYMBOLS.sub('', _nfkc(s).lower()))


_AFFIXES_C = sorted({_compact(a) for a in _AFFIXES}, key=len, reverse=True)


def split_name(raw):
    """店名を (本体, 括弧内の別表記リスト, 支店名, 別館等の表示) に分ける"""
    n = _nfkc(raw)
    aliases = [a.strip() for a in _BRACKETS.findall(n) if a.strip()]
    body = _BRACKETS.sub(' ', n).strip()
    annex = bool(_ANNEX.search(n))
    if annex:   # 別館等の表示は annex として別に扱い、比較用の本体からは除く
        body = _ANNEX.sub(' ', body).strip()
    branch = ''
    tokens = body.split()
    if len(tokens) > 1 and tokens[-1].endswith('店'):
        branch = tokens[-1]
        body = ' '.join(tokens[:-1])
    return body, aliases, _compact(branch), annex


def core(text):
    """表記揺れを吸収した比較用の店名"""
    s = _compact(text)
    changed = True
    while changed:
        changed = False
        for a in _AFFIXES_C:
            if s.startswith(a) and len(s) - len(a) >= 2:
                s = s[len(a):]
                changed = True
            elif s.endswith(a) and len(s) - len(a) >= 2:
                s = s[:-len(a)]
                changed = True
    return s


def name_forms(raw):
    body, aliases, _b, _a = split_name(raw)
    forms = {core(body)} | {core(a) for a in aliases}
    return {f for f in forms if f}


def area_tokens(area_hint):
    """area_hint から住所照合用の地名トークンを作る（例: '横浜駅西口' → {'横浜'}、'中目黒' → {'中目黒','目黒'}）"""
    toks = set()
    for part in re.split(r'[\s、,・/／]+', _nfkc(area_hint)):
        p = _AREA_SUFFIX.sub('', part).strip()
        if len(p) >= 2:
            toks.add(p)
            if len(p) >= 3 and p[0] in _PREFIX_DIRECTION:
                toks.add(p[1:])
    return toks


def area_confirmed(address, tokens):
    a = _nfkc(address)
    return any(t in a for t in tokens)


def is_food_place(place):
    types = set(place.get('types') or [])
    pt = place.get('primaryType') or ''
    return bool(types & _FOOD_TYPES) or pt.endswith('_restaurant') or pt in _FOOD_TYPES \
        or any(t.endswith('_restaurant') for t in types)


def judge(candidate: c.Candidate, places: list):
    """
    returns (status, reason, chosen_place or None, evidence list)
    evidence には place_id と判定結果だけを残す（Maps のコンテンツ本体は残さない）
    """
    cand_forms = set()
    cand_branches = set()
    cand_annex = split_name(candidate.name)[3]
    for raw in [candidate.name]:
        cand_forms |= name_forms(raw)
        b = split_name(raw)[2]
        if b:
            cand_branches.add(b)
    tokens = area_tokens(candidate.area_hint)

    evidence = []
    qualified = []
    closed = []
    for p in places:
        dn = ((p.get('displayName') or {}).get('text')) or ''
        p_forms = name_forms(dn)
        _body, _al, p_branch, p_annex = split_name(dn)
        name_ok = bool(cand_forms & p_forms)
        branch_conflict = bool((cand_branches and p_branch and p_branch not in cand_branches)
                               or (cand_annex != p_annex))
        area_ok = area_confirmed(p.get('formattedAddress') or '', tokens)
        food_ok = is_food_place(p)
        bstatus = p.get('businessStatus') or 'UNKNOWN'
        ev = {'place_id': p.get('id'), 'name_match': name_ok, 'branch_conflict': branch_conflict,
              'area_confirmed': area_ok, 'food_type': food_ok, 'business_status': bstatus}
        evidence.append(ev)
        if not (name_ok and not branch_conflict and area_ok and food_ok):
            continue
        if bstatus == 'OPERATIONAL':
            qualified.append(p)
        elif bstatus in ('CLOSED_PERMANENTLY', 'CLOSED_TEMPORARILY'):
            closed.append(p)
        else:
            ev['note'] = 'business_status_unknown'

    ids = {p.get('id') for p in qualified}
    if len(ids) == 1:
        return c.VERIFIED, 'verified', qualified[0], evidence
    if len(ids) > 1:
        return c.AMBIGUOUS, 'multiple_matching_places', None, evidence
    if closed:
        return c.CLOSED, 'closed', None, evidence
    if not places:
        return c.NOT_VERIFIED, 'no_results', None, evidence
    # 理由を最も近い失敗に寄せて記録
    if any(e['name_match'] and e['branch_conflict'] for e in evidence):
        return c.NOT_VERIFIED, 'branch_conflict', None, evidence
    if any(e['name_match'] and not e['area_confirmed'] for e in evidence):
        return c.NOT_VERIFIED, 'area_unconfirmed', None, evidence
    if any(e['name_match'] and not e['food_type'] for e in evidence):
        return c.NOT_VERIFIED, 'genre_conflict', None, evidence
    if any(e.get('note') == 'business_status_unknown' for e in evidence):
        return c.NOT_VERIFIED, 'business_status_unknown', None, evidence
    return c.NOT_VERIFIED, 'name_mismatch', None, evidence
