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
    rollupOptions: {
      output: {
        // 框架与组件库单独成 chunk：它们很少变，升级业务代码时浏览器缓存仍可复用。
        // Element Plus 仍是全量引入（main.js），这里只做缓存隔离，不减少总量。
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('element-plus') || id.includes('@element-plus')) return 'element-plus';
          if (
            id.includes('node_modules/vue/') ||
            id.includes('node_modules/@vue/') ||
            id.includes('vue-router') ||
            id.includes('pinia') ||
            id.includes('vue-i18n') ||
            id.includes('@intlify')
          ) {
            return 'vue';
          }
          return undefined;
        },
      },
    },
    // Element Plus 全量 chunk 本身约 1 MB，属于已知取舍（见 docs/FEATURES.md）
    chunkSizeWarningLimit: 1100,
  },
});
