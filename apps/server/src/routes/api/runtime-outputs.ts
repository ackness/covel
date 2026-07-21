/**
 * Runtime outputs and interaction records routes (translation layer).
 *
 *   GET /api/sessions/:id/runtime-outputs?runtimeId=&pluginId=&since=&limit=
 *     — list normalised runtime execution records
 *
 *   GET /api/sessions/:id/runtime-outputs/:outputId
 *     — fetch a single runtime output
 *
 *   GET /api/sessions/:id/runtime-outputs/:outputId/full-prompt
 *     — rebuild the complete prompt that was sent on that call from
 *       `turn_messages` + `rawPromptDelta`
 *
 *   GET /api/sessions/:id/interaction-records?type=&source=&targetPluginId=&limit=
 *     — list external inputs recorded for the session
 */

import { Hono } from "hono";
import type { DataStore } from "@covel/store";
import { resolveSessionParam } from "./session/session-guard.js";
import { errorBody } from "../../api-error.js";

type Env = {
  Variables: {
    store: DataStore;
  };
};

export const runtimeOutputRoutes = new Hono<Env>();

// ── Helpers ────────────────────────────────────────────────────────

function parseLimit(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n;
}

// ── Routes ─────────────────────────────────────────────────────────

// GET /:id/runtime-outputs
runtimeOutputRoutes.get("/:id/runtime-outputs", async (c) => {
  const store = c.get("store");
  const sessionId = c.req.param("id");
  const guard = await resolveSessionParam(c);
  if (!guard.ok) return guard.response;

  const runtimeId = c.req.query("runtimeId") || undefined;
  const pluginId = c.req.query("pluginId") || undefined;
  const sinceTimestamp = c.req.query("since") || undefined;
  const limit = parseLimit(c.req.query("limit"));

  const items = await store.listRuntimeOutputs(sessionId, {
    runtimeId,
    pluginId,
    sinceTimestamp,
    limit,
  });
  return c.json({ items });
});

// GET /:id/runtime-outputs/:outputId
runtimeOutputRoutes.get("/:id/runtime-outputs/:outputId", async (c) => {
  const store = c.get("store");
  const sessionId = c.req.param("id");
  const outputId = c.req.param("outputId");
  const guard = await resolveSessionParam(c);
  if (!guard.ok) return guard.response;

  const record = await store.getRuntimeOutput(sessionId, outputId);
  if (!record) {
    return c.json(errorBody(`Runtime output not found: ${outputId}`), 404);
  }
  return c.json(record);
});

// GET /:id/runtime-outputs/:outputId/full-prompt
//
// Rebuilds the complete prompt history that was sent to the runtime on the
// call captured by this RuntimeOutput record.
//
// Rebuild strategy (best-effort — accepts that the reconstruction may
// be approximate for runtimes that rewrote history mid-turn):
//   1. Pull all `turn_messages` for the session up to and including the
//      record's own turnId, sorted by `order`.
//   2. Convert turn messages to { role, content } pairs.
//   3. Append the record's `rawPromptDelta` (if any) as the suffix tail,
//      since the delta represents the messages added on top of the base.
runtimeOutputRoutes.get(
  "/:id/runtime-outputs/:outputId/full-prompt",
  async (c) => {
    const store = c.get("store");
    const sessionId = c.req.param("id");
    const outputId = c.req.param("outputId");
    const guard = await resolveSessionParam(c);
    if (!guard.ok) return guard.response;

    const record = await store.getRuntimeOutput(sessionId, outputId);
    if (!record) {
      return c.json(errorBody(`Runtime output not found: ${outputId}`), 404);
    }

    const turnMessages = await store.listTurnMessages(sessionId);

    // Find the cutoff: only include messages up to and including the target turn.
    // Messages are sorted by createdAt; find the last index belonging to the
    // target turnId, then slice up to (and including) that index.
    const targetTurnId = record.turnId;
    let cutoffIndex = -1;
    for (let i = turnMessages.length - 1; i >= 0; i--) {
      if (turnMessages[i].turnId === targetTurnId) {
        cutoffIndex = i;
        break;
      }
    }

    const relevantMessages =
      cutoffIndex >= 0 ? turnMessages.slice(0, cutoffIndex + 1) : turnMessages; // fallback: if turnId not found in messages, include all

    const history = relevantMessages
      .filter((m) => m.compactedAtTurnId == null)
      .map((m) => ({
        role: m.role,
        content: m.content,
      }));

    const meta = record.metaData as {
      rawPromptDelta?: Array<{ role: string; content: string }>;
    } | null;
    const delta = meta?.rawPromptDelta ?? [];

    return c.json({
      runtimeOutputId: record.id,
      runtimeId: record.runtimeId,
      turnId: record.turnId,
      messages: [...history, ...delta],
      note: "Best-effort rebuild: history comes from turn_messages, delta is stored on RuntimeOutput.metaData.rawPromptDelta.",
    });
  },
);

// GET /:id/interaction-records
runtimeOutputRoutes.get("/:id/interaction-records", async (c) => {
  const store = c.get("store");
  const sessionId = c.req.param("id");
  const guard = await resolveSessionParam(c);
  if (!guard.ok) return guard.response;

  const type = c.req.query("type") || undefined;
  const source = c.req.query("source") || undefined;
  const targetPluginId = c.req.query("targetPluginId") || undefined;
  const limit = parseLimit(c.req.query("limit"));

  const items = await store.listInteractionRecords(sessionId, {
    type,
    source,
    targetPluginId,
    limit,
  });
  return c.json({ items });
});
