import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('./apps/extension', import.meta.url)),
  base: './',
  plugins: [react()],
  worker: { format: 'es' },
  build: { outDir: '../../dist/extension', emptyOutDir: true, chunkSizeWarningLimit: 2500 },
});
