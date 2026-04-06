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
  /** Direct lookup only — returns undefined if slot not found (no fallback). */
  resolveSlot(slotId: string): string | undefined;
  /** Return all slots matching the given tag. */
  listSlotsByTag(tag: string): ModelSlotConfig[];
  /** Return the tag for a given slot, or undefined if slot not found. */
  getSlotTag(slotId: string): string | undefined;
  getParameterOverrides(slotId: string): ModelParameterOverrides | undefined;
  listSlots(): Record<string, ModelSlotConfig>;
}

/**
 * Create a slot registry that maps named model slots to preset IDs.
 *
 * Tag-aware: slots have tags (e.g., "text", "image").
 * No cross-tag fallback. Direct lookup only.
 */
export function createSlotRegistry(deps: SlotRegistryDeps): SlotRegistry {
  let slotMap: ModelSlotMap = { slots: {} };

  function configure(map: ModelSlotMap): void {
    slotMap = map;
  }

  function resolveSlot(slotId: string): string | undefined {
    const slot = slotMap.slots[slotId];
    if (slot) return slot.presetId;
    return undefined;
  }

  function listSlotsByTag(tag: string): ModelSlotConfig[] {
    return Object.values(slotMap.slots).filter((s) => s.tag === tag);
  }

  function getSlotTag(slotId: string): string | undefined {
    return slotMap.slots[slotId]?.tag;
  }

  function getParameterOverrides(
    slotId: string,
  ): ModelParameterOverrides | undefined {
    return slotMap.slots[slotId]?.parameterOverrides;
  }

  function listSlots(): Record<string, ModelSlotConfig> {
    return { ...slotMap.slots };
  }

  return {
    configure,
    resolveSlot,
    listSlotsByTag,
    getSlotTag,
    getParameterOverrides,
    listSlots,
  };
}
