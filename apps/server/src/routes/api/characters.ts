/**
 * API Character routes — list and upsert characters for a session.
 */

import { Hono } from "hono";
import { createCommitPipeline } from "@covel/runtime";
import type { DataStore, CharacterRecord } from "@covel/store";
import type { EventBus } from "@covel/events";
import type { Proposal } from "@covel/shared";
import type { HookPipeline } from "@covel/runtime";

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
	const store = c.get("store");
	const sessionId = c.req.param("id");
	const session = await store.getSession(sessionId);
	if (!session) {
		return c.json({ error: "Session not found" }, 404);
	}
	const characters = await store.listCharacters(sessionId);
	return c.json({ items: characters });
});

// POST /session/:id/characters
characterRoutes.post("/:id/characters", async (c) => {
	const store = c.get("store");
	const sessionId = c.req.param("id");

	const session = await store.getSession(sessionId);
	if (!session) {
		return c.json({ error: "Session not found" }, 404);
	}

	const body = await c.req.json<Record<string, unknown>>();

	if (!body.id || typeof body.id !== "string") {
		return c.json({ error: "id (string) is required" }, 400);
	}
	if (!body.name || typeof body.name !== "string") {
		return c.json({ error: "name (string) is required" }, 400);
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

	const proposal: Proposal = {
		id: crypto.randomUUID(),
		type: "character.upsert",
		source: {
			pluginId: "framework-api",
			runtimeId: "framework-api/characters",
		},
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
	const result = await pipeline.commit(proposal);
	if (!result.committed) {
		return c.json({ error: result.error ?? "Failed to upsert character" }, 500);
	}

	return c.json(record);
});
