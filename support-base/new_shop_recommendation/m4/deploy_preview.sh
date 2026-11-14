#!/usr/bin/env bash
# =====================================================================
# M4 プレビュー環境の隔離デプロイ（Cloud Shell）
#
#   bash ~/m4_deploy_preview.sh
#
# - バックエンド固定 SHA（preview-m4s10-backend）をビルドし、既存サービス travel-sp-base に
#   「トラフィック 0%・タグ m4s10」の別リビジョンとして追加する。本番のトラフィック・本番リビジョンは変更しない
# - 新リビジョンにだけ次の環境変数を追加する（本番リビジョンの環境変数は変更しない）
#     NEW_SHOP_FLOW=S10 / GEMINI_RECOMMEND_API_KEY（AQ キー、非表示入力）/
#     MAPS_AGENT_TOOLS_API_KEY（本番リビジョンの Places キーをプロセス内で読む。M3 と同じ）/
#     M4_BENCH_TOKEN（このスクリプトが乱数で生成し ~/.m4_bench_token に保存、権限 600）/ GIT_SHA
# - 事前確認で前提が違えばデプロイしない。事後確認に失敗しても、トラフィックを変える復旧はしない（停止して報告）
# - キーは画面・ログ・ファイル（トークン以外）に出さない
# =====================================================================
set -euo pipefail
PROJECT_ID="ai-avator-492205"
REGION="us-central1"
SERVICE="travel-sp-base"
BASE_REVISION="travel-sp-base-00060-car"
TAG="m4s10"
BRANCH="preview-m4s10-backend"
EXPECTED_SHA="27642679fd69cb5fe3f1147a3bf554418051c4f7"
AR_IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${SERVICE}/${SERVICE}"
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT
GC=(--project="${PROJECT_ID}" --region="${REGION}")

echo "[1/6] 事前確認（読み取りのみ）"
gcloud run services describe "${SERVICE}" "${GC[@]}" --format=json > "${WORK}/svc_before.json"
gcloud run revisions describe "${BASE_REVISION}" "${GC[@]}" --format=json > "${WORK}/base_rev.json"
python3 - "${WORK}/svc_before.json" "${WORK}/base_rev.json" "${BASE_REVISION}" "${TAG}" <<'PYEOF'
import json, sys
svc, base = json.load(open(sys.argv[1])), json.load(open(sys.argv[2]))
base_rev, tag = sys.argv[3], sys.argv[4]
traffic = svc.get('status', {}).get('traffic') or []
live = [t for t in traffic if t.get('percent')]
if len(live) != 1 or live[0].get('revisionName') != base_rev or live[0].get('percent') != 100:
    sys.exit(f'停止: 本番トラフィックが {base_rev} 100% ではありません: {[(t.get("revisionName"), t.get("percent")) for t in live]}')
if any(t.get('tag') == tag for t in traffic):
    sys.exit(f'停止: タグ {tag} は既に使われています（上書きしません）')
benv = base['spec']['containers'][0].get('env') or []
if any('valueFrom' in e for e in benv):
    sys.exit('停止: 本番リビジョンが Secret 参照の環境変数を使っています（このスクリプトの前提外）')
tenv = svc['spec']['template']['spec']['containers'][0].get('env') or []
bn, tn = sorted(e['name'] for e in benv), sorted(e['name'] for e in tenv)
extra = sorted(set(tn) - set(bn))
missing = sorted(set(bn) - set(tn))
if missing:
    sys.exit(f'停止: サービスの現在のテンプレートに本番リビジョンの環境変数が欠けています: {missing}')
def conf(spec):
    c = spec['containers'][0]
    return {'resources': c.get('resources'), 'ports': c.get('ports'), 'timeout': spec.get('timeoutSeconds'),
            'concurrency': spec.get('containerConcurrency'), 'sa': spec.get('serviceAccountName')}
tconf, bconf = conf(svc['spec']['template']['spec']), conf(base['spec'])
if tconf != bconf:
    sys.exit(f'停止: サービスの現在のテンプレートの設定（CPU・メモリ・ポート・タイムアウト・同時実行数・サービスアカウント）が本番リビジョンと異なります')
open(sys.argv[1] + '.extra', 'w').write(','.join(extra))
print(f'    本番トラフィック: {base_rev} 100%（タグ {tag} は未使用）')
print(f'    テンプレートにだけある環境変数（新リビジョンでは削除）: {extra or "なし"}')
print('    ※ 共通の環境変数の値は読み比べていません（本番キーを取り出さないため）。名前の一致だけ確認しています')
PYEOF
REMOVE_ENV="$(cat "${WORK}/svc_before.json.extra")"

echo "[2/6] ${BRANCH} を取得（固定 SHA ${EXPECTED_SHA:0:7}）"
git init -q "${WORK}/src"
git -C "${WORK}/src" remote add origin https://github.com/mirai-gpro/Travel-sp.git
GIT_TERMINAL_PROMPT=0 git -C "${WORK}/src" fetch -q --depth=5 origin "${BRANCH}" || { echo "GitHub から取得できません" >&2; exit 1; }
git -C "${WORK}/src" checkout -q "${EXPECTED_SHA}" || { echo "固定 SHA が見つかりません" >&2; exit 1; }
[ "$(git -C "${WORK}/src" rev-parse HEAD)" = "${EXPECTED_SHA}" ] || { echo "SHA 不一致" >&2; exit 1; }

echo "[3/6] イメージのビルドと push（タグ m4-${EXPECTED_SHA:0:12}）"
IMAGE="${AR_IMAGE}:m4-${EXPECTED_SHA:0:12}"
gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet > /dev/null 2>&1
docker build -q -t "${IMAGE}" "${WORK}/src/support-base" > /dev/null
docker push -q "${IMAGE}" > /dev/null
DIGEST="$(gcloud artifacts docker images describe "${IMAGE}" --format='value(image_summary.digest)')"
[ -n "${DIGEST}" ] || { echo "イメージ digest を取得できません" >&2; exit 1; }
echo "    digest: ${DIGEST}"

echo "[4/6] 推薦用 AQ キーを入力してください（表示されません。Enter で確定）"
read -rs AQ_KEY_INPUT
echo
[ -n "${AQ_KEY_INPUT}" ] || { echo "キーが空です" >&2; exit 1; }
umask 077
python3 -c "import secrets; print(secrets.token_urlsafe(32))" > "${HOME}/.m4_bench_token"
chmod 600 "${HOME}/.m4_bench_token"

echo "[5/6] デプロイ直前の再確認とデプロイ（--no-traffic --tag=${TAG}）"
gcloud run services describe "${SERVICE}" "${GC[@]}" --format=json > "${WORK}/svc_recheck.json"
python3 - "${WORK}/svc_before.json" "${WORK}/svc_recheck.json" <<'PYEOF'
import json, sys
a, b = (json.load(open(p)).get('status', {}).get('traffic') for p in sys.argv[1:3])
if a != b:
    sys.exit('停止: 事前確認の後にトラフィック設定が変わりました。デプロイしません')
PYEOF
# 環境変数の値はコマンドライン以外に出さない（画面・ファイルに書かない）。Places キーはプロセス内で読む
PLACES_KEY="$(python3 -c "import json,sys; print(next(e['value'] for e in json.load(open(sys.argv[1]))['spec']['containers'][0]['env'] if e['name']=='GOOGLE_PLACES_API_KEY'))" "${WORK}/base_rev.json")"
rm -f "${WORK}/base_rev.json"
[ -n "${PLACES_KEY}" ] || { echo "GOOGLE_PLACES_API_KEY を取得できません" >&2; exit 1; }
BENCH_TOKEN="$(cat "${HOME}/.m4_bench_token")"
REMOVE_ARGS=()
[ -n "${REMOVE_ENV}" ] && REMOVE_ARGS=(--remove-env-vars="${REMOVE_ENV}")
gcloud run deploy "${SERVICE}" "${GC[@]}" --platform=managed \
  --image="${AR_IMAGE}@${DIGEST}" --no-traffic --tag="${TAG}" --revision-suffix="m4s10-${EXPECTED_SHA:0:7}" \
  "${REMOVE_ARGS[@]}" \
  --update-env-vars="^@^NEW_SHOP_FLOW=S10@GEMINI_RECOMMEND_API_KEY=${AQ_KEY_INPUT}@MAPS_AGENT_TOOLS_API_KEY=${PLACES_KEY}@M4_BENCH_TOKEN=${BENCH_TOKEN}@GIT_SHA=${EXPECTED_SHA}" \
  --quiet > "${WORK}/deploy.log" 2>&1 || { echo "デプロイに失敗しました（トラフィックは変更していません）:" >&2; grep -v -i "key\|token" "${WORK}/deploy.log" | tail -n 20 >&2; exit 1; }
unset AQ_KEY_INPUT PLACES_KEY BENCH_TOKEN

echo "[6/6] 事後確認"
gcloud run services describe "${SERVICE}" "${GC[@]}" --format=json > "${WORK}/svc_after.json"
NEW_REV="${SERVICE}-m4s10-${EXPECTED_SHA:0:7}"
gcloud run revisions describe "${NEW_REV}" "${GC[@]}" --format=json > "${WORK}/new_rev.json"
python3 - "${WORK}/svc_before.json" "${WORK}/svc_after.json" "${WORK}/new_rev.json" "${BASE_REVISION}" "${TAG}" "${NEW_REV}" "${DIGEST}" <<'PYEOF'
import json, sys
before, after, rev = (json.load(open(p)) for p in sys.argv[1:4])
base_rev, tag, new_rev, digest = sys.argv[4:8]
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
    print(f'NG: タグ {tag} が新リビジョン（トラフィック 0%）を指していません: {mine}'); ok = False
img = rev['spec']['containers'][0]['image']
if not img.endswith(digest):
    print('NG: 新リビジョンのイメージ digest が一致しません'); ok = False
names = {e['name'] for e in rev['spec']['containers'][0].get('env') or []}
for n in ('NEW_SHOP_FLOW', 'GEMINI_RECOMMEND_API_KEY', 'MAPS_AGENT_TOOLS_API_KEY', 'M4_BENCH_TOKEN', 'GIT_SHA'):
    if n not in names:
        print(f'NG: 環境変数 {n} がありません'); ok = False
url = mine[0].get('url') if mine else ''
open(sys.argv[3] + '.url', 'w').write(url or '')
print(f'    本番トラフィック: {base_rev} 100%（変更なし）／既存タグ: 変更なし／タグ {tag} → {new_rev}（0%）')
sys.exit(0 if ok else 1)
PYEOF
URL="$(cat "${WORK}/new_rev.json.url")"
code_health="$(curl -s -o /dev/null -w '%{http_code}' "${URL}/health")"
code_bench="$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{"query":"x","method":"S10"}' "${URL}/api/m4/bench")"
echo "    ${URL}/health → ${code_health}（200 なら正常）"
echo "    ${URL}/api/m4/bench（トークンなし）→ ${code_bench}（403 なら有効かつ保護されている）"
[ "${code_health}" = "200" ] && [ "${code_bench}" = "403" ] || { echo "NG: 事後確認に失敗しました（トラフィックは変更していません）" >&2; exit 1; }
echo "完了: プレビュー（バックエンド）${URL}"
echo "      プレビュー（フロント）https://travel-sp-git-preview-m4s10-mirais-projects-87257550.vercel.app/concierge/"
