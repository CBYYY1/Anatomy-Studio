import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 开发时前端在 5173，后端在 8788，全部 /api 走代理；
// 打包后由 FastAPI 的 StaticFiles 直接托管 dist/，无需代理。
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://127.0.0.1:8788", changeOrigin: true },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    chunkSizeWarningLimit: 1200,
  },
});
