import type {
  CursorPage,
  PageCursor,
  PluginMutationResponse,
  PluginRpcResponse,
  RuntimeResult,
  SessionEvent,
  SessionPluginsResponse,
} from "@covel/shared";
import type {
  BrowserCheckpoint,
  SessionCommit,
} from "@covel/store/browser-sync";
import { request } from "./request.js";
import {
  clearSessionToken,
  storeSessionToken,
} from "../session-credentials.js";
import type {
  MessageRecord,
  SessionCreateResponse,
  SessionRecord,
  SetupRuntimeState,
  StatePatchRecord,
} from "./types.js";

// -- Session Plugin API -------------------------------------------

export type { SessionPlugin, SessionPluginsResponse } from "@covel/shared";

/** Fetch the active + available plugins for a session. */
export async function listSessionPlugins(
  sessionId: string,
): Promise<SessionPluginsResponse> {
  return request<SessionPluginsResponse>(
    `/api/sessions/${encodeURIComponent(sessionId)}/plugins`,
  );
}

/** Enable a plugin for a session. Returns updated active list. */
export type EnableSessionPluginResponse =
  | PluginMutationResponse
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
    `/api/sessions/${encodeURIComponent(sessionId)}/plugins/${encodeURIComponent(pluginId)}`,
    {
      method: "PUT",
      operatorAuth: true,
    },
  );
}

/** Disable a plugin for a session. Returns updated active list. */
export async function disableSessionPlugin(
  sessionId: string,
  pluginId: string,
): Promise<PluginMutationResponse> {
  return request<PluginMutationResponse>(
    `/api/sessions/${encodeURIComponent(sessionId)}/plugins/${encodeURIComponent(pluginId)}`,
    { method: "DELETE" },
  );
}

/** Re-run a blocked setup runtime. Returns its updated lifecycle state. */
export async function retrySetupRuntime(sessionId: string, runtimeId: string) {
  return request<{ ok: boolean; runtimeId: string; state: SetupRuntimeState }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/setup/${encodeURIComponent(runtimeId)}/retry`,
    { method: "POST" },
  );
}

/** Waive a blocked setup runtime so its plugin resumes in degraded mode. */
export async function waiveSetupRuntime(sessionId: string, runtimeId: string) {
  return request<{ ok: boolean; runtimeId: string; state: SetupRuntimeState }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/setup/${encodeURIComponent(runtimeId)}/waive`,
    { method: "POST", body: JSON.stringify({ confirm: true }) },
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
        kind: "action",
        pluginId: "framework",
        action: "submit-form",
        payload: body,
      }),
    },
  );
  if (response.status !== "ok") {
    throw new Error(`submit-form returned ${response.status}`);
  }
  return response.result as SubmitInputsResult;
}

// -- Session Snapshot (restore/reconnection) -------------------

export async function getSessionSnapshot(
  sessionId: string,
): Promise<import("@covel/shared").SessionSnapshot> {
  return request<import("@covel/shared").SessionSnapshot>(
    `/api/sessions/${encodeURIComponent(sessionId)}/view`,
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

export async function getSession(
  sessionId: string,
  options?: { silentErrors?: boolean },
): Promise<SessionRecord> {
  return request<SessionRecord>(
    `/api/sessions/${encodeURIComponent(sessionId)}`,
    options,
  );
}

export async function listStatePatches(
  sessionId: string,
): Promise<StatePatchRecord[]> {
  const response = await request<{ items: StatePatchRecord[] }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/state-patches`,
  );
  return response.items;
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
  // never re-receives it) can present it on hosted tiers.
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
  const response = await request<{ items: MessageRecord[] }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/messages`,
  );
  return response.items;
}

/**
 * Keyset page of messages, oldest-first. `cursor` omitted ⇒ the newest window;
 * `cursor` set ⇒ the page immediately older than that opaque position.
 * `nextCursor` points at the oldest returned
 * row, or is `null` once the window reaches the start of history. Keeps the
 * The full-history `listMessages` endpoint uses the same `{ items }` envelope.
 */
export async function listMessagesPage(
  sessionId: string,
  opts: { limit?: number; cursor?: PageCursor } = {},
): Promise<CursorPage<MessageRecord>> {
  const params = new URLSearchParams();
  if (opts.limit != null) params.set("limit", String(opts.limit));
  if (opts.cursor) params.set("cursor", opts.cursor);
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
    id?: string;
    role: string;
    content: string;
    turnId?: string;
    runtimeId?: string;
    block?: Record<string, unknown>;
    createdAt?: string;
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

/** Hydrate the server's transient MemoryStore from the browser authority. */
export async function uploadBrowserCheckpoint(
  sessionId: string,
  checkpoint: BrowserCheckpoint,
): Promise<{ ok: true; revision: number; unchanged?: boolean }> {
  return request(
    `/api/sessions/${encodeURIComponent(sessionId)}/browser-checkpoint`,
    {
      method: "PUT",
      body: JSON.stringify({ checkpoint }),
    },
  );
}

/** Export one idempotent post-action commit from the transient server mirror. */
export async function fetchBrowserCommit(
  sessionId: string,
  actionId: string,
  baseRevision: number,
): Promise<SessionCommit> {
  return request(
    `/api/sessions/${encodeURIComponent(sessionId)}/browser-commit`,
    {
      method: "POST",
      body: JSON.stringify({ actionId, baseRevision }),
    },
  );
}

// -- Suspensions (suspend / resume) -------------------------------
//
// Mirrors the backend surface:
//   GET    /api/sessions/:id/suspensions                   → list active
//   POST   /api/sessions/:id/suspensions/:suspensionId/resume → resume one
//   DELETE /api/sessions/:id/suspensions/:suspensionId     → cancel one
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
  const res = await request<{ items: Array<Record<string, unknown>> }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/suspensions`,
  );
  return res.items.map(normaliseSuspension);
}

export async function resumeSuspension(
  sessionId: string,
  suspensionId: string,
  data: unknown,
): Promise<ResumeSuspensionResponse> {
  return request<ResumeSuspensionResponse>(
    `/api/sessions/${encodeURIComponent(sessionId)}/suspensions/${encodeURIComponent(suspensionId)}/resume`,
    {
      method: "POST",
      body: JSON.stringify({ data }),
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
