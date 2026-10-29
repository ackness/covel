import {
  createPluginFaultLatch,
  type FaultTransition,
  type TurnEmitter,
} from "@covel/runtime";
import { DIMENSION_CONTRACT, type RuntimeManifest } from "@covel/shared";
import type { DataStore } from "@covel/store";
import type { EventBus } from "@covel/events";
import type { PluginRegistry } from "@covel/plugin-loader";
import { sessionEventBus } from "./session/session-events.js";

/** Bound once per host store so every commit path uses the same process latch. */
const hosts = new WeakMap<DataStore, HostPluginFaults>();
export type HostPluginFaults = ReturnType<typeof createHostPluginFaults>;
export function pluginFaultHost(
  store: DataStore,
): HostPluginFaults | undefined {
  return hosts.get(store);
}

export function faultExemptions(
  runtimes: readonly RuntimeManifest[],
): ReadonlySet<string> {
  return new Set(
    runtimes
      .filter(
        (runtime) =>
          runtime.outputKind === "story" ||
          runtime.outputContract === DIMENSION_CONTRACT,
      )
      .map((runtime) => runtime.pluginId),
  );
}

export function createHostPluginFaults(args: {
  readonly store: DataStore;
  readonly eventBus: EventBus;
  readonly registry: Pick<PluginRegistry, "getActiveRuntimes">;
}) {
  const latch = createPluginFaultLatch();
  async function publish(
    transitions: readonly FaultTransition[],
    emitter?: TurnEmitter,
    eventBus = args.eventBus,
    trace: { readonly traceId?: string; readonly turnId?: string } = {},
  ): Promise<void> {
    for (const transition of transitions) {
      const { sessionId } = transition.payload;
      // The action emitter persists and forwards notices on its own stream.
      // Otherwise publish on the session subscription, like job-status.updated.
      try {
        if (emitter)
          await emitter.emit(transition.type, { ...transition.payload });
        else
          await args.store.addTraceEvent({
            id: crypto.randomUUID(),
            sessionId,
            type: transition.type,
            traceId: trace.traceId ?? trace.turnId ?? "",
            turnId: trace.turnId ?? "",
            payload: transition.payload,
            createdAt: new Date().toISOString(),
          });
      } catch {
        console.warn("[plugin-faults] trace delivery failed", {
          type: transition.type,
          sessionId,
        });
      }
      if (!emitter && transition.type !== "plugin.fault.counted") {
        const session = await args.store.getSession(sessionId);
        if (session)
          sessionEventBus(eventBus, session).emit({
            id: crypto.randomUUID(),
            type: "event",
            topic: "plugin",
            sessionId,
            timestamp: new Date().toISOString(),
            payload: {
              _subType: transition.type,
              ...transition.payload,
              ...(trace.turnId ? { turnId: trace.turnId } : {}),
            },
          });
      }
    }
  }
  const host = {
    latch,
    publish,
    exemptions(sessionId: string, runtimes: readonly RuntimeManifest[]) {
      return faultExemptions([
        ...args.registry.getActiveRuntimes(sessionId),
        ...runtimes,
      ]);
    },
    async onHandlerOutcome(event: {
      readonly sessionId: string;
      readonly pluginId: string;
      readonly turnId?: string;
      readonly logicalKey?: string;
      readonly outcome: "ok" | "error" | "timeout";
      readonly emitter?: TurnEmitter;
    }): Promise<void> {
      const session = await args.store.getSession(event.sessionId);
      if (!session || session.status === "ended") return;
      const runtimes = args.registry.getActiveRuntimes(event.sessionId);
      const logicalKey =
        event.logicalKey ?? (event.turnId || crypto.randomUUID());
      const transitions =
        event.outcome === "ok"
          ? runtimes.some((runtime) => runtime.pluginId === event.pluginId)
            ? []
            : latch.recordHookClean(event.sessionId, event.pluginId, logicalKey)
          : latch.recordHookFault(
              event.sessionId,
              event.pluginId,
              logicalKey,
              event.outcome === "timeout" ? "timeout" : "hook",
              faultExemptions(runtimes).has(event.pluginId),
            );
      await publish(transitions, undefined, args.eventBus, {
        traceId: event.emitter?.traceId,
        turnId: event.turnId,
      });
    },
  };
  hosts.set(args.store, host);
  return host;
}
