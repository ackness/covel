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

/** The source invocation of a background follower's payload. */
function attachEventProducer<T extends object>(
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

/**
 * Record on a synchronous follower's result the event the chain delivered.
 * The field is public and persisted: a scoped retry reads it back from
 * `turn_results` to hand the target the same event.
 */
export function attachEventTrigger(
  result: RuntimeResult,
  trigger: NonNullable<RuntimeResult["trigger"]>,
): RuntimeResult {
  // In place: the result may carry kernel-only symbols a copy would lose.
  return Object.assign(result, {
    trigger: { topic: trigger.topic, producerRunId: trigger.producerRunId },
  });
}

export interface ExecutionEventDependencies {
  /** Synchronous consumer run -> actual producer run. */
  readonly runs: Readonly<Record<string, string>>;
  readonly followers: readonly {
    readonly descriptor: DeferredFollower;
    readonly producerRunId: string;
  }[];
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
    const source = result.trigger?.producerRunId;
    if (source !== undefined) runs[result.runId] = source;
  }
  const followers = (turn.deferredFollowers ?? []).map((descriptor) => {
    const producerRunId = (descriptor as EventCarrier)[EVENT_PRODUCER];
    if (producerRunId === undefined)
      throw new Error(
        `Missing event producer for follower ${descriptor.runtimeId}`,
      );
    return { descriptor, producerRunId };
  });
  return { runs, followers };
}

/** Queue or run only followers whose selected payload's producer committed. */
export function committedEventFollowers(
  followers: ExecutionEventDependencies["followers"],
  droppedRunIds: ReadonlySet<string>,
): DeferredFollower[] {
  return followers.flatMap(({ descriptor, producerRunId }) =>
    droppedRunIds.has(producerRunId) ? [] : [descriptor],
  );
}
