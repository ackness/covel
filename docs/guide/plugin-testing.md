# Plugin Testing

Covel 插件测试包含声明校验、单元/运行时测试、HTTP 和独立安装包验证。公开文档维护路线图、命令和源码入口；面向 AI 生成插件的长模板放在 [`.claude/skills/create-plugin/references/plugin-testing.md`](../../.claude/skills/create-plugin/references/plugin-testing.md)。

See also: [plugin-authoring.md](./plugin-authoring.md) · [e2e-plugin-verify.md](./e2e-plugin-verify.md).

## 选择测试入口

Directory validation checks declared files, scheduling stages, builtin tool names, contributed plugin tool names and contract/runtime references without importing server code. It cannot verify that an entry actually registers what it declares; run the package's tests and host bootstrap check for that.

| 入口            | 包 / 脚本                                              | 适合验证什么                                                                                                                                                                                                                                                                                                                                                                                                                                         | 需要 server / API key       |
| --------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| Manifest schema | `pnpm validate:plugin <file \| plugin-dir>`            | `PLUGIN.md` frontmatter：loader 解析 + 原始 frontmatter 的 strict authoring schema（拒绝非法字段及 `auto`/`scheduled` 缺 `stage`，保留 Hook/UI-only 和 multi-runtime 元数据声明）。传插件目录、根 `PLUGIN.md` 或 `runtimes/<id>/RUNTIME.md` 时均收集完整包，检查 `PLUGIN.md` 与 `package.json` 的版本是否一致、共享声明引用和跨 runtime 冲突（插件级贡献由根 PLUGIN.md 唯一声明，见 [plugin-authoring-advanced.md](./plugin-authoring-advanced.md)） | 否                          |
| 单元测试        | Vitest + `@covel/plugin-test-utils`                    | 纯函数、local tool、function handler、trigger helper                                                                                                                                                                                                                                                                                                                                                                                                 | 否                          |
| In-process turn | `@covel/runtime` `executeTurn` + `MockLLM`             | agent runtime、tool loop、plugin_data 写入、跨 runtime 协作                                                                                                                                                                                                                                                                                                                                                                                          | 否                          |
| Runtime cases   | `@covel/test-runtime` / `pnpm test:runtime`            | 插件自带 `tests/runtime-cases.json`、外部 `~/.covel/plugins` 调试、mock/live 切换                                                                                                                                                                                                                                                                                                                                                                    | mock 否，live 需要 key      |
| HTTP E2E        | `scripts/e2e-plugin-verify.ts`                         | 真实 API、SSE、session kernel、approval、store 路径                                                                                                                                                                                                                                                                                                                                                                                                  | 需要 server，可用 mock slot |
| 第三方 ZIP      | `pnpm pack:test-plugin` / `pnpm test:plugin-lifecycle` | 安装、重复导入、community 授权、重启发现、运行、禁用、卸载和重新安装                                                                                                                                                                                                                                                                                                                                                                                 | 自动测试不需要外部 key      |

## 推荐反馈环

每次修改都按由快到慢的顺序反馈：

1. `pnpm validate:plugin <插件目录>`：先确认 loader 能解析，随后由 strict authoring schema 检查原始字段、触发器/`stage` 组合和 handler 约束。loader 警告并丢弃的非法 note 字段仍会被严格校验拒绝；没有跳过当前作者合同的模式。看到 `(loader parse)` 时修 frontmatter/YAML 或路径；看到 `(authoring schema)` 时按输出的字段路径修字段类型、枚举或必需组合。
2. `pnpm --filter @covel/plugin-<id> test`（仓库内的插件；仓库外的插件在其目录下跑 `vitest run`）：反馈本地 tool、handler 和 schema 行为。
3. `pnpm test:runtime -- <plugin-id> --plugins-dir <dir> --pretty`：mock 执行 runtime case；多 runtime 可传 `<plugin-id>/<runtime-id>`，跨插件 `needs` 不满足时加 `--ignore-upstreams` 仅用于隔离调试。
4. 最后再跑 `scripts/e2e-plugin-verify.ts` 验证 server、SSE、approval 和真实 session store。mock 通过不代表 provider/API 或审批链路已通过。

`test:runtime` 的插件目录依次取 `--plugins-dir`、`COVEL_USER_PLUGINS_DIR`、`$COVEL_HOME/plugins`、`~/.covel/plugins`。`--mode mock` 是默认值；live 配置路径见下文。缺少凭据时应停留在 mock，不要把凭据写进仓库。

Runtime case 的 pluginData 报告与期望只按自有 namespace / field 查询；`constructor`、`toString` 等普通名称不与 JavaScript 继承属性冲突，缺少的 namespace 判为未满足期望。保存图片使用同一 namespace 查询规则；同次运行中不同数据键清洗成相同文件名时追加序号，避免图片相互覆盖。

没有 runtime case 时，CLI 会对同名的单 runtime 做一次默认 mock smoke test。默认 mock
不会自行构造业务 tool call：声明了 `requireToolUse` 的 runtime 应添加
`tests/runtime-cases.json`，在 case 中提供 `llmResponse` / `llmResponses`，或调试时显式传
对应 CLI 参数。结果为 `skipped: upstream not success` 只证明依赖门控生效，并未执行目标
runtime；`--ignore-upstreams` 可隔离该门控，但不会替你生成所需的 mock tool call。

默认组合：

- 只改 `PLUGIN.md`：跑 `pnpm validate:plugin plugins/<id>`（也可传根或子 runtime 的 `RUNTIME.md`，会校验整个所属包）。
- 写了 `tools/*.js`、`handler.js`、`hooks/*.js`：加 Vitest 单元测试。
- 涉及 agent tool loop、`io.inputs`、多 runtime 或 event 链：手搓 turn-executor 集成测试（见下）或 `pnpm test:runtime`。
- 发布前要验证完整 HTTP 行为：跑 `scripts/e2e-plugin-verify.ts`，并完成下面的第三方包和玩家流程验证。

## 可操作的组合示例

[官方记录工作台 demo](https://github.com/covel-ai/covel-plugins/tree/main/examples/notes-workbench) 及两个处理服务由插件仓库维护，属于按需安装的开发示例，不是核心插件。安装、宿主版本要求和测试步骤以其 README 为准。

主仓库使用 `tests/third-party/lifecycle-probe`、`service-provider-probe` 验证安装、审批、服务发现、调用和禁用边界，使用 `tests/e2e/plugin-webview-actions.spec.ts` 验证包级 HTML 的手动 runtime 桥接。主仓库检查不依赖插件仓库的本地路径或在线下载。

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

| 导出                                                         | 用途                                                                                                           |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `MockLLM`                                                    | 记录 LLM 调用；支持 `defaultResponse` 和按顺序消费的 `responses[]`                                             |
| `makeTurnInput` / `makeTriggerContext` / `makeRuntimeResult` | 减少 fixture 样板代码；`makeTurnInput` 默认带 `locale: "zh-CN"`，与真实会话一致                                |
| `makeManualFunctionContext`                                  | 直接测试 function runtime handler                                                                              |
| `makeRandom(seed?)`                                          | 测试用的 `ctx.random`：每次运行给出相同的数。`makeManualFunctionContext` 默认带它；手写上下文的测试自己放进去  |
| `loadPluginMessages(pluginRoot, locale)`                     | 读取插件 `locales/` 里的译文，得到宿主会传入的 `ctx.messages`；断言中文输出的 handler / 工具测试把它放进上下文 |
| `expectAssetGenerated`                                       | 断言 RuntimeResult 的 `effects.assetGenerations[]` 中有合法 MediaRef                                           |

function handler 单元测试（真实范例：[`plugins/character-blueprint/tests/presence.test.js`](../../plugins/character-blueprint/tests/presence.test.js)）——用 `makeManualFunctionContext` 构造 handler context，直接调用 handler，再用 `@covel/tools` 的 `getPendingProposals` 断言 proposal：

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

`makeManualFunctionContext` 接受完整 handler context 的可选能力（例如 `pluginData`、`images`、`world`、`tools`、`signal` 和 `triggerEvent`），原样传入测试提供的桩，不模拟持久化提交。缺失的 store 读取仍显式报错。事件触发 / 媒体生成类 handler 可以传入这些桩并直接断言 `HandlerResult.effects` 的产物，范例见 [`plugins/scene-stage/tests/handler.test.js`](../../plugins/scene-stage/tests/handler.test.js)（事件触发）与 [`packages/plugin-handlers-utils/tests/image-generation.test.ts`](../../packages/plugin-handlers-utils/tests/image-generation.test.ts)（媒体生成）。`expectAssetGenerated` 接受 `RuntimeResult`、结果数组或 `TurnResult`，只检查显式 effects，不接受裸业务输出。

### In-process turn（手搓 turn-executor）

工具的集成测试可以直接使用真实执行与提交入口，无需在每个插件里复制 proposal 提交器：

```ts
import {
  createPluginTestStore,
  executeToolAndCommit,
  commitToolResults,
} from "@covel/plugin-test-utils";

const ctx = {
  sessionId: "session",
  turnId: "turn",
  pluginId: "sample",
  runtimeId: "sample/main",
};
const store = await createPluginTestStore(ctx);
const result = await executeToolAndCommit(tool, params, ctx, store);
```

该入口使用 memory store、真实 tool executor、`executeTurn` 和 `commitExecution`；保留 namespace 校验与事务回滚，返回原始工具结果便于断言。需要测试同一执行的多次待提交写入时，先执行工具，再 `await commitToolResults([first, second], ctx, store)` 一次提交。它不提供完整 HTTP、审批或事件目录宿主；这些边界仍由 server 测试覆盖。纯转换单测可以直接调用工具，不必启动执行宿主。

`pnpm create-plugin <name> --with-tools` 在仓库的 `plugins/` 下生成的插件提供 `pnpm lint`（`checkJs` / `noEmit`），通过 workspace 内的 SDK 用 JSDoc 类型检查 handler 和工具；无需改写成 TypeScript。修改 SDK 调用时同时运行类型检查与行为测试。生成到用户插件目录的模板不带依赖和类型检查配置，用 `pnpm validate:plugin` 和 `pnpm test:runtime` 验证。

需要跑完整 turn（agent tool loop、event 链、proposal commit）时，直接用 `@covel/runtime` 的公开导出手工组装：`discoverPlugins` / `loadPluginDefinition` / `loadRuntime`（`@covel/plugin-loader`）发现并加载真实 runtime，从定义的 `manifests` 选择执行项，从 `packageManifest` 读取包级 entry 与贡献。`@covel/store/memory` 的 `createMemoryStore` 做后端，`createToolExecutor` + `executeTurn` 执行，LLM 用 `MockLLM` 或按步骤出 tool-call 的自定义 `LLMAdapter`。`executeTurn` 返回 `{ result, commit }`，将整个对象作为 `execution` 传给 `commitExecution`；内核负责完整收集嵌套结果、journal、suspension 和输出 schema。不要自己拼提交计划或逐个落库。调用方式见[宿主执行与提交边界](../reference/protocol.md#宿主执行与提交边界)。当前作者工具的组装见 [`packages/test-runtime/src/execution.ts`](../../packages/test-runtime/src/execution.ts)。下面的低层测试范例用于理解 event 链和 proposal：

- [`packages/runtime/tests/scene-stage-integration.test.ts`](../../packages/runtime/tests/scene-stage-integration.test.ts) — 合成 emitter runtime 发 `scene.set`，同 turn event 链触发真实 scene-stage resolver 并 commit `plugin.data`。
- [`packages/runtime/tests/emit-event-integration.test.ts`](../../packages/runtime/tests/emit-event-integration.test.ts) — 该模式的最初出处。

运行包级测试：

```bash
pnpm --filter @covel/plugin-test-utils test
pnpm --filter @covel/plugin-<id> test
```

仓库内每个跑 Vitest 的包都有一个引入 `vitest.base` 的 `vitest.config.ts`（`pnpm create-plugin --with-tools` 会生成）：它让这次运行使用自己的临时目录，进程退出时整个删除，测试建了临时目录不清理也不会留在系统里。在仓库根用 `pnpm vitest run plugins/<id>/tests` 会绕过这个配置，所以用上面按包运行的写法。

## `@covel/test-runtime`

初始执行和首层 deferred follower 均使用生产 `executeTurn` 和 `commitExecution`，复用声明设置的默认值、工具权限、写缓冲、超时与能力撤销。每次执行的顶层和递归结果、对话 journal、suspensions 在一次事务内提交；失败写入不会留在 plugin-data，提交失败也不会启动该次执行产生的 followers。报告的 `commitStatus` / `commitError` 表示初始执行的提交结果。提交失败、runtime 失败或 job 失败都会使单次 CLI 退出非零，包括 `skipped` follower 和 `--expects-background-follower` 检测到任务缺失。case 可以明确期待某个 runtime 的失败；只有对应 runtime 的失败 job 随该预期被接受，提交失败和其它意外失败仍使 case 失败。

工具仍是隔离调试环境：entry 实际注册 tools、services 和回合 Hook，并通过真实 HookPipeline 执行。SessionStart/End、Pre/PostCompaction、RPC、form validator、media wire，以及 `history.compact@2`、`ui.slot@1`、`media.image-flow@1` 扩展需要完整宿主，会列入报告的 `unsupportedCapabilities`（pluginId、kind、name），CLI 同时输出警告。CLI 执行初始 turn 及它产生的首层后台 followers，不运行长期队列；首层 follower 再产生的任务列在 `pendingDeferredFollowers`，需用真实 server 验证其后续调度。`runtimeResults` 包含已经执行的递归与同步 event 结果。follower 的 `failed` / `skipped` 对应失败 job；成功提交的 `suspended` 保留暂停结果和 suspension，但 job 为 `done`，表示本次后台调用已结束，不表示暂停交互已恢复。真实 provider、审批、恢复和多跳调度仍由 HTTP/浏览器测试覆盖。

源码入口：

- [`packages/test-runtime/src/cli.ts`](../../packages/test-runtime/src/cli.ts)（进程入口）
- [`packages/test-runtime/src/run-cli.ts`](../../packages/test-runtime/src/run-cli.ts)（参数解析、报告输出和退出码）
- [`packages/test-runtime/src/runner.ts`](../../packages/test-runtime/src/runner.ts)
- [`packages/test-runtime/src/cases.ts`](../../packages/test-runtime/src/cases.ts)
- [`packages/test-runtime/src/reporting.ts`](../../packages/test-runtime/src/reporting.ts)

`pnpm test:runtime` 有两种目标：

- `<pluginId>`：读取插件根目录下的 `tests/runtime-cases.json` 或 `covel.test.json`，执行声明的 cases。
- `<pluginId>/<runtimeId>`：直接手动触发某个 runtime，适合临时调试。

harness 会执行选定插件的 `entry` 模块并注册它导出的工具和服务，所以用 `contributes.tools` 声明的工具在 case 里可以被 mock LLM 直接调用。回合 Hook（包括提交前后 Hook）使用选定插件的完整作用域和冻结设置执行，注册时与生产共用 `validatePluginHookRegistration`。工具和服务回调由 `PluginEntryScope` 保活，关闭先通知取消、等待回调退出，再清理资源；需要 HTTP、UI 或会话生命周期的能力则明确报告为不支持。

harness 默认只加载被测插件。使用可重复的 `--with-plugin <id>` 显式加入协作插件；API `runRuntimeDebug` 和 case 均使用 `withPlugins: string[]`，case 的列表覆盖 CLI 列表。它们从同一个 `--plugins-dir` 查找，重复 ID 去重，缺失包在 entry 执行前报错。选定包均加入测试会话，工具按所属插件隔离，服务仅允许选定且当前会话仍活跃的插件调用。角色工具读取会话 World Model 的领域 schema；测试通过 character.schema.set 或初始 characterSchema 提供约束，不查询插件私有 namespace。退出及初始化失败时逆序清理入口资源；正常退出同时启动入口清理和工具停机，等待工具回调结束后才关闭 store，避免超时工具阻塞停止它所等待的入口资源。CLI 会执行这些包的服务端代码，应只选择信任的本地包，生产审批仍需通过 HTTP 测试验证。

只有指定目标被改为初始手动触发，加入协作插件不会自动运行其全部 runtime；声明的事件下游仍可执行。跨插件 `needs` 需要实际的上游结果，单纯加载包并不制造结果。仅调试不依赖上游的路径时，可以用 case `"ignoreUpstreams": true` 或 CLI `--ignore-upstreams`。报告的 `pluginData` 仍只包含被测插件。`userSettings` 覆盖值仅应用于被测插件的 runtime，包括协作插件后台任务递归调用回来的 runtime；协作插件使用自身声明的默认值。后台与递归执行保留完整的按插件分桶设置快照。

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

# Run the repository's two-package service example without an LLM.
pnpm test:runtime -- lifecycle-probe/note \
  --plugins-dir tests/third-party \
  --with-plugin service-provider-probe \
  --payload '{"text":"Hello","providerPluginId":"service-provider-probe"}' \
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
pnpm exec tsx --env-file-if-exists=.env --env-file-if-exists=.env.llm scripts/e2e-plugin-verify.ts \
  --slot e2e_local \
  --turns 3 \
  --plugin my-plugin
```

详细参数见 [e2e-plugin-verify.md](./e2e-plugin-verify.md)。Artifacts 写入 `debugs/e2e-logs/<run-id>/`。

## 维护规则

- 公开 guide 保持短：解释“选哪个入口”和“跑哪个命令”。
- 详细 copy-paste 模板、mock context、runtime case 断言和生成插件策略放在 `.claude/skills/create-plugin/references/plugin-testing.md`。
- 测试文档涉及实际 API 时，先核对 `packages/plugin-test-utils` 和 `packages/test-runtime` 源码。

默认 analyst 示例在 `post-turn` 自动运行，读取本回合叙事绑定；note 示例保留手动函数入口。记录 ID 来自 `ctx.random`，时间戳由代码或存储写入，agent 只提交稳定的事实 key 和内容。
