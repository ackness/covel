/**
 * API Character routes — list and upsert characters for a session.
 */

import { Hono } from "hono";
import { createCommitPipeline, runWithHookScope } from "@covel/runtime";
import type { DataStore, CharacterRecord } from "@covel/store";
import type { EventBus } from "@covel/events";
import type { Proposal } from "@covel/shared";
import type { HookPipeline } from "@covel/runtime";
import { errorBody, readJsonBody } from "../../api-error.js";
import { frameworkProposalSource } from "../../lib/framework-source.js";
import { resolveSessionParam } from "./session/session-guard.js";

type Env = {
  Variables: {
    store: DataStore;
    hookPipeline?: HookPipeline;
    eventBus?: EventBus;
  };
};

export const characterRoutes = new Hono<Env>();

// GET /session/:id/characters
characterRoutes.get("/:id/characters", async (c) => {
  const guard = await resolveSessionParam(c);
  if (!guard.ok) return guard.response;
  const store = c.get("store");
  const characters = await store.listCharacters(guard.session.id);
  return c.json({ items: characters });
});

// POST /session/:id/characters
characterRoutes.post("/:id/characters", async (c) => {
  const guard = await resolveSessionParam(c);
  if (!guard.ok) return guard.response;
  const store = c.get("store");
  const sessionId = guard.session.id;

  const parsed = await readJsonBody<Record<string, unknown>>(c);
  if (parsed instanceof Response) return parsed;
  const body = parsed.body;

  if (!body.id || typeof body.id !== "string") {
    return c.json(errorBody("id (string) is required"), 400);
  }
  if (!body.name || typeof body.name !== "string") {
    return c.json(errorBody("name (string) is required"), 400);
  }

  const now = new Date().toISOString();
  const record: CharacterRecord = {
    id: body.id,
    sessionId,
    name: body.name,
    type: typeof body.type === "string" ? body.type : "npc",
    description:
      typeof body.description === "string" ? body.description : undefined,
    fields:
      body.fields && typeof body.fields === "object" ? body.fields : undefined,
    version: typeof body.version === "number" ? body.version : 1,
    createdAt: typeof body.createdAt === "string" ? body.createdAt : now,
    updatedAt: now,
  };

  // Framework-originated write: the API itself (not a plugin) emits this
  // proposal, so `source` uses the reserved `"framework"` sentinel rather than
  // a hard-coded plugin id (framework↔plugin isolation rule). `character.upsert`
  // is session-scoped, so `source.pluginId` is never used for data isolation.
  const proposal: Proposal = {
    id: crypto.randomUUID(),
    type: "character.upsert",
    source: frameworkProposalSource("characters"),
    turnId: `api-character-${crypto.randomUUID()}`,
    sessionId,
    payload: {
      id: record.id,
      name: record.name,
      type: record.type,
      ...(record.description !== undefined
        ? { description: record.description }
        : {}),
      ...(record.fields !== undefined ? { fields: record.fields } : {}),
      version: record.version,
      createdAt: record.createdAt,
    },
    timestamp: now,
  };

  const pipeline = createCommitPipeline(
    store,
    c.get("hookPipeline"),
    c.get("eventBus"),
  );
  // Commit fires PreStateCommit / PostStateCommit — scope to this session's
  // active plugins so only their hooks run (see hooks/hook-scope.ts).
  const result = await runWithHookScope(
    { activePluginIds: new Set(guard.session.activePlugins ?? []) },
    () => pipeline.commit(proposal),
  );
  if (!result.committed) {
    return c.json(errorBody(result.error ?? "Failed to upsert character"), 500);
  }

  return c.json(record);
});
