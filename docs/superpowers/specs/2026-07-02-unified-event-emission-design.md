# 统一事件发射层（Unified Event Emission）设计

> GalGame 四部曲的插队项 E，先于 B（scene-stage）实施；B 重构为本层的第一个消费方。
> 目标：给 **LLM 叙事流** 一个统一的领域事件发射入口——消费方插件声明事件契约，叙事 agent 用一个内置工具发射，框架校验并接入既有回合内事件链。此后"场景切换/任务更新/关系变化"等任何新关切 = 声明 topic + 写消费 runtime，narrator 与框架零改动。

## 现状与缺口

**已有（发射的下半程，保持不动）**：

- 回合内事件链：`trigger: {type: "event", topic}` 订阅 + `turn-event-chain.ts` fan-out（只从 `RuntimeResult.output.events` 收集，同 depth 同 topic 首发胜出，maxDepth 8）。
- `event.emit` 提案（持久化 + EventBus SSE/审计）。
- UI → 事件：块提交的 `_eventType` 约定。客户端 → 事件：`POST /api/events/emit`。

**缺口**：LLM 叙事流没有统一发射入口。每个关切要自造"专属本地工具 + 专属叙事后小 agent"（每关切每轮 +1 LLM 调用），N 个关切不可扩展；且本地工具作用域限声明插件，narrator 无法调用别家工具。

## 范围

**做**：E1 事件契约声明（manifest 字段 + 加载校验 + 会话级目录）；E2 内置 `emit-event` 工具（校验 + 双路发射）；E3 目录注入（emitter 侧 opt-in）；两个 narrator 插件接入（参考 emitter）；测试与文档。

**不做**：跨插件本地工具共享的泛化（本层就是它的替代品）；conditional 触发引擎；EventBus/持久化改动；UI/HTTP 发射通路（已存在）；具体领域事件（scene.set 属 B 规格）。

## E1 事件契约声明（消费方）

PLUGIN.md 新增顶层字段（与 `dataSchemas` 同风格，schema 为 JSON Schema 文件路径）：

```yaml
events:
  - topic: scene.set
    schema: ./schemas/scene-set.event.json
    description:
      zh: 叙事确立或切换场景时发射；载荷为地点与昼夜。
      en: Emit when the narrative establishes or changes the scene.
    advertise: true # 默认 true；false = 仅接受发射不进目录（内部事件）
```

- **声明者 = 消费方**（"我消费这个 topic，载荷长这样，请把它广告给发射方"）。发射方无需声明。
- 加载期校验：schema 文件存在且为合法 JSON Schema；topic 命名 `/^[a-z0-9-]+(\.[a-z0-9-]+)+$/`（domain.verb 形态）。
- **会话级事件目录** = 该会话激活插件的声明并集（经 SessionPluginScope 过滤，中途启停下一轮生效——沿用现有会话作用域语义）。同一 topic 多插件声明合法（多消费者）；schema 不一致时加载警告、以先加载者为校验基准。
- 框架零硬编码 topic（隔离规则）：目录纯由声明聚合。

## E2 内置 `emit-event` 工具

`packages/tools/src/builtin/`，全插件可用（builtin 作用域）：

- 入参 Zod：`{ topic: string, data: Record<string, unknown> }`。
- 执行校验：topic 必须在**当前会话目录**中（未激活消费方 → 工具返回错误给 LLM，附目录内可用 topic 列表）；`data` 按声明的 JSON Schema 校验（复用 dataSchemas 既有的校验器），失败返回具体字段错误——LLM 可在同一回合内修正重试（既有工具循环）。
- 发射（**单通道，双消费**）：工具事件经工具循环累积、在 finalize 时并入该 runtime 的 `output.events[{topic, data}]`——下游两条既有路径自然分流：`turn-event-chain.collectEventsFrom` 同回合 fan-out + `session-output-normalizer.normalizeOutput` 自动产 `event.emit` 提案（持久化 + SSE）。**工具本身不得再返回 event.emit pendingProposal**（`session-runtime-result` 对 normalizeOutput 与 pendingProposals 两路拼接，双通道会导致提案双发——侦察确认的坑）。
- 同 topic 同回合重复发射：工具层不拦（首发胜出由事件链已有语义保证），返回值提示"该 topic 本回合已发射过"。

## E3 目录注入（发射方）

- runtime frontmatter opt-in：`advertiseEvents: true`。框架为该 runtime 注入一段系统上下文：目录中每个 advertise 事件的 `topic + description(按 locale) + 载荷字段摘要`，附一句使用规约（"叙事中发生对应事实时调用 emit-event，一次一个 topic"）。目录为空则整段不注入。
- 注入走 segment 5（upstreamInjects）新 collector——**不进 framework preamble**（segment 1 按会话稳定可缓存，事件目录依赖激活插件集会破坏缓存）；目录由 turn executor 层从 registry 派生（`getSessionEventDeclarations` 并集）经 ContextBuildParams 线程进 prompt 组装。
- **参考接入**：`chat-mode-narrator` 与 `narrator` 两个插件加 `advertiseEvents: true`（prose 输出要求追加一句"工具调用不计入正文"）。narrator 从纯文本变为带工具循环——需要一轮 e2e 叙事质量抽验（验收项）。

## 观测与错误

- 工具调用天然进入现有 PreToolUse/PostToolUse hook 与 trace（tool 调用记录）；`event.emit` 提案进现有 commit/trace 管线。
- 校验失败不是异常态：返回结构化错误给 LLM 即止，绝不中断叙事回合。
- 无任何消费方激活时：目录空、无注入、误调 emit-event 得到清晰错误——模式照常可玩。

## 验收

- 单测：manifest 解析/校验（合法/非法 topic、schema 缺失）、会话目录聚合（启停过滤、多插件同 topic 告警）、emit-event 校验路径（目录外 topic、schema 违例、成功双路发射）。
- 集成：MockLLM 脚本化 agent 调 emit-event → 同回合 event 触发的 function runtime 被执行（走 plugin-test-utils/既有 turn-executor 测试模式）。
- e2e 抽验：真实 LLM 下 chat-mode-narrator 带工具目录叙事 ≥3 轮，prose 质量无回退、emit 行为符合预期（`pnpm e2e:verify` 或 test:runtime live，用户执行）。
- 文档同步：plugins.md（events 字段 + advertiseEvents）、tools.md（emit-event builtin）、plugin-authoring.md（消费方声明教程）、protocol.md（若 SSE 呈现有新事件形态则更新）。

## 决策记录

1. 声明者 = 消费方、目录按会话聚合——框架零硬编码 topic，新关切零框架 PR（与 image-wire 注册表同哲学）。
2. 发射双路（output.events 回合内接力 + event.emit 提案持久化）——复用两条既有通路，不造第三条。
3. narrator 内联发射（工具循环）替代"每关切一个叙事后小 agent"——每轮省 N 次 LLM 调用；质量风险用 e2e 抽验兜底。
4. B（scene-stage）重构为本层第一个消费方（见同日 scene-stage 规格）。
