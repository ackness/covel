import { useState } from "react";
import * as api from "@/services/api.js";
import type { ResolvedSlot } from "@/hooks/use-slot-config.js";
import { useRuntimeBindings } from "@/hooks/use-runtime-bindings.js";
import type { UseRuntimeBindingsResult } from "@/hooks/use-runtime-bindings.js";

export interface UsePrepRuntimeBindingsResult {
  bindingState: UseRuntimeBindingsResult;
}

export function usePrepRuntimeBindings(
  worldId: string,
  selectedPackages: api.PackageSummary[],
  resolvedSlots: ResolvedSlot[],
): UsePrepRuntimeBindingsResult {
  const [prepBindings, setPrepBindingsState] = useState<Record<string, string>>(
    () => api.getPrepRuntimeBindings(worldId),
  );
  const bindingState = useRuntimeBindings(
    `prep:${worldId}`,
    selectedPackages,
    resolvedSlots,
    undefined,
    prepBindings,
    (next) => {
      setPrepBindingsState(next);
      api.setPrepRuntimeBindings(worldId, next);
    },
  );

  return { bindingState };
}
