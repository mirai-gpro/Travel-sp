#!/usr/bin/env bash
# =====================================================================
# FULL133 起動 PoC の独立再現（Cloud Shell）: PC 想定の A（現行）と D（統合改善）を、初回・2 回目 各 1 回（計 4 件）
#
#   bash ~/repro_full133_startup.sh <コミット SHA（40 桁）>
#
# - 取得するもの（初回だけ。~/.full133-repro に保存し、2 回目以降は取得しない）:
#     ビルド済みの PoC フロントと計測ツール（約 9MB。GitHub の固定 SHA から。SHA-256 を確認）
#     モデル uika-meruru02-full133.zip（25.4MB。本番サイトから読み取りのみ。SHA-256 を確認）
#     Playwright と socket.io（npm）、Chromium（~/.cache/ms-playwright）
# - 本番のコード・環境・Cloud Run には書き込まない（gcloud を使わない。API キー不要）。計測はローカル（127.0.0.1）だけ
# - 所要時間: 初回 5〜8 分（取得を含む）、2 回目以降 約 3 分
# - 結果: ~/full133_repro_report.txt と ~/full133_repro_results.json（失敗しても原因を書く）
# =====================================================================
set -uo pipefail
SHA="${1:-}"
[[ "${SHA}" =~ ^[0-9a-f]{40}$ ]] || { echo "使い方: bash ~/repro_full133_startup.sh <40 桁のコミット SHA>" >&2; exit 2; }
BUNDLE_SHA256="94a0899cd374ebee74481eee9c645a53a15b850de81d608b8d27f7ee13c21bf3"
MODEL_SHA256="b16cd7541fc946f0b85c09f0f995733b0124b3f11f4eba804acaf33504ba949e"
MODEL_URL="https://travel-sp.vercel.app/avatar/uika-meruru02-full133.zip"
BUNDLE_URL="https://raw.githubusercontent.com/mirai-gpro/Travel-sp/${SHA}/tools/full133-startup-poc/repro/full133-repro-bundle.tar.gz"
CACHE="${HOME}/.full133-repro"
APP="${CACHE}/bundle-${BUNDLE_SHA256:0:12}/full133-repro"
OUT_TXT="${HOME}/full133_repro_report.txt"
OUT_JSON="${HOME}/full133_repro_results.json"
LOG="${CACHE}/last_run.log"
mkdir -p "${CACHE}/models"
: > "${LOG}"
SERVER_PID=""
RESULT_E2E="${CACHE}/e2e_last.json"
say() { echo "[$(date +%H:%M:%S)] $*" | tee -a "${LOG}"; }
fail() { say "NG: $*"; { echo "FULL133 起動 PoC の独立再現: 失敗"; echo "理由: $*"; echo "ログ: ${LOG}"; } > "${OUT_TXT}"; exit 1; }
cleanup() { [ -n "${SERVER_PID}" ] && kill "${SERVER_PID}" 2>/dev/null; }
trap cleanup EXIT

command -v node > /dev/null || fail "Node.js が見つかりません"
say "Node.js $(node -v)"

# ---- 1. ビルド済みの PoC（初回だけ取得）----
if [ ! -f "${APP}/.ok" ]; then
  say "PoC のビルド済みファイルを取得中（約 9MB）..."
  rm -rf "${CACHE}/bundle-${BUNDLE_SHA256:0:12}"; mkdir -p "${CACHE}/bundle-${BUNDLE_SHA256:0:12}"
  curl -fsSL "${BUNDLE_URL}" -o "${CACHE}/bundle.tar.gz" || fail "PoC のファイルを取得できません（${SHA:0:7}）"
  [ "$(sha256sum "${CACHE}/bundle.tar.gz" | cut -d' ' -f1)" = "${BUNDLE_SHA256}" ] || fail "PoC のファイルの SHA-256 が一致しません"
  tar -xzf "${CACHE}/bundle.tar.gz" -C "${CACHE}/bundle-${BUNDLE_SHA256:0:12}" || fail "展開に失敗しました"
  rm -f "${CACHE}/bundle.tar.gz"
  touch "${APP}/.ok"
else
  say "PoC のビルド済みファイル: 保存済みを使用"
fi

# ---- 2. モデル（初回だけ取得。本番サイトから読み取りのみ）----
M="${CACHE}/models/uika-meruru02-full133.zip"
if [ ! -f "${M}" ] || [ "$(sha256sum "${M}" | cut -d' ' -f1)" != "${MODEL_SHA256}" ]; then
  say "モデルを取得中（25.4MB）..."
  curl -fsSL "${MODEL_URL}" -o "${M}.tmp" || fail "モデルを取得できません"
  [ "$(sha256sum "${M}.tmp" | cut -d' ' -f1)" = "${MODEL_SHA256}" ] || { rm -f "${M}.tmp"; fail "モデルの SHA-256 が一致しません"; }
  mv "${M}.tmp" "${M}"
else
  say "モデル: 保存済みを使用（SHA-256 一致）"
fi
cp "${M}" "${APP}/dist/avatar/uika-meruru02-full133.zip"

# ---- 3. 計測ツールの依存（初回だけ）----
if [ ! -d "${APP}/tools/node_modules/playwright" ]; then
  say "計測ツールの依存をインストール中..."
  (cd "${APP}/tools" && npm ci --no-audit --no-fund >> "${LOG}" 2>&1) || fail "npm ci に失敗しました（ログ参照）"
else
  say "計測ツールの依存: 保存済みを使用"
fi

# ---- 4. Chromium（~/.cache/ms-playwright。初回だけ取得）----
launch_test() { (cd "${APP}/tools" && node -e 'import("playwright").then(async ({ chromium }) => { const b = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] }); await b.close(); }).catch(e => { console.error(String(e).slice(0, 600)); process.exit(1); })' >> "${LOG}" 2>&1); }
if launch_test; then say "Chromium: 保存済みを使用"; else
  say "Chromium を取得中（初回だけ）..."
  (cd "${APP}/tools" && npx playwright install chromium >> "${LOG}" 2>&1)
  launch_test || fail "Chromium を起動できません（ログ参照）"
fi

# ---- 5. 計測（PC 想定・A と D・初回／2 回目・各 1 回）----
(cd "${APP}/tools" && node server.mjs "${APP}/dist" 4410 4411 "${APP}/tools/blendshape-names-src.ts" >> "${LOG}" 2>&1) &
SERVER_PID=$!
for i in $(seq 1 30); do curl -fs -o /dev/null http://127.0.0.1:4410/concierge/ && curl -fs -o /dev/null http://127.0.0.1:4411/health && break; sleep 1; done
curl -fs -o /dev/null http://127.0.0.1:4410/concierge/ || fail "ローカルのサーバーが起動しません"
say "計測中（4 件。約 2 分）..."
rm -f "${RESULT_E2E}"
(cd "${APP}/tools" && FULL133_PROFILES=pc FULL133_CONFIGS=A,D FULL133_E2E_REPS=1 FULL133_VERSION_CHECK=0 node e2e.mjs http://127.0.0.1:4410 "${RESULT_E2E}" 2> >(tee -a "${LOG}" >&2))

# ---- 6. 集計 ----
node -e '
  const os = require("os"), fs = require("fs");
  fs.writeFileSync(process.argv[1], JSON.stringify({ startedAt: new Date().toISOString(), sha: process.argv[2], os: `${os.type()} ${os.release()}`, cpus: os.cpus().length,
    cpuModel: os.cpus()[0] && os.cpus()[0].model, memGB: Math.round(os.totalmem() / 2 ** 30), node: process.version,
    steps: { "確認の範囲": "PC 想定・A と D・初回／2 回目・各 1 回（独立再現）" } }));' "${CACHE}/env.json" "${SHA}"
FULL133_REPORT_NO_BMT=1 node "${APP}/tools/report.mjs" "${CACHE}/env.json" /nonexistent "${RESULT_E2E}" "${OUT_JSON}" "${OUT_TXT}" > /dev/null 2>> "${LOG}" || fail "集計に失敗しました"
say "完了"
echo "結果: ${OUT_TXT}"
