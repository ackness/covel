import type { CovelEvent, PluginFaultReason } from "@covel/shared";
import type { FinalizeExecutionOutcome } from "../commit/finalize-execution.js";
import { classifyExecutionFaults } from "./classify.js";

export const PLUGIN_FAULT_THRESHOLD = 3;
export type FaultTransition = Extract<
  CovelEvent,
  { type: `plugin.fault.${string}` }
>;
export interface PluginFaultState {
  readonly pluginId: string;
  readonly consecutiveFaults: number;
  readonly latched: boolean;
  readonly reason?: PluginFaultReason;
}
interface Entry {
  state: PluginFaultState;
  readonly faultKeys: Set<string>;
  hookClean?: { readonly logicalKey: string; readonly previousFaults: number };
}

/** Process-local session state. It has no store, snapshot or export surface. */
export function createPluginFaultLatch({
  threshold = PLUGIN_FAULT_THRESHOLD,
}: { readonly threshold?: number } = {}) {
  if (!Number.isInteger(threshold) || threshold < 1)
    throw new RangeError("Invalid plugin fault threshold");
  const sessions = new Map<string, Map<string, Entry>>();
  const entry = (sessionId: string, pluginId: string): Entry => {
    let session = sessions.get(sessionId);
    if (!session) sessions.set(sessionId, (session = new Map()));
    let value = session.get(pluginId);
    if (!value)
      session.set(
        pluginId,
        (value = {
          state: { pluginId, consecutiveFaults: 0, latched: false },
          faultKeys: new Set(),
        }),
      );
    return value;
  };
  const fault = (
    sessionId: string,
    pluginId: string,
    logicalKey: string,
    reason: PluginFaultReason,
    exempt: boolean,
  ): FaultTransition[] => {
    const value = entry(sessionId, pluginId);
    if (value.state.latched || value.faultKeys.has(logicalKey)) return [];
    value.faultKeys.add(logicalKey);
    // An earlier successful hook in this same input cannot hide a later
    // failing handler. Restore the streak it provisionally cleared.
    const consecutiveFaults =
      (value.hookClean?.logicalKey === logicalKey
        ? value.hookClean.previousFaults
        : value.state.consecutiveFaults) + 1;
    value.hookClean = undefined;
    const latched = !exempt && consecutiveFaults >= threshold;
    value.state = { pluginId, consecutiveFaults, latched, reason };
    const transitions: FaultTransition[] = [
      {
        type: "plugin.fault.counted",
        payload: { sessionId, pluginId, reason, consecutiveFaults },
      },
    ];
    if (latched)
      transitions.push({
        type: "plugin.fault.latched",
        payload: { sessionId, pluginId, reason },
      });
    return transitions;
  };
  const clean = (
    sessionId: string,
    pluginId: string,
    logicalKey?: string,
  ): FaultTransition[] => {
    const value = sessions.get(sessionId)?.get(pluginId);
    if (
      !value ||
      value.state.latched ||
      value.state.consecutiveFaults === 0 ||
      (logicalKey !== undefined && value.faultKeys.has(logicalKey))
    )
      return [];
    value.state = { pluginId, consecutiveFaults: 0, latched: false };
    return [
      {
        type: "plugin.fault.cleared",
        payload: { sessionId, pluginId, by: "clean-run" },
      },
    ];
  };
  return {
    recordExecution(input: {
      readonly sessionId: string;
      readonly logicalKey: string;
      readonly results: Parameters<typeof classifyExecutionFaults>[0];
      readonly outcome: FinalizeExecutionOutcome;
      readonly exempt: ReadonlySet<string>;
      readonly setupRuntimeIds?: ReadonlySet<string>;
    }): FaultTransition[] {
      const transitions: FaultTransition[] = [];
      for (const [pluginId, verdict] of classifyExecutionFaults(
        input.results,
        input.outcome,
        input.setupRuntimeIds,
      )) {
        if (verdict.kind === "fault")
          transitions.push(
            ...fault(
              input.sessionId,
              pluginId,
              input.logicalKey,
              verdict.reason,
              input.exempt.has(pluginId),
            ),
          );
        else if (verdict.kind === "clean")
          transitions.push(
            ...clean(input.sessionId, pluginId, input.logicalKey),
          );
      }
      return transitions;
    },
    recordHookFault(
      sessionId: string,
      pluginId: string,
      logicalKey: string,
      kind: "hook" | "timeout",
      exempt = false,
    ): FaultTransition[] {
      return fault(sessionId, pluginId, logicalKey, kind, exempt);
    },
    recordHookClean(
      sessionId: string,
      pluginId: string,
      logicalKey?: string,
    ): FaultTransition[] {
      const value = sessions.get(sessionId)?.get(pluginId);
      const previousFaults = value?.state.consecutiveFaults ?? 0;
      const transitions = clean(sessionId, pluginId, logicalKey);
      if (value && transitions.length > 0 && logicalKey !== undefined)
        value.hookClean = { logicalKey, previousFaults };
      return transitions;
    },
    isLatched(sessionId: string, pluginId: string): boolean {
      return sessions.get(sessionId)?.get(pluginId)?.state.latched ?? false;
    },
    latched(sessionId: string): readonly PluginFaultState[] {
      return [...(sessions.get(sessionId)?.values() ?? [])]
        .filter((value) => value.state.latched)
        .map((value) => ({ ...value.state }));
    },
    clear(
      sessionId: string,
      pluginId: string,
      by: "player",
    ): FaultTransition[] {
      const value = sessions.get(sessionId)?.get(pluginId);
      if (!value) return [];
      sessions.get(sessionId)?.delete(pluginId);
      return [
        { type: "plugin.fault.cleared", payload: { sessionId, pluginId, by } },
      ];
    },
    forgetSession(sessionId: string): void {
      sessions.delete(sessionId);
    },
  };
}
export type PluginFaultLatch = ReturnType<typeof createPluginFaultLatch>;
