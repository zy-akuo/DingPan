import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

/**
 * 轻量固定行高虚拟列表：高频刷新时只渲染可视区，避免几百行整表重绘导致卡顿/错乱。
 */
export function AuctionVirtualList<T>({
  items,
  rowHeight,
  maxHeight,
  overscan = 6,
  getKey,
  renderRow,
  className,
}: {
  items: T[];
  rowHeight: number;
  maxHeight: number;
  overscan?: number;
  getKey: (item: T, index: number) => string;
  renderRow: (item: T, index: number) => ReactNode;
  className?: string;
}) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(maxHeight);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const measure = () => {
      const h = el.clientHeight || maxHeight;
      setViewport(h);
    };
    measure();
    const ro =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(measure)
        : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [maxHeight]);

  const onScroll = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    setScrollTop(el.scrollTop);
  }, []);

  const total = items.length;
  const rh = Math.max(1, rowHeight);
  const visibleCount = Math.ceil(viewport / rh) + overscan * 2;
  const start = Math.max(0, Math.floor(scrollTop / rh) - overscan);
  const end = Math.min(total, start + visibleCount);
  const offsetY = start * rh;
  const slice = items.slice(start, end);

  // 条数很少时直接全量渲染，避免虚拟滚动额外开销
  if (total <= Math.ceil(maxHeight / rh) + 2) {
    return (
      <div
        className={className}
        style={
          {
            height: maxHeight,
            maxHeight,
            overflowY: "auto",
          } as CSSProperties
        }
      >
        {items.map((item, i) => (
          <div key={getKey(item, i)} style={{ minHeight: rh }}>
            {renderRow(item, i)}
          </div>
        ))}
      </div>
    );
  }

  return (
    <div
      ref={scrollerRef}
      className={className}
      onScroll={onScroll}
      style={{
        height: maxHeight,
        maxHeight,
        overflowY: "auto",
        position: "relative",
      }}
    >
      <div style={{ height: total * rh, position: "relative" }}>
        <div style={{ transform: `translateY(${offsetY}px)` }}>
          {slice.map((item, i) => {
            const index = start + i;
            return (
              <div
                key={getKey(item, index)}
                style={{ height: rh, boxSizing: "border-box" }}
              >
                {renderRow(item, index)}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
