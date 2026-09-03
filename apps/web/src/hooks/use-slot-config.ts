import { useState, useMemo, useCallback } from "react";
import { useSetting } from "@/settings/use-settings.js";
import {
  getSlotConfig,
  getCustomPresets,
  slotBindingId,
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
  /** Server-configured provider for this slot (from llm.toml). */
  serverProvider?: string;
}

/** Return the model that requests for this slot will use on this client. */
export function effectiveSlotModel(
  slot: ResolvedSlot | null | undefined,
): string | undefined {
  return slot?.preset?.model ?? slot?.serverModel;
}

/** Format a runtime-binding option as `<slot> · <effective model>`. */
export function formatSlotBindingLabel(slot: ResolvedSlot): string {
  const model = effectiveSlotModel(slot);
  return model ? `${slot.slotId} · ${model}` : slot.slotId;
}

function inferClientSlotTag(slotId: string): string {
  if (slotId === "image") return "image";
  return "text";
}

/**
 * Format a slot for compact display as `<provider> · <model>`. Prefers
 * the resolved preset (user's current selection), then the server-side
 * llm.toml model, and finally just the slot id so the caller always
 * gets something back.
 */
export function formatSlotLabel(
  slot: ResolvedSlot | null | undefined,
): string | null {
  if (!slot) return null;
  if (slot.preset) {
    return `${slot.preset.provider} \u00B7 ${slot.preset.model}`;
  }
  if (slot.serverModel) {
    return `${slot.slotId} \u00B7 ${slot.serverModel}`;
  }
  return slot.slotId;
}

/**
 * Hook that reactively reads slot config + custom presets from SettingsStore,
 * merged with server presets and llm.toml slot definitions. `refresh()` is
 * retained for close-time invalidation, before an async persistence event has
 * reached SettingsStore subscribers.
 */
export function useSlotConfig(
  serverPresets: PresetSummary[],
  llmConfig?: LlmConfigResponse | null,
) {
  const [version, setVersion] = useState(0);
  const [slotConfigSnapshot] =
    useSetting<Record<string, SlotConfigEntry>>("llm.slotConfig");
  const [providerProfilesSnapshot] = useSetting<unknown>("llm.providers");
  const [legacyPresetsSnapshot] = useSetting<unknown>("llm.customPresets");

  const refresh = useCallback(() => setVersion((v) => v + 1), []);

  const slotConfig = useMemo(
    () => getSlotConfig(),
    [slotConfigSnapshot, version],
  );

  const customPresets = useMemo(
    () => getCustomPresets(),
    [providerProfilesSnapshot, legacyPresetsSnapshot, version],
  );

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
      const bindingId = slotBindingId(entry);
      if (bindingId) {
        const found = allPresets.find((p) => p.id === bindingId);
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
        const presetId = slotBindingId(userEntry) ?? "";
        const preset = presetId
          ? (allPresets.find((p) => p.id === presetId) ?? null)
          : null;
        out.push({
          slotId,
          presetId,
          preset,
          label: slotId,
          tag: slotInfo.tag ?? "text",
          serverModel: slotInfo.model,
          serverProvider: slotInfo.provider,
        });
        seen.add(slotId);
      }
    }

    // Source 2: localStorage-only slots the user defined client-side
    for (const [slotId, entry] of Object.entries(slotConfig)) {
      if (seen.has(slotId)) continue;
      const presetId = slotBindingId(entry) ?? "";
      const preset = presetId
        ? (allPresets.find((p) => p.id === presetId) ?? null)
        : null;
      out.push({
        slotId,
        presetId,
        preset,
        label: slotId,
        tag: inferClientSlotTag(slotId),
        serverModel: preset?.model,
        serverProvider: preset?.provider,
      });
      seen.add(slotId);
    }

    // Source 3: synthesize default when nothing is configured
    if (out.length === 0) {
      const defaultPreset =
        serverPresets.find((p) => p.isDefault) ?? serverPresets[0] ?? null;
      if (defaultPreset) {
        out.push({
          slotId: "default",
          presetId: defaultPreset.id,
          preset: defaultPreset,
          label: "default",
          tag: inferClientSlotTag("default"),
          serverModel: defaultPreset.model,
          serverProvider: defaultPreset.provider,
        });
      }
    }

    return out;
  }, [slotConfig, allPresets, serverPresets, llmConfig]);

  return { slotConfig, resolvedSlots, allPresets, resolveSlot, refresh };
}
