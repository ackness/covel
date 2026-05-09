import { useCallback, useRef, useState } from "react";
import * as api from "@/services/api.js";

interface UseRuntimeModelSlotOverrideArgs {
  runtimeKey: string;
  sessionId?: string;
  runtimeModelOverrides?: Record<string, string>;
}

/**
 * Binds a runtime's canonical id (`pluginId` or `pluginId/runtimeName`) to a
 * model slot override and persists the full session override map.
 */
export function useRuntimeModelSlotOverride({
  runtimeKey,
  sessionId,
  runtimeModelOverrides,
}: UseRuntimeModelSlotOverrideArgs): [string, (newSlot: string) => void] {
  const initialSlot = useRef(
    runtimeKey ? (runtimeModelOverrides?.[runtimeKey] ?? "") : "",
  );
  const [boundSlot, setBoundSlot] = useState<string>(initialSlot.current);

  const handleSlotChange = useCallback(
    (newSlot: string) => {
      setBoundSlot(newSlot);
      if (!sessionId || !runtimeKey) return;
      const next: Record<string, string> = { ...runtimeModelOverrides };
      if (newSlot) next[runtimeKey] = newSlot;
      else delete next[runtimeKey];
      void api
        .updateSession(sessionId, { runtimeModelOverrides: next })
        .catch(() => {
          // Non-fatal: user can retry by changing the slot again.
        });
    },
    [sessionId, runtimeKey, runtimeModelOverrides],
  );

  return [boundSlot, handleSlotChange];
}
