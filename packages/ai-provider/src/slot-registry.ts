import type {
  ModelParameterOverrides,
  ModelSlotConfig,
  ModelSlotMap,
} from "./types.js";

export interface SlotRegistryDeps {
  presetRegistry: {
    resolvePreset(presetId?: string): { id: string } | null;
    listPresets(): Array<{ id: string; enabled: boolean }>;
  };
}

export interface SlotRegistry {
  configure(slotMap: ModelSlotMap): void;
  resolveSlot(slotId: string): string | undefined;
  getParameterOverrides(slotId: string): ModelParameterOverrides | undefined;
  listSlots(): Record<string, ModelSlotConfig>;
}

/**
 * Create a slot registry that maps named model slots to preset IDs.
 *
 * Fallback chain: requested slot -> "default" slot -> first available preset.
 */
export function createSlotRegistry(deps: SlotRegistryDeps): SlotRegistry {
  let slotMap: ModelSlotMap = { slots: {}, defaultSlot: "default" };

  function configure(map: ModelSlotMap): void {
    slotMap = map;
  }

  function resolveSlot(slotId: string): string | undefined {
    const slot = slotMap.slots[slotId];
    if (slot) return slot.presetId;

    if (slotId !== slotMap.defaultSlot) {
      const fallback = slotMap.slots[slotMap.defaultSlot];
      if (fallback) return fallback.presetId;
    }

    // Last resort: first available preset
    const presets = deps.presetRegistry.listPresets();
    const first = presets.find((p) => p.enabled);
    return first?.id;
  }

  function getParameterOverrides(
    slotId: string
  ): ModelParameterOverrides | undefined {
    return slotMap.slots[slotId]?.parameterOverrides;
  }

  function listSlots(): Record<string, ModelSlotConfig> {
    return { ...slotMap.slots };
  }

  return { configure, resolveSlot, getParameterOverrides, listSlots };
}
