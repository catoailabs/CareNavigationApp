import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    tailwindcss(),
    react(),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    host: true,
    watch: {
      // The Python agent writes runtime artifacts (a live Chromium profile,
      // logs, REPL state, streaming event logs) into the workspace during a
      // run. Vite watches the project root by default, so each of those writes
      // triggers a full-page reload — which wipes the in-progress chat. Ignore
      // those agent-owned paths so the frontend stays stable while the agent
      // runs. Directory ignores are anchored to the repo root so they never
      // match similarly-named folders under src/ (e.g. src/data).
      ignored: [
        path.resolve(__dirname, 'tools/.runtime') + '/**',
        path.resolve(__dirname, 'logs') + '/**',
        path.resolve(__dirname, 'repl_state') + '/**',
        path.resolve(__dirname, 'errors') + '/**',
        path.resolve(__dirname, 'slack_events') + '/**',
        path.resolve(__dirname, 'data') + '/**',
        path.resolve(__dirname, 'templates') + '/**',
        '**/.venv/**',
        '**/__pycache__/**',
        '**/*.jsonl',
        '**/*.log',
      ],
    },
    proxy: {
      // Proxy to Chrome DevTools Protocol for real tab access.
      // The agent-desktop container publishes only the CDP forwarder port 9223
      // (0.0.0.0:9223 -> 127.0.0.1:9222 inside the container); Chromium's raw
      // 9222 is loopback-only and never published. Point the proxy at 9223 so
      // the frontend tab-bridge and the host agent both reach CDP the same way.
      '/api/chrome-tabs': {
        target: 'http://localhost:9223',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/chrome-tabs/, '/json'),
      },
      '/api/chrome-ws': {
        target: 'ws://localhost:9223',
        ws: true,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/chrome-ws/, ''),
      },
      '/api/chat': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
      },
      '/api/settings': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
      },
      '/api/catalog': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
      },
      '/api/google': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
      },
    },
  },
})
