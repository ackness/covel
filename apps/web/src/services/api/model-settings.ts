import { normalizeProviderKeyMap, providerKeyToId } from "@covel/shared";
import { getSettings, registerKnownProviders } from "@/settings/store";

/** Routes that need the provider API keys header. */
const AI_ROUTES = ["/api/actions", "/api/ai/", "/api/kernel/"];

/** `POST /api/sessions/:id/resume` re-enters the LLM tool loop, so it
 * requires provider API keys just like a regular turn (see resume.ts). */
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
    if (!name.startsWith("preset:")) keys[name] = value;
  }
  // Custom preset keys override globals for the same provider.
  for (const preset of getCustomPresets()) {
    if (preset.apiKey?.trim() && preset.provider) {
      keys[preset.provider] = preset.apiKey.trim();
    }
  }
  if (Object.keys(keys).length > 0) {
    headers["X-Provider-Keys"] = btoa(JSON.stringify(keys));
  }
  return headers;
}

function persistCustomPresetKeyToProvider(
  preset: Pick<CustomPreset, "provider" | "apiKey">,
  store: ReturnType<typeof getSettings>,
): void {
  const provider = providerKeyToId(preset.provider) ?? preset.provider.trim();
  const key = preset.apiKey?.trim();
  if (!provider || !key) return;
  // Mirror custom-preset secrets to the provider namespace as well. The
  // `preset:<id>` key is useful client-side, but desktop `keys.env` and the
  // server's startup env map resolve function-runtime slots by provider id
  // (`OPENAI_API_KEY`, `DASHSCOPE_API_KEY`, ...). Without this mirror a
  // custom preset can work only while the request header is present and then
  // fail in background/job paths or after restart with "no apiKey".
  void store.set(`keys.${provider}`, key);
}

/**
 * Build the `X-Plugin-User-Settings` header from SettingsStore entries
 * keyed `plugin.<pluginId>.<setting>`. Groups by plugin id so the server
 * can route each bucket to the matching runtime (audit F7).
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
    "X-Plugin-User-Settings": btoa(JSON.stringify(buckets)),
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

  const slotPresetOverrides = Object.fromEntries(
    Object.entries(slotConfig)
      .filter(
        ([, entry]) =>
          typeof entry?.presetId === "string" && entry.presetId.length > 0,
      )
      .map(([slotId, entry]) => [slotId, entry.presetId]),
  );

  // Only include custom presets the current request can actually resolve.
  // This keeps the header aligned with the fields the server middleware
  // consumes (`slotPresetOverrides` + `customPresets`) and lets direct
  // preset probes include an unbound custom preset by id.
  const customPresets = getCustomPresets();
  const referencedCustomIds = new Set<string>();
  for (const id of Object.values(slotPresetOverrides)) {
    if (id?.startsWith("custom_")) referencedCustomIds.add(id);
  }
  for (const id of options.includeCustomPresetIds ?? []) {
    if (id?.startsWith("custom_")) referencedCustomIds.add(id);
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
  const hasCustom = customPresetDefs.length > 0;
  if (!hasSlotPresetOverrides && !hasParamOverrides && !hasCustom) return {};
  return {
    "X-Slot-Config": btoa(
      JSON.stringify({
        ...(hasSlotPresetOverrides ? { slotPresetOverrides } : {}),
        ...(hasParamOverrides ? { parameterOverrides: paramOverrides } : {}),
        ...(hasCustom ? { customPresets: customPresetDefs } : {}),
      }),
    ),
  };
}

// -- Provider Keys
//
// Routes through the unified SettingsStore. On desktop (Electron IPC or
// REST) secrets go to `keys.env` with mode 600; on pure web they live in
// `covel:keys` localStorage. Callers see a flat `{ provider -> key }` map.

/**
 * Kept for backwards compatibility with `main.tsx`. The real hydration now
 * happens in `initSettings()`; this awaits the store's ready promise.
 */
export async function loadProviderKeysFromStorage(): Promise<void> {
  await (getSettings() as unknown as { ready(): Promise<void> }).ready();
}

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
  presetId: string;
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
}

export function getSlotConfig(): Record<string, SlotConfigEntry> {
  return (
    getSettings().get<Record<string, SlotConfigEntry>>("llm.slotConfig") ?? {}
  );
}

export function setSlotConfig(config: Record<string, SlotConfigEntry>): void {
  void getSettings().set("llm.slotConfig", config);
}

/**
 * Secret channel key used to persist a custom preset's API key. Kept out
 * of `llm.customPresets` so the JSON settings file never records a raw
 * `sk-...` string - the secret lives in keys.env (desktop) or the
 * `covel:keys` localStorage namespace (web) instead.
 */
function presetSecretKey(id: string): string {
  return `keys.preset:${id}`;
}

export function getCustomPresets(): CustomPreset[] {
  const raw = getSettings().get<CustomPreset[]>("llm.customPresets") ?? [];
  const secrets = (
    getSettings() as unknown as { snapshotSecrets(): Record<string, string> }
  ).snapshotSecrets();

  // Legacy migration: any inline `apiKey` left over from an earlier version
  // of this pane gets promoted to the keys channel and stripped from the
  // persisted settings blob on the next setCustomPresets() call below.
  const legacyLeak = raw.some(
    (p) =>
      !!p &&
      typeof p === "object" &&
      typeof p.apiKey === "string" &&
      p.apiKey.length > 0,
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
      const secretFromChannel = secrets[`preset:${preset.id}`];
      const apiKey =
        (secretFromChannel && secretFromChannel.length > 0
          ? secretFromChannel
          : preset.apiKey) ?? undefined;
      return { ...preset, provider, ...(apiKey ? { apiKey } : {}) };
    })
    .filter((preset) => preset.provider.length > 0);

  if (legacyLeak) {
    // Re-persist without inline apiKeys; routes each to the secret channel.
    setCustomPresets(merged);
  }

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

  // Route each API key into the secret channel, then strip it before
  // writing the presets blob so `settings.json` never sees `sk-...`.
  const sanitized = normalized.map((preset) => {
    const { apiKey, ...rest } = preset;
    if (typeof apiKey === "string") {
      const trimmed = apiKey.trim();
      void store.set(presetSecretKey(preset.id), trimmed);
      persistCustomPresetKeyToProvider({ ...preset, apiKey: trimmed }, store);
    }
    return rest;
  });

  void store.set("llm.customPresets", sanitized);
}

export function addCustomPreset(preset: CustomPreset): void {
  setCustomPresets([...getCustomPresets(), preset]);
}

export function removeCustomPreset(id: string): void {
  void getSettings().clear(presetSecretKey(id));
  setCustomPresets(getCustomPresets().filter((p) => p.id !== id));
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

export function getRuntimePriorityOverrides(): Record<string, number> {
  return getSettings().get<Record<string, number>>("llm.runtimePriority") ?? {};
}

export function setRuntimePriorityOverrides(
  overrides: Record<string, number>,
): void {
  void getSettings().set("llm.runtimePriority", overrides);
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
