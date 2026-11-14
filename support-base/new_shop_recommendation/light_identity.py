# -*- coding: utf-8 -*-
"""
軽量な店舗同一性判定（製品コード）。
起点は Gate M3 で固定した v0.2（commit f29820b）。`poc/light_identity.py` は M3 再現用にそのまま残す。
M4 で承認された修正 R2〜R4 はこのファイルにだけ入れる（各修正は個別コミット）。

判定順（v0.2）:
  1. 営業状態: OPERATIONAL 以外 → DIFFERENT(closed)
  2. 業態: 飲食業態を含まない／駅・建物・商業施設・地名を含む → DIFFERENT(not_a_store)
  3. 都道府県: 住所に検索エリアの都道府県が含まれない → DIFFERENT(prefecture_mismatch)
  4. 地区: 検索エリア中心から max_km 超 → DIFFERENT(area_mismatch)
  5. 店名: 正規化した「中核名」が一致 → SAME（支店名が食い違う・候補が別館/本館なら AMBIGUOUS）
           英字表記とかな・漢字表記で比較できない → AMBIGUOUS(script_differs)
           中核名が 1 文字 → AMBIGUOUS(short_core)
           推薦名の『』「」内の固有店名が候補と一致しない → AMBIGUOUS(quoted_name_mismatch)（M4 R4）
           漢字とかなの表記違いでありうる → AMBIGUOUS(kana_kanji)（M4 R3）
           中核名に共通する 2 文字の並びが無い → DIFFERENT(name_unrelated)
           それ以外 → AMBIGUOUS(name_partial)
方針: SAME だけを即採用する。AMBIGUOUS は選択 LLM へ回す。DIFFERENT は採用しない。LLM・外部 API は使わない。
"""
import math
import re
import unicodedata

SAME, AMBIGUOUS, DIFFERENT = 'SAME', 'AMBIGUOUS', 'DIFFERENT'

FOOD_TYPES = {'restaurant', 'cafe', 'bar', 'food', 'meal_takeaway', 'meal_delivery', 'bakery'}
NON_STORE_TYPES = {'train_station', 'subway_station', 'transit_station', 'light_rail_station', 'bus_station',
                   'shopping_mall', 'department_store', 'premise', 'subpremise', 'route', 'locality', 'sublocality',
                   'sublocality_level_1', 'sublocality_level_2', 'political', 'neighborhood', 'postal_code',
                   'lodging', 'tourist_attraction', 'park', 'parking'}

# 業態・料理の一般語（ひらがな化・小文字化した後の表記）。長いものから順に取り除く
GENERIC_WORDS = sorted({
    '炭火焼鳥', '炭火やきとり', '炭火焼き鳥', '炭火焼', '炭火', '焼鳥', '焼き鳥', 'やきとり', '焼鶏', '串焼き', '串焼',
    '地鶏焼', '地鶏や', 'てんぷら', '天ぷら', '天麩羅', '鮨', 'すし', '寿司', '割烹', '日本料理', '和食料理屋', '和食',
    '京料理', '加賀料理', '料理', '個室会席', '個室', '会席', 'らーめん', 'とんこつらーめん', '中華そば', 'かふぇ', 'cafe',
    'café', 'coffee', 'こーひー', '珈琲店', '珈琲', '名曲喫茶', '喫茶', '串かつ専門店', '串かつ酒場', '串かつ', '串かつ場',
    '立ち呑み処', '立呑み処', '立呑', '立ち呑み', '立ち飲み', 'じんぎすかん', '成吉思汗', '生らむ', 'ぴっつぇりあ',
    'pizzeria', 'とらっとりあ', 'trattoria', 'りすとらんて', 'ristorante', 'いたりあん', '居酒屋', '酒場', 'だいにんぐ',
    'dining', 'ばー', 'bar', 'とらっとりあえぴっつぇりあ'}, key=len, reverse=True)

# 地名（ひらがな化後）。中核名の比較から除く（支店名の判定には使う）
AREA_WORDS = sorted({
    '西新宿', '新宿', '銀座', '渋谷', '中目黒', '吉祥寺', '東京駅', '東京', '丸の内', '八重洲', '横浜', '関内', '野毛',
    '桜木町', 'すすきの', '札幌', 'さっぽろ', '祇園', 'ぎおん', 'ぎをん', '京都', '梅田', 'うめだ', '大阪', '北新地',
    '阪急うめだ'}, key=len, reverse=True)
ANNEX = ('別館', '本館')
MAIN = ('総本店', '本店')
BRACKETS = re.compile(r'[（(［\[【『「]([^）)］\]】』」]*)[）)］\]】』」]')
PUNCT = re.compile(r'[\s・･\-‐ー―−–—_/|｜&＆\'’"“”.,、。!！?？:：~〜]')


def kana_to_hira(s):
    return ''.join(chr(ord(ch) - 0x60) if 'ァ' <= ch <= 'ヶ' else ch for ch in s)


def norm(s):
    return kana_to_hira(unicodedata.normalize('NFKC', s or '').lower())


def branch_of(name):
    """
    支店表記を返す（無ければ None）。
      - 末尾が 総本店・本店・別館・本館 → その語
      - 2 語以上で、最後の語が「〇〇店」または地名を含む語（例: 吉祥寺店・渋谷一丁目）→ その語
    """
    n = BRACKETS.sub(' ', norm(name)).strip()
    for w in MAIN + ANNEX:
        if n.endswith(w):
            return w
    toks = n.split()
    if len(toks) >= 2:
        last = toks[-1]
        if last.endswith('店') or any(a in last for a in AREA_WORDS):
            return last
    return None


def _strip(p, words):
    for w in words:
        p = p.replace(w, ' ')
    return p


def core_variants(name):
    """
    比較用の中核名の候補（括弧外・括弧内それぞれ）。
    支店表記を除いた後、業態語と地名を除いたもの → 2 文字未満なら地名だけ残したもの → それも短ければ元の名前、の順で採る
    """
    n = norm(name)
    b = branch_of(name)
    parts = [BRACKETS.sub(' ', n)] + [m for m in BRACKETS.findall(n)]
    out = set()
    for i, p in enumerate(parts):
        p = p.strip()
        if i == 0 and b and p.endswith(b):
            p = p[:len(p) - len(b)]
        c0 = PUNCT.sub('', p)
        c0 = c0[:-1] if c0.endswith('店') and len(c0) > 2 else c0
        c1 = PUNCT.sub('', _strip(p, GENERIC_WORDS))
        c2 = PUNCT.sub('', _strip(_strip(p, GENERIC_WORDS), AREA_WORDS))
        for c in (c2, c1, c0):
            c = c[:-1] if c.endswith('店') and len(c) > 2 else c
            if len(c) >= 2:
                out.add(c)
                break
    return out


def short_core(name):
    """支店表記・業態語・地名を除いた中核名が 2 文字未満か（括弧外）"""
    n = BRACKETS.sub(' ', norm(name)).strip()
    b = branch_of(name)
    if b and n.endswith(b):
        n = n[:len(n) - len(b)]
    c = PUNCT.sub('', _strip(_strip(n, GENERIC_WORDS), AREA_WORDS))
    c = c[:-1] if c.endswith('店') else c
    return len(c) < 2


def is_latin(s):
    return bool(s) and all(ch.isascii() for ch in s)


def bigrams(s):
    return {s[i:i + 2] for i in range(len(s) - 1)}


def haversine_km(a, b):
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 6371 * 2 * math.asin(math.sqrt(h))


KANJI_ONLY = re.compile(r'[\u4e00-\u9fff々]{1,4}')
KANA_RUN = re.compile(r'[\u3041-\u3096ー]+')


def reading_variant_possible(a, b):
    """
    M4 R3: 中核名 a と b が「漢字の部分」と「かなの部分」の表記違いでありうるか（読みは判定しない）。
    共通の文字を除いた a の残りが漢字だけ（1〜4 字）で、b の残りにその字数〜3 倍＋1 の長さのかなの並びがある場合 True。
    例: 綱八 ⇔ つな八、美濃吉 ⇔ みのきち、塚田 ⇔ つかだ
    """
    com = set(a) & set(b)
    ra = ''.join(ch for ch in a if ch not in com)
    rb = ''.join(ch for ch in b if ch not in com)
    if not ra or not KANJI_ONLY.fullmatch(ra):
        return False
    return any(len(ra) <= len(m.group()) <= 3 * len(ra) + 1 for m in KANA_RUN.finditer(rb))


QUOTED = re.compile(r'[『「]([^』」]+)[』」]')


def quoted_name_cores(name):
    """M4 R4: 『』「」内の固有店名の中核名（2 文字以上のもの）。括弧が無ければ空集合"""
    out = set()
    for m in QUOTED.findall(norm(name)):
        c = PUNCT.sub('', m)
        if len(c) >= 2:
            out.add(c)
    return out


def judge(rec_name, cand, prefecture, area_center=None, max_km=3.0, allowed_municipalities=None):
    """
    cand: {'name','address','types'(任意),'business_status'(任意),'lat','lng'(任意)}
    returns (SAME|AMBIGUOUS|DIFFERENT, reason)
    """
    st = cand.get('business_status')
    if st and st != 'OPERATIONAL':
        return DIFFERENT, 'closed'
    types = set(cand.get('types') or [])
    if types and (not (types & FOOD_TYPES) or (types & NON_STORE_TYPES and not types & {'restaurant'})):
        return DIFFERENT, 'not_a_store'
    addr = unicodedata.normalize('NFKC', cand.get('address') or '')
    if prefecture and prefecture not in addr:
        return DIFFERENT, 'prefecture_mismatch'
    if area_center and cand.get('lat') is not None and cand.get('lng') is not None:
        if haversine_km(area_center, (cand['lat'], cand['lng'])) > max_km:
            return DIFFERENT, 'area_mismatch'
    elif allowed_municipalities is not None and not any(m in addr for m in allowed_municipalities):
        return DIFFERENT, 'area_mismatch'
    rv, cv = core_variants(rec_name), core_variants(cand.get('name'))
    if not rv or not cv:
        return AMBIGUOUS, 'name_empty_after_normalize'
    if rv & cv:
        inner = quoted_name_cores(rec_name)
        if inner and not inner & core_variants(cand.get('name')):
            return AMBIGUOUS, 'quoted_name_mismatch'   # M4 R4: 『』内の固有店名が一致しない（括弧外の一般語だけの一致）
        rb, cb = branch_of(rec_name), branch_of(cand.get('name'))
        if rb and cb and PUNCT.sub('', rb).rstrip('店') != PUNCT.sub('', cb).rstrip('店') \
                and not (rb in MAIN and cb in MAIN):
            return AMBIGUOUS, 'branch_conflict'
        if cb in ANNEX and rb != cb:
            return AMBIGUOUS, 'annex'          # 別館・本館は推薦店と別の店舗でありうる
        return SAME, 'core_name_equal'
    if any(is_latin(a) != is_latin(b) for a in rv for b in cv) and \
            not any(is_latin(a) == is_latin(b) for a in rv for b in cv):
        return AMBIGUOUS, 'script_differs'     # 英字とかな・漢字は機械的に比較できない
    if short_core(rec_name) or short_core(cand.get('name')):
        return AMBIGUOUS, 'short_core'         # 中核名が 1 文字（例: 響・雷・凡）は名前だけで別店舗と断定しない
    if any(reading_variant_possible(a, b) or reading_variant_possible(b, a) for a in rv for b in cv):
        return AMBIGUOUS, 'kana_kanji'         # M4 R3: 漢字とかなの読み違いの可能性。同一店とは確定せず選択 LLM で確認
    if not any(bigrams(a) & bigrams(b) for a in rv for b in cv):
        return DIFFERENT, 'name_unrelated'
    return AMBIGUOUS, 'name_partial'


# ------------------------------------------------------------------ M4 R2: 支店の明確な矛盾
def _branch_core(b):
    b = PUNCT.sub('', b or '')
    return b[:-1] if b.endswith('店') else b


def _implicit_branch(name, other):
    """
    支店表記が語として分かれていない店名（例: 松葉地下店）から、相手の中核名（屋号）に続く「〇〇店」を取り出す。
    屋号が見つからない・「店」で終わらない場合は None
    """
    n = PUNCT.sub('', BRACKETS.sub('', norm(name)))
    if not n.endswith('店'):
        return None
    for core in sorted(core_variants(other), key=len, reverse=True):
        i = n.find(core)
        if i >= 0 and len(n) - (i + len(core)) >= 2:
            return n[i + len(core):]
    return None


def branch_conflict_clear(rec_name, cand_name):
    """
    推薦名と候補の支店名が明確に矛盾するか（選択 LLM の採用結果の検査に使う）。
    次をすべて満たす場合だけ True:
      - 両方に支店名がある（語として分かれていない場合は屋号に続く「〇〇店」）
      - どちらも 本店・総本店・別館・本館 ではない（本店は地名で呼ばれることがあり、通称と区別できない）
      - 支店名どうしに共通する 2 文字の並びが無く、どちらも他方を含まない（例: ルクア大阪店 と ルクアイーレ店 は矛盾としない）
    """
    rb = branch_of(rec_name) or _implicit_branch(rec_name, cand_name)
    cb = branch_of(cand_name) or _implicit_branch(cand_name, rec_name)
    if not rb or not cb or rb in MAIN + ANNEX or cb in MAIN + ANNEX:
        return False
    a, b = _branch_core(rb), _branch_core(cb)
    if not a or not b or a in b or b in a:
        return False
    return not (bigrams(a) & bigrams(b))
