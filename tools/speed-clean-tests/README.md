# speed-clean フロント検証（外部リンク後送りの検索ID隔離）

ビルド済み `dist/` を使ったブラウザ検証。本番・Vercel には影響しない。

```bash
npm ci && npx astro build
# 1) core-controller の search_id 判定（ダミー Socket.IO サーバーがイベントを順に送る）
python tools/speed-clean-tests/sio_server.py "$PWD/dist" &   # Flask-SocketIO が必要（support-base/requirements.txt）
node tools/speed-clean-tests/link_update_e2e.cjs             # http://127.0.0.1:4398/concierge/
# 2) ShopCardList の updateLinks（dist を静的配信して実行）
(cd dist && python -m http.server 4399 &) ; node tools/speed-clean-tests/card_update.cjs
```

期待結果（link_update_e2e）: S1 のリンクは S1 表示中のみ反映、S2 開始後に届いた S1 の更新と、
0件だった S2 の更新は無視、S3 は PC のカードのみ hotpepper が付き、`name` は書き換わらない。
