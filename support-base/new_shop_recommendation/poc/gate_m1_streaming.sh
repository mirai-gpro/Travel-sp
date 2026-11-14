#!/usr/bin/env bash
# =====================================================================
# Gate M1 — 推薦 LLM ストリーミング計測（Cloud Shell・本番非接触）
#
#   bash ~/gate_m1_streaming.sh 3
#
# 通常 10 クエリ × N 回。gemini-3.8-flash / thinking low / 現行プロンプト・スキーマ / 7 店舗 / tools なし / stream=true
# - 固定 SHA 17448af のコードをそのまま使う。キー入力は AQ キー 1 回だけ（非表示）
# - Cloud Run・トラフィック・本番環境変数には一切触れない。結果は画面のみ
# =====================================================================
set -euo pipefail
BRANCH="feature/new-shop-recommendation"
EXPECTED_SHA="17448af3ffb041f4b483977e16f712ea0a9ad53a"
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

echo "[3/3] 推薦用 AQ キーを入力してください（表示されません。Enter で確定）"
read -rs AQ_KEY_INPUT
echo
[ -n "${AQ_KEY_INPUT}" ] || { echo "キーが空です" >&2; exit 1; }
cd "${WORK}/src/support-base"
GEMINI_RECOMMEND_API_KEY="${AQ_KEY_INPUT}" GIT_SHA="${EXPECTED_SHA}" \
  "${WORK}/venv/bin/python" -I -c "import sys, os, runpy; sys.path.insert(0, os.getcwd()); sys.argv=['gate_m1','--repeat','${REPEAT}']; runpy.run_module('new_shop_recommendation.poc.gate_m1_streaming', run_name='__main__')"
unset AQ_KEY_INPUT
