import type { SessionRecord } from "@covel/store";
import type { SessionStatus } from "@covel/shared";
import {
  SAFE_WORLD_ID_RE,
  SAFE_SESSION_ID_RE,
  SAFE_WORLD_ID_DESC,
  SAFE_SESSION_ID_DESC,
} from "../../../lib/validators.js";

const VALID_STATUSES = new Set<SessionStatus>(["active", "paused", "ended"]);
const MAX_OVERRIDE_ENTRIES = 64;
const RUNTIME_ID_PATTERN = /^[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)?$/;

function isSessionStatus(value: string): value is SessionStatus {
  return VALID_STATUSES.has(value as SessionStatus);
}

type ParsedCreateSessionBody =
  | {
      ok: true;
      worldId: string | undefined;
      id: string | undefined;
      requestedPlugins: string[];
    }
  | { ok: false; error: string };

export function parseCreateSessionBody(
  body: Record<string, unknown>,
): ParsedCreateSessionBody {
  const rawWorldId =
    typeof body.worldId === "string" ? body.worldId : undefined;
  if (rawWorldId !== undefined && !SAFE_WORLD_ID_RE.test(rawWorldId)) {
    return {
      ok: false,
      error: `Invalid worldId: must match ${SAFE_WORLD_ID_DESC}`,
    };
  }

  const rawId =
    typeof body.id === "string" && body.id.length > 0 ? body.id : undefined;
  if (rawId !== undefined && !SAFE_SESSION_ID_RE.test(rawId)) {
    return {
      ok: false,
      error: `Invalid session id: must match ${SAFE_SESSION_ID_DESC}`,
    };
  }

  const requestedPlugins = Array.isArray(body.plugins)
    ? body.plugins.filter(
        (pluginId): pluginId is string => typeof pluginId === "string",
      )
    : [];

  return { ok: true, worldId: rawWorldId, id: rawId, requestedPlugins };
}

type Writable<T> = { -readonly [K in keyof T]: T[K] };

export type SessionPatchUpdates = Partial<
  Writable<
    Pick<
      SessionRecord,
      | "status"
      | "turnCount"
      | "preGameCompleted"
      | "activePlugins"
      | "updatedAt"
      | "runtimeModelOverrides"
    >
  >
>;

type ParsedSessionPatch =
  | { ok: true; updates: SessionPatchUpdates }
  | { ok: false; error: string };

export function buildSessionPatchUpdates(
  body: Record<string, unknown>,
  now: string,
): ParsedSessionPatch {
  const updates: SessionPatchUpdates = { updatedAt: now };

  // Validate status against the SessionStatus union. Pre-existing code
  // previously accepted phase strings; the turn-band refactor replaced
  // phase with a coarser status (`active`/`paused`/`ended`).
  if (body.status !== undefined) {
    if (typeof body.status !== "string" || !isSessionStatus(body.status)) {
      return {
        ok: false,
        error: `status must be one of: ${[...VALID_STATUSES].join(", ")}`,
      };
    }
    updates.status = body.status;
  }

  // PR-6: per-runtime model slot overrides. Validates shape (object of
  // string->string) before applying. Empty object clears existing overrides.
  // MEDIUM-3: cap entry count and validate each key shape.
  if (body.runtimeModelOverrides !== undefined) {
    if (
      body.runtimeModelOverrides === null ||
      typeof body.runtimeModelOverrides !== "object" ||
      Array.isArray(body.runtimeModelOverrides)
    ) {
      return { ok: false, error: "runtimeModelOverrides must be an object" };
    }
    const raw = body.runtimeModelOverrides as Record<string, unknown>;
    const rawEntries = Object.entries(raw);
    if (rawEntries.length > MAX_OVERRIDE_ENTRIES) {
      return {
        ok: false,
        error: `runtimeModelOverrides must have at most ${MAX_OVERRIDE_ENTRIES} entries (got ${rawEntries.length})`,
      };
    }
    const cleaned: Record<string, string> = {};
    for (const [key, value] of rawEntries) {
      if (typeof key !== "string" || !RUNTIME_ID_PATTERN.test(key)) continue;
      if (typeof value !== "string" || value.length === 0) continue;
      cleaned[key] = value;
    }
    updates.runtimeModelOverrides = cleaned;
  }

  return { ok: true, updates };
}
