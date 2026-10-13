import { useCallback, useEffect, useRef, useState } from "react";
import type { AlertEvent, MarketSnapshot, SpeechEvent } from "../types";

const empty: MarketSnapshot = {
  trade_date: "",
  updated_at: "",
  summary: {
    zt_today: 0,
    zt_yesterday: 0,
    lb_today: 0,
    lb_yesterday: 0,
    seal_rate_today: 0,
    seal_rate_yesterday: 0,
    zb_today: 0,
    zb_yesterday: 0,
    dt_today: 0,
    dt_yesterday: 0,
  },
  zt: [],
  lb: [],
  zb: [],
  dt: [],
  ladder: [],
  speech_events: [],
  alert_events: [],
  alert_feed: [],
};

function wsUrl(): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/ws/market`;
}

export function useMarketSocket(
  onSpeech?: (events: SpeechEvent[]) => void,
  onAlert?: (events: AlertEvent[]) => void,
) {
  const [snapshot, setSnapshot] = useState<MarketSnapshot>(empty);
  const [connected, setConnected] = useState(false);
  const onSpeechRef = useRef(onSpeech);
  const onAlertRef = useRef(onAlert);
  onSpeechRef.current = onSpeech;
  onAlertRef.current = onAlert;

  const connect = useCallback(() => {
    let ws: WebSocket | null = null;
    let closed = false;
    let timer: number | undefined;

    const open = () => {
      ws = new WebSocket(wsUrl());
      ws.onopen = () => setConnected(true);
      ws.onclose = () => {
        setConnected(false);
        if (!closed) timer = window.setTimeout(open, 2000);
      };
      ws.onerror = () => ws?.close();
      ws.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data) as MarketSnapshot;
          setSnapshot((prev) => {
            // 空事件数组时保留本地已展示的 feed，避免行情推送冲掉流水
            const nextFeed =
              data.alert_events && data.alert_events.length
                ? data.alert_feed || data.alert_events
                : data.alert_feed?.length
                  ? data.alert_feed
                  : prev.alert_feed || [];
            return { ...data, alert_feed: nextFeed };
          });
          // 仅在本帧带有新事件时触发语音，防止空数组外的重复推送
          if (data.speech_events?.length) {
            onSpeechRef.current?.(data.speech_events);
          }
          if (data.alert_events?.length) {
            onAlertRef.current?.(data.alert_events);
          }
        } catch {
          /* ignore */
        }
      };
    };

    open();
    return () => {
      closed = true;
      if (timer) window.clearTimeout(timer);
      ws?.close();
    };
  }, []);

  useEffect(() => connect(), [connect]);

  return { snapshot, connected };
}
