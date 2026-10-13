import { useCallback, useEffect, useRef } from "react";
import type { AlertEvent, SpeechEvent } from "../types";

type QueueItem = { text: string; kind: "normal" | "alert" };

export function useSpeech(
  enabled: boolean,
  types: string[],
  alertEnabled = false,
  alertTypes: string[] = [],
) {
  const queue = useRef<QueueItem[]>([]);
  const speaking = useRef(false);
  const seen = useRef<Set<string>>(new Set());
  const enabledRef = useRef(enabled);
  const typesRef = useRef(types);
  const alertEnabledRef = useRef(alertEnabled);
  const alertTypesRef = useRef(alertTypes);
  const cancelingRef = useRef(false);

  enabledRef.current = enabled;
  typesRef.current = types;
  alertEnabledRef.current = alertEnabled;
  alertTypesRef.current = alertTypes;

  const stopAll = useCallback(() => {
    queue.current = [];
    speaking.current = false;
    cancelingRef.current = true;
    if (window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
    window.setTimeout(() => {
      cancelingRef.current = false;
    }, 50);
  }, []);

  const pruneQueue = useCallback(() => {
    queue.current = queue.current.filter((item) => {
      if (item.kind === "normal") return enabledRef.current;
      return alertEnabledRef.current;
    });
  }, []);

  const flush = useCallback(() => {
    if (speaking.current || cancelingRef.current) return;
    if (!window.speechSynthesis) return;

    pruneQueue();
    let item: QueueItem | undefined;
    while (queue.current.length) {
      const next = queue.current.shift();
      if (!next) break;
      if (next.kind === "normal" && !enabledRef.current) continue;
      if (next.kind === "alert" && !alertEnabledRef.current) continue;
      item = next;
      break;
    }
    if (!item) return;

    speaking.current = true;
    const u = new SpeechSynthesisUtterance(item.text);
    u.lang = "zh-CN";
    if (item.kind === "alert") {
      u.rate = 0.95;
      u.pitch = 1.15;
    } else {
      u.rate = 1.05;
      u.pitch = 1.0;
    }
    u.onend = () => {
      speaking.current = false;
      if (!cancelingRef.current) flush();
    };
    u.onerror = () => {
      speaking.current = false;
      // cancel 触发的 error 不继续刷队列，避免开关切换时连环播报
      if (cancelingRef.current) return;
      window.setTimeout(() => flush(), 200);
    };
    window.speechSynthesis.speak(u);
  }, [pruneQueue]);

  const remember = (key: string) => {
    seen.current.add(key);
    if (seen.current.size > 800) {
      seen.current = new Set([...seen.current].slice(-300));
    }
  };

  const push = useCallback(
    (events: SpeechEvent[]) => {
      if (!enabledRef.current) return;
      let added = false;
      for (const e of events) {
        if (!typesRef.current.includes(e.type)) continue;
        // 不含时间：同一事件只播一次
        const key = `n:${e.type}:${e.code}:${e.board_count}:${e.text}`;
        if (seen.current.has(key)) continue;
        remember(key);
        queue.current.push({ text: e.text, kind: "normal" });
        added = true;
      }
      if (added) flush();
    },
    [flush],
  );

  const pushAlert = useCallback(
    (events: AlertEvent[]) => {
      if (!alertEnabledRef.current) return;
      const alertItems: QueueItem[] = [];
      for (const e of events) {
        if (!alertTypesRef.current.includes(e.type)) continue;
        // 不含秒级时间，避免同一异动边沿因推送重复入队
        const key = `a:${e.type}:${e.code}:${e.text}:${e.detail}`;
        if (seen.current.has(key)) continue;
        remember(key);
        alertItems.push({ text: e.text, kind: "alert" });
      }
      if (!alertItems.length) return;
      queue.current = [...alertItems, ...queue.current];
      flush();
    },
    [flush],
  );

  useEffect(() => {
    pruneQueue();
    if (!enabled && !alertEnabled) {
      stopAll();
      return;
    }
    if (window.speechSynthesis?.speaking) {
      cancelingRef.current = true;
      window.speechSynthesis.cancel();
      speaking.current = false;
      window.setTimeout(() => {
        cancelingRef.current = false;
        flush();
      }, 80);
      return;
    }
    flush();
  }, [enabled, alertEnabled, pruneQueue, stopAll, flush]);

  return { push, pushAlert, stopAll };
}
