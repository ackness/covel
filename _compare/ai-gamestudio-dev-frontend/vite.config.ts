import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

// Ensure the dev server proxy connects directly to the local backend,
// bypassing any system HTTP proxy (e.g. Clash, V2Ray on 127.0.0.1:7897).
process.env.NO_PROXY = (process.env.NO_PROXY || process.env.no_proxy || '')
  .split(',')
  .concat(['localhost', '127.0.0.1'])
  .filter(Boolean)
  .join(',')

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://localhost:8000',
        ws: true,
      },
    },
  },
})
