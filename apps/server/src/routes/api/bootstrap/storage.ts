/** Bootstrap stage 2: session locks and the event-emitting store. */

import type { EventBus } from "@covel/events";
import type { DataStore } from "@covel/store";
import {
  createInProcessSessionLock,
  type SessionLock,
} from "../../../lib/session-lock.js";
import type { ApiBootstrapConfig } from "./config.js";
import { wrapStoreWithPluginDataEvents } from "./plugin-data-store-events.js";

export interface BootstrapStorage {
  /** The injected store, wrapped to emit `plugin-data.changed`. */
  readonly store: DataStore;
  readonly sessionLock: SessionLock;
  /** Nonblocking commit lock durable runtime-job recovery requires. */
  readonly tryWithCommitLock: NonNullable<SessionLock["tryWithLock"]>;
  readonly memoryIngestLock: SessionLock;
}

export function createBootstrapStorage(
  config: Pick<
    ApiBootstrapConfig,
    "store" | "sessionLock" | "memoryIngestLock"
  >,
  eventBus: EventBus,
): BootstrapStorage {
  // Per-session serializer. The caller (e.g. `app.ts`) may inject a PG
  // advisory-lock implementation for multi-pod safety; otherwise we fall
  // back to the in-process chain lock which is correct for single-process
  // deployments (memory/sqlite, single PG pod). Route handlers read this
  // via `c.get('sessionLock')` and never import a concrete lock module.
  const sessionLock: SessionLock =
    config.sessionLock ?? createInProcessSessionLock();
  const tryWithCommitLock = sessionLock.tryWithLock?.bind(sessionLock);
  if (!tryWithCommitLock) {
    throw new Error("durable runtime jobs require a nonblocking session lock");
  }
  const memoryIngestLock: SessionLock =
    config.memoryIngestLock ?? createInProcessSessionLock();
  console.log(
    `[bootstrap] session lock: ${config.sessionLock ? "external (injected)" : "in-process"}`,
  );

  // Wrap store to automatically emit plugin-data.changed SSE events
  // on every setPluginData / setPluginDataBatch call, regardless of caller.
  const store = wrapStoreWithPluginDataEvents(config.store, eventBus);
  return { store, sessionLock, tryWithCommitLock, memoryIngestLock };
}
