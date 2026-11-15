#!/usr/bin/env bash
# =====================================================================
# 新ショップ推薦 S10 の本番化を戻す（Cloud Shell）: 本番トラフィックを travel-sp-base-00060-car へ 100% 戻す
#
#   bash ~/m4_rollback_production.sh
#
# トラフィックの割合だけを変える（リビジョン・Secret・環境変数・タグは変更しない）
# =====================================================================
set -euo pipefail
PROJECT_ID="ai-avator-492205"
REGION="us-central1"
SERVICE="travel-sp-base"
BASE_REVISION="travel-sp-base-00060-car"
GC=(--project="${PROJECT_ID}" --region="${REGION}")
gcloud run revisions describe "${BASE_REVISION}" "${GC[@]}" --format='value(metadata.name)' > /dev/null \
  || { echo "停止: ${BASE_REVISION} がありません" >&2; exit 1; }
gcloud run services update-traffic "${SERVICE}" "${GC[@]}" --to-revisions="${BASE_REVISION}=100" --quiet > /dev/null
gcloud run services describe "${SERVICE}" "${GC[@]}" --format="json(status.traffic)" | python3 -c "
import json, sys
live = [t for t in json.load(sys.stdin)['status']['traffic'] if t.get('percent')]
print('本番トラフィック:', [(t.get('revisionName'), t.get('percent')) for t in live])
sys.exit(0 if len(live) == 1 and live[0].get('revisionName') == '${BASE_REVISION}' and live[0].get('percent') == 100 else 1)"
echo "完了: 本番は ${BASE_REVISION} 100% に戻りました"
