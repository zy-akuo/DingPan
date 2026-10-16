import { useEffect, type RefObject } from "react";

const INTERACTIVE =
  "button, a, input, textarea, select, option, .ant-btn, .ant-switch, .ant-checkbox, .ant-radio, .ant-select, .ant-picker";

/**
 * 表格横向滚动：按住拖动；纵向仍由滚轮控制。
 * 挂在包含 `.ant-table-body` 的根节点上即可。
 */
export function useTableDragScroll(rootRef: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const drag = {
      active: false,
      moved: false,
      startX: 0,
      scrollLeft: 0,
      pointerId: null as number | null,
      body: null as HTMLElement | null,
    };

    const findBody = () =>
      root.querySelector(".ant-table-body") as HTMLElement | null;

    const cleanupCapture = () => {
      const body = drag.body;
      if (body && drag.pointerId != null) {
        try {
          if (body.hasPointerCapture?.(drag.pointerId)) {
            body.releasePointerCapture(drag.pointerId);
          }
        } catch {
          /* ignore */
        }
      }
    };

    const endDrag = () => {
      if (!drag.active && !drag.moved) return;
      cleanupCapture();
      if (drag.moved) {
        const blockClick = (ev: Event) => {
          ev.stopPropagation();
          ev.preventDefault();
          root.removeEventListener("click", blockClick, true);
        };
        root.addEventListener("click", blockClick, true);
        window.setTimeout(() => {
          root.removeEventListener("click", blockClick, true);
        }, 0);
      }
      root.classList.remove("is-table-dragging");
      drag.active = false;
      drag.pointerId = null;
      drag.body = null;
      window.setTimeout(() => {
        drag.moved = false;
      }, 0);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", endDrag);
      window.removeEventListener("pointercancel", endDrag);
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!drag.active || !drag.body) return;
      if (drag.pointerId != null && e.pointerId !== drag.pointerId) return;
      const dx = e.clientX - drag.startX;
      if (!drag.moved) {
        if (Math.abs(dx) <= 6) return;
        drag.moved = true;
        root.classList.add("is-table-dragging");
        try {
          drag.body.setPointerCapture(drag.pointerId ?? e.pointerId);
        } catch {
          /* ignore */
        }
      }
      drag.body.scrollLeft = drag.scrollLeft - dx;
      e.preventDefault();
    };

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const target = e.target as HTMLElement | null;
      if (!target || target.closest(INTERACTIVE)) return;
      const body = findBody();
      if (!body || body.scrollWidth <= body.clientWidth + 1) return;
      drag.active = true;
      drag.moved = false;
      drag.startX = e.clientX;
      drag.scrollLeft = body.scrollLeft;
      drag.pointerId = e.pointerId;
      drag.body = body;
      window.addEventListener("pointermove", onPointerMove, { passive: false });
      window.addEventListener("pointerup", endDrag);
      window.addEventListener("pointercancel", endDrag);
    };

    root.addEventListener("pointerdown", onPointerDown);

    return () => {
      root.classList.remove("is-table-dragging");
      root.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", endDrag);
      window.removeEventListener("pointercancel", endDrag);
    };
  }, [rootRef]);
}
