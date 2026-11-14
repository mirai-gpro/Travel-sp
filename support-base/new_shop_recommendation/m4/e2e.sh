#!/usr/bin/env bash
# =====================================================================
# M4 E2E 集計（Cloud Shell・API 呼び出しなし。ログの読み取りのみ）
#
#   bash ~/m4_e2e.sh <ブラウザのコンソールログ.txt> [さかのぼる時間=6h]
#
# - ブラウザ: プレビュー画面の DevTools コンソールを「Save as...」で保存し、Cloud Shell にアップロードしたファイル
# - バックエンド: タグ m4s10 のリビジョンの [NewShopRec] ログを gcloud logging read で読む（~/m4_backend_logs.json に保存）
# =====================================================================
set -euo pipefail
PROJECT_ID="ai-avator-492205"
REVISION="travel-sp-base-m4s10-fa1b62f"
BRANCH="feature/new-shop-recommendation"
EXPECTED_SHA="8024dd23b70d440e3cfe55141e59a70ba26636a8"
CONSOLE_LOG="${1:?ブラウザのコンソールログのファイルを指定してください}"
FRESH="${2:-6h}"
[ -f "${CONSOLE_LOG}" ] || { echo "ファイルがありません: ${CONSOLE_LOG}" >&2; exit 1; }
gcloud logging read "resource.type=\"cloud_run_revision\" AND resource.labels.revision_name=\"${REVISION}\" AND textPayload:\"NewShopRec\"" \
  --project="${PROJECT_ID}" --freshness="${FRESH}" --order=asc --format=json > "${HOME}/m4_backend_logs.json"
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT
git init -q "${WORK}/src"
git -C "${WORK}/src" remote add origin https://github.com/mirai-gpro/Travel-sp.git
GIT_TERMINAL_PROMPT=0 git -C "${WORK}/src" fetch -q --depth=30 origin "${BRANCH}" || { echo "GitHub から取得できません" >&2; exit 1; }
git -C "${WORK}/src" checkout -q "${EXPECTED_SHA}" || { echo "固定 SHA が見つかりません" >&2; exit 1; }
cd "${WORK}/src/support-base"
python3 -I -c "import sys; sys.path.insert(0, '.'); sys.argv = ['e2e', sys.argv[1], sys.argv[2]]
from new_shop_recommendation.m4 import e2e; e2e.main()" "${CONSOLE_LOG}" "${HOME}/m4_backend_logs.json" | tee "${HOME}/m4_e2e.txt"
