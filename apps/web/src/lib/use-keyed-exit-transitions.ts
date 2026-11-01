import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { ExitTransition } from "@covel/shared";
import { useMediaQuery } from "@/hooks/use-media-query.js";

export const KEYED_EXIT_ANIMATION = "ui-keyed-fade-out";
const FADE_DEADLINE_MS = 350;

export interface KeyedDisplayValue<T> {
  readonly key: string;
  readonly value: T;
}

export interface KeyedDeparture<T> extends KeyedDisplayValue<T> {
  readonly generation: number;
  readonly deadline: number;
  readonly animationName: string;
  readonly reason: "inferred" | "explicit";
}

export interface KeyedDisplaySnapshot<T, Context> {
  readonly live: readonly KeyedDisplayValue<T>[];
  readonly outgoing: readonly KeyedDeparture<T>[];
  readonly context: Context;
}

interface ExitCue<T> extends KeyedDisplayValue<T> {
  readonly animationName: string;
  readonly deadlineMs: number;
}

interface State<T, Context> extends KeyedDisplaySnapshot<T, Context> {
  readonly scope: string;
  readonly explicit: ReadonlySet<string>;
  readonly generation: number;
  readonly validKeys: boolean;
}

export function hasStableDisplayKeys(
  items: readonly { key: string }[],
): boolean {
  return (
    items.every(({ key }) => key.trim().length > 0) &&
    new Set(items.map(({ key }) => key)).size === items.length
  );
}

/**
 * Only committed displays become departure candidates. Adapters own content and
 * geometry; this hook owns identity, re-entry, generations and local deadlines.
 * Keep resolve stable between input changes; it runs after commit, never render.
 */
export function useKeyedExitTransitions<T, Context = undefined>({
  scope,
  initialContext,
  resolve,
  exitTransition,
  maxOutgoing = 32,
  inferredAnimationName = KEYED_EXIT_ANIMATION,
  captureDeparture,
}: {
  scope: string;
  initialContext: Context;
  resolve: (previous: KeyedDisplaySnapshot<T, Context>) => {
    live: readonly KeyedDisplayValue<T>[];
    context: Context;
    explicitExits?: readonly ExitCue<T>[];
    validKeys?: boolean;
  };
  exitTransition?: ExitTransition;
  maxOutgoing?: number;
  inferredAnimationName?: string;
  captureDeparture?: (value: T, key: string) => T;
}) {
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const empty = (generation: number): State<T, Context> => ({
    scope,
    context: initialContext,
    live: [],
    outgoing: [],
    explicit: new Set(),
    generation,
    validKeys: true,
  });
  const [state, setState] = useState(() => empty(0));
  const committed = useRef(state);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  useLayoutEffect(() => {
    const old =
      committed.current.scope === scope
        ? committed.current
        : empty(committed.current.generation);
    const snapshot = resolve(old);
    const { live, context, explicitExits = [] } = snapshot;
    const validKeys =
      snapshot.validKeys !== false &&
      hasStableDisplayKeys(live) &&
      hasStableDisplayKeys(explicitExits);
    const ids = new Set(live.map(({ key }) => key));
    const explicit = new Set(validKeys && old.validKeys ? old.explicit : []);
    for (const key of ids) explicit.delete(key);
    let generation = old.generation;
    let outgoing =
      validKeys && old.validKeys && !reducedMotion
        ? old.outgoing.filter(
            (entry) =>
              !ids.has(entry.key) &&
              (entry.reason === "explicit" || exitTransition === "fade"),
          )
        : [];
    const admit = (
      item: KeyedDisplayValue<T>,
      reason: "inferred" | "explicit",
      animationName: string,
      deadlineMs: number,
    ) => {
      if (reducedMotion || !animationName || deadlineMs <= 0) return;
      outgoing.push({
        ...item,
        reason,
        animationName,
        generation: ++generation,
        deadline: Date.now() + deadlineMs,
      });
    };
    if (validKeys) {
      for (const cue of explicitExits) {
        if (ids.has(cue.key) || explicit.has(cue.key)) continue;
        explicit.add(cue.key);
        outgoing = outgoing.filter(({ key }) => key !== cue.key);
        admit(cue, "explicit", cue.animationName, cue.deadlineMs);
      }
      if (old.validKeys && exitTransition === "fade")
        for (const item of old.live) {
          if (
            ids.has(item.key) ||
            explicit.has(item.key) ||
            outgoing.some(({ key }) => key === item.key)
          )
            continue;
          admit(
            {
              ...item,
              value: captureDeparture?.(item.value, item.key) ?? item.value,
            },
            "inferred",
            inferredAnimationName,
            FADE_DEADLINE_MS,
          );
        }
    }
    const next: State<T, Context> = {
      scope,
      context,
      live,
      validKeys,
      explicit,
      generation,
      outgoing: outgoing.slice(-maxOutgoing),
    };
    committed.current = next;
    setState(next);
  }, [
    scope,
    resolve,
    exitTransition,
    maxOutgoing,
    inferredAnimationName,
    reducedMotion,
    initialContext,
    captureDeparture,
  ]);

  const finish = useCallback((generation: number) => {
    const old = committed.current;
    if (!old.outgoing.some((entry) => entry.generation === generation)) return;
    const next = {
      ...old,
      outgoing: old.outgoing.filter((entry) => entry.generation !== generation),
    };
    committed.current = next;
    setState(next);
  }, []);

  useLayoutEffect(() => {
    const pending = new Set(state.outgoing.map(({ generation }) => generation));
    for (const [generation, timer] of timers.current) {
      if (pending.has(generation)) continue;
      clearTimeout(timer);
      timers.current.delete(generation);
    }
    for (const { generation, deadline } of state.outgoing) {
      if (timers.current.has(generation)) continue;
      timers.current.set(
        generation,
        setTimeout(
          () => finish(generation),
          Math.max(0, deadline - Date.now()),
        ),
      );
    }
  }, [state.outgoing, finish]);

  useLayoutEffect(
    () => () => {
      for (const timer of timers.current.values()) clearTimeout(timer);
      timers.current.clear();
    },
    [],
  );

  return {
    live: state.scope === scope ? state.live : [],
    outgoing: state.scope === scope ? state.outgoing : [],
    validKeys: state.validKeys,
    finish,
  };
}
