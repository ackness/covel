import { useCallback, useEffect, useState } from "react";
import type { RuntimeModelOverrideChange } from "./types.js";

interface UseRuntimeModelSlotOverrideArgs {
  runtimeKey: string;
  sessionId?: string;
  runtimeModelOverrides?: Record<string, string>;
  onChange?: RuntimeModelOverrideChange;
}

/**
 * Binds a runtime's canonical id (`pluginId` or `pluginId/runtimeName`) to a
 * model slot override and persists the full session override map.
 */
export function useRuntimeModelSlotOverride({
  runtimeKey,
  sessionId,
  runtimeModelOverrides,
  onChange,
}: UseRuntimeModelSlotOverrideArgs): [
  string,
  (newSlot: string) => void,
  string | null,
] {
  const boundSlot = runtimeKey
    ? (runtimeModelOverrides?.[runtimeKey] ?? "")
    : "";
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setError(null), [sessionId, runtimeKey]);

  const handleSlotChange = useCallback(
    (newSlot: string) => {
      setError(null);
      if (!sessionId || !runtimeKey || !onChange) return;
      void onChange(runtimeKey, newSlot).catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      });
    },
    [sessionId, runtimeKey, onChange],
  );

  return [boundSlot, handleSlotChange, error];
}
