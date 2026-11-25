import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const projectRoot = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(projectRoot, 'index.html'),
        bitmono: resolve(projectRoot, 'bitmono/index.html')
      }
    }
  },
  server: {
    host: '0.0.0.0',
    proxy: {
      '/api': process.env.BITCIDER_DEV_BACKEND || 'http://127.0.0.1:8787'
    }
  }
});
