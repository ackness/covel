/**
 * API client for communicating with the Covel server.
 */

import type {
  I18nText,
  RuntimeResult,
  SessionEvent,
  SessionStatus,
} from "@covel/shared";
import { normalizeProviderKeyMap, providerKeyToId } from "@covel/shared";
import { getSettings, registerKnownProviders } from "@/settings/store";
import { emitToast } from "@/lib/toast-channel";
export { getDesktopRestToken } from "@/lib/desktop-bridge";
import i18n from "@/i18n";

// ── Types ──────────────────────────────────────────────────────────

export interface WorldRecord {
  id: string;
  name: I18nText;
  description: I18nText;
  lore?: I18nText;
  locale?: string;
  tags?: string[];
  dimensions?: import("@covel/shared").WorldDimensions;
  /** World metadata, including storage/source labels used by the world list. */
  metadata?: { source?: string; [key: string]: unknown };
  createdAt: string;
  updatedAt?: string;
}

export type GeneratedWorldSaveTarget =
  | "server-file"
  | "server-store"
  | "return-only";

export type { SessionStatus };

export interface SessionRecord {
  id: string;
  worldId: string;
  status: SessionStatus;
  turnCount: number;
  /** Runtime IDs whose Pre-Game (band 0-99) runs have completed. */
  preGameCompleted?: readonly string[];
  activePlugins?: readonly string[];
  presetId?: string;
  taskBindings?: Record<string, string>;
  runtimeModelOverrides?: Record<string, string>;
  createdAt: string;
}

export interface MessageRecord {
  id: string;
  sessionId: string;
  role: "system" | "user" | "assistant";
  content: string;
  turnId?: string;
  runtimeId?: string;
  /** Runtime kind (e.g. "story", "plugin") — used to filter display on restore. */
  kind?: string;
  block?: Record<string, unknown>;
  createdAt: string;
}

export interface StatePatchRecord {
  id: string;
  sessionId: string;
  summary: string;
  packageName: string;
  data?: unknown;
  createdAt: string;
}

export interface PresetSummary {
  id: string;
  name: string;
  provider: string;
  model: string;
  enabled: boolean;
  isDefault: boolean;
  scope: string;
  /** Effective baseUrl (preset override → provider default). Undefined if provider not registered. */
  baseUrl?: string;
  /** Effective protocol (openai-chat/anthropic/...). Undefined if unresolvable. */
  protocol?: string;
  /** Slot IDs whose presetId resolves here (e.g. ["default","fast"]). */
  slotBindings?: string[];
}

export interface RuntimeSummary {
  id: string;
  kind: string;
  priority: number;
  trigger: {
    mode: string;
    onEvents?: string[];
    interval?: number;
    cooldownTurns?: number;
    maxTriggerCount?: number;
    startTurn?: number;
    topic?: string;
    condition?: string;
    maxRetryCount?: number;
  };
  /** Slot declared by PLUGIN.md `model` (e.g. story/plugin/image). */
  model?: string;
  /** Back-compat alias used by runtime binding UI; same as `model` when present. */
  providerTag?: string;
  outputKind?: string;
  capabilities?: string[];
}

export interface ToolSummary {
  id: string;
  kind: string;
}

export interface PackageSummary {
  name: string;
  displayName?: string | Record<string, string>;
  description?: string | Record<string, string>;
  pluginType?: string;
  source?: "builtin" | "official" | "community";
  enabled: boolean;
  runtimes?: RuntimeSummary[];
  tools?: ToolSummary[];
  requires?: string[];
  version?: string;
  author?: string;
  /** User-editable settings declared in PLUGIN.md frontmatter. */
  userSettings?: Array<{
    key: string;
    type: "text" | "number" | "toggle" | "select" | "textarea";
    default: unknown;
    label: string | Record<string, string>;
    description?: string | Record<string, string>;
    min?: number;
    max?: number;
    step?: number;
    options?: Array<{ value: string; label: string | Record<string, string> }>;
  }>;
}

export type WorldDataPreflightDiagnosticLevel = "info" | "warning" | "error";

export interface WorldDataPreflightDiagnostic {
  level: WorldDataPreflightDiagnosticLevel;
  sourceId?: string;
  path?: string;
  schema?: string;
  pointer?: string;
  message: string;
}

export interface WorldDataPreflightTarget {
  kind: "plugin-data" | "lorebook" | "character" | "media-index" | string;
  target: string;
  sourceId: string;
  pluginId?: string;
  namespace?: string;
  key?: string;
}

export interface WorldDataPreflightResponse {
  imported: boolean;
  diagnostics: WorldDataPreflightDiagnostic[];
  planned: number;
  targets: WorldDataPreflightTarget[];
}

export interface CommandSummary {
  name: string;
  pluginId: string;
  description: string;
  usage?: string;
  examples?: string[];
  positionalHints?: string[];
  flagHints?: Record<string, string>;
}

export interface SseEnvelope {
  type: string;
  requestId: string;
  traceId: string;
  sessionId: string;
  turnId: string;
  flowId: string;
  seq: number;
  timestamp: string;
  payload: Record<string, unknown>;
}

// ── Helpers ────────────────────────────────────────────────────────

/** Routes that need the provider API keys header. */
const AI_ROUTES = ["/api/actions", "/api/ai/", "/api/kernel/"];

/** `POST /api/sessions/:id/resume` re-enters the LLM tool loop, so it
 * requires provider API keys just like a regular turn (see resume.ts). */
const RESUME_ROUTE_REGEX = /^\/api\/sessions\/[^/]+\/resume(?:\?|$)/;

/** `POST /api/sessions/:id/plugin-rpc` runs the manual-trigger pipeline,
 * which may invoke LLM / image generation via the plugin runtime gateway
 * and needs both provider keys and player-authored plugin settings. */
const PLUGIN_RPC_ROUTE_REGEX = /^\/api\/sessions\/[^/]+\/plugin-rpc(?:\?|$)/;

function needsProviderKeys(url: string): boolean {
  if (AI_ROUTES.some((prefix) => url.startsWith(prefix))) return true;
  if (RESUME_ROUTE_REGEX.test(url)) return true;
  return PLUGIN_RPC_ROUTE_REGEX.test(url);
}

function buildProviderKeysHeader(): Record<string, string> {
  const headers: Record<string, string> = {};
  // Pull every secret the store knows about (registered or not). The
  // `preset:<id>` namespace is only meaningful client-side — strip it
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
 * can route each bucket to the matching runtime (audit F7). Returns an
 * empty object when the player hasn't saved any plugin-scoped settings —
 * the server falls back to manifest defaults in that case.
 */
function buildPluginUserSettingsHeader(): Record<string, string> {
  const store = getSettings() as unknown as {
    listEntries(): readonly { key: string }[];
    get<T>(key: string): T;
  };
  const buckets: Record<string, Record<string, unknown>> = {};
  for (const entry of store.listEntries()) {
    if (!entry.key.startsWith("plugin.")) continue;
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

function buildAiHeaders(): Record<string, string> {
  return {
    ...buildProviderKeysHeader(),
    ...buildSlotConfigHeaderInternal(),
    ...buildPluginUserSettingsHeader(),
  };
}

interface SlotConfigHeaderOptions {
  includeCustomPresetIds?: readonly string[];
}

function buildSlotConfigHeaderInternal(
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

/** Options for the internal `request` fetch wrapper. */
interface RequestOptions extends RequestInit {
  /**
   * Suppress the global error toast for this request. Use for probe-style
   * calls where a non-2xx response is part of normal operation (e.g. auth
   * polling or optional capability checks).
   */
  silentErrors?: boolean;
}

/**
 * Emit a user-visible toast for an HTTP failure. Split out so `request()`
 * stays focused on transport concerns.
 */
function emitHttpErrorToast(url: string, status: number, body: string): void {
  const shortTitle = i18n.t("toast.errorTitle", {
    defaultValue: "Something went wrong",
  }) as string;
  // Detail keeps enough context for the player to paste into a bug report.
  const detail = `${status} ${url}${body ? `\n${body.slice(0, 800)}` : ""}`;
  emitToast("error", shortTitle, detail);
}

function emitNetworkErrorToast(url: string, err: unknown): void {
  const short = i18n.t("toast.networkError", {
    defaultValue: "Network error — check your connection",
  }) as string;
  const detail = `${url}\n${err instanceof Error ? err.message : String(err)}`;
  emitToast("error", short, detail);
}

async function request<T>(url: string, init?: RequestOptions): Promise<T> {
  const { silentErrors, ...fetchInit } = init ?? {};
  let res: Response;
  try {
    res = await fetch(url, {
      ...fetchInit,
      headers: {
        "Content-Type": "application/json",
        ...(needsProviderKeys(url) ? buildAiHeaders() : {}),
        ...fetchInit.headers,
      },
    });
  } catch (err) {
    // Transport-level failure (offline, DNS, CORS preflight). These never
    // reach `res.ok`, so surface them explicitly unless the caller opted out.
    if (!silentErrors) emitNetworkErrorToast(url, err);
    throw err;
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    if (!silentErrors) emitHttpErrorToast(url, res.status, text);
    throw new Error(`API ${res.status}: ${text}`);
  }
  return res.json();
}

// ── World API ──────────────────────────────────────────────────────

/** Map server WorldRecord (metadata.dimensions) to frontend WorldRecord (top-level dimensions). */
function mapWorldRecord(w: Record<string, unknown>): WorldRecord {
  const meta = w.metadata as Record<string, unknown> | undefined;
  return {
    ...w,
    dimensions: (w.dimensions ?? meta?.dimensions) as WorldRecord["dimensions"],
  } as WorldRecord;
}

export async function listWorlds(): Promise<WorldRecord[]> {
  const res = await request<
    { items: Record<string, unknown>[] } | Record<string, unknown>[]
  >("/api/worlds");
  const raw = Array.isArray(res) ? res : res.items;
  return raw.map(mapWorldRecord);
}

export async function getWorld(id: string): Promise<WorldRecord> {
  const raw = await request<Record<string, unknown>>(
    `/api/worlds/${encodeURIComponent(id)}`,
  );
  return mapWorldRecord(raw);
}

export async function createWorld(
  name: string,
  description: string,
  id?: string,
): Promise<WorldRecord> {
  const raw = await request<Record<string, unknown>>("/api/worlds", {
    method: "POST",
    body: JSON.stringify({ id, name, description }),
  });
  return mapWorldRecord(raw);
}

export async function updateWorld(
  id: string,
  patch: Partial<
    Pick<
      WorldRecord,
      "name" | "description" | "lore" | "locale" | "tags" | "dimensions"
    >
  >,
): Promise<WorldRecord> {
  const raw = await request<Record<string, unknown>>(
    `/api/worlds/${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      body: JSON.stringify(patch),
    },
  );
  return mapWorldRecord(raw);
}

export async function deleteWorld(id: string): Promise<void> {
  await request<unknown>(`/api/worlds/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export async function preflightWorldData(
  worldId: string,
  body: { plugins?: string[]; sessionId?: string },
): Promise<WorldDataPreflightResponse> {
  return request<WorldDataPreflightResponse>(
    `/api/worlds/${encodeURIComponent(worldId)}/world-data/preflight`,
    {
      method: "POST",
      body: JSON.stringify(body),
      silentErrors: true,
    },
  );
}

// ── Dimension Import/Export ──────────────────────────────────────────

/** Export world dimensions as a downloadable YAML file. */
export function exportDimensionsUrl(
  worldId: string,
  format: "yaml" | "json" = "yaml",
): string {
  return `/api/worlds/${encodeURIComponent(worldId)}/dimensions/export?format=${format}`;
}

/** Import dimensions into a world (full replace). */
export async function importDimensions(
  worldId: string,
  dimensions: Record<string, unknown>,
): Promise<WorldRecord> {
  const raw = await request<Record<string, unknown>>(
    `/api/worlds/${encodeURIComponent(worldId)}/dimensions/import`,
    {
      method: "POST",
      body: JSON.stringify({ dimensions }),
    },
  );
  return mapWorldRecord(raw);
}

/** Re-sync world dimensions into an active session's plugin_data. */
export async function syncSessionDimensions(
  worldId: string,
  sessionId: string,
): Promise<{ success: boolean; syncedKeys: string[]; entryCount: number }> {
  return request(`/api/worlds/${encodeURIComponent(worldId)}/sync-dimensions`, {
    method: "POST",
    body: JSON.stringify({ sessionId }),
  });
}

// ── AI World Generation ──────────────────────────────────────────────

export interface GenerateWorldProgress {
  type: "progress";
  phase: "generating" | "validating" | "saving";
}

export interface GenerateWorldDone {
  type: "done";
  world: WorldRecord;
}

export interface GenerateWorldError {
  type: "error";
  message: string;
}

export type GenerateWorldEvent =
  | GenerateWorldProgress
  | GenerateWorldDone
  | GenerateWorldError;

/**
 * Generate a world via AI from a text prompt.
 * Returns an AbortController to cancel the stream.
 */
export function generateWorld(
  prompt: string,
  locale: string,
  onEvent: (event: GenerateWorldEvent) => void,
  onError?: (err: Error) => void,
  onDone?: () => void,
  options?: { saveTarget?: GeneratedWorldSaveTarget },
): AbortController {
  const controller = new AbortController();

  (async () => {
    try {
      const res = await fetch("/api/ai/generate-world", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...buildAiHeaders(),
        },
        body: JSON.stringify({
          prompt,
          locale,
          saveTarget: options?.saveTarget,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`API ${res.status}: ${text}`);
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error("No response body");

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (line.startsWith("data:")) {
            const data = line.slice(5).trim();
            if (data) {
              try {
                const event = JSON.parse(data) as GenerateWorldEvent;
                onEvent(event);
              } catch {
                // skip malformed
              }
            }
          }
        }
      }

      onDone?.();
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        onError?.(err instanceof Error ? err : new Error(String(err)));
      }
    }
  })();

  return controller;
}

// ── Session Plugin API ─────────────────────────────────────────────

export interface SessionPluginInfo {
  id: string;
  displayName: I18nText;
  description?: I18nText;
  isActive: boolean;
  /** Core plugins that are always required and cannot be disabled. */
  locked?: boolean;
  pluginType?: string;
  /**
   * Authoritative trust tier resolved by the kernel from the plugin's
   * discovery path: `builtin` (shipped under `plugins/`), `official`
   * (whitelisted), or `community` (everything else, e.g. user-installed
   * under `~/.covel/plugins/`). Use this — not `pluginType` — when the UI
   * needs to mark "core" vs "third-party"; plugin authors can forge
   * `pluginType` but cannot forge the directory the framework loaded them
   * from.
   */
  source?: "builtin" | "official" | "community";
  /** Plugin load status: 'registered' = ok, 'error' = failed to load. */
  status?: string;
  /** Error message when status is 'error'. */
  error?: string;
  priority?: number;
  runtimeType?: string;
  model?: string;
  /** How the framework treats this plugin's output in the UI ('story' | 'plugin' | 'system'). */
  outputKind?: string;
  /** Capability tags declared by this plugin (e.g. 'image-generation', 'world-data-provider'). */
  capabilities?: string[];
  trigger?: {
    type: string;
    interval?: number;
    maxTriggerCount?: number;
    cooldownTurns?: number;
  };
  tools?: { builtin: string[]; local: string[] };
  config?: Record<
    string,
    {
      type: string;
      default?: unknown;
      label?: string;
      description?: string;
      options?: string[];
    }
  >;
  /**
   * Per-runtime breakdown so framework UI surfaces (e.g. inline action buttons
   * in the chat stream) can discover which runtime to invoke via plugin-rpc by
   * matching `capabilities` + `trigger.type`, instead of hardcoding plugin or
   * runtime IDs (forbidden by the framework-plugin isolation rule).
   */
  runtimes?: Array<{
    id: string;
    runtimeType?: string;
    model?: string;
    outputKind?: string;
    trigger?: { type: string; topic?: string };
    capabilities?: string[];
  }>;
}

export interface SessionPluginsResponse {
  active: string[];
  available: SessionPluginInfo[];
}

/** Fetch the active + available plugins for a session. */
export async function listSessionPlugins(
  sessionId: string,
): Promise<SessionPluginsResponse> {
  const raw = await request<{
    active: string[];
    available: Array<Record<string, unknown>>;
  }>(`/api/sessions/${encodeURIComponent(sessionId)}/plugins`);
  // Map API field `active` → frontend field `isActive`
  const available: SessionPluginInfo[] = raw.available.map((p) => ({
    ...p,
    id: p.id as string,
    displayName: (p.name ?? p.id) as I18nText,
    isActive: Boolean(p.active),
    capabilities: p.capabilities as string[] | undefined,
    pluginType: p.pluginType as string | undefined,
    source: p.source as SessionPluginInfo["source"],
    runtimes: p.runtimes as SessionPluginInfo["runtimes"],
  })) as SessionPluginInfo[];
  return { active: raw.active, available };
}

/** Enable a plugin for a session. Returns updated active list. */
export async function enableSessionPlugin(
  sessionId: string,
  pluginId: string,
): Promise<{ ok: boolean; active: string[] }> {
  return request<{ ok: boolean; active: string[] }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/plugins/enable`,
    { method: "POST", body: JSON.stringify({ pluginId }) },
  );
}

/** Disable a plugin for a session. Returns updated active list. */
export async function disableSessionPlugin(
  sessionId: string,
  pluginId: string,
): Promise<{ ok: boolean; active: string[] }> {
  return request<{ ok: boolean; active: string[] }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/plugins/disable`,
    { method: "POST", body: JSON.stringify({ pluginId }) },
  );
}

// ── Submit Inputs (form/choice/confirmation interactions) ────────

export interface SubmitInputsResult {
  results: Array<{
    submissionId: string;
    interactionId: string;
    filledNarrative: string;
    accepted: boolean;
  }>;
}

export async function submitInputs(
  sessionId: string,
  body: {
    turnId: string;
    submissions: Array<{
      interactionId: string;
      type: "form" | "choice" | "confirmation";
      values: Record<string, unknown>;
    }>;
  },
): Promise<SubmitInputsResult> {
  return request<SubmitInputsResult>(
    `/api/sessions/${encodeURIComponent(sessionId)}/submit-inputs`,
    { method: "POST", body: JSON.stringify(body) },
  );
}

// ── Session Snapshot (restore/reconnection) ───────────────────────

export async function getSessionSnapshot(
  sessionId: string,
): Promise<import("@covel/shared").SessionSnapshot> {
  return request<import("@covel/shared").SessionSnapshot>(
    `/api/sessions/${encodeURIComponent(sessionId)}/snapshot`,
  );
}

// ── Session API ────────────────────────────────────────────────────

export async function listSessions(worldId: string): Promise<SessionRecord[]> {
  const res = await request<{ items: SessionRecord[] } | SessionRecord[]>(
    `/api/sessions?worldId=${encodeURIComponent(worldId)}`,
  );
  return Array.isArray(res) ? res : res.items;
}

export async function getSession(sessionId: string): Promise<SessionRecord> {
  return request<SessionRecord>(
    `/api/sessions/${encodeURIComponent(sessionId)}`,
  );
}

export async function listStatePatches(
  sessionId: string,
): Promise<StatePatchRecord[]> {
  return request<StatePatchRecord[]>(
    `/api/sessions/${encodeURIComponent(sessionId)}/state-patches`,
  );
}

export async function loadStateSnapshot(
  sessionId: string,
): Promise<Record<string, unknown> | null> {
  return request<Record<string, unknown> | null>(
    `/api/sessions/${encodeURIComponent(sessionId)}/state-snapshot`,
  );
}

export interface StateTableEntry {
  name: string;
  fields: Array<{ name: string; type?: string; description?: string }>;
  data: Record<string, unknown>;
}

/**
 * Fetch every state table (schema + current values) for the session.
 * Used by the 数据库 panel to render a live DB view instead of just a
 * patch history log.
 */
export async function listStateTables(
  sessionId: string,
): Promise<StateTableEntry[]> {
  type ApiShape = {
    tables: Record<
      string,
      {
        schema: {
          name: string;
          fields: Array<{ name: string; type?: string; description?: string }>;
        };
        data: Record<string, unknown>;
      }
    >;
  };
  const res = await request<ApiShape>(
    `/api/sessions/${encodeURIComponent(sessionId)}/state`,
  );
  return Object.entries(res.tables).map(([name, row]) => ({
    name,
    fields: row.schema?.fields ?? [],
    data: row.data ?? {},
  }));
}

export async function saveStateSnapshot(
  sessionId: string,
  snapshot: Record<string, unknown>,
): Promise<void> {
  await request<{ ok: boolean }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/state-snapshot`,
    {
      method: "PUT",
      body: JSON.stringify(snapshot),
    },
  );
}

export async function createSession(
  worldId: string,
  presetId?: string,
  id?: string,
  plugins?: string[],
  locale?: string,
): Promise<SessionRecord> {
  return request<SessionRecord>("/api/sessions", {
    method: "POST",
    body: JSON.stringify({
      id,
      worldId,
      presetId,
      ...(plugins ? { plugins } : {}),
      ...(locale ? { locale } : {}),
    }),
  });
}

export async function updateSession(
  sessionId: string,
  updates: Partial<Pick<SessionRecord, "status" | "presetId">> & {
    /**
     * Per-runtime model slot overrides. Keys are runtime IDs in the form
     * `pluginId` (single-runtime plugin) or `pluginId/runtimeName` (multi-
     * runtime plugin, matching the manifest `name` field). Values are slot
     * IDs from llm.toml. An empty string clears the override for that
     * runtime; an empty object clears all overrides.
     *
     * Server validation (apps/server/src/routes/api/session.ts):
     *   key: /^[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)?$/
     *   value: non-empty string
     *   entries: <= 64
     */
    runtimeModelOverrides?: Record<string, string>;
  },
): Promise<SessionRecord> {
  return request<SessionRecord>(`/api/sessions/${sessionId}`, {
    method: "PATCH",
    body: JSON.stringify(updates),
  });
}

export async function deleteSession(sessionId: string): Promise<void> {
  await request<{ ok: boolean }>(
    `/api/sessions/${encodeURIComponent(sessionId)}`,
    {
      method: "DELETE",
    },
  );
}

export async function listMessages(
  sessionId: string,
): Promise<MessageRecord[]> {
  return request<MessageRecord[]>(`/api/sessions/${sessionId}/messages`);
}

export async function syncMessages(
  sessionId: string,
  messages: Array<{
    role: string;
    content: string;
    turnId?: string;
    runtimeId?: string;
    block?: Record<string, unknown>;
  }>,
): Promise<void> {
  await request<{ ok: boolean }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/messages/sync`,
    {
      method: "POST",
      body: JSON.stringify({ messages }),
    },
  );
}

// ── Config API ─────────────────────────────────────────────────────

export async function listPresets(): Promise<PresetSummary[]> {
  return request<PresetSummary[]>("/api/presets");
}

export interface PluginLoadError {
  pluginId: string;
  errors: string[];
}

interface PackagesResponse {
  packages: PackageSummary[];
  loadErrors: PluginLoadError[];
}

type RawRuntimeSummary = Omit<RuntimeSummary, "trigger"> & {
  trigger?: Partial<RuntimeSummary["trigger"]> & { type?: string };
};

type RawPackageSummary = Omit<PackageSummary, "runtimes"> & {
  runtimes?: RawRuntimeSummary[];
};

function normalizePackageSummary(pkg: RawPackageSummary): PackageSummary {
  return {
    ...pkg,
    runtimes: (pkg.runtimes ?? []).map((runtime) => {
      const { type: triggerType, ...trigger } = runtime.trigger ?? {};
      return {
        ...runtime,
        trigger: {
          ...trigger,
          mode: trigger.mode ?? triggerType ?? "always",
        },
      };
    }),
  };
}

export async function listPackages(): Promise<PackagesResponse> {
  const res = await request<
    | { packages: RawPackageSummary[]; loadErrors: PluginLoadError[] }
    | RawPackageSummary[]
  >("/api/packages");
  // Backward compat: old servers return a plain array
  if (Array.isArray(res)) {
    return { packages: res.map(normalizePackageSummary), loadErrors: [] };
  }
  return {
    packages: res.packages.map(normalizePackageSummary),
    loadErrors: res.loadErrors,
  };
}

export async function listCommands(): Promise<CommandSummary[]> {
  return request<CommandSummary[]>("/api/commands");
}

// ── LLM Config ───────────────────────────────────────────────────

export type InputModality = "text" | "image" | "audio" | "video" | "file";
export type OutputModality = "text" | "image" | "audio" | "embedding";
export type ModelFeature =
  | "function_calling"
  | "structured_output"
  | "streaming"
  | "reasoning"
  | "vision"
  | "prompt_caching"
  | "web_search"
  | "computer_use";

export interface ModelPricing {
  inputPerMToken?: number;
  outputPerMToken?: number;
  imageInputPerMToken?: number;
  audioInputPerMToken?: number;
  audioOutputPerMToken?: number;
  perImage?: number;
}

export interface ModelCapabilityInfo {
  input: InputModality[];
  output: OutputModality[];
  features?: ModelFeature[];
  contextWindow?: number;
  maxOutputTokens?: number;
  pricing?: ModelPricing;
}

export interface LlmSlotInfo {
  provider: string;
  model: string;
  protocol: string;
  fallback?: string;
  tag: string;
  capability?: ModelCapabilityInfo;
}

export interface LlmConfigResponse {
  configured: boolean;
  slots: Record<string, LlmSlotInfo>;
  providers: string[];
}

export async function fetchLlmConfig(): Promise<LlmConfigResponse> {
  return request<LlmConfigResponse>("/api/llm-config");
}

// ── Model Database API ───────────────────────────────────────────

export interface ModelDbInfo {
  available: boolean;
  updatedAt?: string;
  count?: number;
  source?: string;
}

export interface ModelDbSearchResult {
  id: string;
  input: InputModality[];
  output: OutputModality[];
  features: ModelFeature[];
  contextWindow: number;
  maxOutputTokens: number;
  mode: string;
  inputPerMToken?: number;
  outputPerMToken?: number;
}

export async function fetchModelDbInfo(): Promise<ModelDbInfo> {
  return request<ModelDbInfo>("/api/model-db");
}

export async function searchModelDb(
  query: string,
  limit = 20,
): Promise<ModelDbSearchResult[]> {
  const res = await request<{ results: ModelDbSearchResult[] }>(
    `/api/model-db/search?q=${encodeURIComponent(query)}&limit=${limit}`,
  );
  return res.results;
}

export async function lookupModelCapability(
  model: string,
  provider?: string,
): Promise<ModelCapabilityInfo | null> {
  const params = new URLSearchParams({ model });
  if (provider) params.set("provider", provider);
  const res = await request<{
    found: boolean;
    capability?: ModelCapabilityInfo;
  }>(`/api/model-db/lookup?${params.toString()}`);
  return res.found ? (res.capability ?? null) : null;
}

export async function refreshModelDb(): Promise<{
  ok: boolean;
  count?: number;
  error?: string;
}> {
  return request<{ ok: boolean; count?: number; error?: string }>(
    "/api/model-db/refresh",
    {
      method: "POST",
    },
  );
}

// ── Capability Overrides ─────────────────────────────────────────

export function getCapabilityOverrides(): Record<
  string,
  Partial<ModelCapabilityInfo>
> {
  return (
    getSettings().get<Record<string, Partial<ModelCapabilityInfo>>>(
      "llm.capabilityOverrides",
    ) ?? {}
  );
}

export function setCapabilityOverrides(
  overrides: Record<string, Partial<ModelCapabilityInfo>>,
): void {
  void getSettings().set("llm.capabilityOverrides", overrides);
}

/**
 * Merge server capability with user's local overrides.
 * User overrides take precedence for each field.
 */
export function mergeCapability(
  base: ModelCapabilityInfo | undefined,
  override: Partial<ModelCapabilityInfo> | undefined,
): ModelCapabilityInfo | undefined {
  if (!base && !override) return undefined;
  if (!override) return base;
  if (!base) return override as ModelCapabilityInfo;
  return {
    input: override.input ?? base.input,
    output: override.output ?? base.output,
    features: override.features ?? base.features,
    contextWindow: override.contextWindow ?? base.contextWindow,
    maxOutputTokens: override.maxOutputTokens ?? base.maxOutputTokens,
    pricing: override.pricing
      ? { ...base.pricing, ...override.pricing }
      : base.pricing,
  };
}

// ── Block Schemas ─────────────────────────────────────────────────

export async function fetchBlockSchemas(): Promise<Record<string, unknown>> {
  const res = await request<{ schemas: Record<string, unknown> }>(
    "/api/block-schemas",
  );
  return res.schemas;
}

// ── AI Ping ───────────────────────────────────────────────────────

/**
 * Which of the server's resolution rules picked the preset:
 *   - `direct`: exact presetId match
 *   - `slot`: `slot-<name>` → client override or slotRegistry
 *   - `tag-fallback`: text-tag fallback (slot didn't exist → first text preset)
 *   - `any`: last-resort "any enabled preset"
 *
 * UIs should flag `tag-fallback` / `any` when the user explicitly requested
 * a specific slot — it means that slot isn't actually configured.
 */
export type PingResolvedVia = "direct" | "slot" | "tag-fallback" | "any";

export interface PingTestedTarget {
  presetId: string;
  provider: string;
  model: string;
  baseUrl?: string;
  protocol?: string;
  resolvedVia: PingResolvedVia;
}

export interface PingResult {
  ok: boolean;
  latencyMs: number;
  ttfbMs?: number;
  text?: string;
  usage?: { inputTokens: number; outputTokens: number };
  error?: string;
  /** Echoes the exact preset/baseUrl/model that was probed. Always present for resolved pings. */
  testedTarget?: PingTestedTarget;
}

/**
 * Send a minimal "hi" to a specific preset to test connectivity and latency.
 * Requires API keys in localStorage.
 */
export async function pingPreset(presetId: string): Promise<PingResult> {
  const res = await fetch("/api/ai/ping", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...buildProviderKeysHeader(),
      ...buildSlotConfigHeaderInternal({ includeCustomPresetIds: [presetId] }),
    },
    body: JSON.stringify({ presetId }),
  });
  return res.json() as Promise<PingResult>;
}

// ── Actions (SSE) ──────────────────────────────────────────────────

export type ActionType =
  | "send_message"
  | "execute_command"
  | "submit_block_response"
  | "start_session"
  | "retry_runtime"
  | "trigger_event";

export interface ActionRequest {
  requestId: string;
  type: ActionType;
  sessionId: string;
  locale?: string;
  payload: Record<string, unknown>;
}

/**
 * Send an action and receive SSE events via callback.
 * Returns an AbortController to cancel the stream.
 */
export function sendAction(
  req: ActionRequest,
  onEvent: (envelope: SseEnvelope) => void,
  onError?: (err: Error) => void,
  onDone?: () => void,
): AbortController {
  const controller = new AbortController();

  (async () => {
    try {
      const res = await fetch("/api/actions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...buildAiHeaders(),
        },
        body: JSON.stringify(req),
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Action failed ${res.status}: ${text}`);
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error("No response body");

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (line.startsWith("data:")) {
            const data = line.slice(5).trim();
            if (data) {
              try {
                const envelope = JSON.parse(data) as SseEnvelope;
                onEvent(envelope);
              } catch {
                // skip malformed
              }
            }
          }
        }
      }

      onDone?.();
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        onError?.(err instanceof Error ? err : new Error(String(err)));
      }
    }
  })();

  return controller;
}

/**
 * Trigger a custom kernel event for the given session.
 * Useful for manual plugin triggers (e.g., image generation button).
 */
export function triggerEvent(
  sessionId: string,
  eventType: string,
  eventData: Record<string, unknown>,
  locale: string,
  onEvent: (envelope: SseEnvelope) => void,
  onError?: (err: Error) => void,
  onDone?: () => void,
): AbortController {
  return sendAction(
    {
      requestId: `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      type: "trigger_event",
      sessionId,
      locale,
      payload: { eventType, eventData },
    },
    onEvent,
    onError,
    onDone,
  );
}

// ── Provider Keys ──────────────────────────────────────────────────
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

// ── Slot / Preset / Parameter / Runtime-priority config ───────────
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
 * `sk-...` string — the secret lives in keys.env (desktop) or the
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

// ── World Overlay (IndexedDB via app-kv-store) ─────────────────

import {
  getWorldOverlay as idbGetWorldOverlay,
  setWorldOverlay as idbSetWorldOverlay,
  removeWorldOverlay as idbRemoveWorldOverlay,
  type WorldOverlay,
} from "./app-kv-store.js";

export type { WorldOverlay };

export async function getWorldOverlay(
  worldId: string,
): Promise<WorldOverlay | null> {
  return idbGetWorldOverlay(worldId);
}

export async function setWorldOverlay(
  worldId: string,
  overlay: WorldOverlay,
): Promise<void> {
  return idbSetWorldOverlay(worldId, overlay);
}

export async function removeWorldOverlay(worldId: string): Promise<void> {
  return idbRemoveWorldOverlay(worldId);
}

// ── Plugin Data API ──────────────────────────────────────────────

export interface PluginDataEntry {
  namespace: string;
  key: string;
  value: unknown;
  updatedAt: string;
}

/** List all plugin data entries for a given plugin and optional namespace. */
export async function listPluginData(
  sessionId: string,
  pluginId: string,
  namespace?: string,
): Promise<PluginDataEntry[]> {
  const path = namespace
    ? `/api/sessions/${encodeURIComponent(sessionId)}/plugin-data/${encodeURIComponent(pluginId)}/${encodeURIComponent(namespace)}`
    : `/api/sessions/${encodeURIComponent(sessionId)}/plugin-data/${encodeURIComponent(pluginId)}`;
  const res = await request<{ items: PluginDataEntry[] }>(path);
  return res.items;
}

/** Get a single plugin data entry. */
export async function getPluginData(
  sessionId: string,
  pluginId: string,
  namespace: string,
  key: string,
): Promise<PluginDataEntry | null> {
  try {
    return await request<PluginDataEntry>(
      `/api/sessions/${encodeURIComponent(sessionId)}/plugin-data/${encodeURIComponent(pluginId)}/${encodeURIComponent(namespace)}/${encodeURIComponent(key)}`,
      { silentErrors: true },
    );
  } catch {
    return null;
  }
}

// ── UI Specs (plugin panel discovery) ────────────────────────────

export interface UISlotSpec {
  id?: string;
  label: unknown;
  shortLabel?: unknown;
  icon?: string;
  group?: string;
  groupLabel?: unknown;
  groupOrder?: number;
  dataSource?: { namespace: string };
  emptyState?: { message: unknown };
  view: Record<string, unknown>;
}

export interface UISlotEntry {
  pluginId: string;
  specs: UISlotSpec[];
}

export interface UISpecsResponse {
  right: UISlotEntry[];
  message?: UISlotEntry[];
}

export async function fetchUiSpecs(
  sessionId?: string,
): Promise<UISpecsResponse> {
  const qs = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : "";
  return request<UISpecsResponse>(`/api/ui-specs${qs}`);
}

// ── Lorebook (framework-owned) ──────────────────────────────────

export interface LorebookEntry {
  id: string;
  sessionId?: string;
  content: string;
  keys: string[];
  enabled: boolean;
  strategy: string;
  insertionOrder: number;
  pluginId: string;
  position: string;
  extra?: unknown;
  createdAt?: string;
  updatedAt?: string;
}

export interface LorebookEntryInput {
  id: string;
  pluginId?: string;
  content: string;
  keys?: string[];
  strategy?: "constant" | "selective";
  position?: string;
  insertionOrder?: number;
  enabled?: boolean;
  extra?: unknown;
}

export async function fetchLorebookEntries(
  sessionId: string,
): Promise<LorebookEntry[]> {
  const res = await request<{ entries: LorebookEntry[] }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/lorebook`,
  );
  return res.entries;
}

export async function createLorebookEntry(
  sessionId: string,
  entry: LorebookEntryInput,
): Promise<LorebookEntry> {
  const res = await request<{ entry: LorebookEntry }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/lorebook`,
    { method: "POST", body: JSON.stringify(entry) },
  );
  return res.entry;
}

export async function updateLorebookEntry(
  sessionId: string,
  entryId: string,
  entry: Omit<LorebookEntryInput, "id">,
): Promise<LorebookEntry> {
  const res = await request<{ entry: LorebookEntry }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/lorebook/${encodeURIComponent(entryId)}`,
    { method: "PUT", body: JSON.stringify(entry) },
  );
  return res.entry;
}

export async function updateLorebookEntryEnabled(
  sessionId: string,
  entryId: string,
  enabled: boolean,
): Promise<void> {
  await request(
    `/api/sessions/${encodeURIComponent(sessionId)}/lorebook/${encodeURIComponent(entryId)}`,
    { method: "PATCH", body: JSON.stringify({ enabled }) },
  );
}

export async function deleteLorebookEntry(
  sessionId: string,
  entryId: string,
): Promise<void> {
  await request(
    `/api/sessions/${encodeURIComponent(sessionId)}/lorebook/${encodeURIComponent(entryId)}`,
    { method: "DELETE" },
  );
}

// ── Plugin RPC ──────────────────────────────────────────────────
//
// The server accepts two mutually exclusive dispatch modes:
//
//   Action-level:  { pluginId, action, payload }
//   Runtime-level: { pluginId, runtimeId, payload }
//
// Responses carry a `status` discriminator:
//   - 'ok'                — sync result or action-level completion
//   - 'accepted'          — background runtime queued; poll _jobs/{jobId}
//                           via plugin-data.changed SSE
//   - 'approval-required' — community plugin needs user approval
//   - 'error'             — dispatch or execution failure

export interface PluginRpcActionRequest {
  readonly pluginId: string;
  readonly action: string;
  readonly payload?: unknown;
}

export interface PluginRpcRuntimeRequest {
  readonly pluginId: string;
  readonly runtimeId: string;
  readonly payload?: unknown;
  readonly expectsBackgroundFollower?: boolean;
}

export type PluginRpcRequest = PluginRpcActionRequest | PluginRpcRuntimeRequest;

export interface PluginRpcRuntimeResultSummary {
  readonly runtimeId: string;
  readonly pluginId: string;
  readonly status: string;
  readonly durationMs: number;
  readonly error?: string;
  readonly output: unknown;
}

export type PluginRpcResponse =
  | {
      readonly status: "ok";
      readonly result?: unknown;
      readonly turnId?: string;
      readonly runtimeResults?: readonly PluginRpcRuntimeResultSummary[];
      readonly durationMs?: number;
      readonly abortReason?: string;
      /**
       * Event-chain followers that declare `execution: 'background'` are
       * not awaited in the sync response — the framework writes one
       * `_jobs/<jobId>` pending row per follower and continues them
       * off-cycle. UIs can subscribe to `plugin-data.changed` on the
       * `_jobs` namespace to reflect progress. Absent when no background
       * follower was triggered (audit F1).
       */
      readonly deferredJobs?: readonly {
        readonly jobId: string;
        readonly runtimeId: string;
      }[];
      /**
       * @deprecated Server no longer emits this — `expectsBackgroundFollower`
       * paths return 202 `accepted` instead and the failure surfaces on
       * `_jobs/<jobId>` with `reason: 'expected-background-follower-missing'`.
       * Kept on the type so older clients compile; remove once no UI branch
       * reads it (Q3-2026 follow-up).
       */
      readonly failedJobs?: readonly {
        readonly jobId: string;
        readonly runtimeId: string;
      }[];
    }
  | {
      readonly status: "accepted";
      readonly jobId: string;
      readonly pending: true;
      readonly turnId: string;
      readonly runtimeId: string;
      /**
       * Which phase of the runtime was accepted. For `expectsBackgroundFollower`
       * sync runtimes that act as prompt-builders, this is `"prompt"`. The
       * subsequent follower job appears separately on `_jobs` with its own id.
       */
      readonly phase?: string;
    }
  | {
      readonly status: "approval-required";
      readonly approvalId: string;
      readonly pending: unknown;
    }
  | {
      readonly status: "error";
      readonly error: string;
      readonly code?: string;
    };

export async function postPluginRpc(
  sessionId: string,
  req: PluginRpcRequest,
): Promise<PluginRpcResponse> {
  return request<PluginRpcResponse>(
    `/api/sessions/${encodeURIComponent(sessionId)}/plugin-rpc`,
    { method: "POST", body: JSON.stringify(req) },
  );
}

// ── Suspensions (suspend / resume) ───────────────────────────────
//
// Mirrors the S4-T4 backend surface:
//   GET    /api/sessions/:id/suspensions                   → list active
//   POST   /api/sessions/:id/resume                        → resume one
//   DELETE /api/sessions/:id/suspensions/:suspensionId     → cancel one
//
// All three are gated server-side by the COVEL_SUSPEND_V1 flag. The web
// client surfaces suspensions inside GameView (badge + dialog) so players
// can feed resume data for runtimes that declared a wait-point
// (e.g. image generation, manual review, external callbacks).

export interface SuspensionRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly runtimeId: string;
  readonly pluginId: string;
  /** Normalised from backend `createdAt` — timestamp the runtime was paused. */
  readonly suspendedAt: string;
  readonly reason?: string;
  /** Plain JSON schema describing the shape the plugin expects for resume data. */
  readonly resumeSchema?: unknown;
}

export interface ResumeSuspensionResponse {
  readonly result: RuntimeResult;
  readonly events: readonly SessionEvent[];
}

function normaliseSuspension(raw: Record<string, unknown>): SuspensionRecord {
  return {
    id: String(raw.id ?? ""),
    sessionId: String(raw.sessionId ?? ""),
    turnId: String(raw.turnId ?? ""),
    runtimeId: String(raw.runtimeId ?? ""),
    pluginId: String(raw.pluginId ?? ""),
    suspendedAt: String(raw.suspendedAt ?? raw.createdAt ?? ""),
    reason: typeof raw.reason === "string" ? raw.reason : undefined,
    resumeSchema: raw.resumeSchema,
  };
}

export async function listSuspensions(
  sessionId: string,
): Promise<SuspensionRecord[]> {
  const res = await request<{ suspensions: Array<Record<string, unknown>> }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/suspensions`,
  );
  return res.suspensions.map(normaliseSuspension);
}

export async function resumeSuspension(
  sessionId: string,
  suspensionId: string,
  data: unknown,
): Promise<ResumeSuspensionResponse> {
  return request<ResumeSuspensionResponse>(
    `/api/sessions/${encodeURIComponent(sessionId)}/resume`,
    {
      method: "POST",
      body: JSON.stringify({ suspensionId, data }),
    },
  );
}

export async function cancelSuspension(
  sessionId: string,
  suspensionId: string,
): Promise<void> {
  await request(
    `/api/sessions/${encodeURIComponent(sessionId)}/suspensions/${encodeURIComponent(suspensionId)}`,
    { method: "DELETE" },
  );
}

// ── Approvals (RPC approval gate) ───────────────────────────────

export interface ApprovalRecord {
  approvalId: string;
  sessionId: string;
  action: string;
  pluginId: string;
  payload: unknown;
  trustLevel: "builtin" | "official" | "community";
  description?: string;
  requestedAt: string;
}

export async function listApprovals(
  sessionId: string,
): Promise<ApprovalRecord[]> {
  const res = await request<{ pending: ApprovalRecord[] }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/approvals`,
  );
  return res.pending;
}

export async function resolveApproval(
  approvalId: string,
  decision: "allow" | "deny",
  scope?: "once" | "session",
): Promise<void> {
  await request(`/api/approvals/${encodeURIComponent(approvalId)}/decision`, {
    method: "POST",
    body: JSON.stringify({ decision, scope }),
  });
}

// ── Plugin Flows & Docs ─────────────────────────────────────────

export interface PluginFlowStep {
  pluginId: string;
  runtimeId: string;
  label: string;
  priority: number;
  trigger: { mode: string };
  runtimeType?: string;
  outputKind?: string;
  model?: string;
}

export interface PluginFlowSegment {
  label: string;
  range: [number, number];
}

export interface PluginFlowResponse {
  steps: PluginFlowStep[];
  segments: PluginFlowSegment[];
}

export async function fetchPluginFlows(): Promise<PluginFlowResponse> {
  // Server endpoint is `/api/plugin-flows` (not `/api/plugins/flows`, which
  // falls into `/api/plugins/:id` and 404s with `Plugin "flows" not found`).
  // The server response also uses `runtimeName` / `trigger.type` /
  // `minPriority`+`maxPriority`; adapt to the UI-facing shape here.
  type RawStep = {
    pluginId: string;
    runtimeId: string;
    runtimeName?: string;
    priority: number;
    trigger?: { type?: string };
    runtimeType?: string;
    outputKind?: string;
    model?: string;
  };
  type RawSegment = {
    label: string;
    minPriority: number;
    maxPriority: number;
  };
  const raw = await request<{ steps: RawStep[]; segments: RawSegment[] }>(
    "/api/plugin-flows",
  );
  return {
    steps: raw.steps.map((s) => ({
      pluginId: s.pluginId,
      runtimeId: s.runtimeId,
      label: s.runtimeName ?? s.runtimeId,
      priority: s.priority,
      trigger: { mode: s.trigger?.type ?? "auto" },
      runtimeType: s.runtimeType,
      outputKind: s.outputKind,
      model: s.model,
    })),
    segments: raw.segments.map((seg) => ({
      label: seg.label,
      range: [seg.minPriority, seg.maxPriority],
    })),
  };
}

export interface PluginDocEntry {
  pluginId: string;
  content: string;
  format: string;
}

export interface PluginDocsResponse {
  docs: PluginDocEntry[];
}

export async function fetchPluginDocs(
  pluginId: string,
): Promise<PluginDocsResponse> {
  return request<PluginDocsResponse>(
    `/api/plugins/${encodeURIComponent(pluginId)}/docs`,
  );
}

// ── Trace API ────────────────────────────────────────────────────

export interface TraceEvent {
  type: string;
  requestId: string;
  traceId: string;
  sessionId: string;
  turnId: string;
  flowId: string;
  seq: number;
  timestamp: string;
  payload: Record<string, unknown>;
}

export interface TurnTrace {
  turnId: string;
  flowId: string;
  traceId: string;
  startedAt: string;
  completedAt: string;
  eventCount: number;
  events: TraceEvent[];
}

export interface PluginDataKeyIndex {
  key: string;
  createdAt: string;
  updatedAt: string;
  valueType: string;
}

export interface PluginDataNamespaceIndex {
  namespace: string;
  count: number;
  latestUpdatedAt?: string;
  keys: PluginDataKeyIndex[];
}

export interface PluginDataDiscoveryIndex {
  pluginId: string;
  namespaces: PluginDataNamespaceIndex[];
}

export interface PluginContract {
  id: string;
  name: I18nText | unknown;
  description?: I18nText | unknown;
  pluginType?: string;
  runtimeCount?: number;
  status?: string;
  source?: string;
  capabilities?: string[];
  declaredPluginDataNamespaces?: string[];
  tools?: {
    builtin?: string[];
    local?: Array<{ runtimeId: string; path: string; name: string }>;
  };
  rpc?: Array<Record<string, unknown>>;
  ui?: {
    right?: Array<{ runtimeId: string; path: string }>;
    message?: Array<{ runtimeId: string; path: string }>;
    left?: Array<{ runtimeId: string; path: string }>;
  };
  runtimes?: Array<Record<string, unknown>>;
  dataSchemas?: Record<string, unknown>;
}

export interface TraceDiscovery {
  framework: Record<string, unknown>;
  plugins: PluginContract[];
  pluginData: PluginDataDiscoveryIndex[];
}

export async function fetchTraceEvents(sessionId: string): Promise<{
  sessionId: string;
  count: number;
  discovery?: TraceDiscovery;
  events: TraceEvent[];
}> {
  return request(`/api/traces/${encodeURIComponent(sessionId)}`);
}

export async function fetchTraceTurns(sessionId: string): Promise<{
  sessionId: string;
  turnCount: number;
  discovery?: TraceDiscovery;
  turns: TurnTrace[];
}> {
  return request(`/api/traces/${encodeURIComponent(sessionId)}/turns`);
}

// ── Server Info ──────────────────────────────────────────────────

export interface ServerHealth {
  status: string;
  timestamp: string;
  version: string;
  storeBackend: "pg" | "sqlite" | "memory";
  bootId?: string;
  storage?: {
    data?: {
      backend?: "pg" | "sqlite" | "memory";
      durable?: boolean;
      frontendMode?: "local" | "remote";
    };
    media?: {
      backend?: "memory" | "sqlite" | "pg" | "s3" | "idb" | "none";
      configuredBackend?:
        | "mirror"
        | "memory"
        | "sqlite"
        | "pg"
        | "s3"
        | "idb"
        | "none";
      enabled?: boolean;
      durable?: boolean;
    };
    vector?: {
      backend?: "embedded" | "none" | "external";
      capable?: boolean;
      driver?: "in-memory" | "sqlite-vec" | "pgvector" | "external" | "none";
      modelCount?: number;
      tableCount?: number;
    };
  };
}

export async function fetchServerHealth(): Promise<ServerHealth> {
  const res = await fetch("/api/health");
  return res.json() as Promise<ServerHealth>;
}

// ── Server session sync guard ────────────────────────────────────
//
// Render free-tier sleeps after 15 min of inactivity, wiping MemoryStore.
// Instead of syncing before every action, we use a time-gated bootId check:
//   1. Track when we last got a successful server response
//   2. If idle > STALE_THRESHOLD, ping /api/health to get bootId
//   3. If bootId changed → server restarted → run full sync
//
// Cost: zero overhead during normal play, one lightweight health check
// after idle periods, full sync only on actual server restart.

const STALE_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

let lastServerAckTime = 0;
let knownBootId: string | null = null;

/** Call after any successful server response to update the ack timestamp. */
export function markServerAck(): void {
  lastServerAckTime = Date.now();
}

/**
 * Ensure the server still has our session context.
 * Only checks if idle > STALE_THRESHOLD_MS. Triggers full sync on server restart.
 */
export async function ensureServerSession(
  sessionId: string,
  syncFn: (sid: string) => Promise<void>,
): Promise<void> {
  const elapsed = Date.now() - lastServerAckTime;
  if (elapsed < STALE_THRESHOLD_MS && knownBootId !== null) return;

  try {
    const health = await fetchServerHealth();
    markServerAck();

    if (knownBootId !== null && health.bootId !== knownBootId) {
      // Server restarted — rebuild session context
      await syncFn(sessionId);
    }
    knownBootId = health.bootId ?? null;
  } catch {
    // Health check failed (server still waking up?) — sync defensively
    try {
      await syncFn(sessionId);
    } catch {
      // sync also failed — let the action call surface the real error
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────

export function uid(): string {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
