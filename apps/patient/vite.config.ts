import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import path from 'path';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['fonts/*.woff2', 'icons/icon-*.png'],
      manifest: {
        name: 'RecoveryOS — מטופל',
        short_name: 'RecoveryOS',
        description: 'תוכנית השיקום היומית שלי',
        theme_color: '#1B2140',
        background_color: '#F6EFE3',
        display: 'standalone',
        start_url: '/m/',
        icons: [
          { src: '/m/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/m/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
        ],
      },
      workbox: {
        // Cache-first for exercise media; SWR for plan JSON; network-only for everything else.
        runtimeCaching: [
          {
            urlPattern: /\/(exercise-media|exercises)\/.+\.(jpe?g|png|webp|mp4|webm)$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'exercise-media',
              expiration: { maxEntries: 200, maxAgeSeconds: 60 * 60 * 24 * 30 },
            },
          },
          {
            urlPattern: /\/functions\/v1\/me\/(today|plan|progress)$/,
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'plan-json',
              expiration: { maxEntries: 5, maxAgeSeconds: 60 * 60 * 12 },
            },
          },
        ],
      },
    }),
  ],
  base: '/m/',
  resolve: {
    alias: {
      ui: path.resolve(__dirname, '../../packages/ui/src'),
      tokens: path.resolve(__dirname, '../../packages/tokens/src'),
      shared: path.resolve(__dirname, '../../packages/shared/src'),
      offline: path.resolve(__dirname, '../../packages/offline/src'),
    },
  },
  server: {
    port: 5174,
  },
});
