#!/usr/bin/env bash
# =====================================================================
# Gate M3 — フロー S 統合 PoC 実測（Cloud Shell・本番非接触）
#
#   bash ~/gate_m3_flow_s.sh 3
#
# 通常 10 クエリ × N 回。1 試行で 33（元の33秒版）/ D / S7 / S10 を順に実行（1 試行 約 1 分）
# - 固定 SHA 40c32f0 のコードをそのまま使う。キー入力は AQ キー 1 回だけ（非表示）
#   Google Maps 側（Agent Tools・Place Details・Geocoding・33秒版 Places）は本番リビジョンの Places キーをプロセス内で読む
# - 画面出力は ~/m3_output.txt にも保存。結果（LLM 出力・place ID・時刻のみ）は ~/m3_results.json（試行ごとに上書き保存）
# - Cloud Run・トラフィック・本番環境変数には一切触れない
# =====================================================================
set -euo pipefail
PROJECT_ID="ai-avator-492205"
REGION="us-central1"
KEY_REVISION="travel-sp-base-00060-car"
BRANCH="feature/new-shop-recommendation"
EXPECTED_SHA="40c32f0ab74993a2d411ea2a684a19414696130c"
REPEAT="${1:-1}"
case "${REPEAT}" in 1|2|3) ;; *) echo "繰り返し回数は 1〜3 で指定してください（指定値: ${REPEAT}）" >&2; exit 1;; esac
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

echo "[3/3] 推薦・説明・選択 LLM 用 AQ キーを入力してください（表示されません。Enter で確定）"
read -rs AQ_KEY_INPUT
echo
[ -n "${AQ_KEY_INPUT}" ] || { echo "キーが空です" >&2; exit 1; }
cd "${WORK}/src/support-base"
GEMINI_RECOMMEND_API_KEY="${AQ_KEY_INPUT}" GIT_SHA="${EXPECTED_SHA}" M3_RESULTS="${HOME}/m3_results.json" \
  "${WORK}/venv/bin/python" -I - "${KEY_REVISION}" "${PROJECT_ID}" "${REGION}" "${REPEAT}" <<'PYEOF' 2>&1 | tee "${HOME}/m3_output.txt"
import json, logging, os, runpy, subprocess, sys
sys.path.insert(0, os.getcwd())
rev, project, region, repeat = sys.argv[1:5]
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
os.environ['GOOGLE_GEOCODING_API_KEY'] = os.environ.get('GOOGLE_GEOCODING_API_KEY') or pkey
os.environ['MAPS_AGENT_TOOLS_API_KEY'] = pkey
from new_shop_recommendation.redact import redact, register_secret
register_secret(pkey)
register_secret(os.environ.get('GEMINI_RECOMMEND_API_KEY', ''))
class _RedactFilter(logging.Filter):
    def filter(self, record):
        record.msg = redact(record.getMessage()); record.args = ()
        return True
logging.basicConfig(level=logging.ERROR)
for h in logging.getLogger().handlers:
    h.addFilter(_RedactFilter())
sys.argv = ['gate_m3', '--repeat', repeat]
runpy.run_module('new_shop_recommendation.poc.gate_m3_flow_s', run_name='__main__')
PYEOF
unset AQ_KEY_INPUT
