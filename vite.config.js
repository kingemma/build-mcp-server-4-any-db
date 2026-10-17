import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// Electron 打包后用 file:// 加载，资源必须用相对路径，否则 /assets/* 会 404
export default defineConfig({
  base: './',
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
