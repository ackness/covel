/**
 * Plugin scaffolder — generates a minimal Covel plugin in three flavours.
 *
 * Goal: let a plugin author go from idea to "file loads without errors"
 * in under one minute. The scaffolder produces a README.md + PLUGIN.md +
 * package.json set (plus an optional tool skeleton) and never talks to an LLM.
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
  /** Priority band (defaults per template). Ignored for zero-code/manual. */
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

function defaultPriority(template: PluginTemplate): number | undefined {
  // Stay inside After-Narrator band by default so new plugins pick up
  // narrator output without fighting the narrator itself.
  if (template === "zero-code") return undefined;
  if (template === "function") return 800;
  return 600;
}

function renderPluginMd(
  options: Required<Pick<CreatePluginOptions, "name" | "template">> &
    Pick<CreatePluginOptions, "priority"> & { description: string },
): string {
  const { name, template, priority, description } = options;
  const common = `---
name: ${name}
description:
  en: ${description}
  zh: ${description}
pluginType: plugin
${priority === undefined ? "" : `priority: ${priority}\n`}`;
  if (template === "zero-code") {
    return (
      common +
      `model: plugin
outputKind: system
trigger:
  type: manual
---

# ${name}

Describe the manual skill this runtime performs. Keep it focused on one
plugin-owned responsibility and call \`runtime-done\` when the work is complete.
`
    );
  }
  if (template === "function") {
    return (
      common +
      `outputKind: system
runtimeType: function
handler: ./handler.js
trigger:
  type: scheduled
  interval: 1
---

# ${name}

Pure-function runtime. Edit \`handler.js\` to do the deterministic state update
or data transformation you need. No LLM is involved.
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

Agent runtime. The block above is shared context; the Markdown below is the
runtime prompt the LLM sees every turn.

## Plugin Goal

Replace this with the real goal. Examples: track player promises, maintain quest
clues, record world-rule changes, or preserve reusable combat state.

## Tool Contract

Call \`${name}-tool\` only when the current narrative contains new information
that should become plugin-owned state. After the tool call, immediately call
\`runtime-done\`. If there is nothing useful to record, call \`runtime-done\`
without writing.
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
        "@covel/tools": "workspace:*",
        vitest: "^4.1.4",
      },
    },
    null,
    2,
  )}\n`;
}

function renderReadme(
  options: Required<Pick<CreatePluginOptions, "name" | "template">> & {
    description: string;
  },
): string {
  const runtimeSummary =
    options.template === "function"
      ? "`handler.js` 中的纯函数 runtime，执行确定性代码，不调用模型。"
      : options.template === "agent"
        ? "`PLUGIN.md` 中的 agent runtime；Markdown 正文是运行时提示词，`tools/` 保存可选本地工具。"
        : "`PLUGIN.md` 中的纯提示词手动 runtime；Markdown 正文是运行时提示词。";

  return `# ${options.name}

${options.description}

## 功能

用一到两段话说明这个插件解决什么玩家问题，以及玩家会在界面中看到什么。

## 实现

- 模板：\`${options.template}\`
- Runtime: ${runtimeSummary}
- 入口文件：\`PLUGIN.md\`

## 开发

1. 修改 \`README.md\`，维护给人类和开发者看的说明。
2. 修改 \`PLUGIN.md\`，维护 runtime 元信息和模型指令。
3. 添加测试后，在插件目录运行 \`pnpm test\`。
`;
}

function renderAgentTool(name: string): string {
  return `/**
 * ${name}-tool — local tool wired into the ${name} plugin.
 *
 * The framework injects tool, z, shortId, and withPendingProposals at load
 * time. Return pending proposals when the tool should persist plugin state.
 */

export default function ({ tool, z, shortId, withPendingProposals }) {
  return tool({
    name: '${name}-tool',
    description: 'Record one structured note for the ${name} plugin.',
    parameters: z.object({
      title: z.string().min(1).max(80).describe('Short title'),
      text: z.string().min(1).max(500).describe('One or two concrete sentences'),
      tags: z.array(z.string().min(1)).max(5).default([]).describe('Tags'),
    }),
    async execute(params, context) {
      const key = shortId('note', params.title, context.sessionId);
      const now = new Date().toISOString();
      const note = {
        kind: 'note',
        title: params.title,
        text: params.text,
        tags: params.tags,
        turnId: context.turnId,
        createdAt: now,
      };

      return withPendingProposals({ recorded: true, key, note }, [
        {
          id: crypto.randomUUID(),
          type: 'plugin.data',
          source: {
            pluginId: context.pluginId,
            runtimeId: context.runtimeId,
          },
          turnId: context.turnId,
          sessionId: context.sessionId,
          payload: {
            namespace: 'notes',
            key,
            value: note,
          },
          timestamp: now,
        },
      ]);
    },
  });
}
`;
}

function renderFunctionRuntime(name: string): string {
  return `/**
 * ${name} — pure function runtime.
 *
 * Return a plain object. The runtime normalizer turns supported fields such as
 * pluginData[] into proposals during commit.
 */

export default async function run(context) {
  const title =
    typeof context.manualPayload?.title === 'string'
      ? context.manualPayload.title
      : 'Scheduled checkpoint';
  const now = new Date().toISOString();
  const key = \`note-\${Date.now().toString(36)}\`;

  return {
    status: 'ok',
    pluginData: [
      {
        namespace: 'notes',
        key,
        value: {
          kind: 'function',
          title,
          text: 'Replace this with deterministic plugin logic.',
          createdAt: now,
        },
      },
    ],
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

  const priority =
    template === "zero-code"
      ? undefined
      : (options.priority ?? defaultPriority(template));
  const description = options.description?.trim() || `${name} plugin`;

  await mkdir(pluginDir, { recursive: true });

  const files: string[] = [];
  const writes: Array<[string, string]> = [
    ["README.md", renderReadme({ name, template, description })],
    ["PLUGIN.md", renderPluginMd({ name, template, priority, description })],
    ["package.json", renderPackageJson(name)],
  ];

  if (template === "agent") {
    writes.push([path.join("tools", `${name}-tool.js`), renderAgentTool(name)]);
  } else if (template === "function") {
    writes.push(["handler.js", renderFunctionRuntime(name)]);
  }

  for (const [rel, content] of writes) {
    const abs = path.join(pluginDir, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
    files.push(abs);
  }

  const notes: string[] = [];
  if (template === "zero-code" && options.priority !== undefined) {
    notes.push(
      "Zero-code plugins use a manual trigger, so the supplied priority was ignored.",
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
