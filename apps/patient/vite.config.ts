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
        // Without these, a newly-installed SW never takes control of the
        // page that installed it — it only starts intercepting fetches (and
        // so populating the runtime caches below) on the *next* navigation.
        // A patient who installs the app and goes straight offline (T-12's
        // "go offline, run a full session") would then find nothing cached.
        clientsClaim: true,
        skipWaiting: true,
        // Cache-first for exercise media; SWR for plan JSON; network-only for everything else.
        //
        // These match on url.pathname via a function rather than passing a
        // RegExp directly: Workbox only honors a RegExp route for a
        // cross-origin request when the match starts at index 0 of the full
        // URL, and both the Supabase API and Storage are on a different
        // origin from the app in every environment (127.0.0.1:54321 in
        // local dev, a supabase.co host in production) — a path-only regex
        // never starts at 0 there, so it silently never matched.
        runtimeCaching: [
          {
            urlPattern: ({ url }) =>
              /\/(exercise-media|exercises)\/.+\.(jpe?g|png|webp|mp4|webm)$/.test(url.pathname),
            handler: 'CacheFirst',
            options: {
              cacheName: 'exercise-media',
              expiration: { maxEntries: 200, maxAgeSeconds: 60 * 60 * 24 * 30 },
            },
          },
          {
            urlPattern: ({ url }) => /\/functions\/v1\/me-(today|plan|progress)$/.test(url.pathname),
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
