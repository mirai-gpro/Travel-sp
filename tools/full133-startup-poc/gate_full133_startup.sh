#!/usr/bin/env bash
# =====================================================================
# UIKA FULL133 起動の比較 PoC（Cloud Shell 用）
#
#   bash ~/gate_full133_startup.sh <コミット SHA（40 桁）>
#
# - GitHub の poc/full133-startup の固定 SHA を取得して、一時ディレクトリでビルド・計測する
# - 本番のコード・本番の環境・Cloud Run には書き込まない（gcloud を使わない。API キーは不要）
#   ブラウザの計測は、ローカルのフロント（127.0.0.1:4410）とバックエンドの代わり（127.0.0.1:4411）だけにつなぐ
# - 比べる構成: A 現行 / B 選択中 ZIP の先読み / C buildModelTexture の TypedArray 版 / D B+C+完成後の一括表示
# - 結果: ~/full133_startup_results.json と ~/full133_startup_report.txt（途中で失敗しても、そこまでの結果と原因を書く）
#         実行ログ: ~/full133_startup_run.log
# - 所要時間の目安: 40〜60 分（PC 想定とスマホ想定の両方。FULL133_PROFILES=pc で PC 想定だけにできる）
# - 作業ディレクトリは終了時に消す（FULL133_KEEP=1 で残す）
# =====================================================================
set -uo pipefail
SHA="${1:-}"
if [[ ! "${SHA}" =~ ^[0-9a-f]{40}$ ]]; then
  echo "使い方: bash ~/gate_full133_startup.sh <40 桁のコミット SHA>" >&2
  exit 2
fi
REPO="https://github.com/mirai-gpro/Travel-sp.git"
BRANCH="poc/full133-startup"
PKG_FILE="node_modules/gaussian-splat-renderer-for-lam/build/gaussian-splat-renderer-for-lam.module.js"
PKG_SHA_EXPECTED="7eb00f12081a82a9ff5f5fe6112309667e47a744a41ba594701198154f1c49fb"
OUT_JSON="${HOME}/full133_startup_results.json"
OUT_TXT="${HOME}/full133_startup_report.txt"
OUT_LOG="${HOME}/full133_startup_run.log"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/full133-poc-XXXXXX")"
SRC="${WORK}/src"
TOOLS="${SRC}/tools/full133-startup-poc"
LOG="${WORK}/run.log"
STEPS="${WORK}/steps.tsv"
: > "${STEPS}"
START_ISO="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
SERVER_PID=""
PKG_SHA_BEFORE=""; PKG_SHA_AFTER=""

step() { printf '%s\t%s\n' "$1" "$2" >> "${STEPS}"; echo "[$(date +%H:%M:%S)] $1: $2" | tee -a "${LOG}"; }
say() { echo "[$(date +%H:%M:%S)] $*" | tee -a "${LOG}"; }

finish() {
  [ -n "${SERVER_PID}" ] && kill "${SERVER_PID}" 2>/dev/null
  if command -v node > /dev/null 2>&1; then
    node -e '
      const fs = require("fs"), os = require("os");
      const steps = {}; for (const l of fs.readFileSync(process.argv[1], "utf8").split("\n")) { if (!l) continue; const i = l.indexOf("\t"); steps[l.slice(0, i)] = l.slice(i + 1); }
      fs.writeFileSync(process.argv[2], JSON.stringify({ startedAt: process.argv[3], finishedAt: new Date().toISOString(), sha: process.argv[4],
        os: `${os.type()} ${os.release()}`, cpus: os.cpus().length, cpuModel: os.cpus()[0] && os.cpus()[0].model, memGB: Math.round(os.totalmem() / 2 ** 30), node: process.version,
        pkgShaExpected: process.argv[5], pkgShaBefore: process.argv[6], pkgShaAfter: process.argv[7], steps }, null, 1));
    ' "${STEPS}" "${WORK}/env.json" "${START_ISO}" "${SHA}" "${PKG_SHA_EXPECTED}" "${PKG_SHA_BEFORE}" "${PKG_SHA_AFTER}" 2>> "${LOG}"
    if [ -f "${TOOLS}/report.mjs" ]; then
      node "${TOOLS}/report.mjs" "${WORK}/env.json" "${WORK}/bmt.json" "${WORK}/e2e.json" "${OUT_JSON}" "${OUT_TXT}" > /dev/null 2>> "${LOG}" \
        || { cp "${WORK}/env.json" "${OUT_JSON}"; { echo "集計に失敗しました（ログ: ${OUT_LOG}）"; cat "${STEPS}"; } > "${OUT_TXT}"; }
    else
      cp "${WORK}/env.json" "${OUT_JSON}"; { echo "PoC のコードを取得できなかったため、計測していません。"; cat "${STEPS}"; } > "${OUT_TXT}"
    fi
  else
    { echo "Node.js が無いため、計測していません。"; cat "${STEPS}"; } > "${OUT_TXT}"
    printf '{"error":"node not found","sha":"%s"}\n' "${SHA}" > "${OUT_JSON}"
  fi
  cp "${LOG}" "${OUT_LOG}" 2>/dev/null
  if [ "${FULL133_KEEP:-0}" = "1" ]; then echo "作業ディレクトリを残しました: ${WORK}"; else rm -rf "${WORK}"; fi
  echo ""
  echo "結果: ${OUT_TXT}"
  echo "      ${OUT_JSON}"
  echo "ログ: ${OUT_LOG}"
}
trap finish EXIT

say "作業ディレクトリ: ${WORK}"
say "環境: $(uname -sr) / CPU $(nproc) 個 / メモリ $(free -m 2>/dev/null | awk '/Mem:/{print $2" MB"}') / 空き容量 $(df -h "${WORK}" | awk 'NR==2{print $4}')"

# ---- 1. Node.js ----
if ! command -v node > /dev/null 2>&1; then step "Node.js" "NG: 見つかりません"; exit 1; fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "${NODE_MAJOR}" -lt 18 ]; then step "Node.js" "NG: $(node -v)（18 以上が必要）"; exit 1; fi
step "Node.js" "OK $(node -v) / npm $(npm -v)"

# ---- 2. 固定 SHA の取得 ----
git init -q "${SRC}" && git -C "${SRC}" remote add origin "${REPO}"
if ! GIT_TERMINAL_PROMPT=0 git -C "${SRC}" fetch -q --depth=50 origin "${BRANCH}" >> "${LOG}" 2>&1; then step "GitHub から取得" "NG: ${BRANCH} を取得できません"; exit 1; fi
if ! git -C "${SRC}" checkout -q "${SHA}" >> "${LOG}" 2>&1; then step "GitHub から取得" "NG: 固定 SHA ${SHA:0:7} が ${BRANCH} にありません"; exit 1; fi
[ "$(git -C "${SRC}" rev-parse HEAD)" = "${SHA}" ] || { step "GitHub から取得" "NG: SHA が一致しません"; exit 1; }
step "GitHub から取得" "OK ${BRANCH} ${SHA:0:7}"

# ---- 3. フロントの依存（package-lock どおり）とパッケージのパッチ ----
say "フロントの依存をインストール中（数分）..."
if ! (cd "${SRC}" && npm ci --no-audit --no-fund >> "${LOG}" 2>&1); then step "フロントの依存" "NG: npm ci に失敗（ログ参照）"; exit 1; fi
step "フロントの依存" "OK"
PKG_SHA_BEFORE="$(sha256sum "${SRC}/${PKG_FILE}" | cut -d' ' -f1)"
if [ "${PKG_SHA_BEFORE}" != "${PKG_SHA_EXPECTED}" ]; then step "renderer パッケージ" "NG: 元のファイルが想定と違います（${PKG_SHA_BEFORE:0:12}）。パッチを当てません"; exit 1; fi
if ! (cd "${SRC}" && patch -p1 --forward -s < "${TOOLS}/patches/gaussian-splat-renderer-for-lam+0.0.9-alpha.1.patch" >> "${LOG}" 2>&1); then step "renderer パッケージ" "NG: パッチを当てられません"; exit 1; fi
PKG_SHA_AFTER="$(sha256sum "${SRC}/${PKG_FILE}" | cut -d' ' -f1)"
step "renderer パッケージ" "OK 元 ${PKG_SHA_BEFORE:0:12} → パッチ後 ${PKG_SHA_AFTER:0:12}"

# ---- 4. フロントのビルド（接続先はローカルのバックエンドの代わり）----
say "フロントをビルド中..."
if ! (cd "${SRC}" && PUBLIC_API_URL="http://127.0.0.1:4411" npm run build >> "${LOG}" 2>&1); then step "フロントのビルド" "NG: ビルドに失敗（ログ参照）"; exit 1; fi
grep -q "__FULL133_POC_OPT_BUILD" "${SRC}"/dist/assets/gaussian-splat-renderer-for-lam.module.*.js || { step "フロントのビルド" "NG: パッチがビルドに入っていません"; exit 1; }
step "フロントのビルド" "OK"

# ---- 5. 計測ツールの依存 ----
if ! (cd "${TOOLS}" && npm ci --no-audit --no-fund >> "${LOG}" 2>&1); then step "計測ツールの依存" "NG: npm ci に失敗"; exit 1; fi
step "計測ツールの依存" "OK"

# ---- 6. buildModelTexture のベンチマーク（Node・CPU）。代表 1 体 → 正常なら残り 8 体（1 体ずつ）----
ZIPS=( "${SRC}/public/avatar/uika-meruru02-full133.zip" )
for z in "${SRC}"/public/avatar/uika-*-full133.zip; do [ "${z}" != "${ZIPS[0]}" ] && ZIPS+=( "${z}" ); done
say "buildModelTexture のベンチマーク: 代表 1 体（uika-meruru02-full133）"
(cd "${TOOLS}" && node bench_bmt.mjs "${SRC}/${PKG_FILE}" "${ZIPS[0]}" > "${WORK}/bmt_first.json" 2>> "${LOG}")
FIRST_OK="$(node -e '
  const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const ok = r.length > 0 && r.every(x => !x.error) && new Set(r.map(x => x.sha256Int)).size === 1 && new Set(r.map(x => x.sha256Float)).size === 1;
  console.log(ok ? "1" : "0");' "${WORK}/bmt_first.json" 2>> "${LOG}" || echo 0)"
if [ "${FIRST_OK}" = "1" ]; then
  step "buildModelTexture（代表 1 体）" "OK 旧と新の出力が一致"
  say "buildModelTexture のベンチマーク: 残り $(( ${#ZIPS[@]} - 1 )) 体（1 体ずつ）"
  (cd "${TOOLS}" && node bench_bmt.mjs "${SRC}/${PKG_FILE}" "${ZIPS[@]:1}" > "${WORK}/bmt_rest.json" 2>> "${LOG}")
  node -e 'const fs = require("fs"); const a = JSON.parse(fs.readFileSync(process.argv[1])); let b = []; try { b = JSON.parse(fs.readFileSync(process.argv[2])); } catch (e) {} fs.writeFileSync(process.argv[3], JSON.stringify(a.concat(b)));' \
    "${WORK}/bmt_first.json" "${WORK}/bmt_rest.json" "${WORK}/bmt.json" 2>> "${LOG}"
  step "buildModelTexture（全体）" "実行済み（結果は表を参照）"
else
  cp "${WORK}/bmt_first.json" "${WORK}/bmt.json" 2>/dev/null
  step "buildModelTexture（代表 1 体）" "NG: 出力が一致しないか失敗。残りの体とブラウザの C・D の採否は不可（表を参照）"
fi

# ---- 7. ブラウザ（Playwright の Chromium）----
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-${WORK}/pw-browsers}"
BROWSER_OK=0
launch_test() { (cd "${TOOLS}" && node -e 'import("playwright").then(async ({ chromium }) => { const b = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] }); await b.close(); console.log("ok"); }).catch(e => { console.error(String(e).slice(0, 800)); process.exit(1); })' >> "${LOG}" 2>&1); }
if launch_test; then BROWSER_OK=1; else
  say "Chromium をダウンロード中（一時ディレクトリへ）..."
  (cd "${TOOLS}" && npx playwright install chromium >> "${LOG}" 2>&1)
  if launch_test; then BROWSER_OK=1
  elif sudo -n true 2>/dev/null; then
    say "Chromium の実行に必要なライブラリを入れます（Cloud Shell の一時環境。sudo apt）..."
    (cd "${TOOLS}" && sudo -n env "PATH=${PATH}" npx playwright install-deps chromium >> "${LOG}" 2>&1)
    launch_test && BROWSER_OK=1
  fi
fi
if [ "${BROWSER_OK}" != "1" ]; then
  step "ブラウザ" "NG: Chromium を起動できません。ブラウザの項目は未測定（ログ参照）"
  exit 0
fi
step "ブラウザ" "OK Chromium（ソフトウェア GPU）"

# ---- 8. ローカルのサーバーとブラウザの計測 ----
(cd "${TOOLS}" && node server.mjs "${SRC}/dist" 4410 4411 "${SRC}/src/scripts/chat/lam-websocket-manager.ts" >> "${LOG}" 2>&1) &
SERVER_PID=$!
for i in $(seq 1 30); do curl -fs -o /dev/null http://127.0.0.1:4411/health && curl -fs -o /dev/null http://127.0.0.1:4410/concierge/ && break; sleep 1; done
if ! curl -fs -o /dev/null http://127.0.0.1:4410/concierge/; then step "ローカルのサーバー" "NG: 起動しません"; exit 0; fi
step "ローカルのサーバー" "OK"
say "ブラウザの計測（A〜D・キャッシュなし／あり・各 ${FULL133_E2E_REPS:-3} 回・${FULL133_PROFILES:-pc,mobile}）。時間がかかります..."
if (cd "${TOOLS}" && node e2e.mjs http://127.0.0.1:4410 "${WORK}/e2e.json" 2>> "${LOG}"); then
  step "ブラウザの計測" "実行済み（結果は表を参照）"
else
  step "ブラウザの計測" "NG: 途中で失敗（そこまでの結果を表に出します）"
fi
exit 0
