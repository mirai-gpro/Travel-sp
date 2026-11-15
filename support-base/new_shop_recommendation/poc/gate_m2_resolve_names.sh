#!/usr/bin/env bash
# =====================================================================
# Gate M2 — Maps Experience Agent Tools resolveNames 実データ計測（Cloud Shell・本番非接触）
#
#   bash ~/gate_m2_resolve_names.sh
#
# 照合済み 132 件（推薦店 118）を入力し、locationBias あり／なし × バッチ／単独で計測。返った place を Place Details で照合
# - 固定 SHA 17448af のコードをそのまま使う。キー入力なし:
#   Google Maps 側（resolveNames・Place Details・Geocoding）はこれまでどおり本番リビジョンの Places キーをプロセス内で読む
# - Cloud Run・トラフィック・本番環境変数には一切触れない。結果は画面のみ
# =====================================================================
set -euo pipefail
PROJECT_ID="ai-avator-492205"
REGION="us-central1"
KEY_REVISION="travel-sp-base-00060-car"
BRANCH="feature/new-shop-recommendation"
EXPECTED_SHA="17448af3ffb041f4b483977e16f712ea0a9ad53a"
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

echo "[1/3] ${BRANCH} を取得（固定 SHA ${EXPECTED_SHA:0:7}）"
git init -q "${WORK}/src"
git -C "${WORK}/src" remote add origin https://github.com/mirai-gpro/Travel-sp.git
GIT_TERMINAL_PROMPT=0 git -C "${WORK}/src" fetch -q --depth=10 origin "${BRANCH}" || { echo "GitHub から取得できません" >&2; exit 1; }
git -C "${WORK}/src" checkout -q "${EXPECTED_SHA}" || { echo "固定 SHA が見つかりません" >&2; exit 1; }
[ "$(git -C "${WORK}/src" rev-parse HEAD)" = "${EXPECTED_SHA}" ] || { echo "SHA 不一致" >&2; exit 1; }
echo "    使用 SHA: $(git -C "${WORK}/src" rev-parse HEAD)"

echo "[2/3] 一時 Python 環境（requests==2.32.5 のみ）"
python3 -m venv "${WORK}/venv" || { echo "venv の作成に失敗" >&2; exit 1; }
"${WORK}/venv/bin/pip" install -q --disable-pip-version-check "requests==2.32.5" > "${WORK}/pip.log" 2>&1 \
  || { echo "requests のインストールに失敗:" >&2; tail -n 30 "${WORK}/pip.log" >&2; exit 1; }

echo "[3/3] 計測開始（本番リビジョンの Places キーを使用。キー入力は不要）"
cd "${WORK}/src/support-base"
GIT_SHA="${EXPECTED_SHA}" "${WORK}/venv/bin/python" -I - "${KEY_REVISION}" "${PROJECT_ID}" "${REGION}" <<'PYEOF'
import json, logging, os, runpy, subprocess, sys
sys.path.insert(0, os.getcwd())
rev, project, region = sys.argv[1:4]
p = subprocess.run(['gcloud', 'run', 'revisions', 'describe', rev, f'--project={project}', f'--region={region}',
                    '--format=json'], capture_output=True, text=True)
if p.returncode != 0:
    sys.exit(f'リビジョン {rev} を取得できません（gcloud 終了コード {p.returncode}）')
pkey = None
for c_ in json.loads(p.stdout)['spec']['containers']:
    for e in c_.get('env') or []:
        if e.get('name') == 'GOOGLE_PLACES_API_KEY' and 'value' in e:
            pkey = e['value']
del p
if not pkey:
    sys.exit('GOOGLE_PLACES_API_KEY を取得できません')
os.environ['GOOGLE_PLACES_API_KEY'] = pkey
os.environ['MAPS_AGENT_TOOLS_API_KEY'] = pkey
from new_shop_recommendation.redact import redact, register_secret
register_secret(pkey)
class _RedactFilter(logging.Filter):
    def filter(self, record):
        record.msg = redact(record.getMessage()); record.args = ()
        return True
logging.basicConfig(level=logging.WARNING)
for h in logging.getLogger().handlers:
    h.addFilter(_RedactFilter())
sys.argv = ['gate_m2']
runpy.run_module('new_shop_recommendation.poc.gate_m2_resolve_names', run_name='__main__')
PYEOF
