import path from "node:path";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	discoverPlugins,
	loadPluginManifest,
	loadRuntime,
	parsePluginMd,
} from "@covel/plugin-loader";

const pluginDir = path.resolve(import.meta.dirname, "..");
const pluginsDir = path.dirname(pluginDir);
const pluginMdPath = path.join(pluginDir, "PLUGIN.md");

describe("player-identity manifest and UI loading", () => {
	it("parses the manual runtime manifest through the strict schema", () => {
		const parsed = parsePluginMd(
			readFileSync(pluginMdPath, "utf-8"),
			pluginMdPath,
		);

		expect(parsed.manifest).toMatchObject({
			name: "player-identity",
			pluginId: "player-identity",
			runtimeType: "function",
			handler: "./handler.js",
			trigger: { type: "manual" },
			ui: {
				right: ["./ui/player-identity-panel.json"],
			},
		});
	});

	it("loads the identity right panel through plugin-loader", async () => {
		const discoveries = await discoverPlugins(pluginsDir);
		const discovery = discoveries.find(
			(candidate) => candidate.id === "player-identity",
		);
		expect(discovery).toBeDefined();

		const manifests = await loadPluginManifest(discovery);
		expect(manifests).toHaveLength(1);

		const loaded = await loadRuntime(discovery, "player-identity");
		expect(loaded.handler).toBeTypeOf("function");
		expect(loaded.uiSpecs?.right).toHaveLength(1);
		expect(loaded.uiSpecs?.right?.[0]).toMatchObject({
			id: "player-identity",
			dataSource: { namespace: "profiles" },
			alwaysRender: true,
		});
	});
});
