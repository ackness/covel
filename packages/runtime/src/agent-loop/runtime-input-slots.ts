import type { InputSlot } from "@covel/shared";

/** Clone before freezing so hooks/tools cannot mutate upstream runtime output. */
export function freezeInputSlots(
  inputs: Readonly<Record<string, InputSlot>>,
): Readonly<Record<string, InputSlot>> {
  const copy = structuredClone(inputs);
  const freeze = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  };
  freeze(copy);
  return copy;
}
