import { useLayoutEffect, useState, type RefObject } from "react";

export interface OverflowEdges {
  /** Content is scrolled out of view before the visible part. */
  readonly start: boolean;
  /** Content continues past the visible part. */
  readonly end: boolean;
}

const NO_OVERFLOW: OverflowEdges = { start: false, end: false };

/**
 * Which ends of a horizontal scroller hide content. A strip uses it to fade
 * the cut-off edge and to offer its scroll controls only when they do something.
 * `watch` re-measures when the content changes without a resize of the strip.
 */
export function useOverflowEdges(
  ref: RefObject<HTMLElement | null>,
  watch?: unknown,
): OverflowEdges {
  const [edges, setEdges] = useState(NO_OVERFLOW);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => {
      const start = element.scrollLeft > 1;
      const end =
        element.scrollLeft + element.clientWidth < element.scrollWidth - 1;
      setEdges((current) =>
        current.start === start && current.end === end
          ? current
          : { start, end },
      );
    };
    measure();
    element.addEventListener("scroll", measure, { passive: true });
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    observer?.observe(element);
    if (element.firstElementChild) observer?.observe(element.firstElementChild);
    return () => {
      element.removeEventListener("scroll", measure);
      observer?.disconnect();
    };
  }, [ref, watch]);
  return edges;
}
