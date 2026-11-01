/**
 * The agent loop's behaviour as data: a resolved loop profile.
 *
 * The loop reads steering, the tool-loop fallback and
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
}

/** Resolve a runtime's loop profile. Pure and deterministic. */
export function resolveLoopProfile(
  manifest: Pick<RuntimeManifest, "outputKind" | "loopProfile">,
): ResolvedLoopProfile {
  const spec = manifest.loopProfile;
  const preset = spec?.preset ?? defaultLoopPreset(manifest.outputKind);
  const base = LOOP_PRESETS[preset];
  return {
    preset,
    steering: spec?.steering ?? base.steering,
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
  };
}
