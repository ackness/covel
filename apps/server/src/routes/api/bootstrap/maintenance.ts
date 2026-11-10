/**
 * Bootstrap stage 11: start background work once assembly has succeeded —
 * the startup suspension and trace sweeps, then the runtime-job worker.
 */

import type { EventBus } from "@covel/events";
import type { PluginRegistry } from "@covel/plugin-loader";
import { maybeSweepOldTraces } from "@covel/runtime";
import type { DataStore, StoreBackend } from "@covel/store";
import type { SessionLock } from "../../../lib/session-lock.js";
import type { RuntimeJobWorker } from "../plugin-rpc/runtime-job-worker.js";
import {
  maybeSweepExpiredSuspensions,
  suspensionExpirer,
} from "../suspension-sweep.js";

/**
 * Returns the startup scans. They remain non-blocking for readiness, but
 * belong to the host's drain boundary: it awaits them before closing storage.
 */
export function startBootstrapMaintenance(args: {
  readonly storeBackend: StoreBackend;
  readonly store: DataStore;
  readonly registry: PluginRegistry;
  readonly sessionLock: SessionLock;
  readonly eventBus: EventBus;
  readonly runtimeJobWorker: RuntimeJobWorker;
}): Promise<void> {
  const { store, runtimeJobWorker } = args;
  const suspensionSweep = {
    store,
    expire: suspensionExpirer({
      store,
      pluginRegistry: args.registry,
      sessionLock: args.sessionLock,
      eventBus: args.eventBus,
      worker: runtimeJobWorker,
    }),
  };
  const startupMaintenance = maybeSweepExpiredSuspensions(suspensionSweep, {
    force: true,
    // Only PostgreSQL can have another server process with a live claim.
    ...(args.storeBackend === "pg" ? {} : { claimMaxAgeMs: 0 }),
  })
    .catch(() => {
      console.warn("[suspension-sweep] startup sweep failed");
    })
    .then(() => maybeSweepOldTraces(store, { force: true }))
    .then(() => undefined);
  runtimeJobWorker.wake();
  return startupMaintenance;
}
