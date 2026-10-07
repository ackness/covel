#!/usr/bin/env node

/**
 * Covel 插件脚手架脚本
 *
 * 用法：
 *   node scripts/create-plugin.js <plugin-name>                                     # 默认：多 runtime 插件工作台
 *   node scripts/create-plugin.js <plugin-name> -t <target-dir>                     # 自定义目标目录
 *   node scripts/create-plugin.js <plugin-name> -r <runtime-spec>                   # 自定义 runtime 列表
 *   node scripts/create-plugin.js <plugin-name> -r foo:function,bar:agent           # 多 runtime + 类型
 *   node scripts/create-plugin.js <plugin-name> --with-tools                        # 单 runtime + tools/（仓库内）
 *
 * 选项：
 *   -t, --target <dir>    Override COVEL_USER_PLUGINS_DIR / COVEL_HOME/plugins / ~/.covel/plugins
 *   -r, --runtimes <list> 用逗号分隔的 runtime 列表，每项为 name 或 name:type
 *                         type ∈ { function, agent }（默认 agent）
 *   --with-tools          内联单 runtime 带 tools/，目标固定为 <repo>/plugins/
 *
 * 示例：
 *   node scripts/create-plugin.js session-notes
 *   node scripts/create-plugin.js my-plugin -t ./plugins
 *   node scripts/create-plugin.js my-plugin -r recorder:function,analyst:agent
 *   node scripts/create-plugin.js my-plugin -t ~/.covel/plugins -r api-bridge:function
 */

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  statSync,
  existsSync,
} from "node:fs";
import { resolve, join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, "..");
const DEFAULT_TARGET =
  process.env.COVEL_USER_PLUGINS_DIR?.trim() ||
  join(process.env.COVEL_HOME?.trim() || join(homedir(), ".covel"), "plugins");
const VALID_RUNTIME_TYPES = new Set(["function", "agent"]);
const DEFAULT_RUNTIME_TYPE = "agent";

// ── 参数解析 ──────────────────────────────────────────────────────

const argv = process.argv.slice(2);

function takeFlagValue(flagShort, flagLong) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === flagShort || a === flagLong) {
      const v = argv[i + 1];
      if (!v || v.startsWith("-")) {
        console.error(`错误：${a} 需要一个值。`);
        process.exit(1);
      }
      argv.splice(i, 2);
      return v;
    }
    const eqPrefix = `${flagLong}=`;
    if (a.startsWith(eqPrefix)) {
      const v = a.slice(eqPrefix.length);
      argv.splice(i, 1);
      return v;
    }
  }
  return undefined;
}

function takeBoolFlag(flagLong) {
  const idx = argv.indexOf(flagLong);
  if (idx === -1) return false;
  argv.splice(idx, 1);
  return true;
}

const targetArg = takeFlagValue("-t", "--target");
const runtimesArg = takeFlagValue("-r", "--runtimes");
const withTools = takeBoolFlag("--with-tools");
const showHelp = takeBoolFlag("--help") || takeBoolFlag("-h");

if (showHelp) {
  printUsage();
  process.exit(0);
}

const pluginName = argv.find((a) => !a.startsWith("-"));

if (!pluginName) {
  console.error("错误：请提供插件名称。\n");
  printUsage();
  process.exit(1);
}

if (!/^[a-z][a-z0-9-]*$/.test(pluginName)) {
  console.error(
    "错误：插件名称只能包含小写字母、数字和连字符，且必须以字母开头。",
  );
  console.error(`  收到：${pluginName}`);
  process.exit(1);
}

if (withTools && (targetArg || runtimesArg)) {
  console.error(
    "错误：--with-tools 是内联单 runtime 模式，不能与 -t / -r 同用。",
  );
  process.exit(1);
}

// ── 模式选择 ──────────────────────────────────────────────────────

const mode = withTools
  ? "with-tools"
  : runtimesArg
    ? "custom-multi-runtime"
    : "demo-multi-runtime";

const targetBaseDir = withTools
  ? resolve(ROOT, "plugins")
  : resolve(targetArg ?? DEFAULT_TARGET);
const targetDir = join(targetBaseDir, pluginName);

if (existsSync(targetDir)) {
  console.error(`错误：目录已存在 → ${targetDir}`);
  console.error("请选择其他名称或先删除已有目录。");
  process.exit(1);
}

const placeholders = {
  "{{pluginName}}": pluginName,
  // Manifests are English; the Chinese text goes to locales/zh.yaml and README.
  "{{pluginDescription}}": `${pluginName} plugin - replace with a short plugin description.`,
  "{{pluginDescriptionZh}}": `${pluginName} 插件 - 请在此填写插件描述。`,
};

function replacePlaceholders(content) {
  let result = content;
  for (const [placeholder, value] of Object.entries(placeholders)) {
    result = result.replaceAll(placeholder, value);
  }
  return result;
}

function copyDir(src, dest) {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src)) {
    if (entry === "node_modules") continue;
    const srcPath = join(src, entry);
    const destPath = join(dest, entry);
    const stat = statSync(srcPath);
    if (stat.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      const content = readFileSync(srcPath, "utf-8");
      writeFileSync(destPath, replacePlaceholders(content), "utf-8");
    }
  }
}

function listFiles(dir) {
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      listFiles(fullPath);
    } else {
      console.log(`  ${relative(process.cwd(), fullPath)}`);
    }
  }
}

// ── 模式执行 ──────────────────────────────────────────────────────

console.log(`\n正在创建插件：${pluginName}`);
console.log(`目标：${targetDir}`);
console.log(`模式：${mode}\n`);

switch (mode) {
  case "with-tools":
    runTemplate("plugin-with-tools");
    break;
  case "demo-multi-runtime":
    runTemplate("plugin-multi-runtime");
    break;
  case "custom-multi-runtime":
    runCustomMultiRuntime(parseRuntimeSpec(runtimesArg));
    break;
}

console.log("已生成文件：");
listFiles(targetDir);

console.log("\n下一步：");
if (mode === "with-tools") {
  console.log(
    `  1. 编辑 ${relative(process.cwd(), targetDir)}/README.md，填写给开发者看的插件说明`,
  );
  console.log(
    `  2. 编辑 ${relative(process.cwd(), targetDir)}/PLUGIN.md，填写 runtime 元信息和提示词`,
  );
  console.log(`  3. 修改 tools/record-note.js，实现工具逻辑`);
  console.log(
    "  4. 提示词定稿后新增 PLUGIN.zh.md（内置插件必须有简体中文提示词），再运行 pnpm prompts:lock",
  );
  console.log(
    `  5. 在 Covel 仓库根目录运行 pnpm --filter @covel/plugin-${pluginName} test`,
  );
  console.log(
    `  6. 在 Covel 仓库根目录运行 pnpm test:runtime -- ${pluginName} --plugins-dir ${targetBaseDir} --pretty`,
  );
} else {
  console.log(
    `  1. 检查 ${relative(process.cwd(), targetDir)}/README.md，填写给开发者看的插件说明`,
  );
  console.log(
    `  2. 检查 ${relative(process.cwd(), targetDir)}/runtimes/<name>/RUNTIME.md，按需修改`,
  );
  if (mode === "demo-multi-runtime") {
    console.log("  3. 默认包含 note (function) + analyst (agent) 两个 runtime");
    console.log("  4. 启动框架后侧栏会出现插件记录面板，按按钮验证");
  } else {
    console.log(
      "  3. 函数 runtime 编辑 handler.js，agent runtime 编辑 RUNTIME.md 提示词",
    );
  }
  console.log(
    "  注意：清单和提示词写 English；中文的名称与说明写在 locales/zh.yaml",
  );
  if (targetBaseDir !== DEFAULT_TARGET) {
    console.log(
      `  5. Set COVEL_USER_PLUGINS_DIR to ${targetBaseDir} so the server discovers this plugin.`,
    );
    console.log(
      `  6. 运行 pnpm test:runtime -- ${pluginName} --plugins-dir ${targetBaseDir} --pretty`,
    );
  } else {
    console.log(
      `  5. 运行 pnpm test:runtime -- ${pluginName} --plugins-dir ${targetBaseDir} --pretty`,
    );
  }
}

console.log(`\n插件创建完成！路径：${targetDir}\n`);

// ── 实现 ──────────────────────────────────────────────────────────

function runTemplate(templateName) {
  const templateDir = resolve(ROOT, "templates", templateName);
  if (!existsSync(templateDir)) {
    console.error(`错误：找不到模板目录 → templates/${templateName}/`);
    process.exit(1);
  }
  copyDir(templateDir, targetDir);
}

function parseRuntimeSpec(spec) {
  const items = spec
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (items.length === 0) {
    console.error("错误：-r 至少需要一个 runtime 名。");
    process.exit(1);
  }

  const seen = new Set();
  return items.map((item) => {
    const [rawName, rawType] = item.split(":").map((s) => s.trim());
    if (!rawName || !/^[a-z][a-z0-9-]*$/.test(rawName)) {
      console.error(
        `错误：runtime 名称 "${rawName}" 不合法（小写字母、数字、连字符，字母开头）。`,
      );
      process.exit(1);
    }
    if (seen.has(rawName)) {
      console.error(`错误：runtime 名称 "${rawName}" 重复。`);
      process.exit(1);
    }
    seen.add(rawName);
    const type = rawType ?? DEFAULT_RUNTIME_TYPE;
    if (!VALID_RUNTIME_TYPES.has(type)) {
      console.error(
        `错误：runtime 类型 "${type}" 不合法，必须是 function 或 agent。`,
      );
      process.exit(1);
    }
    return { name: rawName, type };
  });
}

function runCustomMultiRuntime(runtimes) {
  // 复用多 runtime 模板的 root package 配置，跳过默认 runtimes / tests / README。
  const baseTemplateDir = resolve(ROOT, "templates", "plugin-multi-runtime");
  if (!existsSync(baseTemplateDir)) {
    console.error(
      "错误：找不到 templates/plugin-multi-runtime/ —— 用 git status 确认未被删除。",
    );
    process.exit(1);
  }
  mkdirSync(targetDir, { recursive: true });
  for (const entry of readdirSync(baseTemplateDir)) {
    if (
      entry === "runtimes" ||
      entry === "tests" ||
      entry === "locales" ||
      entry === "PLUGIN.md" ||
      entry === "README.md" ||
      entry === "node_modules"
    ) {
      continue;
    }
    const srcPath = join(baseTemplateDir, entry);
    const destPath = join(targetDir, entry);
    const stat = statSync(srcPath);
    if (stat.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      writeFileSync(
        destPath,
        replacePlaceholders(readFileSync(srcPath, "utf-8")),
        "utf-8",
      );
    }
  }

  // Custom runtimes do not include the demo's note panel.
  // The agent stub reads the narrator's output, so the package names the contract.
  const optional = runtimes.some((runtime) => runtime.type === "agent")
    ? "optional: [narrative-engine@1]\n"
    : "";
  writeFileSync(
    join(targetDir, "PLUGIN.md"),
    `---\nid: ${pluginName}\ndescription: ${placeholders["{{pluginDescription}}"]}\nkind: plugin\n${optional}---\n`,
    "utf-8",
  );
  mkdirSync(join(targetDir, "locales"), { recursive: true });
  writeFileSync(
    join(targetDir, "locales", "zh.yaml"),
    renderChineseLabels(runtimes),
    "utf-8",
  );

  writeFileSync(
    join(targetDir, "README.md"),
    renderCustomReadme(runtimes),
    "utf-8",
  );
  mkdirSync(join(targetDir, "tests"), { recursive: true });
  writeFileSync(
    join(targetDir, "tests", "runtime-cases.json"),
    renderCustomRuntimeCases(runtimes),
    "utf-8",
  );

  for (const rt of runtimes) {
    const rtDir = join(targetDir, "runtimes", rt.name);
    mkdirSync(rtDir, { recursive: true });
    if (rt.type === "function") {
      writeFileSync(
        join(rtDir, "RUNTIME.md"),
        renderFunctionStubManifest(rt.name),
        "utf-8",
      );
      writeFileSync(
        join(rtDir, "handler.js"),
        renderFunctionStubHandler(rt.name),
        "utf-8",
      );
    } else {
      writeFileSync(
        join(rtDir, "RUNTIME.md"),
        renderAgentStubManifest(rt.name),
        "utf-8",
      );
    }
  }
}

function renderChineseLabels(runtimes) {
  const sections = runtimes
    .map(
      (rt) =>
        `runtimes/${rt.name}/RUNTIME.md:\n  description: ${rt.name} ${rt.type === "function" ? "函数" : "agent"} runtime，请填写它的职责。\n`,
    )
    .join("");
  return `# Chinese text of this plugin.
# A section named after a manifest file translates its labels, under the same keys.
# messages translates the UI: English text, then its translation.
PLUGIN.md:
  description: ${placeholders["{{pluginDescriptionZh}}"]}
${sections}`;
}

function renderFunctionStubManifest(runtimeName) {
  return `---
type: function
description: ${runtimeName} function runtime, replace with the real responsibility.
schedule:
  trigger: { type: manual }
  manual: { execution: sync }
io:
  visibility: plugin
function:
  handler: ./handler.js
---
`;
}

function renderFunctionStubHandler(runtimeName) {
  return `/**
 * @covel/plugin-${pluginName} — ${runtimeName} handler
 *
 * Manual function runtime for deterministic plugin-owned state updates.
 * Replace the notes record below with your real plugin state.
 */

const NOTES_NAMESPACE = 'notes';

/** @type {import("@covel/plugin-handlers-utils").PluginFunctionHandler} */
export default async function ${camelize(runtimeName)}Handler(ctx) {
  const { pluginData, logger, manualPayload, turnId, random } = ctx;

  if (!pluginData || typeof pluginData.set !== 'function') {
    return {
      outcome: 'failed',
      error: 'This handler requires plugin data writes.',
    };
  }

  const title =
    typeof manualPayload?.title === 'string' && manualPayload.title.trim()
      ? manualPayload.title.trim()
      : '${runtimeName} checkpoint';
  const now = new Date().toISOString();
  if (!random) throw new Error('The host must provide ctx.random');
  let key;
  do {
    key = \`${runtimeName}-\${random.int(0, 0x100000000).toString(36)}\`;
  } while (await pluginData.get(NOTES_NAMESPACE, key));
  const note = {
    kind: 'function',
    title,
    text: 'Replace this with deterministic plugin logic.',
    turnId,
    createdAt: now,
  };

  await pluginData.set(NOTES_NAMESPACE, key, note);
  await logger?.info?.('${runtimeName}.recorded', { key, title });

  return { outcome: 'success', value: { note } };
}
`;
}

function renderAgentStubManifest(runtimeName) {
  return `---
type: agent
description: ${runtimeName} agent runtime, replace with the real responsibility.
schedule:
  stage: post-turn
  trigger: { type: auto }
io:
  inputs:
    narrator-output:
      from:
        contract: narrative-engine@1
      select: /narrativeOutput
      required: false
  visibility: plugin
  selfData:
    - namespace: notes
      as: <existing-notes>
      format: summary
      maxEntries: 50
agent:
  model: plugin
  tools:
    builtin: [plugin-data-set]
  loop:
    timeoutMs: 60000
    callTimeoutMs: 45000
    firstTokenTimeoutMs: 30000
    maxRetries: 1
---

You are the ${runtimeName} runtime in the ${pluginName} plugin. Your job is to turn narrative information relevant to this plugin into one maintainable plugin note.

## Plugin Goal

Replace this section with the real goal. Examples: track player promises, record world-rule changes, maintain quest clues, or preserve reusable combat state.

## Inputs

\`runtime-inputs.narrator-output.value\` is the latest narrative text produced by the narrator this turn. It may be empty.

\`<existing-notes>\` is a compact summary of records already stored in this plugin's \`notes\` namespace. Use it to avoid duplicate writes.

## Decision Rules

- If \`runtime-inputs.narrator-output.value\` is empty, call \`runtime-done\` and stop.
- If there is no new information relevant to the plugin goal, call \`runtime-done\` and stop.
- If existing notes already cover the same fact, call \`runtime-done\` and stop.
- If there is useful new information, call \`plugin-data-set\` once to write into \`notes\`, then immediately call \`runtime-done\`.

## Write Shape

Call \`plugin-data-set\` with:

| Param       | Value |
| ----------- | ----- |
| \`namespace\` | \`notes\` |
| \`key\`       | \`${runtimeName}-\` plus a stable short fact key |
| \`value\`     | \`{ "kind": "analysis", "title": "<short title>", "text": "<one or two actionable sentences>", "tags": ["<1-3 tags>"] }\` |

Keep the note short and concrete. Do not emit explanatory prose.
`;
}

function renderCustomReadme(runtimes) {
  const lines = runtimes
    .map(
      (rt) =>
        `- \`${rt.name}\` (${rt.type}) — 请在对应 RUNTIME.md 中填写职责。`,
    )
    .join("\n");
  return `# ${pluginName}

${placeholders["{{pluginDescriptionZh}}"]}

## Runtime

${lines}

## 开发

1. 修改 \`README.md\`，维护给人类和开发者看的说明。
2. 修改 \`runtimes/<name>/RUNTIME.md\`，维护 runtime 元信息和模型指令。
3. 函数 runtime 修改 \`handler.js\`；agent runtime 修改 Markdown prompt。
4. \`PLUGIN.md\` 和 \`RUNTIME.md\` 只写 English；中文的名称与说明写在 \`locales/zh.yaml\`。提示词的简体中文版本是可选的 \`RUNTIME.zh.md\`，有了它就必须和 English 正文同步修改。
5. 在 Covel 仓库根目录运行 \`pnpm validate:plugin <插件目录>\` 做静态校验，再运行 \`pnpm test:runtime -- ${pluginName} --plugins-dir <plugins-dir> --pretty\`（\`<plugins-dir>\` 为本插件的上级目录）。
`;
}

function renderCustomRuntimeCases(runtimes) {
  const cases = runtimes.map((rt) => {
    if (rt.type === "function") {
      return {
        name: `${rt.name}-manual-records-note`,
        runtimeId: `${pluginName}/${rt.name}`,
        payload: { title: `${rt.name} test checkpoint` },
        expect: {
          runtimeResults: [
            { runtimeId: `${pluginName}/${rt.name}`, status: "success" },
          ],
          pluginData: [{ namespace: "notes", field: "title" }],
          logs: [`${rt.name}.recorded`],
        },
      };
    }
    return {
      name: `${rt.name}-agent-records-note`,
      runtimeId: `${pluginName}/${rt.name}`,
      message: "The player promised the gatekeeper to return before dawn.",
      llmResponses: [
        {
          content: null,
          finishReason: "tool_calls",
          toolCalls: [
            {
              id: `tc-${rt.name}-record`,
              name: "plugin-data-set",
              arguments: JSON.stringify({
                namespace: "notes",
                key: `${rt.name}-test`,
                value: {
                  kind: "analysis",
                  title: `${rt.name} test note`,
                  text: "The player promised the gatekeeper to return before dawn.",
                  tags: ["test"],
                },
              }),
            },
            {
              id: `tc-${rt.name}-done`,
              name: "runtime-done",
              arguments: JSON.stringify({ reason: "recorded" }),
            },
          ],
        },
      ],
      expect: {
        runtimeResults: [
          { runtimeId: `${pluginName}/${rt.name}`, status: "success" },
        ],
        pluginData: [
          { namespace: "notes", key: `${rt.name}-test`, field: "title" },
        ],
      },
    };
  });

  return `${JSON.stringify({ cases }, null, 2)}\n`;
}

function camelize(name) {
  return name.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
}

function printUsage() {
  console.log("用法：");
  console.log(
    "  node scripts/create-plugin.js <plugin-name>                  # 默认多 runtime 插件工作台",
  );
  console.log(
    "  node scripts/create-plugin.js <plugin-name> -t <dir>         # 自定义目标",
  );
  console.log(
    "  node scripts/create-plugin.js <plugin-name> -r foo:function  # 自定义 runtime",
  );
  console.log(
    "  node scripts/create-plugin.js <plugin-name> --with-tools     # 内联单 runtime",
  );
  console.log("");
  console.log("选项：");
  console.log(
    "  -t, --target <dir>    Target directory; overrides COVEL_USER_PLUGINS_DIR, COVEL_HOME/plugins, ~/.covel/plugins.",
  );
  console.log(
    "  -r, --runtimes <list> 逗号分隔的 runtime 列表，每项为 name 或 name:type",
  );
  console.log("                        type ∈ { function, agent }，默认 agent");
  console.log(
    "  --with-tools          内联单 runtime + tools/，目标固定为 <repo>/plugins/",
  );
}
