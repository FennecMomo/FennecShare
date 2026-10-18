import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 开发期只有一个 API 端口，由 API_PROXY_TARGET 覆盖；生产构建里不会出现任何 localhost 地址，
// 前端所有请求都走同源相对路径（/api/...、/play/...、/download/...）。
const apiTarget = process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:8787';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist/web',
    emptyOutDir: true,
    target: 'es2022',
    assetsDir: 'assets',
    sourcemap: false,
    rollupOptions: {
      // 展示站首页 + 管理页面（/admin）两个入口，共用一套构建产物
      input: {
        main: resolve(__dirname, 'index.html'),
        admin: resolve(__dirname, 'admin.html'),
      },
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: apiTarget, changeOrigin: false },
      '/healthz': { target: apiTarget, changeOrigin: false },
      '/play': { target: apiTarget, changeOrigin: false },
      '/download': { target: apiTarget, changeOrigin: false },
      '/media': { target: apiTarget, changeOrigin: false },
      '/admin': { target: apiTarget, changeOrigin: false },
    },
  },
});
