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

describe("branch-reply manifest and UI loading", () => {
	it("parses the manual runtime manifest through the strict schema", () => {
		const parsed = parsePluginMd(
			readFileSync(pluginMdPath, "utf-8"),
			pluginMdPath,
		);

		expect(parsed.manifest).toMatchObject({
			name: "branch-reply",
			pluginId: "branch-reply",
			pluginType: "plugin",
			runtimeType: "function",
			outputKind: "system",
			handler: "./handler.js",
			trigger: { type: "manual" },
			capabilities: ["branch-reply"],
			ui: {
				message: ["./ui/branch-reply-block.json"],
			},
		});
	});

	it("loads the branch reply message block through plugin-loader", async () => {
		const discoveries = await discoverPlugins(pluginsDir);
		const discovery = discoveries.find(
			(candidate) => candidate.id === "branch-reply",
		);
		expect(discovery).toBeDefined();

		const manifests = await loadPluginManifest(discovery);
		expect(manifests).toHaveLength(1);

		const loaded = await loadRuntime(discovery, "branch-reply");
		expect(loaded.handler).toBeTypeOf("function");
		expect(loaded.uiSpecs?.message).toHaveLength(1);
		expect(loaded.uiSpecs?.message?.[0]).toMatchObject({
			id: "branch-reply",
			dataSource: { namespace: "message" },
			view: {
				component: "BranchReplyCandidates",
				props: {
					pluginId: "branch-reply",
				},
			},
		});
	});
});
