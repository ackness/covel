# Covel 框架架构与执行流程

> 从设置、游玩前、游玩中、游玩后到状态存储，完整描述框架运行机制。
> 包含玩家 ↔ LLM Agent 之间的翻译层、消息流动、插件设计和前端交互。

## 一、系统全景

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Covel 全景架构                                 │
│                                                                             │
│  ┌──────────────┐    SSE/HTTP     ┌──────────────────────────────────────┐  │
│  │   Frontend    │ ◄─────────────► │            Server (Hono)             │  │
│  │  (web-v2)     │                │                                      │  │
│  │              │                │  ┌────────────────────────────────┐   │  │
│  │ json-render  │                │  │       Turn Executor            │   │  │
│  │ catalog      │                │  │  ┌──────────────────────────┐  │   │  │
│  │ pluginData   │                │  │  │   Priority Scheduler     │  │   │  │
│  │ SSE client   │                │  │  │  ┌────┐┌────┐┌────┐     │  │   │  │
│  └──────────────┘                │  │  │  │ P10││ P85││P500│ ... │  │   │  │
│                                  │  │  │  └────┘└────┘└────┘     │  │   │  │
│  ┌──────────────┐                │  │  └──────────────────────────┘  │   │  │
│  │   Plugins     │                │  │           │                    │   │  │
│  │  PLUGIN.md    │────加载────────►│  │     ┌─────▼──────┐            │   │  │
│  │  tools/*.js   │                │  │     │ LLM Gateway │            │   │  │
│  │  ui/*.json    │                │  │     └─────┬──────┘            │   │  │
│  └──────────────┘                │  │           │                    │   │  │
│                                  │  │     ┌─────▼──────┐            │   │  │
│  ┌──────────────┐                │  │     │ Tool Loop   │            │   │  │
│  │   Worlds      │                │  │     └─────┬──────┘            │   │  │
│  │  world.yaml   │────加载────────►│  │           │                    │   │  │
│  │  WORLD.md     │                │  │     ┌─────▼──────┐            │   │  │
│  └──────────────┘                │  │     │Session Kernel│            │   │  │
│                                  │  │     │ (Proposal →  │            │   │  │
│                                  │  │     │  Commit)     │            │   │  │
│                                  │  │     └─────┬──────┘            │   │  │
│                                  │  └───────────┼────────────────────┘   │  │
│                                  │              │                        │  │
│                                  │  ┌───────────▼────────────────────┐   │  │
│                                  │  │        DataStore               │   │  │
│                                  │  │  sessions │ messages │ plugin  │   │  │
│                                  │  │  results  │ characters│ data   │   │  │
│                                  │  └────────────────────────────────┘   │  │
│                                  └──────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
```

## 二、生命周期状态机

### 2.1 会话阶段（Session Phase）

```
                    ┌─────────────────────────────────────────────────┐
                    │                Session 生命周期                   │
                    │                                                 │
  创建会话 ─────────►│  pre-game ─────► character_creation ─────► playing ──┬──► ended
                    │     │                    │                    │     │
                    │     │ core-pregame       │ core-char-creator  │     │ 主动结束
                    │     │ 初始化             │ 表单提交           │     │ 或超时
                    │     │ + world-init       │ + 角色创建         │     │
                    │     │ 世界维度           │ + phase 转换       │     │
                    │     ▼                    ▼                    ▼     │
                    │   Turn 1              submit-inputs         Turn N  │
                    │   (所有插件首轮)       (表单处理)            (循环)  │
                    └─────────────────────────────────────────────────┘
```

### 2.2 单轮执行（Turn）状态

```
  玩家输入 / 开始游戏
        │
        ▼
  ┌─────────────┐
  │ Turn 开始    │  ← POST /api/actions
  │ SSE 流打开   │
  └──────┬──────┘
         │
         ▼
  ┌─────────────────────────────────────────────────────────┐
  │  1. 加载消息历史 + 追加玩家消息                           │
  │  2. 触发过滤：shouldTrigger(manifest, context)           │
  │     ├─ auto: 总是触发                                    │
  │     ├─ scheduled: 每 N 轮 + cooldown + maxTriggerCount   │
  │     ├─ manual: 仅手动触发                                │
  │     ├─ event: 待处理事件匹配                              │
  │     └─ phases: 仅在允许的阶段触发                         │
  │  3. 优先级调度：按 priority 分组                          │
  └──────────────────────┬──────────────────────────────────┘
                         │
         ┌───────────────┼───────────────┐
         ▼               ▼               ▼
  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐
  │ P10: pregame│ │ P85: world  │ │   ...        │  ← 同优先级并行
  │             │ │ init        │ │              │
  └──────┬──────┘ └──────┬──────┘ └──────┬──────┘
         │               │               │
         └───────────────┼───────────────┘
                         ▼
  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐
  │ P500:       │ │ P550:       │ │ P650:       │  ← 下一优先级组
  │ narrator    │ │ guide       │ │ codex       │
  └──────┬──────┘ └──────┬──────┘ └──────┬──────┘
         │               │               │
         └───────────────┼───────────────┘
                         ▼
  ┌─────────────────────────────────────────────────────────┐
  │  4. 收集所有 RuntimeResult                               │
  │  5. normalizeOutput → Proposal[]                         │
  │  6. commitAll → 持久化 + SessionEvent                    │
  │  7. SSE 推送每个 SessionEvent 给前端                      │
  └──────────────────────┬──────────────────────────────────┘
                         │
                         ▼
  ┌─────────────┐
  │ Turn 结束    │  → SSE execution.completed
  │ SSE 流关闭   │
  └─────────────┘
```

## 三、消息翻译层（玩家 ↔ LLM Agent）

这是框架最核心的部分：玩家发的是自然语言，LLM 收到的是结构化 prompt，LLM 返回的是结构化 output，玩家看到的是渲染后的 UI。

### 3.1 输入方向：玩家 → LLM

```
玩家输入                      框架翻译层                         LLM 收到的
─────────                    ────────                         ──────────

"我去探索沼泽"     ──►    Context Builder     ──►    System Prompt:
                          │                          │  你是主叙事生成器...
                          │ 1. 加载 PLUGIN.md         │  <world-lore>九州・云梦泽...</world-lore>
                          │    (agent 指令)           │  <world-dimensions>...</world-dimensions>
                          │                          │  <player-character>
                          │ 2. 注入世界观              │    名字: 陆青云, 灵根: 水灵根...
                          │    {{ world.lore }}       │  </player-character>
                          │                          │
                          │ 3. 注入角色数据            │  History:
                          │    {{ player.character }} │  [user] 我去探索沼泽
                          │                          │
                          │ 4. 注入上游输出            │  Tools available:
                          │    {{ inputs.xxx }}       │  (根据 manifest.tools 注入)
                          │                          │
                          │ 5. 注入消息历史            │
                          │    (append-only store)    │
                          │                          │
                          │ 6. 语言约束               │
                          │    "用中文回复"            │
```

### 3.2 输出方向：LLM → 玩家

```
LLM 返回                     框架翻译层                        玩家看到的
────────                    ────────                         ──────────

narrativeOutput:    ──►    Session Kernel      ──►    ┌─────────────────┐
"沼泽的雾气..."              │                         │  叙事文本         │
                            │ normalizeOutput()        │  (Prose 组件)    │
interactions:       ──►     │ → Proposal[]      ──►    ├─────────────────┤
create-form / form          │                         │  角色创建表单    │
                            │ commitAll()              │  (Form 组件)     │
phase: "playing"    ──►     │ → SessionEvent[]  ──►    ├─────────────────┤
plugin_data 写入      ──►    │ SSE emit()               │  插件消息面 /    │
                            │                         │  右侧面板         │
                            │                  ──►    ├─────────────────┤
                            │                         │  状态更新        │
                                                      └─────────────────┘

                            每个 SessionEvent 通过 SSE 推送到前端
                            MessageList 渲染 turn messages
                            MessagePluginSurface / RightPanel 渲染 plugin surfaces
```

### 3.3 翻译细节：Tool 调用链

```
LLM 决定调用工具                框架处理                        结果
──────────────               ────────                       ──────

LLM: "调用 unlock-         ToolExecutor:
      codex-entries"       1. findTool(name, context)
      { entries: [...] }      ├─ builtin? → 直接访问
                              └─ local? → 检查 pluginToolAccess
                                          (声明了才能用)
                           2. approval.check()
                              ├─ builtin → auto-allow
                              └─ local → allow (或需审批)
                           3. tool.execute(params, context)
                              ├─ 工具逻辑执行
                              ├─ 写入 plugin-data / lorebook / characters
                              ├─ eventBus emit plugin-data.changed ──► SSE → 前端 surface 更新
                              └─ 返回结构化结果或 `_text`
                           4. 结果序列化为 tool message
                              → `_text` 优先作为 LLM 可读文本
                              → 结构化结果保留给 trace / commit / 调试
                           5. LLM 看到结果，决定是否继续调用

                           Tool Loop 直到 LLM 返回 finishReason: 'stop'
```

## 四、插件设计

### 4.1 插件结构

```
plugins/my-plugin/
│
├── PLUGIN.md              ← 核心：frontmatter(配置) + markdown(LLM 指令)
│   │
│   │  frontmatter 定义：
│   │  ┌─────────────────────────────────┐
│   │  │ name, description, priority     │ ← 身份
│   │  │ trigger: { type, interval, ... } │ ← 何时触发
│   │  │ model: "fast"                   │ ← 用哪个 LLM slot
│   │  │ tools: { local: [...], builtin: [...] } │ ← 可用工具
│   │  │ input: { inject: [...] }        │ ← 依赖上游输出
│   │  │ ui: { right: [...], message: [...] }    │ ← 前端 UI
│   │  │ capabilities: [...]             │ ← 能力标签（框架发现用）
│   │  │ outputKind: story|plugin|system │ ← 输出可见性
│   │  └─────────────────────────────────┘
│   │
│   │  markdown body = LLM System Prompt：
│   │  ┌─────────────────────────────────┐
│   │  │ 你是xxx agent。                  │
│   │  │ ## 当前叙事                      │
│   │  │ {{ player.message }}             │ ← 模板变量，运行时填充
│   │  │ ## 你的任务                      │
│   │  │ 1. 分析叙事...                   │
│   │  │ 2. 调用 tool-name 工具...         │
│   │  └─────────────────────────────────┘
│
├── tools/                 ← 工具实现（注入式，零 import）
│   └── my-tool.js
│       export default function ({ tool, z, store, shortIdBatch }) {
│         return tool({
│           name: 'my-tool',
│           parameters: z.object({ ... }),
│           execute: async (params, context) => {
│             // 写入 plugin-data（会触发 SSE 事件）
│             await store.setPluginData({ ... });
│             // 返回结果给 LLM + UI block 给前端
│             return { data: ..., ui: [{ type: 'my-block', ... }] };
│           },
│         });
│       }
│
├── ui/                    ← 前端 UI 声明（json-render spec）
│   ├── my-panel.json      → 右侧面板
│   └── my-block.json      → 消息区 block
│
└── package.json
```

### 4.2 插件间通信

```
插件不直接通信。通过框架中介：

  core-narrator (P500)                  core-guide (P550)
  ────────────────────                  ─────────────────
  输出: { narrativeOutput: "..." }       PLUGIN.md 声明:
          │                              input.inject:
          │                                - from: core-narrator
          │                                  field: narrativeOutput
          │                                  as: "<narrator-output>"
          │                                     │
          ▼                                     ▼
  completedResults Map                   Context Builder
  ┌────────────────────┐                 注入:
  │ "core-narrator" →  │ ───────────────► <narrator-output>
  │  { narrativeOutput │                   沼泽的雾气...
  │    : "沼泽的雾气"}  │                  </narrator-output>
  └────────────────────┘

  框架保证：P500 先执行完，P550 才开始
  → completedResults 里已有 narrator 的输出
```

### 4.3 插件触发决策树

```
                    shouldTrigger(manifest, context)
                              │
                    ┌─────────┴──────────┐
                    │ maxTriggerCount?    │ ← 超过 session 最大次数？
                    │ cooldownTurns?     │ ← 冷却中？
                    │ phases?            │ ← 当前阶段允许？
                    └─────────┬──────────┘
                              │ 通过
                    ┌─────────┴──────────┐
                    │   trigger.type     │
                    ├────────────────────┤
                    │ auto    → true     │
                    │ manual  → isManual │
                    │ scheduled → turn % interval == 0 │
                    │ event   → topic in pendingEvents  │
                    │ error-retry → hasUpstreamFailure  │
                    └────────────────────┘
```

## 五、前端交互设计

### 5.1 渲染管线

```
┌──────────────────────────────────────────────────────────────────┐
│                       前端渲染管线                                │
│                                                                  │
│  SSE 事件                  消息转换层                 渲染层       │
│  ──────────               ────────                 ──────        │
│                                                                  │
│  narrative.delta    ──►  appendDelta()      ──►  Prose           │
│  narrative.completed ──► addMessage(story)  ──►  组件            │
│                                                                  │
│  interaction.requested ──► addMessage(block) ──► messageToSpec() │
│                                                  │               │
│                                                  ▼               │
│                                            nestedToFlat()        │
│                                                  │               │
│                                                  ▼               │
│                                            ┌─────────────┐      │
│                                            │  Renderer    │      │
│                                            │ (json-render)│      │
│                                            │              │      │
│                                            │ catalog:     │      │
│                                            │  Prose       │      │
│                                            │  Form        │      │
│                                            │  Button      │      │
│                                            │  EntryCard   │      │
│                                            │  Alert       │      │
│                                            │  ...25个组件  │      │
│                                            └─────────────┘      │
│                                                                  │
│  plugin-data.changed ──► pluginData store  ──► MessagePluginSurface │
│                          更新 namespace         + RightPanel         │
│                                                  json-render        │
│                                                  Renderer           │
│                                                                  │
│  execution.started  ──►  executionSteps[]  ──►  进度条           │
│  runtime.completed  ──►                                          │
│  phase.changed      ──►  session.phase     ──►  状态标签         │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### 5.2 插件面板数据流

```
  插件工具执行                     服务端                      前端
  ────────────                   ──────                     ──────

  unlock-codex-entries
  params: { entries: [...] }
        │
        ▼
  store.setPluginDataBatch()   ──► 写入 plugin_data 表
        │                          (sessionId, pluginId,
        │                           namespace, key, value)
        │
        ▼
  eventBus.emit({              ──► SSE /events/stream
    topic: "plugin",                或 /actions 流
    _subType: "plugin-data.changed",
    payload: {
      pluginId: "core-codex",
      changes: [{
        namespace: "entries",
        key: "codex-fire-magic",
        value: { title: "火焰魔法", ... },
        operation: "set"
      }]
    }
  })
        │
        ▼                          ──► 前端 SSE handler
                                       │
                                       ▼
                                  applyChanges(pluginId, changes)
                                       │
                                       ▼
                                  pluginData["core-codex"]["entries"]["codex-fire-magic"]
                                  = { title: "火焰魔法", ... }
                                       │
                                       ▼
                                  useSyncExternalStore → notify listeners
                                       │
                                       ▼
                                  PluginPanel re-render
                                       │
                                       ▼
                                  JSONUIProvider state={pluginData}
                                  Renderer spec={codex-panel.json}
                                       │
                                       ▼
                                  SearchInput + FilterBar + CardList
                                  (自动显示新的图鉴条目)
```

### 5.3 表单交互完整流程

```
  ┌─────────────────────────────────────────────────────────────────┐
  │                    角色创建表单流程                               │
  │                                                                 │
  │  Turn 1:                                                        │
  │  ┌────────────────────────────────────────────────────────────┐ │
  │  │ P10  core-pregame      → 初始化, phase → character_creation│ │
  │  │ P85  core-world-init   → 生成/复用世界维度 schema          │ │
  │  │ P500 core-narrator     → 生成开场叙事 (narrativeOutput)    │ │
  │  │ P700 core-char-creator → 读取叙事 + schema → 调用          │ │
  │  │                          create-form 工具 → 返回表单 block  │ │
  │  └────────────────────────────────────────────────────────────┘ │
  │                          │                                      │
  │                          ▼ SSE: interaction.requested           │
  │                                                                 │
  │  前端:                                                          │
  │  ┌────────────────────────────────────────────────────────────┐ │
  │  │ messageToSpec(block) → formToSpec(data)                    │ │
  │  │   → FormHeader + FormField[] + SubmitButton                │ │
  │  │   → json-render Renderer 渲染为交互表单                    │ │
  │  │                                                            │ │
  │  │ 玩家填写：陆青云 / 水灵根 / 渔民之子 / 灵识敏锐            │ │
  │  │                                                            │ │
  │  │ 点击提交 → submitFormInputs():                             │ │
  │  │   1. POST /api/sessions/:id/submit-inputs                  │ │
  │  │      { turnId, formId: "char-creation",                    │ │
  │  │        values: { characterName: "陆青云", ... } }           │ │
  │  │                                                            │ │
  │  │   服务端 submit-inputs:                                    │ │
  │  │   ├─ 找到 narrativeTemplate                                │ │
  │  │   ├─ 填充 {{characterName}} → "陆青云"                      │ │
  │  │   ├─ 生成叙事文本（自然语言，非 JSON）                      │ │
  │  │   └─ 返回 filledNarrative（不写 turn_messages，不建角色）   │ │
  │  │                                                            │ │
  │  │   下一轮 Turn 由 char-creator 运行：                       │ │
  │  │   create-character(transitionPhase: "playing") →           │ │
  │  │     upsertCharacter + updateSession({phase}) +             │ │
  │  │     hooks.onPhaseTransition → SSE phase.changed            │ │
  │  │                                                            │ │
  │  │   2. POST /api/actions (player_action)                     │ │
  │  │      → 触发 Turn 2 → narrator + guide + codex              │ │
  │  └────────────────────────────────────────────────────────────┘ │
  └─────────────────────────────────────────────────────────────────┘
```

## 六、数据存储设计

### 6.1 存储层次

```
┌─────────────────────────────────────────────────────────────────┐
│                        DataStore 接口                            │
│                                                                 │
│  会话级                                                         │
│  ├── sessions          会话记录 (id, worldId, phase, plugins)    │
│  ├── turn_results      每轮聚合结果                              │
│  ├── runtime_results   每个 runtime 的执行结果                   │
│  ├── tool_calls        工具调用审计日志                          │
│  ├── trace_events      追踪事件（调试用）                        │
│  │                                                              │
│  消息级                                                         │
│  ├── turn_messages     追加式消息历史 (system/user/assistant/tool)│
│  ├── player_inputs     玩家表单/选择提交记录                     │
│  │                                                              │
│  游戏数据                                                       │
│  ├── characters        角色记录 (name, type, fields)             │
│  ├── state_schemas     动态状态表 schema                        │
│  ├── state_entries     状态键值对                                │
│  ├── state_changes     状态变更历史                              │
│  ├── events            业务事件（append-only）                   │
│  │                                                              │
│  插件数据                                                       │
│  ├── plugin_data       插件持久化 KV (sessionId+pluginId+ns+key) │
│  ├── plugin_configs    插件配置覆盖                              │
│  │                                                              │
│  世界级                                                         │
│  ├── worlds            世界包记录 (name, lore, dimensions)       │
│  └── approvals         审批记录                                  │
│                                                                 │
│  后端实现:                                                      │
│  ├── MemoryStore      → 内存（开发/测试）                        │
│  ├── PgStore          → PostgreSQL（生产）                       │
│  ├── IdbStore         → IndexedDB（浏览器端 T1/T2）              │
│  └── SqliteStore      → SQLite（轻量部署）                       │
└─────────────────────────────────────────────────────────────────┘
```

### 6.2 plugin_data 隔离模型

```
plugin_data 表 (核心持久化接口):

  ┌──────────────────────────────────────────────────────────┐
  │  Primary Key: (sessionId, pluginId, namespace, key)      │
  │                                                          │
  │  session-1                                               │
  │  ├── core-codex                                          │
  │  │   └── entries                                         │
  │  │       ├── codex-fire-magic → { title, category, ... } │
  │  │       ├── codex-ice-shield → { ... }                  │
  │  │       └── codex-dragon    → { ... }                   │
  │  ├── core-world-init                                     │
  │  │   ├── schema                                          │
  │  │   │   └── character-attributes → { attributes: [...] }│
  │  │   └── entries                                         │
  │  │       ├── geography → { regions: [...] }              │
  │  │       ├── factions  → { ... }                         │
  │  │       └── history   → { ... }                         │
  │  └── core-char-creator                                   │
  │      └── character                                       │
  │          └── player → { name, attributes, ... }          │
  │                                                          │
  │  session-2 (同 world, 不同 session)                       │
  │  ├── core-world-init                                     │
  │  │   └── (guard 从 session-1 复制 → 跳过 LLM)            │
  │  └── ...                                                 │
  └──────────────────────────────────────────────────────────┘

  写入: plugin-data-set / plugin-data-set-batch (builtin tools)
        → 自动触发 plugin-data.changed SSE 事件
  读取: plugin-data-get / plugin-data-list (builtin tools)
  前端: pluginData[pluginId][namespace][key] = value
```

### 6.3 消息历史模型

```
turn_messages (追加式，永不删除):

  ┌────────┬──────────┬────────────┬──────────────────────────────┐
  │ turnId │ source   │ role       │ content                      │
  ├────────┼──────────┼────────────┼──────────────────────────────┤
  │ turn-1 │ system   │ system     │ [世界观摘要]                  │
  │ turn-1 │ player   │ user       │ (空 - 首轮无输入)             │
  │ turn-1 │ runtime  │ assistant  │ 午后的坊市弥漫着灵植的甜香... │
  │ turn-1 │ runtime  │ assistant  │ [角色创建叙事]                │
  │ turn-1 │ player-input│ user    │ [narrativeTemplate 填充结果]  │
  │ turn-2 │ player   │ user       │ 我决定跟师姐去探查灵脉       │
  │ turn-2 │ runtime  │ assistant  │ 清晨，你在老槐树下等到了...   │
  │ turn-2 │ tool     │ tool       │ {"entries":[...]}             │
  │ turn-2 │ runtime  │ assistant  │ (codex 分析结果)              │
  └────────┴──────────┴────────────┴──────────────────────────────┘

  消息历史是 LLM 上下文的一部分。
  每次 Turn 执行时，完整历史传给 Context Builder。
  Context Builder 组装为 LLM messages[] 数组。

  注意：玩家输入只以 `user` 角色追加一行（叙事模板填充结果），
  框架不再为 player-input 生成合成的 `assistant` 镜像消息。
```

## 七、完整游戏流程时序图

```
  玩家                  前端(web-v2)              服务端                     LLM / 工具
  ────                 ──────────              ──────                    ──────────

  打开页面 ──────────► boot()
                       GET /api/worlds
                       GET /api/packages
                       GET /api/ui-specs ◄─── 返回所有已加载插件的面板声明（boot 阶段）
                       渲染世界选择页面

  选择世界 ──────────► selectWorld()
                       渲染会话准备页面
                       (json-render: Card + Badge + Button)

  点击"开始冒险" ────► startGame()
                       POST /api/sessions ──► 创建 session
                       POST /api/actions  ──► SSE 流打开
                       (start_session)        │
                                              ├── executeTurn()
                                              │   ├── P10: pregame
                                              │   │   └── handler() ──────► 初始化,返回
                                              │   ├── P85: world-init
                                              │   │   ├── guard() ────────► 检查复用
                                              │   │   │   └── 有旧数据? ──► skip:true
                                              │   │   │   └── 无数据? ────► skip:false
                                              │   │   └── agent() ────────► LLM 生成 schema
                                              │   │       └── tool: set-world-schema ──► store
                                              │   │       └── tool: set-world-entries ──► store
                                              │   ├── P500: narrator
                                              │   │   └── agent() ────────► LLM 生成叙事
                       ◄── narrative.delta ────┤   │       └── 流式返回
                       ◄── narrative.completed ┤   │
                                              │   ├── P550: guide (cooldown, 首轮跳过)
                                              │   └── P700: char-creator
                                              │       └── agent() ────────► LLM 生成表单
                                              │           └── tool: create-form
                       ◄── interaction.requested
                       ◄── execution.completed─┘
                       │
                       ▼
                       渲染叙事(Prose) + 表单(Form)
                       pluginData 更新 → 聊天内插件消息面 + 右侧面板渲染

  填写角色表单 ──────► submitFormInputs()
                       POST /api/sessions/:id/submit-inputs
                                            ──► 仅填充 narrativeTemplate
                                                返回 filledNarrative
                                                并按 submitBehavior 决定是否自动继续
                       POST /api/actions  ──► send_message(filledNarrative)
                       (Turn 2)               ├── narrator 叙事
                                              └── char-creator deterministic handler
                                                  ├── store.upsertCharacter
                                                  ├── mirror plugin_data[characters]
                                                  ├── 输出 phase: "playing"
                                                  └── eventBus.emit
                                                      → SSE phase.changed
                       ◄── phase.changed ─────┘
                       POST /api/actions  ──► SSE 流打开 (Turn 2)
                       (player_action)        │
                                              ├── executeTurn()
                                              │   ├── P500: narrator ─────► LLM 叙事
                       ◄── narrative.* ───────┤   ├── P550: guide ────────► LLM 建议
                       ◄── action-guide block ┤   │   └── tool: generate-guide
                                              │   └── P650: codex ────────► LLM 分析
                                              │       └── tool: unlock-codex-entries
                       ◄── codex-discovery ───┤           └── plugin-data-set ──► SSE
                       ◄── execution.completed┘

                       渲染叙事 + 引导卡片(Button) + 图鉴面板更新

  点击引导建议 ──────► sendMessage("探查古老结构")
                       POST /api/actions  ──► Turn 3 ...
                       (player_action)

  ... 游戏循环继续 ...
```

## 八、Package 职责与依赖

### 8.1 包在执行流程中的参与

```
执行阶段                     参与的包                          职责
──────────                  ──────                           ──────

启动 → 插件发现              @covel/plugin-loader             扫描 plugins/ 目录
                             ├── discoverPlugins()            发现所有插件
                             ├── loadPluginManifest()         解析 PLUGIN.md frontmatter
                             ├── loadRuntime()                加载 prompt + tools + ui specs
                             └── createPluginRegistry()       内存索引 + session 激活

启动 → LLM 初始化            @covel/ai-provider               多供应商 LLM 抽象
                             ├── presetRegistry               管理 LLM 预设 (llm.toml)
                             ├── slotRegistry                 slot 路由 (default/fast/story)
                             ├── createGatewayAdapter()       统一 generate() 接口
                             └── model-db                     2597 模型能力数据库

启动 → 依赖注入              @covel/tools                     工具系统
                             ├── tool()                       工具定义 wrapper
                             ├── builtinUITools               create-form/choice/notification
                             ├── createPluginDataTools()      plugin-data CRUD + 事件发射
                             └── shortId/shortIdBatch()       LLM 友好的语义 ID 生成

启动 → 状态管理              @covel/state                     动态表 + 变更追踪
                             @covel/events                    EventBus pub/sub + SSE 基础
                             @covel/store                     DataStore 接口 + 4 个后端实现
                             @covel/approval                  工具审批管线

Turn 执行                    @covel/runtime                   核心执行引擎
                             ├── executeTurn()                完整 Turn 管线
                             ├── shouldTrigger()              触发路由
                             ├── scheduleByPriority()         优先级调度
                             ├── executeOneRuntime()          单 runtime 执行
                             ├── createToolExecutor()         工具执行器 + 访问控制
                             └── normalizeOutput()            输出 → Proposal 标准化

上下文组装                    @covel/context                   Prompt 组装
                             ├── buildContext()               模板变量 + 注入块 + 消息历史
                             ├── interpolateTemplate()        {{ }} 占位符替换
                             └── Compactor                    长对话压缩

类型共享                      @covel/shared                   跨包类型定义
                             ├── types/plugin.ts              RuntimeManifest, UISpec, etc.
                             ├── types/protocol.ts            ProtocolEventType, SessionCommand
                             ├── types/execution.ts           TurnResult, RuntimeResult
                             ├── schemas/plugin.ts            Zod 校验 (runtimeManifestSchema)
                             └── schemas/world.ts             世界包校验

测试支持                      @covel/plugin-test-utils         插件作者测试工具
                             ├── MockLLM                      模拟 LLM 响应
                             ├── createTestHarness()          完整测试环境
                             └── factory functions             makeTurnInput, etc.
```

### 8.2 包依赖关系

```
  @covel/shared  (纯类型，零运行时依赖)
       │
       ├──► @covel/context         (模板插值，prompt 组装)
       │         │
       ├──► @covel/ai-provider     (LLM 适配器，模型路由)
       │         │
       ├──► @covel/plugin-loader   (插件发现，PLUGIN.md 解析)
       │         │
       ├──► @covel/store           (DataStore 接口 + 实现)
       │         │
       ├──► @covel/state           (动态状态管理)
       │         │
       ├──► @covel/events          (事件总线 + SSE 订阅)
       │         │
       ├──► @covel/tools           (工具定义 + 内置工具)
       │         │
       ├──► @covel/approval        (审批管线)
       │         │
       └──► @covel/runtime         (组装以上所有包，执行 Turn)
                 │
                 ▼
            @covel/server          (Hono HTTP 层，SSE 流，路由)
                 │
                 ▼
            @covel/web-v2          (前端：json-render + pluginData)
```

### 8.3 各包核心接口

| 包 | 核心导出 | 调用方 |
|----|---------|--------|
| **shared** | `RuntimeManifest`, `UISpec`, `ProtocolEventType`, Zod schemas | 所有包 |
| **plugin-loader** | `discoverPlugins()`, `loadRuntime()`, `PluginRegistry` | server bootstrap |
| **ai-provider** | `createGatewayAdapter()`, `PresetRegistry`, `SlotRegistry` | server bootstrap, runtime |
| **context** | `buildContext()`, `interpolateTemplate()` | runtime (per-runtime) |
| **runtime** | `executeTurn()`, `createToolExecutor()`, `shouldTrigger()` | server actions route |
| **store** | `DataStore` interface, `createMemoryStore()`, `createPgStore()` | server, tools, runtime |
| **events** | `createEventBus()`, `EventBus.emit()`, `EventBus.onEmit()` | server, plugin-data-tools |
| **tools** | `tool()`, `createPluginDataTools()`, `shortIdBatch()` | bootstrap, plugin tools |
| **state** | `createStateManager()`, `StateManager` | server, runtime |
| **approval** | `createApprovalPipeline()`, `ApprovalPipeline.check()` | tool executor |
| **plugin-test-utils** | `MockLLM`, `createTestHarness()` | plugin tests only |

## 九、设计约束与原则

### 框架-插件隔离

```
  ✅ 框架代码中禁止出现具体插件 ID
  ✅ 插件通过 capabilities 标签被发现（不是名字）
  ✅ 工具通过注入获得依赖（不是 import）
  ✅ UI 通过 json-render spec 声明（不是 React 组件）
  ✅ 数据通过 pluginData namespace 隔离（不是共享 state key）
  ✅ 删除任何插件不会导致框架报错
```

### 数据所有权

```
  框架拥有:  session, characters, messages, state
  插件拥有:  plugin_data (按 pluginId 隔离)
  世界拥有:  worlds, lore, dimensions
  玩家拥有:  player inputs, form submissions
```

### 通信协议

```
  前端 → 服务端:  HTTP POST (JSON)
  服务端 → 前端:  SSE (ProtocolEvent)
  服务端 → LLM:   LLM Provider Protocol (OpenAI/Anthropic/etc.)
  插件 → 框架:    Tool return values + Proposal pattern
  框架 → 插件:    Context injection (template variables)
  插件 → 前端:    plugin-data.changed SSE events
  前端 → 插件:    json-render Actions (apiCall / emitEvent)
```
