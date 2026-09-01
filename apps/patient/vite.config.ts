import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import path from 'path';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // injectManifest so src/sw.ts can own both the T-12 runtime caching and
      // the T-18 push / notificationclick handlers.
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'autoUpdate',
      includeAssets: ['fonts/*.woff2', 'icons/icon-*.png'],
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,woff2,png,svg}'],
      },
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
