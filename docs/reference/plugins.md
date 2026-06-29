# 插件注册表

> 所有已实现的 Covel 插件。本页当前以 `plugins/**/PLUGIN.md` 与对应 `handler.js / tools/*.js` 的实现为准。

## 目录

按 **Turn Band**（见 [优先级分带](#优先级分带turn-bands)）分组，点击直达。

### Pre-Game（priority 0–99）

- [`pregame`](#pregame) — 游戏初始化 function runtime
- [`char-creator/player-init`](#char-creatorplayer-init) — 玩家建角 agent runtime
- [`world-init/schema-gen`](#world-initschema-gen) — 世界维度 agent runtime（guard 门控）

### Narrator-prep（priority 400）

- [`npc-graph/rag-retriever`](#npc-graphrag-retriever) — NPC 图谱结构化检索

### Narrator（priority 500）

- [`narrator`](#narrator) — 主叙事生成器

### After-Turn / Narrator-downstream（priority 600）

- [`codex`](#codex) — 知识图鉴 agent
- [`guide`](#guide) — 行动引导 agent
- [`npc-graph/extractor`](#npc-graphextractor) — NPC 关系图抽取 agent
- [`char-creator/character-tracker`](#char-creatorcharacter-tracker) — NPC 发现与状态跟踪 agent

### UI-only（无 runtime，仅出现在[概览表](#概览)）

- `memory` — 长期记忆摘要面板 + 声明默认核心记忆块（`memoryBlocks`），不占调度槽位

### 参考章节

- [概览表](#概览) · [调度层级说明](#调度层级) · [插件结构规范](#插件结构规范) · [超时与智能重试](#超时与智能重试) · [优先级分带](#优先级分带turn-bands) · [框架–插件隔离规则](#框架插件隔离规则)

### 世界插件推荐字段

`world.yaml` 可以声明 `requiredPlugins`、`recommendedPlugins`、`excludedPlugins`、`pluginPolicy` 和 `worldData`。加载后这些值进入 `WorldRecord.metadata`：

- `requiredPlugins`：准备页锁定启用。
- `recommendedPlugins`：准备页默认启用。
- `excludedPlugins`：准备页默认关闭。
- `pluginPolicy`：描述场景意图和组合包，可包含 `preset`、`preferTags`、`avoidTags`、`requireCapabilities`、`requiredPlugins`、`recommendedPlugins`、`excludedPlugins` 和 `packs`。旧的三组插件字段仍兼容，前端会与 `pluginPolicy` 合并。
- `worldData`：可选，指向 `data/world.data.yaml`；当前会读取本地 YAML/JSON/Markdown/Text/Media source，生成轻量 `WorldRecord.metadata.worldData` 摘要，投影 `world:metadata.dimensions`，并在 session 创建时导入 `plugin:*/*`、`plugin:*/*+lorebook`、`lorebook`、`characters`、`media` + `indexTo`。

第三方插件可以把插件数据声明为 `schema: plugin://<pluginId>/<namespace>` 与 `to: plugin:<pluginId>/<namespace>`。完整格式见 [World Data](world-data.md)。

内置组合包由前端提供：`traditional-story`、`dialogue-mode`、`low-cost`。世界可以用 `pluginPolicy.preset` 引用，也可以在 `pluginPolicy.packs` 自定义组合包。对话模式世界通常启用 `chat-mode-narrator`、`scene-cast`、`scene-prompts`、`character-blueprint`、`character-presence`、`player-identity`、`living-world-rules`、`branch-reply`，并排除默认 `narrator`、`guide` 以及包级旧下游插件。多 runtime 插件当前按包选择；例如 `npc-graph/rag-retriever` 和 `npc-graph/extractor` 同属 `npc-graph` 包，准备页会一起启用或关闭。

## 徽章说明 / Badge legend

🔵 core（`pluginType: core-plugin`，不可禁用） · ⚪ optional（`pluginType: plugin`，可禁用） · 🧠 uses LLM（`agent` runtime） · ⚙ pure function（`runtimeType: function`，零 token） · 🖼 UI only（只提供面板，无 runtime）

---

## 调度层级

主循环每一轮的调度图由 **DAG 调度器** 依据每个 runtime 的 `input.inject[].from` 和 `upstreamRequired` 推导 —— 无环依赖的 runtime 自动归入同一层并发执行。下面的 priority 仅作同层内部的稳定排序 tiebreaker，调度的真正依据是依赖声明：

| 层                  | priority | Runtime                                                                      | 说明                                               |
| ------------------- | -------- | ---------------------------------------------------------------------------- | -------------------------------------------------- |
| Narrator-prep       | 400      | `npc-graph/rag-retriever`                                                    | narrator 的依赖上游（function runtime，无 LLM）    |
| Narrator            | 500      | `narrator`                                                                   | 主叙事生成器                                       |
| Narrator-downstream | 600      | `guide` · `codex` · `npc-graph/extractor` · `char-creator/character-tracker` | 四者都只依赖 narrator，彼此独立 → **同层并行执行** |

Pre-Game band（priority `0-99`，由 `packages/runtime/src/schedule/scheduler.ts` 强制）仍走 priority 串行：`pregame(10) → world-init/schema-gen(40) → char-creator/player-init(50)`。Pre-Game 插件之间存在 world context 依赖（player-init 读取 schema-gen 写出的 `world.schema`）；目前在 DAG 里不表达，所以靠 priority 顺序确保 schema 先生成、再让 player-init 读到。

---

## 概览

| ID                             | 类型        | 优先级 | 触发方式                                  | 模型 slot | 描述                                                                                     |
| ------------------------------ | ----------- | ------ | ----------------------------------------- | --------- | ---------------------------------------------------------------------------------------- |
| pregame                        | core-plugin | 10     | scheduled（仅首轮）                       | —         | 游戏初始化（function runtime）                                                           |
| world-init/schema-gen          | core-plugin | 40     | scheduled（仅首轮）                       | `plugin`  | 世界维度初始化（guard + agent，Pre-Game 第二步）                                         |
| char-creator/player-init       | core-plugin | 50     | auto（guard 门控）                        | `plugin`  | 玩家角色创建（agent runtime；依赖 schema-gen 写出的 worldSchema）                        |
| npc-graph/rag-retriever        | plugin      | 400    | scheduled（interval=1，function runtime） | —         | Narrator-prep 层：NPC 图谱结构化检索器，向 narrator 注入相关关系事实                     |
| narrator                       | core-plugin | 500    | auto                                      | `story`   | Narrator 层：主叙事生成器                                                                |
| guide                          | plugin      | 600    | scheduled（interval=1, cooldown=1）       | `plugin`  | Narrator-downstream 层：行动引导 + 聊天内建议面                                          |
| codex                          | plugin      | 600    | auto（每轮，紧跟 narrator 之后）          | `plugin`  | Narrator-downstream 层：知识图鉴系统（agent runtime）                                    |
| npc-graph/extractor            | plugin      | 600    | scheduled（interval=1, cooldown=1）       | `plugin`  | Narrator-downstream 层：NPC 关系图抽取器                                                 |
| char-creator/character-tracker | core-plugin | 600    | scheduled（interval=1, cooldown=1）       | `plugin`  | Narrator-downstream 层：NPC 发现 + 角色状态跟踪                                          |
| memory                         | core-plugin | —      | UI-only（无 runtime）                     | —         | 长期记忆摘要面板 + 通过 `memoryBlocks` 声明默认核心记忆块（剧情/角色关系/场景/玩家状态） |
| cost-gate                      | plugin      | —      | hook-only（opt-in，默认禁用）             | —         | 跨切面：每会话 token 预算门控（hooks：PostLLMResponse/PreSchedule/TurnStart/SessionEnd） |
| director                       | plugin      | —      | hook-only（opt-in，默认禁用）             | —         | 跨切面：用 PostContextAssembly 给本局所有 story runtime 统一注入导演前言                 |
| story-guard                    | plugin      | —      | hook-only（opt-in，默认禁用）             | —         | 跨切面：故事文本红线净化（PostLLMResponse）+ 高危工具拦截（PreToolUse）                  |

---

## pregame

🔵 core · ⚙ pure function

**Quick use**：如果你要在 session 首轮（先于任何 LLM 调用）跑一段确定性的初始化逻辑——读世界观、发欢迎通知、写 welcome banner——挂这个插件。

**路径**: `plugins/pregame/`

| 字段         | 值                                                            |
| ------------ | ------------------------------------------------------------- |
| pluginType   | `core-plugin`（不可禁用）                                     |
| priority     | 10（Pre-Game 阶段，最先执行）                                 |
| trigger      | `scheduled`，`interval: 1`，`maxTriggerCount: 1` — 仅首轮触发 |
| runtimeType  | `function`（纯函数执行，不调用 LLM）                          |
| handler      | `./handler.js`                                                |
| input.inject | 无                                                            |

**职责**: 游戏开始时第一个执行的插件。读取世界观设定，发送欢迎通知，输出世界观摘要供后续叙事插件（narrator、codex、char-creator）作为上下文引导。

**Pre-Game 契约**: 位于 Pre-Game 区段（priority `0-99`），`maxTriggerCount: 1` 保证仅在 session 首轮执行。完成后可在 `RuntimeOutput` 中声明 `preGameDone: true`，框架据此在 `session.preGameCompleted` 集合中记录本 runtime 已完成 Pre-Game 初始化。

---

## world-init

🔵 core · 🧠 uses LLM（guard 可能跳过）

**Quick use**：如果你想让 LLM 在首轮根据 `WORLD.md` 自动派生一套"角色属性 schema + 世界词条"并写进 session lorebook，挂这个插件。已有 schema 时 guard 会直接 skip，零 LLM 开销。

**路径**: `plugins/world-init/`

单 runtime 插件，使用 `guard` 机制实现无 LLM 开销的前置门控。

### world-init/schema-gen

| 字段          | 值                                                            |
| ------------- | ------------------------------------------------------------- |
| pluginType    | `core-plugin`（不可禁用）                                     |
| priority      | 40（Pre-Game 阶段，先于 player-init）                         |
| trigger       | `scheduled`，`interval: 1`，`maxTriggerCount: 1` — 仅首轮触发 |
| model         | `plugin`                                                      |
| guard         | `../../guard.js`                                              |
| capabilities  | `[world-data-provider]`                                       |
| tools.local   | `set-world-schema`, `set-world-entries-batch`                 |
| tools.builtin | `plugin-data-get`, `plugin-data-list`                         |
| ui.right      | `./ui/world-entries.json`, `./ui/world-schema.json`           |

**Guard 门控**: `guard.js` 在 LLM 调用前执行（纯函数，零 LLM 开销）。检查 plugin_data 中是否已有世界维度数据，或从 world.yaml 导入 dimensions。若数据已存在，返回 `{ skip: true }` 跳过 LLM。

**Agent 职责**: 读取世界观文档，通过专用 local tools 批量生成角色属性 schema 和世界词条。只需 2 次工具调用（`set-world-schema` + `set-world-entries-batch`）。

**数据存储结构**:

- namespace `schema` — 维度 schema 定义（plugin_data），通过 `world.schema` 注入 prompt。
- session lorebook（`strategy: 'constant'`）— 世界词条数据，通过 `world.entries` 注入 prompt。

`set-world-entries-batch` 工具写入 session 级 lorebook；每个词条成为一条 `constant` 类型的 lorebook row，id 按 `world-entry:<key>` 稳定化，`insertionOrder` 按批内顺序以 100 为步长递增。

---

## narrator

🔵 core · 🧠 uses LLM

**Quick use**：你想要默认的主叙事引擎——每轮读 `{{ player.message }}` + 世界观 + 历史，输出 `outputKind: story` 的第二人称叙事。换掉它就是换掉整个故事基调。

**路径**: `plugins/narrator/`

| 字段          | 值                                                               |
| ------------- | ---------------------------------------------------------------- |
| pluginType    | `core-plugin`（不可禁用）                                        |
| priority      | 500（Narrator 带，每轮执行）                                     |
| trigger       | `auto` — 每轮 Narrator 带执行                                    |
| outputKind    | `story`（输出显示在主聊天区）                                    |
| model         | `story`                                                          |
| capabilities  | `[narrative]`                                                    |
| tools.builtin | `world-dimension-get`                                            |
| input.inject  | `npc-graph/rag-retriever` → `npcContext` → `<npc-relationships>` |

**职责**: 根据玩家输入、世界观和历史上下文生成主线叙事。输出 `narrativeOutput` 字段供其他插件引用；需要精确世界字段时调用 `world-dimension-get` 按需读取。

**上下文变量**:

- `{{ world.lore }}` — 世界观全文
- `{{ world.dimensions }}` — 世界维度信息
- `{{ world.openingScenario }}` — 开场场景（叙事用整段铺垫）
- `{{ world.openingHook }}` — 可选，会话首屏「扉页大字」（一句话钩子，UI 用）
- `{{ world.openingChips }}` — 可选，会话首屏的 2-4 个短 tag（UI 用）
- `{{ world.tone }}` — 叙事风格设定
- `{{ player.message }}` — 玩家当前输入
- `{{ player.character }}` — 玩家角色数据（CharacterSummary）
- `{{ session.turnNumber }}` — 当前回合数（全局 turnCount）
- `{{ session.status }}` — 会话状态（`active` / `paused` / `ended`）

**调度说明**: Narrator 位于 Narrator 带（priority 500），每个非 Pre-Game 轮都会执行。是否在首轮发声由 Pre-Game 段落的插件流水线决定（例如 char-creator/player-init 在 priority 50 处理玩家建角），Narrator 不再通过 `phases` 自我门控。

---

## npc-graph

⚪ optional · ⚙ pure function（rag-retriever）· 🧠 uses LLM（extractor）

**Quick use**：你想要一张会话级的 NPC 关系图——叙事里提到的人物、势力、欠债 / 结盟 / 背叛关系自动抽取并持久化，narrator 下轮能沿 2-hop 邻居看到"跟这个人相关的所有事实"。

**路径**: `plugins/npc-graph/`

多 runtime 插件。包含两个协作的子 runtime：

### npc-graph/rag-retriever

| 字段         | 值                                                  |
| ------------ | --------------------------------------------------- |
| pluginType   | `plugin`                                            |
| runtimeType  | `function`（无 LLM 调用，纯结构化检索）             |
| handler      | `./runtimes/rag-retriever/handler.js`               |
| priority     | 400（Narrator-prep 层，在 `narrator=500` **之前**） |
| capabilities | `[npc-graph, graph-rag]`                            |
| trigger      | `scheduled`，`interval: 1`                          |

每个非 Pre-Game 回合开始时自动运行：从 `playerMessage` 中匹配 NPC 节点名（含别名，case-insensitive），沿邻接索引做 2-hop BFS，过滤 `invalidAt` 已到期的边，按 `(validAt, |strength|)` 排序后取 top-20，输出 markdown 列表到 `npcContext` 字段。`narrator` 通过 `input.inject` 把这段文本作为 `<npc-relationships>` 块注入 prompt 末尾。

**Phase 3.5 升级路径**：当 framework 层向 function handler 暴露 gateway 后，将升级为"先 embed 查询 → vector search → 子图扩展"的混合检索。当前为纯结构化版本。

### npc-graph/extractor

| 字段          | 值                                                                           |
| ------------- | ---------------------------------------------------------------------------- |
| pluginType    | `plugin`                                                                     |
| runtimeType   | `agent`（LLM 驱动）                                                          |
| priority      | 600（Narrator-downstream 层，与 guide / codex / character-tracker 并行执行） |
| capabilities  | `[npc-graph, relationship-tracking]`                                         |
| trigger       | `scheduled`，`interval: 1`，`cooldownTurns: 1`                               |
| input.inject  | `narrator.narrative` → `<narrator-output>`                                   |
| model slot    | `plugin`                                                                     |
| tools.local   | `upsert-npc-graph`（批量写节点+边）、`list-npc-graph`（列出现有图）          |
| tools.builtin | `plugin-data-list`、`plugin-data-get`                                        |
| ui.right      | `./ui/npc-graph-panel.json`                                                  |

**职责**: 维护一张会话级的人物-关系图。从叙事文本中抽取 NPC 节点（individual / group / faction）、它们的关系（信任、结盟、欠债、背叛等）以及每条关系的自然语言事实，持久化到 `plugin_data` 的 `nodes`、`edges`、`index`、`meta` 四个 namespace。

**数据模型**（`packages/shared/src/types/npc-graph.ts`）:

- `NpcNode`: `{id, name, aliases?, type, labels, summary ≤200 字符, firstSeenTurn, lastSeenTurn, attributes?}`
- `NpcEdge`: `{id, source, target, relation (UPPER_SNAKE_CASE), strength [-1..1], fact (完整一句话), validAt, invalidAt?, evidenceTurnIds}`
- `NpcGraphOntology`: `{version, entityTypes, edgeTypes, createdAt, updatedAt}` — 本体约束

**本体设计（受 MiroFish 启发）**:

- 节点类型固定三类：`individual | group | faction`
- 关系类型推荐 10 种 `TRUSTS / FEARS / RESPECTS / ALLY_OF / OPPOSES / COMPETES_WITH / WORKS_FOR / SUBORDINATE_OF / OWES_DEBT_TO / KNOWS_ABOUT`
- LLM 使用 `upsert-npc-graph` 时通过 **name** 而非 ID 引用节点，工具内部去重并分配短 ID（`npc-xxxx`、`edge-xxxx`）
- 每条 edge 的 `fact` 必须是完整自然语言句子 —— 这是 Phase 3 Graph-RAG 的检索单元

**存储布局**（`plugin_data` 表中）:

```
namespace="nodes"  key=npcId      value=NpcNode
namespace="edges"  key=edgeId     value=NpcEdge
namespace="index"  key=by-source:{npcId} | by-target:{npcId}  value=string[] (edge IDs)
namespace="meta"   key=ontology   value=NpcGraphOntology (Phase 3 wire-up)
```

**Phase 进度**: 当前实现已经包含 `ui/npc-graph-panel.json` 与 `GraphCanvas`。后续演进点集中在 Graph-RAG 的向量检索部分。

---

## codex

⚪ optional · 🧠 uses LLM

**Quick use**：你想要一本自动更新的世界百科——LLM 读每轮叙事识别新地点/人物/势力/物品，unlock 成卡片；重复出现时补充原有条目而不是新建。

**路径**: `plugins/codex/`

| 字段         | 值                                                                                                                                            |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| pluginType   | `plugin`（可禁用）                                                                                                                            |
| priority     | 600（Narrator-downstream 层）                                                                                                                 |
| runtimeType  | `agent`（默认，LLM 驱动）                                                                                                                     |
| trigger      | `auto`（每轮触发；`upstreamRequired: [narrator]` 保证在 narrator 失败时 skip，不会用空 `<narrator-output>` 幻觉）                             |
| model        | `plugin`                                                                                                                                      |
| tools.local  | `unlock-codex-entries`, `update-codex-entry`                                                                                                  |
| ui.right     | `./ui/codex-panel.json`                                                                                                                       |
| ui.message   | `./ui/codex-message.json`                                                                                                                     |
| input.inject | `narrator` → `narrativeOutput` → `<narrator-output>`<br>`plugin-data[entries]` → `<existing-entries>`（`format: summary`，`maxEntries: 100`） |

**职责**: 分析叙事文本，识别并登记本轮出现的知识条目（地点 / 人物 / 势力 / 物品 / 技能 / 传闻 / 怪物）。对"没有新发现"的回合直接结束。prompt 里同时看到本轮叙事 `<narrator-output>` 和已登记条目 `<existing-entries>`，所以 LLM 一次调用即可决定是 `unlock-codex-entries`（新增）还是 `update-codex-entry`（补充已有），无需额外调用 `plugin-data-list` 往返。

**数据持久化**: `unlock-codex-entries` 批量写入 `plugin_data[entries]`；`update-codex-entry` 读取指定 `entryId`（就是 plugin-data 的 key，形如 `codex-xxx`）并按 append-only 语义合并内容、合并标签、可选升级 `rarity`。

**框架能力依赖**：`input.inject: plugin-data` source 由 `@covel/context` 的 async build 路径提供；当 manifest 声明了任何 `kind: plugin-data` 注入时，turn-executor 会自动切到异步装配路径并调用 `store.listPluginData(sessionId, pluginId, namespace)`。同步路径保持零改动，其他插件不受影响。

**UI 面板**: `ui/codex-panel.json` 承接完整图鉴，`ui/codex-message.json` 负责聊天内的本轮新增摘要。框架通过 `/api/ui-specs` 发现并渲染这两个 surface。

---

## char-creator（角色子系统）

🔵 core · ⚙ pure function（player-init）· 🧠 uses LLM（character-tracker）

**Quick use**：你要玩家在首轮填一张"角色创建表单"生成主角；并且每轮自动跟踪叙事里出现的 NPC、角色状态变化（受伤、死亡、装备、关系）并写进 `characters` 表。两个子 runtime 共用同一个 `character-panel.json` 侧边栏。

**路径**: `plugins/char-creator/`

多 runtime 插件。player-init 负责玩家角色创建，character-tracker 负责持续跟踪 NPC 和角色状态变化。两者共用同一个 `character-panel.json` 侧边栏面板（通过 `group: "character"` 聚合）。

### char-creator/player-init

| 字段        | 值                                                                                |
| ----------- | --------------------------------------------------------------------------------- |
| pluginType  | `core-plugin`（不可禁用）                                                         |
| priority    | 50（Pre-Game 带）                                                                 |
| runtimeType | `function`                                                                        |
| handler     | `./handler.js`                                                                    |
| trigger     | `scheduled`，`interval: 1`，`maxTriggerCount: 2`（首轮生成表单 + 表单提交后写库） |
| guard       | `./guard.js` — 若 player 已存在则 skip                                            |
| model       | `plugin`                                                                          |
| ui.right    | `../../ui/character-panel.json`                                                   |

**两步流程**（当前由 deterministic handler 完成）：

1. **第 1 步 - 生成表单**（`<player-submission>` 为空时）：
   - 读取世界 schema
   - 直接返回 `interaction.request` 形式的角色创建表单
   - 表单字段从 `worldSchema.character-attributes.attributes` 中选取，最多 4 个字段含 `characterName`

2. **第 2 步 - 提交创建**（`<player-submission>` 包含表单值时）：
   - 读取最近一次 player input submission
   - 合并 schema `defaultValue`
   - 直接写入 `characters` 表与 `plugin_data[characters]`
   - 输出 `preGameDone: true`，标记本 runtime 已完成 Pre-Game 初始化（框架将其累加到 `session.preGameCompleted`）

**当前代码状态**: 这一条路径已经保持在插件包内部，实现位于 `runtimes/player-init/handler.js`。如果后续希望统一 deterministic runtime 的 trace 与工具链，可以把这条流程收敛到 builtin character tools。

### char-creator/character-tracker

| 字段             | 值                                                                         |
| ---------------- | -------------------------------------------------------------------------- |
| pluginType       | `core-plugin`                                                              |
| priority         | 600（Narrator-downstream 层，与 guide / codex / extractor 并行）           |
| trigger          | `scheduled`，`interval: 1`，`cooldownTurns: 1`                             |
| model            | `plugin`                                                                   |
| tools.builtin    | `create-character`, `update-character`, `list-characters`, `get-character` |
| input.inject     | `narrator` → `narrativeOutput` → `<narrator-output>`                       |
| upstreamRequired | `[narrator]` — 框架在 narrator 失败时 skip                                 |

**职责**: 每轮扫描 narrator 输出，发现新的有名字 NPC → `create-character(type="npc")`；检测叙事中的角色状态变化（受伤、死亡、装备、关系）→ `update-character(fields: {...})`。工作流：

1. `list-characters` 获取现有角色（避免重复）
2. 阅读叙事识别新 NPC + 状态变化
3. 仅对明确出现的变化调用 create/update 工具
4. 每次最多创建 5 个 NPC（防止 runaway）
5. 不修改玩家角色属性（除非叙事明确描述）

---

## guide

⚪ optional · 🧠 uses LLM

**Quick use**：你要让 LLM 在每轮叙事之后给玩家提三组行动建议（safe / aggressive / creative）并接入聊天输入框——让 narrator 专注叙事、选择引导交给这个插件。

**路径**: `plugins/guide/`

| 字段             | 值                                                                           |
| ---------------- | ---------------------------------------------------------------------------- |
| pluginType       | `plugin`（可禁用）                                                           |
| priority         | 600（Narrator-downstream 层，与 codex / extractor / character-tracker 并行） |
| trigger          | `scheduled`，`interval: 1`，`cooldownTurns: 1`                               |
| model            | `plugin`                                                                     |
| tools.local      | `generate-guide`                                                             |
| ui.message       | `./ui/action-guide-block.json`                                               |
| input.inject     | `narrator` → `narrativeOutput` → `<narrator-output>`                         |
| upstreamRequired | `[narrator]`                                                                 |

**职责**: 在叙事推进后，分析当前情境，为玩家生成分风格的行动建议。让 narrator 专注叙事，选择引导交由本插件。

**风格分类**:

- **safe（稳妥）** — 低风险、谨慎的选择
- **aggressive（激进）** — 直接、对抗性的选择
- **creative（创意）** — 非常规、巧妙的选择

**触发逻辑**: `cooldownTurns: 1` 确保首轮不触发（避免与角色创建冲突）。位于 After-Turn 带，每轮 narrator 之后执行。如果叙事中没有明显决策点，LLM 不会调用工具。

**UI 渲染**: 当前 `generate-guide` 会把 `topic` 与三组建议写入 `plugin_data[message]`。`ui/action-guide-block.json` 读取这些字段，渲染三组策略卡和自定义输入；玩家点击建议后进入待发送区，由底部输入栏统一发送。

---

## cost-gate

⚪ optional · ⚙ hook-only（无可调度 runtime）

**Quick use**：想给每局对话设一个 token 花费上限——接近上限时自动停掉后台生成（codex / guide / 抽取器），到上限时暂停本回合——启用这个插件。它完全靠生命周期 hook 工作，不进调度、不写库。

**路径**: `plugins/cost-gate/`

| 字段         | 值                                                                                                   |
| ------------ | ---------------------------------------------------------------------------------------------------- |
| pluginType   | `plugin`（可禁用；前端 `low-cost` 组合包默认启用, 其它包 / 世界需手动启用）                          |
| runtimeType  | `function`（无 LLM；`trigger: manual` 的 no-op handler，永不调度）                                   |
| outputKind   | `system`                                                                                             |
| capabilities | `cost-control`                                                                                       |
| hooks        | `PostLLMResponse`(计量) · `PreSchedule`(软上限收窄) · `TurnStart`(硬上限 abort) · `SessionEnd`(清理) |

**职责**: Covel 首个消费 hook 生命周期的「跨切面框架能力插件」示例。维护每会话的进程内 token 计数：

- `PostLLMResponse`（`enforce: post`）累加每次 LLM 调用的 `usage`，纯观察不改写；
- `PreSchedule` 在软上限后把本回合 runtime 收窄为仅 `outputKind: "story"`（按字段判定，不硬编码插件 ID），跳过后台 LLM 生成；
- `TurnStart`（`enforce: pre`）在硬上限 abort 整回合，`abortReason` 透传前端；
- `SessionEnd` 清理该会话的计数桶，防止进程内 Map 泄漏。

Pre-Game runtime（priority ≤ 99）由框架强制保护，`PreSchedule` 收窄只影响主循环。

**配置（per-session userSettings，env 兜底）**: 两个阈值现已 per-session 可配——hook 经 `HookContext.getOwnSettings()` 读取本插件解析后的 `userSettings`（manifest 默认值与玩家保存值合并的冻结快照），玩家可在 `设置 > Plugins > cost-gate` 按局调整。`softTokens`（默认 150000）软上限 · `hardTokens`（默认 200000）硬上限。每次 hook 调用按三级回退链解析：**per-session `userSettings` → env（`COST_GATE_SOFT_TOKENS` / `COST_GATE_HARD_TOKENS`）→ 硬编码默认**，故只设 env 的旧部署照常工作。软上限须低于硬上限，否则收窄无窗口（cost-gate 一次性告警）。

**限制**: 计数为进程内、非持久——重启清零，多进程（PG / T3）不共享（单进程 T1/T2 是硬上限，T3 为每进程软信号）。详见 `plugins/cost-gate/README.md`。

---

## director

⚪ optional · ⚙ hook-only（无可调度 runtime）

**Quick use**：想让本局所有叙事（narrator / chat-mode-narrator 等所有 story runtime）共享一致的语气 / 安全 / 风格前言，而不必逐个改它们的 postHistory——启用这个插件。

**路径**: `plugins/director/`

| 字段         | 值                                                       |
| ------------ | -------------------------------------------------------- |
| pluginType   | `plugin`（可禁用，默认不启用）                           |
| runtimeType  | `function`（no-op handler，`trigger: manual`，永不调度） |
| outputKind   | `system`                                                 |
| capabilities | `narration-director`                                     |
| hooks        | `PostContextAssembly`（turn 级、每 runtime 一次）        |

**职责**: 用 `PostContextAssembly` 在每个 story runtime 的系统提示末尾追加统一的「导演前言」。仅对 `payload.outputKind === "story"` 的 runtime 注入（按字段判定，不硬编码插件 ID）；非 story runtime 原样放行。前言文本为插件自带静态常量。

为支持这种「只塑形 story」的判定，框架给 `PostContextAssembly` 的 payload 增加了只读 `outputKind` 字段（`AssembledContextView.outputKind`，可选、纯增量、hook 不可改写）。

**限制**: 前言来自插件包内静态资源；若要「每会话可调」，可配合 `HookContext.getOwnSettings()`（见 [plugin-authoring](../guide/plugin-authoring.md) hooks 段）。详见 `plugins/director/README.md`。

---

## story-guard

⚪ optional · ⚙ hook-only（无可调度 runtime）

**Quick use**：托管 / 多人环境想要一层可插拔的内容安全——对故事文本做确定性红线净化、剥离模型自我暴露 / 选项菜单，并拦截高危工具调用——启用这个插件。

**路径**: `plugins/story-guard/`

| 字段         | 值                                                       |
| ------------ | -------------------------------------------------------- |
| pluginType   | `plugin`（可禁用，默认不启用）                           |
| runtimeType  | `function`（no-op handler，`trigger: manual`，永不调度） |
| outputKind   | `system`                                                 |
| capabilities | `content-safety`                                         |
| hooks        | `PostLLMResponse`（净化）· `PreToolUse`（拦高危工具）    |

**职责**: 两道确定性、保守的守卫：

- `PostLLMResponse` 对 `response.content` 做红线净化（剥离 AI/模型自我暴露样板、Llama 模板标记、部署配置的红线词）+ 选项菜单剥离（连续 ≥2 行的枚举选项 / 带尾冒号的菜单头；孤立的行首缩写如 `C. S. Lewis` 不误伤）。完整回填 `LLMResponse`（仅换 content）；净化为空时保守放行（绝不把真实叙事清成空白）。
- `PreToolUse` 对高危工具名（`delete-everything` / `drop-database` 等 deny-list，可经 env 扩展）返回 `abort`，仅跳过该工具不中断回合。

> 注意：PreToolUse 的工具名嵌在 `payload.toolCall.name`，而 frontmatter `match` 只对顶层 payload key 等值，故 deny-list 判定在 handler 内完成。

**配置（env）**: `STORY_GUARD_REDACT_TERMS`（额外红线词，逗号分隔）· `STORY_GUARD_REDACT_MARK`（替换标记，默认 `[redacted]`）· `STORY_GUARD_BLOCKED_TOOLS`（额外拦截工具名）。

**限制**: 净化是确定性正则，不替代模型层安全；依赖 M1（resume 路径已接 `PostLLMResponse`，本批审计已修）才能覆盖挂起→恢复的输出。详见 `plugins/story-guard/README.md`。

---

## 规划中插件（待开发）

| 插件       | 预期优先级 | 描述          |
| ---------- | ---------- | ------------- |
| combat     | 420        | 回合制战斗    |
| inventory  | 600        | 物品/装备管理 |
| core-quest | 650        | 任务追踪      |
| image      | 800        | 故事配图生成  |

当前世界包推荐使用 `pluginPolicy` 表达插件组合意图。内置前端组合包包括：`traditional-story`（传统叙事主线 + 行动建议/图鉴/关系图，玩家口吻设置为可选项）、`dialogue-mode`（对话优先叙事 + 场景演员/短句回复 + 玩家口吻设置）、`low-cost`（保留核心流程并减少下游 LLM 调用，玩家口吻设置为可选项）。世界可以通过 `preset` 引用这些组合包，也可以在 `packs` 中提供自定义组合。

---

## 插件结构规范

### 单 runtime 插件（默认）

```
plugins/<plugin-id>/
├── README.md              # 必需：给人类 / 开发者看的插件说明
├── PLUGIN.md              # 必需：frontmatter 元信息 + Markdown 提示词
├── package.json           # 必需：workspace 依赖声明
├── vitest.config.ts       # 可选：测试配置
├── tools/                 # 可选：本地工具实现
│   └── my-tool.ts
├── tests/                 # 可选：测试文件
│   └── my-plugin.test.ts
└── references/            # 可选：按需加载的参考资料
    └── world-lore.md
```

### 多 runtime 插件

一个插件可以包含多个子运行时，放在 `runtimes/` 目录下。每个子运行时有独立的 PLUGIN.md。`name` 字段使用 `plugin-id/runtime-name` 格式（斜杠分隔）。

```
plugins/<plugin-id>/
├── README.md              # 必需：给人类 / 开发者看的插件说明
├── package.json
├── PLUGIN.md              # 可选：包级摘要（见下）
├── runtimes/
│   ├── runtime-a/
│   │   ├── PLUGIN.md      # name: plugin-id/runtime-a
│   │   └── PLUGIN.en.md   # 可选：英文版
│   └── runtime-b/
│       ├── PLUGIN.md      # name: plugin-id/runtime-b
│       └── handler.js     # function runtime 的 handler
└── tools/                 # 可选：所有子运行时共享的工具
```

> 真实多 runtime 范例见 `plugins/npc-graph/`（`extractor` agent + `rag-retriever` function）和 `plugins/char-creator/`（`player-init` 首轮 agent + `character-tracker` 持续 agent）。`world-init` 当前是单 runtime（`schema-gen`）+ 一个 `guard` 文件，不算多 runtime。

子运行时之间可通过 `input.inject` 传递数据（上游输出 → 下游 prompt 注入）。

#### README.md（必需，用于人类阅读）

每个插件根目录都需要 `README.md`。它不参与 runtime 执行，也不会被当作模型提示词；它服务于插件作者、维护者和代码审核者。建议包含：

- 插件解决什么玩家问题
- 运行时组成：哪些 agent runtime、哪些 function runtime、哪些 UI 面板
- 数据读写：主要 namespace、world-data schema、角色 / lorebook / media 写入
- 主要文件：`handler.js`、`tools/`、`ui/`、`schemas/`、`tests/`
- 测试方式、已知限制和后续计划

#### 包级 PLUGIN.md（可选，用于 displayName）

多 runtime 插件可以在根目录放置一个**仅含摘要 frontmatter** 的 `PLUGIN.md`，框架会用它作为整个插件的展示信息（在插件列表、provider 切换器等地方显示）。该文件**不**作为 runtime 加载，只读取以下三个字段：

```yaml
---
name: # I18nText：插件展示名（不是 runtime name）
  zh-CN: "DashScope"
  en-US: "DashScope"
description: # I18nText：包级简介
  zh-CN: "阿里云 DashScope 图像生成插件。"
  en-US: "Aliyun DashScope image generation plugin."
pluginType: plugin # core-plugin | plugin
---
```

**没有**这个文件时，框架强制把展示名设为 plugin id（如 `dashscope-image-gen`），UI 上会显得冗长且不直观。第三方插件作者**强烈建议**提供该文件；内置核心插件由前端 i18n 翻译键兜底，可以省略。

### pluginType

| 值            | 含义                         |
| ------------- | ---------------------------- |
| `core-plugin` | 核心插件，Session 中不可禁用 |
| `plugin`      | 普通插件，可按需启用/禁用    |

### runtimeType

| 值              | 含义                                                              |
| --------------- | ----------------------------------------------------------------- |
| `agent`（默认） | LLM 驱动：构建上下文 → 调用 LLM → 工具循环 → 结果                 |
| `function`      | 纯函数执行：直接调用 `handler` 指定的 JS 模块，不调用 LLM，零延迟 |

`function` 类型 runtime 需要额外声明 `handler` 字段指向 JS 模块路径。

### dataSchemas

`dataSchemas` 声明插件哪些 `plugin_data` namespace 可以接收 world package 导入数据。world-data session importer 会在创建 session 前做插件启用检查，并用插件包内 JSON Schema 校验 source item。

```yaml
dataSchemas:
  relationships:
    schemaVersion: 1
    acceptsWorldData: true
    schema: ./schemas/relationships.schema.json
    description: Importable relationship records.
```

| 字段               | 类型      | 说明                                   |
| ------------------ | --------- | -------------------------------------- |
| `schemaVersion`    | `number`  | namespace 数据契约版本                 |
| `acceptsWorldData` | `boolean` | `true` 时允许 world-data importer 写入 |
| `schema`           | `string`  | 插件根目录相对 JSON Schema 路径        |
| `description`      | `string`  | 面向作者的简短说明                     |

多 runtime 插件可以在多个 runtime 的 `PLUGIN.md` 中声明同一 namespace；声明完全一致时合并到插件级 registry，冲突时插件注册失败。第三方 world 包引用该 namespace 时使用：

```yaml
schema: plugin://social-sim/relationships
to: plugin:social-sim/relationships
key: id
```

### recursiveCall

Function runtime 和 guard 的 `FunctionHandlerContext` 暴露：

```typescript
interface FunctionHandlerContext {
  recursiveCall(
    delta: Partial<TurnInput>,
    opts?: { reason?: string },
  ): Promise<TurnResult>;
  recursionDepth: number;
}
```

`recursiveCall()` 会用当前 turn 输入作为基底，合并 `delta` 后重新进入 turn executor。嵌套调用默认深度上限为 `10`，manifest 可用 `maxRecursionDepth` 覆盖：

```yaml
runtimeType: function
handler: ./handler.js
maxRecursionDepth: 5
```

`opts.reason` 会写入 `recursive.calling`、`recursive.completed`、`recursive.failed` trace payload，方便在 debug timeline 中解释嵌套调用意图。超过上限会抛出 `MaxRecursionExceeded`，并进入 runtime 的失败路径。

### guard

Agent runtime 的前置门控函数。在 LLM 调用前执行（纯函数，零 token 开销），可用于检查前置条件、导入数据等��

```yaml
guard: ../../guard.js
```

Guard 函数接收与 function runtime 相同��� `FunctionHandlerContext`，返回值规则：

- `{ skip: true, ... }` — 跳过 LLM 调用，guard 输出作为 runtime 结果
- `{ skip: false, ... }` — 继续执行 LLM agent

Guard 适用于"先检查再决定是否需要 LLM"的场景，替代了之前需要独立 function runtime 做门控的模式。

### memoryBlocks（核心记忆块）

声明该插件/世界贡献的**核心记忆块**（Letta 式 in-context memory）。框架的记忆系统（`@covel/memory`）会**聚合所有已加载插件的 `memoryBlocks`**，据此驱动每轮结束后的 LLM 抽取、持久化与 prompt 渲染——块定义因此是纯数据，而非内核硬编码。这正是「插件承载玩法、内核提供原语」在记忆维度的落地：侦探局可声明 `clues` / `suspects` / `timeline`，商战局可声明 `deals` / `rivals`，无需 fork 框架包。

builtin `memory` 插件声明默认的四个通用块（`story_state` / `character_relationships` / `scene` / `player_profile`）。任意插件或世界包都可追加自己的块；**标签重复时按信任层级决胜（builtin > official > community）：高信任声明覆盖低信任声明，与发现顺序无关**——因此 community 插件无法靠抢先加载来静默覆盖 builtin 默认块的定义（如改写 `story_state` 的 `extractionHint`）。同一信任层级内取首次声明（稳定）；当同层级的多个插件以**不同定义**声明同一标签时，框架打印一条 dev 警告。信任层级取自插件的发现来源（加载路径，不可伪造），框架不按具体插件 id 决胜。未声明任何 `memoryBlocks` 时，框架回退到 `@covel/memory` 内置的同名通用默认块。

**世界包**在 `world.yaml` 顶层（而非 `PLUGIN.md`）声明 `memoryBlocks`（字段形状相同）。与插件块的全局聚合不同，世界块**按 session 解析**：记忆系统把该 session 所属世界的块合并到全局插件块之上——基础块（插件 / 框架默认）在标签冲突时优先（builtin 默认受保护），世界只**新增**未占用的标签。因此侦探世界的会话才会出现 `clues` / `suspects`，其它题材会话不受影响。世界侧声明与示例见 [world-data.md #世界记忆块memoryblocks](world-data.md#世界记忆块memoryblocks)。

| 字段             | 类型                     | 说明                                                                   |
| ---------------- | ------------------------ | ---------------------------------------------------------------------- |
| `label`          | `string`（snake_case）   | 块机器标签：`working_memory` key、prompt XML tag、镜像 plugin-data key |
| `displayName`    | `I18nText`               | UI 面板与 prompt 块标题的本地化显示名                                  |
| `extractionHint` | `I18nText`               | 注入摘要 LLM system prompt 的逐块抽取指引（保持世界中立）              |
| `icon`           | `string`（可选，Lucide） | UI 面板图标，缺省 `Info`                                               |
| `maxChars`       | `number`（可选）         | 该块字符上限，覆盖管理器默认值（2000）                                 |

```yaml
memoryBlocks:
  - label: clues
    displayName: { zh: 线索, en: Clues }
    icon: Search
    extractionHint:
      zh: 已发现的线索、物证及其与嫌疑人的关联。
      en: Discovered clues, physical evidence, and their links to suspects.
```

### hooks

`hooks` 声明生命周期处理器。`handler` 路径相对插件目录解析，首次触发时懒加载。

```yaml
hooks:
  - event: PreToolUse
    handler: ./hooks/validate-tool.ts
    enforce: pre
    timeoutMs: 3000
    match:
      tool: create-character
```

只要 manifest 声明了 `hooks:`，loader 会校验每个条目并注册有效 hook。单个 hook 条目格式错误或事件名未知时只跳过该条目并输出 warning，其他有效条目继续生效。

| 字段        | 类型                               | 默认值   | 含义                                       |
| ----------- | ---------------------------------- | -------- | ------------------------------------------ |
| `event`     | `HookEvent`                        | 必填     | 生命周期事件名                             |
| `handler`   | `string`                           | 必填     | hook 模块路径，默认导出 async 函数         |
| `enforce`   | `pre \| normal \| post`            | `normal` | 排序分组，执行顺序为 `pre → normal → post` |
| `timeoutMs` | `number`                           | `5000`   | 单个 handler 的超时                        |
| `match`     | `Record<string, string \| number>` | 无       | payload 浅层等值过滤                       |

同一事件内先按 `enforce` 分组排序；同组内全局 hook 先执行，插件 hook 保持注册顺序。

| Event                 | Semantic     | 行为                                                                                                                                                                                                                                                   |
| --------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SessionStart`        | `parallel`   | 会话级（无回合）：会话创建 + 插件激活后触发，payload `{sessionId, worldId}`。观察型,不能否决创建（对齐 pi 的 `session_start`）                                                                                                                         |
| `TurnStart`           | `sequential` | 回合开始的否决门：任一 handler `abort` 则整回合中止(无 runtime 运行,返回带 `abortReason` 的 TurnResult),用于访问控制 / 限流                                                                                                                            |
| `PreCompaction`       | `sequential` | 历史压缩前的否决门：任一 handler `abort` 则本回合跳过压缩、保留完整历史（对齐 pi 的 `session_before_compact` 取消路径）                                                                                                                                |
| `PostCompaction`      | `parallel`   | 并发观察压缩结果（`compacted` / `summaryId`）；返回值只用于日志和 trace（对齐 pi 的 `session_compact`）                                                                                                                                                |
| `PreSchedule`         | `sequential` | 触发选择之后、调度之前观察 / 收窄本回合要跑的 runtime 集；`replace.triggered` 链式改写（如条件门控 / 成本控制）。**仅能影响主循环 runtime**：Pre-Game 未完成时，框架强制保留被 hook 删掉的 Pre-Game（priority ≤ 99）runtime，避免静默中断会话初始化    |
| `PreRuntime`          | `sequential` | 链式改写 runtime 输入；`replace` 会传给下一个 handler；`abort` 会停止执行                                                                                                                                                                              |
| `PostContextAssembly` | `sequential` | turn 级（每 runtime 一次，`buildContext` 之后、进 loop 之前）改写已装配的 `systemPrompt` / 投影历史；`replace.{systemPrompt,messages}` 链式累积（对齐 pi 的 `before_agent_start`）                                                                     |
| `PreLLMCall`          | `sequential` | 每次 LLM 调用前非破坏性改写发往模型的请求；`replace.{messages,model,tools}` 链式累积。不改写底层 transcript（对齐 pi 的 `context`）。`abort` 无意义、视为不变                                                                                          |
| `PostLLMResponse`     | `sequential` | LLM 响应返回后、工具派发前；`replace.response` 链式改写 `content`/`toolCalls`（对齐 pi 的 `after_provider_response`）                                                                                                                                  |
| `PostRuntime`         | `sequential` | 链式改写 runtime 输出：`replace.result` 重写该 runtime 的 `RuntimeResult`(链式累积),不改则原样                                                                                                                                                         |
| `PreToolUse`          | `sequential` | 链式改写 tool call；`replace` 会传给下一个 handler；`abort` 会跳过该 tool（不中止回合）                                                                                                                                                                |
| `PostToolUse`         | `sequential` | 链式 patch tool result：`replace.result` 改写结果、`replace.terminate: true` 在记录该结果后结束工具循环（对齐 pi 的 `tool_result.terminate`）。**结束循环用 `replace.terminate`，不要用 `abort`**（PostToolUse 的 `abort` 不生效，结果原样、循环继续） |
| `PreStateCommit`      | `sequential` | 链式改写 commit payload；任一 handler 可用 `abort` 拒绝 commit                                                                                                                                                                                         |
| `PostStateCommit`     | `parallel`   | 并发观察 commit 结果；返回值只用于日志和 trace                                                                                                                                                                                                         |
| `TurnStop`            | `parallel`   | 并发观察回合结束；返回值只用于日志和 trace                                                                                                                                                                                                             |
| `SessionEnd`          | `parallel`   | 会话级（无回合）：会话 PATCH 状态→`ended` 或 DELETE 时触发,payload `{sessionId, reason: "ended"｜"deleted"}`。仅在进入 `ended` 的那次触发(不重复),适合清理（对齐 pi 的 `session_shutdown`）                                                            |

> `PostToolUse` 为 `sequential`：`parallel` 语义会丢弃 `replace`，因此结果 patch 与 `terminate` 必须在顺序链中累积。
> `SessionStart` / `SessionEnd` 是会话级 hook（`turnId` 为空）：在 server 的 session 路由触发,不属于 turn pipeline。
> **Session 作用域**：hook pipeline 是全局单例,但执行时按当前 session 的激活插件集过滤(`hooks/hook-scope.ts`,经 AsyncLocalStorage)——插件 hook **只对该插件激活的 session 触发**,框架 hook(无 `pluginId`)始终触发。turn hook 的作用域取自 `activeRuntimes`,SessionStart/End 取自 `session.activePlugins`。`HookContext.activePluginIds` 暴露给 handler。

`first` 和 `stream` 已作为框架语义保留：`first` 用于未来的首个命中选择类 hook，`stream` 用于未来的流式 transform hook。

### outputKind

声明该 runtime 输出在 UI 中的处理方式。框架根据此字段决定消息展示策略，**而非硬编码插件 ID**。

| 值               | 含义                             |
| ---------------- | -------------------------------- |
| `story`          | 主叙事内容，显示在主聊天流中     |
| `plugin`（默认） | 辅助内容，可能被隐藏在主聊天之外 |
| `system`         | 系统级输出，不对玩家展示         |

示例 frontmatter：

```yaml
outputKind: story
```

### execution（手动触发执行模式）

仅在通过 `POST /api/sessions/:id/plugin-rpc` 的 `runtimeId` 分支手动触发时生效；调度器驱动的 runtime 忽略此字段。

| 值             | 含义                                                                                                                                                                                                                       |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sync`（默认） | 同步执行:HTTP 请求阻塞到 runtime 完成,返回 `runtimeResults` 汇总 JSON。适合可以秒级完成的 runtime(prompt 生成、状态校验等)                                                                                                 |
| `background`   | 后台执行:立即返回 202 + `jobId`,通过 `setImmediate` 脱离请求继续跑。框架在 `plugin_data` 表 `_jobs/{jobId}` 记录任务生命周期(`pending` → `done` / `failed`),前端通过 `plugin-data.changed` SSE 感知并渲染 loading/final UI |

**使用规则:**

- `_jobs` 是框架保留命名空间,插件**禁止**直接写入;框架自动维护 row 生命周期
- background 模式下,事件链 chain 仍然生效 —— 手动触发的 runtime emit 的 `event.emit` proposals 会在同一后台任务里按 priority 执行下游 runtime
- 如果 runtime 通过 `input.inject` 向下游传递结构化数据,background 模式下下游 runtime 会看到最终态(不是增量),就像在 sync 模式下一样

示例:

```yaml
execution: background # wan2.x 文生图需要几十秒,不阻塞 UI
```

详细 RPC 流程见 [api.md #post-apisessionsidplugin-rpc](api.md#post-apisessionsidplugin-rpc)。

### capabilities

能力标签数组，框架通过能力标签发现插件，**而非硬编码插件 ID**。

| 能力标签                  | 含义              | 框架用途                                                                                                                                                |
| ------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `narrative`               | 主叙事生成器      | 标识主叙事输出源                                                                                                                                        |
| `world-data-provider`     | 世界数据提供者    | 加载世界 schema/entries 到 turn context                                                                                                                 |
| `image-generation`        | 图像生成          | 前端展示「生成配图」按钮                                                                                                                                |
| `memory-panel`            | 核心记忆面板宿主  | 记忆系统将核心记忆块镜像到该插件的 plugin-data，用于实时 UI 面板更新                                                                                    |
| `persona-provider`        | 玩家人设提供者    | `buildSessionContextSnapshot` 从该插件的 `session-binding` / `profiles` 命名空间加载 `activePersona`（由 `player-identity` 声明）。未发现时不加载人设。 |
| `prompt-history-rewriter` | prompt 历史改写者 | `buildProjectedPromptHistory` 读取该插件的 `turns` 命名空间，把已采纳的备选回合折叠进投影历史（由 `branch-reply` 声明）。未发现时历史原样透传。         |

上表是**插件级**能力（匹配整个插件 manifest，对应 `FrameworkCapability`）。框架还消费一组**runtime 级**能力（匹配插件内某个具体子 runtime，对应 `FrameworkRuntimeCapability`），用于多步图像插件的链路发现：

| 能力标签（runtime 级） | 含义                   | 框架用途                                                                                                                 |
| ---------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `image-prompt`         | 图像提示词入口 runtime | 前端「生成配图」入口：发现声明该能力且 `trigger.type === manual` 的入口 runtime，经 plugin-rpc 触发并交给后台 follower。 |
| `image-generator`      | 图像生成后台 runtime   | 图像面板「重跑」：发现声明该能力的后台 runtime，把提示词转成图像 asset。                                                 |

> `dataSchemas.<namespace>.acceptsWorldData: true` 同样是一种能力声明：世界角色蓝图导入（`blueprintStorageTargets` / `characterMirrorTargets`）据此发现「接受世界蓝图 / 角色镜像」的插件（如 `character-blueprint`），框架不再硬编码 `character-blueprint` / `char-creator`。

声明 `image-generation` 的 runtime 在完成态返回 `assetGenerations[]`，每一项包含 `{ ref: MediaRef, modality: "image", meta? }`。图像画廊索引写入 `plugin_data.images` 时保存 `{ status, ref, prompt, ... }`，运行时会把旧 `url` / `base64` / `dataUrl` 字段记录为 `image.generate.plugin_data_inline_media` error。

插件可以声明任意自定义能力标签。框架仅依赖上述已定义标签。框架代码（server / runtime / web）引用这些标签时**不得**使用裸字符串字面量，而应使用 `@covel/shared` 导出的常量：插件级用 `FrameworkCapability`（如 `FrameworkCapability.WorldDataProvider`），runtime 级用 `FrameworkRuntimeCapability`（如 `FrameworkRuntimeCapability.ImageGenerator`），这样拼写漂移会变成编译错误而非静默 `undefined`。两组常量的并集导出为 `FRAMEWORK_KNOWN_CAPABILITIES`（单一事实源）；plugin-loader 在加载 PLUGIN.md 时，对「形似某个框架已知能力但拼错」的声明发 dev 警告（不阻断、不丢弃，自定义能力仍自由声明）。新增框架消费的能力标签时，需同时更新对应常量（`packages/shared/src/types/plugin.ts`）与本表。

**API 暴露**: Session plugins API（`GET /api/sessions/:id/plugins`）在响应中返回每个插件的 `capabilities` 字段（从所有子 runtime 的 manifest 中聚合），前端可据此发现插件能力。示例响应片段：

```json
{
  "id": "world-init",
  "pluginType": "core-plugin",
  "active": true,
  "capabilities": ["world-data-provider"]
}
```

示例 frontmatter：

```yaml
capabilities: [narrative, world-data-provider]
```

### tags / relations

`tags` 是面向玩家、作者和准备页筛选的目录标签，例如 `mode:dialogue`、`role:narrator`、`cost:llm`。`capabilities` 保持机器能力契约；框架逻辑依赖 `capabilities`，准备页和组合包匹配使用 `tags`。

`relations` 描述插件目录关系，可包含 `provides`、`requires`、`conflicts`、`recommends`。简单写法使用字符串数组；需要更细说明时可使用带 `plugin`、`runtime`、`capability`、`tag`、`reason` 的对象。创建或启用 session 时，服务端会执行 `requires` 闭包并移除 `conflicts` 指向的插件；`provides` 和 `recommends` 作为目录/准备页信号保留。

```yaml
tags:
  - mode:dialogue
  - role:narrator
  - cost:llm
relations:
  provides:
    - narrative-engine
  requires:
    - world-init
  conflicts:
    - narrator
  recommends:
    - scene-cast
```

### 超时与智能重试

Agent runtime 在调用 LLM 时会受到两个方向的约束：**单次调用时长**（`callTimeoutMs` / `firstTokenTimeoutMs`）和**运行总时长**（`timeoutMs`）。框架会自动在 transient 错误、call-timeout、first-token-timeout、tool-call 循环四种情形下重试，并在每次重试时向 prompt 追加一条短 system 提示打破 KV-cache 命中。

| 字段                     | 类型     | 默认                                              | 含义                                                                             |
| ------------------------ | -------- | ------------------------------------------------- | -------------------------------------------------------------------------------- |
| `timeoutMs`              | `number` | 60000                                             | 运行总时长硬上限。任何情况下都不会超过此值                                       |
| `maxRetries`             | `number` | `1`                                               | transient 错误/超时/循环时的重试次数（不含首次尝试）。`0` 禁用重试。上限 5       |
| `callTimeoutMs`          | `number` | `min(60000, floor(timeoutMs / (maxRetries + 1)))` | 单次 LLM 调用的总时长。防止一个挂死请求吃掉整轮预算                              |
| `firstTokenTimeoutMs`    | `number` | `30000`                                           | 流式 runtime 的首 token（TTFB）上限；非流式忽略                                  |
| `loopDetectionThreshold` | `number` | `3`                                               | 连续重复相同 `(tool name + JSON arguments)` 的次数；命中则注入扰动继续。`0` 关闭 |

**四类重试触发条件：**

- `transient-error`：AbortError / network / 5xx / `RATE_LIMITED` / `PROVIDER_ERROR`
- `call-timeout`：单次调用超过 `callTimeoutMs`
- `first-token-timeout`（仅流式）：超过 `firstTokenTimeoutMs` 仍无任何 text/tool event
- `tool-loop-detected`：外层 tool loop 连续命中相同调用 `loopDetectionThreshold` 次

**扰动策略**：重试时框架在 messages 末尾追加一条 `[retry N] ...` system 消息，并随 `N` 递增加入空格 padding，确保 prompt 字节串不同，避免 provider 端 KV-cache 复读同一回应。

**与 gateway fallback 的关系**：`llm.toml` 中 `fallback = "story"` 依然生效。本层的同 preset 重试先跑完后，失败才沿 gateway 的 preset fallback chain 继续尝试下一条。总时长硬上限仍是 `timeoutMs`。

示例 frontmatter：

```yaml
timeoutMs: 120000
maxRetries: 2 # 更保守，最多 3 次尝试
callTimeoutMs: 40000 # 每次调用 40s，足够 qwen-flash 但留重试余量
firstTokenTimeoutMs: 20000 # 20s 无首 token 即判定卡死
loopDetectionThreshold: 3 # 默认即可
```

### Prompt 组装扩展

Agent runtime 默认使用 segment-based prompt assembler。插件正文进入 `Plugin Instructions` 段，`authorsNote` 与 `postHistory` 作为高权重消息扩展点参与同一条 context 构建路径。

### authorsNote（prompt 段 9）

声明"导演级"指令，插入到消息历史倒数第 `depth` 条之前。借鉴 SillyTavern / NovelAI 的 author's note 语义 —— 用于在长历史中重新锚定模型的叙事方向。

| 字段      | 类型                                                       | 说明                                                                                               |
| --------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `content` | `string`（必填）                                           | 注入文本，支持 `{{ template }}` 插值（与 PLUGIN.md 正文相同的变量空间）                            |
| `depth`   | `number`（可选，默认 `4`）                                 | 距离消息数组尾部的偏移。`4` 表示插入到 `messages[length - 4]` 之前。`0` 或 `<= 0` 等价于追加到末尾 |
| `role`    | `'system' \| 'user' \| 'assistant'`（可选，默认 `system`） | 注入消息的角色                                                                                     |

多个插件的 authorsNote 会按 `priority` 升序聚合，落在同一 `(role, depth)` 桶内的内容会被合并为一条消息（用空行分隔）。

该字段对所有 agent runtime 生效。

示例 frontmatter：

```yaml
authorsNote:
  content: |
    Keep scenes tense and grounded.
    Do not reveal {{ userSettings.spoilerName }}.
  depth: 4
  role: system
```

### postHistory（prompt 段 10）

声明最末端的高权重指令。追加在所有消息（包括 authorsNote）之后，用于提醒模型输出格式、风格约束或硬规则。

| 字段      | 类型                                        | 说明                                 |
| --------- | ------------------------------------------- | ------------------------------------ |
| `content` | `string`（必填）                            | 注入文本，支持 `{{ template }}` 插值 |
| `role`    | `'system' \| 'user'`（可选，默认 `system`） | 注入消息的角色                       |

多个插件的 postHistory 会按 `priority` 升序聚合；相同 role 的声明会被合并为一条消息。

该字段对所有 agent runtime 生效。

示例 frontmatter：

```yaml
postHistory:
  content: Always respond in valid markdown. Never break character.
```

### rpc(PR-3 插件 RPC 通道)

声明插件暴露给 `POST /api/sessions/:id/plugin-rpc` 的结构化 action,供前端或外部代理用统一通道调用。每个 entry 是一个 RPC handler 模块的相对路径。

| 字段                   | 类型                                               | 说明                                                                                                                   |
| ---------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `<action-name>`        | `string`(必须 kebab-case,不可以 `framework-` 开头) | action 名,与 `pluginId` 一起作为路由 key                                                                               |
| `<action>.handler`     | `string`(必填)                                     | handler 模块的插件相对路径,必须 `.js` / `.mjs` / `.cjs`,**不允许绝对路径或 `..` 段**(框架在 schema 与 loader 两层校验) |
| `<action>.input`       | `string`(可选)                                     | payload 的 JSON Schema 路径,仅作文档参考,框架不强制                                                                    |
| `<action>.trustLevel`  | `'builtin' \| 'official' \| 'community'`(可选)     | 强制声明此 action 的信任级别,**只能比插件源信任更严格(降级)**;尝试升级会被 clamp 并 warn                               |
| `<action>.streaming`   | `boolean`(可选,默认 `false`)                       | 声明 handler 是流式还是单次。当前路由执行同步 handler,streaming 留给后续 PR                                            |
| `<action>.description` | `string`(可选)                                     | 一句话描述,会显示在 PR-7 approval 对话框里                                                                             |

handler 模块必须 default export 一个 `(payload, context) => Promise<unknown>` 函数。`context` 包含 `{ sessionId, pluginId, action, store: RpcHandlerStore }`,其中 `store` 是窄结构接口(`getSession` / `listTurnMessages` / `savePlayerInput` / 可选 plugin-data 三件套),不暴露完整的 `DataStore`。

示例 frontmatter:

```yaml
rpc:
  regenerate:
    handler: ./rpc/regenerate.js
    description: 重新生成上一段叙事
  cancel:
    handler: ./rpc/cancel.js
    trustLevel: community # 即使插件本身是 official,也强制对 cancel 走 community 审批
```

**框架默认 actions(无需声明,通过 `pluginId: "framework"` sentinel 调用):**

| Action        | 说明                                                 |
| ------------- | ---------------------------------------------------- |
| `submit-form` | 持久化玩家表单 / 选择 / 确认提交，填充模板 narrative |

详细 API 说明见 [api.md `POST /api/sessions/:id/plugin-rpc`](api.md#post-apisessionsidplugin-rpc),作者指南见 [../guide/plugin-authoring.md §2.3.1](../guide/plugin-authoring.md)。

### input.inject（prompt 上下文注入）

声明"在 LLM 调用前要注入到 system prompt 里的上下文块"。每条 entry 是一个独立的 XML 块，按声明顺序拼接在 PLUGIN.md 正文末尾。支持两种 `kind`：

#### `kind: runtime`

读取前序 runtime 的结构化 output 字段。`kind: runtime` 必须显式声明，避免同一 inject entry 同时存在多种解释。

| 字段    | 类型                | 说明                                                       |
| ------- | ------------------- | ---------------------------------------------------------- |
| `kind`  | `'runtime'`（必填） | runtime-output 注入来源                                    |
| `from`  | `string`（必填）    | 源 runtime name，可以是 `pluginId` 或 `pluginId/runtimeId` |
| `field` | `string`（必填）    | 从源 runtime `output` 里取的字段名                         |
| `as`    | `string`（必填）    | 包裹 XML 标签，如 `"<narrator-output>"`                    |

如果源 runtime 本回合没有执行、失败、或指定字段不存在，该 entry 静默跳过，不会污染其他注入块。

#### `kind: plugin-data`（本插件自己的 plugin-data 状态注入）

在 prompt 构建时调用 `store.listPluginData(sessionId, pluginId, namespace)` 拿到本插件**自己**的 plugin-data 记录（跨插件读故意不支持），按声明的 `format` 序列化后注入。适合"增量维护状态"类插件：codex 先看已有条目再决定增/改，character-tracker 先看已有角色再决定 create/update，等等。

| 字段         | 类型                                                          | 说明                                |
| ------------ | ------------------------------------------------------------- | ----------------------------------- |
| `kind`       | `'plugin-data'`（必填）                                       | 显式 discriminator                  |
| `namespace`  | `string`（必填）                                              | 本插件的 plugin-data namespace      |
| `as`         | `string`（必填）                                              | XML 标签，如 `"<existing-entries>"` |
| `format`     | `'summary' \| 'full' \| 'ids-only'`（可选，默认 `'summary'`） | 序列化方式，见下                    |
| `maxEntries` | `number`（可选，默认 `50`，范围 `[1, 500]`）                  | Token 预算保护                      |

**Format 说明：**

| format     | 每行结构                                         | 适用场景                       |
| ---------- | ------------------------------------------------ | ------------------------------ |
| `summary`  | `- {key} \| {updatedAt} \| {json-truncated-200}` | 默认，够 LLM 判断重复/匹配     |
| `ids-only` | `- {key}`                                        | 最省 token，只做 ID 存在性检查 |
| `full`     | `- {key}: {full-json}`                           | 调试或小条目集                 |

**两段式截断**：当条目数 > `maxEntries` 时，框架采用确定性的两段式截断——前半按 `createdAt` 升序取"最早的锚"（保证老条目永远可见，防止 session 后期 callback 老地点被当成重复 unlock），后半按 `updatedAt` 倒序取"最近活跃"，两段互相去重。超出时追加一行 `[总计 N 条，展示 M 条]`。

**空 namespace**：返回 `<tag>暂无</tag>`，让 LLM 明确知道"空"而不是"被截断了"。

**错误路径**：`store.listPluginData` 失败会让 runtime 直接失败，错误走观测通道（`runtime_outputs.error` + trace），**不污染下游任何 runtime 的 context**（由 Phase 0 审计保证：失败 runtime 不进入 `completedResults`，无路径泄漏到 narrator）。

**框架能力**：当 manifest 声明了任意 `kind: plugin-data` 注入时，`turn-executor` 自动切换到 `buildContextAsync` 路径；其他 runtime 继续走同步 `buildContext`，零开销零回归。

示例 frontmatter：

```yaml
input:
  inject:
    - kind: runtime
      from: narrator
      field: narrativeOutput
      as: "<narrator-output>"
    - kind: plugin-data
      namespace: entries
      as: "<existing-entries>"
      format: summary
      maxEntries: 100
```

### 优先级分带（Turn Bands）

```
0 ──────────── 100 ───────────────── 500 ───────────────── 1000
    Pre-Game         Pre-Turn          Narrator              After-Turn
   （游戏初始化）     （玩家操作前）     （主叙事输出）         （操作后处理）
```

| 区间    | 阶段       | 执行时机   | 说明                                                                                                                                                                                                                    |
| ------- | ---------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0-99    | Pre-Game   | 首次进入时 | 游戏初始化：世界状态、角色属性、动态表单。按 runtime 粒度跟踪——每个 runtime 首次完成后将自身 id 写入 `session.preGameCompleted`，后续轮次框架不会再调度它。单个 runtime 通过 `maxTriggerCount` 控制首次阶段内的多步流程 |
| 100-499 | Pre-Turn   | 每轮       | 玩家操作后、叙事前的处理                                                                                                                                                                                                |
| 500     | Narrator   | 每轮       | 主叙事模型输出，Turn 的核心产出                                                                                                                                                                                         |
| 501-999 | After-Turn | 每轮       | 叙事后处理：状态更新、图像生成、日志                                                                                                                                                                                    |
| 1000    | Audit      | 每轮       | 冲突审计（保留位）                                                                                                                                                                                                      |

主循环每轮执行 **100-1000** 区间的插件；Pre-Game（0-99）由 `preGameCompleted` 集合控制，默认单次完成后不再触发，无需 `phases: [...]` 自我门控。

### trigger 类型

| 类型          | 状态        | 说明                                                                                                                                                                     |
| ------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `auto`        | ✅ 生产可用 | 每个 Turn 自动触发                                                                                                                                                       |
| `manual`      | ✅ 生产可用 | 仅玩家手动触发；启用插件只表示该能力可用，不会自动进入每轮调度                                                                                                           |
| `scheduled`   | ✅ 生产可用 | 每 N 轮触发一次（配合 `interval` + `maxTriggerCount`）                                                                                                                   |
| `event`       | ✅ 生产可用 | 监听特定事件触发（在 Turn 内的事件 fan-out 中由 `shouldTrigger` 判定）                                                                                                   |
| `conditional` | ⚠️ reserved | **当前永不触发**：schema 接受该值，但没有条件表达式引擎，`shouldTrigger` 直接返回 false 并打印一次性 warning（audit P2-9）。条件引擎落地前请勿使用                       |
| `error-retry` | ⚠️ reserved | **当前永不触发**：依赖 `hasUpstreamFailure`，而调度路径（`turn-executor/scheduling.ts`）将其硬编码为 `false`，该分支在生产中不可达，`shouldTrigger` 会打印一次性 warning |

> **可用 vs reserved**：生产实际可用的只有 `auto` / `manual` / `scheduled` / `event` 四种。`conditional` 与 `error-retry` 是为未来能力预留的占位类型，声明它们的 Runtime 会被静默跳过（并在 console 提示一次）。在对应能力落地前请使用上面四种之一。

### trigger 字段速查

| 字段              | 默认 | 含义                                                                                                                                      |
| ----------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `interval`        | 1    | `scheduled` 类型每隔 N 轮触发一次                                                                                                         |
| `cooldownTurns`   | —    | 上一次触发后多少轮内不可再次触发                                                                                                          |
| `maxTriggerCount` | —    | 整个 session 内最多触发次数（达到后不再触发）                                                                                             |
| `startTurn`       | —    | **PR-2**：从第几个主循环轮次起开始介入。基于 `turnCount`（0-based），与 Pre-Game 首轮自动跳过互不冲突。适合"让玩家先熟悉环境再介入"的场景 |

**`startTurn` 用例**：

```yaml
trigger:
  type: scheduled
  interval: 1
  startTurn: 3 # 前三轮让玩家适应，第四轮起开始检查
```

这条配置表达"前三轮玩家先熟悉环境，从第四轮起插件才开始介入"。Pre-Game 段落（priority `0-99`）由框架按 `session.preGameCompleted` 集合决定是否再次触发，与 `startTurn` 解耦。

---

## 框架–插件隔离规则

> **CRITICAL**: 框架代码中禁止出现任何具体插件 ID 或插件名称。

Covel 的核心设计原则是**插件承载游戏逻辑，框架提供原语和编排**。为确保任何插件都可以被替换而不修改框架代码，以下规则必须严格遵守：

### 禁止

在框架代码（`packages/`、`apps/server/src/`、`apps/web/src/`）中：

- ❌ `pluginId === 'narrator'` — 不得通过插件 ID 判断行为
- ❌ `store.listPluginData(sessionId, 'world-init', ...)` — 不得硬编码数据来源插件
- ❌ `p.id === "image"` — 不得通过插件 ID 控制 UI
- ❌ 在常量集合中列出插件名（如 `KNOWN_KEYS.has("codex")`）

### 正确做法

- ✅ 通过 `RuntimeManifest.outputKind` 判断输出类型（`story` / `plugin` / `system`）
- ✅ 通过 `RuntimeManifest.capabilities` 发现插件能力（如 `world-data-provider`）
- ✅ 通过 `pluginType` 判断核心/普通插件
- ✅ 测试文件中可以使用具体插件名作为测试数据

### 新增 frontmatter 字段

当框架需要区分插件行为时，应在 `RuntimeManifest` 中添加通用字段（如 `outputKind`、`capabilities`），而非在框架代码中添加条件分支。

### Runtime 输出字段：`preGameDone`

Pre-Game 段 runtime（priority `0-99`）可在 `RuntimeOutput` 中声明：

```json
{ "preGameDone": true }
```

框架在 commit 链上看到该字段为 `true` 时，会将该 `runtimeId` 追加到 `session.preGameCompleted`；后续轮次的调度器会跳过已完成的 Pre-Game runtime。这是替代历史上 `session.phase` 状态机的 runtime 粒度闸门，避免"全局 phase 状态 → 单插件职责被迫搬进 trigger.phases"的反模式。
