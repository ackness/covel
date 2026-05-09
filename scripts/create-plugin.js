#!/usr/bin/env node

/**
 * Covel 插件脚手架脚本
 *
 * 用法：
 *   node scripts/create-plugin.js <plugin-name>                                     # 默认：多 runtime hello-world
 *   node scripts/create-plugin.js <plugin-name> -t <target-dir>                     # 自定义目标目录
 *   node scripts/create-plugin.js <plugin-name> -r <runtime-spec>                   # 自定义 runtime 列表
 *   node scripts/create-plugin.js <plugin-name> -r foo:function,bar:agent           # 多 runtime + 类型
 *   node scripts/create-plugin.js <plugin-name> --with-tools                        # 旧：单 runtime + tools/（仓库内）
 *
 * 选项：
 *   -t, --target <dir>    目标目录，默认 ~/.covel/plugins
 *   -r, --runtimes <list> 用逗号分隔的 runtime 列表，每项为 name 或 name:type
 *                         type ∈ { function, agent }（默认 agent）
 *   --with-tools          旧式单 runtime 带 tools/，目标固定为 <repo>/plugins/
 *
 * 示例：
 *   node scripts/create-plugin.js hello-world
 *   node scripts/create-plugin.js my-plugin -t ./plugins
 *   node scripts/create-plugin.js my-plugin -r echo:function,assistant:agent
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
const DEFAULT_TARGET = join(homedir(), ".covel", "plugins");
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
    "错误：--with-tools 是旧式单 runtime 模式，不能与 -t / -r 同用。",
  );
  process.exit(1);
}

// ── 模式选择 ──────────────────────────────────────────────────────

const mode = withTools
  ? "legacy-with-tools"
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
  "{{pluginDescription}}": `${pluginName} 插件 —— 请在此填写插件描述。`,
  "{{packageManager}}": resolveRepoPackageManager(),
};

function resolveRepoPackageManager() {
  try {
    const repoPkg = JSON.parse(
      readFileSync(resolve(ROOT, "package.json"), "utf-8"),
    );
    if (
      typeof repoPkg.packageManager === "string" &&
      repoPkg.packageManager.length > 0
    ) {
      return repoPkg.packageManager;
    }
  } catch {
    // ignore — fall through to default
  }
  return "pnpm@10.33.0";
}

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
  case "legacy-with-tools":
    runLegacyTemplate("plugin-with-tools");
    break;
  case "demo-multi-runtime":
    runLegacyTemplate("plugin-multi-runtime");
    break;
  case "custom-multi-runtime":
    runCustomMultiRuntime(parseRuntimeSpec(runtimesArg));
    break;
}

console.log("已生成文件：");
listFiles(targetDir);

console.log("\n下一步：");
if (mode === "legacy-with-tools") {
  console.log(
    `  1. 编辑 ${relative(process.cwd(), targetDir)}/README.md，填写给开发者看的插件说明`,
  );
  console.log(
    `  2. 编辑 ${relative(process.cwd(), targetDir)}/PLUGIN.md，填写 runtime 元信息和提示词`,
  );
  console.log(`  3. 修改 tools/example.js，实现工具逻辑`);
  console.log(
    `  4. 在 ${relative(process.cwd(), targetDir)} 下跑 pnpm install && pnpm test`,
  );
} else {
  console.log(
    `  1. 检查 ${relative(process.cwd(), targetDir)}/README.md，填写给开发者看的插件说明`,
  );
  console.log(
    `  2. 检查 ${relative(process.cwd(), targetDir)}/runtimes/<name>/PLUGIN.md，按需修改`,
  );
  if (mode === "demo-multi-runtime") {
    console.log(
      "  3. 默认包含 echo (function) + summarizer (agent) 两个 runtime",
    );
    console.log("  4. 启动框架后侧栏会出现 Hello World 标签页，按按钮验证");
  } else {
    console.log(
      "  3. 函数 runtime 编辑 handler.js，agent runtime 编辑 PLUGIN.md 提示词",
    );
  }
  if (targetBaseDir !== DEFAULT_TARGET) {
    console.log(
      `  5. 如未在默认插件目录，请确认 COVEL_PLUGINS_DIR 指向 ${targetBaseDir}`,
    );
  }
}

console.log(`\n插件创建完成！路径：${targetDir}\n`);

// ── 实现 ──────────────────────────────────────────────────────────

function runLegacyTemplate(templateName) {
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
  // 复用多 runtime 模板的 root（package.json / .npmrc / README），跳过 runtimes/ 目录
  const baseTemplateDir = resolve(ROOT, "templates", "plugin-multi-runtime");
  if (!existsSync(baseTemplateDir)) {
    console.error(
      "错误：找不到 templates/plugin-multi-runtime/ —— 用 git status 确认未被删除。",
    );
    process.exit(1);
  }
  mkdirSync(targetDir, { recursive: true });
  for (const entry of readdirSync(baseTemplateDir)) {
    if (entry === "runtimes" || entry === "node_modules") continue;
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

  for (const rt of runtimes) {
    const rtDir = join(targetDir, "runtimes", rt.name);
    mkdirSync(rtDir, { recursive: true });
    if (rt.type === "function") {
      writeFileSync(
        join(rtDir, "PLUGIN.md"),
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
        join(rtDir, "PLUGIN.md"),
        renderAgentStubManifest(rt.name),
        "utf-8",
      );
    }
  }
}

function renderFunctionStubManifest(runtimeName) {
  return `---
name: ${pluginName}/${runtimeName}
description:
  zh: ${runtimeName} 函数 runtime —— 请填写它的职责。
  en: ${runtimeName} function runtime — replace with the real responsibility.
pluginType: plugin
runtimeType: function
handler: ./handler.js
outputKind: plugin
capabilities: [manual-invoke]
execution: sync
trigger:
  type: manual
---
`;
}

function renderFunctionStubHandler(runtimeName) {
  return `/**
 * @covel/plugin-${pluginName} — ${runtimeName} handler
 *
 * 在此实现函数 runtime 的副作用。可访问 ctx.{ pluginData, gateway, utils,
 * media, logger, userSettings, turnId, triggerEvent, manualPayload, ... }。
 */

export default async function ${camelize(runtimeName)}Handler(ctx) {
  const { pluginData, logger } = ctx;

  // TODO: 实现 ${runtimeName} runtime 的逻辑
  await logger?.info?.('${runtimeName}.invoked', {});

  return { status: 'ok' };
}
`;
}

function renderAgentStubManifest(runtimeName) {
  return `---
name: ${pluginName}/${runtimeName}
description:
  zh: ${runtimeName} agent runtime —— 请填写它的职责。
  en: ${runtimeName} agent runtime — replace with the real responsibility.
pluginType: plugin
model: default
outputKind: plugin
capabilities: [manual-invoke]
execution: sync
timeoutMs: 60000
callTimeoutMs: 45000
firstTokenTimeoutMs: 30000
maxRetries: 1
trigger:
  type: manual
tools:
  builtin:
    - plugin-data-set
input:
  inject:
    - from: narrator
      field: narrativeOutput
      as: "<narrator-output>"
---

你是 ${pluginName} 插件中的 ${runtimeName} 助手。

## 当前剧情

\`<narrator-output>\` 区块里是本轮 narrator 生成的剧情文本（可能为空）。

## 你的任务

TODO：在此描述本 agent 的具体目标。完成后调用 \`plugin-data-set\` 把结果写入本插件的某个 namespace，然后立即结束，不要输出任何额外文本。
`;
}

function camelize(name) {
  return name.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
}

function printUsage() {
  console.log("用法：");
  console.log(
    "  node scripts/create-plugin.js <plugin-name>                  # 默认 hello-world",
  );
  console.log(
    "  node scripts/create-plugin.js <plugin-name> -t <dir>         # 自定义目标",
  );
  console.log(
    "  node scripts/create-plugin.js <plugin-name> -r foo:function  # 自定义 runtime",
  );
  console.log(
    "  node scripts/create-plugin.js <plugin-name> --with-tools     # 旧式单 runtime",
  );
  console.log("");
  console.log("选项：");
  console.log("  -t, --target <dir>    目标目录，默认 ~/.covel/plugins");
  console.log(
    "  -r, --runtimes <list> 逗号分隔的 runtime 列表，每项为 name 或 name:type",
  );
  console.log("                        type ∈ { function, agent }，默认 agent");
  console.log(
    "  --with-tools          旧式单 runtime + tools/，目标固定为 <repo>/plugins/",
  );
}
