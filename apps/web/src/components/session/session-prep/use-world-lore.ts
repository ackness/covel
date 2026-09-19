import { useCallback, useEffect, useMemo, useState } from "react";
import * as api from "@/services/api.js";

export type LoreDraftStatus =
  "loading" | "ready" | "saving" | "load-error" | "save-error";

export function useWorldLore(worldId: string, originalLore: string) {
  // Reads and writes belong to this visit and source text. Editing revokes any
  // earlier read; changing worlds or unmounting revokes all UI completions.
  const scope = useMemo(
    () => ({ revision: 0, active: false }),
    [worldId, originalLore],
  );
  const initial = {
    scope,
    value: originalLore,
    status: "loading" as LoreDraftStatus,
  };
  const [draft, setDraft] = useState(initial);
  const current = draft.scope === scope ? draft : initial;
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    scope.active = true;
    let cancelled = false;
    const revision = scope.revision;
    const isCurrent = () => !cancelled && scope.revision === revision;
    setDraft({ scope, value: originalLore, status: "loading" });
    void api
      .getWorldOverlay(worldId)
      .then((overlay) => {
        if (isCurrent())
          setDraft({
            scope,
            value:
              typeof overlay?.lore === "string" ? overlay.lore : originalLore,
            status: "ready",
          });
      })
      .catch(() => {
        console.warn("[world-lore] Draft read failed", { worldId });
        if (isCurrent())
          setDraft({ scope, value: originalLore, status: "load-error" });
      });
    return () => {
      cancelled = true;
      scope.active = false;
    };
  }, [scope, worldId, originalLore, loadAttempt]);

  const change = useCallback(
    (value: string) => {
      const revision = ++scope.revision;
      setDraft({ scope, value, status: "saving" });
      const saving =
        value === originalLore
          ? api.removeWorldOverlay(worldId)
          : api.setWorldOverlay(worldId, {
              lore: value,
              updatedAt: new Date().toISOString(),
            });
      void saving
        .then(() => {
          if (scope.active && scope.revision === revision)
            setDraft({ scope, value, status: "ready" });
        })
        .catch(() => {
          console.warn("[world-lore] Draft write failed", { worldId });
          if (scope.active && scope.revision === revision)
            setDraft({ scope, value, status: "save-error" });
        });
    },
    [scope, worldId, originalLore],
  );

  return {
    value: current.value,
    status: current.status,
    change,
    reset: () => change(originalLore),
    retry: () => {
      if (current.status === "save-error") change(current.value);
      else if (current.status === "load-error")
        setLoadAttempt((attempt) => attempt + 1);
    },
  };
}
