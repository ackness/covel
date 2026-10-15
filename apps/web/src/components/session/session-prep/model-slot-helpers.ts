import type { ResolvedSlot } from "@/hooks/use-slot-config.js";

export function resolveDeclaredSlot(
  resolvedSlots: readonly ResolvedSlot[],
  slotId: string,
): ResolvedSlot | null {
  const slot =
    slotId === "default"
      ? resolvedSlots[0]
      : resolvedSlots.find((slot) => slot.slotId === slotId);
  return slot?.isAvailable === false ? null : (slot ?? null);
}

/**
 * The text slot a runtime's declared slot resolves to. A slot that is not set
 * up at all falls back to the first text slot, as the server does (same-tag
 * fallback, `docs/reference/slots.md`); a slot that is set up but cannot be
 * used does not.
 */
export function resolveTextRuntimeSlot(
  resolvedSlots: readonly ResolvedSlot[],
  slotId: string,
): { readonly slot: ResolvedSlot; readonly fallback: boolean } | null {
  const textSlots = resolvedSlots.filter((slot) => slot.tag === "text");
  const declared = resolveDeclaredSlot(textSlots, slotId);
  if (declared) return { slot: declared, fallback: false };
  if (
    slotId === "default" ||
    resolvedSlots.some((slot) => slot.slotId === slotId)
  )
    return null;
  const first = textSlots.find((slot) => slot.isAvailable !== false);
  return first ? { slot: first, fallback: true } : null;
}

export function isDeclaredSlotMissing(
  resolvedSlots: readonly ResolvedSlot[],
  slotId: string,
): boolean {
  return resolveDeclaredSlot(resolvedSlots, slotId) === null;
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
