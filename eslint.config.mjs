// Shared ESLint (v9 flat config) for the pnpm workspace — .mjs because the
// root package.json isn't ESM. Each package's `lint` script runs `eslint src`
// from its own directory; ESLint finds this file by walking up. Edge
// functions and scripts are Deno — `deno lint` covers those, so they're
// ignored here.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', 'supabase/**', 'scripts/**', 'firebase-public/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.serviceworker },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      // The two classic hook rules only — v7's "recommended" preset also turns
      // on the React Compiler rules, which this codebase isn't written for.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },
);
