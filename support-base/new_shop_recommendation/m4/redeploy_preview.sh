#!/usr/bin/env bash
# =====================================================================
# M4 プレビューの入れ替え（Cloud Shell）— S10 本番化の後に使う
#
#   bash ~/m4_redeploy_preview.sh
#
# - 新リビジョンを「トラフィック 0%・タグ m4s10（付け替え）・最大 1 インスタンス」で追加する。本番トラフィックは変更しない
# - プレビューの Secret 参照（名前とバージョン）は今の m4s10 のリビジョンから写す（値は読まない）
# - 追加の後、サービスのテンプレートを本番リビジョンの設定へ戻す（0% のリビジョンをもう 1 つ追加）。
#   テンプレートに計測トークンやプレビュー用 Secret が残ると、次の CI のデプロイに引き継がれるため
# - 本番が最新のリビジョンに追従していた場合は、最後に追従へ戻す（本番は同じイメージ・設定のテンプレートのリビジョンになる）
# - 環境変数の値は GIT_SHA 以外読まない（名前と Secret 参照だけ）。ビルドは Cloud Build
# =====================================================================
set -euo pipefail
PROJECT_ID="ai-avator-492205"
REGION="us-central1"
SERVICE="travel-sp-base"
TAG="m4s10"
BRANCH="preview-m4s10-backend"
EXPECTED_SHA="76481cb09046c82897894de7a5a74f4473912f8d"
AR_IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${SERVICE}/${SERVICE}"
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT
GC=(--project="${PROJECT_ID}" --region="${REGION}")
SVC_FMT='json(status.traffic,spec.template.spec.containers[0].env[].name,spec.template.spec.containers[0].env[].valueFrom,spec.template.spec.containers[0].image)'
REV_FMT='json(spec.containers[0].env[].name,spec.containers[0].env[].valueFrom,spec.containers[0].image,metadata.annotations)'
PREVIEW_SECRETS='GEMINI_RECOMMEND_API_KEY=m4-preview-recommend-key MAPS_AGENT_TOOLS_API_KEY=m4-preview-maps-key M4_BENCH_TOKEN=m4-preview-bench-token'

echo "[1/5] 事前確認（読み取りのみ）"
gcloud run services describe "${SERVICE}" "${GC[@]}" --format="${SVC_FMT}" > "${WORK}/svc_before.json"
python3 - "${WORK}/svc_before.json" "${TAG}" "${WORK}" <<'PYEOF'
import json, sys
svc, tag, work = json.load(open(sys.argv[1])), sys.argv[2], sys.argv[3]
traffic = svc['status']['traffic']
live = [t for t in traffic if t.get('percent')]
if len(live) != 1 or live[0].get('percent') != 100:
    sys.exit('停止: 本番トラフィックが 1 つのリビジョンに 100% ではありません')
mine = [t for t in traffic if t.get('tag') == tag]
if len(mine) != 1 or mine[0].get('percent'):
    sys.exit(f'停止: タグ {tag} のプレビュー（0%）がありません')
open(f'{work}/prod_rev', 'w').write(live[0]['revisionName'])
open(f'{work}/follow', 'w').write('1' if live[0].get('latestRevision') else '0')
open(f'{work}/prev_rev', 'w').write(mine[0]['revisionName'])
print(f'    本番トラフィック: {live[0]["revisionName"]} 100%（{"最新に追従" if live[0].get("latestRevision") else "固定"}）／タグ {tag}: {mine[0]["revisionName"]}（0%）')
PYEOF
PROD_REV="$(cat "${WORK}/prod_rev")"; PREV_REV="$(cat "${WORK}/prev_rev")"; FOLLOW="$(cat "${WORK}/follow")"
gcloud run revisions describe "${PROD_REV}" "${GC[@]}" --format="${REV_FMT}" > "${WORK}/prod.json"
gcloud run revisions describe "${PREV_REV}" "${GC[@]}" --format="${REV_FMT}" > "${WORK}/prev.json"
# 本番の GIT_SHA だけを取り出す（ほかの値はファイルにも画面にも出さない）
PROD_GIT_SHA="$(gcloud run revisions describe "${PROD_REV}" "${GC[@]}" --format='json(spec.containers[0].env)' | python3 -c "
import json, sys
print(next((e.get('value') or '' for e in json.load(sys.stdin)['spec']['containers'][0].get('env') or [] if e['name'] == 'GIT_SHA'), ''))")"
python3 - "${WORK}/prod.json" "${WORK}/prev.json" "${PREVIEW_SECRETS}" "${WORK}" <<'PYEOF'
import json, sys
prod, prev, work = json.load(open(sys.argv[1])), json.load(open(sys.argv[2])), sys.argv[4]
want = dict(x.split('=') for x in sys.argv[3].split())
def refs(r):
    return {e['name']: ((e.get('valueFrom') or {}).get('secretKeyRef') or {}) for e in r['spec']['containers'][0].get('env') or []}
pv, pr = refs(prev), refs(prod)
args = []
for env_name, secret in want.items():
    r = pv.get(env_name) or {}
    if r.get('name') != secret or not r.get('key'):
        sys.exit(f'停止: プレビューの {env_name} が Secret {secret} の参照ではありません')
    args.append(f'{env_name}={secret}:{r["key"]}')
open(f'{work}/preview_secrets', 'w').write(','.join(args))
p_args = []
for env_name in ('GEMINI_RECOMMEND_API_KEY', 'MAPS_AGENT_TOOLS_API_KEY'):
    r = pr.get(env_name) or {}
    if not r.get('name') or not r.get('key') or r['name'].startswith('m4-preview-'):
        sys.exit(f'停止: 本番の {env_name} が本番用 Secret の参照ではありません')
    p_args.append(f'{env_name}={r["name"]}:{r["key"]}')
if 'M4_BENCH_TOKEN' in pr:
    sys.exit('停止: 本番に計測トークンが設定されています')
open(f'{work}/prod_secrets', 'w').write(','.join(p_args))
open(f'{work}/prod_image', 'w').write(prod['spec']['containers'][0]['image'])
open(f'{work}/prod_max', 'w').write((prod['metadata'].get('annotations') or {}).get('autoscaling.knative.dev/maxScale', ''))
print(f'    プレビューの Secret 参照: {", ".join(args)}')
print(f'    本番の Secret 参照: {", ".join(p_args)}（計測トークンなし）')
PYEOF
[ -n "${PROD_GIT_SHA}" ] || { echo "停止: 本番の GIT_SHA を取得できません" >&2; exit 1; }
PROD_MAX="$(cat "${WORK}/prod_max")"
[ -n "${PROD_MAX}" ] || { echo "停止: 本番の最大インスタンス数を取得できません" >&2; exit 1; }

echo "[2/5] ${BRANCH} を取得（固定 SHA ${EXPECTED_SHA:0:7}）し Cloud Build でビルド"
git init -q "${WORK}/src"
git -C "${WORK}/src" remote add origin https://github.com/mirai-gpro/Travel-sp.git
GIT_TERMINAL_PROMPT=0 git -C "${WORK}/src" fetch -q --depth=5 origin "${BRANCH}" || { echo "GitHub から取得できません" >&2; exit 1; }
git -C "${WORK}/src" checkout -q "${EXPECTED_SHA}" || { echo "固定 SHA が見つかりません" >&2; exit 1; }
[ "$(git -C "${WORK}/src" rev-parse HEAD)" = "${EXPECTED_SHA}" ] || { echo "SHA 不一致" >&2; exit 1; }
IMAGE="${AR_IMAGE}:m4-${EXPECTED_SHA:0:12}"
gcloud builds submit "${WORK}/src/support-base" --project="${PROJECT_ID}" --region="${REGION}" --tag="${IMAGE}" --quiet \
  > "${WORK}/build.log" 2>&1 || { echo "停止: Cloud Build に失敗しました（Cloud Run は未変更）:" >&2; tail -n 15 "${WORK}/build.log" >&2; exit 1; }
DIGEST="$(gcloud artifacts docker images describe "${IMAGE}" --format='value(image_summary.digest)')"
[ -n "${DIGEST}" ] || { echo "イメージ digest を取得できません" >&2; exit 1; }
AMD64_DIGEST="$(docker buildx imagetools inspect --raw "${AR_IMAGE}@${DIGEST}" 2>/dev/null </dev/null | python3 -c "import json,sys
d=json.load(sys.stdin)
print(next((m['digest'] for m in d.get('manifests') or [] if (m.get('platform') or {}).get('os')=='linux' and (m.get('platform') or {}).get('architecture')=='amd64'), ''))" || true)"
echo "    digest: ${DIGEST}（linux/amd64: ${AMD64_DIGEST:-単一イメージ}）"

echo "[3/5] デプロイ直前の再確認とプレビューの追加（--no-traffic --tag=${TAG}）"
gcloud run services describe "${SERVICE}" "${GC[@]}" --format="${SVC_FMT}" > "${WORK}/svc_recheck.json"
python3 - "${WORK}/svc_before.json" "${WORK}/svc_recheck.json" <<'PYEOF'
import json, sys
a, b = (json.load(open(p))['status']['traffic'] for p in sys.argv[1:3])
if a != b:
    sys.exit('停止: 事前確認の後にトラフィック設定が変わりました。デプロイしません')
PYEOF
NEW_REV="${SERVICE}-m4s10-${EXPECTED_SHA:0:7}"
gcloud run deploy "${SERVICE}" "${GC[@]}" --platform=managed \
  --image="${AR_IMAGE}@${DIGEST}" --no-traffic --tag="${TAG}" --revision-suffix="m4s10-${EXPECTED_SHA:0:7}" \
  --max-instances=1 --update-secrets="$(cat "${WORK}/preview_secrets")" \
  --update-env-vars="NEW_SHOP_FLOW=S10,GIT_SHA=${EXPECTED_SHA},M4_BENCH_MAX_CALLS=150" \
  --quiet > "${WORK}/deploy.log" 2>&1 || { echo "デプロイに失敗しました（トラフィックは変更していません）:" >&2; tail -n 20 "${WORK}/deploy.log" >&2; exit 1; }

TMPL_SUFFIX="tmpl-$(date +%m%d%H%M)"; TMPL_REV="${SERVICE}-${TMPL_SUFFIX}"
echo "[4/5] テンプレートを本番 ${PROD_REV} の設定へ戻す（0% のリビジョンを追加。トラフィックは変更しない）"
gcloud run services update "${SERVICE}" "${GC[@]}" --platform=managed --no-traffic \
  --image="$(cat "${WORK}/prod_image")" --max-instances="${PROD_MAX}" \
  --remove-secrets=M4_BENCH_TOKEN --remove-env-vars=M4_BENCH_MAX_CALLS \
  --update-secrets="$(cat "${WORK}/prod_secrets")" --update-env-vars="NEW_SHOP_FLOW=S10,GIT_SHA=${PROD_GIT_SHA}" \
  --revision-suffix="${TMPL_SUFFIX}" \
  --quiet > "${WORK}/restore.log" 2>&1 || { echo "NG: テンプレートを戻せませんでした（トラフィックは変更していません）。次の CI の前に連絡してください:" >&2; tail -n 20 "${WORK}/restore.log" >&2; exit 1; }

echo "[5/5] 事後確認"
gcloud run services describe "${SERVICE}" "${GC[@]}" --format="${SVC_FMT}" > "${WORK}/svc_after.json"
gcloud run revisions describe "${NEW_REV}" "${GC[@]}" --format="${REV_FMT}" > "${WORK}/new_rev.json"
python3 - "${WORK}/svc_before.json" "${WORK}/svc_after.json" "${WORK}/new_rev.json" "${WORK}/prod.json" "${TAG}" "${NEW_REV}" "${DIGEST}" "${AMD64_DIGEST}" "${WORK}" <<'PYEOF'
import json, sys
before, after, rev, prod = (json.load(open(p)) for p in sys.argv[1:5])
tag, new_rev, digest, amd64, work = sys.argv[5:10]
ok = True
live_b = [(t.get('revisionName'), t.get('percent')) for t in before['status']['traffic'] if t.get('percent')]
live_a = [(t.get('revisionName'), t.get('percent')) for t in after['status']['traffic'] if t.get('percent')]
if live_a != live_b:
    print('NG: 本番トラフィックが変わっています'); ok = False
others_b = {(t.get('tag'), t.get('revisionName')) for t in before['status']['traffic'] if t.get('tag') and t.get('tag') != tag}
others_a = {(t.get('tag'), t.get('revisionName')) for t in after['status']['traffic'] if t.get('tag') and t.get('tag') != tag}
if others_b != others_a:
    print('NG: ほかのタグが変わっています'); ok = False
mine = [t for t in after['status']['traffic'] if t.get('tag') == tag]
if len(mine) != 1 or mine[0].get('revisionName') != new_rev or mine[0].get('percent'):
    print(f'NG: タグ {tag} が新リビジョン（0%）を指していません'); ok = False
img = rev['spec']['containers'][0]['image']
if not (img.endswith(digest) or (amd64 and img.endswith(amd64))):
    print('NG: 新リビジョンのイメージが今回のビルドではありません'); ok = False
def refs(containers):
    return {e['name']: (((e.get('valueFrom') or {}).get('secretKeyRef') or {}).get('name')) for e in containers[0].get('env') or []}
rv = refs(rev['spec']['containers'])
for n, s in (('GEMINI_RECOMMEND_API_KEY', 'm4-preview-recommend-key'), ('MAPS_AGENT_TOOLS_API_KEY', 'm4-preview-maps-key'), ('M4_BENCH_TOKEN', 'm4-preview-bench-token')):
    if rv.get(n) != s:
        print(f'NG: プレビューの {n} が {s} の参照ではありません'); ok = False
tv, pv = refs(after['spec']['template']['spec']['containers']), refs(prod['spec']['containers'])
if tv != pv:
    print(f'NG: テンプレートが本番リビジョンと一致しません（名前・Secret 参照）: 余分 {sorted(set(tv) - set(pv))} / 不足 {sorted(set(pv) - set(tv))}'); ok = False
open(f'{work}/url', 'w').write((mine[0].get('url') if mine else '') or '')
if ok:
    print(f'    本番トラフィック: 変更なし／タグ {tag} → {new_rev}（0%）／テンプレート: 本番リビジョンと同じ（計測トークンなし）')
sys.exit(0 if ok else 1)
PYEOF
URL="$(cat "${WORK}/url")"
code_health="$(curl -s -o /dev/null -w '%{http_code}' "${URL}/health")"
code_bench="$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{"query":"x","method":"scope"}' "${URL}/api/m4/bench")"
echo "    ${URL}/health → ${code_health}（200 なら正常）／計測エンドポイント（トークンなし）→ ${code_bench}（403 なら保護されている）"
[ "${code_health}" = "200" ] && [ "${code_bench}" = "403" ] || { echo "NG: プレビューの事後確認に失敗しました（トラフィックは変更していません）" >&2; exit 1; }
if [ "${FOLLOW}" = "1" ]; then
  # 本番は最新のリビジョンに追従していた。--no-traffic のデプロイで固定に変わるため、追従に戻す。
  # 最新は今追加したテンプレートのリビジョン（本番と同じイメージ・設定）。名前・Secret 参照・GIT_SHA が本番と同じことを確かめてから戻す
  gcloud run revisions describe "${TMPL_REV}" "${GC[@]}" --format='json(spec.containers[0].env)' | python3 -c "
import json, sys
env = json.load(sys.stdin)['spec']['containers'][0].get('env') or []
prod = json.load(open('${WORK}/prod.json'))['spec']['containers'][0].get('env') or []
ref = lambda es: {e['name']: ((e.get('valueFrom') or {}).get('secretKeyRef') or {}).get('name') for e in es}
sha = next((e.get('value') for e in env if e['name'] == 'GIT_SHA'), None)
sys.exit(0 if ref(env) == ref(prod) and sha == '${PROD_GIT_SHA}' else 1)" \
    || { echo "NG: ${TMPL_REV} が本番と同じ設定ではないため、追従に戻しません（本番は ${PROD_REV} に固定のまま）" >&2; exit 1; }
  LATEST_READY="$(gcloud run services describe "${SERVICE}" "${GC[@]}" --format='value(status.latestReadyRevisionName)')"
  [ "${LATEST_READY}" = "${TMPL_REV}" ] || { echo "NG: 最新のリビジョンが ${TMPL_REV} ではないため、追従に戻しません（本番は ${PROD_REV} に固定のまま）" >&2; exit 1; }
  gcloud run services update-traffic "${SERVICE}" "${GC[@]}" --to-latest --quiet > /dev/null
  gcloud run services describe "${SERVICE}" "${GC[@]}" --format='json(status.traffic)' | python3 -c "
import json, sys
live = [t for t in json.load(sys.stdin)['status']['traffic'] if t.get('percent')]
print('    本番トラフィック:', [(t.get('revisionName'), t.get('percent'), '最新に追従' if t.get('latestRevision') else '固定') for t in live])
sys.exit(0 if len(live) == 1 and live[0].get('latestRevision') and live[0].get('percent') == 100 else 1)" \
    || { echo "NG: 追従に戻せませんでした" >&2; exit 1; }
fi
echo "完了: ${URL}（${NEW_REV}）"
