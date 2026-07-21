# 工具注册表

> 所有可供 LLM Runtime 调用的工具（Function Calling）。工具分为 builtin（框架内置）和 local（插件本地）两类。

---

## 概览

| 工具名                  | 来源    | 所属插件   | 审批策略   | 描述                                                                                |
| ----------------------- | ------- | ---------- | ---------- | ----------------------------------------------------------------------------------- |
| create-form             | builtin | —          | auto-allow | 创建玩家表单                                                                        |
| create-choices          | builtin | —          | auto-allow | 创建选项列表                                                                        |
| create-notification     | builtin | —          | auto-allow | 显示通知消息                                                                        |
| render-ui               | builtin | —          | auto-allow | 渲染带独立 part 状态的 UI 块                                                        |
| plugin-data-set         | builtin | —          | auto-allow | 写入插件持久化数据（单条）                                                          |
| plugin-data-set-batch   | builtin | —          | auto-allow | 批量写入插件持久化数据                                                              |
| plugin-data-get         | builtin | —          | auto-allow | 读取当前插件持久化数据                                                              |
| plugin-data-list        | builtin | —          | auto-allow | 列出当前插件持久化数据                                                              |
| **create-character**    | builtin | —          | auto-allow | 创建角色（player/npc/companion），写 characters 表 + 镜像到 plugin-data             |
| **update-character**    | builtin | —          | auto-allow | 按 id 更新角色描述/字段（shallow merge），自动 version++                            |
| **list-characters**     | builtin | —          | auto-allow | 列出本 session 所有角色（session 作用域，跨插件可见）                               |
| **get-character**       | builtin | —          | auto-allow | 按 id 或 name 查找单个角色                                                          |
| **world-dimension-get** | builtin | —          | auto-allow | 按需读取当前 session 世界的结构化维度字段                                           |
| **emit-event**          | builtin | —          | auto-allow | 发射当前 session 已声明的领域事件（一次一个 topic），校验 topic + payload schema    |
| **suspend**             | builtin | —          | auto-allow | 挂起当前 runtime 等待玩家输入，写 `suspensions` 表，可通过 resume API 恢复          |
| **runtime-done**        | builtin | —          | auto-allow | Agent 工具循环的结束信号——业务工具调用完毕后调用以结束本 runtime                    |
| **search-tools**        | 注入    | —          | auto-allow | 延迟工具搜索——manifest 声明 `tools.defer` 时框架自动注入，BM25 检索并激活未预载工具 |
| **memory-search**       | builtin | —          | auto-allow | 搜索记忆：对话历史(recall) + 长期知识库(archival，含 codex/lorebook/角色)           |
| **memory-get-block**    | builtin | —          | auto-allow | 读取一个核心记忆块的当前内容                                                        |
| **memory-update-block** | builtin | —          | auto-allow | 更新（完整替换）一个核心记忆块。无 capability 门控——列入 tools.builtin 即可用       |
| set-world-schema        | local   | world-init | auto-allow | 定义世界角色属性 Schema                                                             |
| set-world-entries-batch | local   | world-init | auto-allow | 批量写入世界词条                                                                    |
| unlock-codex-entries    | local   | codex      | auto-allow | 批量解锁图鉴条目                                                                    |
| update-codex-entry      | local   | codex      | auto-allow | 更新已有图鉴条目                                                                    |

---

## 工具调用方向

本页当前以 `apps/server/src/routes/api/bootstrap.ts` 与 `plugins/**/tools/` 下的实现为准。

### 选择顺序

1. 通用、重复、跨插件复用的能力，使用 `tools.builtin`
2. 插件专属 schema、RAG、NPC 关系维护、图鉴整理等能力，在插件 `entry` 模块里 `covel.registerTool()` 注册，并在 runtime manifest 用 `tools.plugin`（名字列表）声明 LLM 可见性
3. 多个插件长期共享且契约稳定的能力，升级为新的 builtin 工具

### Builtin 的职责

Builtin 工具承接系统级 building blocks，例如：

- `plugin-data-*`
- `render-ui`
- `create-form`
- `create-choices`
- `create-character`
- `world-dimension-get`

这类能力适合被多个插件直接复用。

### Local 的职责

Local 工具承接插件自己的业务封装，例如：

- `generate-guide`
- `upsert-npc-graph`
- `unlock-codex-entries`

这类能力的 schema、文案、数据结构由插件包自己定义和演进。

### 目录与访问边界

- local 工具在插件 `entry` 模块（frontmatter `entry` 字段，基于插件根目录解析）里用 `covel.registerTool()` 注册；旧的 `tools.local` 路径声明已弃用（保留一个发布周期），语义不变
- bootstrap 会校验 entry 路径边界，并只加载位于插件目录内的文件
- local 工具访问权限按 `pluginId` 隔离，且**只在注册成功时授予**：`tools.plugin` / 旧 `tools.local` 的 manifest 声明只控制 runtime 的 LLM 可见面，本身不授予执行权——声明了未注册（或注册被碰撞跳过）的名字时，该名字对声明插件解析失败，不会命中其他插件的同名实现
- 工具名全局唯一：与 builtin 或其他插件已注册的工具重名时，注册会被拒绝（warn + skip），不会静默覆盖已有实现，声明方也不会因此获得已有实现的调用权

### 不是 Tool：`FunctionHandlerContext` 上的框架能力

`ctx.gateway`、`ctx.media`、`ctx.images`、`ctx.utils` 是 function runtime handler 直接调用的 JS API，**不经过** Tool 注册表 / 审批管线——它们不是 LLM 通过 function calling 触发的工具，而是框架注入给 handler 代码本身的能力。图像生成尤其如此：插件不应该声明一个 `generate-image` 工具让 LLM 调用，而应在 `handler.js` 里直接 `await ctx.images.generate({...})`。完整的 ctx 能力表和图像生成契约见 [plugin-authoring-advanced.md §6](../guide/plugin-authoring-advanced.md#6-函数-runtime手动触发与后台执行)。

### 当前代码状态

当前实现里，local tool 可以读取注入的 `store`，持久化写入优先通过 `withPendingProposals(...)` 交给 commit chain；deterministic function handler 继续使用 `store` 完成内部批量工作。

插件对外暴露给 runtime 的稳定契约依旧建议留在插件目录内，由插件自己维护测试。

---

## Builtin 工具

框架级原语，定义在 `packages/tools/src/builtin/*.ts`。所有插件可通过 `tools.builtin` 声明引用，无需编写代码。

### create-form

创建一个需要玩家填写的表单。框架渲染表单，玩家提交后结果注入下一轮上下文。

| 参数              | 类型        | 必需 | 描述                                |
| ----------------- | ----------- | ---- | ----------------------------------- |
| formId            | string      | ✓    | 表单唯一标识                        |
| title             | string      | ✓    | 表单标题                            |
| fields            | FormField[] | ✓    | 表单字段列表                        |
| submitLabel       | string      | ✓    | 提交按钮文本                        |
| narrativeTemplate | string      | ✓    | 叙事模板，含 `{{fieldName}}` 占位符 |

**FormField**: `{ type, name, label, placeholder?, options?, required?, defaultValue? }`

- type: `text` | `textarea` | `select` | `checkbox` | `number`

**使用者**: char-creator

---

### create-choices

创建选项列表供玩家选择。适用于决策点、分支剧情、NPC 对话选项。

| 参数     | 类型     | 必需 | 描述                         |
| -------- | -------- | ---- | ---------------------------- |
| choiceId | string   | ✓    | 选项组唯一标识               |
| prompt   | string   | ✓    | 引导文本（如"你要怎么做？"） |
| choices  | Choice[] | ✓    | 选项列表（至少 2 个）        |

**Choice**: `{ id, label, description?, category? }`

- category: `safe` | `aggressive` | `creative` | `wild` 等

**使用者**: 通用交互插件。当前 `guide` 采用 `generate-guide + ui.message` 路径来承接更完整的插件自定义 UI。

---

### create-notification

在前端显示一条通知消息。适用于状态变化、获得物品、触发事件等。

| 参数    | 类型   | 必需 | 描述                                     |
| ------- | ------ | ---- | ---------------------------------------- |
| level   | enum   | ✓    | `info` / `success` / `warning` / `error` |
| title   | string | ✓    | 通知标题                                 |
| message | string | ✓    | 通知内容                                 |
| icon    | string |      | 图标名称                                 |

**使用者**: codex

---

### render-ui

渲染一个 `ui.render` 块。每个 part 独立携带状态，适合叙事文本、图片、卡片、音频等混排输出。

| 参数   | 类型           | 必需 | 描述                           |
| ------ | -------------- | ---- | ------------------------------ |
| parts  | UIRenderPart[] | ✓    | UI part 列表                   |
| layout | enum           |      | `stream` / `split` / `overlay` |

**UIRenderPart**:

```typescript
type UIPartStatus = "pending" | "streaming" | "success" | "error" | "paused";

interface UIRenderPart {
  id: string;
  type: string;
  status: UIPartStatus;
  content: unknown;
  retry?: { count: number; lastError?: string };
}
```

工具返回 `{ ui: [{ parts, layout? }] }`，runtime normalizer 会生成 `ui.render` proposal。旧形态 `{ ui: [{ type, ...content }] }` 会自动包装成一个 `success` part。

---

### plugin-data-set

将数据写入插件的持久化存储。数据按 `(sessionId, pluginId, namespace, key)` 隔离，同 `(namespace, key)` 会覆盖旧值。

| 参数      | 类型    | 必需 | 描述                                             |
| --------- | ------- | ---- | ------------------------------------------------ |
| namespace | string  | ✓    | 数据命名空间（如 `schema`, `entries`, `config`） |
| key       | string  | ✓    | 数据键名                                         |
| value     | unknown | ✓    | 要存储的 JSON 数据                               |

**输出**: `{ success, namespace, key }`

**治理路径**: 写入经 Session Kernel commit chain 提交，统一进入 `PreStateCommit` / `PostStateCommit`、trace 与 store 事务。

**保留命名空间**: `_` 前缀的 namespace（`_jobs` 后台任务、`_logs` runtime 日志环）属于框架簿记，插件不可写。该限制由 `reservedPluginDataNamespaceError()`（`packages/shared/src/utils/plugin-data-namespace.ts`）统一实施，覆盖全部插件侧写入口：REST `PUT /api/sessions/:id/plugin-data/...`、`plugin.data` / `plugin.data.batch` commit handler（含 function runtime 输出规范化出的 proposal）、function runtime 的 `ctx.pluginData`、以及 RPC handler 的 store view。框架自身的特权写入者（后台 job runner、runtime logger）直接调 store，不走这些通路。

---

### plugin-data-set-batch

批量写入多条数据到插件持久化存储。一次调用写入整个数组，避免逐条调用的 LLM 轮次开销。适用于需要一次性写入大量条目的场景（如世界初始化）。

| 参数  | 类型                           | 必需 | 描述                     |
| ----- | ------------------------------ | ---- | ------------------------ |
| items | Array<{namespace, key, value}> | ✓    | 要批量写入的数据条目数组 |

每个 item:

| 字段      | 类型    | 必需 | 描述               |
| --------- | ------- | ---- | ------------------ |
| namespace | string  | ✓    | 数据命名空间       |
| key       | string  | ✓    | 数据键名           |
| value     | unknown | ✓    | 要存储的 JSON 数据 |

**输出**: `{ success, count, items: [{ namespace, key }] }`

**治理路径**: 写入经 Session Kernel commit chain 提交，batch 保持单 proposal 粒度，hook / trace / 事务路径与单条写入一致。

**设计原则**: 框架提供通用批量写入能力。对于专用场景（如世界初始化），推荐插件创建自己的 local tools，用更精确的 schema 引导 LLM 生成正确结构的数据。

---

### plugin-data-get

从**当前插件**的持久化存储中读取单条数据。出于安全考虑，不允许跨插件读取。

| 参数      | 类型   | 必需 | 描述         |
| --------- | ------ | ---- | ------------ |
| namespace | string | ✓    | 数据命名空间 |
| key       | string | ✓    | 数据键名     |

**输出**: `{ found, namespace, key, value?, updatedAt? }`

读取会叠加**本次 tool loop 内尚未提交**的 `plugin.data` / `plugin.data.batch` proposal（read-your-own-write）。plugin-data 写入走 proposal、在回合末才提交，若不叠加，同一 loop 内先 `plugin-data-set` 再读同一个 key 会拿到写入**前**的旧值，runtime 因而重复写入或「纠正」一个本已正确的值。叠加只覆盖**本插件自己**的 pending 写入，不放宽插件作用域；同 key 多次写入以最后一次为准（与提交顺序一致）。

---

### plugin-data-list

列出**当前插件**持久化存储中某个 namespace 下的所有数据条目。

| 参数      | 类型   | 必需 | 描述                           |
| --------- | ------ | ---- | ------------------------------ |
| namespace | string |      | 数据命名空间（不传则列出所有） |

**输出**: `{ count, items: [{ namespace, key, value, updatedAt }] }`

与 `plugin-data-get` 一样叠加本 loop 内未提交的 pending 写入；`namespace` 过滤同样作用于 pending 项。

---

### world-dimension-get

按需读取当前 session 绑定世界的结构化维度数据。适合 world 信息字段很多、但 LLM 只需要少量精确字段时使用。

读取顺序：

1. 优先读当前 session 中 `world-data-provider` 插件写入的 `plugin_data[namespace="entries"]`
2. 若该维度不存在，则回退到 `world.metadata.dimensions`

| 参数        | 类型                        | 必需 | 描述                                                  |
| ----------- | --------------------------- | ---- | ----------------------------------------------------- |
| queries     | Array<{ dimension, path? }> | ✓    | 查询列表，至少 1 项，最多 20 项                       |
| resolveI18n | boolean                     |      | 是否按 session locale 解析 i18n 文本对象，默认 `true` |

`dimension` 可选值：

- `geography`
- `factions`
- `powerSystem`
- `history`
- `economy`
- `socialStructure`
- `tone`
- `mechanics`
- `startingConditions`

`path` 语法支持对象点路径与数组下标，例如：

- `contentRating`
- `regions[0].name`
- `tiers[2].description`
- `startingResources.硬币`

**输出 (parsedResult)**:

```json
{
  "_text": "1. tone.contentRating [plugin-data] = \"mature\"",
  "success": true,
  "locale": "zh-CN",
  "results": [
    {
      "dimension": "tone",
      "path": "contentRating",
      "found": true,
      "source": "plugin-data",
      "value": "mature",
      "error": null
    }
  ]
}
```

**文本优先约定**：

- LLM 看到的是 `_text`
- trace / 调试里保留完整 `results`

**适用场景**：

- narrator 只需读取 `startingConditions.openingScenario`
- guide 只需读取 `tone.themes`
- 角色或剧情 agent 只需读取某个势力、地区、力量阶位的精确字段

---

### emit-event

声明在 `packages/tools/src/builtin/emit-event.ts`。发射一个由某个激活插件在 `events`（见 [plugins.md #events-声明与-advertiseevents统一事件发射层](plugins.md#events-声明与-advertiseevents统一事件发射层)）声明的领域事件。校验和 topic 列举委托给注入的 `EventDirectoryLike`（server 侧实现见 `apps/server/src/routes/api/bootstrap/event-directory.ts`），聚合当前 session 激活插件集的声明。

| 参数  | 类型                    | 必需 | 描述                                                    |
| ----- | ----------------------- | ---- | ------------------------------------------------------- |
| topic | string                  | ✓    | 事件 topic，须匹配某个激活插件已声明的 `events[].topic` |
| data  | Record<string, unknown> |      | 事件 payload，按声明的 JSON Schema 校验，默认 `{}`      |

**单通道语义**：发射成功时结果只经 `emittedEvents` result channel 携带（`withEmittedEvents`，见 `packages/tools/src/result.ts`），由工具循环累积、`finalize-agent-output.ts` 合并进 `RuntimeResult.output.events`——**绝不**同时返回 `event.emit` pendingProposal，避免同一事件被 `turn-event-chain.ts` 的 fan-out 与提案归一化重复处理。合并进 `output.events` 后走已有的回合内事件 fan-out（同 depth 同 topic 首胜）与 `event.emit` proposal 归一化，最终以 `event.emitted` SSE 事件下发（见 [protocol.md](protocol.md)）。

**校验流程与错误形态**（错误均以可读文本回给 LLM，供其看错误后重试，不抛异常中断工具循环）：

1. topic 本回合已经发射过（`context.emittedEventTopics` 由工具循环累积传入，见 `packages/tools/src/types.ts` 的 `ToolExecutionContext.emittedEventTopics`）→ no-op：`event "<topic>" already emitted this turn — skipped`，不产生第二条 `emittedEvents`
2. topic 不在当前 session 的**已 advertise 目录**里 → `unknown topic "<topic>". Available topics: <逗号分隔列表，或 "(none — no consumer plugin active)">`。`advertise: false` 的内部 topic 不进 emit-event 白名单（`listTopics` 与 `validate` 均只认 advertised），只能由声明它的插件自己的**函数 runtime**经 `output.events` 结果通道发射——agent 无法经 `emit-event` 直发绕过生成门；回显的可用列表也不泄漏内部 topic 名
3. topic 已知但 payload 未通过 JSON Schema 校验 → `event payload rejected: <ajv 错误文本>`
4. 全部通过 → `event "<topic>" emitted`，结果携带 `emittedEvents`

**一次一个 topic**：单次调用只发射一条事件；需要发多个领域事件时多次调用 `emit-event`。

**去重的作用域是单个 tool loop**：`emittedEventTopics` 由 agent tool loop 逐次累积，因此同一 runtime 在同一回合内重复发同一 topic 会被 no-op。它**不跨 runtime**——同优先级并行组里的两个 runtime 可以各自发同一 topic。这不是缺陷：事件 fan-out 收集阶段按 topic 汇聚（同一深度内 first-emission-wins，见 `collectEventsFrom`），所以下游订阅者仍只被触发一次。

**使用者**：任何声明了 `advertiseEvents: true` 且在 `tools.builtin` 里包含 `emit-event` 的 agent runtime，例如 `narrator`、`chat-mode-narrator`。

---

### suspend

声明在 `packages/tools/src/builtin/suspend.ts`。Agent runtime 调用 `suspend({ reason, resumeSchema })` 时，工具直接返回一个 sentinel 对象 `{ _covelSuspend: true, reason, resumeSchema }`。turn-executor 在每次 tool 执行后通过 `isSuspendSentinel()` 检测：识别到 sentinel 后会序列化当前 pendingContinuation 写入 `suspensions` 表，并发出 `turn.suspended` 事件，整个 tool loop 立即停止。后续可通过 `POST /api/sessions/:id/resume` 提交匹配 `resumeSchema` 的数据重新启动该 runtime（详见 `docs/reference/api.md`）。

| 参数         | 类型   | 必需 | 描述                                                                                                                                             |
| ------------ | ------ | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| reason       | string | ✓    | 给玩家看的简短说明，解释为什么需要输入                                                                                                           |
| resumeSchema | object | ✓    | **纯 JSON Schema 对象**（`type` / `properties` / `required`）。插件如需用 Zod 定义，必须先用 `zod-to-json-schema` 转换 —— 不要传 live Zod schema |

**输出**: sentinel `{ _covelSuspend: true, reason, resumeSchema }`（被 turn-executor 拦截，正常情况下不会作为普通工具结果回到 LLM）

**注意事项**：

- `resumeSchema` 必须可被 `JSON.stringify` —— pendingContinuation 是要落盘的
- 同一 runtime 同一时刻只能有一个未解决的 suspension（resume 路由通过 `runtimeId + sessionId` 查找）
- 注册位置：`bootstrap.ts` 中 `toolMap.set(suspendTool.name, suspendTool)` + `builtinToolNames.add(...)`，所有 agent runtime 自动可用

---

### search-tools（框架注入，延迟工具加载）

契约声明在 `packages/tools/src/builtin/tool-search.ts`，执行逻辑在 `packages/runtime/src/agent-loop/tool-search.ts`。**不可在 `tools.builtin` 中手动声明**——当某个 agent runtime 的 manifest 声明了 `tools.defer`（`true` = 延迟整个白名单；`string[]` = 延迟指定工具名）时，框架把被延迟工具的 schema 从初始 LLM 工具清单中移除，并自动注入本工具。设计对齐 openai/codex 的 `tool_search`（`ToolExposure::Deferred` + BM25）。

| 参数  | 类型   | 必需 | 描述                                        |
| ----- | ------ | ---- | ------------------------------------------- |
| query | string | ✓    | 能力关键词（中英文均可），如 `切换场景背景` |
| limit | number | —    | 最多激活的工具数（默认 8，上限 20）         |

**输出**: 文本列出命中工具的名字与描述；命中工具的完整 schema 自下一次 LLM 调用起加入工具清单，并在本 turn 的 agent loop 内持续有效（跨 turn 重置为精简清单）。

**注意事项**：

- 与 `suspend` / `runtime-done` 同为 loop 层 sentinel：调用被 agent loop 拦截，**永不进入 ToolExecutor**，也不注册在全局 toolMap
- 检索池严格限定为该 runtime 自己声明且被延迟的白名单，schema 通过 `getToolInfo(name, context)` 获取——沿用 builtin/local 访问边界，无权工具既搜不到也不会泄露
- 打分为零依赖 BM25（k1=1.2 / b=0.75），CJK 文本按字符二元组切分，语料 = 工具名 + 描述 + 参数 schema 的字段名/字段描述
- description 会向 LLM 通告延迟池的数量与来源插件，模型据此知道有未预载工具可搜
- 适用场景：单 runtime 白名单超过 ~10 个工具、每次调用全量预载 schema 开始挤占 prompt 预算时

---

## Character 管理工具

框架级角色管理工具，定义在 `packages/tools/src/builtin/character-tools.ts`。写入 `characters` 表（session 作用域，跨插件可见），同时镜像到调用插件的 `plugin_data[pluginId][namespace="characters"][key=charId]`，让右侧面板通过现成的 `plugin-data.changed` SSE 通道实时更新。

### 文本优先（Text-first）约定

这一组工具（以及任何采用该约定的其他工具）的返回值包含一个特殊字段 `_text`：

- **LLM 看到的内容 = `_text` 的原始文本**，不带 JSON 包装
- **框架追踪 / 前端 trace UI 看到的是完整 `parsedResult` 对象**（含 `_text` + 结构化字段）

框架层面（`packages/runtime/tool-executor.ts`）检测 `_text` 字段：

- 如果存在且为字符串 → LLM tool message content 直接写原始文本
- 如果不存在 → 退回到旧的 `JSON.stringify(result)` 行为（向后兼容）

这样的分层让 LLM 看到的是紧凑可读的自然语言（省 token、降噪），而框架依然有结构化数据做调试和追踪。其他 builtin 工具（如 `plugin-data-*`、`create-form`）目前保持 JSON 格式不变。

---

### create-character

创建一个新的角色记录（玩家、NPC 或同伴）。同 session 内同 `(name, type)` 会自动去重 —— 返回已存在的角色 id，不会创建重复项。

| 参数        | 类型                    | 必需 | 描述                                                      |
| ----------- | ----------------------- | ---- | --------------------------------------------------------- |
| name        | string                  | ✓    | 角色名称                                                  |
| type        | enum                    | ✓    | `player` / `npc` / `companion`                            |
| description | string                  |      | 角色简短描述                                              |
| fields      | Record<string, unknown> |      | 属性键值对（应符合世界 schema 中的 character-attributes） |

**输出 (parsedResult)**: `{ _text, success, existed, characterId, name, type }`

**LLM 看到的 `_text` 示例**：

```
Created npc "苏婉" as char-abc123. — 青萍宗外门首席弟子，冰灵根修士。
```

或当去重命中时：

```
Character "苏婉" (npc) already exists as char-abc123. No new record created. Use update-character to modify it.
```

**使用者**: `char-creator/player-init`（创建 player 角色，建角完成后输出 `preGameDone: true`）、`char-creator/character-tracker`（只创建 NPC）

> **Turn-band 重构注记**：`create-character` 原本接受 `transitionPhase` 参数并通过 `CharacterToolHooks.onPhaseTransition` 驱动 SSE `phase.changed` 广播。该路径在 turn-band 重构中被移除——`SessionRecord.phase` 字段已去除，Pre-Game 段落的完成由 runtime 输出 `preGameDone: true` 累加到 `session.preGameCompleted` 集合表达。现在 `create-character` 只写 `characters` 表（并镜像到调用方 plugin-data 的 `characters` namespace），不再触发任何 phase / status 副作用。

---

### update-character

按 id 更新已有角色。`fields` 按 shallow merge 合并（新键覆盖旧键），`version` 自动 +1。适用于状态变化、装备变更、受伤、死亡等。

| 参数        | 类型                    | 必需 | 描述                     |
| ----------- | ----------------------- | ---- | ------------------------ |
| id          | string                  | ✓    | 要更新的角色 id          |
| description | string                  |      | 新描述（未传则保留原值） |
| fields      | Record<string, unknown> |      | 要合并的字段             |

**输出 (parsedResult)**: `{ _text, success, characterId, version }` 或 `{ _text, success: false, notFound: true }`

**LLM 看到的 `_text` 示例**：

```
Updated npc "苏婉" (char-abc123) → v2.
  hp: 100 → 60
  status: alive → wounded
```

---

### list-characters

列出本 session 所有角色（session 作用域，跨插件可见）。输出是**紧凑文本列表**，一行一个角色，包含 id / 名字 / 类型 / 版本 / 简短描述 —— 方便 LLM 快速对齐已知人物，需要完整属性时再单独调用 `get-character`。

**排序算法**：主键 `version desc`（版本越高 = 被交互次数越多 = 频率越高），次键 `updatedAt desc`（频率相同时最近 turn 的优先）。

| 参数 | 类型 | 必需 | 描述                                |
| ---- | ---- | ---- | ----------------------------------- |
| type | enum |      | `player` / `npc` / `companion` 过滤 |

**输出 (parsedResult)**: `{ _text, count, characters: CharacterSnapshot[] }`

**LLM 看到的 `_text` 示例**：

```
Characters in session (3 total, sorted by frequency then recency):
1. 苏婉 [npc] char-abc (v3) — 青萍宗外门首席弟子，冰灵根修士，知晓野生灵脉秘密
2. 柳娘 [npc] char-def (v2) — 药王谷谷主，三百年前见过碧鳞龙
3. 柳无痕 [player] char-xyz (v1) — 青萍宗外门弟子，水灵根中品
```

---

### get-character

按 id 或 name 查询单个角色的**完整属性**（description、version、时间戳、全部 fields）。必须传入 id 或 name 其中之一。与 `list-characters` 的简洁列表形成对照，适合需要深入了解某个角色全部状态的场景。

| 参数 | 类型   | 必需 | 描述                 |
| ---- | ------ | ---- | -------------------- |
| id   | string |      | 角色 id              |
| name | string |      | 角色名称（精确匹配） |

**输出 (parsedResult)**: `{ _text, found, character: CharacterSnapshot }` 或 `{ _text, found: false }`

**LLM 看到的 `_text` 示例**：

```
Character: 苏婉 [npc] char-abc123
Description: 青萍宗外门首席弟子，冰灵根修士。发现百灵沼泽深处一条野生灵脉...
Version: 3
Created: 2026-04-12T04:00:00.000Z
Updated: 2026-04-12T04:24:55.000Z

Attributes:
  hp: 60
  mp: 80
  maxHp: 100
  maxMp: 100
  level: 4
  lingGen: 冰灵根
  status: wounded
```

---

## Local 工具

插件自带的工具，定义在插件包自己的 `tools/` 目录或 runtime 子目录下，使用 `tool()` 包装函数创建。

### Local 工具的推荐使用方式

- 文件放在插件自己的 `tools/` 或 runtime 子目录下
- 在 `entry` 模块（`server/index.js`）里 `covel.registerTool(makeMyTool(covel.toolkit))` 注册；使用工具的 runtime 在 `PLUGIN.md` 里用 `tools.plugin` 按名字声明（旧 `tools.local` 路径声明已弃用）
- 为每个 local tool 提供独立测试
- 持久化写入优先返回 `withPendingProposals(...)`，让 commit chain 接管落盘
- 通过 local tool 封装插件自己的数据 schema 和批量写入逻辑

### set-world-schema

**所属**: world-init (`plugins/world-init/tools/set-world-schema.js`)

定义世界角色属性 Schema。一次调用传入所有属性定义，存储到 `plugin_data` 的 `schema/character-attributes`。

| 参数       | 类型           | 必需 | 描述                          |
| ---------- | -------------- | ---- | ----------------------------- |
| attributes | AttributeDef[] | ✓    | 角色属性定义数组（至少 1 个） |

**AttributeDef**:

| 字段         | 类型     | 必需 | 描述                                                   |
| ------------ | -------- | ---- | ------------------------------------------------------ |
| id           | string   | ✓    | 属性唯一标识                                           |
| name         | string   | ✓    | 属性显示名称                                           |
| type         | enum     | ✓    | `string` / `number` / `array` / `enum` / `boolean`     |
| category     | enum     | ✓    | `stats` / `bio` / `abilities` / `equipment` / `social` |
| min/max      | number   |      | 数值类型的范围                                         |
| defaultValue | unknown  |      | 默认值                                                 |
| itemType     | enum     |      | 数组元素类型（`string` / `number`）                    |
| options      | string[] |      | 枚举选项列表                                           |
| description  | string   |      | 属性说明                                               |

**输出**: `{ success, attributeCount, categories }`

**使用者**: world-init/schema-gen

---

### set-world-entries-batch

**所属**: world-init (`plugins/world-init/tools/set-world-entries-batch.js`)

批量写入世界词条。一次调用传入所有词条（地理、阵营、货币等）。

写入 session lorebook（`store.upsertLorebookEntries`）：每个词条成为一条 `constant` lorebook row，id 稳定化为 `world-entry:<key>`，`insertionOrder` 按批次递增（100, 200, …）。下一轮 prompt 通过 session context snapshot 的 `world.entries` 读取这些词条。

| 参数    | 类型         | 必需 | 描述                      |
| ------- | ------------ | ---- | ------------------------- |
| entries | WorldEntry[] | ✓    | 世界词条数组（至少 1 个） |

**WorldEntry**:

| 字段  | 类型   | 必需 | 描述                                   |
| ----- | ------ | ---- | -------------------------------------- |
| key   | string | ✓    | 词条标识（如 `geography`, `factions`） |
| value | object | ✓    | 词条内容（任意 JSON 对象）             |

**输出**: `{ success, count, keys }`

**使用者**: world-init/schema-gen

---

### unlock-codex-entries

**所属**: codex (`plugins/codex/tools/unlock-codex-entries.js`)

批量解锁图鉴条目，每个条目生成一张"知识发现"UI 卡片。

返回的 `entryId` 使用**语义短 ID** 格式（如 `codex-fire-magic`, `codex-3`），方便 LLM 在后续 `update-codex-entry` 调用中精确引用。

| 参数    | 类型         | 必需 | 描述             |
| ------- | ------------ | ---- | ---------------- |
| entries | CodexEntry[] | ✓    | 要解锁的条目列表 |

**CodexEntry**:

| 字段      | 类型     | 必需 | 描述                                                             |
| --------- | -------- | ---- | ---------------------------------------------------------------- |
| category  | enum     | ✓    | `monster` / `item` / `location` / `lore` / `character` / `skill` |
| title     | string   | ✓    | 条目标题                                                         |
| content   | string   | ✓    | 2-3 句话描述                                                     |
| tags      | string[] | ✓    | 标签列表（1-5 个）                                               |
| rarity    | enum     |      | `common`(默认) / `uncommon` / `rare` / `legendary`               |
| imageHint | string   |      | 视觉描述提示                                                     |

**输出**: `{ unlocked, entries, ui }` — 含稀有度分级的 UI 卡片数组。每个 entry 包含 `entryId`（短 ID）。

**ID 生成**: 使用 `shortIdBatch('codex', titles, sessionId)`，英文标题生成语义 slug（`codex-fire-magic`），CJK 标题回退为计数器（`codex-1`），同一批次内自动去重。

---

### update-codex-entry

**所属**: codex (`plugins/codex/tools/update-codex-entry.js`)

更新已有图鉴条目，追加新发现的信息。

| 参数          | 类型     | 必需 | 描述                                       |
| ------------- | -------- | ---- | ------------------------------------------ |
| entryId       | string   | ✓    | 要更新的条目短 ID（如 `codex-fire-magic`） |
| appendContent | string   | ✓    | 追加的新内容                               |
| newTags       | string[] |      | 新增标签                                   |
| rarityUpgrade | enum     |      | 提升稀有度                                 |

**输出**: `{ updated, entryId, ui }` — 含更新动画的 UI 卡片

---

## 短 ID（LLM 友好实体引用）

工具中需要 LLM 传入或引用的实体 ID 应使用**短语义 ID** 而非 UUID。UUID 对 LLM 有两个问题：

1. **Token 效率低** — 36 字符需 8-10 个 token
2. **难以精确复制** — LLM 容易在长随机字符串中出错

### 设计原则

| 层         | 格式  | 用途                            | 示例                         |
| ---------- | ----- | ------------------------------- | ---------------------------- |
| **存储层** | UUID  | DB 主键、API 路由               | `550e8400-e29b-41d4...`      |
| **LLM 层** | 短 ID | 工具参数、返回值、prompt 中引用 | `codex-fire-magic`, `char-1` |

### 使用方法

框架通过工厂注入提供 `shortId()` 和 `shortIdBatch()`，插件本地工具可直接使用：

```javascript
// 插件工具文件接收注入
export default function ({ tool, z, shortId, shortIdBatch }) {
  return tool({
    name: 'my-tool',
    parameters: z.object({ ... }),
    execute: async (params, context) => {
      // 单个 ID
      const id = shortId('item', 'Dragon Sword', context.sessionId);
      // → 'item-dragon-sword'

      // 批量 ID（自动去重）
      const ids = shortIdBatch('codex', ['Fire Magic', 'Fire Magic', '龙息术'], context.sessionId);
      // → ['codex-fire-magic', 'codex-fire-magic-2', 'codex-1']
    },
  });
}
```

### ID 格式规则

| 输入                                     | 输出                       | 说明                   |
| ---------------------------------------- | -------------------------- | ---------------------- |
| `shortId('char', 'Dragon Knight', sid)`  | `char-dragon-knight`       | 英文 → 语义 slug       |
| `shortId('item', 'Fire Sword', sid)`     | `item-fire-sword`          | 英文 → 语义 slug       |
| `shortId('codex', '龙息术', sid)`        | `codex-1`                  | CJK → session 内计数器 |
| `shortId('npc', '林若风', sid)`          | `npc-2`                    | CJK → session 内计数器 |
| `shortIdBatch('codex', ['A', 'A'], sid)` | `['codex-a', 'codex-a-2']` | 批量自动去重           |

---

## ToolClient

工具执行统一经过 `ToolExecutor`：通过注入的 `findTool(name, context)` 解析出 `ToolModule` 后直接调用 `module.execute(args, ctx)` —— 内置工具和插件本地工具都走这条内存内路径，审批、trace、结果 envelope 由 `ToolExecutor` 统一处理。

**执行端授权（2026-07-20 审计 H-02）**：工具白名单不再只是 LLM 广告面。agent loop 把当前 runtime 的精确授权集（`tools.*` 声明的全部名字 + 非 schema runtime 的 `runtime-done` 框架合同工具；`defer` 名单包含在内——延迟只影响广告、不影响授权）随 `ToolCallContext.authorizedToolNames` 传给 executor，`execute` 在解析/审批之前先校验最终工具名（session override 与 `PreToolUse` 替换之后的名字）∈ 授权集，越界返回 `UNAUTHORIZED` 结构化错误。`search-tools` 在 loop 内被拦截、不达 executor。另外 `findTool` 对缺失 context 的调用 fail-closed：无 context 只能解析 builtin，local 工具一律拒绝。

接口位于 `@covel/tools`：

```typescript
interface ToolClient {
  readonly id: string;
  list(): Promise<readonly ToolDefinition[]>;
  call(
    name: string,
    args: unknown,
    ctx: ToolExecutionContext,
  ): Promise<ToolCallResult>;
  close?(): Promise<void>;
}
```

---

## 审批策略

工具调用经过 `ApprovalPipeline` 审批检查，当前规则（配置在 `apps/server/src/routes/api/bootstrap/tools.ts`）：

| 来源分类        | 规则      | 说明                           |
| --------------- | --------- | ------------------------------ |
| `builtin:*`     | **allow** | 框架内置工具，始终放行         |
| `local:*`       | **allow** | 已发现的插件本地工具，自动放行 |
| `third-party:*` | **deny**  | 未知来源工具，拒绝执行         |

### 来源分类逻辑

Bootstrap 时自动分类：

- `builtinUITools` 中的工具 → `builtin`
- 插件 `tools/` 目录加载的工具 → `local`
- 其他 → `third-party`（当前不存在，预留给社区插件）

### 第三方插件 server-code / local tool 审批边界

社区插件（位于 `~/.covel/plugins/` 或后续添加的非 first-dir 来源）会被 `getPluginTrustInfo` 标记为 `community`，bootstrap 在启动阶段**跳过这些插件的 `entry` 执行与 `tools.local` 急加载**（见 `apps/server/src/routes/api/bootstrap/plugin-entry.ts` / `local-tools.ts` 中 `if (!trust.autoLoad) continue;`）。

完整的 approval 生命周期 **discovered → approved → import → active → revoked / uninstalled 现已实现**：

- **discovered**：拖拽 zip 经 `POST /api/install/plugin` 安装（含反 shadow 校验：保留内置 ID、强制 package.json 与 PLUGIN.md 名一致）。
- **approved**：首次 deferred entry 调用先审批固定的 `covel:plugin-server-code`，加载并验证真实 action 后再做 action 审批。server-code 与 `runtime:*` 只接受 session scope；普通 action 支持 once/session。hosted 环境还要求 operator token，因为 community ESM 在服务端进程内执行。
- **import**：approve 后经 `activatePluginLocalTools` JIT 懒加载该插件的服务端代码——先执行 `entry` 工厂（`ensurePluginEntry`）、再加载旧式 `tools.local`（allow 决定时 + RPC 派发时各触发一次）。
- **active**：运行期工具调用受真实审批规则门控（builtin allow / local allow / third-party deny）。
- **revoked**：`DELETE /api/sessions/:id/approvals[?pluginId=]` 与 plugin disable 会同时清除 session grant、one-time grant 和 pending approval。community grant 不跨 create/fork/进程重启恢复。
- **uninstalled**：`DELETE /api/plugins/:id` 删除 `~/.covel/plugins/<id>` 目录（拒绝内置 ID，返回 `restartRequired:true`）；前端 Settings → Packages 面板列出已安装第三方插件并提供卸载按钮。

实际影响：

- 第三方插件可以通过 `/api/sessions/:id/plugin-rpc` 触发 runtime 调用（HITL 审批 OK）。
- 审批激活后，entry 与旧式 `tools.local` 会 JIT 注册；未授权 session 无法触发 community runtime/hook。
- community entry factory 的 `toolkit.store` 不开放任何方法，因为该全局 factory 没有可绑定的 request session；RPC/function runtime 使用各自的 session/plugin-scoped store。
- community agent guard 仅获得只读 store 与纯输入；`pluginData`、logger、gateway、utils、media、assetProgress 等副作用能力不注入，`recursiveCall` 会拒绝。写入放在 runtime handler 返回的 proposal/`pluginData[]` 中。
- 进程内 ESM 本身不是沙箱。self 层级以本机用户为信任边界；hosted 层级把 community server-code 定义为 operator 级全局信任。真正的多租户第三方代码需要独立 worker/process 隔离。

撰写第三方插件时的当前规约：

- 优先通过 function runtime 返回 proposals / `pluginData[]` 写入。
- entry factory 只注册 tool/hook/RPC/wire，不在 factory 顶层读取 session 或产生业务副作用。
- guard 保持确定性与只读；网络、媒体、递归执行和持久化放入正式 runtime handler。

### 新增插件的工具

新插件只需在 `PLUGIN.md` frontmatter 中声明 `tools.local` 或 `tools.builtin`，bootstrap 会自动发现、注册并归类为对应来源，无需手动修改白名单。

推荐同时补齐三项测试：

1. manifest 中的工具声明可被正确加载
2. tool 参数校验与返回结构稳定
3. tool 对 `plugin_data` / lorebook / `characters` 的写入行为稳定

---

## 交互协议（interaction）

工具可以通过返回值中的 `interaction` 字段声明"需要玩家交互"。框架自动聚合所有交互、返回给前端、等待玩家响应、然后将结果翻译为自然语言注入下一轮上下文。

### 协议流程

```
工具 execute() 返回 { ..., interaction: InteractionPayload }
  ↓ turn-executor 扫描所有 tool result 的 interaction（通用，无硬编码工具名）
  ↓ 聚合为数组存入 TurnMessage.pendingInput
  ↓ 返回 TurnResult.pendingInputs（支持多插件、多交互）
  ↓ 前端渲染所有交互 UI
  ↓ 玩家提交 plugin-rpc framework.submit-form { submissions: [...] }
  ↓ 每个 submission 用 narrativeTemplate 翻译为自然语言
  ↓ 追加到消息历史（纯文本，LLM 看到的和普通消息一样）
```

### 交互类型

| 类型           | 用途      | 模板占位符                                             |
| -------------- | --------- | ------------------------------------------------------ |
| `form`         | 表单填写  | `{{fieldName}}` — 玩家填写的字段值                     |
| `choice`       | 选项选择  | `{{selectedId}}`, `{{selectedLabel}}` — 玩家选择的选项 |
| `confirmation` | 确认/取消 | `{{confirmed}}` — "确认" 或 "取消"                     |

### 返回值示例

```typescript
// 表单交互
execute: async (params) => ({
  created: true,
  interaction: {
    type: "form",
    interactionId: params.formId,
    title: params.title,
    fields: params.fields,
    submitLabel: params.submitLabel,
    narrativeTemplate:
      "你的名字叫 {{characterName}}，拥有 {{spiritRoot}} 灵根。",
  },
});

// 选项交互
execute: async (params) => ({
  created: true,
  interaction: {
    type: "choice",
    interactionId: params.choiceId,
    prompt: params.prompt,
    choices: params.choices,
    narrativeTemplate: "你思考片刻后决定：{{selectedLabel}}。",
  },
});
```

**`narrativeTemplate` 由插件作者编写**，决定了交互结果如何翻译为叙事文本。框架只负责替换占位符。提交后**只有填充后的叙事文本会作为玩家消息追加到对话历史**，框架不再生成任何合成的 assistant-role 镜像消息。

### 提交 API

```
POST /api/sessions/:id/plugin-rpc

{
  "pluginId": "framework",
  "action": "submit-form",
  "payload": {
    "turnId": "...",
    "submissions": [
      { "interactionId": "form-1", "type": "form", "values": { "name": "林清风" } },
      { "interactionId": "choice-1", "type": "choice", "values": { "selectedId": "a", "selectedLabel": "跟随黑袍人" } }
    ]
  }
}
```

---

## 创建新工具

### 方式一：工厂函数（推荐）

插件本地工具使用工厂函数模式，框架通过注入提供 `tool`, `z`, `shortId`, `shortIdBatch`, `withPendingProposals`, `store`：

```javascript
// tools/my-tool.js
export default function ({ tool, z, shortId }) {
  return tool({
    name: "my-tool-name",
    description: "工具描述（会注入 LLM system prompt）",
    parameters: z.object({
      param1: z.string().describe("参数描述"),
    }),
    execute: async (params, context) => {
      // context: { sessionId, turnId, pluginId, runtimeId }
      const id = shortId("item", params.param1, context.sessionId);
      return { id, result: params.param1 };
    },
  });
}
```

**注入对象**:

| 字段                   | 类型      | 描述                                                           |
| ---------------------- | --------- | -------------------------------------------------------------- |
| `tool`                 | function  | `tool()` 包装函数，定义工具参数和执行逻辑                      |
| `z`                    | object    | Zod schema 库，用于参数验证                                    |
| `shortId`              | function  | `shortId(prefix, label, sessionId)` — 生成单个短语义 ID        |
| `shortIdBatch`         | function  | `shortIdBatch(prefix, labels, sessionId)` — 批量生成短 ID      |
| `withPendingProposals` | function  | 把工具返回值和待提交 proposal 绑定，交给 commit chain 统一落盘 |
| `store`                | DataStore | DataStore 实例，用于直接读写持久化数据（如批量操作）           |

### 方式二：直接导出（TypeScript）

```typescript
import { z } from "zod";
import { tool } from "@covel/tools";

export const myTool = tool({
  name: "my-tool-name",
  description: "工具描述",
  parameters: z.object({
    param1: z.string().describe("参数描述"),
  }),
  execute: async (params, context) => {
    return { result: params.param1 };
  },
});
```

> 注意：直接导出模式无法使用 `shortId` 注入，需自行从 `@covel/tools` 导入。

### 声明方式

如需玩家交互，在返回值中添加 `interaction`（见上方交互协议）。

在 `PLUGIN.md` frontmatter 中声明：

```yaml
tools:
  local:
    - ./tools/my-tool-name.js
```

## Proposal 类型

Runtime 输出最终都被规范化为 `Proposal[]`（定义见 `packages/shared/src/types/proposal.ts`），由 commit chain 顺序提交、写入 store、再以 SessionEvent 形式广播。`ProposalType` 由单一真相源 `ProposalPayloadMap` 派生，commit handler 注册表（`satisfies CommitHandlerMap`）与 discovery 广告（`PROPOSAL_TYPES`）均与之编译期对齐——新增 proposal 类型只改 `ProposalPayloadMap` 一处，漏注册 handler 即编译失败。当前已注册类型：`narrative.append`、`state.patch`、`event.emit`、`interaction.request`、`ui.render`、`asset.generate`、`plugin.data`、`plugin.data.batch`、`character.upsert`、`working_memory.set`、`lorebook.upsert`。（历史上的 `phase.transition` 已随 turn-band 迁移移除；从未实装的 `narrative.template`、`record.upsert` 也已移除——它们曾被声明并对外广告但无 commit handler，提交即以 `unknown proposal type` 失败。）

### `ui.render`

写入聊天消息中的通用 UI block，并发出 `ui.rendered` 事件。payload 使用 parts 模型：

```typescript
interface UIRenderInstruction {
  parts: readonly UIRenderPart[];
  layout?: "stream" | "split" | "overlay";
  status?: UIPartStatus;
}
```

commit trace 会记录 `ui.rendered`，并为每个 part 记录 `ui.part.update` trace。`status` 是 UI 展示状态，独立于 runtime 的 `success` / `failed` 执行状态。

### `character.upsert`

写入或更新 session 级角色记录。commit handler 持久化到 `characters` 表，并发出 `character.upserted` SessionEvent。HTTP `POST /api/sessions/:id/characters` 已保持原 URL/响应兼容，但内部通过该 proposal 提交，后续可继续接入 hook/trace 策略而不破坏 API client。

**Payload (`CharacterUpsertPayload`):**

| 字段           | 类型    | 必需 | 描述                                                                            |
| -------------- | ------- | ---- | ------------------------------------------------------------------------------- |
| id             | string  | ✓    | 角色 ID                                                                         |
| name           | string  | ✓    | 角色名称                                                                        |
| type           | string  |      | 角色类型，默认 `npc`                                                            |
| description    | string  |      | 角色描述                                                                        |
| fields         | unknown |      | 角色属性                                                                        |
| version        | number  |      | 版本号，默认 `1`                                                                |
| createdAt      | string  |      | 创建时间，缺省为提交时间                                                        |
| mirrorPluginId | string  |      | 可选：同时镜像到该插件的 `plugin_data/<plugin>/characters/<id>`，供插件 UI 订阅 |

### `working_memory.set`（S3-T3）

写入 session 级工作记忆。commit handler 把 payload 持久化到 `working_memory` 表，并发出一个名为 `working_memory.changed` 的 KernelEvent（runtime 内部事件，目前**不会**通过 SSE 推到前端 —— 相关接入状态见 `docs/reference/protocol.md` 的 "Working Memory / 上下文压缩事件" 段落）。

**Payload (`WorkingMemorySetPayload`):**

| 字段      | 类型    | 必需 | 描述                                        |
| --------- | ------- | ---- | ------------------------------------------- |
| scope     | enum    | ✓    | `player` / `story` / `shared`               |
| key       | string  | ✓    | 条目主键，按 `(sessionId, scope, key)` 唯一 |
| value     | unknown | ✓    | 任意可序列化 JSON 值                        |
| schemaRef | string  |      | 可选 schema 引用，仅作为元数据持久化        |

**写入路径：**

- runtime 端：通过 `Proposal` 输出 `{ type: 'working_memory.set', payload: { scope, key, value, schemaRef? } }`
- HTTP 端：`PUT /api/sessions/:id/working-memory/:scope/:key` 直接调 store，不经 commit chain（详见 `docs/reference/api.md`）

**存储配额（commit 边界）：** 工作记忆常驻每回合 prompt，因此除渲染端的截断（60 条 / 每条 600 字符）外，commit handler 还实施存储配额：单条 value 序列化后上限 8000 字符，单 session 上限 200 条。超限时提交失败并返回错误，**已存在的 key 仍可更新**——只拒绝新 key，避免淘汰 session 正依赖的条目（core memory blocks 也存在这里）。批量状态应写 plugin-data，它不常驻 prompt。

**KernelEvent 输出：**

```json
{
  "type": "working_memory.changed",
  "sessionId": "<id>",
  "turnId": "<id>",
  "source": { "pluginId": "...", "runtimeId": "..." },
  "payload": { "scope": "player", "key": "mood" }
}
```
