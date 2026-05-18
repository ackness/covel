import { useCallback, useEffect, useMemo, useState } from "react";
import type { PackageSummary, SessionPluginInfo } from "@/services/api.js";
import { updateSession } from "@/services/api.js";
import type { ResolvedSlot } from "./use-slot-config.js";
import {
  autoAssignRuntimeBindings,
  filterRuntimeBindingsForKnownRuntimes,
} from "../lib/runtime-binding-utils.js";

export interface RuntimeBindingEntry {
  /** Qualified runtime ID: `pluginId` or `pluginId/runtimeName`. */
  qualifiedId: string;
  pluginId: string;
  pluginDisplayName?: string;
  /** Runtime's declared default slot from PLUGIN.md `model`; defaults to `text`. */
  defaultSlot: string;
  slotName: string;
}

export interface UseRuntimeBindingsResult {
  entries: RuntimeBindingEntry[];
  allBound: boolean;
  bindings: Record<string, string>;
  setBinding: (qualifiedId: string, slotName: string) => void;
  autoAssign: () => void;
  compatibleSlots: (tag: string) => ResolvedSlot[];
}

/**
 * Hook that manages runtime-to-slot bindings for a session.
 *
 * Two modes:
 *   - Session mode: caller passes a real sessionId + the current
 *     `SessionRecord.runtimeModelOverrides`. Changes PATCH the server.
 *   - External mode: caller passes an `onPersist` callback and keeps
 *     `runtimeModelOverrides` in its own state. Used for the session
 *     prep screen, where no SessionRecord exists yet.
 */
export function useRuntimeBindings(
  sessionId: string | undefined,
  packages: PackageSummary[],
  resolvedSlots: ResolvedSlot[],
  sessionPlugins?: SessionPluginInfo[],
  runtimeModelOverrides?: Record<string, string>,
  onPersist?: (bindings: Record<string, string>) => void,
): UseRuntimeBindingsResult {
  const [bindings, setBindingsState] = useState<Record<string, string>>({});

  const runtimeTargets = useMemo(() => {
    const result: Array<Omit<RuntimeBindingEntry, "slotName">> = [];

    if (packages.length === 0 && sessionPlugins && sessionPlugins.length > 0) {
      for (const sp of sessionPlugins) {
        if (
          sp.status === "error" ||
          sp.runtimeType === "function" ||
          sp.model === undefined
        )
          continue;
        const defaultSlot = sp.model;
        result.push({
          qualifiedId: sp.id,
          pluginId: sp.id.includes("/")
            ? sp.id.slice(0, sp.id.indexOf("/"))
            : sp.id,
          pluginDisplayName:
            typeof sp.displayName === "string"
              ? sp.displayName
              : typeof sp.displayName === "object"
                ? Object.values(sp.displayName)[0]
                : sp.id,
          defaultSlot,
        });
      }
      return result;
    }

    for (const pkg of packages) {
      if (!pkg.enabled || !pkg.runtimes) continue;
      for (const rt of pkg.runtimes) {
        if (rt.kind === "function" || rt.model === undefined) continue;
        const defaultSlot = rt.model;
        result.push({
          qualifiedId: rt.id,
          pluginId: pkg.name,
          pluginDisplayName:
            typeof pkg.displayName === "string"
              ? pkg.displayName
              : typeof pkg.displayName === "object"
                ? Object.values(pkg.displayName)[0]
                : pkg.name,
          defaultSlot,
        });
      }
    }

    return result;
  }, [packages, sessionPlugins]);

  const runtimeTargetIdsKey = useMemo(
    () => runtimeTargets.map((target) => target.qualifiedId).join("\n"),
    [runtimeTargets],
  );

  const persist = useCallback(
    (sid: string, next: Record<string, string>) => {
      if (onPersist) {
        onPersist(next);
        return;
      }
      if (sid.startsWith("prep:")) return;
      void updateSession(sid, { runtimeModelOverrides: next }).catch(() => {});
    },
    [onPersist],
  );

  // Load server-side overrides (filtering to known runtimes).
  useEffect(() => {
    if (!sessionId) {
      setBindingsState({});
      return;
    }
    const saved = runtimeModelOverrides ?? {};
    const filtered = filterRuntimeBindingsForKnownRuntimes(
      saved,
      runtimeTargets.map((target) => target.qualifiedId),
    );
    setBindingsState(filtered);
    if (Object.keys(saved).length > Object.keys(filtered).length && sessionId) {
      persist(sessionId, filtered);
    }
  }, [sessionId, runtimeTargetIdsKey, runtimeTargets, runtimeModelOverrides]);

  // Auto-generate defaults on first load when a session has no saved bindings.
  useEffect(() => {
    if (!sessionId) return;
    if (runtimeTargets.length === 0 || resolvedSlots.length === 0) return;
    if (Object.keys(bindings).length > 0) return;

    const defaults = autoAssignRuntimeBindings(
      bindings,
      runtimeTargets,
      resolvedSlots,
    );
    if (Object.keys(defaults).length === 0) return;

    setBindingsState(defaults);
    persist(sessionId, defaults);
  }, [bindings, resolvedSlots, runtimeTargets, sessionId]);

  const entries = useMemo((): RuntimeBindingEntry[] => {
    return runtimeTargets.map((target) => ({
      ...target,
      slotName: bindings[target.qualifiedId] ?? "",
    }));
  }, [runtimeTargets, bindings]);

  const compatibleSlots = useCallback(
    (tag: string): ResolvedSlot[] => {
      const byTag = resolvedSlots.filter((s) => s.tag === tag);
      if (byTag.length > 0) return byTag;
      const byName = resolvedSlots.filter((s) => s.slotId === tag);
      return byName;
    },
    [resolvedSlots],
  );

  const allBound = useMemo(() => {
    return entries.every((e) => {
      const effectiveSlotName = e.slotName || e.defaultSlot;
      if (effectiveSlotName === "default") return resolvedSlots.length > 0;
      return resolvedSlots.some((s) => s.slotId === effectiveSlotName);
    });
  }, [entries, resolvedSlots]);

  const setBinding = useCallback(
    (qualifiedId: string, slotName: string) => {
      setBindingsState((prev) => {
        const next = { ...prev, [qualifiedId]: slotName };
        if (sessionId) persist(sessionId, next);
        return next;
      });
    },
    [sessionId, persist],
  );

  const autoAssign = useCallback(() => {
    setBindingsState((prev) => {
      const next = autoAssignRuntimeBindings(
        prev,
        runtimeTargets,
        resolvedSlots,
      );
      if (sessionId) persist(sessionId, next);
      return next;
    });
  }, [runtimeTargets, resolvedSlots, sessionId, persist]);

  return {
    entries,
    allBound,
    bindings,
    setBinding,
    autoAssign,
    compatibleSlots,
  };
}
