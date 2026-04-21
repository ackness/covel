import { useCallback, useEffect, useState } from "react";
import {
  applyAppearance,
  emitAppearanceChange,
  resolveInitialAppearance,
  setStoredAppearance,
  subscribeAppearance,
  type Appearance,
} from "@/lib/appearance";

export type { Appearance } from "@/lib/appearance";

export function useAppearance(): {
  appearance: Appearance;
  setAppearance: (next: Appearance) => void;
} {
  const [appearance, setAppearanceState] = useState<Appearance>(() => resolveInitialAppearance());

  useEffect(() => {
    const unsubscribe = subscribeAppearance(setAppearanceState);
    return unsubscribe;
  }, []);

  const setAppearance = useCallback((next: Appearance) => {
    setStoredAppearance(next);
    applyAppearance(next);
    setAppearanceState(next);
    emitAppearanceChange(next);
  }, []);

  return { appearance, setAppearance };
}
