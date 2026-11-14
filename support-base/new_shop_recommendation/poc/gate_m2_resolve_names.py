# -*- coding: utf-8 -*-
"""
Gate M2 — Maps Experience Agent Tools resolveNames の実データ計測（計測専用。製品コードは変更しない）

  python -m new_shop_recommendation.poc.gate_m2_resolve_names

入力: Gate D1.7E の照合済み 132 件（m2_labeled_pairs.tsv）から、推薦店（クエリ × 推薦店名）を重複なしで取り出す。
      queries[].text = 「推薦店名 推薦エリア 都道府県」（取得済みの Places 店名は入力に使わない）
設定: regionCode=JP。locationBias（検索エリア中心 ±約 3km の viewport）あり／なしの 2 通りを比較。
      バッチ（同じクエリの推薦店をまとめて最大 20 件）と 1 件単独の両方で時間を測る。
評価: 返った place をすべて Place Details で店名・住所・営業状態を取得し、既存の独立判定（O/X/?）と照合する。
      ラベルの無い店舗は正解扱いせず「未ラベル」として別枠で全件表示する。
公式仕様: POST https://mapstools.googleapis.com/v1:resolveNames（X-Goog-Api-Key）
      results は queries と 1:1（失敗した位置は entity なし）、failedRequests は {index: Status}
"""
import argparse
import os
import statistics
import sys
import time

import requests

from new_shop_recommendation import legacy_places
from new_shop_recommendation.redact import contains_secret, redact, register_secret

RESOLVE_URL = 'https://mapstools.googleapis.com/v1:resolveNames'
DETAILS_URL = 'https://maps.googleapis.com/maps/api/place/details/json'
MAX_BATCH = 20
HERE = os.path.dirname(os.path.abspath(__file__))
QUERY_LABELS = ['横浜 焼き鳥', '銀座 天ぷら', '渋谷 カフェ', '新宿 和食', '吉祥寺 イタリアン', '東京駅 ラーメン',
                '中目黒 焼き鳥', 'すすきの ジンギスカン', '祇園 割烹', '梅田 串カツ']
REGION = ['神奈川県', '東京都', '東京都', '東京都', '東京都', '東京都', '東京都', '北海道', '京都府', '大阪府']
BIAS_AREA = ['横浜', '銀座', '渋谷', '新宿', '吉祥寺', '東京駅', '中目黒', 'すすきの', '祇園', '梅田']
VIEWPORT_DLAT, VIEWPORT_DLNG = 0.03, 0.037      # 中心から約 ±3.3km
OUT = []


def say(s=''):
    s = redact(s)
    OUT.append(s)
    print(s, flush=True)


# ------------------------------------------------------------------ 入力（照合済みデータ）
def load_groups(path=os.path.join(HERE, 'm2_labeled_pairs.tsv')):
    groups, order = {}, []
    with open(path, encoding='utf-8') as f:
        for line in f:
            line = line.rstrip('\n')
            if not line or line.startswith('#'):
                continue
            rid, qidx, trials, rec, hint, card, by, verdict = line.split('\t')
            key = (int(qidx), rec)
            if key not in groups:
                groups[key] = {'qidx': int(qidx), 'rec': rec, 'hint': hint, 'trials': set(), 'labels': {}, 'by': {},
                               'rids': []}
                order.append(key)
            g = groups[key]
            g['trials'].update(int(t) for t in trials.split(','))
            g['labels'][card] = verdict
            g['by'][card] = by
            g['rids'].append(rid)
    return [groups[k] for k in order]


def query_text(g):
    return f'{g["rec"]} {g["hint"]} {REGION[g["qidx"]]}'


def has_known_store(g):
    return any(v == 'O' for v in g['labels'].values())


# ------------------------------------------------------------------ resolveNames
def viewport(geo):
    if not geo or not geo.get('lat') or not geo.get('lng'):
        return None
    lat, lng = geo['lat'], geo['lng']
    return {'low': {'latitude': lat - VIEWPORT_DLAT, 'longitude': lng - VIEWPORT_DLNG},
            'high': {'latitude': lat + VIEWPORT_DLAT, 'longitude': lng + VIEWPORT_DLNG}}


def build_body(texts, vp=None):
    if not 1 <= len(texts) <= MAX_BATCH:
        raise ValueError('queries は 1〜20 件')
    body = {'queries': [{'text': t} for t in texts], 'regionCode': 'JP'}
    if vp:
        body['locationBias'] = {'viewport': vp}
    return body


def parse_response(data, n):
    """queries と同じ位置の [{'place_id','confidence','status','error'}] を返す"""
    results = data.get('results') or []
    failed = {int(k): v for k, v in (data.get('failedRequests') or {}).items()}
    out = []
    for i in range(n):
        res = results[i] if i < len(results) and isinstance(results[i], dict) else {}
        place = ((res.get('entity') or {}).get('place') or '')
        if i in failed:
            st = failed[i] or {}
            code = st.get('code')
            out.append({'place_id': None, 'confidence': None,
                        'status': 'NOT_FOUND' if code == 5 else f'FAILED_{code}',
                        'error': str(st.get('message'))[:120]})
        elif place:
            out.append({'place_id': place.split('/')[-1], 'confidence': res.get('confidence') or 'CONFIDENCE_UNSPECIFIED',
                        'status': 'OK', 'error': None})
        else:
            out.append({'place_id': None, 'confidence': None, 'status': 'NO_ENTITY', 'error': None})
    return out


def resolve(api_key, texts, vp=None, post=None, now=time.monotonic):
    post = post or requests.post
    t0 = now()
    try:
        r = post(RESOLVE_URL, json=build_body(texts, vp),
                 headers={'Content-Type': 'application/json', 'X-Goog-Api-Key': api_key}, timeout=15)
    except requests.exceptions.RequestException as e:
        ms = int((now() - t0) * 1000)
        return [{'place_id': None, 'confidence': None, 'status': f'ERROR_{type(e).__name__}', 'error': None}
                for _ in texts], ms, None
    ms = int((now() - t0) * 1000)
    if r.status_code != 200:
        err = redact((r.text or '')[:160])
        return [{'place_id': None, 'confidence': None, 'status': f'HTTP_{r.status_code}', 'error': err}
                for _ in texts], ms, r.status_code
    return parse_response(r.json(), len(texts)), ms, 200


# ------------------------------------------------------------------ Place Details（照合用）
_DET_CACHE = {}


def details(place_id, get=None):
    if place_id in _DET_CACHE:
        return _DET_CACHE[place_id]
    get = get or legacy_places.legacy.requests.get
    try:
        data = get(DETAILS_URL, params={'place_id': place_id, 'language': 'ja',
                                        'fields': 'name,formatted_address,business_status,types',
                                        'key': legacy_places.legacy.GOOGLE_PLACES_API_KEY}, timeout=10).json()
        res = (data.get('result') or {}) if data.get('status') == 'OK' else {}
        d = {'name': res.get('name'), 'address': res.get('formatted_address') or '',
             'business_status': res.get('business_status') or '', 'types': res.get('types') or [],
             'status': data.get('status')}
    except Exception as e:
        d = {'name': None, 'address': '', 'business_status': '', 'types': [], 'status': f'ERROR_{type(e).__name__}'}
    _DET_CACHE[place_id] = d
    return d


def judge(g, name):
    """返った店舗名を既存の独立判定と照合: O / X / ?（判定不能ラベル）/ unlabeled（未ラベル）"""
    if name is None:
        return 'unlabeled'
    return g['labels'].get(name, 'unlabeled')


# ------------------------------------------------------------------ 評価
def evaluate(groups, res):
    """res: [{'place_id','confidence','status',...}]（groups と同じ順）→ 集計 dict"""
    ev = {'n': len(groups), 'conf': {}, 'by_conf': {}, 'cases': []}
    for g, r in zip(groups, res):
        conf = r['confidence'] if r['status'] == 'OK' else r['status']
        ev['conf'][conf] = ev['conf'].get(conf, 0) + 1
        d = details(r['place_id']) if r['place_id'] else None
        v = judge(g, d['name']) if d else None
        if r['status'] == 'OK':
            ev['by_conf'].setdefault(conf, {}).setdefault(v, 0)
            ev['by_conf'][conf][v] += 1
        ev['cases'].append({'g': g, 'r': r, 'd': d, 'v': v})
    known = [x for x in ev['cases'] if has_known_store(x['g'])]
    high = [x for x in ev['cases'] if x['r']['status'] == 'OK' and x['r']['confidence'] == 'HIGH']
    ev['known'] = len(known)
    ev['high_correct'] = sum(1 for x in high if x['v'] == 'O')
    ev['high_wrong'] = sum(1 for x in high if x['v'] == 'X')
    ev['high_unknown'] = sum(1 for x in high if x['v'] in ('?', 'unlabeled'))
    ev['high_recall'] = ev['high_correct'] / len(known) if known else 0
    ev['missed_known'] = sum(1 for x in known if x['r']['status'] != 'OK')
    return ev


def d_baseline(groups):
    """方式 D（Gate D1.7E）の同じ母数（推薦店単位）での成績: 採用した店舗の O/X/?"""
    o = x = q = 0
    for g in groups:
        vs = {g['labels'][card] for card, by in g['by'].items() if 'D' in by}
        if 'X' in vs:
            x += 1
        elif 'O' in vs:
            o += 1
        elif '?' in vs:
            q += 1
    known = sum(1 for g in groups if has_known_store(g))
    return {'adopt_o': o, 'adopt_x': x, 'adopt_q': q, 'known': known}


def stats(v):
    v = sorted(x for x in v if x is not None)
    if not v:
        return '—'
    p95 = v[min(len(v) - 1, int(round(0.95 * (len(v) - 1))))]
    return f'p50 {statistics.median(v):.0f} / p95 {p95:.0f} / 最大 {v[-1]:.0f} ms（n={len(v)}）'


def rate(a, b):
    return f'{a}/{b}（{100.0 * a / b:.1f}%）' if b else f'{a}/0'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--batch-repeat', type=int, default=3)
    args = ap.parse_args()
    key = os.environ.get('MAPS_AGENT_TOOLS_API_KEY', '')
    if not key:
        sys.exit('MAPS_AGENT_TOOLS_API_KEY が必要です')
    register_secret(key)
    register_secret(os.environ.get('GOOGLE_PLACES_API_KEY', ''))
    groups = load_groups()
    say(f'git_sha={os.environ.get("GIT_SHA", "unknown")}  POST {RESOLVE_URL}  regionCode=JP  入力 {len(groups)} 推薦店'
        f'（照合済み {sum(len(g["rids"]) for g in groups)} ペア、正しい実店舗が判明している推薦店 '
        f'{sum(1 for g in groups if has_known_store(g))}）')
    say('queries[].text = 推薦店名 + 推薦エリア + 都道府県（取得済みの Places 店名は使わない）')

    vps = {}
    for i, area in enumerate(BIAS_AREA):
        vps[i] = viewport(legacy_places.region_info(area, 'ja'))
    say('locationBias viewport（中心 ±緯度0.03°・経度0.037°）: ' +
        ', '.join(f'{BIAS_AREA[i]}={"OK" if vps[i] else "取得不可"}' for i in vps))

    by_q = {}
    for idx, g in enumerate(groups):
        by_q.setdefault(g['qidx'], []).append(idx)
    calls = {'batch': 0, 'single': 0}
    results, timings = {}, {}
    for mode in ('regionCode_only', 'locationBias'):
        res = [None] * len(groups)
        bt, st = [], []
        for rep in range(args.batch_repeat):
            for q, idxs in sorted(by_q.items()):
                for s in range(0, len(idxs), MAX_BATCH):
                    part = idxs[s:s + MAX_BATCH]
                    out, ms, _ = resolve(key, [query_text(groups[i]) for i in part],
                                         vps[q] if mode == 'locationBias' else None)
                    calls['batch'] += 1
                    bt.append((ms, len(part)))
                    if rep == 0:
                        for i, o in zip(part, out):
                            res[i] = o
                time.sleep(0.2)
        single, agree = [None] * len(groups), 0
        for i, g in enumerate(groups):
            out, ms, _ = resolve(key, [query_text(g)], vps[g['qidx']] if mode == 'locationBias' else None)
            calls['single'] += 1
            st.append(ms)
            single[i] = out[0]
            agree += (out[0]['place_id'], out[0]['confidence']) == (res[i]['place_id'], res[i]['confidence'])
            time.sleep(0.15)
        results[mode] = res
        timings[mode] = {'batch': bt, 'single': st, 'agree': agree}

    d0 = d_baseline(groups)
    for mode in ('regionCode_only', 'locationBias'):
        report_mode(mode, groups, results[mode], timings[mode], d0)
    report_compare(groups, results)
    report_trials(groups, results)
    say(f'\n【API 呼び出し】resolveNames バッチ {calls["batch"]} 回・単独 {calls["single"]} 回（$0: Text Search Essentials IDs Only）'
        f' / Place Details {len(_DET_CACHE)} 件（重複なし、place_id ごとに 1 回）')
    say(f'\n出力への API キー残存: {"あり（要確認）" if contains_secret(chr(10).join(OUT)) else "なし"}')


def report_mode(mode, groups, res, tm, d0):
    ev = evaluate(groups, res)
    say(f'\n================ M2 [{mode}] ================')
    say(f'  確信度・状態の内訳: {ev["conf"]}')
    say('  | 区分 | O 正しい店舗 | X 別店舗 | ? 判定不能ラベル | 未ラベル |')
    say('  |---|---:|---:|---:|---:|')
    for conf in ('HIGH', 'MEDIUM', 'CONFIDENCE_UNSPECIFIED'):
        b = ev['by_conf'].get(conf, {})
        if b or conf != 'CONFIDENCE_UNSPECIFIED':
            say(f'  | {conf} | {b.get("O", 0)} | {b.get("X", 0)} | {b.get("?", 0)} | {b.get("unlabeled", 0)} |')
    hj = ev['high_correct'] + ev['high_wrong']
    say(f'  HIGH の誤店舗率（判定可能分）: {rate(ev["high_wrong"], hj)}  ※未ラベル・? は別枠 {ev["high_unknown"]} 件')
    say(f'  HIGH の誤店舗率（未ラベル・? を誤りとみなした最悪値）: '
        f'{rate(ev["high_wrong"] + ev["high_unknown"], hj + ev["high_unknown"])}')
    say(f'  HIGH だけで正しい店舗を回収: {rate(ev["high_correct"], ev["known"])}（正しい実店舗が判明している推薦店が母数）')
    say(f'  実在が判明している推薦店で place を返さなかった（NOT_FOUND 等）: {rate(ev["missed_known"], ev["known"])}')
    dj = d0['adopt_o'] + d0['adopt_x']
    say(f'  [比較] 方式 D（D1.7E、同じ推薦店単位）: 誤店舗率 {rate(d0["adopt_x"], dj)}（? {d0["adopt_q"]} 件は別枠） / '
        f'正しい店舗の回収 {rate(d0["adopt_o"], d0["known"])}')
    bt = tm['batch']
    say(f'  時間: 1 件単独 {stats(tm["single"])} / バッチ {stats([m for m, _ in bt])}'
        f'（1 バッチ平均 {statistics.mean(k for _, k in bt):.1f} 件） / 単独とバッチの結果一致 {tm["agree"]}/{len(groups)}')
    say('  ── HIGH で別店舗（全件）')
    for x in ev['cases']:
        if x['r']['status'] == 'OK' and x['r']['confidence'] == 'HIGH' and x['v'] == 'X':
            say('   ' + case_line(x))
    say('  ── HIGH で未ラベル・判定不能（全件。正解扱いしない）')
    for x in ev['cases']:
        if x['r']['status'] == 'OK' and x['r']['confidence'] == 'HIGH' and x['v'] in ('?', 'unlabeled'):
            say('   ' + case_line(x))
    say('  ── MEDIUM（全件）')
    for x in ev['cases']:
        if x['r']['status'] == 'OK' and x['r']['confidence'] == 'MEDIUM':
            say('   ' + case_line(x))
    say('  ── 実在が判明しているのに place を返さなかった推薦店（全件）')
    for x in ev['cases']:
        if has_known_store(x['g']) and x['r']['status'] != 'OK':
            ok = [k for k, v in x['g']['labels'].items() if v == 'O']
            say(f'   推薦「{x["g"]["rec"]}」（{x["g"]["hint"]}） → {x["r"]["status"]}  正しい店舗={ok}')


def case_line(x):
    g, d, r = x['g'], x['d'] or {}, x['r']
    pref = REGION[g['qidx']]
    flag = '' if pref in (d.get('address') or '') else f' ★都道府県不一致（期待 {pref}）'
    closed = '' if d.get('business_status') in ('', 'OPERATIONAL') else f' ★{d.get("business_status")}'
    ok = [k for k, v in g['labels'].items() if v == 'O']
    return (f'[{QUERY_LABELS[g["qidx"]]}] 推薦「{g["rec"]}」（{g["hint"]}） → 「{d.get("name")}」 '
            f'{(d.get("address") or "")[:60]} 判定={x["v"]}{flag}{closed}  正しい店舗={ok or "不明"}')


def report_compare(groups, results):
    a, b = results['regionCode_only'], results['locationBias']
    same = sum(1 for x, y in zip(a, b) if (x['place_id'], x['confidence']) == (y['place_id'], y['confidence']))
    say(f'\n【locationBias あり／なしの差】結果が同じ推薦店 {same}/{len(groups)}')
    for g, x, y in zip(groups, a, b):
        if (x['place_id'], x['confidence']) != (y['place_id'], y['confidence']):
            dx = details(x['place_id'])['name'] if x['place_id'] else x['status']
            dy = details(y['place_id'])['name'] if y['place_id'] else y['status']
            say(f'   推薦「{g["rec"]}」 なし: {x["confidence"] or ""}「{dx}」({judge(g, dx) if x["place_id"] else "-"}) '
                f'/ あり: {y["confidence"] or ""}「{dy}」({judge(g, dy) if y["place_id"] else "-"})')


def report_trials(groups, results):
    """各試行に出てきた推薦店のうち、HIGH で正しい店舗に解決できた数（推定。ラベルのある推薦店のみ）"""
    say('\n【試行ごとの見込み（D1.7E の 30 試行に登場した推薦店のうち、HIGH で正しい店舗に解決できた数）】')
    for mode in ('regionCode_only', 'locationBias'):
        ok = {}
        for g, r in zip(groups, results[mode]):
            good = r['status'] == 'OK' and r['confidence'] == 'HIGH' and judge(g, details(r['place_id'])['name']) == 'O'
            for t in g['trials']:
                ok.setdefault(t, 0)
                ok[t] += 1 if good else 0
        dist = {}
        for t in range(1, 31):
            k = min(ok.get(t, 0), 5)
            dist[k] = dist.get(k, 0) + 1
        say(f'  [{mode}] 5 店舗以上: {sum(1 for t in range(1, 31) if ok.get(t, 0) >= 5)}/30 試行  分布（件数→試行数）: '
            f'{dict(sorted(dist.items()))}')
    say('  ※ 照合リストに無い推薦店（どの方式もカードにしなかった店）は数えていないため、実際の値は上下しうる')


if __name__ == '__main__':
    main()
