/**
 * API Character routes — list and upsert characters for a session.
 */

import { Hono } from "hono";
import { z } from "zod";
import { decodePluginUserSettingsHeader } from "./plugin-user-settings.js";
import { loadSessionHookScope } from "./session/hook-scope.js";
import { createCommitPipeline, runWithHookScope } from "@covel/runtime";
import type { DataStore, CharacterRecord } from "@covel/store";
import type { EventBus } from "@covel/events";
import type { Proposal } from "@covel/shared";
import type { HookPipeline } from "@covel/runtime";
import { errorBody, readJsonBody } from "../../api-error.js";
import { frameworkProposalSource } from "../../lib/framework-source.js";
import type { SessionLock } from "../../lib/session-lock.js";
import { resolveSessionParam } from "./session/session-guard.js";
import { withLockedSessionMutation } from "./session/locked-mutation.js";

type Env = {
  Variables: {
    store: DataStore;
    hookPipeline?: HookPipeline;
    eventBus?: EventBus;
    sessionLock: SessionLock;
  };
};

export const characterRoutes = new Hono<Env>();

const characterBodySchema = z.object({
  id: z
    .string({ error: "id (string) is required" })
    .min(1, "id (string) is required")
    .max(160, "id is too long"),
  name: z
    .string({ error: "name (string) is required" })
    .min(1, "name (string) is required")
    .max(256, "name is too long"),
  type: z.string().min(1).max(64).optional(),
  description: z.string().max(65_536).optional(),
  fields: z.record(z.string(), z.unknown()).optional(),
  version: z.number().optional(),
  createdAt: z.string().optional(),
});

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

  const decodedUserSettings = decodePluginUserSettingsHeader(
    c.req.header("X-Plugin-User-Settings"),
  );
  if (!decodedUserSettings.ok) {
    return c.json(
      errorBody(decodedUserSettings.error, { code: decodedUserSettings.code }),
      decodedUserSettings.status,
    );
  }

  const parsed = await readJsonBody<unknown>(c);
  if (parsed instanceof Response) return parsed;
  const valid = characterBodySchema.safeParse(parsed.body);
  if (!valid.success) {
    const issue = valid.error.issues[0];
    const path = issue?.path.join(".");
    return c.json(
      errorBody(
        path && issue && !issue.message.includes(path)
          ? `${path}: ${issue.message}`
          : (issue?.message ?? "Invalid character body"),
      ),
      400,
    );
  }
  const body = valid.data;

  const now = new Date().toISOString();
  const record: CharacterRecord = {
    id: body.id,
    sessionId,
    name: body.name,
    type: body.type ?? "npc",
    description: body.description,
    fields: body.fields,
    version: body.version ?? 1,
    createdAt: body.createdAt ?? now,
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
  // Take the per-session lock, like the turn and resume paths. A player editing
  // a character from the UI can otherwise interleave with a turn's
  // read-modify-write on the same record (update-character reads, the API
  // upserts, the tool writes back a stale copy) and silently lose the edit.
  // Commit fires PreStateCommit / PostStateCommit — scope to this session's
  // active plugins so only their hooks run (see hooks/hook-scope.ts).
  const committed = await withLockedSessionMutation({
    c,
    store,
    sessionLock: c.get("sessionLock"),
    sessionId,
    expectedSession: guard.session,
    allowedStatuses: ["active"],
    mutate: async (liveSession) =>
      runWithHookScope(
        await loadSessionHookScope({
          store,
          pluginRegistry: c.get("pluginRegistry"),
          session: liveSession,
          userSettings: decodedUserSettings.settings,
        }),
        () => pipeline.commit(proposal),
      ),
  });
  if (committed instanceof Response) return committed;
  const result = committed;
  if (!result.committed) {
    return c.json(errorBody(result.error ?? "Failed to upsert character"), 400);
  }

  return c.json(record);
});
