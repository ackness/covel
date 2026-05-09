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
