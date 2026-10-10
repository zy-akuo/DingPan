import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:17831",
        configure: (proxy) => {
          proxy.on("error", (err) => {
            // 后端 --reload 重启 / 页面刷新会重置代理连接，属开发期预期噪音（前端 2s 自动重连）
            const msg = err instanceof Error ? err.message : String(err);
            if (!/ECONNRESET|ECONNREFUSED/.test(msg)) {
              console.warn("[http proxy]", msg);
            }
          });
        },
      },
      "/ws": {
        target: "ws://127.0.0.1:17831",
        ws: true,
        configure: (proxy) => {
          proxy.on("error", (err) => {
            const msg = err instanceof Error ? err.message : String(err);
            if (!/ECONNRESET|ECONNREFUSED/.test(msg)) {
              console.warn("[ws proxy]", msg);
            }
          });
        },
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
