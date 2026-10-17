import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// Tauri 用固定端口 + 严格端口，避免 devServer 随机跳端口导致前端连不上后端
export default defineConfig({
  plugins: [vue()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: '127.0.0.1',
  },
  build: {
    outDir: 'dist',
    target: 'es2021',
  },
});
