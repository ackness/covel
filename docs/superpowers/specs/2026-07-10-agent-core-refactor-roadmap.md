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

## W2 统一 AgentLoopEvent 事件流

loop 内部只发一条类型化事件流，现有三条出口降级为订阅适配器：

```
runAgentToolLoop ──emit──▶ AgentLoopEvent 流
                             ├─ delta 适配器 → onDelta（SSE，沿用 outputKind 门控）
                             ├─ trace 适配器 → TurnEmitter（llm.* / tool.* / message.* 词汇表不变）
                             └─ （未来观测按需订阅，不再改 loop 体）
```

- 事件词汇表（首版）：`loop_start` / `llm_call_start` / `llm_delta` / `llm_call_end` / `tool_start` / `tool_end` / `message_final` / `loop_end`，载荷带 runtimeId / pluginId / step 序号。
- **行为保真是硬约束**：trace 适配器必须逐条复刻现有 `TurnEmitter` 事件的字段与时序，尤其 delta 记录"不重复存 prompt 历史"的约定；/debug 时间线、成本聚合、Langfuse 导出零感知。
- `onDelta` 的 story-only 门控从 loop 体移到 delta 适配器。

**验收**：parity 测试——同一 MockLLM 剧本下，新旧实现产出的 trace 事件序列与 SSE delta 序列逐字节一致；/debug 页人工抽验一轮。

## W3 loop 分层形式化

把接缝落成真实模块边界：

- loop 核抽为独立模块（纯函数），依赖面只有 `LLMAdapter` + `ToolExecutor` + W2 事件流 + 显式配置对象；不 import harness 类型。
- 内联策略显式化为配置项：sentinel 识别（`runtime-done` / `suspend`）、`requireToolUse` nudge、loop 扰动阈值、schema gate、重试策略（`llm-retry.ts` 的 TTFB guard / 瞬态分类保持现状，作为 `LLMAdapter` 包装层注入）。
- `resume/`（suspension 恢复）与主路径共用同一个 loop 核入口。
- 产出物：loop 核可用最小 fixture（MockLLM + 两个假工具）独立实例化测试，不再需要拉起 turn executor 全家桶。

**验收**：`turn-agent-tool-loop.ts` 主体降到策略装配 + 核调用；loop 核模块自带独立测试；现有 runtime 测试套全绿。

## W4 steering / followUp / abort（玩家中途干预）

在 W3 的 loop 核上加消息队列能力：

- **steer**：turn 进行中玩家输入进入队列，在下一次 LLM 调用前并入上下文（工具执行中收到 → 下一步生效）。
- **followUp**：turn 自然结束后自动续接的排队输入。
- **abort**：turn 级取消——中断当前 LLM 流与工具执行、丢弃未提交 proposals、会话状态干净回到可输入。
- 协议面：SSE 增加对应事件、HTTP 增加 steer/abort 端点、前端输入区在 turn 进行中切换为"插话/停止"态。**这是四个 W 中唯一动协议面的**，需同步 `docs/reference/protocol.md` + `docs/reference/api.md`。

**验收**：e2e——长叙事流式中 steer 一条指令、下一次 LLM 调用可见；abort 后无残留 proposal 落库、下一 turn 正常。

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
