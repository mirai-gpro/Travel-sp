#!/usr/bin/env bash
# =====================================================================
# ショップ推薦エンジン v2 — PoC Step 1+2 ベンチ（Cloud Shell で実行。読み取り専用）
#
#   bash run_poc_step12.sh --list-models
#   bash run_poc_step12.sh --models gemini-2.5-flash --thinking-budgets 0,none --repeat 2
#
# - GitHub の shop-engine-v2 ブランチを一時ディレクトリに取得し、その SHA を記録して実行する。
# - API キーは本番リビジョン travel-sp-base-00060-car の環境変数から読み、このプロセス内だけで使う
#   （画面・ファイル・シェル履歴に出さない）。Cloud Run・トラフィック・設定は変更しない。
# - 実際の Gemini / Places を呼ぶため API 利用料が発生する（1 クエリあたり LLM 1 回＋Places 8〜16 回程度。
#   検索要と判断された場合は検索付き LLM がもう 1 回）。
# =====================================================================
set -euo pipefail
PROJECT_ID="ai-avator-492205"
REGION="us-central1"
KEY_REVISION="travel-sp-base-00060-car"
BRANCH="shop-engine-v2"
REPO_URL="https://github.com/mirai-gpro/Travel-sp.git"

WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

echo "[1/3] ${BRANCH} を取得"
git init -q "${WORK}/src"
git -C "${WORK}/src" remote add origin "${REPO_URL}"
if ! GIT_TERMINAL_PROMPT=0 git -C "${WORK}/src" fetch -q --depth=1 origin "${BRANCH}"; then
  if [ -n "${GITHUB_TOKEN:-}" ]; then
    AUTH="$(printf 'x-access-token:%s' "${GITHUB_TOKEN}" | base64 -w0)"
    GIT_TERMINAL_PROMPT=0 git -C "${WORK}/src" -c "http.extraHeader=Authorization: Basic ${AUTH}" fetch -q --depth=1 origin "${BRANCH}"
  else
    echo "GitHub から取得できません。非公開の場合は GITHUB_TOKEN=<読み取り用トークン> を付けて再実行してください" >&2; exit 1
  fi
fi
git -C "${WORK}/src" checkout -q FETCH_HEAD
SHA="$(git -C "${WORK}/src" rev-parse HEAD)"
echo "    SHA: ${SHA}"

echo "[2/3] Python 環境（google-genai / requests は本番 requirements と同じ版）"
python3 -m venv "${WORK}/venv"
"${WORK}/venv/bin/pip" install -q "google-genai==1.68.0" "requests==2.32.5" 2>&1 | grep -v -i notice || true

echo "[3/3] API キーを ${KEY_REVISION} から読み込み（表示しない）→ ベンチ実行"
gcloud run revisions describe "${KEY_REVISION}" --project="${PROJECT_ID}" --region="${REGION}" --format=json > "${WORK}/rev.json"
OUT_DIR="${HOME}/shop_engine_poc"
mkdir -p "${OUT_DIR}"
OUT="${OUT_DIR}/poc_$(date -u +%Y%m%dT%H%M%SZ).json"
cd "${WORK}/src/support-base"
POC_GIT_SHA="${SHA}" "${WORK}/venv/bin/python" - "${WORK}/rev.json" "${OUT}" "$@" <<'PYEOF'
import json, os, runpy, sys
rev_path, out = sys.argv[1], sys.argv[2]
env = {}
for c in json.load(open(rev_path))['spec']['containers']:
    for e in c.get('env') or []:
        if 'value' in e:
            env[e['name']] = e['value']
for k in ('GEMINI_API_KEY', 'GOOGLE_PLACES_API_KEY'):
    if not env.get(k):
        sys.exit(f'{k} がリビジョンの環境変数（平文値）にありません。Secret 参照の場合はこのスクリプトでは読めません')
    os.environ[k] = env[k]
del env
sys.path.insert(0, os.getcwd())
args = sys.argv[3:]
if '--list-models' not in args and '--out' not in args:
    args += ['--out', out]
sys.argv = ['poc_bench'] + args
runpy.run_module('shop_engine.poc_bench', run_name='__main__')
PYEOF
