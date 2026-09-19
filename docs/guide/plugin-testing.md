# Plugin Testing

Covel 插件测试包含声明校验、单元/运行时测试、HTTP 和独立安装包验证。公开文档维护路线图、命令和源码入口；面向 AI 生成插件的长模板放在 [`.claude/skills/create-plugin/references/plugin-testing.md`](../../.claude/skills/create-plugin/references/plugin-testing.md)。

See also: [plugin-authoring.md](./plugin-authoring.md) · [e2e-plugin-verify.md](./e2e-plugin-verify.md).

## 选择测试入口

| 入口            | 包 / 脚本                                              | 适合验证什么                                                                                                                                                                                                                                                                                                                                                                    | 需要 server / API key       |
| --------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| Manifest schema | `pnpm validate:plugin <file \| plugin-dir>`            | `PLUGIN.md` frontmatter：loader 解析 + 原始 frontmatter 的 strict authoring schema（拒绝非法字段及 `auto`/`scheduled` 缺 `stage`，保留 Hook/UI-only 和 multi-runtime 元数据声明）。传**插件目录**时额外检查跨 runtime 的 `userSettings` 同名 key 声明是否冲突（插件级字段的完整合并规则见 [plugin-authoring-advanced.md](./plugin-authoring-advanced.md#插件级字段的合并规则)） | 否                          |
| 单元测试        | Vitest + `@covel/plugin-test-utils`                    | 纯函数、local tool、function handler、trigger helper                                                                                                                                                                                                                                                                                                                            | 否                          |
| In-process turn | `@covel/runtime` `executeTurn` + `MockLLM`             | agent runtime、tool loop、plugin_data 写入、跨 runtime 协作                                                                                                                                                                                                                                                                                                                     | 否                          |
| Runtime cases   | `@covel/test-runtime` / `pnpm test:runtime`            | 插件自带 `tests/runtime-cases.json`、外部 `~/.covel/plugins` 调试、mock/live 切换                                                                                                                                                                                                                                                                                               | mock 否，live 需要 key      |
| HTTP E2E        | `scripts/e2e-plugin-verify.ts`                         | 真实 API、SSE、session kernel、approval、store 路径                                                                                                                                                                                                                                                                                                                             | 需要 server，可用 mock slot |
| 第三方 ZIP      | `pnpm pack:test-plugin` / `pnpm test:plugin-lifecycle` | 安装、重复导入、community 授权、重启发现、运行、禁用、卸载和重新安装                                                                                                                                                                                                                                                                                                            | 自动测试不需要外部 key      |

## 推荐反馈环

每次修改都按由快到慢的顺序反馈：

1. `pnpm validate:plugin <插件目录>`：先确认 loader 能解析，随后由 strict authoring schema 检查原始字段、触发器/`stage` 组合和 handler 约束。loader 警告并丢弃的非法 note 字段仍会被严格校验拒绝；没有跳过当前作者合同的模式。看到 `(loader parse)` 时修 frontmatter/YAML 或路径；看到 `(authoring schema)` 时按输出的字段路径修字段类型、枚举或必需组合。
2. `pnpm vitest run plugins/<id>/tests`（或对应 workspace 的 `pnpm --filter ... test`）：反馈本地 tool、handler 和 schema 行为。
3. `pnpm test:runtime -- <plugin-id> --plugins-dir <dir> --pretty`：mock 执行 runtime case；多 runtime 可传 `<plugin-id>/<runtime-id>`，跨插件 `needs` 不满足时加 `--ignore-upstreams` 仅用于隔离调试。
4. 最后再跑 `scripts/e2e-plugin-verify.ts` 验证 server、SSE、approval 和真实 session store。mock 通过不代表 provider/API 或审批链路已通过。

`test:runtime` 的插件目录依次取 `--plugins-dir`、`COVEL_USER_PLUGINS_DIR`、`$COVEL_HOME/plugins`、`~/.covel/plugins`。`--mode mock` 是默认值；live 配置路径见下文。缺少凭据时应停留在 mock，不要把凭据写进仓库。

没有 runtime case 时，CLI 会对同名的单 runtime 做一次默认 mock smoke test。默认 mock
不会自行构造业务 tool call：声明了 `requireToolUse` 的 runtime 应添加
`tests/runtime-cases.json`，在 case 中提供 `llmResponse` / `llmResponses`，或调试时显式传
对应 CLI 参数。结果为 `skipped: upstream not success` 只证明依赖门控生效，并未执行目标
runtime；`--ignore-upstreams` 可隔离该门控，但不会替你生成所需的 mock tool call。

默认组合：

- 只改 `PLUGIN.md`：跑 `pnpm validate:plugin plugins/<id>`（传目录而非单个文件，才能跑到跨 runtime 检查）。
- 写了 `tools/*.js`、`handler.js`、`hooks/*.js`：加 Vitest 单元测试。
- 涉及 agent tool loop、`input.inject`、多 runtime 或 event 链：手搓 turn-executor 集成测试（见下）或 `pnpm test:runtime`。
- 发布前要验证完整 HTTP 行为：跑 `scripts/e2e-plugin-verify.ts`，并完成下面的第三方包和玩家流程验证。

## 独立第三方包与玩家流程

[`tests/third-party/lifecycle-probe`](../../tests/third-party/lifecycle-probe/README.md) 是独立 ID、
独立版本的包，通过真实安装 API 写入临时用户插件目录，以 `community` 来源加载。它覆盖
agent/function/background runtime、entry、工具、RPC、Hook、设置、UI、数据、失败回滚和恢复，
不借用内置插件信任或可写 store。运行 `pnpm pack:test-plugin` 得到
`test-results/lifecycle-probe.zip`，再运行 `pnpm test:plugin-lifecycle`。

配点、跨字段校验和确定性结算另由
[`third-party-tabletop.test.ts`](../../apps/server/tests/api/third-party-tabletop.test.ts) 验证：
将可选跑团插件更名后打包，覆盖 setup / playing 两阶段、审批拒绝、非法表单、同轮输入传递、
保留已有玩家以及重试/重启不重复掷骰。

这些自动测试使用确定性模型回复。发布涉及玩家流程的变更时，还应按
[浏览器 E2E 指南](./e2e-testing.md#发版前的玩家流程验收) 在正式构建上使用真实模型实玩，
验证从创角到连续回合、失败重试、重启续玩及卸载重装的页面体验。先完成本地验证，再运行远端 CI。

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

需要跑完整 turn（agent tool loop、event 链、proposal commit）时，直接用 `@covel/runtime` 的公开导出手工组装：`discoverPlugins` / `loadPluginManifest` / `loadRuntime`（`@covel/plugin-loader`）发现并加载真实 runtime，`createMemoryStore` 做后端，`createToolExecutor` + `executeTurn` 执行，LLM 用 `MockLLM` 或按步骤出 tool-call 的自定义 `LLMAdapter`。提交时通过 `commitExecution` 一次处理 `runtimeResults`、`nestedRuntimeResults`、`collectExecutionJournal` 和 `collectExecutionSuspensions`；不能只遍历顶层结果逐个落库，否则会遗漏递归写入并丢失整次执行的事务边界。当前作者工具的组装见 [`packages/test-runtime/src/execution.ts`](../../packages/test-runtime/src/execution.ts)。下面的低层测试范例用于理解 event 链和 proposal：

- [`packages/runtime/tests/scene-stage-integration.test.ts`](../../packages/runtime/tests/scene-stage-integration.test.ts) — 合成 emitter runtime 发 `scene.set`，同 turn event 链触发真实 scene-stage resolver 并 commit `plugin.data`。
- [`packages/runtime/tests/emit-event-integration.test.ts`](../../packages/runtime/tests/emit-event-integration.test.ts) — 该模式的最初出处。

运行包级测试：

```bash
pnpm --filter @covel/plugin-test-utils test
pnpm --filter @covel/plugin-<id> test
pnpm vitest run plugins/<id>/tests
```

## `@covel/test-runtime`

初始执行和首层 deferred follower 均使用生产 `executeTurn` 和 `commitExecution`，复用声明设置的默认值、工具权限、写缓冲、超时与能力撤销。每次执行的顶层和递归结果、对话 journal、suspensions 在一次事务内提交；失败写入不会留在 plugin-data，提交失败也不会启动该次执行产生的 followers。报告的 `commitStatus` / `commitError` 表示初始执行的提交结果。提交失败、runtime 失败或 job 失败都会使单次 CLI 退出非零，包括 `skipped` follower 和 `--expects-background-follower` 检测到任务缺失。case 可以明确期待某个 runtime 的失败；只有对应 runtime 的失败 job 随该预期被接受，提交失败和其它意外失败仍使 case 失败。

工具仍是隔离调试环境：entry 只实际注册 tools，Hook、RPC、form validator 和 media wire 的注册不在此处运行。CLI 执行初始 turn 及它产生的首层后台 followers，不运行长期队列；首层 follower 再产生的任务列在 `pendingDeferredFollowers`，需用真实 server 验证其后续调度。`runtimeResults` 包含已经执行的递归与同步 event 结果。follower 的 `failed` / `skipped` 对应失败 job；成功提交的 `suspended` 保留暂停结果和 suspension，但 job 为 `done`，表示本次后台调用已结束，不表示暂停交互已恢复。真实 provider、审批、恢复和多跳调度仍由 HTTP/浏览器测试覆盖。

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

# Use the configured user plugin directory.
pnpm test:runtime -- my-plugin --pretty

# 直接调试一个 runtime
pnpm test:runtime -- my-plugin/manual-runtime \
  --payload '{"debug":true}' \
  --pretty

# 使用真实 provider 跑一个 case
pnpm test:runtime -- my-plugin \
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

`--mode mock` 是默认值，会提供 fake LLM 和 synthetic `ctx.gateway.resolveSlot()`。脚手架的默认、自定义多 runtime 和 `--with-tools` 三种模板均有 mock 回归，测试会检查实际运行结果和已提交 plugin-data；Turbo 缓存同时包含脚手架与模板文件。

`--mode live` 会请求真实 provider，可能产生费用。CLI 按顺序尝试 `COVEL_LLM_TOML`、`$COVEL_HOME/llm.toml`、当前目录 `llm.toml`，缺失或解析失败时继续尝试下一份，全部失败则使用测试工具内置配置。未设置 `COVEL_HOME` 时使用 `~/.covel`；key 从该目录的 `keys.env` 补入，已有同名进程环境变量优先。CLI 不自动读取根 `.env` / `.env.llm`，这一点与开发 server 不同。

需要使用仓库根配置时显式加载；执行前检查目标 slot、provider 和凭据：

```bash
COVEL_LLM_TOML=llm.toml pnpm exec tsx \
  --env-file-if-exists=.env --env-file-if-exists=.env.llm \
  packages/test-runtime/src/cli.ts my-plugin --case happy-path --mode live --pretty
```

Live 模式适合发布前人工验证，CI 默认使用 mock。

## HTTP E2E

当你要验证 API、SSE、approval policy 或真实 session store 行为时，使用 `scripts/e2e-plugin-verify.ts`：

```bash
pnpm exec tsx --env-file=.env --env-file=.env.llm scripts/e2e-plugin-verify.ts \
  --slot e2e_local \
  --turns 3 \
  --plugins my-plugin
```

详细参数见 [e2e-plugin-verify.md](./e2e-plugin-verify.md)。Artifacts 写入 `debugs/e2e-logs/<run-id>/`。

## 维护规则

- 公开 guide 保持短：解释“选哪个入口”和“跑哪个命令”。
- 详细 copy-paste 模板、mock context、runtime case 断言和生成插件策略放在 `.claude/skills/create-plugin/references/plugin-testing.md`。
- 测试文档涉及实际 API 时，先核对 `packages/plugin-test-utils` 和 `packages/test-runtime` 源码。
