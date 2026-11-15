#!/usr/bin/env bash
# =====================================================================
# 本番トラフィックを「最新のリビジョンに追従」へ切り替える（Cloud Shell）。以後は main の CI のデプロイがそのまま本番になる
#
#   bash ~/m4_follow_latest.sh
#
# - 切り替え先は「最新の準備済みリビジョン」。それが main の最新コミットを CI がデプロイしたもの
#   （GIT_SHA が一致）で、S10 の設定・本番用 Secret・計測トークンなしであることを確かめてから切り替える
# - 切り替え前に一時タグで /health と計測エンドポイント（無効）を確かめ、タグは外す
# - 環境変数の値は NEW_SHOP_FLOW・GIT_SHA 以外読まない（名前と Secret 参照だけ）
# - 戻す: bash ~/m4_rollback_production.sh <リビジョン名>（このスクリプトが最後に表示する）
# =====================================================================
set -euo pipefail
PROJECT_ID="ai-avator-492205"
REGION="us-central1"
SERVICE="travel-sp-base"
TMP_TAG="cicheck"
GC=(--project="${PROJECT_ID}" --region="${REGION}")
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

echo "[1/4] 事前確認（読み取りのみ）"
MAIN_SHA="$(GIT_TERMINAL_PROMPT=0 git ls-remote https://github.com/mirai-gpro/Travel-sp.git refs/heads/main | cut -f1)"
[ -n "${MAIN_SHA}" ] || { echo "停止: GitHub から main の最新コミットを取得できません" >&2; exit 1; }
gcloud run services describe "${SERVICE}" "${GC[@]}" \
  --format='json(status.traffic,status.latestReadyRevisionName,status.latestCreatedRevisionName)' > "${WORK}/svc.json"
python3 - "${WORK}/svc.json" "${WORK}" <<'PYEOF'
import json, sys
s, work = json.load(open(sys.argv[1]))['status'], sys.argv[2]
live = [t for t in s['traffic'] if t.get('percent')]
if len(live) != 1 or live[0].get('percent') != 100:
    sys.exit('停止: 本番トラフィックが 1 つのリビジョンに 100% ではありません')
if live[0].get('latestRevision'):
    sys.exit('停止: すでに最新のリビジョンに追従しています（何も変更しません）')
ready, created = s.get('latestReadyRevisionName'), s.get('latestCreatedRevisionName')
if not ready or ready != created:
    sys.exit(f'停止: 最新のリビジョンが準備中か失敗しています（作成 {created}／準備済み {ready}）')
open(f'{work}/prev', 'w').write(live[0]['revisionName'])
open(f'{work}/latest', 'w').write(ready)
print(f'    本番トラフィック: {live[0]["revisionName"]} 100%／最新の準備済みリビジョン: {ready}')
PYEOF
PREV="$(cat "${WORK}/prev")"; LATEST="$(cat "${WORK}/latest")"
gcloud run revisions describe "${LATEST}" "${GC[@]}" --format='json(spec.containers[0].env)' | python3 -c "
import json, sys
env = json.load(sys.stdin)['spec']['containers'][0].get('env') or []
val = {e['name']: e.get('value') for e in env if e['name'] in ('NEW_SHOP_FLOW', 'GIT_SHA')}
ref = {e['name']: ((e.get('valueFrom') or {}).get('secretKeyRef') or {}).get('name') for e in env}
ok = True
print('    ${LATEST}: GIT_SHA', val.get('GIT_SHA'), '／NEW_SHOP_FLOW', val.get('NEW_SHOP_FLOW'))
if val.get('GIT_SHA') != '${MAIN_SHA}':
    print('NG: 最新のリビジョンが main の最新コミット ${MAIN_SHA:0:7} の CI デプロイではありません'); ok = False
if val.get('NEW_SHOP_FLOW') != 'S10':
    print('NG: NEW_SHOP_FLOW が S10 ではありません'); ok = False
for n, s in (('GEMINI_RECOMMEND_API_KEY', 'new-shop-recommend-key'), ('MAPS_AGENT_TOOLS_API_KEY', 'new-shop-maps-key')):
    if ref.get(n) != s:
        print(f'NG: {n} が Secret {s} の参照ではありません'); ok = False
if 'M4_BENCH_TOKEN' in ref:
    print('NG: 計測トークンが設定されています'); ok = False
sys.exit(0 if ok else 1)" || { echo "停止: 切り替えません（トラフィックは変更していません）" >&2; exit 1; }

echo "[2/4] 一時タグ ${TMP_TAG} で ${LATEST} を確認（トラフィックの割合は変えない）"
gcloud run services update-traffic "${SERVICE}" "${GC[@]}" --update-tags="${TMP_TAG}=${LATEST}" --quiet > /dev/null
URL="$(gcloud run services describe "${SERVICE}" "${GC[@]}" --format='json(status.traffic)' | python3 -c "
import json, sys
print(next((t.get('url') or '' for t in json.load(sys.stdin)['status']['traffic'] if t.get('tag') == '${TMP_TAG}'), ''))")"
h="$(curl -s -o /dev/null -w '%{http_code}' "${URL}/health")"
b="$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{"query":"x","method":"scope"}' "${URL}/api/m4/bench")"
gcloud run services update-traffic "${SERVICE}" "${GC[@]}" --remove-tags="${TMP_TAG}" --quiet > /dev/null
echo "    /health → ${h}（200 なら正常）／計測エンドポイント → ${b}（404 なら無効）／一時タグは外した"
[ "${h}" = "200" ] && [ "${b}" = "404" ] || { echo "停止: 切り替えません（トラフィックは変更していません）" >&2; exit 1; }

echo "[3/4] 本番トラフィックを最新のリビジョンに追従させる（--to-latest）"
gcloud run services update-traffic "${SERVICE}" "${GC[@]}" --to-latest --quiet > /dev/null

echo "[4/4] 事後確認"
gcloud run services describe "${SERVICE}" "${GC[@]}" --format='json(status.traffic,status.url)' > "${WORK}/after.json"
python3 - "${WORK}/after.json" "${LATEST}" "${TMP_TAG}" <<'PYEOF'
import json, sys
s, latest, tmp = json.load(open(sys.argv[1]))['status'], sys.argv[2], sys.argv[3]
live = [t for t in s['traffic'] if t.get('percent')]
print('    本番トラフィック:', [(t.get('revisionName'), t.get('percent'), '最新に追従' if t.get('latestRevision') else '固定') for t in live])
ok = len(live) == 1 and live[0].get('percent') == 100 and live[0].get('latestRevision') and live[0].get('revisionName') == latest
if any(t.get('tag') == tmp for t in s['traffic']):
    print('NG: 一時タグが残っています'); ok = False
sys.exit(0 if ok else 1)
PYEOF
h="$(curl -s -o /dev/null -w '%{http_code}' "$(python3 -c "import json; print(json.load(open('${WORK}/after.json'))['status']['url'])")/health")"
echo "    本番 /health → ${h}"
[ "${h}" = "200" ] || { echo "NG: 本番の /health が 200 ではありません。戻す: bash ~/m4_rollback_production.sh ${PREV}" >&2; exit 1; }
echo "完了: 本番は最新のリビジョンに追従（今は ${LATEST}）。以後は main の CI のデプロイがそのまま本番になる"
echo "戻す場合: bash ~/m4_rollback_production.sh ${PREV}"
