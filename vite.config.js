import { defineConfig } from 'vite';
import { resolve } from 'node:path';
// https://vite.dev/guide/static-deploy#github-pages
export default defineConfig({
  base: './',
  worker: { format: 'es' },
  build: { target: 'es2022', chunkSizeWarningLimit: 700,
    rollupOptions: { preserveEntrySignatures: 'strict', input: { app: resolve('index.html'), api: resolve('src/public-api.js') }, output: { entryFileNames: info => info.name === 'api' ? 'api.js' : 'assets/[name]-[hash].js' } }
  },
  optimizeDeps: { exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/core'] }
});
