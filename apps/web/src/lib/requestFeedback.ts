export type RequestNotice = { kind: "error" | "success"; title: string; description: string };
export const REQUEST_NOTICE_EVENT = "dingpan:request-notice";

export function requestLabel(path: string): string {
  if (path.includes("/market/overview")) return "大盘概览";
  const code = path.match(/\/stock\/(\d+)/)?.[1];
  if (path.includes("/kline")) return `${code || "个股"} 日K`;
  if (path.includes("/trends")) return `${code || "个股"} 分时`;
  if (path.includes("/auction/prev")) return "昨日连板竞价";
  if (path.includes("/auction")) return "早盘竞价";
  if (path.includes("/history")) return "历史回溯";
  if (path.includes("/config")) return "设置";
  if (path.includes("/search")) return "股票搜索";
  if (path.includes("/stock/")) return `${code || "个股"} 数据`;
  return `数据请求（${path}）`;
}

/** 统一覆盖现有 fetch 调用，包括响应体等待；主动取消不提醒。 */
export function installRequestFeedback(timeoutMs = 30_000): void {
  const original = window.fetch.bind(window);
  const failed = new Map<string, number>();
  const emit = (notice: RequestNotice) => window.dispatchEvent(new CustomEvent(REQUEST_NOTICE_EVENT, { detail: notice }));
  window.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
    if (url.origin !== window.location.origin || !url.pathname.startsWith("/api/")) return original(input, init);
    const key = url.pathname;
    const label = requestLabel(key);
    const controller = new AbortController();
    const callerSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const cancel = () => controller.abort(callerSignal?.reason);
    callerSignal?.addEventListener("abort", cancel, { once: true });
    if (callerSignal?.aborted) cancel();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const report = (description: string) => {
      const last = failed.get(key);
      failed.set(key, last ?? Date.now());
      if (last === undefined || Date.now() - last >= 60_000) {
        failed.set(key, Date.now());
        emit({ kind: "error", title: `${label}加载失败`, description });
      }
    };
    try {
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
          reject(new Error(`请求超时（${timeoutMs / 1000}秒），请检查网络或代理设置后重试`));
        }, timeoutMs);
      });
      const response = await Promise.race([
        (async () => {
          const result = await original(input, { ...init, signal: controller.signal });
          // 等待完整响应体，避免响应头已返回而 JSON 一直挂起。
          const body = await result.clone().text();
          if (timedOut || callerSignal?.aborted) throw new DOMException("请求已取消", "AbortError");
          let payload: { error?: unknown; detail?: unknown } | undefined;
          if (result.headers.get("content-type")?.includes("json")) {
            try { payload = JSON.parse(body); } catch {
              throw new Error("服务器响应格式异常，请重试");
            }
          }
          const error = typeof payload?.error === "string" ? payload.error : "";
          if (!result.ok || error) {
            const detail = error || (typeof payload?.detail === "string" ? payload.detail : "");
            report(`${result.ok ? "数据源返回异常" : `HTTP ${result.status}`}。${detail.slice(0, 180) || "请检查网络、代理或服务状态后重试"}`);
          } else if (failed.delete(key)) {
            emit({ kind: "success", title: `${label}请求已恢复`, description: "已重新收到正常响应" });
          }
          return result;
        })(),
        deadline,
      ]);
      return response;
    } catch (error) {
      if (callerSignal?.aborted && !timedOut) throw error;
      const message = timedOut
        ? `请求超时（${timeoutMs / 1000}秒），请检查网络或代理设置后重试`
        : error instanceof TypeError ? "网络连接失败，请检查网络、代理设置及后端服务" : error instanceof Error ? error.message : "请求失败，请重试";
      report(message);
      throw new Error(message);
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", cancel);
    }
  };
}
