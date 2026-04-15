# 插件注册表

> 所有已实现的 Covel 插件。本页当前以 `plugins/**/PLUGIN.md` 与对应 `handler.js / tools/*.js` 的实现为准。

---

## 概览

| ID | 类型 | 优先级 | 触发方式 | 模型 slot | 描述 |
|----|------|--------|----------|-----------|------|
| core-pregame | core-plugin | 10 | scheduled（仅首轮） | — | 游戏初始化（function runtime） |
| core-world-init/schema-gen | core-plugin | 85 | scheduled（仅首轮） | `plugin` | 世界维度初始化（guard + agent） |
| core-narrator | core-plugin | 500 | auto（`playing` 阶段） | `story` | 主叙事生成器 |
| core-guide | plugin | 550 | scheduled（interval=1, cooldown=1） | `plugin` | 行动引导 + 聊天内建议面 |
| core-npc-graph/rag-retriever | plugin | 490 | scheduled（interval=1，function runtime） | — | NPC 图谱结构化检索器，向 narrator 注入相关关系事实 |
| core-npc-graph/extractor | plugin | 620 | scheduled（interval=1, cooldown=1） | `plugin` | NPC 关系图抽取器（受 MiroFish 启发） |
| core-codex | plugin | 650 | scheduled（interval=2, cooldown=1） | `plugin` | 知识图鉴系统（deterministic handler） |
| core-char-creator/player-init | core-plugin | 700 | scheduled（maxTriggerCount=2, guard, function runtime） | `plugin` | 玩家角色创建（deterministic handler） |
| core-char-creator/character-tracker | core-plugin | 750 | scheduled（interval=1, cooldown=1, phases=[playing]） | `plugin` | NPC 发现 + 角色状态跟踪 |

---

## core-pregame

**路径**: `plugins/core-pregame/`

| 字段 | 值 |
|------|----|
| pluginType | `core-plugin`（不可禁用） |
| priority | 10（Pre-Game 阶段，最先执行） |
| trigger | `scheduled`，`interval: 1`，`maxTriggerCount: 1` — 仅首轮触发 |
| runtimeType | `function`（纯函数执行，不调用 LLM） |
| handler | `./handler.js` |
| input.inject | 无 |

**职责**: 游戏开始时第一个执行的插件。读取世界观设定，发送欢迎通知，输出世界观摘要供后续叙事插件（narrator、codex、char-creator）作为上下文引导。持久化 session phase → `character_creation`。

**Phase 转换**: 输出 `{ phase: 'character_creation' }` → turn-executor 自动调用 `store.updateSession()` 持久化。

---

## core-world-init

**路径**: `plugins/core-world-init/`

单 runtime 插件，使用 `guard` 机制实现无 LLM 开销的前置门控。

### core-world-init/schema-gen

| 字段 | 值 |
|------|----|
| pluginType | `core-plugin`（不可禁用） |
| priority | 85（Pre-Game 阶段） |
| trigger | `scheduled`，`interval: 1`，`maxTriggerCount: 1` — 仅首轮触发 |
| model | `plugin` |
| guard | `../../guard.js` |
| capabilities | `[world-data-provider]` |
| tools.local | `set-world-schema`, `set-world-entries-batch` |
| tools.builtin | `plugin-data-get`, `plugin-data-list` |
| ui.right | `./ui/world-entries.json`, `./ui/world-schema.json` |

**Guard 门控**: `guard.js` 在 LLM 调用前执行（纯函数，零 LLM 开销）。检查 plugin_data 中是否已有世界维度数据，或从 world.yaml 导入 dimensions。若数据已存在，返回 `{ skip: true }` 跳过 LLM。

**Agent 职责**: 读取世界观文档，通过专用 local tools 批量生成角色属性 schema 和世界词条。只需 2 次工具调用（`set-world-schema` + `set-world-entries-batch`）。

**数据存储结构**:
- namespace `schema` — 维度 schema 定义（plugin_data）
- namespace `entries` — 世界词条数据（plugin_data，legacy fallback）
- session lorebook（`strategy: 'constant'`）— 世界词条数据（FU-8 canonical 目的地）

**FU-8 lorebook 迁移**（S3-T2 收尾）：`set-world-entries-batch` 工具从 FU-8 起会 **double-write**：
既写 `plugin_data` namespace=`entries`（保留给旧会话 / 仍未实现 lorebook 表的 store），
也通过 `store.upsertLorebookEntries()` 写入 session 级 lorebook。
每个词条成为一条 `constant` 类型的 lorebook row，id 按 `world-entry:<key>` 稳定化，
`insertionOrder` 按批内顺序以 100 为步长递增。`loadSessionConfig` 在构造
`{{ config.worldEntries }}` 时优先读 lorebook，空才回退 plugin_data。
`{{ config.worldSchema }}` 仍从 plugin_data 读取，不进入 lorebook（结构化 JSON 不适合 free-form content）。

---

## core-narrator

**路径**: `plugins/core-narrator/`

| 字段 | 值 |
|------|----|
| pluginType | `core-plugin`（不可禁用） |
| priority | 500 |
| trigger | `auto`，`phases: [playing]` — 仅 `playing` 阶段执行 |
| outputKind | `story`（输出显示在主聊天区） |
| model | `story` |
| capabilities | `[narrative]` |
| tools.builtin | `world-dimension-get` |
| input.inject | `core-npc-graph/rag-retriever` → `npcContext` → `<npc-relationships>` |

**职责**: 根据玩家输入、世界观和历史上下文生成主线叙事。输出 `narrativeOutput` 字段供其他插件引用；需要精确世界字段时调用 `world-dimension-get` 按需读取。

**上下文变量**:
- `{{ world.lore }}` — 世界观全文
- `{{ world.dimensions }}` — 世界维度信息
- `{{ world.openingScenario }}` — 开场场景
- `{{ world.tone }}` — 叙事风格设定
- `{{ player.message }}` — 玩家当前输入
- `{{ player.character }}` — 玩家角色数据（CharacterSummary）
- `{{ session.turnNumber }}` — 当前回合数
- `{{ session.phase }}` — 当前会话阶段

**Phase 门控**: 通过 `phases: [playing]` 触发门控，narrator 仅在角色创建完成后（session phase 转入 `playing`）开始执行。首轮（`init` / `character_creation` 阶段）不触发。

---

## core-npc-graph

**路径**: `plugins/core-npc-graph/`

多 runtime 插件。包含两个协作的子 runtime：

### core-npc-graph/rag-retriever

| 字段 | 值 |
|------|----|
| pluginType | `plugin` |
| runtimeType | `function`（无 LLM 调用，纯结构化检索） |
| handler | `./runtimes/rag-retriever/handler.js` |
| priority | 490（在 `core-narrator=500` **之前**） |
| capabilities | `[npc-graph, graph-rag]` |
| trigger | `scheduled`，`interval: 1`，`phases: [playing]` |

每个 playing 回合开始时自动运行：从 `playerMessage` 中匹配 NPC 节点名（含别名，case-insensitive），沿邻接索引做 2-hop BFS，过滤 `invalidAt` 已到期的边，按 `(validAt, |strength|)` 排序后取 top-20，输出 markdown 列表到 `npcContext` 字段。`core-narrator` 通过 `input.inject` 把这段文本作为 `<npc-relationships>` 块注入 prompt 末尾。

**Phase 3.5 升级路径**：当 framework 层向 function handler 暴露 gateway 后，将升级为"先 embed 查询 → vector search → 子图扩展"的混合检索。当前为纯结构化版本。

### core-npc-graph/extractor

| 字段 | 值 |
|------|----|
| pluginType | `plugin` |
| runtimeType | `agent`（LLM 驱动） |
| priority | 620（位于 narrator=500 与 codex=650 之间） |
| capabilities | `[npc-graph, relationship-tracking]` |
| trigger | `scheduled`，`interval: 1`，`cooldownTurns: 1`，`phases: [playing]` |
| input.inject | `core-narrator.narrative` → `<narrator-output>` |
| model slot | `plugin` |
| tools.local | `upsert-npc-graph`（批量写节点+边）、`list-npc-graph`（列出现有图） |
| tools.builtin | `plugin-data-list`、`plugin-data-get` |
| ui.right | `./ui/npc-graph-panel.json` |

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

## core-codex

**路径**: `plugins/core-codex/`

| 字段 | 值 |
|------|----|
| pluginType | `plugin`（可禁用） |
| priority | 650 |
| runtimeType | `function` |
| handler | `./handler.js` |
| trigger | `scheduled`，`interval: 2`，`cooldownTurns: 1`，`phases: [playing]` |
| model | `plugin` |
| tools.local | `unlock-codex-entries`, `update-codex-entry` |
| tools.builtin | `plugin-data-list`, `create-notification` |
| ui.right | `./ui/codex-panel.json` |
| ui.message | `./ui/codex-message.json` |
| input.inject | 无 |

**职责**: 分析叙事文本，识别并记录玩家发现的知识条目（怪物、道具、地点、传说、人物、技能）。当前实现是 deterministic handler：它直接提取高信号条目，写入 `plugin_data[entries]`，并同步写入 `plugin_data[message]` 作为聊天内摘要。

**数据持久化**: 当前 `handler.js` 直接完成 `plugin_data` 写入；`tools/` 目录中的 codex 工具仍保留在插件包内，供独立测试与后续演进使用。

**UI 面板**: `ui/codex-panel.json` 承接完整图鉴，`ui/codex-message.json` 负责聊天内的本轮新增摘要。框架通过 `/api/ui-specs` 发现并渲染这两个 surface。

---

## core-char-creator（角色子系统）

**路径**: `plugins/core-char-creator/`

多 runtime 插件。player-init 负责玩家角色创建，character-tracker 负责持续跟踪 NPC 和角色状态变化。两者共用同一个 `character-panel.json` 侧边栏面板（通过 `group: "character"` 聚合）。

### core-char-creator/player-init

| 字段 | 值 |
|------|----|
| pluginType | `core-plugin`（不可禁用） |
| priority | 700 |
| runtimeType | `function` |
| handler | `./handler.js` |
| trigger | `scheduled`，`interval: 1`，`maxTriggerCount: 2`（首轮生成表单 + 表单提交后写库） |
| guard | `./guard.js` — 若 player 已存在则 skip，并保证 session 在 playing phase |
| model | `plugin` |
| ui.right | `../../ui/character-panel.json` |

**两步流程**（当前由 deterministic handler 完成）：

1. **第 1 步 - 生成表单**（`<player-submission>` 为空时）：
   - 读取世界 schema
   - 直接返回 `interaction.request` 形式的角色创建表单
   - 表单字段从 `worldSchema.character-attributes.attributes` 中选取，最多 4 个字段含 `characterName`

2. **第 2 步 - 提交创建**（`<player-submission>` 包含表单值时）：
   - 读取最近一次 player input submission
   - 合并 schema `defaultValue`
   - 直接写入 `characters` 表与 `plugin_data[characters]`
   - 输出 `phase: "playing"` 推动 session 进入正式游戏

**当前代码状态**: 这一条路径已经保持在插件包内部，实现位于 `runtimes/player-init/handler.js`。如果后续希望统一 deterministic runtime 的 trace 与工具链，可以把这条流程收敛到 builtin character tools。

### core-char-creator/character-tracker

| 字段 | 值 |
|------|----|
| pluginType | `core-plugin` |
| priority | 750 |
| trigger | `scheduled`，`interval: 1`，`cooldownTurns: 1`，`phases: [playing]` |
| model | `plugin` |
| tools.builtin | `create-character`, `update-character`, `list-characters`, `get-character` |
| input.inject | `core-narrator` → `narrativeOutput` → `<narrator-output>` |

**职责**: 每轮扫描 narrator 输出，发现新的有名字 NPC → `create-character(type="npc")`；检测叙事中的角色状态变化（受伤、死亡、装备、关系）→ `update-character(fields: {...})`。工作流：
1. `list-characters` 获取现有角色（避免重复）
2. 阅读叙事识别新 NPC + 状态变化
3. 仅对明确出现的变化调用 create/update 工具
4. 每次最多创建 5 个 NPC（防止 runaway）
5. 不修改玩家角色属性（除非叙事明确描述）

---

## core-guide

**路径**: `plugins/core-guide/`

| 字段 | 值 |
|------|----|
| pluginType | `plugin`（可禁用） |
| priority | 550（narrator 之后、codex 之前） |
| trigger | `scheduled`，`interval: 1`，`cooldownTurns: 1`，`phases: [playing]` |
| model | `plugin` |
| tools.local | `generate-guide` |
| ui.message | `./ui/action-guide-block.json` |
| input.inject | `core-narrator` → `narrativeOutput` → `<narrator-output>` |

**职责**: 在叙事推进后，分析当前情境，为玩家生成分风格的行动建议。让 narrator 专注叙事，选择引导交由本插件。

**风格分类**:
- **safe（稳妥）** — 低风险、谨慎的选择
- **aggressive（激进）** — 直接、对抗性的选择
- **creative（创意）** — 非常规、巧妙的选择

**触发逻辑**: `cooldownTurns: 1` 确保首轮不触发（避免与角色创建冲突）。仅在 `playing` 阶段执行。如果叙事中没有明显决策点，LLM 不会调用工具。

**UI 渲染**: 当前 `generate-guide` 会把 `topic` 与三组建议写入 `plugin_data[message]`。`ui/action-guide-block.json` 读取这些字段，渲染三组策略卡和自定义输入；玩家点击建议后进入待发送区，由底部输入栏统一发送。

---

## 待迁移插件（待开发）

| 插件 | 预期优先级 | 描述 |
|------|-----------|------|
| core-persona | 100 | AI 人格配置 |
| core-combat | 420 | 回合制战斗 |
| core-inventory | 600 | 物品/装备管理 |
| core-quest | 650 | 任务追踪 |
| core-image | 800 | 故事配图生成 |
| core-memory | 900 | 长期记忆摘要 |

---

## 插件结构规范

### 单 runtime 插件（默认）

```
plugins/<plugin-id>/
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
├── package.json
├── runtimes/
│   ├── check-existing/
│   │   ├── PLUGIN.md      # name: plugin-id/check-existing
│   │   └── PLUGIN.en.md   # 可选：英文版
│   └── schema-gen/
│       ├── PLUGIN.md      # name: plugin-id/schema-gen
│       └── PLUGIN.en.md
├── tools/                 # 可选：所有子运行时共享的工具
└── check-existing.js      # function runtime 的 handler
```

子运行时之间可通过 `input.inject` 传递数据（如 check-existing 的输出注入到 schema-gen）。

### pluginType

| 值 | 含义 |
|----|------|
| `core-plugin` | 核心插件，Session 中不可禁用 |
| `plugin` | 普通插件，可按需启用/禁用 |

### runtimeType

| 值 | 含义 |
|----|------|
| `agent`（默认） | LLM 驱动：构建上下文 → 调用 LLM → 工具循环 → 结果 |
| `function` | 纯函数执行：直接调用 `handler` 指定的 JS 模块，不调用 LLM，零延迟 |

`function` 类型 runtime 需要额外声明 `handler` 字段指向 JS 模块路径。

### guard

Agent runtime 的前置门控函数。在 LLM 调用前执行（纯函数，零 token 开销），可用于检查前置条件、导入数据等��

```yaml
guard: ../../guard.js
```

Guard 函数接收与 function runtime 相同��� `FunctionHandlerContext`，返回值规则：
- `{ skip: true, ... }` — 跳过 LLM 调用，guard 输出作为 runtime 结果
- `{ skip: false, ... }` — 继续执行 LLM agent

Guard 适用于"先检查再决定是否需要 LLM"的场景，替代了之前需要独立 function runtime 做门控的模式。

### outputKind

声明该 runtime 输出在 UI 中的处理方式。框架根据此字段决定消息展示策略，**而非硬编码插件 ID**。

| 值 | 含义 |
|----|------|
| `story` | 主叙事内容，显示在主聊天流中 |
| `plugin`（默认） | 辅助内容，可能被隐藏在主聊天之外 |
| `system` | 系统级输出，不对玩家展示 |

示例 frontmatter：
```yaml
outputKind: story
```

### capabilities

能力标签数组，框架通过能力标签发现插件，**而非硬编码插件 ID**。

| 能力标签 | 含义 | 框架用途 |
|---------|------|---------|
| `narrative` | 主叙事生成器 | 标识主叙事输出源 |
| `world-data-provider` | 世界数据提供者 | 加载世界 schema/entries 到 turn context |
| `image-generation` | 图像生成 | 前端展示「生成配图」按钮 |

插件可以声明任意自定义能力标签。框架仅依赖上述已定义标签。

**API 暴露**: Session plugins API（`GET /api/sessions/:id/plugins`）在响应中返回每个插件的 `capabilities` 字段（从所有子 runtime 的 manifest 中聚合），前端可据此发现插件能力。示例响应片段：
```json
{ "id": "core-world-init", "pluginType": "core-plugin", "active": true, "capabilities": ["world-data-provider"] }
```

示例 frontmatter：
```yaml
capabilities: [narrative, world-data-provider]
```

### promptVersion（S2-T4，V2 opt-in 闸门）

声明本 runtime 使用哪个版本的 prompt assembler：

| 值 | 含义 |
|----|------|
| 省略 / `1` | V1 单遍组装器（legacy 路径） |
| `2` | V2 三段式组装器（10 个结构化段） |

V2 的路由需要**同时**满足两个条件：

1. 环境变量 `COVEL_PROMPT_V2=1`（部署级启用）
2. manifest 声明 `promptVersion: 2`（插件级启用）

任一缺失都走 V1。这一"双闸门"让运维可以在部署层面统一切换，而插件作者按节奏逐个迁移（§A8 渐进策略）。

当前已迁移的核心插件：

| 插件 | promptVersion | 迁移 ticket |
|------|---------------|-------------|
| core-narrator | 2 | S2-T4 |
| core-guide | 2 | S2-T4 |
| core-codex | 2 | S3-T5a |
| core-char-creator/player-init | 2 | S3-T5a |
| core-char-creator/character-tracker | 2 | S3-T5a |

示例 frontmatter：

```yaml
promptVersion: 2
```

**迁移说明**：将 V1 插件迁移到 V2 通常只需要在 frontmatter 中添加 `promptVersion: 2`。`assemblePromptVariables` 在 V1/V2 路径下共享一份实现，因此 `{{ player.message }}`、`{{ player.lastFormValues }}`、`{{ world.* }}`、`{{ config.* }}`、`{{ inputs.* }}` 等模板变量在两条路径下行为一致。结构差异仅体现在：

- V2 把 `[LANGUAGE]` 约束从系统 prompt 尾部移到段 1（framework preamble）
- V2 的段间分隔符是 `\n\n`
- V2 对 `authorsNote` / `postHistory` 生效（V1 忽略）

### authorsNote（S3-T4，V2 prompt 段 9）

声明"导演级"指令，插入到消息历史倒数第 `depth` 条之前。借鉴 SillyTavern / NovelAI 的 author's note 语义 —— 用于在长历史中重新锚定模型的叙事方向。

| 字段 | 类型 | 说明 |
|------|------|------|
| `content` | `string`（必填） | 注入文本，支持 `{{ template }}` 插值（与 PLUGIN.md 正文相同的变量空间） |
| `depth` | `number`（可选，默认 `4`） | 距离消息数组尾部的偏移。`4` 表示插入到 `messages[length - 4]` 之前。`0` 或 `<= 0` 等价于追加到末尾 |
| `role` | `'system' \| 'user' \| 'assistant'`（可选，默认 `system`） | 注入消息的角色 |

多个插件的 authorsNote 会按 `priority` 升序聚合，落在同一 `(role, depth)` 桶内的内容会被合并为一条消息（用空行分隔）。

仅在 V2 prompt assembler（`COVEL_PROMPT_V2=1`）下生效；V1 路径忽略该字段。

示例 frontmatter：
```yaml
authorsNote:
  content: |
    Keep scenes tense and grounded.
    Do not reveal {{ config.spoilerName }}.
  depth: 4
  role: system
```

### postHistory（S3-T4，V2 prompt 段 10）

声明最末端的高权重指令。追加在所有消息（包括 authorsNote）之后，用于提醒模型输出格式、风格约束或硬规则。

| 字段 | 类型 | 说明 |
|------|------|------|
| `content` | `string`（必填） | 注入文本，支持 `{{ template }}` 插值 |
| `role` | `'system' \| 'user'`（可选，默认 `system`） | 注入消息的角色 |

多个插件的 postHistory 会按 `priority` 升序聚合；相同 role 的声明会被合并为一条消息。

仅在 V2 prompt assembler（`COVEL_PROMPT_V2=1`）下生效；V1 路径忽略该字段。

示例 frontmatter：
```yaml
postHistory:
  content: Always respond in valid markdown. Never break character.
```

### rpc(PR-3 插件 RPC 通道)

声明插件暴露给 `POST /api/sessions/:id/plugin-rpc` 的结构化 action,供前端或外部代理用统一通道调用。每个 entry 是一个 RPC handler 模块的相对路径。

| 字段 | 类型 | 说明 |
|------|------|------|
| `<action-name>` | `string`(必须 kebab-case,不可以 `framework-` 开头) | action 名,与 `pluginId` 一起作为路由 key |
| `<action>.handler` | `string`(必填) | handler 模块的插件相对路径,必须 `.js` / `.mjs` / `.cjs`,**不允许绝对路径或 `..` 段**(框架在 schema 与 loader 两层校验) |
| `<action>.input` | `string`(可选) | payload 的 JSON Schema 路径,仅作文档参考,框架不强制 |
| `<action>.trustLevel` | `'builtin' \| 'official' \| 'community'`(可选) | 强制声明此 action 的信任级别,**只能比插件源信任更严格(降级)**;尝试升级会被 clamp 并 warn |
| `<action>.streaming` | `boolean`(可选,默认 `false`) | 声明 handler 是流式还是单次。当前 v1 路由只走 sync,streaming 留给后续 PR |
| `<action>.description` | `string`(可选) | 一句话描述,会显示在 PR-7 approval 对话框里 |

handler 模块必须 default export 一个 `(payload, context) => Promise<unknown>` 函数。`context` 包含 `{ sessionId, pluginId, action, store: RpcHandlerStore }`,其中 `store` 是窄结构接口(`getSession` / `listTurnMessages` / `savePlayerInput` / 可选 plugin-data 三件套),不暴露完整的 `DataStore`。

示例 frontmatter:
```yaml
rpc:
  regenerate:
    handler: ./rpc/regenerate.js
    description: 重新生成上一段叙事
  cancel:
    handler: ./rpc/cancel.js
    trustLevel: community  # 即使插件本身是 official,也强制对 cancel 走 community 审批
```

**框架默认 actions(无需声明,通过 `pluginId: "framework"` sentinel 调用):**

| Action | 说明 |
|--------|------|
| `submit-form` | 持久化玩家表单 / 选择 / 确认 提交,填充模板 narrative。等同于 legacy `POST /api/sessions/:id/submit-inputs` |

详细 API 说明见 [api.md `POST /api/sessions/:id/plugin-rpc`](api.md#post-apisessionsidplugin-rpc),作者指南见 [../guide/plugin-authoring.md §2.3.1](../guide/plugin-authoring.md)。

### 优先级分带

```
0 ──────────── 100 ───────────────── 500 ───────────────── 1000
    Pre-Game         Pre-Turn          Narrator              After-Turn
   （游戏初始化）     （玩家操作前）     （主叙事输出）         （操作后处理）
```

| 区间 | 阶段 | 执行时机 | 说明 |
|------|------|----------|------|
| 0-99 | Pre-Game | 仅 session 首轮 | 游戏初始化：世界状态、角色属性、动态表单 |
| 100-499 | Pre-Turn | 每轮 | 玩家操作后、叙事前的处理 |
| 500 | Narrator | 每轮 | 主叙事模型输出，Turn 的核心产出 |
| 501-999 | After-Turn | 每轮 | 叙事后处理：状态更新、图像生成、日志 |
| 1000 | Audit | 每轮 | 冲突审计（保留位） |

正式游戏循环只执行 **100-1000** 区间的插件。Pre-Game（0-99）仅在首轮执行一次。

### trigger 类型

| 类型 | 说明 |
|------|------|
| `auto` | 每个 Turn 自动触发 |
| `manual` | 仅玩家手动触发 |
| `scheduled` | 每 N 轮触发一次（配合 `interval` + `maxTriggerCount`） |
| `conditional` | 满足条件时触发 |
| `event` | 监听特定事件触发 |
| `error-retry` | 前序 Runtime 出错时触发 |

### trigger 字段速查

| 字段 | 默认 | 含义 |
|------|------|------|
| `interval` | 1 | `scheduled` 类型每隔 N 轮触发一次 |
| `cooldownTurns` | — | 上一次触发后多少轮内不可再次触发 |
| `maxTriggerCount` | — | 整个 session 内最多触发次数（达到后不再触发） |
| `phases` | 全部 | 限定在哪些 session phase 下才有资格触发 |
| `startTurn` | — | **PR-2**：从第几个 playing-phase 轮次起开始介入。基于 `playingTurnNumber`（0-based 从首次进入 `playing` 阶段算起），不计入 pre-game / character_creation 期间的轮次 |

**`startTurn` 用例**：

```yaml
trigger:
  type: scheduled
  interval: 1
  startTurn: 3        # 跳过 playing 的前三轮，从第四轮起开始检查
  phases: [playing]
```

这条配置表达"前三轮 playing 玩家先熟悉环境，从第四轮起插件才开始介入"，与 pre-game 阶段执行了多少次 setup runtime 完全解耦。

---

## 框架–插件隔离规则

> **CRITICAL**: 框架代码中禁止出现任何具体插件 ID 或插件名称。

Covel 的核心设计原则是**插件承载游戏逻辑，框架提供原语和编排**。为确保任何插件都可以被替换而不修改框架代码，以下规则必须严格遵守：

### 禁止

在框架代码（`packages/`、`apps/server/src/`、`apps/web/src/`）中：

- ❌ `pluginId === 'core-narrator'` — 不得通过插件 ID 判断行为
- ❌ `store.listPluginData(sessionId, 'core-world-init', ...)` — 不得硬编码数据来源插件
- ❌ `p.id === "core-image"` — 不得通过插件 ID 控制 UI
- ❌ 在常量集合中列出插件名（如 `KNOWN_KEYS.has("core-codex")`）

### 正确做法

- ✅ 通过 `RuntimeManifest.outputKind` 判断输出类型（`story` / `plugin` / `system`）
- ✅ 通过 `RuntimeManifest.capabilities` 发现插件能力（如 `world-data-provider`）
- ✅ 通过 `pluginType` 判断核心/普通插件
- ✅ 测试文件中可以使用具体插件名作为测试数据

### 新增 frontmatter 字段

当框架需要区分插件行为时，应在 `RuntimeManifest` 中添加通用字段（如 `outputKind`、`capabilities`），而非在框架代码中添加条件分支。
