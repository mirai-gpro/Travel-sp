#!/usr/bin/env bash
# =====================================================================
# M4 プレビューの入れ替え（Cloud Shell）— 既存の Secret・IAM はそのまま、イメージだけ新しいバックエンド SHA にする
#
#   bash ~/m4_redeploy_preview.sh
#
# - 前提: m4_deploy_preview.sh でタグ m4s10・Secret 3 つ・IAM が設定済み
# - 新リビジョンを「トラフィック 0%・タグ m4s10（付け替え）・最大 1 インスタンス」で追加。本番トラフィックは変更しない
# - テンプレートの Secret 参照（バージョン固定）と NEW_SHOP_FLOW 等は引き継ぎ、GIT_SHA だけ更新する
# - 事前・事後確認は m4_deploy_preview.sh と同じ（本番キーの値は読まない）
# =====================================================================
set -euo pipefail
PROJECT_ID="ai-avator-492205"
REGION="us-central1"
SERVICE="travel-sp-base"
BASE_REVISION="travel-sp-base-00060-car"
TAG="m4s10"
BRANCH="preview-m4s10-backend"
EXPECTED_SHA="754cbcb844f1fa915e1fdfde9197bf5e74c1abc2"
AR_IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${SERVICE}/${SERVICE}"
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT
GC=(--project="${PROJECT_ID}" --region="${REGION}")
SVC_FMT='json(status.traffic,spec.template.spec.containers[0].env[].name,spec.template.spec.containers[0].env[].valueFrom)'
REV_FMT='json(spec.containers[0].env[].name,spec.containers[0].env[].valueFrom,spec.containers[0].image)'

echo "[1/4] 事前確認（読み取りのみ）"
gcloud run services describe "${SERVICE}" "${GC[@]}" --format="${SVC_FMT}" > "${WORK}/svc_before.json"
python3 - "${WORK}/svc_before.json" "${BASE_REVISION}" "${TAG}" <<'PYEOF'
import json, sys
svc = json.load(open(sys.argv[1]))
base_rev, tag = sys.argv[2], sys.argv[3]
traffic = svc['status']['traffic']
live = [t for t in traffic if t.get('percent')]
if len(live) != 1 or live[0].get('revisionName') != base_rev or live[0].get('percent') != 100:
    sys.exit(f'停止: 本番トラフィックが {base_rev} 100% ではありません')
mine = [t for t in traffic if t.get('tag') == tag]
if len(mine) != 1 or mine[0].get('percent'):
    sys.exit(f'停止: タグ {tag} のプレビュー（0%）がありません。先に m4_deploy_preview.sh を実行してください')
env = {e['name']: e.get('valueFrom') for e in svc['spec']['template']['spec']['containers'][0].get('env') or []}
for n in ('GEMINI_RECOMMEND_API_KEY', 'MAPS_AGENT_TOOLS_API_KEY', 'M4_BENCH_TOKEN'):
    if not ((env.get(n) or {}).get('secretKeyRef') or {}).get('name'):
        sys.exit(f'停止: テンプレートの {n} が Secret 参照ではありません')
if 'NEW_SHOP_FLOW' not in env:
    sys.exit('停止: テンプレートに NEW_SHOP_FLOW がありません')
print(f'    本番トラフィック: {base_rev} 100%／タグ {tag}: {mine[0]["revisionName"]}（0%）／Secret 参照: 3 つとも設定済み')
PYEOF

echo "[2/4] ${BRANCH} を取得（固定 SHA ${EXPECTED_SHA:0:7}）とイメージのビルド"
git init -q "${WORK}/src"
git -C "${WORK}/src" remote add origin https://github.com/mirai-gpro/Travel-sp.git
GIT_TERMINAL_PROMPT=0 git -C "${WORK}/src" fetch -q --depth=5 origin "${BRANCH}" || { echo "GitHub から取得できません" >&2; exit 1; }
git -C "${WORK}/src" checkout -q "${EXPECTED_SHA}" || { echo "固定 SHA が見つかりません" >&2; exit 1; }
[ "$(git -C "${WORK}/src" rev-parse HEAD)" = "${EXPECTED_SHA}" ] || { echo "SHA 不一致" >&2; exit 1; }
IMAGE="${AR_IMAGE}:m4-${EXPECTED_SHA:0:12}"
gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet > /dev/null 2>&1
docker build -q -t "${IMAGE}" "${WORK}/src/support-base" > /dev/null
pushed=0
for i in 1 2 3 4; do
  if docker push -q "${IMAGE}" > "${WORK}/push.log" 2>&1; then pushed=1; break; fi
  echo "    push に失敗（${i}/4 回目）。$((i * 15)) 秒後に再試行します: $(tail -n 1 "${WORK}/push.log")"
  sleep $((i * 15))
done
[ "${pushed}" = "1" ] || { echo "停止: Artifact Registry への push に 4 回失敗しました（Cloud Run は未変更）" >&2; exit 1; }
DIGEST="$(gcloud artifacts docker images describe "${IMAGE}" --format='value(image_summary.digest)')"
[ -n "${DIGEST}" ] || { echo "イメージ digest を取得できません" >&2; exit 1; }
AMD64_DIGEST="$(docker buildx imagetools inspect --raw "${AR_IMAGE}@${DIGEST}" 2>/dev/null | python3 -c "import json,sys
d=json.load(sys.stdin)
print(next((m['digest'] for m in d.get('manifests') or [] if (m.get('platform') or {}).get('os')=='linux' and (m.get('platform') or {}).get('architecture')=='amd64'), ''))" || true)"
echo "    digest: ${DIGEST}（linux/amd64: ${AMD64_DIGEST:-単一イメージ}）"

echo "[3/4] デプロイ直前の再確認とデプロイ（--no-traffic --tag=${TAG}）"
gcloud run services describe "${SERVICE}" "${GC[@]}" --format="${SVC_FMT}" > "${WORK}/svc_recheck.json"
python3 - "${WORK}/svc_before.json" "${WORK}/svc_recheck.json" <<'PYEOF'
import json, sys
a, b = (json.load(open(p))['status']['traffic'] for p in sys.argv[1:3])
if a != b:
    sys.exit('停止: 事前確認の後にトラフィック設定が変わりました。デプロイしません')
PYEOF
gcloud run deploy "${SERVICE}" "${GC[@]}" --platform=managed \
  --image="${AR_IMAGE}@${DIGEST}" --no-traffic --tag="${TAG}" --revision-suffix="m4s10-${EXPECTED_SHA:0:7}" \
  --max-instances=1 --update-env-vars="GIT_SHA=${EXPECTED_SHA}" \
  --quiet > "${WORK}/deploy.log" 2>&1 || { echo "デプロイに失敗しました（トラフィックは変更していません）:" >&2; tail -n 20 "${WORK}/deploy.log" >&2; exit 1; }

echo "[4/4] 事後確認"
NEW_REV="${SERVICE}-m4s10-${EXPECTED_SHA:0:7}"
gcloud run services describe "${SERVICE}" "${GC[@]}" --format="${SVC_FMT}" > "${WORK}/svc_after.json"
gcloud run revisions describe "${NEW_REV}" "${GC[@]}" --format="${REV_FMT}" > "${WORK}/new_rev.json"
python3 - "${WORK}/svc_before.json" "${WORK}/svc_after.json" "${WORK}/new_rev.json" "${BASE_REVISION}" "${TAG}" "${NEW_REV}" "${DIGEST}" "${AMD64_DIGEST}" "${WORK}" <<'PYEOF'
import json, sys
before, after, rev = (json.load(open(p)) for p in sys.argv[1:4])
base_rev, tag, new_rev, digest, amd64, work = sys.argv[4:10]
tb, ta = before['status']['traffic'], after['status']['traffic']
ok = True
live = [t for t in ta if t.get('percent')]
if len(live) != 1 or live[0].get('revisionName') != base_rev or live[0].get('percent') != 100:
    print('NG: 本番トラフィックが変わっています'); ok = False
others_b = {(t.get('tag'), t.get('revisionName')) for t in tb if t.get('tag') and t.get('tag') != tag}
others_a = {(t.get('tag'), t.get('revisionName')) for t in ta if t.get('tag') and t.get('tag') != tag}
if others_b != others_a:
    print('NG: ほかのタグが変わっています'); ok = False
mine = [t for t in ta if t.get('tag') == tag]
if len(mine) != 1 or mine[0].get('revisionName') != new_rev or mine[0].get('percent'):
    print(f'NG: タグ {tag} が新リビジョン（0%）を指していません'); ok = False
img = rev['spec']['containers'][0]['image']
if not (img.endswith(digest) or (amd64 and img.endswith(amd64))):
    print('NG: 新リビジョンのイメージが今回のビルドではありません'); ok = False
env = {e['name']: e.get('valueFrom') for e in rev['spec']['containers'][0].get('env') or []}
for n in ('GEMINI_RECOMMEND_API_KEY', 'MAPS_AGENT_TOOLS_API_KEY', 'M4_BENCH_TOKEN'):
    if not ((env.get(n) or {}).get('secretKeyRef') or {}).get('name'):
        print(f'NG: {n} が Secret 参照ではありません'); ok = False
open(f'{work}/url', 'w').write((mine[0].get('url') if mine else '') or '')
print(f'    本番トラフィック: {base_rev} 100%（変更なし）／ほかのタグ: 変更なし／タグ {tag} → {new_rev}（0%）／キーは Secret 参照')
sys.exit(0 if ok else 1)
PYEOF
URL="$(cat "${WORK}/url")"
code_health="$(curl -s -o /dev/null -w '%{http_code}' "${URL}/health")"
code_bench="$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{"query":"x","method":"scope"}' "${URL}/api/m4/bench")"
echo "    ${URL}/health → ${code_health}（200 なら正常）／計測エンドポイント（トークンなし）→ ${code_bench}（403 なら保護されている）"
[ "${code_health}" = "200" ] && [ "${code_bench}" = "403" ] || { echo "NG: 事後確認に失敗しました（トラフィックは変更していません）" >&2; exit 1; }
echo "完了: ${URL}（${NEW_REV}）"
