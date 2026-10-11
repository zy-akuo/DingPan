import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/** 开发期后端 reload / 页面刷新会掐断代理连接，属预期噪音 */
const PROXY_NOISE =
  /ECONNABORTED|ECONNRESET|ECONNREFUSED|EPIPE|ws proxy error|ws proxy socket error|http proxy error/i;

function quietDevProxyErrors(): Plugin {
  return {
    name: "quiet-dev-proxy-errors",
    configureServer(server) {
      const logger = server.config.logger;
      const origError = logger.error.bind(logger);
      logger.error = (msg, options) => {
        const text = typeof msg === "string" ? msg : String(msg);
        if (PROXY_NOISE.test(text)) return;
        const errMsg =
          options?.error instanceof Error
            ? options.error.message
            : options?.error
              ? String(options.error)
              : "";
        if (errMsg && PROXY_NOISE.test(errMsg)) return;
        origError(msg, options);
      };
    },
  };
}

function attachQuietProxy(proxy: {
  on: (event: string, fn: (err: Error) => void) => void;
}) {
  proxy.on("error", (err) => {
    const msg = err instanceof Error ? err.message : String(err);
    if (!PROXY_NOISE.test(msg)) {
      console.warn("[proxy]", msg);
    }
  });
}

export default defineConfig({
  plugins: [react(), quietDevProxyErrors()],
  server: {
    // 固定 IPv4，避免只监听 [::1] 导致浏览器打开 127.0.0.1:5173 被拒绝
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:17831",
        configure: attachQuietProxy,
      },
      "/ws": {
        target: "ws://127.0.0.1:17831",
        ws: true,
        configure: attachQuietProxy,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
