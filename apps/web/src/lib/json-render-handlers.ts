import { useLayoutEffect, useRef, useState } from "react";
import type { ActionProviderProps } from "@json-render/react";

type ActionHandlers = NonNullable<ActionProviderProps["handlers"]>;

/**
 * json-render's ActionProvider keeps the handlers it receives first. Give it
 * stable functions that call the latest handlers instead, so guards such as
 * "a turn is running" and the callbacks they use stay current without
 * re-registering handlers or re-rendering the spec. Handler names are fixed
 * when the provider mounts, as they are in json-render.
 */
export function useLiveActionHandlers(
  handlers: ActionHandlers,
): ActionHandlers {
  const latest = useRef(handlers);
  useLayoutEffect(() => {
    latest.current = handlers;
  });
  const [stable] = useState(() =>
    Object.fromEntries(
      Object.keys(handlers).map((name) => [
        name,
        (params: Record<string, unknown>) => latest.current[name]?.(params),
      ]),
    ),
  );
  return stable;
}
