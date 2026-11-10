/**
 * Bootstrap stage 1: the event bus every later stage publishes on, and the
 * record of what a failed startup must release.
 */

import { readRuntimeEnv } from "@covel/shared";
import {
  createEventBus,
  type EventBus,
  type EventBusTransport,
} from "@covel/events";
import type { ApiBootstrapConfig } from "./config.js";
import type { BootstrapPluginEntries } from "./plugin-entry.js";

/**
 * Resources a stage acquired, recorded as soon as it holds them so a later
 * failure releases exactly what exists. Injected resources (the store, the
 * locks) stay owned by the composition root and are never listed here.
 */
export interface BootstrapOwned {
  eventTransport?: EventBusTransport;
  eventBus?: EventBus;
  pluginEntries?: BootstrapPluginEntries;
  closeTools?: () => Promise<void>;
}

/**
 * Cross-pod EventBus fan-out (audit): multi-pod PG deployments need events
 * emitted on one pod to reach SSE subscribers on another. PG LISTEN/NOTIFY is
 * the lowest-dependency shared transport (the deployment already runs on PG).
 * Single-process backends (memory/sqlite) pass no transport — pure in-process
 * behavior, unchanged. A boot-time transport failure propagates: with a PG
 * store backend, an unreachable PG is fatal anyway, and silently degrading to
 * single-pod fan-out would be incorrect.
 */
export async function createBootstrapEventBus(
  config: Pick<ApiBootstrapConfig, "store" | "storeBackend">,
  owned: BootstrapOwned,
): Promise<EventBus> {
  const databaseUrl = readRuntimeEnv().databaseUrl;
  if (config.storeBackend === "pg" && databaseUrl) {
    const { createPgEventTransport } =
      await import("../../../lib/pg-event-transport.js");
    owned.eventTransport = await createPgEventTransport(databaseUrl);
    console.log(
      "[bootstrap] event bus transport: pg listen/notify (cross-pod fan-out enabled)",
    );
  }
  owned.eventBus = createEventBus(config.store, {
    transport: owned.eventTransport,
    requireSessionIncarnation: true,
  });
  return owned.eventBus;
}

/**
 * Release what a failed startup acquired: tool admission first, then plugin
 * entries, then the event bus (or the bare transport when the bus was never
 * built). The caller rethrows the startup error.
 */
export async function releaseAfterStartupFailure(
  owned: BootstrapOwned,
): Promise<void> {
  await owned.closeTools?.();
  try {
    await owned.pluginEntries?.close();
  } catch {
    console.warn(
      "[bootstrap] failed to clean up plugin entries after startup failure",
    );
  }
  try {
    if (owned.eventBus) await owned.eventBus.close();
    else await owned.eventTransport?.close?.();
  } catch {
    console.warn(
      "[bootstrap] failed to close event infrastructure after startup failure",
    );
  }
}
