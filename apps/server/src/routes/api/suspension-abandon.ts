import { sessionEventBus } from "./session/session-events.js";
/**
 * Abandon a suspension and settle what it held back.
 *
 * One exit for every way a suspension ends without a successful resume: the
 * player abandons it (`DELETE /suspensions/:id`), a resume finds it out of
 * date and voids it, or the expiry sweep removes it. When it was the last
 * pending suspension of its turn, the turn counts and the detached jobs the
 * turn held back are queued, in the transaction that deletes the record, as
 * after a normal end. The progress jobs of the suspended execution end
 * `cancelled` once that transaction commits.
 *
 * The caller holds the session lock.
 */

import type { Context } from "hono";
import type { DataStore, SuspensionRecord } from "@covel/store";
import type { EventBus } from "@covel/events";
import type { PluginRegistry } from "@covel/plugin-loader";
import {
  applySuspensionAbandonTx,
  planSuspensionAbandon,
  settleAbandonedSuspensionJobs,
} from "@covel/runtime";
import { DEFAULT_LOCALE, type TurnInput } from "@covel/shared";
import {
  enqueueDeferredRuntimeJobs,
  type QueuedRuntimeJob,
} from "./plugin-rpc/runtime-job-enqueue.js";
import {
  publishDeferredRuntimeJobs,
  requestJobServices,
} from "./plugin-rpc/settled-request.js";
import type { RuntimeJobWorker } from "./plugin-rpc/runtime-job-worker.js";
import { loadSessionPluginUserSettings } from "./plugin-user-settings.js";

export interface SuspensionAbandonDeps {
  readonly store: DataStore;
  readonly pluginRegistry: Pick<
    PluginRegistry,
    "syncSessionActivations" | "getActiveRuntimes"
  >;
  readonly eventBus?: EventBus;
  readonly worker?: Pick<RuntimeJobWorker, "wake">;
  /** Request-scoped provider credentials for the jobs this releases. */
  readonly registerCredentials?: Parameters<
    typeof enqueueDeferredRuntimeJobs
  >[1]["registerCredentials"];
  /** Player settings sent with the request, merged over the world's. */
  readonly playerSettings?: TurnInput["userSettings"];
}

/** The abandon dependencies of a request. */
export function requestSuspensionAbandonDeps(
  c: Context,
  playerSettings?: TurnInput["userSettings"],
): SuspensionAbandonDeps {
  const eventBus = c.get("eventBus");
  const worker = c.get("runtimeJobWorker");
  return {
    store: c.get("store"),
    pluginRegistry: c.get("pluginRegistry"),
    ...(eventBus ? { eventBus } : {}),
    ...(worker ? { worker } : {}),
    ...(playerSettings ? { playerSettings } : {}),
    registerCredentials: (key, maxQueueMs) => {
      const services = requestJobServices(c);
      if (services)
        c.get("runtimeJobCredentials")?.register(key, services, maxQueueMs);
    },
  };
}

/**
 * Delete `suspension` and settle its turn. Call under the session lock with
 * the record as read under that lock. Returns the jobs it queued.
 */
export async function abandonSuspension(
  deps: SuspensionAbandonDeps,
  suspension: SuspensionRecord,
): Promise<readonly QueuedRuntimeJob[]> {
  const { store } = deps;
  const session = await store.getSession(suspension.sessionId);
  const eventBus =
    deps.eventBus && session
      ? sessionEventBus(deps.eventBus, session)
      : undefined;
  const plan = await planSuspensionAbandon(store, suspension);
  let enqueue:
    | Omit<Parameters<typeof enqueueDeferredRuntimeJobs>[1], "descriptors">
    | undefined;
  if (session && plan.releasedRuntimeJobs.length > 0) {
    deps.pluginRegistry.syncSessionActivations(
      session.id,
      session.activePlugins,
    );
    const userSettings = await loadSessionPluginUserSettings(
      store,
      session,
      deps.playerSettings,
    );
    enqueue = {
      sessionId: session.id,
      session,
      activeRuntimes: deps.pluginRegistry.getActiveRuntimes(session.id),
      locale: session.locale ?? DEFAULT_LOCALE,
      ...(userSettings ? { userSettings } : {}),
      // A runtime switched off since the turn has no job to run.
      skipInactive: true,
      ...(deps.registerCredentials
        ? { registerCredentials: deps.registerCredentials }
        : {}),
    };
  }
  const queued = await store.withTransaction(async (tx) => {
    await applySuspensionAbandonTx(tx, plan, new Date().toISOString());
    if (!enqueue) return [];
    return enqueueDeferredRuntimeJobs(tx, {
      ...enqueue,
      descriptors: plan.releasedRuntimeJobs,
    });
  });
  await settleAbandonedSuspensionJobs(
    { store, ...(eventBus ? { eventBus } : {}) },
    suspension,
  );
  await publishDeferredRuntimeJobs(
    { eventBus: deps.eventBus, worker: deps.worker },
    queued,
  );
  return queued;
}
