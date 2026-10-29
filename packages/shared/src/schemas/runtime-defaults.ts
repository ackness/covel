/**
 * Defaults of an authored runtime (RUNTIME.md or the inline `runtime` of a
 * PLUGIN.md) for the fields most manifests would otherwise repeat. The loader
 * applies them when it compiles a runtime, `validate:plugin` warns about a
 * field written with its default, and the generated reference states them,
 * all from these values.
 */

/** `io.visibility` of a runtime that does not write one. */
export const DEFAULT_RUNTIME_VISIBILITY = "system";

/**
 * PLUGIN.md `entry` of a package that writes none: this file, relative to the
 * package root, when it exists.
 */
export const DEFAULT_PLUGIN_ENTRY = "./server/index.js";

/**
 * `function.handler` of a function runtime that writes none: this file next
 * to the manifest that declares the runtime, when it exists.
 */
export const DEFAULT_FUNCTION_HANDLER = "./handler.js";

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

/**
 * The built-in agent loop profiles (`agent.loop.profile`). A `story` loop
 * streams its text to the player, merges the player's interjections and keeps
 * a reply cut at the output limit; `actor` and `system` do none of that.
 * `story` and `actor` continue without tools when a tool loop repeats;
 * `system` fails.
 */
export type LoopPresetId = "story" | "actor" | "system";

/** Every loop behaviour a profile sets, with no field left out. */
export interface LoopPresetValues {
  /** Forward the model's text deltas to the player's narrative feed. */
  readonly stream: boolean;
  /** Merge queued player interjections into the transcript. */
  readonly steering: boolean;
  /** `accept` keeps a reply cut at the output limit; `reject` fails it. */
  readonly truncation: "accept" | "reject";
  /**
   * `answer-without-tools` takes the tools away and asks for the answer when
   * a tool loop repeats; `fail` stops the runtime with `loop-detected`.
   */
  readonly fallback: "answer-without-tools" | "fail";
  readonly corrections: {
    readonly toolUse: number;
    readonly review: number;
    readonly loopPerturbation: number;
    readonly outputRepair: number;
  };
  readonly finalizer: {
    /** Ask once for the answer, tools off, at the step limit. */
    readonly maxSteps: boolean;
    /**
     * Stop starting steps this many ms before the deadline and ask for the
     * answer, tools off. `0` turns it off.
     */
    readonly deadlineReserveMs: number;
  };
}

function frozenPreset(values: LoopPresetValues): LoopPresetValues {
  return Object.freeze({
    ...values,
    finalizer: Object.freeze({ ...values.finalizer }),
    corrections: Object.freeze({ ...values.corrections }),
  });
}

/** The values of each built-in loop profile. */
export const LOOP_PRESETS: Readonly<Record<LoopPresetId, LoopPresetValues>> =
  Object.freeze({
    story: frozenPreset({
      stream: true,
      steering: true,
      truncation: "accept",
      fallback: "answer-without-tools",
      finalizer: { maxSteps: true, deadlineReserveMs: 0 },
      corrections: {
        toolUse: 1,
        review: 2,
        loopPerturbation: 1,
        outputRepair: 1,
      },
    }),
    actor: frozenPreset({
      stream: false,
      steering: false,
      truncation: "reject",
      fallback: "answer-without-tools",
      finalizer: { maxSteps: true, deadlineReserveMs: 0 },
      corrections: {
        toolUse: 1,
        review: 2,
        loopPerturbation: 1,
        outputRepair: 1,
      },
    }),
    system: frozenPreset({
      stream: false,
      steering: false,
      truncation: "reject",
      fallback: "fail",
      finalizer: { maxSteps: true, deadlineReserveMs: 0 },
      corrections: {
        toolUse: 1,
        review: 2,
        loopPerturbation: 1,
        outputRepair: 1,
      },
    }),
  });

/** The loop profile of an agent that names none: the one of its visibility. */
export function defaultLoopPreset(
  visibility: RuntimeVisibility | undefined,
): LoopPresetId {
  return visibility === "story" ? "story" : "system";
}
