/**
 * Tests for the per-runtime handler helpers — scoped plugin-data writer
 * + logger. Both are handed to function-runtime handlers via
 * `FunctionHandlerContext` so plugins can write placeholder frames /
 * diagnostics without bypassing the pluginId scope.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createMemoryStore } from "@covel/store";
import type { DataStore } from "@covel/store";
import {
	createFunctionStoreView,
	createPluginDataWriter,
	createPluginLogger,
} from "../src/plugin-handler-helpers.js";

const SESSION_ID = "sess-hh-1";
const PLUGIN_ID = "my-plugin";
const RUNTIME_ID = "my-plugin/runner";
const TURN_ID = "turn-hh-1";

let store: DataStore;

beforeEach(() => {
	store = createMemoryStore();
});

describe("createPluginDataWriter", () => {
	const ctx = {
		sessionId: SESSION_ID,
		pluginId: PLUGIN_ID,
		runtimeId: RUNTIME_ID,
		turnId: TURN_ID,
	};

	it("writes plugin_data scoped to the runtime pluginId", async () => {
		const writer = createPluginDataWriter(store, ctx);
		await writer.set("images", "img-1", { status: "pending" });

		const row = await store.getPluginData(
			SESSION_ID,
			PLUGIN_ID,
			"images",
			"img-1",
		);
		expect(row?.value).toEqual({ status: "pending" });
	});

	it("overwrites existing rows on repeat set", async () => {
		const writer = createPluginDataWriter(store, ctx);
		await writer.set("images", "img-1", { status: "pending" });
		await writer.set("images", "img-1", { status: "done", url: "x" });

		const row = await store.getPluginData(
			SESSION_ID,
			PLUGIN_ID,
			"images",
			"img-1",
		);
		expect(row?.value).toEqual({ status: "done", url: "x" });
	});

	it("deletes when value is null", async () => {
		const writer = createPluginDataWriter(store, ctx);
		await writer.set("images", "img-1", { status: "pending" });
		await writer.set("images", "img-1", null);

		const row = await store.getPluginData(
			SESSION_ID,
			PLUGIN_ID,
			"images",
			"img-1",
		);
		expect(row).toBeNull();
	});

	it("list returns entries for the given namespace", async () => {
		const writer = createPluginDataWriter(store, ctx);
		await writer.set("images", "img-1", { status: "pending" });
		await writer.set("images", "img-2", { status: "done" });
		await writer.set("other", "x", { something: "else" });

		const entries = await writer.list("images");
		expect(entries.map((e) => e.key).sort()).toEqual(["img-1", "img-2"]);
	});

	it("get returns null for missing key", async () => {
		const writer = createPluginDataWriter(store, ctx);
		expect(await writer.get("images", "missing")).toBeNull();
	});
});

describe("createPluginLogger", () => {
	const ctx = {
		sessionId: SESSION_ID,
		pluginId: PLUGIN_ID,
		runtimeId: RUNTIME_ID,
		turnId: TURN_ID,
	};

	it("appends rows to the plugin _logs namespace", async () => {
		const logger = createPluginLogger(store, ctx);
		await logger.info("hello", { foo: "bar" });

		const rows = await store.listPluginData(SESSION_ID, PLUGIN_ID, "_logs");
		expect(rows).toHaveLength(1);
		const entry = rows[0].value as {
			level: string;
			message: string;
			meta: Record<string, unknown>;
			runtimeId: string;
			turnId: string;
			timestamp: string;
		};
		expect(entry.level).toBe("info");
		expect(entry.message).toBe("hello");
		expect(entry.meta).toEqual({ foo: "bar" });
		expect(entry.runtimeId).toBe(RUNTIME_ID);
		expect(entry.turnId).toBe(TURN_ID);
		expect(typeof entry.timestamp).toBe("string");
	});

	it("preserves all severity levels", async () => {
		const logger = createPluginLogger(store, ctx);
		await logger.debug("d");
		await logger.info("i");
		await logger.warn("w");
		await logger.error("e");

		const rows = await store.listPluginData(SESSION_ID, PLUGIN_ID, "_logs");
		const levels = rows.map((r) => (r.value as { level: string }).level).sort();
		expect(levels).toEqual(["debug", "error", "info", "warn"]);
	});

	it("omits the meta field when no metadata is provided", async () => {
		const logger = createPluginLogger(store, ctx);
		await logger.info("no-meta");
		const rows = await store.listPluginData(SESSION_ID, PLUGIN_ID, "_logs");
		expect(rows[0].value).not.toHaveProperty("meta");
	});

	it("never throws when the store rejects writes", async () => {
		const rejectingStore = {
			...store,
			setPluginData: async () => {
				throw new Error("boom");
			},
		} as unknown as DataStore;

		const logger = createPluginLogger(rejectingStore, ctx);
		await expect(
			logger.error("this should be swallowed"),
		).resolves.toBeUndefined();
	});
});

describe("createFunctionStoreView", () => {
	const ctx = {
		sessionId: SESSION_ID,
		pluginId: PLUGIN_ID,
		runtimeId: RUNTIME_ID,
		turnId: TURN_ID,
	};

	it("binds plugin_data reads to the calling pluginId", async () => {
		await store.setPluginData({
			id: "own-row",
			sessionId: SESSION_ID,
			pluginId: PLUGIN_ID,
			namespace: "notes",
			key: "a",
			value: { owner: "self" },
			createdAt: "2024-01-01T00:00:00Z",
			updatedAt: "2024-01-01T00:00:00Z",
		});
		await store.setPluginData({
			id: "other-row",
			sessionId: SESSION_ID,
			pluginId: "other-plugin",
			namespace: "notes",
			key: "a",
			value: { owner: "other" },
			createdAt: "2024-01-01T00:00:00Z",
			updatedAt: "2024-01-01T00:00:00Z",
		});

		const view = createFunctionStoreView(store, ctx);

		expect((await view.getPluginData("notes", "a"))?.value).toEqual({
			owner: "self",
		});
		const rows = await view.listPluginData("notes");
		expect(rows.map((r) => r.value)).toEqual([{ owner: "self" }]);
	});
});
