/** Actual event payload producers, kept out of public runtime and follower DTOs. */
import type { RuntimeResult, TurnResult } from "@covel/shared";

const EVENT_PRODUCER = Symbol.for("@covel/runtime/event-producer");
type EventCarrier = object & { readonly [EVENT_PRODUCER]?: string };
type DeferredFollower = NonNullable<TurnResult["deferredFollowers"]>[number];
const DEFERRED_FOLLOWERS = Symbol.for("@covel/runtime/deferred-followers");
type FollowerCarrier = RuntimeResult & {
  readonly [DEFERRED_FOLLOWERS]?: readonly DeferredFollower[];
};

/** Followers belong to their producer's commit unit, including nested calls. */
export function deferEventFollower(
  producer: RuntimeResult,
  follower: DeferredFollower,
): DeferredFollower {
  attachEventProducer(follower, producer.runId);
  Object.defineProperty(producer, DEFERRED_FOLLOWERS, {
    value: [...deferredFollowersOf([producer]), follower],
    enumerable: false,
    configurable: true,
  });
  return follower;
}

/** Directly owned followers of results already flattened in commit order. */
export function deferredFollowersOf(
  results: readonly RuntimeResult[],
): DeferredFollower[] {
  return results.flatMap(
    (result) => (result as FollowerCarrier)[DEFERRED_FOLLOWERS] ?? [],
  );
}

/** The source invocation, captured when the chain selected its payload. */
export function attachEventProducer<T extends object>(
  target: T,
  producerRunId: string,
): T {
  Object.defineProperty(target, EVENT_PRODUCER, {
    value: producerRunId,
    enumerable: false,
    configurable: true,
  });
  return target;
}

export interface ExecutionEventDependencies {
  /** Synchronous consumer run -> actual producer run. */
  readonly runs: Readonly<Record<string, string>>;
  /** Producer run IDs in the same order as the execution's deferred followers. */
  readonly followers: readonly string[];
}

/** Symbols do not survive the commit plan's structuredClone. */
export function collectExecutionEventDependencies(
  turn: Pick<
    TurnResult,
    "runtimeResults" | "nestedRuntimeResults" | "deferredFollowers"
  >,
): ExecutionEventDependencies {
  const runs: Record<string, string> = {};
  for (const result of new Set([
    ...turn.runtimeResults,
    ...(turn.nestedRuntimeResults ?? []),
  ])) {
    const source = (result as EventCarrier)[EVENT_PRODUCER];
    if (source !== undefined) runs[result.runId] = source;
  }
  const followers: string[] = [];
  for (const follower of turn.deferredFollowers ?? []) {
    const source = (follower as EventCarrier)[EVENT_PRODUCER];
    if (source === undefined)
      throw new Error(
        `Missing event producer for follower ${follower.runtimeId}`,
      );
    followers.push(source);
  }
  return { runs, followers };
}

/** Queue or run only followers whose selected payload's producer committed. */
export function committedEventFollowers<
  T extends { readonly runtimeId: string },
>(
  followers: readonly T[],
  sources: readonly string[],
  droppedRunIds: ReadonlySet<string>,
): T[] {
  if (followers.length !== sources.length)
    throw new Error(
      "Event followers and producer run IDs must have equal lengths",
    );
  return followers.filter((follower, index) => {
    const source = sources[index];
    if (source === undefined)
      throw new Error(
        `Missing event producer for follower ${follower.runtimeId}`,
      );
    return !droppedRunIds.has(source);
  });
}
