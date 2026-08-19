import type {
  ModelParameterOverrides,
  ReasoningEffort,
  ReasoningEffortProfile,
  SlotConfigEntry,
} from "@/services/api.js";
import { slotBindingId } from "@/services/api.js";

export function isReasoningEffortOverrideValid(
  profile: ReasoningEffortProfile | null | undefined,
  override: ReasoningEffort | undefined,
): boolean {
  if (override === undefined || profile === undefined) return true;
  return profile?.options.some((option) => option.value === override) ?? false;
}

export function clearReasoningEffortOverride(
  overrides: Record<string, ModelParameterOverrides>,
  slotId: string,
): Record<string, ModelParameterOverrides> {
  const current = overrides[slotId];
  if (current?.reasoningEffort === undefined) return overrides;
  const nextSlot = { ...current };
  delete nextSlot.reasoningEffort;
  const next = { ...overrides };
  if (Object.keys(nextSlot).length === 0) delete next[slotId];
  else next[slotId] = nextSlot;
  return next;
}

export function clearChangedSlotReasoningEfforts(
  previousSlots: Record<string, SlotConfigEntry>,
  nextSlots: Record<string, SlotConfigEntry>,
  overrides: Record<string, ModelParameterOverrides>,
): Record<string, ModelParameterOverrides> {
  const slotIds = new Set([
    ...Object.keys(previousSlots),
    ...Object.keys(nextSlots),
  ]);
  let nextOverrides = overrides;
  for (const slotId of slotIds) {
    if (
      slotBindingId(previousSlots[slotId]) !== slotBindingId(nextSlots[slotId])
    ) {
      nextOverrides = clearReasoningEffortOverride(nextOverrides, slotId);
    }
  }
  return nextOverrides;
}

export function pruneInvalidReasoningEffortOverride(
  overrides: Record<string, ModelParameterOverrides>,
  slotId: string,
  profile: ReasoningEffortProfile | null | undefined,
): Record<string, ModelParameterOverrides> {
  const override = overrides[slotId]?.reasoningEffort;
  return isReasoningEffortOverrideValid(profile, override)
    ? overrides
    : clearReasoningEffortOverride(overrides, slotId);
}
