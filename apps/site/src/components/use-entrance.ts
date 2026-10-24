import { useEffect, useRef } from "react";

/** One quiet entrance per section; content remains visible without the observer. */
export function useEntrance<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    const element = ref.current;
    if (
      !element ||
      typeof IntersectionObserver === "undefined" ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    )
      return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        element.dataset.entered = "true";
        observer.disconnect();
      },
      { threshold: 0.08 },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return ref;
}
