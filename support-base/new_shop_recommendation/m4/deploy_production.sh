#!/usr/bin/env bash
# =====================================================================
# 新ショップ推薦 S10 の本番化（Cloud Shell）
#
#   bash ~/m4_deploy_production.sh
#
# 1. 事前確認（読み取りのみ・本番キーの値は読まない）: 本番トラフィックが 00060-car 100%、プレビュー用 Secret があること
# 2. 本番用 Secret を作成（既にあれば停止）: new-shop-recommend-key・new-shop-maps-key
#    値はプレビュー用 Secret（m4-preview-recommend-key・m4-preview-maps-key）から画面に出さずに写す
#    IAM: 各 Secret に Cloud Run の実行サービスアカウントへ roles/secretmanager.secretAccessor（Secret 単位）
# 3. feature/new-shop-recommendation の固定 SHA を Cloud Build でビルドし、0%・タグ m4prod で追加
#    本番リビジョン 00060-car と同じ最大インスタンス数。NEW_SHOP_FLOW=S10、Secret 参照 2 つ。計測用トークンは入れない（計測エンドポイントは無効）
# 4. 事後確認: /health 200、計測エンドポイント 404（無効）、Secret 参照、イメージ一致
# 5. トラフィックを新リビジョンへ 100% 切り替え → 確認。失敗したら停止（戻すのは m4_rollback_production.sh）
# =====================================================================
set -euo pipefail
PROJECT_ID="ai-avator-492205"
REGION="us-central1"
SERVICE="travel-sp-base"
BASE_REVISION="travel-sp-base-00060-car"
TAG="m4prod"
BRANCH="feature/new-shop-recommendation"
EXPECTED_SHA="b53037fb64be36a9fd7cd26aae0addc0b60fc691"
AR_IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${SERVICE}/${SERVICE}"
SRC_SECRETS=(m4-preview-recommend-key m4-preview-maps-key)
PROD_SECRETS=(new-shop-recommend-key new-shop-maps-key)
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT
GC=(--project="${PROJECT_ID}" --region="${REGION}")
SVC_FMT='json(status.traffic,spec.template.spec.containers[0].resources,spec.template.spec.containers[0].ports,spec.template.spec.timeoutSeconds,spec.template.spec.containerConcurrency,spec.template.spec.serviceAccountName)'
REV_FMT='json(spec.containers[0].env[].name,spec.containers[0].env[].valueFrom,spec.containers[0].image,spec.containers[0].resources,spec.containers[0].ports,spec.timeoutSeconds,spec.containerConcurrency,spec.serviceAccountName)'

echo "[1/5] 事前確認（読み取りのみ）"
gcloud run services describe "${SERVICE}" "${GC[@]}" --format="${SVC_FMT}" > "${WORK}/svc_before.json"
gcloud run revisions describe "${BASE_REVISION}" "${GC[@]}" --format="${REV_FMT}" > "${WORK}/base.json"
BASE_MAX="$(gcloud run revisions describe "${BASE_REVISION}" "${GC[@]}" --format='value(metadata.annotations."autoscaling.knative.dev/maxScale")')"
python3 - "${WORK}/svc_before.json" "${WORK}/base.json" "${BASE_REVISION}" "${TAG}" "${WORK}" <<'PYEOF'
import json, sys
svc, base = json.load(open(sys.argv[1])), json.load(open(sys.argv[2]))
base_rev, tag, work = sys.argv[3], sys.argv[4], sys.argv[5]
traffic = svc['status']['traffic']
live = [t for t in traffic if t.get('percent')]
if len(live) != 1 or live[0].get('revisionName') != base_rev or live[0].get('percent') != 100:
    sys.exit(f'停止: 本番トラフィックが {base_rev} 100% ではありません')
if any(t.get('tag') == tag for t in traffic):
    sys.exit(f'停止: タグ {tag} は既に使われています')
def conf(sp):
    c = sp['containers'][0]
    return {'resources': c.get('resources'), 'ports': c.get('ports'), 'timeout': sp.get('timeoutSeconds'),
            'concurrency': sp.get('containerConcurrency'), 'sa': sp.get('serviceAccountName')}
if conf(svc['spec']['template']['spec']) != conf(base['spec']):
    sys.exit('停止: テンプレートの CPU・メモリ・ポート・タイムアウト・同時実行数・サービスアカウントが本番リビジョンと異なります')
open(f'{work}/sa', 'w').write(base['spec'].get('serviceAccountName') or '')
print(f'    本番トラフィック: {base_rev} 100%（切り替え前）')
PYEOF
for s in "${SRC_SECRETS[@]}"; do
  gcloud secrets describe "${s}" --project="${PROJECT_ID}" > /dev/null 2>&1 || { echo "停止: Secret ${s} がありません" >&2; exit 1; }
done
for s in "${PROD_SECRETS[@]}"; do
  if gcloud secrets describe "${s}" --project="${PROJECT_ID}" > /dev/null 2>&1; then echo "停止: Secret ${s} は既にあります（上書きしません）" >&2; exit 1; fi
done
RUN_SA="$(cat "${WORK}/sa")"
if [ -z "${RUN_SA}" ]; then RUN_SA="$(gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)')-compute@developer.gserviceaccount.com"; fi
echo "    実行サービスアカウント: ${RUN_SA}／本番の最大インスタンス数: ${BASE_MAX:-（既定）}"

echo "[2/5] 本番用 Secret の作成（値は画面・ファイルに出さない）と IAM"
for i in 0 1; do
  gcloud secrets create "${PROD_SECRETS[$i]}" --project="${PROJECT_ID}" --replication-policy=automatic --labels=purpose=new-shop-production > /dev/null
  gcloud secrets versions access latest --secret="${SRC_SECRETS[$i]}" --project="${PROJECT_ID}" \
    | gcloud secrets versions add "${PROD_SECRETS[$i]}" --project="${PROJECT_ID}" --data-file=- > /dev/null
  gcloud secrets add-iam-policy-binding "${PROD_SECRETS[$i]}" --project="${PROJECT_ID}" \
    --member="serviceAccount:${RUN_SA}" --role="roles/secretmanager.secretAccessor" --condition=None > /dev/null
  echo "    ${PROD_SECRETS[$i]}: 作成（${SRC_SECRETS[$i]} の値を写した）・serviceAccount:${RUN_SA} → secretAccessor"
done
V1="$(gcloud secrets versions list new-shop-recommend-key --project="${PROJECT_ID}" --filter='state=ENABLED' --sort-by='~createTime' --limit=1 --format='value(name)')"
V2="$(gcloud secrets versions list new-shop-maps-key --project="${PROJECT_ID}" --filter='state=ENABLED' --sort-by='~createTime' --limit=1 --format='value(name)')"

echo "[3/5] ${BRANCH} を取得（固定 SHA ${EXPECTED_SHA:0:7}）し Cloud Build でビルド、0%・タグ ${TAG} で追加"
git init -q "${WORK}/src"
git -C "${WORK}/src" remote add origin https://github.com/mirai-gpro/Travel-sp.git
GIT_TERMINAL_PROMPT=0 git -C "${WORK}/src" fetch -q --depth=40 origin "${BRANCH}" || { echo "GitHub から取得できません" >&2; exit 1; }
git -C "${WORK}/src" checkout -q "${EXPECTED_SHA}" || { echo "固定 SHA が見つかりません" >&2; exit 1; }
[ "$(git -C "${WORK}/src" rev-parse HEAD)" = "${EXPECTED_SHA}" ] || { echo "SHA 不一致" >&2; exit 1; }
IMAGE="${AR_IMAGE}:prod-${EXPECTED_SHA:0:12}"
gcloud builds submit "${WORK}/src/support-base" --project="${PROJECT_ID}" --region="${REGION}" --tag="${IMAGE}" --quiet \
  > "${WORK}/build.log" 2>&1 || { echo "停止: Cloud Build に失敗しました（本番は未変更）:" >&2; tail -n 15 "${WORK}/build.log" >&2; exit 1; }
DIGEST="$(gcloud artifacts docker images describe "${IMAGE}" --format='value(image_summary.digest)')"
gcloud run services describe "${SERVICE}" "${GC[@]}" --format="${SVC_FMT}" > "${WORK}/svc_recheck.json"
python3 - "${WORK}/svc_before.json" "${WORK}/svc_recheck.json" <<'PYEOF'
import json, sys
a, b = (json.load(open(p))['status']['traffic'] for p in sys.argv[1:3])
if a != b:
    sys.exit('停止: 事前確認の後にトラフィック設定が変わりました。デプロイしません')
PYEOF
NEW_REV="${SERVICE}-prod-${EXPECTED_SHA:0:7}"
gcloud run deploy "${SERVICE}" "${GC[@]}" --platform=managed \
  --image="${AR_IMAGE}@${DIGEST}" --no-traffic --tag="${TAG}" --revision-suffix="prod-${EXPECTED_SHA:0:7}" \
  ${BASE_MAX:+--max-instances="${BASE_MAX}"} \
  --remove-secrets=M4_BENCH_TOKEN --remove-env-vars=M4_BENCH_MAX_CALLS \
  --update-secrets="GEMINI_RECOMMEND_API_KEY=new-shop-recommend-key:${V1},MAPS_AGENT_TOOLS_API_KEY=new-shop-maps-key:${V2}" \
  --update-env-vars="NEW_SHOP_FLOW=S10,GIT_SHA=${EXPECTED_SHA}" \
  --quiet > "${WORK}/deploy.log" 2>&1 || { echo "停止: デプロイに失敗しました（本番トラフィックは未変更）:" >&2; tail -n 20 "${WORK}/deploy.log" >&2; exit 1; }

echo "[4/5] 事後確認（トラフィックはまだ 00060-car）"
gcloud run revisions describe "${NEW_REV}" "${GC[@]}" --format="${REV_FMT}" > "${WORK}/new.json"
python3 - "${WORK}/new.json" "${DIGEST}" <<'PYEOF'
import json, sys
rev, digest = json.load(open(sys.argv[1])), sys.argv[2]
env = {e['name']: e.get('valueFrom') for e in rev['spec']['containers'][0].get('env') or []}
ok = rev['spec']['containers'][0]['image'].endswith(digest)
for n, s in (('GEMINI_RECOMMEND_API_KEY', 'new-shop-recommend-key'), ('MAPS_AGENT_TOOLS_API_KEY', 'new-shop-maps-key')):
    if ((env.get(n) or {}).get('secretKeyRef') or {}).get('name') != s:
        print(f'NG: {n} が本番用 Secret {s} の参照ではありません'); ok = False
if 'M4_BENCH_TOKEN' in env:
    print('NG: 計測用トークンが残っています'); ok = False
if 'NEW_SHOP_FLOW' not in env:
    print('NG: NEW_SHOP_FLOW がありません'); ok = False
sys.exit(0 if ok else 1)
PYEOF
TAG_URL="$(gcloud run services describe "${SERVICE}" "${GC[@]}" --format=json | python3 -c "import json,sys; print(next(t['url'] for t in json.load(sys.stdin)['status']['traffic'] if t.get('tag')=='${TAG}'))")"
h="$(curl -s -o /dev/null -w '%{http_code}' "${TAG_URL}/health")"
b="$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{"query":"x","method":"scope"}' "${TAG_URL}/api/m4/bench")"
echo "    ${NEW_REV}: /health → ${h}（200 なら正常）、計測エンドポイント → ${b}（404 なら無効）"
[ "${h}" = "200" ] && [ "${b}" = "404" ] || { echo "停止: 事後確認に失敗しました（本番トラフィックは 00060-car のまま）" >&2; exit 1; }

echo "[5/5] 本番トラフィックを ${NEW_REV} へ 100% 切り替え"
gcloud run services update-traffic "${SERVICE}" "${GC[@]}" --to-revisions="${NEW_REV}=100" --quiet > /dev/null
gcloud run services describe "${SERVICE}" "${GC[@]}" --format="json(status.traffic)" > "${WORK}/svc_after.json"
python3 - "${WORK}/svc_after.json" "${NEW_REV}" <<'PYEOF'
import json, sys
live = [t for t in json.load(open(sys.argv[1]))['status']['traffic'] if t.get('percent')]
if len(live) != 1 or live[0].get('revisionName') != sys.argv[2] or live[0].get('percent') != 100:
    sys.exit(f'NG: 切り替え後のトラフィックが想定と異なります: {[(t.get("revisionName"), t.get("percent")) for t in live]}（戻すには m4_rollback_production.sh）')
print(f'    本番トラフィック: {sys.argv[2]} 100%')
PYEOF
SVC_URL="$(gcloud run services describe "${SERVICE}" "${GC[@]}" --format='value(status.url)')"
echo "    ${SVC_URL}/health → $(curl -s -o /dev/null -w '%{http_code}' "${SVC_URL}/health")"
echo "完了: 本番は ${NEW_REV}。戻す場合は bash ~/m4_rollback_production.sh（00060-car へ 100%）"
