# -*- coding: utf-8 -*-
"""
R1 の原因調査（Geocoding のみ）。プレビュー用 Maps キー（Secret m4-preview-maps-key）をプロセス内で読み、画面には出さない。
地名候補ごとに Geocoding の種別・部分一致・範囲の大きさ・判定（match_info）だけを表示する（住所の全文は表示しない）。

  python -m new_shop_recommendation.m4.scope_debug <query> [<query> ...]
"""
import subprocess
import sys

from new_shop_recommendation import scope as S
from new_shop_recommendation.flow_s import HttpApis
from new_shop_recommendation.redact import register_secret


def main():
    p = subprocess.run(['gcloud', 'secrets', 'versions', 'access', 'latest', '--secret=m4-preview-maps-key',
                        '--project=ai-avator-492205'], capture_output=True, text=True)
    if p.returncode != 0 or not p.stdout.strip():
        sys.exit('Secret m4-preview-maps-key を読めません')
    key = p.stdout.strip()
    register_secret(key)
    apis = HttpApis('', key)
    for q in sys.argv[1:]:
        print(f'\n## {q}')
        print(f'候補: {S.candidates(q)}')
        for cd in S.candidates(q):
            g = apis.geocode(cd)
            if g is None:
                print(f'  {cd}: 結果なし')
                continue
            vp = S._vp_size_km(g.get('viewport'))
            print(f'  {cd}: 種別={g.get("types")} 部分一致={g.get("partial_match")} 範囲の対角={round(vp, 1)}km '
                  f'判定={S.match_info(cd, g)} 種類={S.kind_of(g)} 住所要素={[n for n in g.get("component_names") or []][:6]}')
            if S.kind_of(g) == 'facility':
                pid = g.get('place_id')
                official, status = None, None
                if pid:
                    import requests
                    from new_shop_recommendation.flow_s import DETAILS_URL
                    d = requests.get(DETAILS_URL, params={'place_id': pid, 'fields': 'name', 'key': key, 'language': 'ja'},
                                     timeout=5).json()
                    status = d.get('status')
                    official = (d.get('result') or {}).get('name')
                print(f'      施設の確認: place_id={"あり" if pid else "なし"} Details={status} 正式名={official!r} '
                      f'照合={S.facility_name_matches(cd, official) if official else None}')
        sc = S.resolve_scope(q, apis.geocode, apis.place_name)
        print(f'→ 結果: 種類={sc.get("kind")} 地名={sc.get("area")} 半径={round(sc.get("radius_km") or 0, 2)} '
              f'根拠={sc.get("radius_reason")}/{sc.get("scope_reason")} 認めた地名={sc.get("places")}')


if __name__ == '__main__':
    main()
