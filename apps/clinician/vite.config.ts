import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
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
  plugins: [requireEnv(), react()],
  base: '/app/',
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom'],
          supabase: ['@supabase/supabase-js'],
          query: ['@tanstack/react-query'],
          router: ['@tanstack/react-router'],
        },
      },
    },
  },
  resolve: {
    alias: {
      ui: path.resolve(__dirname, '../../packages/ui/src'),
      tokens: path.resolve(__dirname, '../../packages/tokens/src'),
      shared: path.resolve(__dirname, '../../packages/shared/src'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:54321', // Supabase local
    },
  },
});
