import type { RuntimeManifest, RuntimeResult, TurnResult } from "@covel/shared";
import { executeParallel } from "../schedule/parallel-executor.js";
import { NARRATOR_PRIORITY } from "../schedule/scheduler.js";
import { shouldTrigger } from "./trigger.js";
import type { TriggerContext } from "../types.js";

export type DeferredFollower = NonNullable<
  TurnResult["deferredFollowers"]
>[number];

export type EventChainRuntimeExecutor = (
  manifest: RuntimeManifest,
  triggerEvent:
    { topic: string; data: Readonly<Record<string, unknown>> } | undefined,
) => Promise<RuntimeResult>;

export interface RunEventChainParams {
  readonly activeRuntimes: readonly RuntimeManifest[];
  readonly completedResults: Map<string, RuntimeResult>;
  readonly executeRuntime: EventChainRuntimeExecutor;
  readonly maxDepth?: number;
  /** Current session id — threaded into the `TriggerContext` fed to
   *  `shouldTrigger` when re-evaluating event subscribers. */
  readonly sessionId: string;
  /** Current main-loop turn number — same purpose as `sessionId`. */
  readonly turnNumber: number;
  /**
   * How many times each runtime has already produced output this session,
   * and how many turns since it last did.
   *
   * Fan-out is the ONLY place an `event` runtime can trigger: the main
   * scheduler evaluates it with an empty topic list, so its topic match always
   * fails there. Passing hardcoded "never triggered" values here therefore made
   * `maxTriggerCount` and `cooldownTurns` dead for event runtimes everywhere —
   * a once-only event runtime re-fired on every matching emission.
   */
  readonly runtimeTriggerCounts?: ReadonlyMap<string, number>;
  readonly runtimeTurnsSinceLastTrigger?: ReadonlyMap<string, number>;
  /**
   * RuntimeIds the session has already marked Pre-Game-done. A Pre-Game
   * runtime that reported completion must not be resurrected by a later
   * emission of the topic it subscribes to — that is the same one-shot
   * contract the main scheduler enforces, and it is the only gate that keeps
   * setup runtimes out of main-loop fan-out.
   */
  readonly preGameCompleted?: readonly string[];
}

/**
 * Build the `TriggerContext` used to re-evaluate event subscribers during a
 * single turn's event fan-out, delegating the actual topic-match (and trigger
 * gates) to the single authority, `shouldTrigger`.
 *
 * The per-session throttles (`maxTriggerCount` / `cooldownTurns`) are applied
 * **once per turn** by the main scheduler (`selectTriggeredRuntimes`). Within
 * a turn, event fan-out is bounded instead by `maxDepth`, so those fields are
 * set to non-blocking sentinels here — re-applying per-session throttles to a
 * within-turn reaction would be semantically wrong. `isManualTrigger` is
 * irrelevant to the `event` branch.
 *
 * Fan-out is deliberately NOT filtered by the current priority band: it is a
 * causal reaction to something that actually happened, not a scheduled slot.
 * Band filtering would silently drop a subscriber whenever the emitter sat in
 * the other band (a Pre-Game runtime announcing the world is ready, say), with
 * no diagnostic. The gate that genuinely has to hold — "a completed setup
 * runtime never runs again" — is `preGameCompleted`, so that one is passed
 * through for real.
 */
function eventFanoutTriggerContext(
  sessionId: string,
  turnNumber: number,
  pendingEventTopics: readonly string[],
  runtimeName: string,
  triggerCounts: ReadonlyMap<string, number> | undefined,
  turnsSinceLastTrigger: ReadonlyMap<string, number> | undefined,
  preGameCompleted: readonly string[],
): TriggerContext {
  return {
    sessionId,
    turnNumber,
    // Real per-runtime history so `maxTriggerCount` / `cooldownTurns` bite.
    // Absent maps fall back to "never triggered", which keeps direct callers
    // (tests) working and matches the previous behaviour.
    triggerCount: triggerCounts?.get(runtimeName) ?? 0,
    turnsSinceLastTrigger:
      turnsSinceLastTrigger?.get(runtimeName) ?? Number.MAX_SAFE_INTEGER,
    pendingEventTopics,
    isManualTrigger: false,
    preGameCompleted,
  };
}

/**
 * Collect emitted runtime events into a topic -> payload map. First emission
 * wins inside a depth to keep fan-out deterministic.
 */
function collectEventsFrom(
  result: RuntimeResult,
  sink: Map<string, Record<string, unknown>>,
): void {
  const output = result.output as Record<string, unknown> | null | undefined;
  const events = output?.events as Array<Record<string, unknown>> | undefined;
  if (!events) return;
  for (const evt of events) {
    const topic = evt?.topic;
    if (typeof topic !== "string" || topic.length === 0) continue;
    if (sink.has(topic)) continue;
    const data = (evt?.data as Record<string, unknown> | undefined) ?? {};
    sink.set(topic, data);
  }
}

export async function runEventChain({
  activeRuntimes,
  completedResults,
  executeRuntime,
  maxDepth = 8,
  sessionId,
  turnNumber,
  runtimeTriggerCounts,
  runtimeTurnsSinceLastTrigger,
  preGameCompleted = [],
}: RunEventChainParams): Promise<DeferredFollower[]> {
  const emittedEvents = new Map<string, Record<string, unknown>>();
  for (const [, result] of completedResults) {
    collectEventsFrom(result, emittedEvents);
  }

  const deferredFollowers: DeferredFollower[] = [];
  // Background runtimes never enter `completedResults` (they run off-turn), so
  // the chain-local dedup below can't catch them: if the same topic is re-emitted
  // across depths, the same background runtime would be deferred twice. Dedup by
  // runtime name here — first defer wins, later re-emissions are dropped.
  const deferredNames = new Set<string>();
  let chainDepth = 0;
  while (emittedEvents.size > 0 && chainDepth < maxDepth) {
    chainDepth += 1;
    const pendingEventTopics = [...emittedEvents.keys()];
    const nextBatch = activeRuntimes.filter((rt) => {
      // Chain-local dedup: never re-run a runtime that already produced a
      // result this turn.
      if (completedResults.has(rt.name)) return false;
      // The chain only fans out event-subscriber runtimes — this is the
      // chain's *scope* (which runtimes it re-evaluates), not a duplicate of
      // trigger semantics. Without this guard, `shouldTrigger` would return
      // true for an `auto` runtime and wrongly re-execute it.
      if (rt.trigger?.type !== "event") return false;
      // Single source of truth for the event topic-match (+ gates): delegate
      // to `shouldTrigger`, feeding it the freshly-emitted topics.
      return shouldTrigger(
        rt,
        eventFanoutTriggerContext(
          sessionId,
          turnNumber,
          pendingEventTopics,
          rt.name,
          runtimeTriggerCounts,
          runtimeTurnsSinceLastTrigger,
          preGameCompleted,
        ),
      );
    });
    if (nextBatch.length === 0) break;

    const ordered = [...nextBatch].sort(
      (a, b) =>
        (a.priority ?? NARRATOR_PRIORITY) - (b.priority ?? NARRATOR_PRIORITY),
    );

    const currentDepthEvents = new Map(emittedEvents);
    const newEvents = new Map<string, Record<string, unknown>>();
    const syncBatch: RuntimeManifest[] = [];

    for (const manifest of ordered) {
      const topic = manifest.trigger?.topic;
      const matchedEvent =
        topic !== undefined ? currentDepthEvents.get(topic) : undefined;
      if (
        manifest.execution === "background" &&
        topic !== undefined &&
        matchedEvent !== undefined
      ) {
        if (deferredNames.has(manifest.name)) {
          // eslint-disable-next-line no-console -- dev-time warning, not user-facing
          console.warn(
            `[event-chain] background runtime "${manifest.name}" already deferred this turn — dropping duplicate for topic "${topic}"`,
          );
          continue;
        }
        deferredNames.add(manifest.name);
        deferredFollowers.push({
          runtimeId: manifest.name,
          pluginId: manifest.pluginId,
          triggerEvent: { topic, data: matchedEvent },
        });
        continue;
      }
      syncBatch.push(manifest);
    }

    if (syncBatch.length === 0) break;

    const results = await executeParallel(syncBatch, async (manifest) => {
      const topic = manifest.trigger?.topic;
      const matchedEvent =
        topic !== undefined ? currentDepthEvents.get(topic) : undefined;
      const triggerEvent =
        topic !== undefined && matchedEvent !== undefined
          ? { topic, data: matchedEvent }
          : undefined;
      return executeRuntime(manifest, triggerEvent);
    });
    for (const [name, result] of results) {
      completedResults.set(name, result);
      collectEventsFrom(result, newEvents);
    }

    emittedEvents.clear();
    for (const [topic, data] of newEvents) emittedEvents.set(topic, data);
  }

  return deferredFollowers;
}
