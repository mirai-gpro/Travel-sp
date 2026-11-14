#!/usr/bin/env bash
# =====================================================================
# M4 プレビューの後片付け（Cloud Shell）
#
#   bash ~/m4_cleanup_preview.sh            タグ m4s10 を外し、サービスのテンプレートを本番リビジョンと同じ設定に戻す
#   bash ~/m4_cleanup_preview.sh --delete-secrets   さらに Secret 3 つとプレビュー用 Maps API キーを削除する
#
# - 本番トラフィック（travel-sp-base-00060-car 100%）は変更しない（テンプレートを戻すリビジョンも --no-traffic）
# - 次の本番デプロイ（CI）より前に実行する。テンプレートにプレビューの Secret 参照・NEW_SHOP_FLOW が残らないようにするため
# =====================================================================
set -euo pipefail
PROJECT_ID="ai-avator-492205"
REGION="us-central1"
SERVICE="travel-sp-base"
BASE_REVISION="travel-sp-base-00060-car"
TAG="m4s10"
SECRETS=(m4-preview-recommend-key m4-preview-maps-key m4-preview-bench-token)
GC=(--project="${PROJECT_ID}" --region="${REGION}")
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT
SVC_FMT='json(status.traffic,spec.template.spec.containers[0].env[].name)'

gcloud run services describe "${SERVICE}" "${GC[@]}" --format="${SVC_FMT}" > "${WORK}/before.json"
python3 - "${WORK}/before.json" "${BASE_REVISION}" <<'PYEOF'
import json, sys
t = json.load(open(sys.argv[1]))['status']['traffic']
live = [x for x in t if x.get('percent')]
if len(live) != 1 or live[0].get('revisionName') != sys.argv[2] or live[0].get('percent') != 100:
    sys.exit(f'停止: 本番トラフィックが {sys.argv[2]} 100% ではありません（何も変更しません）')
PYEOF
BASE_IMAGE="$(gcloud run revisions describe "${BASE_REVISION}" "${GC[@]}" --format='value(spec.containers[0].image)')"
BASE_MAX="$(gcloud run revisions describe "${BASE_REVISION}" "${GC[@]}" --format='value(metadata.annotations."autoscaling.knative.dev/maxScale")')"
echo "[1/3] タグ ${TAG} を外す（トラフィックの割合は変えない）"
gcloud run services update-traffic "${SERVICE}" "${GC[@]}" --remove-tags="${TAG}" --quiet > /dev/null
echo "[2/3] テンプレートを本番リビジョンの設定へ戻す（イメージ・環境変数・最大インスタンス数。新リビジョンは 0%）"
gcloud run services update "${SERVICE}" "${GC[@]}" --no-traffic --image="${BASE_IMAGE}" \
  --remove-secrets=GEMINI_RECOMMEND_API_KEY,MAPS_AGENT_TOOLS_API_KEY,M4_BENCH_TOKEN \
  --remove-env-vars=NEW_SHOP_FLOW,GIT_SHA,M4_BENCH_MAX_CALLS \
  ${BASE_MAX:+--max-instances="${BASE_MAX}"} --revision-suffix="m4clean-$(date +%m%d%H%M)" --quiet > /dev/null
gcloud run services describe "${SERVICE}" "${GC[@]}" --format="${SVC_FMT}" > "${WORK}/after.json"
gcloud run revisions describe "${BASE_REVISION}" "${GC[@]}" --format='json(spec.containers[0].env[].name)' > "${WORK}/base.json"
python3 - "${WORK}/before.json" "${WORK}/after.json" "${WORK}/base.json" "${BASE_REVISION}" "${TAG}" <<'PYEOF'
import json, sys
b, a, base = (json.load(open(p)) for p in sys.argv[1:4])
ok = True
live = [x for x in a['status']['traffic'] if x.get('percent')]
if len(live) != 1 or live[0].get('revisionName') != sys.argv[4] or live[0].get('percent') != 100:
    print('NG: 本番トラフィックが変わっています'); ok = False
if any(x.get('tag') == sys.argv[5] for x in a['status']['traffic']):
    print('NG: タグが残っています'); ok = False
tn = sorted(e['name'] for e in a['spec']['template']['spec']['containers'][0].get('env') or [])
bn = sorted(e['name'] for e in base['spec']['containers'][0].get('env') or [])
if tn != bn:
    print(f'NG: テンプレートの環境変数名が本番リビジョンと一致しません: 余分 {sorted(set(tn) - set(bn))} / 不足 {sorted(set(bn) - set(tn))}'); ok = False
print('    本番トラフィック: 変更なし／タグ: 削除済み／テンプレート: 本番リビジョンと同じ環境変数名' if ok else '')
sys.exit(0 if ok else 1)
PYEOF
if [ "${1:-}" = "--delete-secrets" ]; then
  echo "[3/3] Secret とプレビュー用 Maps API キーの削除"
  for s in "${SECRETS[@]}"; do gcloud secrets delete "${s}" --project="${PROJECT_ID}" --quiet > /dev/null 2>&1 || true; done
  KEY_NAME="$(gcloud services api-keys list --project="${PROJECT_ID}" --filter='displayName=m4-preview-maps' --format='value(name)' | head -n 1)"
  [ -n "${KEY_NAME}" ] && gcloud services api-keys delete "${KEY_NAME}" --project="${PROJECT_ID}" --quiet > /dev/null
  rm -f "${HOME}/.m4_bench_token"
  echo "    削除しました"
else
  echo "[3/3] Secret と API キーは残しています（削除は --delete-secrets）"
fi
