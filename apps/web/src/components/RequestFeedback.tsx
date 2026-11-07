import { notification } from "antd";
import { useEffect } from "react";
import { REQUEST_NOTICE_EVENT, type RequestNotice } from "../lib/requestFeedback";

export function RequestFeedback() {
  const [api, holder] = notification.useNotification({ maxCount: 3 });
  useEffect(() => {
    const show = (event: Event) => {
      const notice = (event as CustomEvent<RequestNotice>).detail;
      api[notice.kind]({ title: notice.title, description: notice.description,
        key: notice.title, duration: notice.kind === "error" ? 8 : 3 });
    };
    window.addEventListener(REQUEST_NOTICE_EVENT, show);
    return () => window.removeEventListener(REQUEST_NOTICE_EVENT, show);
  }, [api]);
  return holder;
}
