// astro.config.mjs
import { defineConfig } from 'astro/config';
import AstroPWA from '@vite-pwa/astro';

export default defineConfig({
  output: 'static',
  build: {
    assets: 'assets'
  },
  server: {
    port: 4321,
    host: true
  },
  vite: {
    envPrefix: 'PUBLIC_',
    build: {
      charset: 'utf8'
    }
  },
  integrations: [
    AstroPWA({
      registerType: 'autoUpdate',
      // ▼▼▼ 重要: 生成されるファイル名をHTMLと一致させる ▼▼▼
      manifestFilename: 'manifest.webmanifest',
      // ▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲

      // avatar-config.json だけ明示的に precache する。offline でも avatar 定義を
      // 読めるようにするための補助であって、local 起動の条件ではない。
      // avatars-manifest.json は precache しない (更新検知は常に最新を見る)。
      //
      // TODO(poster): Poster 実ファイルを用意したら、offline でも出せるように
      //   ここへ 'avatar/posters/uika-full133.webp' を追加する。
      //   現時点では実ファイルが存在しないため追加しない (build が壊れる)。
      //   Poster 要件: FULL133 と同一カメラ (posY 1.704 / posZ 0.45 /
      //   targetY 1.644 / offsetX 0.045)、neutral pose、同一背景、同一 crop。
      includeAssets: ['favicon.svg', 'apple-touch-icon.png', 'avatar/avatar-config.json'],
      manifest: {
        name: 'Travel AI',
        short_name: 'Travel AI',
        description: '旅行をサポートするAIアプリ',
        theme_color: '#ffffff',
        background_color: '#ffffff',
        display: 'standalone',
        scope: '/',
        start_url: '/',
        icons: [
          {
            src: 'pwa-192x192.png', // publicフォルダにこの画像があること！
            sizes: '192x192',
            type: 'image/png'
          },
          {
            src: 'pwa-512x512.png', // publicフォルダにこの画像があること！
            sizes: '512x512',
            type: 'image/png'
          }
        ]
      },
      workbox: {
        // navigateFallback は **precache manifest に実在する URL** でなければ
        // ならない。生成 manifest の index entry は clean URL の '/' で、
        // '/index.html' は存在しない。'/index.html' を指定すると install 時に
        //   non-precached-url :: [{"url":"/index.html"}]
        // で SW が activate できず、active: null のままになる (実機で確認)。
        navigateFallback: '/',
        globPatterns: ['**/*.{css,js,html,svg,png,ico,txt}'],

        // avatar local package を Cache Storage からのみ返す cache-only route。
        // 生成 SW の先頭で読み込まれる加算スクリプトで、Workbox の route 定義
        // には触らない。network fallback を持たないので、未インストール状態で
        // 25MB を暗黙に download する経路は作られない。
        importScripts: ['/sw-avatar-local.js'],
        // 404.html は precache しない。clean URL の '/404' として登録され、
        // 実際に GET すると Vercel は status 404 を返すため
        //   bad-precaching-response :: [{"url":".../404","status":404}]
        // で SW の install が失敗する (実機で確認)。deploy 自体には残る。
        // sw-avatar-local.js も precache しない (SW から importScripts するだけ)。
        globIgnores: ['**/node_modules/**/*', '404.html', 'sw-avatar-local.js']
      }
    })
  ]
});
