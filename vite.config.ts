import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The front end lives in client/; the API (server/) is proxied in dev and runs as a Vercel Function in prod.
export default defineConfig({
  root: 'client',
  plugins: [react()],
  build: { outDir: '../dist', emptyOutDir: true },
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:8787' },
  },
})
