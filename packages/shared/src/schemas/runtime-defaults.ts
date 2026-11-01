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
 * narrative with longer provider responses, so it gets more time per call
 * and one retry; other agents get the usual task limits.
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
 * merges player interjections; `actor` and `system` do not.
 * `story` and `actor` request submission when a tool loop repeats; `system`
 * fails. Every agent requires complete, accepted output before commit.
 */
export type LoopPresetId = "story" | "actor" | "system";

/** Every loop behaviour a profile sets, with no field left out. */
export interface LoopPresetValues {
  /** Merge queued player interjections into the transcript. */
  readonly steering: boolean;
  /**
   * `submit-output` offers only submit-output for the final result when
   * a tool loop repeats; `fail` stops the runtime with `loop-detected`.
   */
  readonly fallback: "submit-output" | "fail";
  readonly corrections: {
    readonly toolUse: number;
    readonly review: number;
    readonly loopPerturbation: number;
    readonly outputRepair: number;
  };
  readonly finalizer: {
    /** Ask once for the final submission, at the step limit. */
    readonly maxSteps: boolean;
    /**
     * Stop starting steps this many ms before the deadline and ask for the
     * final submission. `0` turns it off.
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
      steering: true,
      fallback: "submit-output",
      finalizer: { maxSteps: true, deadlineReserveMs: 0 },
      corrections: {
        toolUse: 1,
        review: 2,
        loopPerturbation: 1,
        outputRepair: 1,
      },
    }),
    actor: frozenPreset({
      steering: false,
      fallback: "submit-output",
      finalizer: { maxSteps: true, deadlineReserveMs: 0 },
      corrections: {
        toolUse: 1,
        review: 2,
        loopPerturbation: 1,
        outputRepair: 1,
      },
    }),
    system: frozenPreset({
      steering: false,
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
