import { useState, useMemo, useCallback } from "react";
import {
  getSlotConfig,
  getCustomPresets,
  type SlotConfigEntry,
  type CustomPreset,
  type PresetSummary,
} from "@/services/api.js";

export interface ResolvedSlot {
  slotId: string;
  presetId: string;
  preset: PresetSummary | null;
  label: string;
}

const SLOT_LABELS: Record<string, string> = {
  default: "默认",
  fast: "快速",
  balance: "均衡",
  image: "图像",
};

/**
 * Hook that reads slot config + custom presets from localStorage,
 * merged with server presets. Call `refresh()` to re-read after
 * SettingsDialog closes.
 */
export function useSlotConfig(serverPresets: PresetSummary[]) {
  const [version, setVersion] = useState(0);

  const refresh = useCallback(() => setVersion((v) => v + 1), []);

  const slotConfig = useMemo(() => {
    void version; // trigger recalc
    return getSlotConfig();
  }, [version]);

  const customPresets = useMemo(() => {
    void version;
    return getCustomPresets();
  }, [version]);

  const allPresets = useMemo(() => {
    const customs: PresetSummary[] = customPresets.map((p) => ({
      id: p.id,
      name: p.name,
      provider: p.provider,
      model: p.model,
      enabled: true,
      isDefault: false,
      scope: "custom",
    }));
    return [...serverPresets, ...customs];
  }, [serverPresets, customPresets]);

  /** Resolve a slot name to a preset (checks user config, falls back to server default). */
  const resolveSlot = useCallback(
    (slotId: string): PresetSummary | null => {
      const entry = slotConfig[slotId];
      if (entry?.presetId) {
        const found = allPresets.find((p) => p.id === entry.presetId);
        if (found) return found;
      }
      return serverPresets.find((p) => p.isDefault) ?? serverPresets[0] ?? null;
    },
    [slotConfig, allPresets, serverPresets],
  );

  /** All configured slot entries as resolved objects. */
  const resolvedSlots = useMemo((): ResolvedSlot[] => {
    const entries = Object.entries(slotConfig);
    if (entries.length === 0) {
      // No user config — synthesize a default slot
      const defaultPreset = serverPresets.find((p) => p.isDefault) ?? serverPresets[0] ?? null;
      return defaultPreset
        ? [{ slotId: "default", presetId: defaultPreset.id, preset: defaultPreset, label: SLOT_LABELS.default }]
        : [];
    }
    return entries.map(([slotId, entry]) => ({
      slotId,
      presetId: entry.presetId,
      preset: allPresets.find((p) => p.id === entry.presetId) ?? null,
      label: SLOT_LABELS[slotId] ?? slotId,
    }));
  }, [slotConfig, allPresets, serverPresets]);

  return { slotConfig, resolvedSlots, allPresets, resolveSlot, refresh };
}
