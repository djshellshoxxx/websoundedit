import { defineConfig, defaultClientConditions } from 'vite';
import { resolve } from 'node:path';
// https://vite.dev/guide/static-deploy#github-pages
export default defineConfig({
  base: './',
  // Runtime binaries are copied once to stems-runtime; avoid a second bundled
  // WASM copy from ONNX's default embedded-loader entry.
  resolve: { conditions: ['onnxruntime-web-use-extern-wasm', ...defaultClientConditions] },
  worker: { format: 'es' },
  build: { target: 'es2022', chunkSizeWarningLimit: 700,
    rollupOptions: { preserveEntrySignatures: 'strict', input: { app: resolve('index.html'), stems: resolve('stem-lab.html'), api: resolve('src/public-api.js') }, output: { entryFileNames: info => info.name === 'api' ? 'api.js' : 'assets/[name]-[hash].js' } }
  },
  optimizeDeps: { exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/core', 'onnxruntime-web', 'onnxruntime-web/wasm'] }
});
