#!/usr/bin/env bash
# R1 の原因調査（Cloud Shell・Geocoding のみ・プレビュー用 Maps キーを Secret から読み、画面には出さない）
#   bash ~/m4_scope_debug.sh
set -euo pipefail
BRANCH="feature/new-shop-recommendation"
EXPECTED_SHA="4f75ce6158448ac58fae17ff334ec5510311d81e"
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT
git init -q "${WORK}/src"
git -C "${WORK}/src" remote add origin https://github.com/mirai-gpro/Travel-sp.git
GIT_TERMINAL_PROMPT=0 git -C "${WORK}/src" fetch -q --depth=40 origin "${BRANCH}" || { echo "GitHub から取得できません" >&2; exit 1; }
git -C "${WORK}/src" checkout -q "${EXPECTED_SHA}" || { echo "固定 SHA が見つかりません" >&2; exit 1; }
python3 -m venv "${WORK}/venv" && "${WORK}/venv/bin/pip" install -q --disable-pip-version-check "requests==2.32.5" > /dev/null 2>&1
cd "${WORK}/src/support-base"
"${WORK}/venv/bin/python" -I -c "import sys; sys.path.insert(0, '.'); sys.argv = ['d'] + sys.argv[1:]
from new_shop_recommendation.m4 import scope_debug; scope_debug.main()" \
  '札幌すすきので美味しいジンギスカン' 'ホテルニューオータニ東京の中で接待に使える鉄板焼き 4名' '京都の祇園で記念日に行くカウンター割烹 予算1人2万円 2名'
