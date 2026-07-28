# Plugin Testing

Covel 插件测试分五个入口。公开文档只维护路线图、命令和源码入口；面向 AI 生成插件的长模板放在 [`.claude/skills/create-plugin/references/plugin-testing.md`](../../.claude/skills/create-plugin/references/plugin-testing.md)。

See also: [plugin-authoring.md](./plugin-authoring.md) · [e2e-plugin-verify.md](./e2e-plugin-verify.md).

## 选择测试入口

| 入口            | 包 / 脚本                                   | 适合验证什么                                                                                                                                                                                                                                                                                                                       | 需要 server / API key       |
| --------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| Manifest schema | `pnpm validate:plugin <file \| plugin-dir>` | `PLUGIN.md` frontmatter：loader compat 解析 + strict authoring schema（缺 `stage` / legacy 字段直接报错；`--compat` 仅校验能否加载）。传**插件目录**时额外检查跨 runtime 的 `userSettings` 同名 key 声明是否冲突（插件级字段的完整合并规则见 [plugin-authoring-advanced.md](./plugin-authoring-advanced.md#插件级字段的合并规则)） | 否                          |
| 单元测试        | Vitest + `@covel/plugin-test-utils`         | 纯函数、local tool、function handler、trigger helper                                                                                                                                                                                                                                                                               | 否                          |
| In-process turn | `@covel/runtime` `executeTurn` + `MockLLM`  | agent runtime、tool loop、plugin_data 写入、跨 runtime 协作                                                                                                                                                                                                                                                                        | 否                          |
| Runtime cases   | `@covel/test-runtime` / `pnpm test:runtime` | 插件自带 `tests/runtime-cases.json`、外部 `~/.covel/plugins` 调试、mock/live 切换                                                                                                                                                                                                                                                  | mock 否，live 需要 key      |
| HTTP E2E        | `scripts/e2e-plugin-verify.ts`              | 真实 API、SSE、session kernel、approval、store 路径                                                                                                                                                                                                                                                                                | 需要 server，可用 mock slot |

默认组合：

- 只改 `PLUGIN.md`：跑 `pnpm validate:plugin plugins/<id>`（传目录而非单个文件，才能跑到跨 runtime 检查）。
- 写了 `tools/*.js`、`handler.js`、`hooks/*.js`：加 Vitest 单元测试。
- 涉及 agent tool loop、`input.inject`、多 runtime 或 event 链：手搓 turn-executor 集成测试（见下）或 `pnpm test:runtime`。
- 发布前要验证完整 HTTP 行为：跑 `scripts/e2e-plugin-verify.ts`。

## `@covel/plugin-test-utils`

源码入口：

- [`packages/plugin-test-utils/src/index.ts`](../../packages/plugin-test-utils/src/index.ts)
- [`packages/plugin-test-utils/src/mock-llm.ts`](../../packages/plugin-test-utils/src/mock-llm.ts)
- [`packages/plugin-test-utils/src/manual-context.ts`](../../packages/plugin-test-utils/src/manual-context.ts)
- [`packages/plugin-test-utils/src/contract.ts`](../../packages/plugin-test-utils/src/contract.ts)

主要导出：

| 导出                                                         | 用途                                                               |
| ------------------------------------------------------------ | ------------------------------------------------------------------ |
| `MockLLM`                                                    | 记录 LLM 调用；支持 `defaultResponse` 和按顺序消费的 `responses[]` |
| `makeTurnInput` / `makeTriggerContext` / `makeRuntimeResult` | 减少 fixture 样板代码                                              |
| `makeManualFunctionContext`                                  | 直接测试 function runtime handler                                  |
| `expectAssetGenerated`                                       | 断言 runtime output 的 `assetGenerations[]` 中有合法 MediaRef      |

function handler 单元测试（真实范例：[`plugins/character-presence/tests/handler.test.js`](../../plugins/character-presence/tests/handler.test.js)）——用 `makeManualFunctionContext` 构造 handler context，直接调用 handler，再用 `@covel/tools` 的 `getPendingProposals` 断言 proposal：

```js
import { describe, expect, it } from "vitest";
import { makeManualFunctionContext } from "@covel/plugin-test-utils";
import { getPendingProposals } from "@covel/tools";
import handler from "../handler.js";

it("saves data via a plugin.data proposal", async () => {
  const result = await handler(
    makeManualFunctionContext({
      pluginId: "my-plugin",
      manualPayload: { text: "hello" },
    }),
  );

  const proposals = getPendingProposals(result);
  expect(proposals[0]).toMatchObject({ type: "plugin.data" });
});
```

事件触发 / 媒体生成类 handler 通常手写 context 对象（`vi.fn()` 桩掉 `pluginData` / `images` / `logger`），并用 `expectAssetGenerated` 断言产物——完整范例见 [`plugins/scene-stage/tests/background-gen.test.js`](../../plugins/scene-stage/tests/background-gen.test.js)。

### In-process turn（手搓 turn-executor）

需要跑完整 turn（agent tool loop、event 链、proposal commit）时，直接用 `@covel/runtime` 的公开导出手工组装：`discoverPlugins` / `loadPluginManifest` / `loadRuntime`（`@covel/plugin-loader`）发现并加载真实 runtime，`createMemoryStore` 做后端，`createToolExecutor` + `executeTurn` 执行，`processRuntimeResult` 落库 proposal，LLM 用 `MockLLM` 或按步骤出 tool-call 的自定义 `LLMAdapter`。完整范例：

- [`packages/runtime/tests/scene-stage-integration.test.ts`](../../packages/runtime/tests/scene-stage-integration.test.ts) — 合成 emitter runtime 发 `scene.set`，同 turn event 链触发真实 scene-stage resolver 并 commit `plugin.data`。
- [`packages/runtime/tests/emit-event-integration.test.ts`](../../packages/runtime/tests/emit-event-integration.test.ts) — 该模式的最初出处。

运行包级测试：

```bash
pnpm --filter @covel/plugin-test-utils test
pnpm --filter @covel/plugin-<id> test
pnpm vitest run plugins/<id>/tests
```

## `@covel/test-runtime`

源码入口：

- [`packages/test-runtime/src/cli.ts`](../../packages/test-runtime/src/cli.ts)
- [`packages/test-runtime/src/runner.ts`](../../packages/test-runtime/src/runner.ts)
- [`packages/test-runtime/src/cases.ts`](../../packages/test-runtime/src/cases.ts)
- [`packages/test-runtime/src/reporting.ts`](../../packages/test-runtime/src/reporting.ts)

`pnpm test:runtime` 有两种目标：

- `<pluginId>`：读取插件根目录下的 `tests/runtime-cases.json` 或 `covel.test.json`，执行声明的 cases。
- `<pluginId>/<runtimeId>`：直接手动触发某个 runtime，适合临时调试。

harness 会执行插件的 `entry` 模块并注册它导出的工具，所以用 `tools.plugin` 声明的工具在 case 里可以被 mock LLM 直接调用。hook / RPC / wire 的注册会被接受但不生效——它们属于 server bootstrap 的职责，单 runtime 的 harness 回合走不到。

harness 只加载被测插件，所以跨插件的 `needs`（如 `{ capability: narrative-engine }`）必然不满足、runtime 会被 gate 跳过。case 里加 `"ignoreUpstreams": true` 可以绕过（等价于 CLI 的 `--ignore-upstreams`）。

常用命令：

```bash
# 跑仓库内插件声明的 cases
pnpm test:runtime -- my-plugin --plugins-dir plugins --pretty

# 跑外部插件声明的 cases
pnpm test:runtime -- my-plugin --plugins-dir ~/.covel/plugins --pretty

# 直接调试一个 runtime
pnpm test:runtime -- my-plugin/manual-runtime \
  --plugins-dir ~/.covel/plugins \
  --payload '{"debug":true}' \
  --pretty

# 使用真实 provider 跑一个 case
pnpm test:runtime -- my-plugin \
  --plugins-dir ~/.covel/plugins \
  --case happy-path \
  --mode live \
  --pretty
```

最小 case 文件：

```json
{
  "cases": [
    {
      "name": "manual-runtime-writes-data",
      "runtimeId": "my-plugin/manual-runtime",
      "payload": { "text": "hello" },
      "expect": {
        "runtimeResults": [
          { "runtimeId": "my-plugin/manual-runtime", "status": "success" }
        ],
        "pluginData": [{ "namespace": "notes", "field": "text" }]
      }
    }
  ]
}
```

`--mode mock` 是默认值，会提供 fake LLM 和 synthetic `ctx.gateway.resolveSlot()`；`--mode live` 会读取 `llm.toml` 与 `~/.covel/keys.env`，走真实 provider。Live 模式适合发布前人工验证，CI 默认使用 mock。

## HTTP E2E

当你要验证 API、SSE、approval policy 或真实 session store 行为时，使用 `scripts/e2e-plugin-verify.ts`：

```bash
npx tsx --env-file=.env --env-file=.env.llm scripts/e2e-plugin-verify.ts \
  --slot e2e_local \
  --turns 3 \
  --plugins my-plugin
```

详细参数见 [e2e-plugin-verify.md](./e2e-plugin-verify.md)。Artifacts 写入 `debugs/e2e-logs/<run-id>/`。

## 维护规则

- 公开 guide 保持短：解释“选哪个入口”和“跑哪个命令”。
- 详细 copy-paste 模板、mock context、runtime case 断言和生成插件策略放在 `.claude/skills/create-plugin/references/plugin-testing.md`。
- 测试文档涉及实际 API 时，先核对 `packages/plugin-test-utils` 和 `packages/test-runtime` 源码。
