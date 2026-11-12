#!/usr/bin/env bash
# =====================================================================
# speed-clean 検証リビジョンの隔離デプロイ（Cloud Shell で1回だけ実行）
#
#   bash deploy_speedclean1.sh
#
# 何をするか:
#   1. 事前検証（どれか1つでも不一致なら、何も変更せずに停止）
#      - 本番トラフィックが travel-sp-base-00060-car に 100%、latestRevision 追従なし
#      - 検証タグ speedclean1・リビジョン名・イメージタグが未使用
#      - 00060-car のイメージ digest と Artifact Registry のタグ（33秒版 SHA の先頭 7〜40 文字）を照合
#      - 現行サービスのテンプレート設定が 00060-car と同一（イメージ以外。値はハッシュで比較し表示しない）
#   2. GitHub の固定コミット speed-clean-backend をチェックアウト（HEAD が固定 SHA と完全一致）、
#      docker build → Artifact Registry へ push → digest を記録
#   3. デプロイ直前にトラフィックを再検査 → --no-traffic --tag=speedclean1 で新リビジョンのみ作成
#   4. 事後検証: 本番 100% 維持・既存タグ不変・新リビジョンの digest／設定・/health・CORS・Preview URL
#
# 変更しないもの: 本番トラフィック、既存タグ、Secrets、環境変数、IAM、Vercel Production。
# 失敗時に本番トラフィックを動かす「リカバリー」は一切行わない。
# =====================================================================
set -euo pipefail

PROJECT_ID="ai-avator-492205"
REGION="us-central1"
SERVICE="travel-sp-base"
PROD_REVISION="travel-sp-base-00060-car"
BASE_SHA="8d30e554f004957996a871b79b2c0b177a5e3e47"          # 33秒版（本番 A）
BACKEND_BRANCH="speed-clean-backend"
BACKEND_SHA="7655ca04816cface169e7c26d8c118d5f36b00a6"       # 検証バックエンド（固定）
TAG="speedclean1"
REVISION_SUFFIX="sc-${BACKEND_SHA:0:7}"
REVISION_NAME="${SERVICE}-${REVISION_SUFFIX}"
AR_REPO_PATH="${REGION}-docker.pkg.dev/${PROJECT_ID}/${SERVICE}/${SERVICE}"
IMAGE_TAG="speedclean-${BACKEND_SHA}"
IMAGE="${AR_REPO_PATH}:${IMAGE_TAG}"
REPO_URL="https://github.com/mirai-gpro/Travel-sp.git"
EXPECTED_TAG_URL="https://${TAG}---travel-sp-base-fmfxldo6kq-uc.a.run.app"   # speed-clean-web が接続する URL
PREVIEW_ORIGIN="https://travel-sp-git-speed-clean-web-mirais-projects-87257550.vercel.app"
DOCUMENTED_PROD_DIGEST="sha256:1adbdd9848efab8efd6c2117bad62533f8e85673cec97fd49102c1586877dd25"

WORK="$(mktemp -d)"
cleanup() { rm -rf "${WORK}"; }
trap cleanup EXIT

log()  { printf '\n[%s] %s\n' "$(date -u +%H:%M:%SZ)" "$*"; }
ok()   { printf '  OK  %s\n' "$*"; }
die()  { printf '\n  STOP: %s\n  （本番・既存タグには何も変更していません）\n' "$*" >&2; exit 1; }
fail_after_deploy() { printf '\n  NG: %s\n  検証リビジョンは 0%% トラフィックのままです。本番トラフィックは変更していません。合格ではありません。\n' "$*" >&2; exit 2; }

G=(--project="${PROJECT_ID}" --region="${REGION}")

# ---------------------------------------------------------------------
# JSON 判定（python3。秘密の値は出力しない）
# ---------------------------------------------------------------------
PY="${WORK}/check.py"
cat > "${PY}" <<'PYEOF'
import hashlib, json, sys

def load(p):
    with open(p) as f:
        return json.load(f)

def traffic_entries(svc):
    out = []
    for t in (svc.get('spec', {}).get('traffic') or []):
        out.append({
            'revisionName': t.get('revisionName'),
            'percent': int(t.get('percent') or 0),
            'tag': t.get('tag'),
            'latestRevision': bool(t.get('latestRevision')),
        })
    return sorted(out, key=lambda x: json.dumps(x, sort_keys=True))

IGNORED_ANNOTATIONS = {
    'client.knative.dev/user-image', 'run.googleapis.com/client-name', 'run.googleapis.com/client-version',
    'serving.knative.dev/creator', 'serving.knative.dev/lastModifier', 'run.googleapis.com/operation-id',
    'serving.knative.dev/creationTimestamp', 'run.googleapis.com/urls', 'client.knative.dev/nonce',
}

def h(v):
    return hashlib.sha256(json.dumps(v, sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:16]

def settings(template_metadata, template_spec):
    """リビジョン設定の比較用表現（イメージ・自動付与の注釈は除く）。値はハッシュ化"""
    ann = {k: v for k, v in (template_metadata.get('annotations') or {}).items() if k not in IGNORED_ANNOTATIONS}
    spec = json.loads(json.dumps(template_spec))
    containers = spec.get('containers') or []
    for c in containers:
        c.pop('image', None)
        c.pop('name', None)
    env = {}
    for c in containers:
        for e in c.pop('env', None) or []:
            env[e.get('name')] = h({k: v for k, v in e.items() if k != 'name'})
    flat = {}
    for k, v in sorted(ann.items()):
        flat[f'annotation:{k}'] = h(v)
    for k, v in sorted(env.items()):
        flat[f'env:{k}'] = v
    for k, v in sorted(spec.items()):
        if k == 'containers':
            for i, c in enumerate(containers):
                for ck, cv in sorted(c.items()):
                    flat[f'container[{i}]:{ck}'] = h(cv)
        else:
            flat[f'spec:{k}'] = h(v)
    return flat

def diff_settings(a, b):
    keys = sorted(set(a) | set(b))
    return [k for k in keys if a.get(k) != b.get(k)]

cmd = sys.argv[1]

if cmd == 'traffic':          # 本番トラフィックの前提確認
    svc, prod, tag = load(sys.argv[2]), sys.argv[3], sys.argv[4]
    tr = traffic_entries(svc)
    problems = []
    if any(t['latestRevision'] for t in tr):
        problems.append('latestRevision: true の traffic 項目がある（新規デプロイで経路が変わる）')
    total = sum(t['percent'] for t in tr if t['revisionName'] == prod)
    if total != 100:
        problems.append(f'{prod} のトラフィックが 100% ではない（{total}%）')
    others = [t for t in tr if t['percent'] > 0 and t['revisionName'] != prod]
    if others:
        problems.append('本番以外にトラフィックがある: ' + ', '.join(f"{t['revisionName']}={t['percent']}%" for t in others))
    if any(t['tag'] == tag for t in tr):
        problems.append(f'タグ {tag} は既に使用中')
    for t in tr:
        print(f"    traffic: revision={t['revisionName']} percent={t['percent']} tag={t['tag']} latest={t['latestRevision']}")
    if problems:
        print('PROBLEMS:' + ' / '.join(problems))
        sys.exit(1)

elif cmd == 'traffic_json':   # 比較用の正規化
    print(json.dumps(traffic_entries(load(sys.argv[2])), sort_keys=True))

elif cmd == 'post_traffic':   # 事後: 既存項目が不変で、追加は検証タグ 0% のみ
    pre, svc, prod, tag, newrev = json.loads(open(sys.argv[2]).read()), load(sys.argv[3]), *sys.argv[4:7]
    post = traffic_entries(svc)
    problems = []
    added = [t for t in post if t not in pre]
    removed = [t for t in pre if t not in post]
    if removed:
        problems.append(f'既存の traffic 項目が変化/消失: {removed}')
    if len(added) != 1 or added[0] != {'revisionName': newrev, 'percent': 0, 'tag': tag, 'latestRevision': False}:
        problems.append(f'追加項目が想定と違う: {added}')
    if sum(t['percent'] for t in post if t['revisionName'] == prod) != 100:
        problems.append(f'{prod} が 100% ではない')
    for t in post:
        print(f"    traffic: revision={t['revisionName']} percent={t['percent']} tag={t['tag']} latest={t['latestRevision']}")
    if problems:
        print('PROBLEMS:' + ' / '.join(problems))
        sys.exit(1)

elif cmd == 'tag_url':
    svc, tag = load(sys.argv[2]), sys.argv[3]
    for t in (svc.get('status', {}).get('traffic') or []):
        if t.get('tag') == tag:
            print(t.get('url', ''))
            break

elif cmd == 'rev_settings_vs_template':   # 本番リビジョン vs 現行サービステンプレート
    rev, svc = load(sys.argv[2]), load(sys.argv[3])
    a = settings(rev.get('metadata', {}), rev.get('spec', {}))
    tmpl = svc.get('spec', {}).get('template', {})
    b = settings(tmpl.get('metadata', {}), tmpl.get('spec', {}))
    d = diff_settings(a, b)
    print(f'    比較項目数: {len(a)}（値は表示しない）')
    if d:
        print('PROBLEMS:設定が異なる項目: ' + ', '.join(d))
        sys.exit(1)

elif cmd == 'rev_settings_vs_rev':
    a = settings(load(sys.argv[2]).get('metadata', {}), load(sys.argv[2]).get('spec', {}))
    b = settings(load(sys.argv[3]).get('metadata', {}), load(sys.argv[3]).get('spec', {}))
    d = diff_settings(a, b)
    print(f'    比較項目数: {len(a)}（値は表示しない）')
    if d:
        print('PROBLEMS:設定が異なる項目: ' + ', '.join(d))
        sys.exit(1)

elif cmd == 'rev_image':
    rev = load(sys.argv[2])
    print(rev['spec']['containers'][0]['image'])
    print(rev.get('status', {}).get('imageDigest', ''))

elif cmd == 'prod_tags':      # AR のタグのうち digest が一致し、33秒版 SHA の先頭 7〜40 文字であるもの
    tags, digest, base_sha = load(sys.argv[2]), sys.argv[3], sys.argv[4]
    found_any, valid = [], []
    for t in tags:
        ver = t.get('version', '')
        name = t.get('tag', '').rsplit('/', 1)[-1]
        if ver.endswith(digest):
            found_any.append(name)
            if 7 <= len(name) <= 40 and all(c in '0123456789abcdef' for c in name) and base_sha.startswith(name):
                valid.append(name)
    print('    digest に付いたタグ: ' + (', '.join(found_any) or '(なし)'))
    if not valid:
        print(f'PROBLEMS:{digest} に 33秒版 SHA {base_sha} の先頭（7〜40文字）と一致するタグがない')
        sys.exit(1)
    print('    33秒版 SHA と一致するタグ: ' + ', '.join(valid))
PYEOF

check() { python3 "${PY}" "$@"; }

# =====================================================================
log "0. 実行環境"
ACCOUNT="$(gcloud config get-value account 2>/dev/null || true)"
[ -n "${ACCOUNT}" ] || die "gcloud にログインしていません"
ok "gcloud アカウント: ${ACCOUNT} / project=${PROJECT_ID} region=${REGION} service=${SERVICE}"
command -v docker >/dev/null || die "docker がありません"
command -v git >/dev/null || die "git がありません"

# =====================================================================
log "1. 事前検証（読み取りのみ）"
gcloud run services describe "${SERVICE}" "${G[@]}" --format=json > "${WORK}/svc_pre.json"
check traffic "${WORK}/svc_pre.json" "${PROD_REVISION}" "${TAG}" || die "本番トラフィックの前提が違います（上記 PROBLEMS）"
check traffic_json "${WORK}/svc_pre.json" > "${WORK}/traffic_pre.json"
ok "本番トラフィック: ${PROD_REVISION} 100%、latestRevision 追従なし、タグ ${TAG} 未使用"

if gcloud run revisions describe "${REVISION_NAME}" "${G[@]}" --format='value(metadata.name)' >/dev/null 2>&1; then
  die "リビジョン名 ${REVISION_NAME} は既に存在します"
fi
ok "リビジョン名 ${REVISION_NAME} は未使用"

gcloud run revisions describe "${PROD_REVISION}" "${G[@]}" --format=json > "${WORK}/rev_prod.json"
mapfile -t PROD_IMG < <(check rev_image "${WORK}/rev_prod.json")
PROD_IMAGE_REF="${PROD_IMG[0]}"; PROD_DIGEST_FULL="${PROD_IMG[1]:-}"
PROD_DIGEST="${PROD_DIGEST_FULL##*@}"
[ -n "${PROD_DIGEST}" ] || die "${PROD_REVISION} の imageDigest を取得できません"
echo "    本番イメージ参照: ${PROD_IMAGE_REF}"
echo "    本番 digest:      ${PROD_DIGEST}"
if [ "${PROD_DIGEST}" != "${DOCUMENTED_PROD_DIGEST}" ]; then
  die "本番 digest が引継ぎ書の記録（${DOCUMENTED_PROD_DIGEST}）と異なります。状況を確認してください"
fi
ok "本番 digest は引継ぎ書の記録と一致"
gcloud artifacts docker tags list "${AR_REPO_PATH}" --project="${PROJECT_ID}" --format=json > "${WORK}/ar_tags.json"
check prod_tags "${WORK}/ar_tags.json" "${PROD_DIGEST}" "${BASE_SHA}" || die "Artifact Registry のタグ照合に失敗"
ok "本番 digest は Artifact Registry 上で 33秒版 SHA のタグと一致"

check rev_settings_vs_template "${WORK}/rev_prod.json" "${WORK}/svc_pre.json" \
  || die "現行サービスのテンプレート設定が ${PROD_REVISION} と異なります。--no-traffic デプロイでも差分が新リビジョンに入るため停止します（上記の項目名を確認してください）"
ok "現行テンプレート設定 = ${PROD_REVISION} の設定（イメージ以外。環境変数・Secrets・CPU/メモリ・同時実行数・タイムアウト・min/max・SA・VPC 等）"

if gcloud artifacts docker images describe "${IMAGE}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
  die "イメージタグ ${IMAGE_TAG} は既に存在します（上書きしません）"
fi
ok "イメージタグ ${IMAGE_TAG} は未使用"

# =====================================================================
log "2. 固定コミットの取得とビルド"
SRC="${WORK}/src"
git init -q "${SRC}"
git -C "${SRC}" remote add origin "${REPO_URL}"
if ! GIT_TERMINAL_PROMPT=0 git -C "${SRC}" fetch -q --depth=20 origin "${BACKEND_BRANCH}"; then
  if [ -n "${GITHUB_TOKEN:-}" ]; then
    AUTH="$(printf 'x-access-token:%s' "${GITHUB_TOKEN}" | base64 -w0)"
    GIT_TERMINAL_PROMPT=0 git -C "${SRC}" -c "http.extraHeader=Authorization: Basic ${AUTH}" fetch -q --depth=20 origin "${BACKEND_BRANCH}" \
      || die "GitHub から ${BACKEND_BRANCH} を取得できません"
  else
    die "GitHub から取得できません。非公開リポジトリの場合は GITHUB_TOKEN=<読み取り用トークン> bash $0 で再実行してください"
  fi
fi
git -C "${SRC}" checkout -q "${BACKEND_SHA}" || die "固定 SHA ${BACKEND_SHA} が ${BACKEND_BRANCH} の履歴にありません"
HEAD_SHA="$(git -C "${SRC}" rev-parse HEAD)"
[ "${HEAD_SHA}" = "${BACKEND_SHA}" ] || die "HEAD ${HEAD_SHA} が固定 SHA と不一致"
REMOTE_TIP="$(git -C "${SRC}" rev-parse FETCH_HEAD)"
[ "${REMOTE_TIP}" = "${BACKEND_SHA}" ] || die "${BACKEND_BRANCH} の先端（${REMOTE_TIP}）が固定 SHA と違います。想定外の push があります"
git -C "${SRC}" merge-base --is-ancestor "${BASE_SHA}" "${HEAD_SHA}" || die "固定 SHA が 33秒版 ${BASE_SHA} から派生していません"
[ -z "$(git -C "${SRC}" status --porcelain)" ] || die "作業ツリーが clean ではありません"
if ! git -C "${SRC}" diff --quiet "${BASE_SHA}" "${HEAD_SHA}" -- support-base/Dockerfile support-base/requirements.txt support-base/prompts support-base/templates support-base/support_core.py support-base/long_term_memory.py; then
  die "Dockerfile / requirements / prompts / templates / support_core / long_term_memory が 33秒版から変わっています"
fi
echo "    33秒版からの変更ファイル:"; git -C "${SRC}" diff --stat "${BASE_SHA}" "${HEAD_SHA}" | sed 's/^/      /'
ok "HEAD=${HEAD_SHA}（固定 SHA と一致、clean、33秒版から派生、Dockerfile/依存は不変）"

gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet >/dev/null 2>&1
docker build -q -t "${IMAGE}" "${SRC}/support-base" >/dev/null || die "docker build に失敗"
docker push -q "${IMAGE}" >/dev/null || die "docker push に失敗"
NEW_DIGEST="$(gcloud artifacts docker images describe "${IMAGE}" --project="${PROJECT_ID}" --format='value(image_summary.digest)')"
[ -n "${NEW_DIGEST}" ] || die "push したイメージの digest を取得できません"
ok "ビルド完了: ${IMAGE}"
ok "digest: ${NEW_DIGEST}"

# =====================================================================
log "3. デプロイ直前の再検査 → --no-traffic デプロイ"
gcloud run services describe "${SERVICE}" "${G[@]}" --format=json > "${WORK}/svc_pre2.json"
check traffic "${WORK}/svc_pre2.json" "${PROD_REVISION}" "${TAG}" >/dev/null || die "デプロイ直前に本番トラフィックの前提が変わりました"
[ "$(check traffic_json "${WORK}/svc_pre2.json")" = "$(cat "${WORK}/traffic_pre.json")" ] || die "デプロイ直前に traffic 設定が変化しました"
check rev_settings_vs_template "${WORK}/rev_prod.json" "${WORK}/svc_pre2.json" >/dev/null || die "デプロイ直前にテンプレート設定が変化しました"
ok "前提は変化なし"

# イメージ以外の設定は現行テンプレート（= 00060-car と同一を確認済み）を引き継ぐ。--set-env-vars 等は使わない
gcloud run deploy "${SERVICE}" "${G[@]}" \
  --image="${AR_REPO_PATH}@${NEW_DIGEST}" \
  --no-traffic \
  --tag="${TAG}" \
  --revision-suffix="${REVISION_SUFFIX}" \
  --quiet

# =====================================================================
log "4. 事後検証"
gcloud run services describe "${SERVICE}" "${G[@]}" --format=json > "${WORK}/svc_post.json"
check post_traffic "${WORK}/traffic_pre.json" "${WORK}/svc_post.json" "${PROD_REVISION}" "${TAG}" "${REVISION_NAME}" \
  || fail_after_deploy "traffic の事後検証に失敗"
ok "本番 ${PROD_REVISION} は 100% のまま、既存タグ不変、追加は ${TAG} → ${REVISION_NAME}（0%）のみ"

gcloud run revisions describe "${REVISION_NAME}" "${G[@]}" --format=json > "${WORK}/rev_new.json"
mapfile -t NEW_IMG < <(check rev_image "${WORK}/rev_new.json")
[ "${NEW_IMG[1]##*@}" = "${NEW_DIGEST}" ] || fail_after_deploy "新リビジョンの digest（${NEW_IMG[1]:-}）がビルドした digest と不一致"
ok "新リビジョンの digest = ビルドした digest"
check rev_settings_vs_rev "${WORK}/rev_prod.json" "${WORK}/rev_new.json" || fail_after_deploy "新リビジョンの設定が ${PROD_REVISION} と異なる"
ok "新リビジョンの設定 = ${PROD_REVISION}（イメージ以外）"

TAG_URL="$(check tag_url "${WORK}/svc_post.json" "${TAG}")"
[ -n "${TAG_URL}" ] || fail_after_deploy "タグ URL を取得できません"
echo "    タグ URL: ${TAG_URL}"
[ "${TAG_URL}" = "${EXPECTED_TAG_URL}" ] || fail_after_deploy "タグ URL がフロント（speed-clean-web）の接続先 ${EXPECTED_TAG_URL} と違います"
ok "タグ URL = speed-clean-web の接続先"

HEALTH_OK=""
for i in 1 2 3 4 5 6; do
  if curl -sf --max-time 30 "${TAG_URL}/health" -o "${WORK}/health.json"; then HEALTH_OK=1; break; fi
  sleep 10
done
[ -n "${HEALTH_OK}" ] || fail_after_deploy "/health が応答しません"
python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print('    /health:', d.get('status'), d.get('services'))" "${WORK}/health.json"
ok "/health 正常"

ACAO="$(curl -s --max-time 30 -o /dev/null -D - -H "Origin: ${PREVIEW_ORIGIN}" "${TAG_URL}/health" | tr -d '\r' | awk -F': ' 'tolower($1)=="access-control-allow-origin"{print $2}' | head -1)"
[ "${ACAO}" = "${PREVIEW_ORIGIN}" ] || fail_after_deploy "検証タグが Preview origin を CORS 許可していません（${ACAO:-なし}）"
ok "CORS: ${PREVIEW_ORIGIN} を許可"

PREVIEW_STATUS="$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 "${PREVIEW_ORIGIN}/concierge" || true)"
case "${PREVIEW_STATUS}" in
  200|304) ok "Vercel Preview は応答あり（HTTP ${PREVIEW_STATUS}）: ${PREVIEW_ORIGIN}/concierge" ;;
  401|403) echo "  注意: Vercel Preview は存在するが保護されています（HTTP ${PREVIEW_STATUS}）。ブラウザで Vercel にログインして開いてください" ;;
  *)       echo "  注意: Vercel Preview に到達できません（HTTP ${PREVIEW_STATUS}）。Vercel の speed-clean-web デプロイ状況を確認してください" ;;
esac

log "完了（検証リビジョンのみ作成。本番トラフィックは ${PROD_REVISION} 100% のまま）"
cat <<EOF
  検証リビジョン : ${REVISION_NAME}
  イメージ       : ${AR_REPO_PATH}@${NEW_DIGEST}
  タグ URL       : ${TAG_URL}
  フロント       : ${PREVIEW_ORIGIN}/concierge   （speed-clean-web、接続先 = タグ URL）
  計測           : 試験後に measure_speedclean.sh を実行
EOF
