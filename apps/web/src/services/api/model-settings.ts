import { normalizeProviderKeyMap, providerKeyToId } from "@covel/shared";
import { isServerManagedSecret } from "@covel/settings";
import { getSettings, registerKnownProviders } from "@/settings/store";
import {
  flattenProviderProfiles,
  profilesFromLegacyPresets,
  type ProviderModelProfile,
} from "./provider-model-profiles.js";

/** Routes that need the provider API keys header. */
const AI_ROUTES = ["/api/actions", "/api/ai/", "/api/kernel/"];

/** `POST /api/sessions/:id/resume` re-enters the LLM tool loop. Browser
 * callers attach their request-scoped keys; desktop may use server keys. */
const RESUME_ROUTE_REGEX = /^\/api\/sessions\/[^/]+\/resume(?:\?|$)/;

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

export function buildProviderKeysHeader(): Record<string, string> {
  const headers: Record<string, string> = {};
  // Pull every secret the store knows about (registered or not). The
  // `preset:<id>` namespace is only meaningful client-side - strip it
  // before building the provider-keyed header the server expects.
  const allSecrets = (
    getSettings() as unknown as {
      snapshotSecrets(): Record<string, string>;
    }
  ).snapshotSecrets();
  const keys: Record<string, string> = {};
  for (const [name, value] of Object.entries(allSecrets)) {
    if (!name.startsWith("preset:") && !isServerManagedSecret(value)) {
      keys[name] = value;
    }
  }
  // Custom preset keys override globals for the same provider.
  for (const preset of getCustomPresets()) {
    if (preset.apiKey?.trim() && preset.provider) {
      keys[preset.provider] = preset.apiKey.trim();
    }
  }
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
function buildPluginUserSettingsHeader(): Record<string, string> {
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
    "X-Plugin-User-Settings": encodeBase64Json(buckets),
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
    .map(({ id, name, provider, baseUrl, model, protocol }) => ({
      id,
      name,
      provider,
      baseUrl,
      model,
      protocol,
    }));

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
// All of these used to live in individual `covel:*` localStorage keys. They
// are now thin wrappers over the unified SettingsStore. The API shape below
// is preserved so existing call sites keep compiling.

export interface SlotConfigEntry {
  /** Legacy/server model plan binding. */
  presetId?: string;
  /** Provider-first model reference used by new settings. */
  modelRef?: string;
}

export function slotBindingId(
  entry: SlotConfigEntry | null | undefined,
): string | undefined {
  return entry?.modelRef ?? entry?.presetId;
}

export interface CustomPreset {
  id: string;
  name: string;
  provider: string;
  baseUrl: string;
  model: string;
  protocol?: string;
  apiKey?: string;
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
  const config =
    getSettings().get<Record<string, SlotConfigEntry>>("llm.slotConfig") ?? {};
  const customIds = new Set(getCustomPresets().map((preset) => preset.id));
  let migrated = false;
  const next = Object.fromEntries(
    Object.entries(config).map(([slotId, entry]) => {
      if (entry.modelRef || !entry.presetId || !customIds.has(entry.presetId)) {
        return [slotId, entry];
      }
      migrated = true;
      return [slotId, { modelRef: entry.presetId }];
    }),
  );
  if (migrated) void getSettings().set("llm.slotConfig", next);
  return next;
}

export function setSlotConfig(config: Record<string, SlotConfigEntry>): void {
  void getSettings().set("llm.slotConfig", config);
}

function legacyPresetState(): {
  presets: CustomPreset[];
  present: boolean;
  valid: boolean;
} {
  const store = getSettings();
  const present = store.has("llm.customPresets");
  const raw = store.get<unknown>("llm.customPresets");
  if (!present) return { presets: [], present: false, valid: true };
  if (!Array.isArray(raw)) return { presets: [], present: true, valid: false };

  const presets: CustomPreset[] = [];
  for (const value of raw) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { presets: [], present: true, valid: false };
    }
    const preset = value as Record<string, unknown>;
    if (
      typeof preset.id !== "string" ||
      typeof preset.name !== "string" ||
      typeof preset.provider !== "string" ||
      typeof preset.model !== "string" ||
      (preset.baseUrl !== undefined && typeof preset.baseUrl !== "string") ||
      (preset.protocol !== undefined && typeof preset.protocol !== "string") ||
      (preset.apiKey !== undefined && typeof preset.apiKey !== "string")
    ) {
      return { presets: [], present: true, valid: false };
    }
    presets.push({
      id: preset.id,
      name: preset.name,
      provider: preset.provider,
      baseUrl: typeof preset.baseUrl === "string" ? preset.baseUrl : "",
      model: preset.model,
      ...(typeof preset.protocol === "string"
        ? { protocol: preset.protocol }
        : {}),
      ...(typeof preset.apiKey === "string" ? { apiKey: preset.apiKey } : {}),
    });
  }
  return { presets, present: true, valid: true };
}

function rawLegacyPresets(): CustomPreset[] {
  return legacyPresetState().presets;
}

let providerProfileMigration: Promise<void> | null = null;

function secretSnapshot(
  store: ReturnType<typeof getSettings>,
): Record<string, string> {
  return (
    store as unknown as { snapshotSecrets(): Record<string, string> }
  ).snapshotSecrets();
}

function profileProviderId(profile: ProviderModelProfile): string {
  return (
    providerKeyToId(profile.provider ?? profile.id) ??
    (profile.provider ?? profile.id).trim()
  );
}

/** Persist connection-scoped keys, mirroring only the provider namespace. */
async function persistProfileSecrets(
  profiles: readonly ProviderModelProfile[],
  presets: readonly CustomPreset[],
  store: ReturnType<typeof getSettings>,
): Promise<Set<string>> {
  const legacyByRef = new Map(presets.map((preset) => [preset.id, preset]));
  const confirmed = new Set<string>();
  for (const profile of profiles) {
    const profileId = profile.id.trim();
    if (!profileId) continue;
    let secrets = secretSnapshot(store);
    let key: string | undefined = secrets[profileId]?.trim();
    if (!key) {
      // Preserve the old "last model key wins" rule for shared connections.
      key = profile.models.reduce<string | undefined>(
        (selected, model) =>
          secrets[`preset:${model.ref}`]?.trim() ||
          legacyByRef.get(model.ref)?.apiKey?.trim() ||
          selected,
        undefined,
      );
      const provider = profileProviderId(profile);
      key ||= secrets[provider]?.trim();
      if (key) await store.set(`keys.${profileId}`, key);
    }
    secrets = secretSnapshot(store);
    if (key && secrets[profileId]?.trim() === key) {
      confirmed.add(profileId);
      const provider = profileProviderId(profile);
      if (!secrets[provider]?.trim()) await store.set(`keys.${provider}`, key);
    }
  }
  return confirmed;
}

/**
 * One-way migration from legacy custom presets to provider-first profiles.
 * Call only after `initSettings()`; getters deliberately have no writes.
 */
export async function migrateLegacyProviderProfiles(): Promise<void> {
  if (providerProfileMigration) return providerProfileMigration;
  providerProfileMigration = (async () => {
    const store = getSettings();
    const existing =
      store
        .get<ProviderModelProfile[]>("llm.providers")
        ?.filter(
          (profile) => profile && typeof profile === "object" && profile.id,
        ) ?? [];
    const legacyState = legacyPresetState();
    if (!legacyState.valid) {
      console.warn(
        "[settings] legacy llm.customPresets is invalid; preserving it for manual recovery",
      );
      return;
    }
    const legacy = legacyState.presets;
    if (legacy.length === 0 && existing.length === 0) return;
    const profiles = existing.length
      ? existing
      : profilesFromLegacyPresets(legacy);
    if (profiles.length === 0) return;

    registerKnownProviders(
      profiles.flatMap((profile) => [profile.id, profileProviderId(profile)]),
    );
    const confirmed = await persistProfileSecrets(profiles, legacy, store);
    const refs = new Set(
      profiles.flatMap((profile) => profile.models.map((model) => model.ref)),
    );
    const fullyCovered = legacy.every((preset) => refs.has(preset.id));
    if (!fullyCovered) return;

    if (!existing.length) await store.set("llm.providers", profiles);
    // Clear legacy settings only after canonical providers and destinations
    // have been confirmed. Unmigrated preset secrets remain available.
    if (legacyState.present) await store.clear("llm.customPresets");
    const after = secretSnapshot(store);
    await Promise.all(
      [...confirmed].flatMap((profileId) => {
        const profile = profiles.find(
          (candidate) => candidate.id === profileId,
        );
        return (
          profile?.models
            .filter((model) => after[profileId]?.trim())
            .map((model) => store.clear(`keys.preset:${model.ref}`)) ?? []
        );
      }),
    );
  })().catch((error: unknown) => {
    providerProfileMigration = null;
    console.warn("[settings] legacy provider migration failed:", error);
  });
  return providerProfileMigration;
}

export function getProviderProfiles(): ProviderModelProfile[] {
  const store = getSettings();
  const stored =
    store
      .get<ProviderModelProfile[]>("llm.providers")
      ?.filter(
        (profile) => profile && typeof profile === "object" && profile.id,
      ) ?? [];
  if (stored.length > 0) {
    registerKnownProviders(
      stored.flatMap((profile) => [
        profile.id,
        profile.provider?.trim() || profile.id,
      ]),
    );
    return stored;
  }

  const legacy = rawLegacyPresets();
  const migrated = profilesFromLegacyPresets(legacy);
  if (migrated.length > 0) {
    registerKnownProviders(
      migrated.flatMap((profile) => [
        profile.id,
        profile.provider?.trim() || profile.id,
      ]),
    );
  }
  return migrated;
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
  const secrets = (
    store as unknown as { snapshotSecrets(): Record<string, string> }
  ).snapshotSecrets();
  for (const secretName of Object.keys(secrets)) {
    if (
      secretName.startsWith("preset:") &&
      !validModelRefs.has(secretName.slice("preset:".length))
    ) {
      void store.clear(`keys.${secretName}`);
    }
  }
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

export function getCustomPresets(): CustomPreset[] {
  const profiles = getProviderProfiles();
  const hasCanonicalProfiles =
    (getSettings().get<ProviderModelProfile[]>("llm.providers")?.length ?? 0) >
    0;
  const raw = hasCanonicalProfiles
    ? (flattenProviderProfiles(profiles) as CustomPreset[])
    : rawLegacyPresets();
  const secrets = (
    getSettings() as unknown as { snapshotSecrets(): Record<string, string> }
  ).snapshotSecrets();
  const providerFallbackByModelRef = new Map(
    profiles.flatMap((profile) =>
      profile.models.map(
        (model) => [model.ref, profile.provider?.trim() || profile.id] as const,
      ),
    ),
  );

  const merged = raw
    .filter(
      (preset): preset is CustomPreset =>
        !!preset && typeof preset === "object",
    )
    .map((preset) => {
      const provider =
        providerKeyToId(preset.provider) ??
        String(preset.provider ?? "").trim();
      const secretFromConnection = secrets[provider];
      const secretFromChannel = secrets[`preset:${preset.id}`];
      const providerFallback = providerFallbackByModelRef.get(preset.id);
      const secretFromProvider = providerFallback
        ? secrets[providerFallback]
        : undefined;
      const apiKey =
        (secretFromConnection && secretFromConnection.length > 0
          ? secretFromConnection
          : secretFromChannel && secretFromChannel.length > 0
            ? secretFromChannel
            : secretFromProvider && secretFromProvider.length > 0
              ? secretFromProvider
              : preset.apiKey) ?? undefined;
      return { ...preset, provider, ...(apiKey ? { apiKey } : {}) };
    })
    .filter((preset) => preset.provider.length > 0);

  return merged;
}

export function setCustomPresets(presets: CustomPreset[]): void {
  const normalized = presets
    .map((preset) => ({
      ...preset,
      provider: providerKeyToId(preset.provider) ?? preset.provider.trim(),
    }))
    .filter((preset) => preset.provider.length > 0);

  const store = getSettings();

  const profiles = profilesFromLegacyPresets(normalized);
  // Persist the canonical value first, then serialize its secret writes behind
  // that settings snapshot to avoid competing full-snapshot saves.
  void store
    .set("llm.providers", profiles)
    .then(() => persistProfileSecrets(profiles, normalized, store))
    .catch((error: unknown) => {
      console.warn("[settings] provider profile write failed:", error);
    });
  registerKnownProviders(
    profiles.flatMap((profile) => [profile.id, profileProviderId(profile)]),
  );
}

export function addCustomPreset(preset: CustomPreset): void {
  setCustomPresets([...getCustomPresets(), preset]);
}

export function removeCustomPreset(id: string): void {
  const profiles = getProviderProfiles();
  const profile = profiles.find((candidate) =>
    candidate.models.some((model) => model.ref === id),
  );
  if (profile && profile.models.length === 1)
    void getSettings().clear(`keys.${profile.id}`);
  setProviderProfiles(
    profiles.map((candidate) => ({
      ...candidate,
      models: candidate.models.filter((model) => model.ref !== id),
    })),
  );
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
