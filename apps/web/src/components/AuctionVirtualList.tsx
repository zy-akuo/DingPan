import {
  useCallback,
  useEffect,
  useLayoutEffect,
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
  fillViewport = false,
}: {
  items: T[];
  rowHeight: number;
  maxHeight: number;
  overscan?: number;
  getKey: (item: T, index: number) => string;
  renderRow: (item: T, index: number) => ReactNode;
  className?: string;
  /** 按列表实际位置使用窗口剩余高度。 */
  fillViewport?: boolean;
}) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(maxHeight);

  const [availableHeight, setAvailableHeight] = useState(maxHeight);
  const listHeight = fillViewport
    ? Math.min(items.length * rowHeight, availableHeight)
    : maxHeight;

  useLayoutEffect(() => {
    if (!fillViewport) return;
    const el = scrollerRef.current;
    if (!el) return;
    const measure = () => {
      const top = el.getBoundingClientRect().top;
      setAvailableHeight(Math.max(rowHeight, window.innerHeight - Math.max(0, top) - 16));
    };
    measure();
    window.addEventListener("resize", measure);
    const observer = new ResizeObserver(measure);
    if (el.parentElement) observer.observe(el.parentElement);
    return () => {
      window.removeEventListener("resize", measure);
      observer.disconnect();
    };
  }, [fillViewport, items.length, rowHeight]);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const measure = () => {
      const h = el.clientHeight || listHeight;
      setViewport(h);
    };
    measure();
    const ro =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(measure)
        : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [listHeight]);

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
  if (total <= Math.ceil(listHeight / rh) + 2) {
    return (
      <div
        ref={scrollerRef}
        className={className}
        style={
          {
            height: listHeight,
            maxHeight: listHeight,
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
        height: listHeight,
        maxHeight: listHeight,
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
