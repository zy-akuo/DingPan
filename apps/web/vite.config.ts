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

/** Vite8 / http-proxy 类型对 error 监听签名过严，运行时仍按标准 EventEmitter 处理 */
function attachQuietProxy(proxy: { on: (event: string, fn: (...args: unknown[]) => void) => void }) {
  proxy.on("error", (...args: unknown[]) => {
    const err = args[0];
    const msg = err instanceof Error ? err.message : String(err ?? "");
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
        // 类型断言：规避 Vite ProxyServer 与 @types/http-proxy 的 never 冲突
        configure: attachQuietProxy as (proxy: unknown) => void,
      },
      "/ws": {
        target: "ws://127.0.0.1:17831",
        ws: true,
        configure: attachQuietProxy as (proxy: unknown) => void,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
