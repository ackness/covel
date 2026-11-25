import type { InputSlot } from "@covel/shared";
import { deepFreeze } from "../utils/deep-freeze.js";

/** Clone before freezing so hooks/tools cannot mutate upstream runtime output. */
export function freezeInputSlots(
  inputs: Readonly<Record<string, InputSlot>>,
): Readonly<Record<string, InputSlot>> {
  return deepFreeze(structuredClone(inputs));
}
