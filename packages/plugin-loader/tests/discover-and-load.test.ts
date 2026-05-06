import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { discoverPlugins } from "../src/discover.js";
import {
	loadPluginSummary,
	loadPluginManifest,
	loadRuntime,
} from "../src/load.js";

const MINIMAL_FRONTMATTER = `---
name: test-plugin
description: A test plugin
priority: 500
---

You are a test agent.
`;

function makeFrontmatter(overrides: Record<string, unknown>): string {
	const base = {
		name: "test-plugin",
		description: "A test plugin",
		priority: 500,
	};
	const merged = { ...base, ...overrides };
	const yaml = Object.entries(merged)
		.map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
		.join("\n");
	return `---\n${yaml}\n---\n\nYou are a test agent.\n`;
}

let tmpDir: string;

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "covel-test-"));
});

afterEach(async () => {
	await fs.rm(tmpDir, { recursive: true, force: true });
});

// ── discoverPlugins ─────────────────────────────────────────────

describe("discoverPlugins", () => {
	it("discovers a single-runtime plugin", async () => {
		const pluginDir = path.join(tmpDir, "my-plugin");
		await fs.mkdir(pluginDir, { recursive: true });
		await fs.writeFile(path.join(pluginDir, "PLUGIN.md"), MINIMAL_FRONTMATTER);

		const results = await discoverPlugins(tmpDir);

		expect(results).toHaveLength(1);
		expect(results[0]).toMatchObject({
			id: "my-plugin",
			rootPath: pluginDir,
			isMultiRuntime: false,
		});
		expect(results[0].pluginMdPaths).toHaveLength(1);
		expect(results[0].pluginMdPaths[0]).toBe(path.join(pluginDir, "PLUGIN.md"));
	});

	it("discovers a multi-runtime plugin", async () => {
		const pluginDir = path.join(tmpDir, "multi-plugin");
		await fs.mkdir(path.join(pluginDir, "runtimes", "rt-a"), {
			recursive: true,
		});
		await fs.mkdir(path.join(pluginDir, "runtimes", "rt-b"), {
			recursive: true,
		});
		// Root PLUGIN.md in multi-runtime is a human doc, not a runtime
		await fs.writeFile(path.join(pluginDir, "PLUGIN.md"), MINIMAL_FRONTMATTER);
		await fs.writeFile(
			path.join(pluginDir, "runtimes", "rt-a", "PLUGIN.md"),
			makeFrontmatter({ name: "rt-a", description: "Runtime A" }),
		);
		await fs.writeFile(
			path.join(pluginDir, "runtimes", "rt-b", "PLUGIN.md"),
			makeFrontmatter({ name: "rt-b", description: "Runtime B" }),
		);

		const results = await discoverPlugins(tmpDir);

		expect(results).toHaveLength(1);
		expect(results[0].isMultiRuntime).toBe(true);
		expect(results[0].pluginMdPaths).toHaveLength(2);
		const names = results[0].pluginMdPaths.map((p) =>
			path.basename(path.dirname(p)),
		);
		expect(names.sort()).toEqual(["rt-a", "rt-b"]);
	});

	it("discovers mixed directory with single and multi-runtime plugins", async () => {
		// Single-runtime
		const singleDir = path.join(tmpDir, "single");
		await fs.mkdir(singleDir, { recursive: true });
		await fs.writeFile(path.join(singleDir, "PLUGIN.md"), MINIMAL_FRONTMATTER);

		// Multi-runtime
		const multiDir = path.join(tmpDir, "multi");
		await fs.mkdir(path.join(multiDir, "runtimes", "rt-x"), {
			recursive: true,
		});
		await fs.writeFile(
			path.join(multiDir, "runtimes", "rt-x", "PLUGIN.md"),
			makeFrontmatter({ name: "rt-x", description: "Runtime X" }),
		);

		const results = await discoverPlugins(tmpDir);

		expect(results).toHaveLength(2);
		const ids = results.map((r) => r.id).sort();
		expect(ids).toEqual(["multi", "single"]);
	});

	it("returns empty array for empty directory", async () => {
		const results = await discoverPlugins(tmpDir);
		expect(results).toEqual([]);
	});

	it("skips subdirectories without PLUGIN.md", async () => {
		const noPluginDir = path.join(tmpDir, "no-plugin");
		await fs.mkdir(noPluginDir, { recursive: true });
		await fs.writeFile(path.join(noPluginDir, "README.md"), "# Not a plugin");

		const results = await discoverPlugins(tmpDir);
		expect(results).toEqual([]);
	});

	it("skips disabled plugins (PLUGIN.md.disabled)", async () => {
		const pluginDir = path.join(tmpDir, "disabled-plugin");
		await fs.mkdir(pluginDir, { recursive: true });
		await fs.writeFile(
			path.join(pluginDir, "PLUGIN.md.disabled"),
			MINIMAL_FRONTMATTER,
		);

		const results = await discoverPlugins(tmpDir);
		expect(results).toEqual([]);
	});
});

// ── loadPluginSummary ───────────────────────────────────────────

describe("loadPluginSummary", () => {
	it("loads summary for single-runtime plugin", async () => {
		const pluginDir = path.join(tmpDir, "summary-single");
		await fs.mkdir(pluginDir, { recursive: true });
		const fm = makeFrontmatter({
			name: "summary-single",
			description: "Summary test",
			pluginType: "core-plugin",
		});
		await fs.writeFile(path.join(pluginDir, "PLUGIN.md"), fm);

		const [discovery] = await discoverPlugins(tmpDir);
		const summary = await loadPluginSummary(discovery);

		expect(summary).toMatchObject({
			id: "summary-single",
			name: "summary-single",
			description: "Summary test",
			pluginType: "core-plugin",
			runtimeCount: 1,
		});
	});

	it("loads summary for multi-runtime plugin from root PLUGIN.md", async () => {
		const pluginDir = path.join(tmpDir, "summary-multi");
		await fs.mkdir(path.join(pluginDir, "runtimes", "rt-a"), {
			recursive: true,
		});
		await fs.mkdir(path.join(pluginDir, "runtimes", "rt-b"), {
			recursive: true,
		});
		await fs.writeFile(
			path.join(pluginDir, "PLUGIN.md"),
			makeFrontmatter({
				name: "summary-multi",
				description: "Multi summary",
				pluginType: "core-plugin",
			}),
		);
		await fs.writeFile(
			path.join(pluginDir, "runtimes", "rt-a", "PLUGIN.md"),
			makeFrontmatter({ name: "rt-a", description: "Runtime A" }),
		);
		await fs.writeFile(
			path.join(pluginDir, "runtimes", "rt-b", "PLUGIN.md"),
			makeFrontmatter({ name: "rt-b", description: "Runtime B" }),
		);

		const [discovery] = await discoverPlugins(tmpDir);
		const summary = await loadPluginSummary(discovery);

		expect(summary.id).toBe("summary-multi");
		expect(summary.name).toBe("summary-multi");
		expect(summary.description).toBe("Multi summary");
		expect(summary.runtimeCount).toBe(2);
	});
});

// ── loadPluginManifest ──────────────────────────────────────────

describe("loadPluginManifest", () => {
	it("returns array with 1 ParsedPluginMd for single-runtime", async () => {
		const pluginDir = path.join(tmpDir, "manifest-single");
		await fs.mkdir(pluginDir, { recursive: true });
		await fs.writeFile(path.join(pluginDir, "PLUGIN.md"), MINIMAL_FRONTMATTER);

		const [discovery] = await discoverPlugins(tmpDir);
		const manifests = await loadPluginManifest(discovery);

		expect(manifests).toHaveLength(1);
		expect(manifests[0].manifest.name).toBe("test-plugin");
		expect(manifests[0].promptTemplate).toContain("You are a test agent.");
	});

	it("returns array with N ParsedPluginMd for multi-runtime", async () => {
		const pluginDir = path.join(tmpDir, "manifest-multi");
		await fs.mkdir(path.join(pluginDir, "runtimes", "rt-a"), {
			recursive: true,
		});
		await fs.mkdir(path.join(pluginDir, "runtimes", "rt-b"), {
			recursive: true,
		});
		await fs.writeFile(
			path.join(pluginDir, "runtimes", "rt-a", "PLUGIN.md"),
			makeFrontmatter({ name: "rt-a", description: "Runtime A" }),
		);
		await fs.writeFile(
			path.join(pluginDir, "runtimes", "rt-b", "PLUGIN.md"),
			makeFrontmatter({ name: "rt-b", description: "Runtime B" }),
		);

		const [discovery] = await discoverPlugins(tmpDir);
		const manifests = await loadPluginManifest(discovery);

		expect(manifests).toHaveLength(2);
		const names = manifests.map((m) => m.manifest.name).sort();
		expect(names).toEqual(["rt-a", "rt-b"]);
	});
});

// ── loadRuntime ─────────────────────────────────────────────────

describe("loadRuntime", () => {
	it("loads prompt template and references", async () => {
		const pluginDir = path.join(tmpDir, "runtime-refs");
		await fs.mkdir(pluginDir, { recursive: true });
		await fs.mkdir(path.join(pluginDir, "references"), { recursive: true });
		await fs.writeFile(path.join(pluginDir, "PLUGIN.md"), MINIMAL_FRONTMATTER);
		await fs.writeFile(
			path.join(pluginDir, "references", "lore.md"),
			"---\nkeywords:\n  - dragon\n---\n\nDragon lore content.\n",
		);

		const [discovery] = await discoverPlugins(tmpDir);
		const loaded = await loadRuntime(discovery, "test-plugin");

		expect(loaded.manifest.name).toBe("test-plugin");
		expect(loaded.promptTemplate).toContain("You are a test agent.");
		expect(loaded.references).toHaveLength(1);
		expect(loaded.references[0].keywords).toContain("dragon");
		expect(loaded.references[0].content).toContain("Dragon lore content.");
	});

	it("loads output schema when present", async () => {
		const pluginDir = path.join(tmpDir, "runtime-schema");
		await fs.mkdir(pluginDir, { recursive: true });
		await fs.writeFile(path.join(pluginDir, "PLUGIN.md"), MINIMAL_FRONTMATTER);
		const schema = {
			type: "object",
			properties: { result: { type: "string" } },
		};
		await fs.writeFile(
			path.join(pluginDir, "output.schema.json"),
			JSON.stringify(schema),
		);

		const [discovery] = await discoverPlugins(tmpDir);
		const loaded = await loadRuntime(discovery, "test-plugin");

		expect(loaded.outputSchema).toEqual(schema);
	});

	it("handles missing references and schema gracefully", async () => {
		const pluginDir = path.join(tmpDir, "runtime-bare");
		await fs.mkdir(pluginDir, { recursive: true });
		await fs.writeFile(path.join(pluginDir, "PLUGIN.md"), MINIMAL_FRONTMATTER);

		const [discovery] = await discoverPlugins(tmpDir);
		const loaded = await loadRuntime(discovery, "test-plugin");

		expect(loaded.references).toEqual([]);
		expect(loaded.outputSchema).toBeUndefined();
	});
});
