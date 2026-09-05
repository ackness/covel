import {
  toJsonValueOrDiagnostic,
  type InputSlot,
  type RuntimeManifest,
  type RuntimeResult,
} from "@covel/shared";

/** Project declared legacy runtime injects onto the same typed tool/hook view. */
export function agentInputSlots(
  manifest: RuntimeManifest,
  completedResults: ReadonlyMap<string, RuntimeResult>,
  inputs?: Readonly<Record<string, InputSlot>>,
): Readonly<Record<string, InputSlot>> {
  const slots: Record<string, InputSlot> = {};
  for (const inject of manifest.input?.inject ?? []) {
    if (inject.kind !== "runtime") continue;
    const result = completedResults.get(inject.from);
    const value = result?.output?.[inject.field];
    if (!result || value === undefined || value === null) continue;
    slots[inject.as.replace(/^<|>$/g, "")] = {
      cardinality: "one",
      value: toJsonValueOrDiagnostic(value),
      source: {
        pluginId: result.pluginId,
        runtimeId: result.runtimeId,
        resultId: result.runId,
      },
    };
  }
  return freezeInputSlots({ ...slots, ...inputs });
}

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
