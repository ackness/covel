# Agent 核心与插件注册改造路线（Roadmap）

> 目标：收敛插件服务端能力的注册入口（W1）、统一 agent loop 的对外事件流（W2）、把 loop/harness 的分离接缝落成真实模块边界（W3）、补齐玩家中途干预能力（W4）。
> 四个工作流各自独立交付、按依赖排序；本文是路线总纲，每个 W 动手前出各自的细化 spec。

## 现状与缺口

**W1 缺口 — 插件服务端注册方式分散。** 插件作者要学四套注册面：本地工具（`tools/` + frontmatter）、hook（HookPipeline 注册）、RPC action（plugin-rpc）、媒体 wire（frontmatter `wires` 字段 + `bootstrap/plugin-wires.ts`）。每套的加载时机、作用域规则、错误处理各不相同，`bootstrap.ts` 里对应四段独立装配逻辑。

**W2 缺口 — loop 出口三条并行。** `runAgentToolLoop`（`packages/runtime/src/agent-loop/turn-agent-tool-loop.ts`，~540 行）对外有三条出口：`onDelta` 回调（SSE 流式叙事）、`deps.emitter` trace 事件（`llm.calling` / `tool.completed` 等，供 /debug、成本聚合、Langfuse）、`RuntimeResult`（提交管线）。emit 调用散落在 loop 体各处，新增一种观测（如 token 速率、工具耗时直方图）就要再改 loop 体。

**W3 缺口 — 分离接缝有注释、无边界。** `turn-executor/turn-executor-types.ts` 已经文档化了 `AgentLoopDeps` vs `TurnExecutorDeps` 的分离意图，但 loop 核与 harness 类型仍混居一个文件；`runtime-done` / `suspend` sentinel、`requireToolUse` nudge、schema gate、streaming 按 `outputKind` 门控这些策略全部内联在 while 体里，loop 核无法脱离 harness 单独实例化和测试。

**W4 缺口 — 玩家无法中途干预。** narration 流式输出期间玩家不能插话（steer 进下一次 LLM 调用），也没有干净的 turn 级 abort（当前只有底层 `signal` 透传）。对 RPG 场景这是可感知的体验缺口：长叙事无法打断、指令发出后无法修正。

## 非目标

- 不改 16 事件 HookPipeline 的语义（sequential accumulate-replace、会话作用域）——它是既有插件契约。
- 不动 `@covel/ai-provider`（slot 路由、tag fallback、SSRF、X-Provider-Keys）。
- 不动 proposal → commit 管线与 store 层。
- 不换 schema 库（Zod → JSON Schema 现状保持）。
- 不引入新的外部运行时依赖。

## W1 统一 PluginAPI（插件服务端单入口）

插件服务端代码收敛为一个工厂函数入口：

```ts
// plugins/<id>/server/index.ts
export default function (covel: PluginAPI) {
  covel.registerTool({ name, description, parameters: zodSchema, execute });
  covel.on("PreToolUse", handler); // 既有 16 事件，语义不变
  covel.registerRpc("myAction", handler);
  covel.registerWire("image", wireImpl);
  covel.settings; // 会话作用域读取，替代 HookContext.getOwnSettings() 的散点
}
```

- **PLUGIN.md manifest 保持声明式**（trigger / priority / trust tier / UI / i18n / dataSchemas / events）；收敛的只是"服务端代码怎么注册能力"这一层。
- `packages/plugin-loader` 识别新入口协议；`bootstrap.ts` 四段装配逻辑收敛为一次工厂调用后的统一登记。作用域规则不变：工具仍按 `pluginToolAccess` 限定、hook 仍会话作用域、wire 仍信任分级。
- **兼容窗口**：旧注册方式与新入口共存一个 minor 周期，加载器对旧方式打一次弃用告警；窗口结束删除旧路径（在 CHANGELOG 声明）。
- 迁移面：20 个内置插件中只有带 `server/` 目录的需要迁（迁移清单在细化 spec 中盘点）。

**验收**：新入口注册的工具/hook/RPC/wire 与旧方式行为逐项等价（现有插件测试套 + `@covel/plugin-test-utils` harness）；`docs/guide/plugin-authoring.md` 同步。

**已知限制（community entry hook 生效时机）**：旧 `hooks` 字段在 boot 时为所有信任级注册声明（handler 懒加载）；`entry` 里的 hook 只有在 `ensurePluginEntry` 跑过之后才进入 HookPipeline。对 community 插件，`ensurePluginEntry` 最早发生在**审批通过**（`approvals.ts` 的 `allow` 分支调用 `activatePluginServerCode`）或首次 runtime 调度/RPC 激活时——因此本会话中在激活点之前发生的 `SessionStart`/`TurnStart` 等早期事件，community entry 的 hook 收不到；每次进程重启也会为已审批的 community 插件重新打开这个窗口，直到它再次被激活。这是 deferred activation 安全模型的固有结果（未审批的第三方代码绝不能在 boot 时运行），不通过"把 entry hook 改回声明式 manifest"来消除。builtin/official entry 在 boot 时运行，无此限制。

## W2 统一 AgentLoopEvent 事件流（实施时修订）

> **核实结论（2026-07-10 动手核实）**：本节最初的前提——"emit 调用散落在 loop 体各处"——不成立。
> 实际拓扑：`TurnEmitter` 本身就是那条类型化事件流；`llm.calling/responded` 由**重试层**发
> （attempt 序号与 provider 身份只有它知道）、`tool.*` 由 **tool-executor** 发（审批状态只有它知道）、
> `message.completed` 在 finalize 发——分层各归其位，loop 体只有唯一一个 delta 出口。
> 再造一层 loop 级事件流会丢失 per-attempt 粒度或沦为纯改名，且威胁 trace 字节级 parity，故**不做**。

按核实结论收窄后的交付（已完成）：

- **delta 适配器**（`agent-loop/delta-forwarder.ts`）：loop 的唯一叙事出口抽成命名模块，
  身份注入 + 分片计数 + 断连吞错收敛于一处；streaming 门控（`outputKind: story`）移入 W3 的策略模块。
- **loop 直测**（`tests/agent-tool-loop-core.test.ts`）：最小 fixture（脚本化 LLMAdapter + 真 ToolExecutor +
  录制型 TurnEmitter）直接实例化 `runAgentToolLoop`，钉住 trace 序列（`llm.calling → llm.responded` 每步、
  `tool.calling → tool.completed`）、delta 序列与身份、runtime-done 剥离、maxSteps 边界、
  story/plugin streaming 门控、工具循环扰动一次后放弃。这正是本节原验收想要的 parity 网，
  且对未来任何 loop 改动持续生效。

**验收（已达成）**：runtime 全测试套通过（604/604，含 8 个新 loop 直测）；trace 词汇表与发射层零改动，/debug 零感知。

## W3 loop 分层形式化（已完成）

把接缝落成真实模块边界（实施时核实：`AgentLoopDeps`/`RuntimeResult` 接缝已存在且质量良好，
`resume/` 已与主路径共用同一 loop 入口——需要补的是策略显式化与直测，不是重切边界）：

- **策略模块**（`agent-loop/agent-loop-policy.ts`）：`buildAgentLoopPolicy()` 一处收敛全部
  "怎么跑"的推导——工具面（含 `tools.plugin`）、schema gate（responseFormat）、模型覆写链、
  streaming 门控、`effectiveMaxSteps`、重试策略（TTFB guard / 瞬态分类留在 `llm-retry.ts` 原位）、
  `requireToolUse`。loop 体只剩控制流。
- sentinel 识别（`runtime-done` / `suspend`）留在 loop 体：它们是控制流分支而非策略参数，
  强行参数化是伪灵活性。
- 保持 `runAgentToolLoop` 签名不变——resume 路径与 turn-agent-runtime 调用方零改动。

**验收（已达成）**：loop 体从 543 行降到 ~470 行且不再直接读 manifest 派生策略；
loop 核由最小 fixture 直测（见 W2 交付）；runtime 测试套 604/604 全绿。

## W4 steering / abort（玩家中途干预，已完成；followUp 裁掉）

在 W3 的 loop 核上加消息队列能力（实施记录）：

- **steer**（已实现）：`POST /api/sessions/:id/steer` → 服务端 per-session 队列（`turn-control.ts` 注册表，actions 路由注册/释放）→ loop 在每次 LLM 调用前 drain（仅 `outputKind: story`，策略字段 `acceptsSteering`）→ 消息同时持久化进历史。前端：回合进行中输入框保持可用，提交即插话；409（回合已结束）时草稿还回输入框，由玩家再发送。
- **abort**（已实现）：`POST /api/sessions/:id/abort` → 回合级 AbortSignal 线穿 `AgentLoopDeps.turnControl` → 重试层立刻切断在途调用/流（玩家 abort 不可重试且**绕过流式 salvage**——否则半截叙事会被当作结果提交，这是实施中发现的关键坑）→ executor 停止调度后续组、跳过事件链 → `execution.completed` 带 `abortReason: "aborted-by-player"`（复用既有字段，未新增 SSE 事件类型）。前端：执行中显示停止按钮。
- **followUp 裁掉（YAGNI）**：原设想"回合结束后自动续发的排队输入"——实施时判定多余：回合进行中输入即插话（steer），回合一结束输入框本来就能正常发送；steer 的 409 回退已覆盖临界竞态。需要时再作为纯前端队列补上，零内核改动。
- 协议面：新增两个 HTTP 端点 + `abortReason` 语义扩展，无新 SSE 事件类型；已同步 `docs/reference/api.md` + `docs/reference/protocol.md`。
- 已知上限（代码内注）：turn-control 注册表为进程内 Map，多 pod（PG）部署下 steer/abort 只达同 pod 回合。

**验收（已达成）**：loop 直测钉住 steer 注入（story 可见 / plugin 不可见）、abort 预发信号零 LLM 调用、abort 中流绕过 salvage；executor 测试钉住组间停调度 + `abortReason` + 先完成结果保留；server 测试钉住注册表生命周期与 steer/abort 路由（200/400/404/409 + 持久化）。

## 顺序与交付

```
W1（独立） ──────────────────────▶ 随时可先行
W2 ──▶ W3 ──▶ W4                   同一依赖链；W2+W3 可合并为一个"loop 重构"PR
```

| 序  | 工作流       | 前置                   | 交付形态                                            |
| --- | ------------ | ---------------------- | --------------------------------------------------- |
| 1   | W1 PluginAPI | 无                     | 细化 spec → PR（loader + bootstrap + 首批插件迁移） |
| 2   | W2 事件流    | 补足 loop 现状测试覆盖 | 细化 spec → PR（可与 W3 合并）                      |
| 3   | W3 分层      | W2                     | 同上                                                |
| 4   | W4 干预      | W3；协议评审           | 细化 spec → PR（server + web 同步）                 |

每个 PR 独立可回滚；W2/W3 期间不接受向 loop 体新增行为的并行改动（先冻结、后重构）。

## 风险

- **W2/W3 是行为敏感重构**：trace 时序、streaming 门控、thinking 内容往返（`reasoningContent`）、DeepSeek 畸形 tool-args fallback 等实战补丁必须逐条搬运，靠 parity 测试兜底，不靠肉眼。前置动作：先盘点 loop 现状测试覆盖，不足先补再动。
- **W1 双轨期拖长**：兼容窗口必须有明确删除时限，否则永久双轨。
- **W4 动协议**：SSE/API 变更影响 web 与 desktop 两端，放最后且单独评审。
