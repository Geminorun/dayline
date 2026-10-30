import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { VitePWA } from 'vite-plugin-pwa';
export default defineConfig({
  plugins: [
    vue(),
    VitePWA({
      injectRegister: false,
      registerType: 'prompt',
      manifest: {
        id: '/',
        name: '日序 · Dayline',
        short_name: '日序',
        description: '记录持续的经历，回看每天的重点。',
        lang: 'zh-CN',
        start_url: '/day',
        scope: '/',
        display: 'standalone',
        background_color: '#f6f7f4',
        theme_color: '#35594b',
        icons: [
          {
            src: '/icons/icon-192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: '/icons/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: '/icons/maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,png,svg,woff,woff2}'],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [
          /^\/(?:api|health)(?:[/?]|$)/,
          /\/\./,
          /\.[^/]+$/,
        ],
        runtimeCaching: [],
        skipWaiting: false,
        clientsClaim: true,
        cleanupOutdatedCaches: true,
      },
    }),
  ],
  server: { proxy: { '/api': 'http://127.0.0.1:3000' } },
});
