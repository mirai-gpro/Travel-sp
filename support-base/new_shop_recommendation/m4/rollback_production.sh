#!/usr/bin/env bash
# =====================================================================
# 本番トラフィックを指定のリビジョン（省略時は travel-sp-base-00060-car）へ 100% 固定で戻す（Cloud Shell）
#
#   bash ~/m4_rollback_production.sh                 00060-car（S10 の前）へ
#   bash ~/m4_rollback_production.sh <リビジョン名>   指定のリビジョンへ（例: travel-sp-base-prod-b53037f）
#
# 最新のリビジョンへの追従もやめる（固定になる）。戻した後は CI のデプロイは本番に届かない
#
# トラフィックの割合だけを変える（リビジョン・Secret・環境変数・タグは変更しない）
# =====================================================================
set -euo pipefail
PROJECT_ID="ai-avator-492205"
REGION="us-central1"
SERVICE="travel-sp-base"
BASE_REVISION="${1:-travel-sp-base-00060-car}"
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
