/**
 * API Message routes — read-only query endpoints for message history.
 */

import { Hono } from "hono";
import type { DataStore } from "@covel/store";
import { rateLimiter } from "../../middleware/rate-limit.js";

type Env = {
	Variables: {
		store: DataStore;
	};
};

export const messageRoutes = new Hono<Env>();

// GET /sessions/:id/messages
messageRoutes.get("/:id/messages", async (c) => {
	const store = c.get("store");
	const sessionId = c.req.param("id");
	const session = await store.getSession(sessionId);
	if (!session) {
		return c.json({ error: "Session not found" }, 404);
	}
	const messages = await store.listMessages(sessionId);
	// Flatten metadata into top-level fields for frontend consumption
	const flattened = messages.map((m) => {
		const meta = (m.metadata ?? {}) as Record<string, unknown>;
		return {
			id: m.id,
			sessionId: m.sessionId,
			role: m.role,
			content: m.content,
			turnId: meta.turnId,
			runtimeId: meta.runtimeId,
			kind: meta.kind,
			block: meta.block,
			createdAt: m.createdAt,
		};
	});
	return c.json(flattened);
});

// POST /sessions/:id/messages/sync — bulk upsert messages (LocalDataService)
messageRoutes.post(
	"/:id/messages/sync",
	rateLimiter({ max: 60 }),
	async (c) => {
		const store = c.get("store");
		const sessionId = c.req.param("id");
		const session = await store.getSession(sessionId);
		if (!session) {
			return c.json({ error: "Session not found" }, 404);
		}
		const body = await c.req.json<{
			messages: Array<Record<string, unknown>>;
		}>();
		const msgs = body.messages ?? [];
		for (const msg of msgs) {
			await store.addMessage({
				id: (msg.id as string) ?? crypto.randomUUID(),
				sessionId,
				role: (msg.role as string) ?? "user",
				content: (msg.content as string) ?? "",
				metadata: {
					turnId: msg.turnId,
					runtimeId: msg.runtimeId,
					block: msg.block,
				},
				createdAt: (msg.createdAt as string) ?? new Date().toISOString(),
			});
		}
		return c.json({ ok: true });
	},
);
