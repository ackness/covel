# Session State & Narrative Flow 改动记录

> 本文档记录框架改动、新增字段、已知问题和待办事项。
>
> **2026-04-17 更新（turn-band 重构）**：以下所有历史条目中提到的 `SessionPhase` / `session.phase` / `character_creation` / `transitionPhase` / `phase.changed` 均已废弃。当前实现：`SessionRecord` 取消 `phase` 字段，改用 `status` (`active`/`paused`/`ended`) + `turnCount` + `preGameCompleted: string[]`。Pre-Game 段落由每个 runtime 自行输出 `preGameDone: true` 完成自身登记，框架据此跳过已完成 runtime；不再有全局 phase 状态机。`trigger.phases` 字段也被移除。此说明对下列所有历史段落统一适用，历史条目保留以便追溯上下文。
>
> **2026-04-12 更新**：以下条目中提到的 `_createCharacter` magic flag 与 `submit-inputs.ts` 自动建角色 + 切 phase 的路径已被废弃。当前实现：插件通过 `create-character(transitionPhase="playing")` builtin 工具完成建角色与 phase 切换，框架不再在 submit-inputs 中检测任何插件特定字段。详见 `audits/2026-04-12-backend-webv2-framework-audit/04-changelog.md`。

---

## 2026-04-11: Schema-Driven Character Attributes & UI Panel Refactor

### 新增：CharacterAttributeSchema 共享类型

`packages/shared/src/types/character-schema.ts` — 定义 `AttributeDefinition` 和 `CharacterAttributeSchema`，供 world-init、char-creator、submit-inputs、右侧面板共同使用。

属性类型：`string` | `number` | `boolean` | `enum` | `array`
属性分类：`stats` | `bio` | `abilities` | `equipment` | `social`

### 新增：Schema-Driven 角色创建

- `char-creator/PLUGIN.md` 读取 `{{ config.worldSchema }}` 生成表单字段
- 字段 `name` 与 world schema attribute `id` 对齐（如 `lingGen`、`background`）
- `submit-inputs.ts` 角色创建时合并 schema 默认值（hp、mp、cultivation_layer 等）

### 新增：CharacterPanel 组件

`apps/web/src/components/session/character-panel.tsx` — 替代旧的 GameStatusPanel 角色展示。
按 schema 分类分组渲染：进度条（stats）、Badge（enum）、key-value（string/number）。

### 修复：Session Plugins API 缺少 capabilities

`session.ts` GET `/sessions/:id/plugins` 响应现在包含 `capabilities` 字段，从 manifest + loadedRuntimes 收集。

### 修复：API active → 前端 isActive 字段映射

`api.ts` `listSessionPlugins` 添加字段映射：`active` → `isActive`、`name` → `displayName`。

### 修复：Snapshot API characterSchema 加载

`session.ts` snapshot 路由从 DB `activePlugins` + 全局 registry 查找 world-data-provider（不依赖内存态 session activation），确保 server 重启后仍能返回 characterSchema。

### 修复：restoreSession 加载 sessionPlugins

`session-store.tsx` 的 `restoreSession` 现在调用 `listSessionPlugins` API，确保右侧面板能发现 world-data-provider 插件。

### 修复：submitInteraction 后刷新角色面板

提交角色创建表单后，自动从 snapshot API 加载最新角色数据和 characterSchema。

### 重构：右侧面板 Tab 整理

- 游戏 tab：移除角色重复显示，characterSchema 格式化渲染（非 raw JSON）
- 世界观 tab：显示世界 lore markdown 文档（WORLD.md）
- 移除 plugin_data fetch（world dimension 数据不再在前端直接加载）
- 详细 Tab 定义见 `docs/reference/ui-panels.md`

### 修复：多字段表单 JSON 序列化

`block-renderer.tsx` 多字段表单（无 submitMapping）现在序列化为 JSON 对象，修复角色名 "未命名" bug。

---

## 2026-04-10: Session Kernel & Protocol Layer

## 一、改动概览

### 1. Context 注入增强

插件模板中新增三个上下文变量：

| 变量                       | 类型           | 描述                                                                  |
| -------------------------- | -------------- | --------------------------------------------------------------------- |
| `{{ session.turnNumber }}` | number         | 当前回合数（从消息历史中的 player 消息数计算）                        |
| `{{ session.phase }}`      | string         | 当前会话阶段：`pre-game` / `character_creation` / `playing` / `ended` |
| `{{ player.character }}`   | object \| null | 玩家角色数据（CharacterSummary: name, type, description, fields）     |

**涉及文件**：

- `packages/context/src/types.ts` — 新增 `SessionMeta`、`CharacterSummary` 接口
- `packages/context/src/context-builder.ts` — 扩展 `variables` 对象
- `packages/runtime/src/turn-executor.ts` — 加载 session/character 数据传递给 context builder

### 2. Trigger Phase 门控

`TriggerConfig` 新增 `phases` 字段，允许运行时声明仅在特定会话阶段触发。

```yaml
# 示例：仅在 playing 阶段触发
trigger:
  type: auto
  phases: [playing]
```

**行为**：

- `phases` 未设置或为空 → 所有阶段都触发（默认）
- `phases` 设置但 `sessionPhase` 不在列表中 → 跳过
- `sessionPhase` 为 undefined（无 store / 测试环境）→ 不做 phase 过滤

**涉及文件**：

- `packages/shared/src/types/plugin.ts` — TriggerConfig 加 `phases`
- `packages/shared/src/schemas/plugin.ts` — Zod schema 加 `phases`
- `packages/runtime/src/types.ts` — TriggerContext 加 `sessionPhase`
- `packages/runtime/src/trigger.ts` — `shouldTrigger()` 加 phase 门控逻辑

### 3. Phase 自动转换

运行时输出中包含 `phase` 字段时，turn-executor 自动持久化到 session：

```
pregame 输出 { phase: 'character_creation' }
→ turn-executor 调用 store.updateSession(sessionId, { phase: 'character_creation' })
→ 同 turn 内后续运行时看到更新后的 phase
```

**转换链**：

- session 创建 → `pre-game`
- pregame 运行 → `character_creation`（pregame handler 直接调用 updateSession）
- 角色表单提交 → `playing`（submit-inputs.ts 中 `_createCharacter` 检测后转换）

### 4. 消息持久化（Phase 1）

Server 在 SSE 流中，每发一条事件同步写入 `messages` 表，确保刷新后可恢复。

| 事件                | 持久化内容                                                                                      |
| ------------------- | ----------------------------------------------------------------------------------------------- |
| Turn 开始前         | 玩家消息 → `role: 'user'`, `metadata: { turnId }`                                               |
| `message.completed` | 运行时输出 → `role: 'assistant'`, `metadata: { turnId, runtimeId, kind }`                       |
| `block.emitted`     | 交互 block → `role: 'assistant'`, `content: ''`, `metadata: { turnId, runtimeId, kind, block }` |

**GET /api/sessions/:id/messages** 响应展平 metadata：

```json
{
  "id": "...",
  "role": "assistant",
  "content": "叙事文本...",
  "turnId": "...",
  "runtimeId": "narrator",
  "kind": "story",
  "block": null,
  "createdAt": "..."
}
```

**涉及文件**：

- `apps/server/src/routes/api/actions.ts` — 三处添加 `store.addMessage()`
- `apps/server/src/routes/api/messages.ts` — GET 响应展平 metadata

### 5. create-form 工具增强

`create-form` 工具新增 `createCharacter` 参数：

```typescript
createCharacter: z.boolean()
  .optional()
  .describe(
    "设为 true 表示此表单用于角色创建，提交后框架自动创建 CharacterRecord 并切换 phase",
  );
```

设置后在 interaction 输出中注入 `_createCharacter: true`，submit-inputs 据此自动创建角色 + 转换 phase。

### 6. 插件改动

**narrator**：

- 新增 `{{ player.character }}` 注入
- 叙事规则中说明可以融入角色背景

**char-creator**：

- 表单字段上限从 6 个降到 4 个
- 优先使用选择题（combobox）而非文本输入
- `createCharacter: true` 为必需参数
- 保留对 narrator 输出的依赖（input.inject）

**pregame**：

- 新增 `store.updateSession()` 持久化 phase 到 DB

### 7. 前端修复

- `right-panel.tsx` 角色数据 fetch URL：`/sessions/` → `/api/sessions/`

---

## 二、已知问题（未修复）

### A. 数据持久化 — 统一使用 packages/store

**核心原则**: 所有 session 相关数据必须通过 `packages/store` 的 `DataStore` 接口持久化到 DB，前端统一从 API 恢复，不依赖浏览器 IDB 或内存。

| #   | 数据类型                           | 当前状态                                              | 目标状态                                                                                                  |
| --- | ---------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| A1  | **显示消息**                       | ✅ 已修复 — actions.ts 写入 messages 表               | 刷新后可恢复                                                                                              |
| A2  | **运行时 trace / 日志**            | ❌ 只在 turn_messages 中有原始内容，无结构化 trace    | 每个 runtime 的 LLM 调用、tool calls、耗时、输入输出应通过 `store.addTraceEvent()` 写入 `trace_events` 表 |
| A3  | **执行步骤 (ExecutionStep)**       | ❌ 只存 IDB，Remote 模式下刷新丢失                    | 通过 `store.addTraceEvent()` 写入 `trace_events` 表，前端从 API 恢复                                      |
| A4  | **状态快照 (gameState)**           | ❌ Remote 模式下 `persistStateSnapshot()` 是 no-op    | 通过 `PUT /api/sessions/:id/state-snapshot` 持久化到 DB                                                   |
| A5  | **状态变更 (statePatches)**        | ❌ Remote 模式下 `addStatePatch()` 是 no-op           | Server 在 SSE 流中同步写入 `state_changes` 表                                                             |
| A6  | **已提交 block (submittedBlocks)** | ❌ 只存 IDB (`appKv`)                                 | 需要 server 端持久化，或从 `player_inputs` 表推导                                                         |
| A7  | **LLM 配置管理**                   | 部分 — `llm.toml` 文件级、前端 localStorage           | 配置变更应通过 `plugin_configs` 表持久化，支持运行时修改                                                  |
| A8  | **Provider Keys**                  | ❌ 只在前端 localStorage                              | T3 模式需要 server 端加密存储（安全要求）                                                                 |
| A9  | **Plugin 运行时日志**              | ❌ 各插件的 LLM 交互、工具调用细节不持久化            | 通过 trace_events 或 tool_calls 表持久化，debug 页面可查看                                                |
| A10 | **Session 完整状态恢复**           | ❌ 刷新后 phase/消息部分恢复，角色/状态/事件/图鉴丢失 | 统一恢复机制：一次性从多个 API 加载所有 session 数据                                                      |

### B. 前端数据流断裂

| #   | 问题                                        | 根因                                                                                          | 修复方向                                                                               |
| --- | ------------------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| B1  | **表单提交不走 submit-inputs API**          | 前端 block 表单 onSubmit 走 `send_message` action（当文本发送），不调用 `POST /submit-inputs` | 前端添加 `submitInteraction` 方法，交互 block 走 submit-inputs API                     |
| B2  | **CharacterRecord 不创建**                  | submit-inputs 不被调用 → `upsertCharacter` 不执行                                             | 依赖 B1                                                                                |
| B3  | **Phase 不从 character_creation → playing** | submit-inputs 不被调用 → phase 转换不执行                                                     | 依赖 B1                                                                                |
| B4  | **Narrator 输出不在前端显示**               | SSE handler 按 `kind === "story"` 过滤，但 kind 匹配可能因事件顺序/runtimeId 映射失败         | 排查 `outputKindMap` 填充逻辑、runtimeId 匹配、SSE 事件顺序                            |
| B5  | **Plugin 类消息在刷新后误显示**             | 恢复的消息含 `kind=plugin`，前端过滤逻辑可能不一致                                            | 统一 live SSE 和恢复两条路径的 kind 过滤逻辑                                           |
| B6  | **RemoteDataService 多个方法是 no-op**      | `addMessage()`、`addStatePatch()`、`persistStateSnapshot()` 全是空操作                        | Server 端负责持久化（已部分修复），RemoteDataService 的读取方法需确保从正确的 API 加载 |

### C. 右侧面板数据为空

| #   | 问题               | 根因                                                       | 修复方向                                                                 |
| --- | ------------------ | ---------------------------------------------------------- | ------------------------------------------------------------------------ |
| C1  | **角色面板为空**   | CharacterRecord 不存在 (依赖 B1) + fetch URL 已修复        | 依赖 B1                                                                  |
| C2  | **状态面板为空**   | SSE `state.patch.applied` payload 结构与前端解析不匹配     | 对齐 server 发送格式与前端解析格式                                       |
| C3  | **事件面板为空**   | events 数据不通过 SSE 推送到前端                           | 需要在 turn 执行后推送 event 汇总                                        |
| C4  | **图鉴面板为空**   | codex 数据存在 plugin_data 中，但面板未从 API 加载         | 面板需通过 `GET /api/sessions/:id/plugin-data/:pluginId/:namespace` 加载 |
| C5  | **世界观面板为空** | 需要 `world-data-provider` capability 的插件且面板正确加载 | 验证 world-init 的 capability 声明和面板数据加载路径                     |
| C6  | **知识库面板为空** | 同 C4，依赖 plugin_data API                                | 需要面板组件正确调用 API                                                 |

### D. 推送机制与事件系统

| #   | 问题                             | 描述                                                                        |
| --- | -------------------------------- | --------------------------------------------------------------------------- |
| D1  | **SSE 是唯一实时通道但不可靠**   | SSE 连接断开后无重连恢复机制，丢失的事件无法补回                            |
| D2  | **缺少事件回放能力**             | 前端无法从某个 seq 开始重放 SSE 事件（断点续传）                            |
| D3  | **SSE 事件顺序依赖**             | `runtime.started` 必须在 `message.delta` 前到达才能注册 kind 映射，但无保证 |
| D4  | **缺少统一的 subscription 机制** | 前端各组件各自 fetch，没有统一的数据订阅层                                  |
| D5  | **后续扩展困难**                 | 多人协作、跨设备同步、webhook 回调等场景需要更强的事件基础设施              |

### E. Debug 页面

| #   | 问题                      | 描述                                                                              |
| --- | ------------------------- | --------------------------------------------------------------------------------- |
| E1  | **缺少运行时日志查看**    | /debug 页面应显示每个 runtime 的完整 LLM 调用链（prompt → response → tool calls） |
| E2  | **缺少 plugin data 浏览** | 应能查看各插件存储的数据（world schema、codex entries 等）                        |
| E3  | **缺少状态变更时间线**    | 应显示 state_entries / state_changes 的变更历史                                   |
| E4  | **缺少消息历史查看**      | 应显示 messages 和 turn_messages 两张表的完整数据                                 |
| E5  | **缺少 trace 可视化**     | trace_events 表已有数据结构，但 debug 页面未接入                                  |
| E6  | **缺少配置管理界面**      | LLM config、provider keys、plugin configs 应可在 debug 页面查看和修改             |

### F. 体验问题

| #   | 问题                            | 描述                                                                         |
| --- | ------------------------------- | ---------------------------------------------------------------------------- |
| F1  | **角色创建表单字段过多**        | 已在 PLUGIN.md 限制为最多 4 个 + 优先选择题，但 LLM 可能不遵守               |
| F2  | **Player 消息显示 UUID**        | 提交后 player 消息显示 `Player{uuid}`，应显示角色名或隐藏                    |
| F3  | **叙事内容连贯性依赖 LLM 质量** | narrator 在无角色时的开场质量取决于 LLM，无法保证不会提前假定角色身份        |
| F4  | **Turn 执行时间过长**           | world-init 40-60s + char-creator 30-40s，首轮总计约 1.5 分钟，用户等待体验差 |

---

## 三、架构决策记录

### 决策 1：narrator 始终运行 vs Phase 门控

**讨论过程**：

1. 最初方案 — narrator prompt 加条件分支（turnNumber=1 时只写氛围）→ **否决**：prompt hack
2. 思路 C — narrator 不在 character_creation 阶段运行 → **否决**：Turn 1 没有叙事开场
3. 最终方案 — narrator 始终运行，prompt 无条件分支。Turn 1 时 `player.character = null`，LLM 自然写世界观开场

**结论**：phase 门控系统保留在框架中（其他插件可能需要），但 narrator 不使用。narrator 的行为完全由上下文决定，不由配置决定。

### 决策 2：数据源 — DB vs SSE

**原则**：DB 为 source of truth，SSE 为实时推送通道。

- Server 在 SSE 流中同步写入 `messages` 表
- 前端刷新时从 `GET /api/sessions/:id/messages` 恢复
- SSE 仍用于实时文本流和增量更新
- `RemoteDataService.addMessage()` 保持为 no-op（server 端负责持久化）

### 决策 3：SillyTavern 研究结论

参考 SillyTavern 的设计：

- 角色定义在叙事之前完成（Character Card + Persona）
- First Message 是手写的"种子"，不是 LLM 生成的
- 所有角色数据作为 Permanent Tokens 注入每次 LLM 调用

Covel 选择保留沉浸式角色创建（在叙事中创建），但确保 narrator 在角色创建前后都能正常运行。
