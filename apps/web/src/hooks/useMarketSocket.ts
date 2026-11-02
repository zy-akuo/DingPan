import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AlertEvent,
  LadderGroup,
  MarketSnapshot,
  SpeechEvent,
} from "../types";

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

function ladderStockCount(ladder: LadderGroup[] | undefined): number {
  return (ladder || []).reduce((n, g) => n + (g.stocks?.length || 0), 0);
}

/** 服务端偶发瘦包时保留本地天梯，避免「3进4」等档位闪没。

 * 不对齐整档粘贴：消失的档位不再复活；仅向 next 已有同 key 档补「败」，
 * 且该代码尚未出现在 next 任意档（防幽灵短板/跨档重复）。
 */
function keepLadder(
  prev: LadderGroup[] | undefined,
  next: LadderGroup[] | undefined,
  sameDay: boolean,
): LadderGroup[] {
  const p = prev || [];
  const n = next || [];
  if (!n.length && p.length) return p;
  if (!sameDay || !p.length) return n;

  const pn = ladderStockCount(p);
  const nn = ladderStockCount(n);
  // 仅接近空时整表保留；禁止 0.6 阈值把「纠偏后的正确瘦梯」盖回错误胖梯
  if (pn >= 5 && nn < Math.max(2, Math.min(6, Math.floor(pn * 0.2)))) return p;

  const nextMap = new Map(n.map((g) => [g.key, { ...g, stocks: [...(g.stocks || [])] }]));
  const present = new Set<string>();
  for (const g of nextMap.values()) {
    for (const s of g.stocks || []) present.add(s.code);
  }

  let changed = false;
  for (const g of p) {
    if (g.key === "first" || !g.stocks?.length) continue;
    const cur = nextMap.get(g.key);
    // 不复活已消失档位（避免上一交易日/瘦包幽灵整档贴回）
    if (!cur) continue;
    const extra = (g.stocks || []).filter(
      (s) => s.status === "败" && !present.has(s.code),
    );
    if (!extra.length) continue;
    cur.stocks = [...cur.stocks, ...extra];
    for (const s of extra) present.add(s.code);
    nextMap.set(g.key, cur);
    changed = true;
  }
  if (!changed) return n;

  const body = [...nextMap.values()].filter((g) => g.key !== "first");
  body.sort((a, b) => {
    const av = Number(String(a.key).split("-")[0]) || 0;
    const bv = Number(String(b.key).split("-")[0]) || 0;
    return bv - av;
  });
  const first = nextMap.get("first");
  return first ? [...body, first] : body;
}

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
            const sameDay =
              !!prev.trade_date &&
              !!data.trade_date &&
              prev.trade_date === data.trade_date;
            const ladder = keepLadder(prev.ladder, data.ladder, sameDay);
            return { ...data, alert_feed: nextFeed, ladder };
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
