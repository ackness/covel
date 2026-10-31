import { createTurnEmitter } from "../trace/turn-emitter.js";
import {
  presentationSnapshotSchema,
  type DeferredRuntimeJob,
  type RuntimeManifest,
} from "@covel/shared";
import type { StoreTransaction } from "@covel/store";
import { createPresentationBudget } from "./budget.js";
import { presentationLimits } from "./policy.js";
import { completePresentation } from "./state.js";
import {
  emptyPresentationDigest,
  projectPresentationStory,
  presentationIncarnation,
  takePresentationSnapshot,
  PresentationUnavailable,
} from "./projection.js";

/** Admission can settle a valid source before a handler or execution exists. */
export async function unavailablePresentationJob(
  store: Pick<
    StoreTransaction,
    | "getSession"
    | "getPluginData"
    | "compareAndSetPluginData"
    | "queryTraceEvents"
    | "addTraceEvent"
  >,
  sessionId: string,
  job: DeferredRuntimeJob,
): Promise<void> {
  const snapshot = job.presentation;
  if (!snapshot) return;
  const prior = await store.queryTraceEvents(sessionId, {
    types: ["presentation.completed"],
  });
  if (
    prior.some(
      (event) => (event.payload as { jobId?: string })?.jobId === job.jobId,
    )
  )
    return;
  const budget = createPresentationBudget({
    store,
    sessionId,
    snapshot,
    currentLimits: snapshot.limits,
    assertLive: () => {},
  });
  await completePresentation(
    createTurnEmitter({ store, sessionId, turnId: job.sourceTurnId }),
    {
      pluginId: job.pluginId,
      runtimeId: job.runtimeId,
      turnId: job.sourceTurnId,
    },
    {
      snapshot,
      budget,
      mediaIds: new Set(),
      reason: "unavailable",
      jobId: job.jobId,
    },
    "no-op",
  );
}

/** Only transaction reads and pure projection; no plugin, media or provider I/O. */
export async function finalizePresentationJobs(
  tx: StoreTransaction,
  sessionId: string,
  jobs: readonly DeferredRuntimeJob[],
  runtimes: readonly RuntimeManifest[],
  settled = false,
): Promise<DeferredRuntimeJob[]> {
  const finalized: DeferredRuntimeJob[] = [];
  const skipped = async (
    job: DeferredRuntimeJob,
    reason: "no-story" | "unavailable",
  ) => {
    const parsed = presentationSnapshotSchema.safeParse(job.presentation);
    const budget = parsed.success
      ? createPresentationBudget({
          store: tx,
          sessionId,
          snapshot: parsed.data,
          currentLimits: parsed.data.limits,
          assertLive: () => {},
        })
      : undefined;
    await budget?.refresh().catch(() => undefined);
    await createTurnEmitter({
      store: tx,
      sessionId,
      turnId: job.sourceTurnId,
    }).emit("presentation.completed", {
      pluginId: job.pluginId,
      runtimeId: job.runtimeId,
      jobId: job.jobId,
      sourceTurnId: job.sourceTurnId,
      sourceExecutionId: job.sourceExecutionId,
      status: "no-op",
      reason,
      budget: budget?.usage() ?? {
        calls: { limit: 0, used: 0 },
        generations: { limit: 0, used: 0 },
      },
    });
  };
  for (const job of jobs) {
    const target = runtimes.find(
      (runtime) =>
        runtime.name === job.runtimeId && runtime.pluginId === job.pluginId,
    );
    // A resumed unit may carry only its own manifest; the enqueue adapter
    // rechecks the full active graph when the source finally settles.
    if (!target) {
      if (job.presentation && settled) await skipped(job, "unavailable");
      else finalized.push(job);
      continue;
    }
    if (!target.presentation) {
      if (job.presentation) await skipped(job, "unavailable");
      else finalized.push(job);
      continue;
    }
    if (target.version !== job.pluginVersion) {
      if (settled) await skipped(job, "unavailable");
      continue;
    }
    const limits = presentationLimits(target);
    const sourceIncarnation = job.presentation?.incarnation;
    if (
      (sourceIncarnation &&
        sourceIncarnation !== (await presentationIncarnation(tx, sessionId))) ||
      (!sourceIncarnation && (limits.calls > 0 || limits.generations > 0))
    ) {
      await skipped(job, "unavailable");
      continue;
    }
    if (job.presentation?.committed) {
      const parsed = presentationSnapshotSchema.safeParse(job.presentation);
      if (parsed.success)
        finalized.push({
          ...job,
          presentation: parsed.data,
          upstreamResults: [],
          turnDigest: emptyPresentationDigest(
            job.sourceTurnId,
            parsed.data.locale,
          ),
        });
      else if (settled) await skipped(job, "unavailable");
      continue;
    }
    const providers = runtimes.filter(
      (runtime) =>
        runtime.outputKind === "story" &&
        !runtime.concealed &&
        runtime.outputContract === "narrative-engine@2",
    );
    const provider = providers.length === 1 ? providers[0] : undefined;
    const messages = provider
      ? (await tx.listMessages(sessionId)).filter((message) => {
          const metadata = message.metadata as
            Record<string, unknown> | undefined;
          return (
            metadata?.turnId === job.sourceTurnId &&
            metadata?.runtimeId === provider.name &&
            metadata?.kind === "story"
          );
        })
      : [];
    // An absent/rejected/ambiguous source never releases paid work.
    const message = messages.length === 1 ? messages[0] : undefined;
    const story = message
      ? projectPresentationStory(message.metadata)
      : undefined;
    if (!story && settled) {
      await skipped(job, "no-story");
      continue;
    }
    try {
      const snapshot = await takePresentationSnapshot({
        store: tx,
        manifest: target,
        sessionId,
        sourceTurnId: job.sourceTurnId,
        sourceExecutionId: job.sourceExecutionId,
        locale: job.turnDigest.locale,
        ...(story ? { story } : {}),
      });
      finalized.push({
        ...job,
        presentation: { ...snapshot, committed: Boolean(story) },
        upstreamResults: [],
        turnDigest: emptyPresentationDigest(job.sourceTurnId, snapshot.locale),
      });
    } catch (error) {
      if (!(error instanceof PresentationUnavailable)) throw error;
      if (settled || message) await skipped(job, "unavailable");
      // Snapshot size is a feature refusal, never a story commit failure.
    }
  }
  return finalized;
}
