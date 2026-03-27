# 旧功能在当前 Extension 架构下的迁移设计

## 1. 目标

把 `../ai-gamestudio-dev` 里真正有用户价值的旧功能，迁到当前 `covel` 的 package/extension 架构下，同时保持这些约束：

- 所有模型流量必须继续走 `modules/model-gateway`
- package 不直接选择 provider/model，只声明任务、工具或能力
- storage 继续兼容 in-memory / PostgreSQL
- Web Host 继续作为受信任宿主，不直接动态执行任意第三方前端代码

## 2. 当前真实状态

今天已经真正在跑的，主要是三块：

- package `commands`
- package `blocks` 的 schema 注册与 pending-block 持久化
- package `capabilities/hooks` 作为 block resume handler

今天还没有接进主链路的，主要是：

- package `context providers`
- package-owned `renderers`
- package `artifact types`
- 更完整的 phase hooks / tool calling

这意味着当前 extension 平台更像“命令可用、block 可用、上下文和前端还没接上”的骨架。

## 3. 旧项目里真正要迁的能力

按重要性排序，旧项目里最值得迁的不是“插件目录结构”，而是下面这套组合：

1. 插件/工具调用
2. block 合约与交互恢复
3. world/session bootstrap
4. stateful memory / world state
5. character card / character sheet
6. archive / snapshot / restore
7. preset/runtime settings/debug
8. story image

其中最核心的是：

- `extension metadata -> capability/tool execution -> block contract -> frontend renderer/state`

## 4. 设计原则

### 4.1 三类贡献先分开

旧功能迁移时，不要把所有东西都塞进 command。

应该把 package 贡献明确拆成三类：

- `command-only`
  例：`/packages`、`/trace`、`/world-seeds`
- `context + prompt`
  例：worldbook、persona、character-card、memory-rag
- `block + resume state machine`
  例：guide/choices、character sheet、archive restore confirm

### 4.2 用现有 capability/hook 骨架扩展，不另起一套插件运行时

当前已经有：

- package manifest
- package runtime discovery / enable
- capability / hook registry
- pending block store

所以迁移旧功能时，优先在现有骨架上补主链路，而不是重新引入一套“legacy plugin engine”。

### 4.3 前端 renderer 继续由宿主管控

短期不要让 package 前端代码动态执行。

建议采用：

- package manifest 继续声明 block type / renderer name
- Web Host 维护 allowlist registry
- host-bundled renderer 负责真正渲染

也就是：

- package 声明“我要一个 `character_sheet` block”
- Web Host 决定这个 block 由哪个受信任 React 组件渲染

这比直接动态加载 `extensions/*/client/*.tsx` 更符合当前安全边界。

## 5. 目标架构

### 5.1 Turn 主链路新增 `context assembly`

新增宿主阶段：

1. 读取 `world/session/task binding`
2. 收集启用 package 的 `context providers`
3. 生成 `ContextFragment[]`
4. 送入 prompt graph / narration task
5. 调 model-gateway
6. 对结果执行 block emission / tool dispatch / resume

建议新增统一结构：

```ts
interface ContextFragment {
  id: string;
  packageName: string;
  scope: "world" | "session" | "turn";
  channel: "instruction" | "memory" | "state" | "reference";
  title: string;
  content: string;
  priority: number;
  tokenBudgetHint?: number;
  tags?: string[];
}
```

这样 `core-worldbook`、`core-persona`、`core-character-card`、`core-memory-rag` 都输出同一种结构，由宿主统一排序和裁剪。

### 5.2 在 package runtime 上补 `tool-exposed capability`

旧项目的 plugin/tool calling 不应该被还原成“模型直接调用旧插件”。

建议复用现有 `capabilities`，给 capability 增加一层“是否暴露给模型工具调用”的声明：

```ts
capabilities: [
  {
    id: "worldbook.lookup",
    entry: "server/capabilities/worldbook-lookup.ts",
    inputSchema: "schemas/capabilities/worldbook-lookup.input.json",
    outputSchema: "schemas/capabilities/worldbook-lookup.output.json",
    exposeAsTool: {
      name: "worldbook_lookup",
      description: "Lookup staged or imported world lore."
    }
  }
]
```

宿主负责：

- 收集可暴露工具
- 通过 model-gateway 统一下发 tool schema
- 把 tool call 映射回 package capability

这样保留了：

- package owned logic
- host controlled execution
- provider agnostic tool calling

### 5.3 补 `package state store`

旧项目很多能力本质上不是向量检索，而是会话状态与插件状态。

建议新增统一 package state storage：

```ts
interface PackageStateStore {
  get(input: { packageName: string; scope: "world" | "session"; scopeId: string; key: string }): Promise<unknown | null>;
  put(input: { packageName: string; scope: "world" | "session"; scopeId: string; key: string; value: unknown }): Promise<void>;
  list(input: { packageName: string; scope: "world" | "session"; scopeId: string }): Promise<Array<{ key: string; value: unknown }>>;
  delete(input: { packageName: string; scope: "world" | "session"; scopeId: string; key: string }): Promise<void>;
}
```

这层用于承接旧项目里的：

- world state
- plugin storage
- pending guide state
- character sheet draft state
- image generation pending state

### 5.4 Resume 从“泛型 block response”提升为“package-owned state machine”

当前 `submit_block_response` 已经能进 capability/hook，但还不够系统。

建议把 pending block 记录扩展成：

```ts
interface PendingBlockRecord {
  blockId: string;
  packageName: string;
  blockType: string;
  sessionId: string;
  flowId: string;
  turnId: string;
  resumeHandler: string;
  stateRef?: {
    kind: "package-state";
    key: string;
  };
  blockEnvelope: Record<string, unknown>;
}
```

这样恢复时不是只把表单值塞回宿主，而是回到 package 自己的 resume handler，继续状态机。

## 6. 旧功能到当前 package 的映射

| 旧功能 | 目标 package | 贡献类型 | 宿主需要补什么 |
| --- | --- | --- | --- |
| world seed / world lore | `core-worldbook` | `commands + context + capability` | context assembly、artifact ingest |
| narrator persona / style | `core-persona` | `context` | context assembly、package state |
| character sheets / cards | `core-character-card` | `context + block + resume` | host renderer、package state、resume |
| memory / retrieval / recap | `core-memory-rag` | `context + capability + debug command` | retrieval pipeline、context budget integration |
| guide / choices | `core-guide` | `command + block + resume` | package-owned resume state machine |
| archive / fork restore | `core-archive` | `command + block + lineage UI` | archive lineage view、restore confirmation block |
| runtime preset inspection/edit | `core-presets` | `command + settings surface` | package config UI、binding model |
| debug / trace / package inspect | `core-debug-commands` | `commands` | richer debug read models |
| plugin tool calling | 新增 `capability exposeAsTool` 机制 | `capability/tool` | model-gateway tool bridge |
| story image | 新增 `core-story-image` 或并入 `core-character-card` | `capability + block + artifact` | image mode、artifact/media UI |

## 7. 每个第一方 package 的目标职责

### 7.1 `core-worldbook`

当前：

- 已有 `/world-seeds`
- 已有 legacy staged assets
- 还没有真实 context 注入

目标：

- 管理世界观条目、地点、势力、术语
- 提供 `worldbook-context`
- 提供 `worldbook.lookup` capability/tool
- 提供 world import pipeline：
  - staged markdown -> `World`
  - full text -> `Artifact`
  - headings -> `MemoryDocument`

### 7.2 `core-persona`

当前：

- 只有 placeholder context provider

目标：

- 管理 narrator / GM persona
- 输出 instruction channel context
- 支持 world-level 与 session-level persona 覆盖
- 与 preset 解绑：persona 只提供叙事人格，不直接决定模型

### 7.3 `core-character-card`

当前：

- 只有 placeholder context provider

目标：

- 管理角色实体与角色卡 block
- 提供：
  - `character_sheet` block
  - `character_card_context`
  - 角色状态 package state
- 与旧项目兼容的核心字段：
  - identity
  - attributes
  - inventory
  - status effects
  - notes

### 7.4 `core-memory-rag`

当前：

- 有最小 `/memory`
- ingestion registry 只接了最小能力

目标：

- 管理 memory ingest / retrieve / summarize
- 提供：
  - retrieval context
  - memory debug command
  - archive restore 后的 reindex 策略
- 短期先做“状态记忆 + 文本检索”
- 中期再做真正的 embedding retrieval

### 7.5 `core-guide`

当前：

- `/guide` 已可发 choices block

目标：

- 负责玩家下一步交互提示
- 提供：
  - `choices`
  - `auto_guide`
  - `form_prompt`
- 选择后进入 package-owned resume handler
- 不把“guide 逻辑”写死在 host 内

### 7.6 `core-archive`

当前：

- `/archive` 已可创建快照

目标：

- 管理 snapshot / lineage / restore modes
- 提供：
  - archive summary
  - lineage inspect
  - restore confirm block
- 与 `core-memory-rag` 联动：
  - restore 后重建记忆视图

### 7.7 `core-presets`

当前：

- `/presets` 命令存在
- 真正的 preset 主体仍在 runtime/web host

目标：

- 只承接“preset explanation / editable metadata / policy surfaces”
- 不把 provider 调用下沉到 package
- 最终与：
  - `Connection Profile`
  - `Task Preset`
  - `World/Session task bindings`
  对齐

### 7.8 `core-debug-commands`

目标：

- 不只是 `/trace` `/packages`
- 应扩成：
  - `/prompt`
  - `/context`
  - `/memory-debug`
  - `/package-state`
  - `/archive-lineage`

## 8. 宿主侧必须新增的 extension point

这是迁移旧功能的最小宿主补丁集。

### 8.1 `buildTurnContext()`

新增 runtime host 流程：

- 枚举启用 packages
- 调 `contextProvider.build(context)`
- 生成 `ContextFragment[]`
- 交给 prompt graph 预算器

### 8.2 `packageStateStore`

提供统一 package state 读写接口。

### 8.3 `tool bridge`

在 model-gateway / flow-engine 之间增加：

- package capability -> tool schema
- tool call -> package capability invoke

### 8.4 `host-bundled block renderer registry`

当前 block registry 继续由宿主维护，但要升级成：

- `choices`
- `character_sheet`
- `archive_restore`
- `image_result`
- `debug_table`

这些 renderer 由 host import，package 只声明类型。

### 8.5 `package config surface`

增加 package 级 settings read model：

- package enabled
- package world/session scoped config
- package default bindings

## 9. 推荐实施顺序

### Phase 1: 把 context 接进主链路

目标：

- 让 `core-worldbook / core-persona / core-character-card / core-memory-rag` 真正影响 narration

交付：

- `buildTurnContext()`
- `ContextFragment`
- 最小 package state store
- retrieval debug 命令

这是最优先的一步，因为它直接恢复“旧项目的内容感”和“世界/角色真的在影响输出”。

### Phase 2: 把 block + resume 变成 package-owned state machine

目标：

- 恢复 guide/choice/character interactions 的闭环

交付：

- pending block 扩展记录
- package-owned resume handler
- `core-guide` 正式化
- `character_sheet` block + resume

### Phase 3: 把旧项目里的 plugin/tool calling 迁成 capability tools

目标：

- 恢复旧项目里“叙事后自动触发能力/工具”的效果

交付：

- `exposeAsTool`
- tool bridge
- package capability schemas
- observability for tool calls

### Phase 4: archive / preset / debug / image

目标：

- 恢复完整产品面

交付：

- archive lineage UI
- package config UI
- prompt/context debug view
- story image pipeline

## 10. 不建议的做法

- 不建议把旧项目的 Python plugin engine 原样搬进来
- 不建议让 package 直接发模型请求
- 不建议先做动态 package renderer 加载
- 不建议继续把所有旧功能都塞进 slash commands

## 11. 最终建议

如果只选一个“最值”的起点：

先做：

- `Phase 1 context assembly`

具体顺序：

1. `core-worldbook`
2. `core-persona`
3. `core-character-card`
4. `core-memory-rag`
5. 再做 `core-guide` 的 package-owned resume

原因：

- 这条线最能恢复旧项目“内容真的来自世界/角色/记忆”的感觉
- 对当前架构最顺
- 不需要先解决动态 renderer 和完整 tool bridge

等这一层跑通后，再把旧项目的 plugin/tool calling 收敛成 package capability tools，整体会更稳，也更符合现在的架构约束。
