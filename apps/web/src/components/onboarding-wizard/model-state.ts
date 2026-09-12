import type { ResolvedSlot } from "@/hooks/use-slot-config.js";

/** A binding is not proof of connectivity; probes remain explicit user actions. */
export function configuredTextSlots(
  slots: readonly ResolvedSlot[],
): ResolvedSlot[] {
  return slots.filter(
    (slot) =>
      slot.tag === "text" &&
      (slot.presetId
        ? slot.preset?.enabled === true && !!slot.preset.model.trim()
        : !!slot.serverModel?.trim()),
  );
}
