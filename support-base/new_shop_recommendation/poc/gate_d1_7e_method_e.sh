#!/usr/bin/env bash
# =====================================================================
# Gate D1.7E — 方式 E（Agent Tools 検索 1 位を直接採用・選択 LLM なし）を A・D と比較（隔離 PoC）
#
#   bash ~/gate_d1_7e_method_e.sh 3
#
# 通常 10 クエリ × N 回。1 試行で推薦 LLM 1 回・Agent Tools 検索 1 回。その同じ結果から
#   A（33秒版）/ D（選択 LLM あり）/ E（検索 1 位を直接採用）を作って比較する。
#
# - 固定 SHA 86e1838 のコードをそのまま使う。
# - 選択 LLM に渡すのは Agent Tools の summary だけ（Legacy Places の応答は LLM に送らない）。
# - API の有効化確認は読み取りのみ（gcloud services list）。有効化・キー設定の変更はしない。
# - AQ キーは非表示入力。Places / Agent Tools は本番リビジョンの既存 Places キーをプロセス内で読んで使う。
# - Cloud Run・トラフィック・本番環境変数には一切触れない。結果は画面のみ。
# =====================================================================
set -euo pipefail
PROJECT_ID="ai-avator-492205"
REGION="us-central1"
KEY_REVISION="travel-sp-base-00060-car"
BRANCH="feature/new-shop-recommendation"
EXPECTED_SHA="86e18386a1549abb6ee8ae307d2041ffb0b19803"
REPEAT="${1:-1}"
case "${REPEAT}" in 1|2|3) ;; *) echo "繰り返し回数は 1〜3 で指定してください（指定値: ${REPEAT}）。例: bash ~/gate_d1_7e_method_e.sh 3" >&2; exit 1;; esac
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

echo "[1/4] Maps Experience Agent Tools API（mapstools.googleapis.com）の有効化状態（読み取りのみ）"
ENABLED="$(gcloud services list --enabled --project="${PROJECT_ID}" \
  --filter="config.name=mapstools.googleapis.com" --format="value(config.name)" 2>/dev/null || true)"
if [ "${ENABLED}" = "mapstools.googleapis.com" ]; then
  echo "    有効"
else
  echo "    このプロジェクトでは有効になっていません（または確認できません）。"
  echo "    有効化はプロジェクト設定の変更のため、このスクリプトでは行いません。"
  echo "    別プロジェクトで有効化済みのキーを使う場合は、そのまま続行できます。"
fi

echo "[2/4] ${BRANCH} を取得（固定 SHA ${EXPECTED_SHA:0:7}）"
git init -q "${WORK}/src"
git -C "${WORK}/src" remote add origin https://github.com/mirai-gpro/Travel-sp.git
GIT_TERMINAL_PROMPT=0 git -C "${WORK}/src" fetch -q --depth=5 origin "${BRANCH}" \
  || { echo "GitHub から取得できません" >&2; exit 1; }
git -C "${WORK}/src" checkout -q "${EXPECTED_SHA}" || { echo "固定 SHA が見つかりません" >&2; exit 1; }
[ "$(git -C "${WORK}/src" rev-parse HEAD)" = "${EXPECTED_SHA}" ] || { echo "SHA 不一致" >&2; exit 1; }
echo "    使用 SHA: $(git -C "${WORK}/src" rev-parse HEAD)"

echo "[3/4] 一時 Python 環境（requests==2.32.5 のみ）"
python3 -m venv "${WORK}/venv" || { echo "venv の作成に失敗" >&2; exit 1; }
if ! "${WORK}/venv/bin/pip" install -q --disable-pip-version-check "requests==2.32.5" > "${WORK}/pip.log" 2>&1; then
  echo "requests のインストールに失敗:" >&2; tail -n 30 "${WORK}/pip.log" >&2; exit 1
fi

echo "[4/4] 推薦・選択 LLM 用 AQ キーを入力してください（表示されません。Enter で確定）"
read -rs AQ_KEY_INPUT; echo
[ -n "${AQ_KEY_INPUT}" ] || { echo "キーが空です" >&2; exit 1; }
cd "${WORK}/src/support-base"
GEMINI_RECOMMEND_API_KEY="${AQ_KEY_INPUT}" GIT_SHA="${EXPECTED_SHA}" \
  "${WORK}/venv/bin/python" -I - "${KEY_REVISION}" "${PROJECT_ID}" "${REGION}" "${REPEAT}" <<'PYEOF'
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
os.environ['GOOGLE_PLACES_API_KEY'] = pkey          # api_integrations の import 前に設定
mkey = pkey                                         # Agent Tools も既存の Google Maps Platform キーを使う
os.environ['MAPS_AGENT_TOOLS_API_KEY'] = mkey
from new_shop_recommendation.redact import redact, register_secret
for k in (pkey, mkey, os.environ.get('GEMINI_RECOMMEND_API_KEY', '')):
    register_secret(k)

class _RedactFilter(logging.Filter):
    def filter(self, record):
        record.msg = redact(record.getMessage()); record.args = ()
        return True
logging.basicConfig(level=logging.WARNING)
for h in logging.getLogger().handlers:
    h.addFilter(_RedactFilter())
sys.argv = ['gate_d1_7e', '--repeat', repeat]
runpy.run_module('new_shop_recommendation.poc.gate_d1_7e_method_e', run_name='__main__')
PYEOF
unset AQ_KEY_INPUT
