import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Toggle: `MOCK=1 npm run dev` (or `npm run dev:mock`) replaces the
// workspace-api proxy with a fixture-driven middleware so the UI can be
// iterated on without booting the full Docker stack.
//
// The mock plugin lives under `dev-mock/` which is gitignored — local-only
// dev tooling, not shipped. If MOCK=1 is set but the directory isn't
// present (e.g. fresh clone), we warn and continue without it.
const useMock = process.env.MOCK === '1'
let memoryMockPlugin = null
if (useMock) {
  try {
    memoryMockPlugin = (await import('./dev-mock/vite-plugin.mjs')).memoryMockPlugin
  } catch {
    console.warn('[vite] MOCK=1 set but ./dev-mock/vite-plugin.mjs not found — falling back to proxy.')
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    memoryMockPlugin ? memoryMockPlugin() : null,
    {
      name: 'html-env',
      transformIndexHtml(html) {
        return html.replace('%VITE_APP_TITLE%', process.env.VITE_APP_TITLE || 'IDE')
      }
    }
  ].filter(Boolean),
  base: '/app/',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    // Local dev without MOCK=1: workspace-api on :3001. In prod, Caddy
    // routes /api/* directly to workspace-api so this proxy is dev-only.
    // With MOCK=1, the plugin above intercepts /api/* + /auth/* with
    // fixture JSON before this proxy gets a chance.
    proxy: memoryMockPlugin ? undefined : {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        // Local dev only: workspace-api expects either a JWT cookie OR a
        // validated X-IDE-User header from nginx. In dev we run without
        // either, so we forge the header here. Gated behind `DEV_LOCAL=1`
        // so the proxy still 401s by default for safety (you don't want
        // a random `npm run dev` against a real workspace-api to silently
        // grant access). Pair with workspace-api launched via
        // scripts/dev-local.sh which clears SESSION_SECRET so the header
        // gets honored.
        headers: process.env.DEV_LOCAL === '1'
          ? { 'X-IDE-User': process.env.DEV_ACTOR || 'dev@local.dev' }
          : undefined,
      },
    },
  },
})
