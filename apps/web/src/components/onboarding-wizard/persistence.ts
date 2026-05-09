import {
  getProviderKeys,
  setProviderKeys,
  getCustomPresets,
  setCustomPresets,
  uid,
  listPresets,
  getSlotConfig,
  setSlotConfig,
} from "@/services/api.js";
import type { CustomPreset, PresetSummary } from "@/services/api.js";
import { invalidatePingResult } from "@/components/shared/ping-button.js";
import { getSettings } from "@/settings/store";
import { CUSTOM_PROVIDER_ID, ONBOARDING_VERSION } from "./constants.js";
import { providerOptionLabel } from "./provider-state.js";
import type { ProviderFormState, SlotName } from "./types.js";

export function isOnboarded(): boolean {
  const stored = getSettings().get<number>("ui.onboardedVersion");
  return typeof stored === "number" && stored >= ONBOARDING_VERSION;
}

export function markOnboarded(): void {
  void getSettings().set("ui.onboardedVersion", ONBOARDING_VERSION);
}

/** Force the onboarding wizard to appear again on next mount. Used by Settings "re-run tutorial". */
export function resetOnboarding(): void {
  void getSettings().clear("ui.onboardedVersion");
}

/**
 * Drop stale cached Ping results when the form inputs change — otherwise a
 * green badge from a previous URL/key combination can linger and mislead.
 */
export function clearCachedPing(slotName: SlotName): void {
  invalidatePingResult({ kind: "slot", slotId: slotName });
}

function findReusableCustomPreset(
  expected: Pick<CustomPreset, "provider" | "model" | "baseUrl" | "protocol">,
): CustomPreset | undefined {
  return getCustomPresets().find(
    (preset) =>
      preset.provider === expected.provider &&
      preset.model === expected.model &&
      (preset.baseUrl ?? "") === (expected.baseUrl ?? "") &&
      (preset.protocol ?? "") === (expected.protocol ?? ""),
  );
}

function upsertTransientPreset(input: Omit<CustomPreset, "id">): string {
  const existing = findReusableCustomPreset(input);
  if (existing) return existing.id;

  const nextPreset: CustomPreset = {
    ...input,
    id: `custom_${uid()}`,
  };
  setCustomPresets([...getCustomPresets(), nextPreset]);
  return nextPreset.id;
}

/**
 * Persist an API key + slot binding.
 *
 * For built-in providers we bind the slot to the exact provider/model pair.
 * Existing presets are reused; arbitrary model IDs synthesize a local preset.
 * For custom providers we register a local custom preset and point the
 * slot at that. Returns the resolved preset ID, or undefined if no match
 * could be found (e.g. built-in provider with no server-side preset yet).
 */
export async function persistSlot(
  form: ProviderFormState,
  slotName: SlotName,
  presetCatalog: PresetSummary[],
): Promise<string | undefined> {
  const key = form.apiKey.trim();
  if (!key) return undefined;

  const isCustom = form.selected === CUSTOM_PROVIDER_ID;

  if (isCustom) {
    const provName = form.customProviderName.trim() || "custom";
    const existingKeys = getProviderKeys();
    setProviderKeys({ ...existingKeys, [provName]: key });

    const presetId = upsertTransientPreset({
      name: `${provName} — ${form.customModel || "default"}`,
      provider: provName,
      baseUrl: form.customBaseUrl.trim(),
      model: form.customModel.trim() || "default",
      protocol: "openai-chat-v1",
      apiKey: key,
    });
    const slots = getSlotConfig();
    setSlotConfig({ ...slots, [slotName]: { presetId } });
    return presetId;
  }

  const existingKeys = getProviderKeys();
  setProviderKeys({ ...existingKeys, [form.selected]: key });
  const desiredModel = form.builtInModel.trim();
  if (!desiredModel) return undefined;

  try {
    const presets =
      presetCatalog.length > 0 ? presetCatalog : await listPresets();
    const match = presets.find(
      (p) =>
        p.provider === form.selected && p.enabled && p.model === desiredModel,
    );
    if (match) {
      const slots = getSlotConfig();
      setSlotConfig({ ...slots, [slotName]: { presetId: match.id } });
      return match.id;
    }

    const presetId = upsertTransientPreset({
      name: `${providerOptionLabel(form.selected)} — ${desiredModel}`,
      provider: form.selected,
      model: desiredModel,
      baseUrl: "",
      apiKey: key,
    });
    const slots = getSlotConfig();
    setSlotConfig({ ...slots, [slotName]: { presetId } });
    return presetId;
  } catch {
    // Network hiccup — leave slot config untouched so the ping probe
    // surfaces the real problem to the user.
  }
  return undefined;
}

export function bindPluginSlotToStory(): void {
  const slots = getSlotConfig();
  if (!slots.plugin && slots.story) {
    setSlotConfig({ ...slots, plugin: slots.story });
  }
}

export function persistPluginModeSame(): void {
  const slots = getSlotConfig();
  if (slots.story) {
    setSlotConfig({ ...slots, plugin: slots.story });
    return;
  }

  const { plugin: _drop, ...rest } = slots;
  setSlotConfig(rest);
}
