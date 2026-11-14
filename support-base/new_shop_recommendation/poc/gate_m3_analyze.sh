#!/usr/bin/env bash
# =====================================================================
# Gate M3 — 事後分析（Cloud Shell・キー不要・API 呼び出しなし）
#
#   bash gate_m3_analyze.sh          （~/m3_results.json を分析）
#
# - 固定 SHA のコードと独立判定ラベル（poc/m3_labels.tsv）で ~/m3_results.json を分析する（S10 未達原因・条件適合評価用の詳細）
# - 外部 API・Cloud Run・本番環境には一切アクセスしない。出力は ~/m3_analysis.txt に保存
# =====================================================================
set -euo pipefail
BRANCH="feature/new-shop-recommendation"
EXPECTED_SHA="93a9fc5e551a134f8db57c45414f83b1298a16ec"
RESULTS="${1:-${HOME}/m3_results.json}"
[ -f "${RESULTS}" ] || { echo "結果ファイルがありません: ${RESULTS}" >&2; exit 1; }
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

echo "[1/2] ${BRANCH} を取得（固定 SHA ${EXPECTED_SHA:0:7}）"
git init -q "${WORK}/src"
git -C "${WORK}/src" remote add origin https://github.com/mirai-gpro/Travel-sp.git
GIT_TERMINAL_PROMPT=0 git -C "${WORK}/src" fetch -q --depth=10 origin "${BRANCH}" || { echo "GitHub から取得できません" >&2; exit 1; }
git -C "${WORK}/src" checkout -q "${EXPECTED_SHA}" || { echo "固定 SHA が見つかりません" >&2; exit 1; }
[ "$(git -C "${WORK}/src" rev-parse HEAD)" = "${EXPECTED_SHA}" ] || { echo "SHA 不一致" >&2; exit 1; }

echo "[2/2] 一時 Python 環境（requests==2.32.5 のみ）で分析"
python3 -m venv "${WORK}/venv" || { echo "venv の作成に失敗" >&2; exit 1; }
"${WORK}/venv/bin/pip" install -q --disable-pip-version-check "requests==2.32.5" > "${WORK}/pip.log" 2>&1 \
  || { echo "requests のインストールに失敗:" >&2; tail -n 30 "${WORK}/pip.log" >&2; exit 1; }
cd "${WORK}/src/support-base"
"${WORK}/venv/bin/python" -I -c "import sys; sys.path.insert(0, '.'); sys.argv = ["analyze", sys.argv[1], sys.argv[2], "S10"]
from new_shop_recommendation.poc import gate_m3_analyze as g; g.main()" \
  "${RESULTS}" new_shop_recommendation/poc/m3_labels.tsv > "${HOME}/m3_analysis.txt" 2>&1
echo "完了: ~/m3_analysis.txt（$(wc -l < "${HOME}/m3_analysis.txt") 行）"
