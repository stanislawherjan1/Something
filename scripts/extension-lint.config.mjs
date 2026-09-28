// Flat ESLint config for the browser extension's plain scripts. The one rule
// that matters is no-undef: sidepanel.js is hand-edited plain JS, and a call
// to a function that never got defined passes `node --check` and every test
// that extracts functions, then breaks every observation at runtime (it did,
// 2026-09-27: `previousEntry is not defined`). Run via scripts/test-tab-executor.mjs
// or: ide-template/frontend/node_modules/.bin/eslint -c scripts/extension-lint.config.mjs chrome-extension/*.js
export default [
  {
    files: ['chrome-extension/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: {
        chrome: 'readonly', window: 'readonly', document: 'readonly', navigator: 'readonly',
        fetch: 'readonly', URL: 'readonly', URLSearchParams: 'readonly', performance: 'readonly',
        setTimeout: 'readonly', clearTimeout: 'readonly', console: 'readonly', getSelection: 'readonly',
        innerWidth: 'readonly', innerHeight: 'readonly', location: 'readonly',
        atob: 'readonly', crypto: 'readonly', TextEncoder: 'readonly',
      },
    },
    rules: { 'no-undef': 'error', 'no-unused-vars': ['warn', { args: 'none' }] },
  },
];
