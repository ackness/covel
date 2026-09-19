import { normalizeProviderKeyMap, providerKeyToId } from "@covel/shared";
import {
  PLUGIN_USER_SETTINGS_HEADER_MAX_BYTES,
  PLUGIN_USER_SETTINGS_HEADER_TOO_LARGE_CODE,
  utf8ByteLength,
} from "@covel/shared/plugin-user-settings-header";
import { isServerManagedSecret } from "@covel/settings";
import { getSettings, registerKnownProviders } from "@/settings/store";
import {
  flattenProviderProfiles,
  type CustomPreset,
  type ProviderModelProfile,
} from "./provider-model-profiles.js";

/** Routes that need the provider API keys header. */
const AI_ROUTES = ["/api/actions", "/api/ai/", "/api/kernel/"];

/** A suspension resume request re-enters the LLM tool loop. Browser
 * callers attach their request-scoped keys; desktop may use server keys. */
const RESUME_ROUTE_REGEX =
  /^\/api\/sessions\/[^/]+\/suspensions\/[^/]+\/resume(?:\?|$)/;

/** `POST /api/sessions/:id/plugin-rpc` runs the manual-trigger pipeline,
 * which may invoke LLM / image generation via the plugin runtime gateway
 * and needs both provider keys and player-authored plugin settings. */
const PLUGIN_RPC_ROUTE_REGEX = /^\/api\/sessions\/[^/]+\/plugin-rpc(?:\?|$)/;

export function needsProviderKeys(url: string): boolean {
  if (AI_ROUTES.some((prefix) => url.startsWith(prefix))) return true;
  if (RESUME_ROUTE_REGEX.test(url)) return true;
  return PLUGIN_RPC_ROUTE_REGEX.test(url);
}

/** `btoa` chokes on any codepoint above U+00FF, so a Chinese preset name or a
 * CJK plugin setting would throw inside the header builder and take down every
 * AI request with a misleading transport error. Encode to UTF-8 bytes first —
 * that is also what the server assumes (`Buffer.from(h, "base64").toString("utf8")`).
 * Chunked because `String.fromCharCode(...bytes)` overflows the call stack on
 * large payloads. */
export function encodeBase64Json(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export class PluginUserSettingsHeaderTooLargeError extends Error {
  readonly code = PLUGIN_USER_SETTINGS_HEADER_TOO_LARGE_CODE;

  constructor() {
    super("X-Plugin-User-Settings exceeds 8 KiB");
    this.name = "PluginUserSettingsHeaderTooLargeError";
  }
}

/** Encode and preflight the same quota enforced by the server. */
export function encodePluginUserSettingsHeader(value: unknown): string {
  const encoded = encodeBase64Json(value);
  if (utf8ByteLength(encoded) > PLUGIN_USER_SETTINGS_HEADER_MAX_BYTES) {
    throw new PluginUserSettingsHeaderTooLargeError();
  }
  return encoded;
}

export function buildProviderKeysHeader(): Record<string, string> {
  const headers: Record<string, string> = {};
  // Request keys are connection-scoped and never embedded in model profiles.
  const keys = Object.fromEntries(
    Object.entries(providerKeysSnapshot()).filter(
      ([name, value]) =>
        providerKeyToId(name) === name && !isServerManagedSecret(value),
    ),
  );
  if (Object.keys(keys).length > 0) {
    headers["X-Provider-Keys"] = encodeBase64Json(keys);
  }
  return headers;
}

/**
 * Build the `X-Plugin-User-Settings` header from SettingsStore entries
 * keyed `plugin.<pluginId>.<setting>`. Groups by plugin id so the server
 * can route each bucket to the matching runtime.
 *
 * Only carries settings the player has **explicitly set** (`store.has(key)`).
 * `listEntries()` returns every registered plugin setting (registered at boot
 * for all plugins) and `store.get()` would return the manifest default for an
 * untouched key — sending that as a "player override" would mask the world's
 * `pluginSettings` default at the server merge boundary (player → world →
 * manifest). Filtering by `has()` keeps the header to genuine overrides, so the
 * world default survives for keys the player never touched. Returns an empty
 * object when the player hasn't explicitly saved any plugin-scoped setting.
 */
export function buildPluginUserSettingsHeader(): Record<string, string> {
  const store = getSettings() as unknown as {
    listEntries(): readonly { key: string }[];
    get<T>(key: string): T;
    has(key: string): boolean;
  };
  const buckets: Record<string, Record<string, unknown>> = {};
  for (const entry of store.listEntries()) {
    if (!entry.key.startsWith("plugin.")) continue;
    if (!store.has(entry.key)) continue; // explicit player overrides only
    const parts = entry.key.split(".");
    if (parts.length < 3) continue;
    const pluginId = parts[1];
    const settingKey = parts.slice(2).join(".");
    const value = store.get<unknown>(entry.key);
    (buckets[pluginId] ??= {})[settingKey] = value;
  }
  if (Object.keys(buckets).length === 0) return {};
  return {
    "X-Plugin-User-Settings": encodePluginUserSettingsHeader(buckets),
  };
}

export function buildAiHeaders(): Record<string, string> {
  return {
    ...buildProviderKeysHeader(),
    ...buildSlotConfigHeaderInternal(),
    ...buildPluginUserSettingsHeader(),
  };
}

interface SlotConfigHeaderOptions {
  includeCustomPresetIds?: readonly string[];
}

export function buildSlotConfigHeaderInternal(
  options: SlotConfigHeaderOptions = {},
): Record<string, string> {
  const slotConfig = getSlotConfig();
  const paramOverrides = getParamOverrides();
  const rawCapabilityOverrides =
    getSettings().get<
      Record<
        string,
        {
          input?: string[];
          output?: string[];
          features?: string[];
          contextWindow?: number;
          maxOutputTokens?: number;
        }
      >
    >("llm.capabilityOverrides") ?? {};
  // Pricing stays a client-side display preference. Only operational model
  // facts cross the untrusted X-Slot-Config boundary.
  const capabilityOverrides = Object.fromEntries(
    Object.entries(rawCapabilityOverrides)
      .map(([slotId, override]) => {
        const operational = {
          ...(override.input ? { input: override.input } : {}),
          ...(override.output ? { output: override.output } : {}),
          ...(override.features ? { features: override.features } : {}),
          ...(override.contextWindow !== undefined
            ? { contextWindow: override.contextWindow }
            : {}),
          ...(override.maxOutputTokens !== undefined
            ? { maxOutputTokens: override.maxOutputTokens }
            : {}),
        };
        return [slotId, operational] as const;
      })
      .filter(([, override]) => Object.keys(override).length > 0),
  );

  const slotPresetOverrides = Object.fromEntries(
    Object.entries(slotConfig)
      .map(([slotId, entry]) => [slotId, slotBindingId(entry)] as const)
      .filter((entry): entry is readonly [string, string] => !!entry[1]),
  );

  // Only include custom presets the current request can actually resolve.
  // This keeps the header aligned with the fields the server middleware
  // consumes (`slotPresetOverrides` + `customPresets`) and lets direct
  // preset probes include an unbound custom preset by id.
  const customPresets = getCustomPresets();
  const customPresetIds = new Set(customPresets.map((preset) => preset.id));
  const referencedCustomIds = new Set<string>();
  for (const id of Object.values(slotPresetOverrides)) {
    if (customPresetIds.has(id)) referencedCustomIds.add(id);
  }
  for (const id of options.includeCustomPresetIds ?? []) {
    if (customPresetIds.has(id)) referencedCustomIds.add(id);
  }
  const customPresetDefs = customPresets
    .filter((p) => referencedCustomIds.has(p.id))
    .map(
      ({ id, name, provider, baseUrl, model, protocol, reasoningEffort }) => ({
        ...(reasoningEffort ? { reasoningEffort } : {}),
        id,
        name,
        provider,
        baseUrl,
        model,
        protocol,
      }),
    );

  const hasSlotPresetOverrides = Object.keys(slotPresetOverrides).length > 0;
  const hasParamOverrides = Object.keys(paramOverrides).length > 0;
  const hasCapabilityOverrides = Object.keys(capabilityOverrides).length > 0;
  const hasCustom = customPresetDefs.length > 0;
  if (
    !hasSlotPresetOverrides &&
    !hasParamOverrides &&
    !hasCapabilityOverrides &&
    !hasCustom
  )
    return {};
  return {
    "X-Slot-Config": encodeBase64Json({
      ...(hasSlotPresetOverrides ? { slotPresetOverrides } : {}),
      ...(hasParamOverrides ? { parameterOverrides: paramOverrides } : {}),
      ...(hasCapabilityOverrides ? { capabilityOverrides } : {}),
      ...(hasCustom ? { customPresets: customPresetDefs } : {}),
    }),
  };
}

// -- Provider Keys
//
// Routes through the unified SettingsStore. On desktop (Electron IPC or
// REST) secrets go to `keys.env` with mode 600; on pure web they live in
// `covel:keys` localStorage. Callers see a flat `{ provider -> key }` map.

function providerKeysSnapshot(): Record<string, string> {
  const store = getSettings() as unknown as {
    snapshotSecrets(): Record<string, string>;
  };
  return store.snapshotSecrets();
}

export function getProviderKeys(): Record<string, string> {
  return normalizeProviderKeyMap(providerKeysSnapshot());
}

export function setProviderKeys(keys: Record<string, string>): void {
  void setProviderKeysAsync(keys);
}

/** Promise-returning variant for call sites that want to report success. */
export async function setProviderKeysAsync(
  keys: Record<string, string>,
): Promise<{ ok: boolean }> {
  const normalized = normalizeProviderKeyMap(keys);
  const store = getSettings();
  // Ensure every provider has a registered entry so the Settings UI
  // surfaces it immediately after the first call.
  registerKnownProviders(Object.keys(normalized));
  // Clear any providers no longer present.
  const existing = providerKeysSnapshot();
  try {
    await Promise.all([
      ...Object.entries(normalized).map(([provider, value]) =>
        store.set(`keys.${provider}`, value),
      ),
      ...Object.keys(existing)
        .filter((p) => !(p in normalized))
        .map((p) => store.clear(`keys.${p}`)),
    ]);
    return { ok: true };
  } catch (err) {
    console.warn("[api] setProviderKeysAsync failed:", err);
    return { ok: false };
  }
}

// -- Slot / Preset / Parameter / Runtime-priority config -------
//
// Stored model roles select either a server preset or a local model reference.

export type SlotConfigEntry =
  | { modelRef: string; presetId?: never }
  | { presetId: string; modelRef?: never };

export function slotBindingId(
  entry: SlotConfigEntry | null | undefined,
): string | undefined {
  return entry?.modelRef ?? entry?.presetId;
}

export interface ModelParameterOverrides {
  temperature?: number;
  topP?: number;
  maxOutputTokens?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  reasoningEffort?: import("./llm.js").ReasoningEffort;
}

export function getSlotConfig(): Record<string, SlotConfigEntry> {
  return (
    getSettings().get<Record<string, SlotConfigEntry>>("llm.slotConfig") ?? {}
  );
}

export function setSlotConfig(config: Record<string, SlotConfigEntry>): void {
  void getSettings().set("llm.slotConfig", config);
}

export function getProviderProfiles(): ProviderModelProfile[] {
  const profiles =
    getSettings().get<ProviderModelProfile[]>("llm.providers") ?? [];
  registerKnownProviders(profiles.map((profile) => profile.id));
  return profiles;
}

export function setProviderProfiles(profiles: ProviderModelProfile[]): void {
  const store = getSettings();
  const previous =
    store.get<ProviderModelProfile[]>("llm.providers")?.filter(Boolean) ?? [];
  const normalized = profiles
    .map((profile) => ({
      ...profile,
      id: providerKeyToId(profile.id) ?? profile.id.trim(),
      ...(profile.provider?.trim()
        ? {
            provider:
              providerKeyToId(profile.provider) ?? profile.provider.trim(),
          }
        : {}),
      name: profile.name.trim() || profile.id.trim(),
      baseUrl: profile.baseUrl.trim(),
      models: profile.models
        .map((model) => ({
          ...model,
          ref: model.ref.trim(),
          modelId: model.modelId.trim(),
          ...(model.name?.trim() ? { name: model.name.trim() } : {}),
        }))
        .filter((model) => model.ref && model.modelId),
    }))
    .filter((profile) => profile.id && profile.models.length > 0);
  registerKnownProviders(
    normalized.flatMap((profile) => [
      profile.id,
      profile.provider?.trim() || profile.id,
    ]),
  );
  void store.set("llm.providers", normalized);

  const retainedProfileIds = new Set(normalized.map((profile) => profile.id));
  for (const profile of previous) {
    if (!retainedProfileIds.has(profile.id)) {
      void store.clear(`keys.${profile.id}`);
    }
  }

  const validModelRefs = new Set(
    normalized.flatMap((profile) => profile.models.map((model) => model.ref)),
  );
  const slotConfig =
    store.get<Record<string, SlotConfigEntry>>("llm.slotConfig") ?? {};
  const prunedSlotConfig = Object.fromEntries(
    Object.entries(slotConfig).filter(
      ([, entry]) => !entry.modelRef || validModelRefs.has(entry.modelRef),
    ),
  );
  if (Object.keys(prunedSlotConfig).length !== Object.keys(slotConfig).length) {
    void store.set("llm.slotConfig", prunedSlotConfig);
  }
}

export function getProviderPriceMultipliers(): Record<string, number> {
  const raw =
    getSettings().get<Record<string, number>>("llm.providerPriceMultipliers") ??
    {};
  return Object.fromEntries(
    Object.entries(raw).flatMap(([provider, value]) => {
      const id = providerKeyToId(provider);
      return id && Number.isFinite(value) && value > 0 ? [[id, value]] : [];
    }),
  );
}

export function getProviderPriceMultiplier(provider?: string): number {
  if (!provider) return 1;
  const id = providerKeyToId(provider);
  return (id && getProviderPriceMultipliers()[id]) || 1;
}

export function setProviderPriceMultipliers(
  multipliers: Record<string, number>,
): void {
  const normalized = Object.fromEntries(
    Object.entries(multipliers).flatMap(([provider, value]) => {
      const id = providerKeyToId(provider);
      return id && Number.isFinite(value) && value > 0 ? [[id, value]] : [];
    }),
  );
  void getSettings().set("llm.providerPriceMultipliers", normalized);
}

/** Compile the current provider profiles for model pickers and request overlays. */
export function getCustomPresets(): CustomPreset[] {
  return flattenProviderProfiles(getProviderProfiles());
}

export function getParamOverrides(): Record<string, ModelParameterOverrides> {
  return (
    getSettings().get<Record<string, ModelParameterOverrides>>(
      "llm.paramOverrides",
    ) ?? {}
  );
}

export function setParamOverrides(
  overrides: Record<string, ModelParameterOverrides>,
): void {
  void getSettings().set("llm.paramOverrides", overrides);
}

/**
 * Prep-phase runtime bindings (pre-session), keyed by worldId. Wiped by the
 * caller once the real session is created and the bindings are copied onto
 * the SessionRecord.
 */
export function getPrepRuntimeBindings(
  worldId: string,
): Record<string, string> {
  const all =
    getSettings().get<Record<string, Record<string, string>>>(
      "llm.prepRuntimeBindings",
    ) ?? {};
  return all[worldId] ?? {};
}

export function setPrepRuntimeBindings(
  worldId: string,
  bindings: Record<string, string>,
): void {
  const store = getSettings();
  const all =
    store.get<Record<string, Record<string, string>>>(
      "llm.prepRuntimeBindings",
    ) ?? {};
  void store.set("llm.prepRuntimeBindings", { ...all, [worldId]: bindings });
}

export function clearPrepRuntimeBindings(worldId: string): void {
  const store = getSettings();
  const all =
    store.get<Record<string, Record<string, string>>>(
      "llm.prepRuntimeBindings",
    ) ?? {};
  if (!(worldId in all)) return;
  const next = { ...all };
  delete next[worldId];
  void store.set("llm.prepRuntimeBindings", next);
}
