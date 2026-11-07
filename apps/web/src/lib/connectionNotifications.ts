const STORAGE_KEY = "dingpan.connectionNotifications";

export function supportsDesktopNotifications(): boolean {
  return typeof Notification !== "undefined"
    && typeof Notification.requestPermission === "function"
    && window.isSecureContext !== false;
}

export function loadConnectionNotifications(): boolean {
  try {
    return supportsDesktopNotifications()
      && Notification.permission === "granted"
      && localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function saveConnectionNotifications(enabled: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(enabled));
  } catch {
    // Storage-disabled environments retain the preference for this session.
  }
}

export function showConnectionNotification(body: string, backgroundOnly = true): boolean {
  if (!supportsDesktopNotifications() || Notification.permission !== "granted") return false;
  if (backgroundOnly && document.visibilityState === "visible" && document.hasFocus()) return false;
  try {
    const notice = new Notification("盯盘 · 连接提醒", {
      body, tag: "dingpan-connection", silent: true,
    });
    notice.onclick = () => { window.focus(); notice.close(); };
    return true;
  } catch {
    // Native webviews may expose the API without implementing delivery.
    return false;
  }
}
