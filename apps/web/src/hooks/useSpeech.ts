import { useCallback, useEffect, useRef } from "react";
import type { SpeechEvent } from "../types";

export function useSpeech(enabled: boolean, types: string[]) {
  const queue = useRef<string[]>([]);
  const speaking = useRef(false);
  const seen = useRef<Set<string>>(new Set());
  const enabledRef = useRef(enabled);
  const typesRef = useRef(types);

  enabledRef.current = enabled;
  typesRef.current = types;

  const stopAll = useCallback(() => {
    queue.current = [];
    speaking.current = false;
    if (window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
  }, []);

  const flush = useCallback(() => {
    if (!enabledRef.current || speaking.current) return;
    if (!window.speechSynthesis) return;

    const text = queue.current.shift();
    if (!text) return;

    speaking.current = true;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "zh-CN";
    u.rate = 1.05;
    u.onend = () => {
      speaking.current = false;
      if (enabledRef.current) flush();
    };
    u.onerror = () => {
      speaking.current = false;
      if (enabledRef.current) {
        window.setTimeout(() => flush(), 200);
      }
    };
    window.speechSynthesis.speak(u);
  }, []);

  const push = useCallback(
    (events: SpeechEvent[]) => {
      if (!enabledRef.current) return;
      for (const e of events) {
        if (!typesRef.current.includes(e.type)) continue;
        const key = `${e.type}-${e.code}-${e.board_count}-${e.text}`;
        if (seen.current.has(key)) continue;
        seen.current.add(key);
        queue.current.push(e.text);
      }
      if (seen.current.size > 500) {
        seen.current = new Set([...seen.current].slice(-200));
      }
      flush();
    },
    [flush],
  );

  useEffect(() => {
    stopAll();
  }, [enabled, stopAll]);

  return { push, stopAll };
}
