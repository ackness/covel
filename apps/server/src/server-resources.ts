import {
  awaitPendingMemoryBackgroundTasks,
  pendingMemoryBackgroundTaskCount,
} from "@covel/memory";
import type { DataStore, MediaStore } from "@covel/store";
import type { Sql } from "postgres";
import type { ApiBootstrapResult } from "./routes/api/bootstrap.js";
import type { WorldFileWatcher } from "./world-file-watcher.js";
import type { ApplicationWork } from "./application-work.js";

/** Assign each resource immediately after creation, before the next startup step. */
export interface ServerResources {
  applicationWork?: Pick<ApplicationWork, "close">;
  store?: Pick<DataStore, "close">;
  mediaStore?: Pick<MediaStore, "close">;
  api?: Pick<
    ApiBootstrapResult,
    "startupMaintenance" | "closePluginEntries"
  > & {
    applicationWork: Pick<ApplicationWork, "close">;
    runtimeJobWorker: Pick<ApiBootstrapResult["runtimeJobWorker"], "close">;
    pluginBackgroundQueue: Pick<
      ApiBootstrapResult["pluginBackgroundQueue"],
      "close"
    >;
    eventBus: Pick<ApiBootstrapResult["eventBus"], "close">;
  };
  readonly worldWatchers: WorldFileWatcher[];
  lockSql?: Pick<Sql, "end">;
  ingestLockSql?: Pick<Sql, "end">;
}

const DRAIN_PHASE_TIMEOUT_MS = 2_000;
const MEMORY_DRAIN_TIMEOUT_MS = 5_000;

async function drainPhase(
  name: string,
  run: () => Promise<unknown> | void,
  timeoutMs = DRAIN_PHASE_TIMEOUT_MS,
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("drain timed out")), timeoutMs);
  });
  try {
    await Promise.race([Promise.resolve().then(run), timeout]);
    return true;
  } catch {
    // Exceptions can contain connection strings or provider response bodies.
    console.warn(`[shutdown] drain phase "${name}" failed or timed out`);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Shared by failed startup and normal shutdown; retain dependencies under owned work. */
export function createServerResourceDrain(
  resources: ServerResources,
): () => Promise<void> {
  let closing: Promise<void> | undefined;
  async function drain(): Promise<void> {
    const api = resources.api;
    const applicationWork = resources.applicationWork ?? api?.applicationWork;
    // Stop every producer before waiting: a foreground request or watcher can
    // be waiting for a session lock held by a background job being cancelled.
    const producers: Array<() => Promise<unknown> | void> = [
      ...(applicationWork ? [() => applicationWork.close()] : []),
      ...resources.worldWatchers.map((watcher) => () => watcher.stop()),
      ...(api
        ? [
            () => api.runtimeJobWorker.close(),
            () => api.pluginBackgroundQueue.close(),
            () => api.startupMaintenance,
          ]
        : []),
    ];
    if (
      !(await drainPhase("close application and background work", () =>
        Promise.all(producers.map((stop) => Promise.resolve().then(stop))),
      ))
    )
      return;

    const memoryDrained = await drainPhase(
      "flush memory background tasks",
      async () => {
        const result = await awaitPendingMemoryBackgroundTasks();
        if (result.rejected > 0) {
          console.warn(
            `[shutdown] ${result.rejected} memory background task(s) failed while draining`,
          );
        }
      },
      MEMORY_DRAIN_TIMEOUT_MS,
    );
    const pending = pendingMemoryBackgroundTaskCount();
    if (pending > 0) {
      console.warn(
        `[shutdown] ${pending} memory background task(s) still pending; leaving dependencies open for process exit`,
      );
    }
    if (!memoryDrained || pending > 0) return;
    if (
      api &&
      !(await drainPhase("close plugin entries", () =>
        api.closePluginEntries(),
      ))
    )
      return;
    if (
      api &&
      !(await drainPhase("close event bus", () => api.eventBus.close()))
    )
      return;
    if (resources.mediaStore?.close) {
      await drainPhase("close media store", () =>
        resources.mediaStore!.close!(),
      );
    }
    if (resources.store)
      await drainPhase("close data store", () => resources.store!.close());
    // Pools no longer have producers; one failed leaf must not skip its peers.
    if (resources.lockSql)
      await drainPhase("close pg lock pool", () =>
        resources.lockSql!.end({ timeout: 1 }),
      );
    if (resources.ingestLockSql)
      await drainPhase("close pg ingest lock pool", () =>
        resources.ingestLockSql!.end({ timeout: 1 }),
      );
  }
  return () => {
    // Publish before any disposer can re-enter through a synchronous callback.
    closing ??= Promise.resolve().then(drain);
    return closing;
  };
}
