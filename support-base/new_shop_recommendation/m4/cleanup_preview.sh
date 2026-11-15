#!/usr/bin/env bash
# =====================================================================
# M4 プレビューの後片付け（Cloud Shell）— S10 本番化の後に使う（本番は 100% を受けている 1 つのリビジョン）
#
#   bash ~/m4_cleanup_preview.sh                    タグ m4s10 を外す
#   bash ~/m4_cleanup_preview.sh --delete-secrets   さらにプレビュー用 Secret 3 つを削除する
#
# - 本番トラフィック・サービスのテンプレート（イメージ・環境変数・Secret 参照）は変更しない
# - Secret を消すのは、本番リビジョンとテンプレートがプレビュー用 Secret を参照していないことを確かめた後だけ
# - API キー m4-preview-maps は削除しない（本番の new-shop-maps-key はこのキーの値を写したもの。消すと本番の Maps が止まる）
# =====================================================================
set -euo pipefail
PROJECT_ID="ai-avator-492205"
REGION="us-central1"
SERVICE="travel-sp-base"
TAG="m4s10"
SECRETS=(m4-preview-recommend-key m4-preview-maps-key m4-preview-bench-token)
GC=(--project="${PROJECT_ID}" --region="${REGION}")
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT
SVC_FMT='json(status.traffic,spec.template.spec.containers[0].env[].name,spec.template.spec.containers[0].env[].valueFrom)'
REV_FMT='json(spec.containers[0].env[].name,spec.containers[0].env[].valueFrom)'

echo "[1/3] 事前確認（読み取りのみ）"
gcloud run services describe "${SERVICE}" "${GC[@]}" --format="${SVC_FMT}" > "${WORK}/before.json"
PROD_REVISION="$(python3 -c "import json,sys; live=[t for t in json.load(open('${WORK}/before.json'))['status']['traffic'] if t.get('percent')]; print(live[0].get('revisionName') if len(live)==1 and live[0].get('percent')==100 else '')")"
[ -n "${PROD_REVISION}" ] || { echo "停止: 本番トラフィックが 1 つのリビジョンに 100% ではありません（何も変更しません）" >&2; exit 1; }
gcloud run revisions describe "${PROD_REVISION}" "${GC[@]}" --format="${REV_FMT}" > "${WORK}/prod.json"
python3 - "${WORK}/before.json" "${WORK}/prod.json" "${PROD_REVISION}" "${SECRETS[*]}" <<'PYEOF'
import json, sys
svc, prod = json.load(open(sys.argv[1])), json.load(open(sys.argv[2]))
prod_rev, preview = sys.argv[3], set(sys.argv[4].split())
live = [x for x in svc['status']['traffic'] if x.get('percent')]
if len(live) != 1 or live[0].get('revisionName') != prod_rev or live[0].get('percent') != 100:
    sys.exit(f'停止: 本番トラフィックが {prod_rev} 100% ではありません（何も変更しません）')
def refs(containers):
    return {((e.get('valueFrom') or {}).get('secretKeyRef') or {}).get('name') for e in containers[0].get('env') or []} - {None}
used = (refs(svc['spec']['template']['spec']['containers']) | refs(prod['spec']['containers'])) & preview
if used:
    sys.exit(f'停止: 本番リビジョンかテンプレートがプレビュー用 Secret を参照しています: {sorted(used)}（何も変更しません）')
print(f'    本番トラフィック: {prod_rev} 100%／本番・テンプレートはプレビュー用 Secret を参照していない')
PYEOF

echo "[2/3] タグ ${TAG} を外す（トラフィックの割合・テンプレートは変えない）"
if python3 -c "import json,sys; sys.exit(0 if any(x.get('tag')=='${TAG}' for x in json.load(open('${WORK}/before.json'))['status']['traffic']) else 1)"; then
  gcloud run services update-traffic "${SERVICE}" "${GC[@]}" --remove-tags="${TAG}" --quiet > /dev/null
fi
gcloud run services describe "${SERVICE}" "${GC[@]}" --format="${SVC_FMT}" > "${WORK}/after.json"
python3 - "${WORK}/before.json" "${WORK}/after.json" "${PROD_REVISION}" "${TAG}" <<'PYEOF'
import json, sys
b, a = json.load(open(sys.argv[1])), json.load(open(sys.argv[2]))
prod_rev, tag = sys.argv[3], sys.argv[4]
ok = True
live = [x for x in a['status']['traffic'] if x.get('percent')]
if len(live) != 1 or live[0].get('revisionName') != prod_rev or live[0].get('percent') != 100:
    print('NG: 本番トラフィックが変わっています'); ok = False
if any(x.get('tag') == tag for x in a['status']['traffic']):
    print('NG: タグが残っています'); ok = False
if b['spec']['template'] != a['spec']['template']:
    print('NG: テンプレートが変わっています'); ok = False
if ok:
    print(f'    本番トラフィック: {prod_rev} 100%（変更なし）／タグ {tag}: なし／テンプレート: 変更なし')
sys.exit(0 if ok else 1)
PYEOF

if [ "${1:-}" = "--delete-secrets" ]; then
  echo "[3/3] プレビュー用 Secret の削除（API キー m4-preview-maps は本番で使うので残す）"
  for s in "${SECRETS[@]}"; do
    if gcloud secrets describe "${s}" --project="${PROJECT_ID}" --format='value(name)' > /dev/null 2>&1; then
      gcloud secrets delete "${s}" --project="${PROJECT_ID}" --quiet > /dev/null
      echo "    ${s}: 削除"
    else
      echo "    ${s}: ありません（削除済み）"
    fi
  done
  rm -f "${HOME}/.m4_bench_token"
else
  echo "[3/3] Secret は残しています（削除は --delete-secrets）"
fi
echo "完了"
