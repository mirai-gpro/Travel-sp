#!/usr/bin/env bash
# =====================================================================
# M4 事前確認（Cloud Shell・キー入力なし・本番非接触）
#
#   bash ~/m4_precheck.sh
#
# 1. M3 保存データ（~/m3_results.json）30 試行で二段階・先行 1 枚の値を確定（API 呼び出しなし）
# 2. R1 検索範囲を M3 の 10 クエリと M4 の未使用 10 クエリで確認（Geocoding のみ。推薦・照合・LLM は呼ばない）
#    Geocoding キーは本番リビジョンの GOOGLE_PLACES_API_KEY をプロセス内で読む（画面・ファイルに出さない）
# 出力は ~/m4_precheck.txt にも保存。Cloud Run・トラフィック・環境変数には一切触れない
# =====================================================================
set -euo pipefail
PROJECT_ID="ai-avator-492205"
REGION="us-central1"
KEY_REVISION="travel-sp-base-00060-car"
BRANCH="feature/new-shop-recommendation"
EXPECTED_SHA="23b84d78a5c026b7573f8402285aaa0351689175"
RESULTS="${1:-${HOME}/m3_results.json}"
[ -f "${RESULTS}" ] || { echo "結果ファイルがありません: ${RESULTS}" >&2; exit 1; }
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

echo "[1/2] ${BRANCH} を取得（固定 SHA ${EXPECTED_SHA:0:7}）"
git init -q "${WORK}/src"
git -C "${WORK}/src" remote add origin https://github.com/mirai-gpro/Travel-sp.git
GIT_TERMINAL_PROMPT=0 git -C "${WORK}/src" fetch -q --depth=30 origin "${BRANCH}" || { echo "GitHub から取得できません" >&2; exit 1; }
git -C "${WORK}/src" checkout -q "${EXPECTED_SHA}" || { echo "固定 SHA が見つかりません" >&2; exit 1; }
[ "$(git -C "${WORK}/src" rev-parse HEAD)" = "${EXPECTED_SHA}" ] || { echo "SHA 不一致" >&2; exit 1; }

echo "[2/2] 一時 Python 環境（requests==2.32.5 のみ）で実行"
python3 -m venv "${WORK}/venv" || { echo "venv の作成に失敗" >&2; exit 1; }
"${WORK}/venv/bin/pip" install -q --disable-pip-version-check "requests==2.32.5" > "${WORK}/pip.log" 2>&1 \
  || { echo "requests のインストールに失敗:" >&2; tail -n 30 "${WORK}/pip.log" >&2; exit 1; }
cd "${WORK}/src/support-base"
"${WORK}/venv/bin/python" -I - "${KEY_REVISION}" "${PROJECT_ID}" "${REGION}" "${RESULTS}" <<'PYEOF' 2>&1 | tee "${HOME}/m4_precheck.txt"
import json, os, subprocess, sys
sys.path.insert(0, os.getcwd())
rev, project, region, results = sys.argv[1:5]
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
os.environ['GOOGLE_GEOCODING_API_KEY'] = pkey
from new_shop_recommendation.redact import register_secret
register_secret(pkey)
sys.argv = ['precheck', results, 'new_shop_recommendation/poc/m3_labels.tsv']
from new_shop_recommendation.m4 import precheck
precheck.main()
PYEOF
echo "完了: ~/m4_precheck.txt"
