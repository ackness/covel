import type { SlotRegistry } from "@covel/ai-provider";
import type { SlotTag } from "@covel/shared";
import type { RuntimeBindingMap, BindingResolution, RuntimeBindingInfo } from "./types.js";

/**
 * Resolve a runtime's model binding.
 *
 * 1. Look up the runtime's slot in the binding map
 * 2. Resolve the slot to a preset ID via the slot registry
 * 3. Validate tag compatibility (cross-tag = reject)
 *
 * Returns null if: no binding, slot not found, or tag mismatch.
 */
export function resolveRuntimeBinding(
  runtimeId: string,
  providerTag: SlotTag,
  bindings: RuntimeBindingMap,
  slotRegistry: SlotRegistry,
): BindingResolution | null {
  const slotName = bindings[runtimeId];
  if (!slotName) return null;

  const presetId = slotRegistry.resolveSlot(slotName);
  if (!presetId) return null;

  const slotTag = slotRegistry.getSlotTag(slotName);
  if (slotTag !== providerTag) return null;

  return { presetId, slotName };
}

/**
 * Generate default runtime bindings by assigning the first compatible slot
 * (by tag) to each runtime.
 *
 * Runtimes with no compatible slot are omitted from the result.
 */
export function generateDefaultBindings(
  runtimes: RuntimeBindingInfo[],
  slotRegistry: SlotRegistry,
): RuntimeBindingMap {
  const bindings: RuntimeBindingMap = {};

  for (const rt of runtimes) {
    const compatible = slotRegistry.listSlotsByTag(rt.providerTag);
    if (compatible.length > 0) {
      bindings[rt.qualifiedId] = compatible[0].slotId;
    }
  }

  return bindings;
}
