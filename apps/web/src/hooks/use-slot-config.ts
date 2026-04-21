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
  /** Capability tag ("text" | "image") — used for runtime binding compatibility. */
  tag: string;
  /** Server-configured model for this slot (from llm.toml). */
  serverModel?: string;
}

function inferClientSlotTag(slotId: string): string {
  if (slotId === "image") return "image";
  return "text";
}


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

  /**
   * All resolvable slot entries.
   *
   * Union of THREE sources, in priority order:
   *   1. llm.toml `[covel.<slot>]` sections from the server (authoritative
   *      config; includes model/tag/serverModel metadata)
   *   2. SettingsStore `llm.slotConfig` entries that name slots NOT in (1)
   *      — i.e. user-defined slots added through the Settings UI that don't
   *      correspond to any llm.toml section yet
   *   3. If both (1) and (2) are empty, synthesize a single `default` slot
   *      so the UI never renders a completely empty picker when at least one
   *      preset exists
   *
   * Previously only (1) was used when llmConfig.configured was true, which
   * meant user-added slots silently disappeared from binding dropdowns the
   * moment llm.toml was loaded.
   */
  const resolvedSlots = useMemo((): ResolvedSlot[] => {
    const out: ResolvedSlot[] = [];
    const seen = new Set<string>();

    // Source 1: server-defined slots from llm.toml
    if (llmConfig?.configured && llmConfig.slots) {
      for (const [slotId, slotInfo] of Object.entries(llmConfig.slots)) {
        const userEntry = slotConfig[slotId];
        const presetId = userEntry?.presetId ?? "";
        const preset = presetId ? allPresets.find((p) => p.id === presetId) ?? null : null;
        out.push({
          slotId,
          presetId,
          preset,
          label: slotId,
          tag: slotInfo.tag ?? "text",
          serverModel: slotInfo.model,
        });
        seen.add(slotId);
      }
    }

    // Source 2: localStorage-only slots the user defined client-side
    for (const [slotId, entry] of Object.entries(slotConfig)) {
      if (seen.has(slotId)) continue;
      const preset = entry.presetId ? allPresets.find((p) => p.id === entry.presetId) ?? null : null;
        out.push({
          slotId,
          presetId: entry.presetId,
          preset,
          label: slotId,
          tag: inferClientSlotTag(slotId),
          serverModel: preset?.model,
        });
        seen.add(slotId);
    }

    // Source 3: synthesize default when nothing is configured
    if (out.length === 0) {
      const defaultPreset = serverPresets.find((p) => p.isDefault) ?? serverPresets[0] ?? null;
      if (defaultPreset) {
        out.push({
          slotId: "default",
          presetId: defaultPreset.id,
          preset: defaultPreset,
          label: "default",
          tag: inferClientSlotTag("default"),
          serverModel: defaultPreset.model,
        });
      }
    }

    return out;
  }, [slotConfig, allPresets, serverPresets, llmConfig]);

  return { slotConfig, resolvedSlots, allPresets, resolveSlot, refresh };
}
