import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	discoverPlugins,
	loadPluginManifest,
	loadRuntime,
	parsePluginMd,
} from "@covel/plugin-loader";

const pluginDir = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);
const pluginsDir = path.dirname(pluginDir);
const pluginMdPath = path.join(pluginDir, "PLUGIN.md");

describe("scene-prompts manifest and UI loading", () => {
	it("parses PLUGIN.md through the strict runtime manifest schema", () => {
		const parsed = parsePluginMd(
			readFileSync(pluginMdPath, "utf-8"),
			pluginMdPath,
		);

		expect(parsed.manifest).toMatchObject({
			name: "scene-prompts",
			pluginId: "scene-prompts",
			pluginType: "plugin",
			priority: 600,
			model: "plugin",
			outputKind: "system",
			promptVersion: 1,
			trigger: {
				type: "scheduled",
				interval: 1,
				cooldownTurns: 1,
			},
			tools: {
				local: ["./tools/generate-scene-prompts.js"],
			},
			ui: {
				message: ["./ui/scene-prompts-block.json"],
			},
		});
	});

	it("parses PLUGIN.md and loads ui.message through plugin-loader", async () => {
		const discoveries = await discoverPlugins(pluginsDir);
		const discovery = discoveries.find(
			(candidate) => candidate.id === "scene-prompts",
		);
		expect(discovery).toBeDefined();

		const manifests = await loadPluginManifest(discovery!);
		expect(manifests).toHaveLength(1);
		expect(manifests[0].manifest).toMatchObject({
			name: "scene-prompts",
			pluginType: "plugin",
			priority: 600,
			model: "plugin",
			outputKind: "system",
			trigger: {
				type: "scheduled",
				interval: 1,
				cooldownTurns: 1,
			},
			upstreamRequired: ["chat-mode-narrator"],
			input: {
				inject: [
					{
						kind: "runtime",
						from: "chat-mode-narrator",
						field: "narrativeOutput",
						as: "<narrator-output>",
					},
				],
			},
			ui: {
				message: ["./ui/scene-prompts-block.json"],
			},
		});

		const loaded = await loadRuntime(discovery!, "scene-prompts");
		expect(loaded.promptTemplate).toContain(
			"{{ inputs.chat-mode-narrator.chat-mode-narrator.narrativeOutput }}",
		);
		expect(loaded.uiSpecs?.message).toHaveLength(1);
		expect(loaded.uiSpecs?.message?.[0]).toMatchObject({
			id: "scene-prompts",
			dataSource: { namespace: "message" },
			view: {
				component: "Stack",
			},
		});
	});

	it("keeps scene prompt choices guide-like without per-card send buttons", async () => {
		const ui = JSON.parse(
			readFileSync(
				path.join(pluginDir, "ui/scene-prompts-block.json"),
				"utf-8",
			),
		) as unknown;

		const actions: string[] = [];
		const labels: unknown[] = [];
		function walk(value: unknown): void {
			if (!value || typeof value !== "object") return;
			if (Array.isArray(value)) {
				for (const item of value) walk(item);
				return;
			}
			const obj = value as Record<string, unknown>;
			const on = obj.on as Record<string, unknown> | undefined;
			const click = on?.click as Record<string, unknown> | undefined;
			if (typeof click?.action === "string") actions.push(click.action);
			const props = obj.props as Record<string, unknown> | undefined;
			if (props && Object.hasOwn(props, "label")) labels.push(props.label);
			for (const child of Object.values(obj)) walk(child);
		}
		walk(ui);

		expect(actions).toContain("draftMessage");
		expect(actions).not.toContain("sendMessage");
		expect(labels).not.toContainEqual({ zh: "发送", en: "Send" });
	});
});
