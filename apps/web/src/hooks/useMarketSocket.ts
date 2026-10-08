import { useCallback, useEffect, useRef, useState } from "react";
import type { MarketSnapshot, SpeechEvent } from "../types";

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
};

function wsUrl(): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/ws/market`;
}

export function useMarketSocket(onSpeech?: (events: SpeechEvent[]) => void) {
  const [snapshot, setSnapshot] = useState<MarketSnapshot>(empty);
  const [connected, setConnected] = useState(false);
  const onSpeechRef = useRef(onSpeech);
  onSpeechRef.current = onSpeech;

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
          setSnapshot(data);
          if (data.speech_events?.length) {
            onSpeechRef.current?.(data.speech_events);
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
