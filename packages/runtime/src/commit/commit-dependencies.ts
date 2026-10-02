/**
 * Commit-time dependency checks for savepoint isolation.
 *
 * Next to a committed story, an optional runtime's writes can be dropped on
 * their own. A runtime that hard-depends on a dropped one ran on output that
 * never landed, so it must not commit, and no follow-up work may be queued
 * from it either.
 */

import type {
  BindingSource,
  DeferredRuntimeJob,
  DependencyRef,
  RuntimeManifest,
} from "@covel/shared";
import { getRuntimeSpec } from "@covel/shared";

export interface CommitDependencyView {
  /** Every manifest that may appear in `results`. */
  readonly runtimes: readonly RuntimeManifest[];
  /** Results produced by this execution. */
  readonly results: readonly {
    readonly runtimeId: string;
    readonly status: string;
    readonly effects?: { readonly events?: unknown };
  }[];
  /** Runtimes of this execution whose writes did not commit. */
  readonly dropped: ReadonlySet<string>;
}

/**
 * The first hard upstream of `manifest` that this execution produced but did
 * not commit: a turn-scoped `needs` target, a required `inputs` source, or the
 * emitters of its trigger event when none of them committed. `after` edges and
 * optional inputs never require their producer's success. An upstream absent
 * from `results` (setup completed earlier, a retry seed) committed before.
 */
export function droppedUpstream(
  manifest: RuntimeManifest,
  view: CommitDependencyView,
): string | undefined {
  if (view.dropped.size === 0) return undefined;
  const spec = getRuntimeSpec(manifest);
  const sources: (DependencyRef | BindingSource)[] = [
    ...spec.deps.needs.filter(
      (need) => typeof need === "string" || need.scope !== "session",
    ),
    ...Object.values(spec.bindings)
      .filter((binding) => binding.required !== false)
      .map((binding) => binding.from),
  ];
  for (const source of sources) {
    const lost = droppedSource(source, view);
    if (lost) return lost;
  }
  const topic =
    manifest.trigger?.type === "event" ? manifest.trigger.topic : undefined;
  return topic ? droppedEmitter(topic, view, manifest.name) : undefined;
}

/** A dropped emitter of `topic` when every runtime that emitted it was dropped. */
export function droppedEmitter(
  topic: string,
  view: CommitDependencyView,
  exceptRuntimeId?: string,
): string | undefined {
  if (view.dropped.size === 0) return undefined;
  const emitters = view.results.filter(
    (result) =>
      result.runtimeId !== exceptRuntimeId &&
      result.status === "success" &&
      emitsTopic(result.effects?.events, topic),
  );
  return emitters.length > 0 &&
    emitters.every((result) => view.dropped.has(result.runtimeId))
    ? emitters[0]!.runtimeId
    : undefined;
}

/**
 * A queued job's frozen source facts as committed: a dropped runtime reads as
 * failed in both the turn digest and the seeded upstream results, so later
 * background work never sees it as a successful upstream.
 */
export function settleDroppedInputs(
  job: DeferredRuntimeJob,
  dropped: ReadonlySet<string>,
): DeferredRuntimeJob {
  if (dropped.size === 0) return job;
  return {
    ...job,
    turnDigest: {
      ...job.turnDigest,
      runtimeResults: job.turnDigest.runtimeResults.map((result) =>
        dropped.has(result.runtimeId)
          ? { ...result, status: "failed" as const }
          : result,
      ),
    },
    upstreamResults: job.upstreamResults.map((result) =>
      dropped.has(result.runtimeId)
        ? {
            ...result,
            status: "failed" as const,
            error: "writes did not commit",
          }
        : result,
    ),
  };
}

function droppedSource(
  source: DependencyRef | BindingSource,
  view: CommitDependencyView,
): string | undefined {
  if (typeof source === "string" || "runtime" in source) {
    const name = typeof source === "string" ? source : source.runtime;
    return view.dropped.has(name) ? name : undefined;
  }
  const providers = view.runtimes
    .filter((runtime) => runtime.outputContract === source.capability)
    .map((runtime) => runtime.name);
  const lost = providers.find((name) => view.dropped.has(name));
  if (!lost) return undefined;
  if (source.cardinality === "all") return lost;
  // `one`: still satisfied while another provider committed a success.
  const committed = providers.some(
    (name) =>
      !view.dropped.has(name) &&
      view.results.some(
        (result) => result.runtimeId === name && result.status === "success",
      ),
  );
  return committed ? undefined : lost;
}

function emitsTopic(events: unknown, topic: string): boolean {
  return (
    Array.isArray(events) &&
    events.some(
      (event) =>
        event !== null &&
        typeof event === "object" &&
        (event as { topic?: unknown }).topic === topic,
    )
  );
}
