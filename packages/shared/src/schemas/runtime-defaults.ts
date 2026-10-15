/**
 * Defaults of an authored runtime (RUNTIME.md or the inline `runtime` of a
 * PLUGIN.md) for the fields most manifests would otherwise repeat. The loader
 * applies them when it compiles a runtime, `validate:plugin` warns about a
 * field written with its default, and the generated reference states them,
 * all from these values.
 */

/** `io.visibility` of a runtime that does not write one. */
export const DEFAULT_RUNTIME_VISIBILITY = "system";

/** The visibilities a runtime may declare. */
export type RuntimeVisibility = "story" | "system";

/** `agent.model` of an agent that names no slot: the slot of its visibility. */
export function defaultAgentModel(
  visibility: RuntimeVisibility | undefined,
): string {
  return visibility === "story" ? "story" : "plugin";
}

/** The `agent.loop` limits the loader fills in when an agent leaves them out. */
export interface AgentLoopDefaults {
  readonly timeoutMs: number;
  readonly callTimeoutMs: number;
  readonly maxRetries: number;
}

/**
 * `agent.loop` defaults by visibility. A `story` agent writes the player's
 * narrative in one long streamed call, so it gets more time per call and one
 * retry; every other agent gets the limits most bundled agents used to write.
 */
export const AGENT_LOOP_DEFAULTS: Readonly<
  Record<RuntimeVisibility, AgentLoopDefaults>
> = {
  system: { timeoutMs: 120_000, callTimeoutMs: 60_000, maxRetries: 3 },
  story: { timeoutMs: 240_000, callTimeoutMs: 120_000, maxRetries: 1 },
};

/** The `agent.loop` defaults of an agent with this visibility. */
export function defaultAgentLoop(
  visibility: RuntimeVisibility | undefined,
): AgentLoopDefaults {
  return AGENT_LOOP_DEFAULTS[visibility ?? DEFAULT_RUNTIME_VISIBILITY];
}
