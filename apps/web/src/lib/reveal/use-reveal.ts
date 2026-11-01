import { useEffect, useRef, useState } from "react";
import type { RevealPolicy } from "@covel/shared";
import { useMediaQuery } from "@/hooks/use-media-query.js";
import { useSetting } from "@/settings/use-settings.js";

/** One clock for complete display units; the canonical children are never changed. */
export function useReveal({
  revealKey,
  revision = revealKey,
  count,
  policy,
  live,
  active = true,
}: {
  revealKey: string;
  revision?: string;
  count: number;
  policy: RevealPolicy;
  live?: boolean;
  active?: boolean;
}) {
  const [instant] = useSetting<boolean>("ui.instantText");
  const reduced = useMediaQuery("(prefers-reduced-motion: reduce)");
  const [visiblePage, setVisiblePage] = useState(
    () => document.visibilityState !== "hidden",
  );
  useEffect(() => {
    const change = () => setVisiblePage(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", change);
    return () => document.removeEventListener("visibilitychange", change);
  }, []);
  const identity = JSON.stringify([revealKey, revision]);
  const [state, setState] = useState(() => ({
    identity,
    key: revealKey,
    count,
    visible: live ? 1 : count,
  }));
  let current = state;
  if (state.identity !== identity || state.count !== count) {
    // A revision of the same group is authoritative replacement, never a replay.
    const shouldReveal = live ?? state.key !== revealKey;
    current = {
      identity,
      key: revealKey,
      count,
      visible: state.key === revealKey || !shouldReveal ? count : 1,
    };
    setState(current);
  }
  const forced =
    instant ||
    reduced ||
    !visiblePage ||
    !active ||
    policy.mode !== "segments" ||
    policy.intervalMs === 0 ||
    count <= 1;
  const done = forced || current.visible >= count;
  const finished = useRef<(() => void) | undefined>(undefined);
  const clock = useRef<{ identity: string; started: number } | undefined>(
    undefined,
  );
  const showAll = () => {
    finished.current?.();
    setState((previous) =>
      previous.identity === identity
        ? { ...previous, visible: count }
        : previous,
    );
  };
  useEffect(() => {
    if (done) {
      if (current.visible < count)
        setState((previous) =>
          previous.identity === identity
            ? { ...previous, visible: count }
            : previous,
        );
      return;
    }
    let cancelled = false;
    const interval = Math.min(policy.intervalMs, 2000 / (count - 1));
    if (clock.current?.identity !== identity)
      clock.current = { identity, started: Date.now() };
    const started = clock.current.started;
    let timer: ReturnType<typeof setTimeout>;
    const cancel = () => {
      cancelled = true;
      clearTimeout(timer);
    };
    finished.current = cancel;
    const tick = () => {
      if (cancelled) return;
      const elapsed = Date.now() - started;
      const visible =
        elapsed >= 2000
          ? count
          : Math.min(count, Math.floor(elapsed / interval) + 1);
      setState((previous) =>
        previous.identity === identity
          ? { ...previous, visible: Math.max(previous.visible, visible) }
          : previous,
      );
      if (visible < count)
        timer = setTimeout(
          tick,
          Math.max(
            1,
            Math.min(started + visible * interval, started + 2000) - Date.now(),
          ),
        );
    };
    timer = setTimeout(
      tick,
      Math.max(
        0,
        Math.min(started + current.visible * interval, started + 2000) -
          Date.now(),
      ),
    );
    return () => {
      cancel();
      if (finished.current === cancel) finished.current = undefined;
    };
  }, [identity, count, policy.mode, policy.intervalMs, forced, done]);
  return { visible: done ? count : current.visible, revealing: !done, showAll };
}
