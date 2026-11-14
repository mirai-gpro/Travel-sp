#!/usr/bin/env bash
# =====================================================================
# M4 T4 比較試験（33 秒版 vs S10、未使用 10 クエリ × 3 回）— Cloud Shell
#
#   bash ~/m4_bench_run.sh [回数=3]
#
# - 隔離したプレビュー・リビジョン（タグ m4s10）の /api/m4/bench を呼ぶだけ。33 秒版の本番キーはリビジョン内で使われ、
#   ここには出てこない。トークンは m4_deploy_preview.sh が作った ~/.m4_bench_token を使う
# - 結果 ~/m4_bench.json、方式を伏せた評価シート ~/m4_eval_sheet.tsv、対応表 ~/m4_eval_key.tsv
# - 所要時間の目安: 60 回 × 20〜60 秒
# =====================================================================
set -euo pipefail
PROJECT_ID="ai-avator-492205"
REGION="us-central1"
SERVICE="travel-sp-base"
TAG="m4s10"
BRANCH="feature/new-shop-recommendation"
EXPECTED_SHA="4acfde951976ffcc9965bf2fc216190becd3fdc8"
REPEAT="${1:-3}"
[ -f "${HOME}/.m4_bench_token" ] || { echo "~/.m4_bench_token がありません（先に m4_deploy_preview.sh を実行）" >&2; exit 1; }
URL="$(gcloud run services describe "${SERVICE}" --project="${PROJECT_ID}" --region="${REGION}" --format=json | python3 -c "import json,sys; print(next(t['url'] for t in json.load(sys.stdin)['status']['traffic'] if t.get('tag')=='${TAG}'))")"
[ -n "${URL}" ] || { echo "タグ ${TAG} の URL がありません" >&2; exit 1; }
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT
git init -q "${WORK}/src"
git -C "${WORK}/src" remote add origin https://github.com/mirai-gpro/Travel-sp.git
GIT_TERMINAL_PROMPT=0 git -C "${WORK}/src" fetch -q --depth=30 origin "${BRANCH}" || { echo "GitHub から取得できません" >&2; exit 1; }
git -C "${WORK}/src" checkout -q "${EXPECTED_SHA}" || { echo "固定 SHA が見つかりません" >&2; exit 1; }
python3 -m venv "${WORK}/venv" && "${WORK}/venv/bin/pip" install -q --disable-pip-version-check "requests==2.32.5" > /dev/null 2>&1
cd "${WORK}/src/support-base"
echo "接続先: ${URL}（固定 SHA ${EXPECTED_SHA:0:7}）"
"${WORK}/venv/bin/python" -I -c "import sys; sys.path.insert(0, '.'); sys.argv = ['bench', sys.argv[1], sys.argv[2], sys.argv[3]]
from new_shop_recommendation.m4 import bench_run; bench_run.main()" "${URL}" "${HOME}/.m4_bench_token" "${REPEAT}" 2>&1 | tee "${HOME}/m4_bench_output.txt"
