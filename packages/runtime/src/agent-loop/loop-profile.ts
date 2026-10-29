/**
 * The agent loop's behaviour as data: a resolved loop profile.
 *
 * The loop reads streaming, steering, truncation, the tool-loop fallback and
 * the finalizer from here, never from `outputKind`. A runtime gets the preset
 * it names in `agent.loop.profile`, or the one of its visibility (`story` for
 * a story, `system` otherwise), with the author's overrides merged field by
 * field. The preset values live in `LOOP_PRESETS` (`@covel/shared`), the one
 * table the manifest rules also read.
 */

import {
  defaultLoopPreset,
  LOOP_PRESETS,
  type LoopPresetId,
  type LoopPresetValues,
  type RuntimeManifest,
} from "@covel/shared";

export { LOOP_PRESETS, type LoopPresetId };

/** A loop profile with every field set. */
export interface ResolvedLoopProfile extends LoopPresetValues {
  /** The preset the overrides were merged over. */
  readonly preset: LoopPresetId;
  /**
   * Derived from `outputKind`, never authored: which answer the loop asks
   * for when it takes the tools away. `story` asks for the narrative and
   * corrects a `runtime-done` that came without one; `answer` asks for the
   * final answer in the required output format.
   */
  readonly answerPrompt: "story" | "answer";
}

/** Resolve a runtime's loop profile. Pure and deterministic. */
export function resolveLoopProfile(
  manifest: Pick<RuntimeManifest, "outputKind" | "loopProfile">,
): ResolvedLoopProfile {
  const story = manifest.outputKind === "story";
  const spec = manifest.loopProfile;
  const preset = spec?.preset ?? defaultLoopPreset(manifest.outputKind);
  const base = LOOP_PRESETS[preset];
  return {
    preset,
    stream: spec?.stream ?? base.stream,
    steering: spec?.steering ?? base.steering,
    truncation: spec?.truncation ?? base.truncation,
    fallback: spec?.fallback ?? base.fallback,
    finalizer: {
      maxSteps: spec?.finalizer?.maxSteps ?? base.finalizer.maxSteps,
      deadlineReserveMs:
        spec?.finalizer?.deadlineReserveMs ?? base.finalizer.deadlineReserveMs,
    },
    corrections: {
      toolUse: spec?.corrections?.toolUse ?? base.corrections.toolUse,
      review: spec?.corrections?.review ?? base.corrections.review,
      loopPerturbation:
        spec?.corrections?.loopPerturbation ??
        base.corrections.loopPerturbation,
      outputRepair:
        spec?.corrections?.outputRepair ?? base.corrections.outputRepair,
    },
    answerPrompt: story ? "story" : "answer",
  };
}
