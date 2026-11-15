#!/usr/bin/env bash
# R1 の原因調査（Cloud Shell・Geocoding のみ・プレビュー用 Maps キーを Secret から読み、画面には出さない）
#   bash ~/m4_scope_debug.sh
set -euo pipefail
BRANCH="feature/new-shop-recommendation"
EXPECTED_SHA="c52fda0b9eea9f18f5a3dc39d36a8dc08cd0cf65"
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
  'ホテルニューオータニ東京の中で接待に使える鉄板焼き 4名'
