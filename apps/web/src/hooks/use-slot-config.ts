import { isRoleModelCompatible, modelRoleTag } from "@/lib/model-role.js";
import { useModelCapabilities } from "./use-model-capabilities.js";
import { formatModelConfigLabel } from "@/lib/model-config-label.js";
import { useState, useMemo, useCallback } from "react";
import { useSetting } from "@/settings/use-settings.js";
import {
  getSlotConfig,
  getCustomPresets,
  slotBindingId,
  type SlotConfigEntry,
  type ModelParameterOverrides,
  type PresetSummary,
  type LlmConfigResponse,
} from "@/services/api.js";

export interface ResolvedSlot {
  slotId: string;
  presetId: string;
  preset: PresetSummary | null;
  /** i18n key like "session.slotDefault" for known slots, raw slotId otherwise. */
  label: string;
  /** Whether the effective binding exists and supports the role. */
  isAvailable?: boolean;
  /** Capability tag used for runtime binding compatibility. */
  tag: string;
  /** Server-configured model for this slot (from llm.toml). */
  serverModel?: string;
  /** Server-configured provider for this slot (from llm.toml). */
  serverProvider?: string;
  /** Effective saved selection after role overrides; undefined leaves task policy in control. */
  reasoningEffort?: ModelParameterOverrides["reasoningEffort"];
}

/** Return the model that requests for this slot will use on this client. */
export function effectiveSlotModel(
  slot: ResolvedSlot | null | undefined,
): string | undefined {
  return slot?.preset?.model ?? slot?.serverModel;
}

/** Format a runtime-binding option as `<slot> · <effective model>`. */
export function formatSlotBindingLabel(slot: ResolvedSlot): string {
  const model = formatSlotModelLabel(slot);
  return model ? `${slot.slotId} · ${model}` : slot.slotId;
}

/** Configuration name and effective saved reasoning, without changing the API ID. */
export function formatSlotModelLabel(slot: ResolvedSlot): string | undefined {
  const model = effectiveSlotModel(slot);
  return model
    ? formatModelConfigLabel({
        ...slot.preset,
        model,
        reasoningEffort: slot.reasoningEffort ?? slot.preset?.reasoningEffort,
      })
    : undefined;
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
    return `${slot.preset.provider} \u00B7 ${formatSlotModelLabel(slot)}`;
  }
  if (slot.serverModel) {
    return `${slot.slotId} \u00B7 ${formatSlotModelLabel(slot)}`;
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
  const [capabilityOverrides] = useSetting<
    Record<string, { output?: string[] }>
  >("llm.capabilityOverrides");
  const roleModel = (model: PresetSummary, slotId: string) => ({
    ...model,
    ...(capabilityOverrides?.[slotId]?.output
      ? { capability: { output: capabilityOverrides[slotId].output! } }
      : {}),
  });
  const roleCompatible = (model: PresetSummary, tag: string, slotId: string) =>
    isRoleModelCompatible(roleModel(model, slotId), tag);
  const [parameterOverrides] =
    useSetting<Record<string, ModelParameterOverrides>>("llm.paramOverrides");

  const refresh = useCallback(() => setVersion((v) => v + 1), []);

  const slotConfig = useMemo(
    () => getSlotConfig(),
    [slotConfigSnapshot, version],
  );

  const customPresets = useMemo(
    () => getCustomPresets(),
    [providerProfilesSnapshot, version],
  );

  const unresolvedLocalPresets = useMemo(() => {
    return customPresets.map((p): PresetSummary => ({
      id: p.id,
      name: p.name,
      provider: p.provider,
      model: p.model,
      baseUrl: p.baseUrl,
      reasoningEffort: p.reasoningEffort,
      protocol: p.protocol,
      enabled: true,
      isDefault: false,
      scope: "custom",
    }));
  }, [customPresets]);
  const localPresets = useModelCapabilities(unresolvedLocalPresets);
  const allPresets = useMemo(
    () => [...serverPresets, ...localPresets],
    [serverPresets, localPresets],
  );
  const findBinding = useCallback(
    (entry: (typeof slotConfig)[string] | undefined) => {
      return entry?.modelRef !== undefined
        ? localPresets.find((p) => p.id === entry.modelRef)
        : serverPresets.find((p) => p.id === entry?.presetId);
    },
    [localPresets, serverPresets],
  );

  /** Resolve a slot name to a preset (checks user config, falls back to server default). */
  const resolveSlot = useCallback(
    (slotId: string): PresetSummary | null => {
      const entry = slotConfig[slotId];
      const bindingId = slotBindingId(entry);
      if (bindingId) {
        return findBinding(entry) ?? null;
      }
      return (
        serverPresets.find(
          (p) => p.slotBindings?.includes(slotId) || p.id === `slot-${slotId}`,
        ) ??
        serverPresets.find((p) => p.isDefault) ??
        serverPresets[0] ??
        null
      );
    },
    [slotConfig, findBinding, serverPresets],
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
        const preset = presetId ? (findBinding(userEntry) ?? null) : null;
        out.push({
          slotId,
          presetId,
          preset,
          label: slotId,
          tag: modelRoleTag(slotId, slotInfo.tag, preset ?? slotInfo),
          isAvailable:
            !presetId ||
            (!!preset &&
              roleCompatible(
                preset,
                modelRoleTag(slotId, slotInfo.tag, slotInfo),
                slotId,
              )),
          serverModel: presetId && !preset ? undefined : slotInfo.model,
          serverProvider: presetId && !preset ? undefined : slotInfo.provider,
        });
        seen.add(slotId);
      }
    }

    // Source 2: localStorage-only slots the user defined client-side
    for (const [slotId, entry] of Object.entries(slotConfig)) {
      if (seen.has(slotId)) continue;
      const presetId = slotBindingId(entry) ?? "";
      const preset = presetId ? (findBinding(entry) ?? null) : null;
      out.push({
        slotId,
        presetId,
        preset,
        label: slotId,
        tag: modelRoleTag(
          slotId,
          undefined,
          preset ? roleModel(preset, slotId) : undefined,
        ),
        isAvailable:
          !!preset &&
          roleCompatible(
            preset,
            modelRoleTag(slotId, undefined, roleModel(preset, slotId)),
            slotId,
          ),
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
          tag: modelRoleTag("default"),
          isAvailable: isRoleModelCompatible(defaultPreset, "text"),
          serverModel: defaultPreset.model,
          serverProvider: defaultPreset.provider,
        });
      }
    }

    return out.map((slot) => ({
      ...slot,
      reasoningEffort:
        parameterOverrides?.[slot.slotId]?.reasoningEffort ??
        slot.preset?.reasoningEffort ??
        slot.preset?.parameterOverrides?.reasoningEffort ??
        (slot.preset || slot.presetId
          ? undefined
          : llmConfig?.slots[slot.slotId]?.parameterOverrides?.reasoningEffort),
    }));
  }, [
    slotConfig,
    findBinding,
    serverPresets,
    llmConfig,
    parameterOverrides,
    capabilityOverrides,
  ]);

  return { slotConfig, resolvedSlots, allPresets, resolveSlot, refresh };
}
