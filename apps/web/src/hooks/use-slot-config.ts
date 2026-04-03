import { useState, useMemo, useCallback } from "react";
import {
  getSlotConfig,
  getCustomPresets,
  type SlotConfigEntry,
  type CustomPreset,
  type PresetSummary,
  type LlmConfigResponse,
} from "@/services/api.js";

export interface ResolvedSlot {
  slotId: string;
  presetId: string;
  preset: PresetSummary | null;
  /** i18n key like "session.slotDefault" for known slots, raw slotId otherwise. */
  label: string;
  /** Server-configured model for this slot (from llm.toml). */
  serverModel?: string;
}

const SLOT_I18N_KEYS: Record<string, string> = {
  default: "session.slotDefault",
  fast: "session.slotFast",
  balance: "session.slotBalance",
  image: "session.slotImage",
};

/**
 * Hook that reads slot config + custom presets from localStorage,
 * merged with server presets and llm.toml slot definitions.
 * Call `refresh()` to re-read after SettingsDialog closes.
 */
export function useSlotConfig(
  serverPresets: PresetSummary[],
  llmConfig?: LlmConfigResponse | null,
) {
  const [version, setVersion] = useState(0);

  const refresh = useCallback(() => setVersion((v) => v + 1), []);

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- version in deps triggers recalc on refresh()
  const slotConfig = useMemo(() => getSlotConfig(), [version]);

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- version in deps triggers recalc on refresh()
  const customPresets = useMemo(() => getCustomPresets(), [version]);

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
    // Prefer server-defined slots from llm.toml as the source of truth
    if (llmConfig?.configured && llmConfig.slots) {
      const serverSlots = Object.entries(llmConfig.slots);
      return serverSlots.map(([slotId, slotInfo]) => {
        // Check if user has a localStorage override for this slot
        const userEntry = slotConfig[slotId];
        const presetId = userEntry?.presetId ?? "";
        const preset = presetId
          ? allPresets.find((p) => p.id === presetId) ?? null
          : null;

        return {
          slotId,
          presetId,
          preset,
          label: SLOT_I18N_KEYS[slotId] ?? slotId,
          serverModel: slotInfo.model,
        };
      });
    }

    // Fallback: use localStorage slotConfig entries
    const entries = Object.entries(slotConfig);
    if (entries.length === 0) {
      // No user config — synthesize a default slot
      const defaultPreset = serverPresets.find((p) => p.isDefault) ?? serverPresets[0] ?? null;
      return defaultPreset
        ? [{ slotId: "default", presetId: defaultPreset.id, preset: defaultPreset, label: "default" }]
        : [];
    }
    return entries.map(([slotId, entry]) => ({
      slotId,
      presetId: entry.presetId,
      preset: allPresets.find((p) => p.id === entry.presetId) ?? null,
      label: slotId,
    }));
  }, [slotConfig, allPresets, serverPresets, llmConfig]);

  return { slotConfig, resolvedSlots, allPresets, resolveSlot, refresh };
}
