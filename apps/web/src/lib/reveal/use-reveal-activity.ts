import { useLayoutEffect, useState, type RefObject } from "react";

/** A mounted tab/panel may be hidden without leaving the visible document. */
export function useRevealActivity(ref: RefObject<HTMLElement | null>): boolean {
  const [active, setActive] = useState(true);
  useLayoutEffect(() => {
    const ancestors: HTMLElement[] = [];
    for (let node = ref.current; node; node = node.parentElement)
      ancestors.push(node);
    const update = () =>
      setActive(
        ancestors.every((node) => {
          const style = getComputedStyle(node);
          return (
            !node.hidden &&
            !node.hasAttribute("inert") &&
            node.getAttribute("aria-hidden") !== "true" &&
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            style.visibility !== "collapse"
          );
        }),
      );
    update();
    const observer = new MutationObserver(update);
    for (const node of ancestors)
      observer.observe(node, {
        attributes: true,
        attributeFilter: [
          "hidden",
          "inert",
          "aria-hidden",
          "style",
          "class",
          "data-state",
        ],
      });
    return () => observer.disconnect();
  }, [ref]);
  return active;
}
