#!/usr/bin/env bash
# =====================================================================
# 本番（travel-sp-base）の S10 設定確認（Cloud Shell・読み取りのみ）
#
#   bash ~/m4_verify_production.sh
#
# - 何も変更しない。環境変数の値は NEW_SHOP_FLOW・GIT_SHA 以外は表示もファイル保存もしない（名前だけ）
# =====================================================================
set -euo pipefail
PROJECT_ID="ai-avator-492205"
REGION="us-central1"
SERVICE="travel-sp-base"
GC=(--project="${PROJECT_ID}" --region="${REGION}")
LIVE="$(gcloud run services describe "${SERVICE}" "${GC[@]}" --format="json(status.traffic,status.url)" | python3 -c "
import json, sys
s = json.load(sys.stdin)
live = [t for t in s['status']['traffic'] if t.get('percent')]
print('本番トラフィック:', [(t.get('revisionName'), t.get('percent')) for t in live], file=sys.stderr)
print((live[0].get('revisionName') if len(live) == 1 and live[0].get('percent') == 100 else '') + ' ' + s['status']['url'])")"
REV="${LIVE%% *}"; URL="${LIVE##* }"
[ -n "${REV}" ] || { echo "NG: 本番トラフィックが 1 つのリビジョンに 100% ではありません" >&2; exit 1; }
gcloud run revisions describe "${REV}" "${GC[@]}" --format="json(spec.containers[0].env,spec.containers[0].image)" | python3 -c "
import json, sys
c = json.load(sys.stdin)['spec']['containers'][0]
env = c.get('env') or []
ok = True
show = {e['name']: e.get('value') for e in env if e['name'] in ('NEW_SHOP_FLOW', 'GIT_SHA')}
refs = {e['name']: (e.get('valueFrom') or {}).get('secretKeyRef') or {} for e in env}
print('リビジョン:', '${REV}', '／イメージのタグ・digest:', c['image'].split('/')[-1])
print('NEW_SHOP_FLOW:', show.get('NEW_SHOP_FLOW'), '／GIT_SHA:', show.get('GIT_SHA'))
if show.get('NEW_SHOP_FLOW') != 'S10':
    print('NG: NEW_SHOP_FLOW が S10 ではありません'); ok = False
for n, sec in (('GEMINI_RECOMMEND_API_KEY', 'new-shop-recommend-key'), ('MAPS_AGENT_TOOLS_API_KEY', 'new-shop-maps-key')):
    r = refs.get(n) or {}
    print(f'{n}: Secret {r.get(\"name\")}:{r.get(\"key\")}')
    if r.get('name') != sec:
        print(f'NG: {n} が Secret {sec} の参照ではありません'); ok = False
if 'M4_BENCH_TOKEN' in refs:
    print('NG: 計測トークンが設定されています'); ok = False
print('環境変数の名前:', sorted(e['name'] for e in env))
sys.exit(0 if ok else 1)"
h="$(curl -s -o /dev/null -w '%{http_code}' "${URL}/health")"
b="$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{"query":"x","method":"scope"}' "${URL}/api/m4/bench")"
echo "${URL}/health → ${h}（200 なら正常）／計測エンドポイント → ${b}（404 なら無効）"
[ "${h}" = "200" ] && [ "${b}" = "404" ] || { echo "NG" >&2; exit 1; }
echo "完了: 本番 ${REV} は S10 設定"
