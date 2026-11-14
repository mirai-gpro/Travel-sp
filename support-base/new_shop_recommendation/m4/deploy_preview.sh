#!/usr/bin/env bash
# =====================================================================
# M4 プレビュー環境の隔離デプロイ（Cloud Shell・Secret Manager 版）
#
#   bash ~/m4_deploy_preview.sh
#
# 何をするか（実行前に内容を表示する）
#   1. 事前確認（読み取りのみ）: 本番トラフィックが travel-sp-base-00060-car 100%、タグ m4s10 が未使用、
#      現在のテンプレートの設定が本番リビジョンと同じ。gcloud の出力は「変数名・設定値」だけに絞り、本番キーの値は読まない
#   2. Secret Manager（プレビュー専用。既にあれば停止）
#        m4-preview-recommend-key : 推薦A・推薦B・選択 LLM 用 AQ キー（非表示で入力）
#        m4-preview-maps-key      : S10 の Maps 用プレビュー専用 API キー（このスクリプトが作成。Places・Geocoding・
#                                   Maps Agent Tools の 3 API だけに制限。キー文字列は画面に出さず Secret へ直接渡す）
#        m4-preview-bench-token   : 計測エンドポイントの認証トークン（乱数。~/.m4_bench_token にも保存、権限 600）
#   3. IAM（最小権限）: 上の 3 つの Secret それぞれに、Cloud Run の実行サービスアカウントへ
#      roles/secretmanager.secretAccessor を付与（Secret 単位。プロジェクト全体には付与しない）
#   4. バックエンド固定 SHA（preview-m4s10-backend）をビルドし、「トラフィック 0%・タグ m4s10・最大 1 インスタンス」で追加
#      新リビジョンだけに: Secret 参照 3 つ、NEW_SHOP_FLOW=S10、GIT_SHA、M4_BENCH_MAX_CALLS=150
#      33 秒版の比較・Live は、既存の本番設定（GEMINI_API_KEY など）をリビジョン内でそのまま使う（取り出さない）
#   5. 事後確認: 本番トラフィック・既存タグが不変、タグ m4s10 が新リビジョン 0%、Secret が参照（平文でない）、
#      /health が 200、トークンなしの計測エンドポイントが 403
# 前提が違えば停止する。トラフィックを変える復旧はしない。
# 後片付け（タグとテンプレートを本番の状態へ戻す）は m4/cleanup_preview.sh
# =====================================================================
set -euo pipefail
PROJECT_ID="ai-avator-492205"
REGION="us-central1"
SERVICE="travel-sp-base"
BASE_REVISION="travel-sp-base-00060-car"
TAG="m4s10"
BRANCH="preview-m4s10-backend"
EXPECTED_SHA="fa1b62f28698d8d1c12b5b72078efe5a381b761d"
AR_IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${SERVICE}/${SERVICE}"
SECRETS=(m4-preview-recommend-key m4-preview-maps-key m4-preview-bench-token)
MAPS_APIS=(places-backend.googleapis.com geocoding-backend.googleapis.com mapstools.googleapis.com)
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT
GC=(--project="${PROJECT_ID}" --region="${REGION}")
# 値を含まない射影（環境変数は名前と Secret 参照名だけ）
SVC_FMT='json(status.traffic,spec.template.spec.containers[0].env[].name,spec.template.spec.containers[0].env[].valueFrom,spec.template.spec.containers[0].resources,spec.template.spec.containers[0].ports,spec.template.spec.timeoutSeconds,spec.template.spec.containerConcurrency,spec.template.spec.serviceAccountName)'
REV_FMT='json(spec.containers[0].env[].name,spec.containers[0].env[].valueFrom,spec.containers[0].resources,spec.containers[0].ports,spec.timeoutSeconds,spec.containerConcurrency,spec.serviceAccountName,spec.containers[0].image)'

echo "[1/7] 事前確認（読み取りのみ・本番キーの値は読まない）"
gcloud run services describe "${SERVICE}" "${GC[@]}" --format="${SVC_FMT}" > "${WORK}/svc_before.json"
gcloud run revisions describe "${BASE_REVISION}" "${GC[@]}" --format="${REV_FMT}" > "${WORK}/base_rev.json"
for api in secretmanager.googleapis.com apikeys.googleapis.com; do
  gcloud services list --enabled --project="${PROJECT_ID}" --filter="config.name=${api}" --format='value(config.name)' | grep -q "${api}" \
    || { echo "停止: ${api} が有効になっていません（有効化はプロジェクト設定の変更のため、このスクリプトでは行いません）" >&2; exit 1; }
done
for s in "${SECRETS[@]}"; do
  if gcloud secrets describe "${s}" --project="${PROJECT_ID}" > /dev/null 2>&1; then
    echo "停止: Secret ${s} は既にあります（上書きしません）。再デプロイは m4_cleanup_preview.sh --delete-secrets の後に行ってください" >&2; exit 1
  fi
done
python3 - "${WORK}/svc_before.json" "${WORK}/base_rev.json" "${BASE_REVISION}" "${TAG}" "${WORK}" <<'PYEOF'
import json, sys
svc, base = json.load(open(sys.argv[1])), json.load(open(sys.argv[2]))
base_rev, tag, work = sys.argv[3], sys.argv[4], sys.argv[5]
traffic = svc.get('status', {}).get('traffic') or []
live = [t for t in traffic if t.get('percent')]
if len(live) != 1 or live[0].get('revisionName') != base_rev or live[0].get('percent') != 100:
    sys.exit(f'停止: 本番トラフィックが {base_rev} 100% ではありません: {[(t.get("revisionName"), t.get("percent")) for t in live]}')
if any(t.get('tag') == tag for t in traffic):
    sys.exit(f'停止: タグ {tag} は既に使われています（上書きしません）')
tspec = svc['spec']['template']['spec']
bspec = base['spec']
def conf(sp):
    c = sp['containers'][0]
    return {'resources': c.get('resources'), 'ports': c.get('ports'), 'timeout': sp.get('timeoutSeconds'),
            'concurrency': sp.get('containerConcurrency'), 'sa': sp.get('serviceAccountName')}
if conf(tspec) != conf(bspec):
    sys.exit('停止: サービスの現在のテンプレートの設定（CPU・メモリ・ポート・タイムアウト・同時実行数・サービスアカウント）が本番リビジョンと異なります')
bn = [e['name'] for e in bspec['containers'][0].get('env') or []]
tn = [e['name'] for e in tspec['containers'][0].get('env') or []]
missing = sorted(set(bn) - set(tn))
if missing:
    sys.exit(f'停止: 現在のテンプレートに本番リビジョンの環境変数が欠けています: {missing}')
ours = {'GEMINI_RECOMMEND_API_KEY', 'MAPS_AGENT_TOOLS_API_KEY', 'M4_BENCH_TOKEN', 'NEW_SHOP_FLOW', 'GIT_SHA', 'M4_BENCH_MAX_CALLS'}
if ours & set(bn):
    sys.exit(f'停止: 本番リビジョンに同名の環境変数があります: {sorted(ours & set(bn))}')
extra = sorted(set(tn) - set(bn))
open(f'{work}/extra', 'w').write(','.join(extra))
open(f'{work}/sa', 'w').write(bspec.get('serviceAccountName') or '')
print(f'    本番トラフィック: {base_rev} 100%（タグ {tag} は未使用）')
print(f'    テンプレートにだけある環境変数（新リビジョンでは削除）: {extra or "なし"}')
print('    ※ 共通の環境変数は名前の一致だけを確認しています（本番キーの値は読み比べていません）')
PYEOF
REMOVE_ENV="$(cat "${WORK}/extra")"
RUN_SA="$(cat "${WORK}/sa")"
if [ -z "${RUN_SA}" ]; then
  PROJECT_NUMBER="$(gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)')"
  RUN_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
fi
echo "    Cloud Run の実行サービスアカウント: ${RUN_SA}"

echo "[2/7] これから行う変更"
echo "    Secret を作成: ${SECRETS[*]}（自動レプリケーション）"
echo "    API キーを作成: m4-preview-maps（利用 API を ${MAPS_APIS[*]} に制限）"
echo "    IAM: 各 Secret に serviceAccount:${RUN_SA} → roles/secretmanager.secretAccessor（Secret 単位）"
echo "    Cloud Run: ${SERVICE} に新リビジョン（--no-traffic --tag=${TAG} --max-instances=1）を追加。本番トラフィックは変更しない"

echo "[3/7] ${BRANCH} を取得（固定 SHA ${EXPECTED_SHA:0:7}）とイメージのビルド"
git init -q "${WORK}/src"
git -C "${WORK}/src" remote add origin https://github.com/mirai-gpro/Travel-sp.git
GIT_TERMINAL_PROMPT=0 git -C "${WORK}/src" fetch -q --depth=5 origin "${BRANCH}" || { echo "GitHub から取得できません" >&2; exit 1; }
git -C "${WORK}/src" checkout -q "${EXPECTED_SHA}" || { echo "固定 SHA が見つかりません" >&2; exit 1; }
[ "$(git -C "${WORK}/src" rev-parse HEAD)" = "${EXPECTED_SHA}" ] || { echo "SHA 不一致" >&2; exit 1; }
IMAGE="${AR_IMAGE}:m4-${EXPECTED_SHA:0:12}"
gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet > /dev/null 2>&1
docker build -q -t "${IMAGE}" "${WORK}/src/support-base" > /dev/null
docker push -q "${IMAGE}" > /dev/null
DIGEST="$(gcloud artifacts docker images describe "${IMAGE}" --format='value(image_summary.digest)')"
[ -n "${DIGEST}" ] || { echo "イメージ digest を取得できません" >&2; exit 1; }
echo "    digest: ${DIGEST}"

echo "[4/7] Secret の作成（値は画面・ファイルに出さない）"
echo "    推薦用 AQ キーを入力してください（表示されません。Enter で確定）"
read -rs AQ_KEY_INPUT
echo
[ -n "${AQ_KEY_INPUT}" ] || { echo "キーが空です" >&2; exit 1; }
for s in "${SECRETS[@]}"; do
  gcloud secrets create "${s}" --project="${PROJECT_ID}" --replication-policy=automatic --labels=purpose=m4-preview > /dev/null
done
printf '%s' "${AQ_KEY_INPUT}" | gcloud secrets versions add m4-preview-recommend-key --project="${PROJECT_ID}" --data-file=- > /dev/null
unset AQ_KEY_INPUT
API_TARGETS=()
for a in "${MAPS_APIS[@]}"; do API_TARGETS+=(--api-target=service="${a}"); done
gcloud services api-keys create --project="${PROJECT_ID}" --display-name="m4-preview-maps" "${API_TARGETS[@]}" \
  --format='value(response.keyString)' 2> "${WORK}/apikey.err" | tr -d '\n' \
  | gcloud secrets versions add m4-preview-maps-key --project="${PROJECT_ID}" --data-file=- > /dev/null \
  || { echo "停止: プレビュー用 Maps API キーの作成に失敗しました:" >&2; grep -v -i "keyString" "${WORK}/apikey.err" | tail -n 5 >&2; exit 1; }
umask 077
python3 -c "import secrets; print(secrets.token_urlsafe(32), end='')" > "${HOME}/.m4_bench_token"
chmod 600 "${HOME}/.m4_bench_token"
gcloud secrets versions add m4-preview-bench-token --project="${PROJECT_ID}" --data-file="${HOME}/.m4_bench_token" > /dev/null
declare -A VER
for s in "${SECRETS[@]}"; do
  VER[$s]="$(gcloud secrets versions list "${s}" --project="${PROJECT_ID}" --filter='state=ENABLED' --sort-by='~createTime' --limit=1 --format='value(name)')"
  [ -n "${VER[$s]}" ] || { echo "停止: Secret ${s} のバージョンがありません" >&2; exit 1; }
done

echo "[5/7] IAM（Secret 単位で secretAccessor を付与）"
for s in "${SECRETS[@]}"; do
  gcloud secrets add-iam-policy-binding "${s}" --project="${PROJECT_ID}" \
    --member="serviceAccount:${RUN_SA}" --role="roles/secretmanager.secretAccessor" --condition=None > /dev/null
  echo "    ${s}: serviceAccount:${RUN_SA} → roles/secretmanager.secretAccessor"
done

echo "[6/7] デプロイ直前の再確認とデプロイ（--no-traffic --tag=${TAG}）"
gcloud run services describe "${SERVICE}" "${GC[@]}" --format="${SVC_FMT}" > "${WORK}/svc_recheck.json"
python3 - "${WORK}/svc_before.json" "${WORK}/svc_recheck.json" <<'PYEOF'
import json, sys
a, b = (json.load(open(p)).get('status', {}).get('traffic') for p in sys.argv[1:3])
if a != b:
    sys.exit('停止: 事前確認の後にトラフィック設定が変わりました。デプロイしません')
PYEOF
REMOVE_ARGS=()
[ -n "${REMOVE_ENV}" ] && REMOVE_ARGS=(--remove-env-vars="${REMOVE_ENV}")
gcloud run deploy "${SERVICE}" "${GC[@]}" --platform=managed \
  --image="${AR_IMAGE}@${DIGEST}" --no-traffic --tag="${TAG}" --revision-suffix="m4s10-${EXPECTED_SHA:0:7}" \
  --max-instances=1 "${REMOVE_ARGS[@]}" \
  --update-secrets="GEMINI_RECOMMEND_API_KEY=m4-preview-recommend-key:${VER[m4-preview-recommend-key]},MAPS_AGENT_TOOLS_API_KEY=m4-preview-maps-key:${VER[m4-preview-maps-key]},M4_BENCH_TOKEN=m4-preview-bench-token:${VER[m4-preview-bench-token]}" \
  --update-env-vars="NEW_SHOP_FLOW=S10,GIT_SHA=${EXPECTED_SHA},M4_BENCH_MAX_CALLS=150" \
  --quiet > "${WORK}/deploy.log" 2>&1 || { echo "デプロイに失敗しました（トラフィックは変更していません）:" >&2; tail -n 20 "${WORK}/deploy.log" >&2; exit 1; }

echo "[7/7] 事後確認"
NEW_REV="${SERVICE}-m4s10-${EXPECTED_SHA:0:7}"
gcloud run services describe "${SERVICE}" "${GC[@]}" --format="${SVC_FMT}" > "${WORK}/svc_after.json"
gcloud run revisions describe "${NEW_REV}" "${GC[@]}" --format="${REV_FMT}" > "${WORK}/new_rev.json"
python3 - "${WORK}/svc_before.json" "${WORK}/svc_after.json" "${WORK}/new_rev.json" "${BASE_REVISION}" "${TAG}" "${NEW_REV}" "${DIGEST}" "${WORK}" <<'PYEOF'
import json, sys
before, after, rev = (json.load(open(p)) for p in sys.argv[1:4])
base_rev, tag, new_rev, digest, work = sys.argv[4:9]
tb, ta = before['status']['traffic'], after['status']['traffic']
ok = True
live = [t for t in ta if t.get('percent')]
if len(live) != 1 or live[0].get('revisionName') != base_rev or live[0].get('percent') != 100:
    print(f'NG: 本番トラフィックが変わっています: {[(t.get("revisionName"), t.get("percent")) for t in live]}'); ok = False
old_tags = {(t.get('tag'), t.get('revisionName')) for t in tb if t.get('tag')}
new_tags = {(t.get('tag'), t.get('revisionName')) for t in ta if t.get('tag')}
if not old_tags <= new_tags:
    print(f'NG: 既存タグが変わっています: {sorted(old_tags - new_tags)}'); ok = False
mine = [t for t in ta if t.get('tag') == tag]
if len(mine) != 1 or mine[0].get('revisionName') != new_rev or mine[0].get('percent'):
    print(f'NG: タグ {tag} が新リビジョン（トラフィック 0%）を指していません'); ok = False
if not rev['spec']['containers'][0]['image'].endswith(digest):
    print('NG: 新リビジョンのイメージ digest が一致しません'); ok = False
env = {e['name']: e.get('valueFrom') for e in rev['spec']['containers'][0].get('env') or []}
for n, s in (('GEMINI_RECOMMEND_API_KEY', 'm4-preview-recommend-key'), ('MAPS_AGENT_TOOLS_API_KEY', 'm4-preview-maps-key'),
             ('M4_BENCH_TOKEN', 'm4-preview-bench-token')):
    ref = ((env.get(n) or {}).get('secretKeyRef') or {}).get('name')
    if ref != s:
        print(f'NG: {n} が Secret {s} の参照になっていません'); ok = False
for n in ('NEW_SHOP_FLOW', 'GIT_SHA'):
    if n not in env:
        print(f'NG: 環境変数 {n} がありません'); ok = False
open(f'{work}/url', 'w').write((mine[0].get('url') if mine else '') or '')
print(f'    本番トラフィック: {base_rev} 100%（変更なし）／既存タグ: 変更なし／タグ {tag} → {new_rev}（0%）／キーは Secret 参照')
sys.exit(0 if ok else 1)
PYEOF
URL="$(cat "${WORK}/url")"
code_health="$(curl -s -o /dev/null -w '%{http_code}' "${URL}/health")"
code_bench="$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{"query":"x","method":"scope"}' "${URL}/api/m4/bench")"
echo "    ${URL}/health → ${code_health}（200 なら正常）"
echo "    ${URL}/api/m4/bench（トークンなし）→ ${code_bench}（403 なら有効かつ保護されている）"
[ "${code_health}" = "200" ] && [ "${code_bench}" = "403" ] || { echo "NG: 事後確認に失敗しました（トラフィックは変更していません）" >&2; exit 1; }
echo "完了: プレビュー（バックエンド）${URL}"
echo "      プレビュー（フロント）https://travel-sp-git-preview-m4s10-mirais-projects-87257550.vercel.app/concierge/"
