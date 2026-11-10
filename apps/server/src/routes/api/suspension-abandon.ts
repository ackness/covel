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
 * `cancelled` once that transaction commits, and a suspended setup runtime's
 * attempt ends `failed` (the runtime stays not done).
 *
 * The caller holds the session lock.
 */

import type { Context } from "hono";
import type {
  DataStore,
  StoreTransaction,
  SuspensionRecord,
} from "@covel/store";
import type { EventBus } from "@covel/events";
import type { PluginRegistry } from "@covel/plugin-loader";
import {
  applySuspensionAbandonTx,
  planSuspensionAbandon,
  settleAbandonedSetupAttempt,
  settleAbandonedSuspensionJobs,
} from "@covel/runtime";
import {
  DEFAULT_LOCALE,
  type DeferredRuntimeJob,
  type RuntimeManifest,
  type TurnInput,
} from "@covel/shared";
import type { QueuedRuntimeJob } from "./plugin-rpc/runtime-job-enqueue.js";
import {
  queueReleasedRuntimeJobs,
  type CommitEnqueueContext,
} from "./commit-envelope.js";
import {
  publishDeferredRuntimeJobs,
  requestCredentialHandoff,
} from "./plugin-rpc/settled-request.js";
import type { JobCredentialHandoff } from "./plugin-rpc/runtime-job-credentials.js";
import type { RuntimeJobWorker } from "./plugin-rpc/runtime-job-worker.js";
import { loadSessionPluginUserSettings } from "./plugin-user-settings.js";
import { syncSessionRuntimes } from "./execution-context.js";

export interface SuspensionAbandonDeps {
  readonly store: DataStore;
  readonly pluginRegistry: Pick<
    PluginRegistry,
    "syncSessionActivations" | "getActiveRuntimes"
  >;
  readonly eventBus?: EventBus;
  readonly worker?: Pick<RuntimeJobWorker, "wake">;
  /** Hands request-scoped provider services to the jobs this releases. */
  readonly credentials?: CommitEnqueueContext["credentials"];
  /** Player settings sent with the request, merged over the world's. */
  readonly playerSettings?: TurnInput["userSettings"];
}

/**
 * The abandon dependencies of a request. A request whose commit also queues
 * other jobs passes its own hand-off, so one withdrawal covers them all.
 */
export function requestSuspensionAbandonDeps(
  c: Context,
  playerSettings?: TurnInput["userSettings"],
  credentials: JobCredentialHandoff = requestCredentialHandoff(c),
): SuspensionAbandonDeps {
  const eventBus = c.get("eventBus");
  const worker = c.get("runtimeJobWorker");
  return {
    store: c.get("store"),
    pluginRegistry: c.get("pluginRegistry"),
    ...(eventBus ? { eventBus } : {}),
    ...(worker ? { worker } : {}),
    ...(playerSettings ? { playerSettings } : {}),
    credentials,
  };
}

/**
 * Queues the detached jobs a suspension's turn held back, inside the caller's
 * transaction, and publishes them once it committed. An abandon uses it, and
 * so does a commit whose new suspension replaces an older one of the same
 * runtime (`enqueueReleasedJobsInTx` of `commitExecution`).
 */
export interface HeldJobsRelease {
  readonly enqueueInTx: (
    tx: StoreTransaction,
    jobs: readonly DeferredRuntimeJob[],
  ) => Promise<void>;
  /** Call after the transaction committed. */
  readonly publish: () => Promise<readonly QueuedRuntimeJob[]>;
}

export function heldJobsRelease(
  deps: SuspensionAbandonDeps,
  sessionId: string,
): HeldJobsRelease {
  const queued: QueuedRuntimeJob[] = [];
  return {
    enqueueInTx: async (tx, jobs) => {
      if (jobs.length === 0) return;
      const session = await tx.getSession(sessionId);
      if (!session) return;
      const activeRuntimes = syncSessionRuntimes(
        deps.pluginRegistry,
        session.id,
        session.activePlugins,
      );
      const userSettings = await loadSessionPluginUserSettings(
        tx,
        session,
        deps.playerSettings,
      );
      queued.push(
        ...(await queueReleasedRuntimeJobs(
          tx,
          {
            sessionId: session.id,
            session,
            activeRuntimes,
            locale: session.locale ?? DEFAULT_LOCALE,
            ...(userSettings ? { userSettings } : {}),
            ...(deps.credentials ? { credentials: deps.credentials } : {}),
          },
          jobs,
        )),
      );
    },
    publish: async () => {
      await publishDeferredRuntimeJobs(
        { eventBus: deps.eventBus, worker: deps.worker },
        queued,
      );
      return queued;
    },
  };
}

/** The active manifest of a suspension's runtime, if it is still active. */
async function activeManifest(
  deps: SuspensionAbandonDeps,
  suspension: SuspensionRecord,
): Promise<RuntimeManifest | undefined> {
  const session = await deps.store.getSession(suspension.sessionId);
  if (!session) return undefined;
  return syncSessionRuntimes(
    deps.pluginRegistry,
    session.id,
    session.activePlugins,
  ).find((runtime) => runtime.name === suspension.runtimeId);
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
  const release = heldJobsRelease(deps, suspension.sessionId);
  const now = new Date().toISOString();
  await store.withTransaction(async (tx) => {
    await applySuspensionAbandonTx(tx, plan, now);
    await release.enqueueInTx(tx, plan.releasedRuntimeJobs);
  });
  await settleAbandonedSuspensionJobs(
    { store, ...(eventBus ? { eventBus } : {}) },
    suspension,
  );
  await settleAbandonedSetupAttempt(
    store,
    suspension,
    await activeManifest(deps, suspension),
    now,
  );
  return release.publish();
}
