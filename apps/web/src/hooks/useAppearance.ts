import { useCallback, useEffect } from "react";
import { useSetting } from "@/settings/use-settings.js";
import { applyAppearance, type Appearance } from "@/lib/appearance";

export type { Appearance } from "@/lib/appearance";

/**
 * Read and write the current appearance through the unified settings store.
 * Re-applies the `data-appearance` attribute on the document root whenever
 * the value changes.
 */
export function useAppearance(): {
  appearance: Appearance;
  setAppearance: (next: Appearance) => void;
} {
  const [appearance, setAsync] = useSetting<Appearance>("ui.appearance");

  useEffect(() => {
    applyAppearance(appearance);
  }, [appearance]);

  const setAppearance = useCallback(
    (next: Appearance) => {
      void setAsync(next);
    },
    [setAsync],
  );

  return { appearance, setAppearance };
}
