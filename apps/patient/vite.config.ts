import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import path from 'path';

// The VITE_* values live in the gitignored .env.production, so a build
// anywhere else (CI) used to succeed with them undefined and ship an app that
// crashes on load — a blank white page. Fail the build instead.
const REQUIRED_ENV = ['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY', 'VITE_VAPID_PUBLIC_KEY'];
function requireEnv(): Plugin {
  return {
    name: 'require-env',
    apply: 'build',
    configResolved(config) {
      const missing = REQUIRED_ENV.filter((k) => !config.env[k]);
      if (missing.length) throw new Error(`Missing build env: ${missing.join(', ')}`);
    },
  };
}

export default defineConfig({
  plugins: [
    requireEnv(),
    react(),
    VitePWA({
      // injectManifest so src/sw.ts can own both the T-12 runtime caching and
      // the T-18 push / notificationclick handlers.
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'autoUpdate',
      includeAssets: ['fonts/*.woff2', 'icons/*.svg'],
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,woff2,png,svg}'],
        // og-image / email-logo exist for link previews and emails only; the
        // app never renders them, so don't make every install download them.
        globIgnores: ['brand/**'],
      },
      manifest: {
        id: '/m/',
        name: 'ReCOVR',
        short_name: 'ReCOVR',
        description: 'תוכנית השיקום היומית שלי',
        lang: 'he',
        dir: 'rtl',
        theme_color: '#1B2140',
        background_color: '#F6EFE3',
        display: 'standalone',
        start_url: '/m/',
        scope: '/m/',
        icons: [
          { src: '/m/icons/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
          { src: '/m/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/m/icons/icon-maskable.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
        ],
      },
    }),
  ],
  base: '/m/',
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom'],
          supabase: ['@supabase/auth-js', '@supabase/functions-js'],
          query: ['@tanstack/react-query'],
        },
      },
    },
  },
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
