import type {
  PackageSummary,
  PresetSummary,
  SlotConfigEntry,
} from "@/services/api.js";
import { slotBindingId } from "@/services/api.js";

const DEFAULT_LLM_SLOT_IDS = [
  "story",
  "plugin",
  "memory",
  "image",
  "fast",
  "balance",
  "default",
] as const;

export interface LlmSlotPresetCandidate {
  readonly id: string;
  readonly provider: string;
  readonly isCustom?: boolean;
}

export function discoverRuntimeSlotIds(
  packages: readonly Pick<PackageSummary, "runtimes" | "userSettings">[],
): string[] {
  const out = new Set<string>();
  for (const pkg of packages) {
    for (const rt of pkg.runtimes ?? []) {
      if (rt.kind === "function") continue;
      const slot = rt.model;
      if (isRuntimeSlotId(slot)) out.add(slot);
    }
    for (const setting of pkg.userSettings ?? []) {
      if (setting.type !== "slot") continue;
      if (isSettingsSlotId(setting.default)) out.add(setting.default);
    }
  }
  return [...out].sort((a, b) => a.localeCompare(b));
}

export function createVisibleSlotIds(args: {
  readonly isConfigured: boolean;
  readonly configuredSlots: readonly string[];
  readonly discoveredSlotIds: readonly string[];
}): string[] {
  const out: string[] = [];
  const add = (slotId: string | undefined) => {
    if (!slotId || slotId === "default" || out.includes(slotId)) return;
    out.push(slotId);
  };
  if (args.isConfigured) {
    args.configuredSlots.forEach(add);
  } else {
    DEFAULT_LLM_SLOT_IDS.forEach(add);
  }
  args.discoveredSlotIds.forEach(add);
  return out;
}

export function autoBindDiscoveredSlots(
  slotConfig: Record<string, SlotConfigEntry>,
  discoveredSlotIds: readonly string[],
  presets: readonly LlmSlotPresetCandidate[],
): Record<string, SlotConfigEntry> {
  const next = { ...slotConfig };
  for (const slotId of discoveredSlotIds) {
    if (slotId === "default" || slotBindingId(next[slotId])) continue;
    const candidate = findAutoBindPreset(slotId, presets);
    if (candidate) {
      next[slotId] = candidate.isCustom
        ? { modelRef: candidate.id }
        : { presetId: candidate.id };
    }
  }
  return next;
}

export function collectLlmSlotPresetCandidates(
  builtInPresets: readonly Pick<
    PresetSummary,
    "id" | "name" | "provider" | "model" | "baseUrl" | "protocol"
  >[],
  customPresets: readonly Pick<
    PresetSummary,
    "id" | "name" | "provider" | "model" | "baseUrl" | "protocol"
  >[],
): Array<
  Pick<
    PresetSummary,
    "id" | "name" | "provider" | "model" | "baseUrl" | "protocol"
  > & {
    readonly isCustom: boolean;
  }
> {
  return [
    ...builtInPresets.map((p) => ({
      id: p.id,
      name: p.name,
      provider: p.provider,
      model: p.model,
      baseUrl: p.baseUrl,
      protocol: p.protocol,
      isCustom: false,
    })),
    ...customPresets.map((p) => ({
      id: p.id,
      name: p.name,
      provider: p.provider,
      model: p.model,
      baseUrl: p.baseUrl,
      protocol: p.protocol,
      isCustom: true,
    })),
  ];
}

function findAutoBindPreset(
  slotId: string,
  presets: readonly LlmSlotPresetCandidate[],
): LlmSlotPresetCandidate | undefined {
  const byName = presets.find(
    (preset) => preset.id === `slot-${slotId}` || preset.id === slotId,
  );
  const byProvider = presets.find((preset) => preset.provider === slotId);
  return byName ?? byProvider;
}

function isRuntimeSlotId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value !== "default" &&
    value !== "text"
  );
}

function isSettingsSlotId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value !== "default";
}
