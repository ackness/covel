import type {
  CursorPage,
  I18nText,
  PluginRpcResponse,
  RuntimeResult,
  SessionEvent,
} from "@covel/shared";
import { request } from "./request.js";
import {
  clearSessionToken,
  storeSessionToken,
} from "../session-credentials.js";
import type {
  MessageRecord,
  SessionCreateResponse,
  SessionRecord,
  StatePatchRecord,
} from "./types.js";

// -- Session Plugin API -------------------------------------------

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
   * under `~/.covel/plugins/`). Use this - not `pluginType` - when the UI
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
  tags?: string[];
  relations?: Record<string, unknown>;
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
    tags?: string[];
    relations?: Record<string, unknown>;
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
  // Map API field `active` -�� frontend field `isActive`
  const available: SessionPluginInfo[] = raw.available.map((p) => ({
    ...p,
    id: p.id as string,
    // Prefer the friendly manifest displayName; fall back to name (which is the
    // plugin id today) then the id. Resolved to the UI locale at render time.
    displayName: (p.displayName ?? p.name ?? p.id) as I18nText,
    isActive: Boolean(p.active),
    capabilities: p.capabilities as string[] | undefined,
    tags: p.tags as string[] | undefined,
    relations: p.relations as Record<string, unknown> | undefined,
    pluginType: p.pluginType as string | undefined,
    source: p.source as SessionPluginInfo["source"],
    runtimes: p.runtimes as SessionPluginInfo["runtimes"],
  })) as SessionPluginInfo[];
  return { active: raw.active, available };
}

/** Enable a plugin for a session. Returns updated active list. */
export type EnableSessionPluginResponse =
  | { ok: boolean; active: string[] }
  | {
      status: "approval-required";
      approvalId: string;
      pending: {
        pluginId: string;
        action: string;
        description?: string;
      };
    };

export async function enableSessionPlugin(
  sessionId: string,
  pluginId: string,
): Promise<EnableSessionPluginResponse> {
  return request<EnableSessionPluginResponse>(
    `/api/sessions/${encodeURIComponent(sessionId)}/plugins/enable`,
    {
      method: "POST",
      body: JSON.stringify({ pluginId }),
      operatorAuth: true,
    },
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

// -- Submit Inputs (form/choice/confirmation interactions) -------

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
  const response = await request<PluginRpcResponse>(
    `/api/sessions/${encodeURIComponent(sessionId)}/plugin-rpc`,
    {
      method: "POST",
      body: JSON.stringify({
        pluginId: "framework",
        action: "submit-form",
        payload: body,
      }),
    },
  );
  if (response.status !== "ok") {
    throw new Error(
      response.status === "error"
        ? response.error
        : `submit-form returned ${response.status}`,
    );
  }
  return response.result as SubmitInputsResult;
}

// -- Session Snapshot (restore/reconnection) -------------------

export async function getSessionSnapshot(
  sessionId: string,
): Promise<import("@covel/shared").SessionSnapshot> {
  return request<import("@covel/shared").SessionSnapshot>(
    `/api/sessions/${encodeURIComponent(sessionId)}/snapshot`,
  );
}

// -- Session API -------------------------------------------------

export async function listSessions(worldId: string): Promise<SessionRecord[]> {
  const res = await request<{ items: SessionRecord[] }>(
    `/api/sessions?worldId=${encodeURIComponent(worldId)}`,
    { operatorAuth: true },
  );
  return res.items;
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
 * Used by the database panel to render a live DB view instead of just a
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
  const { ownerToken, ...session } = await request<SessionCreateResponse>(
    "/api/sessions",
    {
      method: "POST",
      operatorAuth: true,
      body: JSON.stringify({
        id,
        worldId,
        presetId,
        ...(plugins ? { plugins } : {}),
        ...(locale ? { locale } : {}),
      }),
    },
  );
  // Persist the one-time owner token immediately so every follow-up call (which
  // never re-receives it) can present it on hosted tiers. See H-01.
  if (ownerToken) storeSessionToken(session.id, ownerToken);
  return session;
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
  // Drop the stored owner token — the session is gone, keeping it only leaks
  // stale key material into localStorage.
  clearSessionToken(sessionId);
}

export async function listMessages(
  sessionId: string,
): Promise<MessageRecord[]> {
  return request<MessageRecord[]>(`/api/sessions/${sessionId}/messages`);
}

/**
 * Keyset page of messages, oldest-first. `before` omitted ⇒ the newest window;
 * `before` set ⇒ the page immediately older than that `(createdAt, id)`
 * position (scroll-up "load older"). `nextCursor` points at the oldest returned
 * row, or is `null` once the window reaches the start of history. Keeps the
 * full-history `listMessages` above untouched.
 */
export async function listMessagesPage(
  sessionId: string,
  opts: { limit?: number; before?: { createdAt: string; id: string } } = {},
): Promise<CursorPage<MessageRecord>> {
  const params = new URLSearchParams();
  if (opts.limit != null) params.set("limit", String(opts.limit));
  if (opts.before) {
    params.set("before_created_at", opts.before.createdAt);
    params.set("before_id", opts.before.id);
  }
  const qs = params.toString();
  return request<CursorPage<MessageRecord>>(
    `/api/sessions/${encodeURIComponent(sessionId)}/messages/page${
      qs ? `?${qs}` : ""
    }`,
  );
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

// -- Suspensions (suspend / resume) -------------------------------
//
// Mirrors the S4-T4 backend surface:
//   GET    /api/sessions/:id/suspensions                   -�� list active
//   POST   /api/sessions/:id/resume                        -�� resume one
//   DELETE /api/sessions/:id/suspensions/:suspensionId     -�� cancel one
//
// The web client surfaces suspensions inside GameView (badge + dialog) so
// players can feed resume data for runtimes that declared a wait-point
// (e.g. image generation, manual review, external callbacks).

export interface SuspensionRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly runtimeId: string;
  readonly pluginId: string;
  /** Normalised from backend `createdAt` - timestamp the runtime was paused. */
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
