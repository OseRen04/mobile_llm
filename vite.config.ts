import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('./apps/web', import.meta.url)),
  base: './',
  plugins: [react()],
  worker: { format: 'es' },
  build: {
    outDir: '../../dist/web', emptyOutDir: true, chunkSizeWarningLimit: 2500,
    rollupOptions: { input: process.env.VITE_MODEL_TEST === '1'
      ? { main: fileURLToPath(new URL('./apps/web/index.html', import.meta.url)), modelTest: fileURLToPath(new URL('./apps/web/model-test.html', import.meta.url)) }
      : fileURLToPath(new URL('./apps/web/index.html', import.meta.url)) },
  },
  server: { fs: { allow: [fileURLToPath(new URL('.', import.meta.url))] } },
});
