import {
  Children,
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import type { RevealPolicy } from "@covel/shared";
import { useRevealActivity } from "./use-reveal-activity.js";
import { useReveal } from "./use-reveal.js";

const ManagedReveal = createContext(false);
const INTERACTIVE =
  "a[href],button,input,select,textarea,summary,[tabindex]:not([tabindex='-1']),[contenteditable]:not([contenteditable='false']),audio[controls],video[controls],[role='button'],[role='link']";

function RevealUnit({
  hidden,
  children,
}: {
  hidden: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const update = () => {
      const delayed = hidden && !node.querySelector(INTERACTIVE);
      node.style.opacity = delayed ? "0" : "1";
      node.dataset.revealHidden = String(delayed);
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(node, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [
        "href",
        "tabindex",
        "role",
        "controls",
        "contenteditable",
      ],
    });
    return () => observer.disconnect();
  }, [hidden]);
  return (
    <div ref={ref} data-reveal-unit="" style={{ opacity: hidden ? 0 : 1 }}>
      {children}
    </div>
  );
}

export interface RevealProps {
  revealKey: string;
  revision?: string;
  mode?: RevealPolicy["mode"];
  intervalMs?: number;
  /** Only the host can admit a newly committed story on its first render. */
  live?: boolean;
  active?: boolean;
  children: ReactNode;
}

/** Complete semantic content stays mounted once; only display units change opacity. */
export function Reveal(props: RevealProps) {
  const managed = useContext(ManagedReveal);
  return managed ? <>{props.children}</> : <RevealGroup {...props} />;
}

function RevealGroup({
  children,
  mode = "instant",
  intervalMs = 120,
  ...props
}: RevealProps) {
  const { t } = useTranslation();
  const units = Children.toArray(children);
  const root = useRef<HTMLDivElement>(null);
  const viewActive = useRevealActivity(root);
  const controller = useReveal({
    ...props,
    active: viewActive && props.active !== false,
    policy: { mode, intervalMs },
    count: units.length,
  });
  const [controlFocused, setControlFocused] = useState(false);
  const identity = JSON.stringify([props.revealKey, props.revision]);
  useLayoutEffect(() => {
    const node = root.current;
    if (!node || !controller.revealing || props.revision !== undefined) return;
    // A same-key content replacement from declarative state cancels pending display.
    const observer = new MutationObserver(() => controller.showAll());
    observer.observe(node, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    return () => observer.disconnect();
  }, [identity, controller.revealing, props.revision]);
  return (
    <ManagedReveal value={true}>
      <div ref={root} data-reveal-group="" aria-live="off">
        {units.map((unit, index) => (
          <RevealUnit key={index} hidden={index >= controller.visible}>
            {unit}
          </RevealUnit>
        ))}
      </div>
      {(controller.revealing || controlFocused) && (
        <button
          type="button"
          data-covel-host-controls=""
          className="my-2 rounded-sm border border-border bg-background px-3 py-1 text-xs text-foreground"
          aria-disabled={!controller.revealing || undefined}
          onFocus={() => setControlFocused(true)}
          onBlur={() => setControlFocused(false)}
          onClick={controller.revealing ? controller.showAll : undefined}
        >
          {t("session.showAll")}
        </button>
      )}
    </ManagedReveal>
  );
}
