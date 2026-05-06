/**
 * Plugin scaffolder — generates a minimal Covel plugin in three flavours.
 *
 * Goal: let a plugin author go from idea to "file loads without errors"
 * in under one minute. The scaffolder produces a PLUGIN.md + package.json
 * pair (plus an optional tool skeleton) and never talks to an LLM.
 *
 * Template choices:
 *   - `zero-code` : manual trigger + skill prompt only. No tools, no local code.
 *                   Ideal for "prompt-only" plugins the user wants to tweak.
 *   - `agent`     : auto trigger + LLM-backed runtime with one local tool.
 *                   Ideal for real gameplay plugins.
 *   - `function`  : runtimeType=function, pure-JS handler, no LLM.
 *                   Ideal for pure side-effect / data plumbing plugins.
 *
 * The scaffolder is intentionally dumb: it writes files, runs a minimal
 * validation, and returns the list of files written. CLI wrapping lives
 * in scripts/create-plugin.ts.
 */

import { mkdir, writeFile, stat } from "node:fs/promises";
import path from "node:path";

export type PluginTemplate = "zero-code" | "agent" | "function";

export interface CreatePluginOptions {
	/** Plugin id — must match /^[a-z][a-z0-9-]{1,63}$/ and be unique on disk. */
	readonly name: string;
	/** Which template to scaffold. */
	readonly template: PluginTemplate;
	/** Human-readable description (defaults to "{{name}} plugin"). */
	readonly description?: string;
	/** Parent directory to write into — will contain `<name>/`. */
	readonly outputDir: string;
	/** Priority band (defaults per template). */
	readonly priority?: number;
	/** Overwrite an existing directory. Defaults to false. */
	readonly force?: boolean;
}

export interface CreatePluginResult {
	readonly success: boolean;
	/** Absolute paths of files written. */
	readonly files: readonly string[];
	/** Final plugin directory (absolute). */
	readonly pluginDir: string;
	/** Normalised plugin name (== directory name). */
	readonly name: string;
	/** Non-fatal notes for the caller to surface. */
	readonly notes: readonly string[];
}

const NAME_RX = /^[a-z][a-z0-9-]{1,63}$/;

function assertValidName(name: string): void {
	if (!NAME_RX.test(name)) {
		throw new Error(
			`Invalid plugin name "${name}". Use 2–64 chars, lowercase letters, digits, or "-", starting with a letter.`,
		);
	}
}

async function pathExists(p: string): Promise<boolean> {
	try {
		await stat(p);
		return true;
	} catch {
		return false;
	}
}

function defaultPriority(template: PluginTemplate): number {
	// Stay inside After-Narrator band by default so new plugins pick up
	// narrator output without fighting the narrator itself.
	if (template === "zero-code") return 700;
	if (template === "function") return 800;
	return 600;
}

function renderPluginMd(
	options: Required<
		Pick<CreatePluginOptions, "name" | "template" | "priority">
	> & { description: string },
): string {
	const { name, template, priority, description } = options;
	const common = `---
name: ${name}
description:
  en: ${description}
  zh: ${description}
pluginType: plugin
priority: ${priority}
`;
	if (template === "zero-code") {
		return (
			common +
			`model: plugin
outputKind: system
trigger:
  type: manual
---

# ${name}

Replace this prose with the skill you want the plugin runtime to perform.
Triggering is manual — wire it up to a player command or another plugin's
event before it will run.
`
		);
	}
	if (template === "function") {
		return (
			common +
			`outputKind: system
runtime:
  type: function
  handler: ./runtime.js
trigger:
  type: scheduled
  interval: 1
---

# ${name}

Pure-function runtime. Edit \`runtime.js\` to do whatever side-effect or
data transformation you need. No LLM involved.
`
		);
	}
	// agent
	return (
		common +
		`model: plugin
outputKind: system
timeoutMs: 120000
promptVersion: 2
trigger:
  type: scheduled
  interval: 1
tools:
  local:
    - ./tools/${name}-tool.js
---

# ${name}

Agent runtime. The block above is shared context; write the actual skill
prompt below — this is what the LLM sees every turn.

## Skill

Describe what this plugin is supposed to *do* in plain language. You can
call \`${name}-tool\` (defined in \`tools/\`) and \`runtime-done\` when you're
finished.
`
	);
}

function renderPackageJson(name: string): string {
	return `${JSON.stringify(
		{
			name: `@covel/plugin-${name}`,
			version: "0.0.1-beta",
			private: true,
			type: "module",
			scripts: {
				test: "vitest run --passWithNoTests",
				"test:watch": "vitest",
			},
			devDependencies: {
				"@covel/plugin-test-utils": "workspace:*",
				"@covel/shared": "workspace:*",
				vitest: "^4.1.4",
			},
		},
		null,
		2,
	)}\n`;
}

function renderAgentTool(name: string): string {
	return `/**
 * ${name}-tool — local tool wired into the ${name} plugin.
 *
 * Covel local tools expose (input) => output. Throw on invalid input;
 * the runtime will surface the error to the caller.
 */

import { z } from 'zod';

export const schema = z.object({
  message: z.string().min(1, 'message is required'),
});

export default {
  name: '${name}-tool',
  description: 'Example local tool for the ${name} plugin.',
  schema,
  async handler(input) {
    const { message } = schema.parse(input);
    // TODO: replace with real behaviour.
    return { echoed: message };
  },
};
`;
}

function renderFunctionRuntime(name: string): string {
	return `/**
 * ${name} — pure function runtime.
 *
 * Return a \`RuntimeResult\` shape: { proposals?: Proposal[], output?: unknown }.
 * See docs/reference/plugins.md for the full contract.
 */

export default async function run(context) {
  // \`context\` carries turn + session state. Inspect context.input to see
  // what triggered this runtime.
  return {
    proposals: [],
    output: { ran: true, at: new Date().toISOString() },
  };
}
`;
}

export async function createPlugin(
	options: CreatePluginOptions,
): Promise<CreatePluginResult> {
	const { name, template, outputDir } = options;
	assertValidName(name);

	const pluginDir = path.resolve(outputDir, name);
	const exists = await pathExists(pluginDir);
	if (exists && !options.force) {
		throw new Error(
			`Directory already exists: ${pluginDir}\nUse force=true to overwrite.`,
		);
	}

	const priority = options.priority ?? defaultPriority(template);
	const description = options.description?.trim() || `${name} plugin`;

	await mkdir(pluginDir, { recursive: true });

	const files: string[] = [];
	const writes: Array<[string, string]> = [
		["PLUGIN.md", renderPluginMd({ name, template, priority, description })],
		["package.json", renderPackageJson(name)],
	];

	if (template === "agent") {
		writes.push([path.join("tools", `${name}-tool.js`), renderAgentTool(name)]);
	} else if (template === "function") {
		writes.push(["runtime.js", renderFunctionRuntime(name)]);
	}

	for (const [rel, content] of writes) {
		const abs = path.join(pluginDir, rel);
		await mkdir(path.dirname(abs), { recursive: true });
		await writeFile(abs, content, "utf8");
		files.push(abs);
	}

	const notes: string[] = [];
	if (template === "agent") {
		notes.push(
			"Agent template emits a local tool. Remember to install `zod` in your plugin package if you keep the schema validation.",
		);
	}
	notes.push(
		"Add the plugin to your dev config so it loads: either drop it under plugins/ in the repo, or point COVEL_PLUGINS_DIR at its parent folder.",
	);

	return {
		success: true,
		files,
		pluginDir,
		name,
		notes,
	};
}
