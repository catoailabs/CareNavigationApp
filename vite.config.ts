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
    proxy: {
      // Proxy to Chrome DevTools Protocol for real tab access
      '/api/chrome-tabs': {
        target: 'http://localhost:9222',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/chrome-tabs/, '/json'),
      },
      '/api/chrome-ws': {
        target: 'ws://localhost:9222',
        ws: true,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/chrome-ws/, ''),
      },
      '/api/chat': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
      },
    },
  },
})
