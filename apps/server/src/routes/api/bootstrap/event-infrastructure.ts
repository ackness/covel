/**
 * Bootstrap stage 1: the event bus every later stage publishes on, and the
 * record of what a failed startup must release.
 */

import { rm } from "node:fs/promises";
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
  instancePlugins?: import("./instance-plugins.js").InstancePluginRegistry;
  appScheduler?: Pick<import("./app-scheduler.js").AppScheduler, "close">;
  configFlows?: Pick<import("./config-flows.js").ConfigFlowEngine, "close">;
  uiSlots?: Pick<import("../../../ui-slots/host.js").UiSlotHost, "close">;
  runtimeJobWorker?: Pick<
    import("../plugin-rpc/runtime-job-worker.js").RuntimeJobWorker,
    "close"
  >;
  runtimeJobCredentials?: { readonly clear: () => void };
  closeTools?: () => Promise<void>;
  ephemeralConfigDir?: string;
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

async function runStartupCleanup(
  label: string,
  fn: () => Promise<unknown> | unknown,
): Promise<void> {
  try {
    await fn();
  } catch {
    console.warn(`[bootstrap] failed to ${label} after startup failure`);
  }
}

/**
 * Release what a failed startup acquired in reverse dependency order. Each
 * cleanup step is isolated so a throwing resource never leaks the rest.
 */
export async function releaseAfterStartupFailure(
  owned: BootstrapOwned,
): Promise<void> {
  if (owned.runtimeJobCredentials) {
    await runStartupCleanup("clear runtime job credentials", () =>
      owned.runtimeJobCredentials?.clear(),
    );
  }
  if (owned.runtimeJobWorker) {
    await runStartupCleanup("close runtime job worker", () =>
      owned.runtimeJobWorker?.close(),
    );
  }
  if (owned.appScheduler) {
    await runStartupCleanup("close app scheduler", () =>
      owned.appScheduler?.close(),
    );
  }
  if (owned.configFlows) {
    await runStartupCleanup("close config flows", () =>
      owned.configFlows?.close(),
    );
  }
  if (owned.uiSlots) {
    await runStartupCleanup("close ui slots", () => owned.uiSlots?.close());
  }
  if (owned.closeTools) {
    await runStartupCleanup("close tools", () => owned.closeTools?.());
  }
  if (owned.pluginEntries) {
    await runStartupCleanup("clean up plugin entries", () =>
      owned.pluginEntries?.close(),
    );
  }
  if (owned.eventBus || owned.eventTransport) {
    await runStartupCleanup("close event infrastructure", () =>
      owned.eventBus ? owned.eventBus.close() : owned.eventTransport?.close?.(),
    );
  }
  if (owned.ephemeralConfigDir) {
    await runStartupCleanup("remove ephemeral instance config directory", () =>
      rm(owned.ephemeralConfigDir!, { recursive: true, force: true }),
    );
  }
}
