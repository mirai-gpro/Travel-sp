#!/usr/bin/env bash
# =====================================================================
# speed-clean A/B 計測（読み取りのみ）。実機試験の後に Cloud Shell で実行:
#
#   bash measure_speedclean.sh            # 直近 180 分
#   bash measure_speedclean.sh 60         # 直近 60 分
#
# Cloud Logging から 33秒版（travel-sp-base-00060-car）と検証版（travel-sp-base-sc-7655ca0）の
# ショップ検索ログを読み、検索1回ごとに outcome / Gemini秒 / Places秒 / 初回カード秒 / 件数 / 採用店名 を出す。
# - 33秒版は既存ログの時刻差から算出（計測コードは入っていないため）
# - 検証版は [ShopTiming] summary の値を使う
# - outcome が success 以外（upstream_error / timeout / error / no_result）の回は「正常終了の統計」から除外
# 注意: 00060-car は本番なので、同じ時間帯の他の利用者の検索も含まれ得る。依頼文と時刻で自分の試験を特定すること。
# =====================================================================
set -euo pipefail
PROJECT_ID="ai-avator-492205"
SERVICE="travel-sp-base"
REV_A="travel-sp-base-00060-car"
REV_NEW="travel-sp-base-sc-7655ca0"
MINUTES="${1:-180}"

WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT
SINCE="$(date -u -d "-${MINUTES} min" +%Y-%m-%dT%H:%M:%SZ)"

FILTER="resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${SERVICE}\" AND (resource.labels.revision_name=\"${REV_A}\" OR resource.labels.revision_name=\"${REV_NEW}\") AND timestamp>=\"${SINCE}\" AND (textPayload:\"[ShopSearch]\" OR textPayload:\"search_shops\" OR textPayload:\"[Enrich]\" OR textPayload:\"[ShopTiming]\")"
gcloud logging read "${FILTER}" --project="${PROJECT_ID}" --order=asc --limit=50000 --format=json > "${WORK}/logs.json"

python3 - "${WORK}/logs.json" "${REV_A}" "${REV_NEW}" <<'PYEOF'
import json, re, sys
from datetime import datetime
from statistics import median

logs, REV_A, REV_NEW = json.load(open(sys.argv[1])), sys.argv[2], sys.argv[3]

def ts(e):
    t = e.get('timestamp', '')
    t = re.sub(r'(\.\d{6})\d*', r'\1', t).replace('Z', '+00:00')
    return datetime.fromisoformat(t)

searches = []
cur = {}   # (revision, instance) -> 進行中の検索

for e in logs:
    msg = e.get('textPayload', '') or ''
    rev = e.get('resource', {}).get('labels', {}).get('revision_name', '')
    inst = (e.get('labels') or {}).get('instanceId', '')
    key = (rev, inst)
    t = ts(e)
    m = re.search(r"search_shops呼び出し: '(.*)'", msg)
    if m:
        s = {'rev': 'A(33秒版)' if rev == REV_A else '新版', 'req': m.group(1), 't0': t, 'adopted': [],
             'outcome': None, 'last_name': None}
        cur[key] = s
        searches.append(s)
        continue
    s = cur.get(key)
    if not s:
        continue
    if '案C: 検索専用プロンプトで直接API呼び出し' in msg:
        s['t_gem0'] = t
    elif '案C: Gemini応答' in msg:
        s['t_gem1'] = t
        s.setdefault('gem_status', 'ok')
    elif '案C: エラー' in msg:
        s.setdefault('t_gem1', t)
        if 't_gem1' in s and s.get('gem_status') == 'ok':
            s['outcome'] = 'error'
        elif '503' in msg or 'UNAVAILABLE' in msg:
            s['gem_status'] = 'http_503'; s['outcome'] = 'upstream_error'
        elif '504' in msg or 'DEADLINE' in msg:
            s['gem_status'] = 'http_504'; s['outcome'] = 'upstream_error'
        elif 'timeout' in msg.lower():
            s['gem_status'] = 'timeout'; s['outcome'] = 'timeout'
        else:
            s['gem_status'] = 'error'; s['outcome'] = 'error'
    elif re.search(r"\[Enrich\] [^:]*: area='", msg):
        s['t_enrich0'] = t
    elif '[Enrich] → 検索結果:' in msg:
        mm = re.search(r"検索結果: '(.*)'", msg)
        s['last_name'] = mm.group(1) if mm else '?'
    elif '[Enrich] → ✅' in msg:
        s['adopted'].append(s.get('last_name') or '?')
    elif 'ショップ見つからず' in msg:
        s['t_card'] = t
        if not s['outcome']:
            s['outcome'] = 'no_result' if s.get('gem_status') == 'ok' else 'error'
        s['n'] = 0
    elif re.search(r'\[ShopSearch\] (\d+)件のショップをブラウザに送信', msg):
        s['t_card'] = t
        s['n'] = int(re.search(r'(\d+)件のショップ', msg).group(1))
        s['outcome'] = s['outcome'] or 'success'
    elif '[ShopTiming]' in msg and ' summary ' in msg:
        kv = dict(re.findall(r'(\w+)=(\S+)', msg))
        s['summary'] = kv
        s['outcome'] = kv.get('outcome')
        s['gem_status'] = kv.get('gemini_status')
    elif '[ShopTiming]' in msg and 'stage=links_done' in msg:
        mm = re.search(r' t=([\d.]+)', msg)
        s['links_t'] = mm.group(1) if mm else '-'

def sec(a, b):
    return round((b - a).total_seconds(), 1) if a and b else None

def fmt(v):
    return '—' if v is None or v == '-' else (f'{float(v):.1f}' if isinstance(v, (int, float, str)) and str(v).replace('.', '', 1).isdigit() else str(v))

rows = []
for s in searches:
    if 'summary' in s:
        kv = s['summary']
        gem, places, card = kv.get('gemini_sec'), kv.get('enrich_sec'), kv.get('first_card_sec')
        area = kv.get('area_wait_after_gemini_sec')
        n = kv.get('shops')
    else:
        gem = sec(s.get('t_gem0'), s.get('t_gem1'))
        area = sec(s.get('t_gem1'), s.get('t_enrich0'))
        places = sec(s.get('t_enrich0'), s.get('t_card')) if s.get('outcome') == 'success' else None
        card = sec(s['t0'], s.get('t_card'))
        n = s.get('n')
    rows.append({'time': s['t0'].strftime('%H:%M:%S'), 'rev': s['rev'], 'req': s['req'],
                 'outcome': s.get('outcome') or '未完了', 'gem_status': s.get('gem_status') or '—',
                 'gem': gem, 'area': area, 'places': places, 'card': card, 'n': n,
                 'links': s.get('links_t'), 'adopted': s['adopted']})

print('| 時刻(UTC) | 依頼 | 版 | outcome | Gemini | Gemini秒 | エリア待ち秒 | Places秒 | 初回カード秒 | リンク完了秒 | 表示件数 | 採用店（Places名・順） |')
print('|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---|')
for r in rows:
    print(f"| {r['time']} | {r['req']} | {r['rev']} | {r['outcome']} | {r['gem_status']} | {fmt(r['gem'])} | {fmt(r['area'])} | "
          f"{fmt(r['places'])} | {fmt(r['card'])} | {fmt(r['links'])} | {'—' if r['n'] is None else int(r['n'])} | {' / '.join(r['adopted']) or '—'} |")

print('\n正常終了（outcome=success）のみの中央値:')
for rev in ('A(33秒版)', '新版'):
    ok = [r for r in rows if r['rev'] == rev and r['outcome'] == 'success']
    def med(k):
        v = [float(r[k]) for r in ok if r[k] not in (None, '-')]
        return f'{median(v):.1f}' if v else '—'
    print(f"  {rev}: 回数={len(ok)} Gemini秒={med('gem')} Places秒={med('places')} 初回カード秒={med('card')}")
bad = [r for r in rows if r['outcome'] != 'success']
print(f"\n統計から除外した回: {len(bad)}（" + ', '.join(f"{r['time']} {r['rev']} {r['outcome']}" for r in bad) + '）' if bad else '\n統計から除外した回: 0')
print('注: 33秒版の Places秒 は enrich 開始→カード送信（Geocoding・Places・Hot Pepper を直列で含む）。'
      '新版の Places秒 は enrich 開始→確定（Geocoding＋Places 並列。Hot Pepper/TripAdvisor はカード後）。')
PYEOF
