import type { ResolvedSlot } from "@/hooks/use-slot-config.js";

/**
 * Whether a text model can run now: a text slot that is available and has a
 * key. The world list and the start screen use this one check to decide
 * whether to ask the player to set up a model.
 */
export function isUsableTextSlot(slot: ResolvedSlot): boolean {
  return (
    slot.tag === "text" &&
    slot.isAvailable !== false &&
    slot.hasCredentials === true
  );
}
