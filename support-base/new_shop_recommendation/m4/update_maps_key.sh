#!/usr/bin/env bash
# =====================================================================
# M4: プレビュー用 Maps API キー（m4-preview-maps）の利用 API に Places API (New) を追加（Cloud Shell）
#
#   bash ~/m4_update_maps_key.sh
#
# 変更内容: キー m4-preview-maps の API 制限を次の 4 つにする（キー文字列は表示しない・Secret はそのまま）
#   places-backend.googleapis.com（Places API）/ geocoding-backend.googleapis.com（Geocoding）/
#   mapstools.googleapis.com（Maps Agent Tools）/ places.googleapis.com（Places API (New)・写真用に追加）
# 本番の Places キー・Cloud Run・トラフィックには触れない
# =====================================================================
set -euo pipefail
PROJECT_ID="ai-avator-492205"
KEY_NAME="$(gcloud services api-keys list --project="${PROJECT_ID}" --filter='displayName=m4-preview-maps' --format='value(name)')"
[ -n "${KEY_NAME}" ] && [ "$(echo "${KEY_NAME}" | wc -l)" = "1" ] || { echo "停止: m4-preview-maps のキーが 1 つに特定できません" >&2; exit 1; }
echo "変更前: $(gcloud services api-keys describe "${KEY_NAME}" --format='value(restrictions.apiTargets[].service)')"
gcloud services api-keys update "${KEY_NAME}" --project="${PROJECT_ID}" \
  --api-target=service=places-backend.googleapis.com --api-target=service=geocoding-backend.googleapis.com \
  --api-target=service=mapstools.googleapis.com --api-target=service=places.googleapis.com --quiet > /dev/null
echo "変更後: $(gcloud services api-keys describe "${KEY_NAME}" --format='value(restrictions.apiTargets[].service)')"
