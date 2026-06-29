import type { ResolvedSlot } from "@/hooks/use-slot-config.js";

export function resolveDeclaredSlot(
  resolvedSlots: readonly ResolvedSlot[],
  slotId: string,
): ResolvedSlot | null {
  if (slotId === "default") return resolvedSlots[0] ?? null;
  return resolvedSlots.find((slot) => slot.slotId === slotId) ?? null;
}

export function isDeclaredSlotMissing(
  resolvedSlots: readonly ResolvedSlot[],
  slotId: string,
): boolean {
  if (slotId === "default") return resolvedSlots.length === 0;
  return !resolvedSlots.some((slot) => slot.slotId === slotId);
}

export interface ProviderSlotState {
  /** The slot the plugin will actually use — player override if set, else manifest default. */
  effectiveSlot: string | undefined;
  /** True when the effective slot is not configured in llm.toml. */
  missing: boolean;
  /** True when a player override is active and differs from the manifest default. */
  isOverridden: boolean;
}

/**
 * Resolve the effective provider slot for a plugin's `modelPresetId` setting.
 *
 * A function-runtime plugin (e.g. image generation) names its provider slot
 * via the `modelPresetId` userSetting. The prep row must reflect the player's
 * *override* of that setting, not just the manifest default — otherwise a
 * player who points the plugin at a slot they actually have configured still
 * sees a red "missing [covel.<manifest-default>]". The effective slot drives
 * the missing check so the warning clears once a configured slot is picked.
 */
export function resolveProviderSlot(args: {
  manifestDefault: string | undefined;
  override: string | undefined;
  isMissing: (slotId: string) => boolean;
}): ProviderSlotState {
  const { manifestDefault, override, isMissing } = args;
  const effectiveSlot = override ?? manifestDefault;
  return {
    effectiveSlot,
    missing: effectiveSlot ? isMissing(effectiveSlot) : false,
    isOverridden: override !== undefined && override !== manifestDefault,
  };
}
