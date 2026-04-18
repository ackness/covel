import { useState, useMemo, useCallback, useEffect } from "react";
import type { PackageSummary, SessionPluginInfo } from "@/services/api.js";
import {
  clearRuntimeBindings,
  getRuntimeBindings,
  setRuntimeBindings,
} from "@/services/api.js";
import type { ResolvedSlot } from "./use-slot-config.js";
import {
  autoAssignRuntimeBindings,
  filterRuntimeBindingsForKnownRuntimes,
} from "../lib/runtime-binding-utils.js";

export interface RuntimeBindingEntry {
  /** Qualified runtime ID: "pluginId:runtimeId" */
  qualifiedId: string;
  /** Plugin name (for grouping in UI) */
  pluginId: string;
  /** Plugin display name */
  pluginDisplayName?: string;
  /** Runtime kind (story, plugin, etc.) */
  kind: string;
  /** Required model tag */
  providerTag: string;
  /** Currently bound slot name (empty = unbound) */
  slotName: string;
}

export interface UseRuntimeBindingsResult {
  /** All runtime binding entries */
  entries: RuntimeBindingEntry[];
  /** Whether all runtimes with a providerTag have a compatible slot bound */
  allBound: boolean;
  /** Current bindings map */
  bindings: Record<string, string>;
  /** Set binding for a specific runtime */
  setBinding: (qualifiedId: string, slotName: string) => void;
  /** Auto-assign first compatible slot to all unbound runtimes */
  autoAssign: () => void;
  /** Compatible slots for a given tag */
  compatibleSlots: (tag: string) => ResolvedSlot[];
}

/**
 * Hook that manages runtime-to-slot bindings for a session.
 *
 * - Reads saved bindings from localStorage on mount
 * - Auto-generates defaults for unbound runtimes
 * - Persists changes to localStorage
 * - Provides tag-filtered slot lists
 */
export function useRuntimeBindings(
  sessionId: string | undefined,
  packages: PackageSummary[],
  resolvedSlots: ResolvedSlot[],
  sessionPlugins?: SessionPluginInfo[],
): UseRuntimeBindingsResult {
  const [bindings, setBindingsState] = useState<Record<string, string>>({});

  const runtimeTargets = useMemo(() => {
    const result: Array<{
      qualifiedId: string;
      pluginId: string;
      pluginDisplayName?: string;
      kind: string;
      providerTag: string;
    }> = [];

    // qualifiedId is the canonical runtime id (`pluginId` for single-runtime
    // plugins, `pluginId/runtimeName` for multi-runtime). The server's
    // `runtimeModelOverrides` map keys MUST match this shape (regex
    // `^[a-z][a-z0-9-]*(?:/[a-z][a-z0-9-]*)?$`). Do NOT use `pluginId:runtimeId`
    // — the colon form is rejected by server validation and the override is
    // silently dropped.

    // Detailed path: build targets from SessionPluginInfo when available
    if (packages.length === 0 && sessionPlugins && sessionPlugins.length > 0) {
      for (const sp of sessionPlugins) {
        // Skip error plugins and function runtimes (no LLM needed)
        if (sp.status === "error" || sp.runtimeType === "function") continue;
        // Skip plugins without a model slot — they use default
        const tag = sp.model ?? "text";
        result.push({
          qualifiedId: sp.id,
          pluginId: sp.id.includes("/") ? sp.id.slice(0, sp.id.indexOf("/")) : sp.id,
          pluginDisplayName: typeof sp.displayName === "string"
            ? sp.displayName
            : typeof sp.displayName === "object"
              ? Object.values(sp.displayName)[0]
              : sp.id,
          kind: sp.outputKind ?? "plugin",
          providerTag: tag,
        });
      }
      return result;
    }

    // Fallback: build targets from PackageSummary runtimes. Skip function
    // runtimes (no LLM) but do NOT require providerTag — the server-side
    // /api/packages endpoint currently omits that field, which used to hide
    // every agent runtime from the binding UI. Default to "text" so the tag-
    // based slot compatibility filter keeps working when the tag IS set in
    // other code paths.
    for (const pkg of packages) {
      if (!pkg.enabled || !pkg.runtimes) continue;
      for (const rt of pkg.runtimes) {
        if (rt.kind === "function") continue;
        result.push({
          qualifiedId: rt.id,
          pluginId: pkg.name,
          pluginDisplayName: typeof pkg.displayName === "string"
            ? pkg.displayName
            : typeof pkg.displayName === "object"
              ? Object.values(pkg.displayName)[0]
              : pkg.name,
          kind: rt.kind,
          providerTag: rt.providerTag ?? "text",
        });
      }
    }

    return result;
  }, [packages, sessionPlugins]);

  const runtimeTargetIdsKey = useMemo(
    () => runtimeTargets.map((target) => target.qualifiedId).join("\n"),
    [runtimeTargets],
  );

  // Load saved bindings on mount / session change
  useEffect(() => {
    if (!sessionId) {
      setBindingsState({});
      return;
    }

    const saved = getRuntimeBindings(sessionId);
    const filtered = filterRuntimeBindingsForKnownRuntimes(
      saved,
      runtimeTargets.map((target) => target.qualifiedId),
    );
    setBindingsState(filtered);

    if (Object.keys(saved).length === 0) return;
    if (Object.keys(filtered).length > 0) {
      setRuntimeBindings(sessionId, filtered);
    } else {
      clearRuntimeBindings(sessionId);
    }
  }, [sessionId, runtimeTargetIdsKey, runtimeTargets]);

  // Auto-generate defaults on first load when a session has no saved bindings.
  useEffect(() => {
    if (!sessionId) return;
    if (runtimeTargets.length === 0 || resolvedSlots.length === 0) return;
    if (Object.keys(bindings).length > 0) return;

    const defaults = autoAssignRuntimeBindings(bindings, runtimeTargets, resolvedSlots);
    if (Object.keys(defaults).length === 0) return;

    setBindingsState(defaults);
    setRuntimeBindings(sessionId, defaults);
  }, [bindings, resolvedSlots, runtimeTargets, sessionId]);

  // Build flat list of all runtimes that need bindings
  const entries = useMemo((): RuntimeBindingEntry[] => {
    return runtimeTargets.map((target) => ({
      ...target,
      slotName: bindings[target.qualifiedId] ?? "",
    }));
  }, [runtimeTargets, bindings]);

  // Filter slots compatible with a providerTag.
  // Priority: tag match first, then include name-matched slot (slotId === tag).
  const compatibleSlots = useCallback(
    (tag: string): ResolvedSlot[] => {
      const byTag = resolvedSlots.filter((s) => s.tag === tag);
      if (byTag.length > 0) return byTag;
      // Name match: treat the slot whose slotId matches the tag as compatible
      const byName = resolvedSlots.filter((s) => s.slotId === tag);
      return byName;
    },
    [resolvedSlots],
  );

  // Check if all runtimes are bound to a compatible slot.
  // A slot is compatible if its tag matches OR its slotId matches the providerTag (name match).
  const allBound = useMemo(() => {
    return entries.every((e) => {
      if (!e.slotName) return false;
      return resolvedSlots.some(
        (s) => s.slotId === e.slotName && (s.tag === e.providerTag || s.slotId === e.providerTag),
      );
    });
  }, [entries, resolvedSlots]);

  // Set a single binding
  const setBinding = useCallback(
    (qualifiedId: string, slotName: string) => {
      setBindingsState((prev) => {
        const next = { ...prev, [qualifiedId]: slotName };
        if (sessionId) setRuntimeBindings(sessionId, next);
        return next;
      });
    },
    [sessionId],
  );

  // Auto-assign first compatible slot to all unbound runtimes
  const autoAssign = useCallback(() => {
    setBindingsState((prev) => {
      const next = autoAssignRuntimeBindings(prev, runtimeTargets, resolvedSlots);
      if (sessionId) setRuntimeBindings(sessionId, next);
      return next;
    });
  }, [runtimeTargets, resolvedSlots, sessionId]);

  return {
    entries,
    allBound,
    bindings,
    setBinding,
    autoAssign,
    compatibleSlots,
  };
}
