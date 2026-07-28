# 插件开发指南 · 零代码

> 面向**内容创作者**：只写 Markdown + YAML frontmatter，不写任何 JS/TS。插件运行最少依赖 `PLUGIN.md`；可维护插件还需要 `README.md` 给人类阅读。

> **读完你能做到**
>
> - 写一个只靠 `PLUGIN.md` 就能运行的插件
> - 根据场景选对触发类型（`auto` / `scheduled` / `event` / `manual`）
> - 用框架内置的四个 UI 工具（`render-ui` / `create-form` / `create-choices` / `create-notification`）产生玩家可交互块。`render-ui` 是通用的 parts 模型（详见 [docs/reference/tools.md#render-ui](../reference/tools.md#render-ui)），后三个是 form / choices / notification 的语义糖。
> - 通过 `references/` 目录按关键词按需注入参考资料，避免每轮烧 token
> - 用 `userSettings` 字段暴露玩家可调参数
> - 打包一个 `worlds/<id>/` 世界包并指定 `requiredPlugins` / `recommendedPlugins`

---

## 1. 最简运行时：PLUGIN.md

框架加载一个最简运行时只需要 `PLUGIN.md`。实际提交插件时同时提供 `README.md`：

```
plugins/my-narrator/
├── README.md
└── PLUGIN.md
```

`README.md` 写给人类，说明插件功能、实现情况、测试方式和维护注意事项。`PLUGIN.md` 写给框架和模型。

`PLUGIN.md` 由两部分组成：

1. **YAML frontmatter**（`---` 包裹）— 告诉框架"这个插件是什么、何时运行"
2. **Markdown 正文** — 直接作为 LLM 的 system prompt 发送

以 `narrator`（主叙事插件）为例，这就是一个**零代码**插件的完整实现：

```markdown
---
name: narrator
description: 主叙事生成器，负责根据玩家输入和世界观设定生成故事内容。每个 Turn 自动执行。
pluginType: core-plugin
stage: narrative
model: ds
outputKind: story
capabilities: [narrative, narrative-engine]
trigger:
  type: auto
---

你是一个互动叙事游戏的叙述者（Narrator）。你必须完全基于世界观设定进行叙事，不可编造与设定矛盾的内容。

## 世界观设定

<world-lore>
{{ world.lore }}
</world-lore>

## 玩家当前输入

{{ player.message }}

## 叙事规则

- 使用第二人称叙述（"你..."）
- 严格遵循世界观中的地理、势力、力量体系等设定
- 长度控制在 300-600 字
- 在末尾留下一个自然的互动节点
```

就这样。没有 TypeScript，没有构建步骤。框架发现 `plugins/my-narrator/PLUGIN.md` 后会自动注册。

## 2. Frontmatter 字段详解

| 字段                     | 必需 | 类型                          | 说明                                                                                                                                   |
| ------------------------ | ---- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                   | 是   | string                        | 插件唯一标识（建议与目录名一致）                                                                                                       |
| `description`            | 是   | string                        | 插件功能描述（展示给玩家）                                                                                                             |
| `pluginType`             | 否   | `core-plugin` / `plugin`      | `core-plugin` 不可禁用，`plugin` 可按需启用/禁用。默认 `plugin`                                                                        |
| `stage`                  | 是\* | enum                          | 调度阶段：`setup` / `pre-turn` / `narrative` / `post-turn` / `audit`。\*`auto` / `scheduled` runtime 必需；`event` / `manual` 不可声明 |
| `needs`                  | 否   | array                         | 强依赖（排序 + 门控）：上游本轮未成功则本 runtime 被 skipped。支持 runtime id 或 `{ capability }`                                      |
| `after`                  | 否   | array                         | 弱依赖（只排序不设门）                                                                                                                 |
| `inputs`                 | 否   | object                        | 类型化上游数据绑定（见[进阶指南](./plugin-authoring.md#调度声明)）                                                                     |
| `model`                  | 否   | string                        | 使用的模型 slot（如 `ds`、`fast`、`balance`）。不填则用 `default`                                                                      |
| `outputKind`             | 否   | `story` / `plugin` / `system` | 输出在 UI 中的展示方式。`story` 显示在主聊天流，`plugin`（默认）可能被隐藏，`system` 不展示                                            |
| `capabilities`           | 否   | string[]                      | 能力标签，框架通过能力发现插件而非 ID。如 `[narrative]`、`[world-data-provider]`、`[image-generation]`                                 |
| `tags`                   | 否   | string[]                      | 玩家/作者筛选标签，用于准备页搜索、分组和世界 `pluginPolicy` 匹配。如 `[mode:dialogue, role:narrator]`                                 |
| `relations`              | 否   | object                        | 插件目录关系，可含 `provides`、`requires`、`conflicts`、`recommends`                                                                   |
| `trigger`                | 否   | object                        | 触发配置（见下方详解）                                                                                                                 |
| `tools`                  | 否   | object                        | 工具声明（见[进阶指南](./plugin-authoring-agent.md)）                                                                                  |
| `input`                  | 否   | object                        | 输入注入声明（见[进阶指南](./plugin-authoring-agent.md)）                                                                              |
| `userSettings`           | 否   | array                         | 玩家可调设置数组（见第 7 节）                                                                                                          |
| `timeoutMs`              | 否   | number                        | Runtime 总时长硬上限，默认 60000                                                                                                       |
| `maxSteps`               | 否   | number                        | 单次 attempt 内的 tool-call 步数上限，默认 10                                                                                          |
| `maxRetries`             | 否   | number                        | LLM 调用失败/超时/工具循环时的重试次数，默认 1                                                                                         |
| `callTimeoutMs`          | 否   | number                        | 单次 LLM 调用时长（ms），默认从 `timeoutMs` + `maxRetries` 推算                                                                        |
| `firstTokenTimeoutMs`    | 否   | number                        | 流式首 token 超时（ms），默认 30000                                                                                                    |
| `loopDetectionThreshold` | 否   | number                        | 连续相同 tool call 的判定阈值，默认 3；0 关闭                                                                                          |

**智能重试说明（默认已启用）：**

- Runtime 会在以下四种情况自动重试一次并向 prompt 追加 `[retry N]` 扰动消息：
  1. provider 返回 transient 错误（5xx / 网络错误 / rate limit）
  2. 单次调用超过 `callTimeoutMs`（默认 `min(60s, timeoutMs / 2)`)
  3. 流式调用 `firstTokenTimeoutMs` 内未收到任何 token
  4. 外层连续 3 次相同 `(tool name + args)` 调用
- 重试总数不会让整个 runtime 超过 `timeoutMs`。
- `llm.toml` 中的 `fallback = "story"` 仍然生效：同 preset 重试完再沿 gateway fallback chain 尝试。

**调度阶段（stage，kernel 强制）：**

| stage       | 何时运行                       | 用途                             | 示例                                                     |
| ----------- | ------------------------------ | -------------------------------- | -------------------------------------------------------- |
| `setup`     | `session.phase === "setup"` 时 | 游戏初始化（报告完成后进主循环） | pregame, world-init/schema-gen, char-creator/player-init |
| `pre-turn`  | 主循环第 1 段                  | 玩家输入前置处理 / 只读准备      | npc-graph/rag-retriever, scene-cast                      |
| `narrative` | 主循环第 2 段                  | 主叙事输出                       | narrator, chat-mode-narrator                             |
| `post-turn` | 主循环第 3 段                  | 叙事后记账 / 状态写入 / 后台任务 | codex, guide, npc-graph/extractor                        |
| `audit`     | 主循环第 4 段                  | 冲突/一致性审计（预留）          | —                                                        |

> **阶段间是严格屏障**（前一阶段全部结束才进下一阶段），由 `session.phase` 而不是回合数选带。**同阶段内部的先后只由依赖决定**：声明 `needs`（强依赖，上游失败则本 runtime skipped）或 `after`（弱排序），无依赖的 runtime 并发执行，同名时按 `name` 定序。

## 3. 提示词编写技巧

PLUGIN.md 的 Markdown 正文就是发给 LLM 的 system prompt。框架会在发送前替换模板变量。

**可用模板变量：**

```markdown
{{ world.lore }} <!-- 世界观 Markdown 文本 -->
{{ world.dimensions }} <!-- 世界维度信息（地理、势力等） -->
{{ world.openingScenario }} <!-- 开场场景描述 -->
{{ world.tone }} <!-- 叙事风格设定 -->
{{ player.message }} <!-- 当前玩家输入 -->
{{ codex.entries }} <!-- 已有图鉴条目（如插件需要） -->
```

**提示词最佳实践：**

1. **角色定义开头** — 第一句话明确 LLM 的角色："你是一个知识图鉴系统"
2. **XML 标签包裹数据** — 用 `<world-lore>...</world-lore>` 包裹注入的数据，帮助 LLM 区分指令和数据
3. **任务列表** — 用编号列表明确 LLM 要做的事情
4. **硬规则** — 在末尾用 `## 硬规则` 列出不可违反的约束
5. **Markdown 格式** — LLM 对 Markdown 结构敏感，用标题分节、列表列规则

**示例——精简版事件追踪插件：**

```markdown
---
name: my-event-tracker
description: 追踪故事中发生的重要事件
pluginType: plugin
stage: post-turn
needs:
  - capability: narrative-engine
model: plugin
trigger:
  type: auto
---

你是一个事件追踪系统。分析每轮叙事，识别重要事件。

## 当前叙事

{{ player.message }}

## 你的任务

1. 阅读叙事内容
2. 判断是否有重要事件发生（战斗、发现、社交等）
3. 如果有，输出 JSON 格式的事件摘要
4. 如果没有重要事件，输出空 JSON `{}`

## 硬规则

- 只记录叙事中**明确发生**的事件
- 每轮最多 3 个事件
- 不推测、不编造
```

## 4. 触发类型选择

通过 `trigger` 字段控制插件何时执行：

### auto（默认）— 每轮自动执行

```yaml
trigger:
  type: auto
```

适用于：主叙事、事件追踪等每轮都需要运行的插件。

### scheduled — 按间隔触发

```yaml
trigger:
  type: scheduled
  interval: 5 # 每 5 轮触发一次
```

适用于：记忆总结（每 N 轮整理一次）、定期检查。

加 `maxTriggerCount` 限制总次数：

```yaml
trigger:
  type: scheduled
  interval: 1
  maxTriggerCount: 1 # 只触发一次（如角色创建）
```

### event — 监听事件触发

```yaml
trigger:
  type: event
  topic: combat-start # 当 combat-start 事件发出时触发
```

适用于：战斗系统（收到战斗事件才运行）、特殊场景插件。

### manual — 手动触发

```yaml
trigger:
  type: manual
```

适用于：玩家主动点击按钮触发的功能（如查看角色面板）。manual runtime **永远不会**被每轮自动调度选中（也不可声明 `stage`），必须由 UI 或 `plugin-rpc` 显式按名触发；启用 manual 插件只表示该能力在 session 中可用。

### 表达"有条件才跑"

trigger 枚举只有上面四种，没有条件表达式类型。要表达运行条件，请用 `auto` + guard、`scheduled`、`event` 或 `manual`。

### 冷却和重试

所有触发类型都支持：

```yaml
trigger:
  type: auto
  cooldownTurns: 3 # 触发后至少间隔 3 轮
  maxTriggerCount: 10 # 整个会话最多触发 10 次
  startTurn: 2 # 等到 playing 阶段第 2 轮起才开始介入
```

> `startTurn` 是按 **playing 段** 计数（不是全局 turnNumber），所以"等待玩家先经历两轮再介入"在 pre-game 多少初始化轮次都不影响结果。

### 段职责约定（软约束）

Covel 的主循环把每一轮拆成 `pre-turn → narrative → post-turn → audit` 四个 stage：

| stage         | 推荐职责                            | 对 store 的权限                       |
| ------------- | ----------------------------------- | ------------------------------------- |
| **pre-turn**  | 检索、加载、向本轮 context 注入信息 | **建议只读**（不改持久状态）          |
| **narrative** | 生成本轮叙事                        | 只写 narrativeOutput                  |
| **post-turn** | 状态变更、抽取、结算、为下一轮准备  | 可写（state.patch / plugin-data-set） |

#### 为什么需要这个约定

如果一个插件既在 pre 段读、又在 pre 段写，那「Turn N 的 post」和「Turn N+1 的 pre」职责就会混淆。后果：

- 同样的数据可能在两个时间点被写入，谁覆盖谁难判断
- 跨 turn 状态传递的语义不清楚（来自上一轮还是本轮？）
- 调试观测时间线会乱

#### 落地方式（软约束 — 框架不拦截）

**首选模式**：把"既读又写"的插件拆成两个 runtime：

| 插件        | pre runtime（只读）                                | post runtime（写）                                 |
| ----------- | -------------------------------------------------- | -------------------------------------------------- |
| `npc-graph` | `rag-retriever`（pre-turn）— 查图谱注入 npcContext | `extractor`（post-turn）— 基于叙事 upsert 节点和边 |

**例外是 OK 的**：

如果一个 runtime 内部的"读"只是**自身去重**而非"为别的 runtime 注入 context"，单 runtime 既读又写没问题：

- `codex`（post-turn）是 agent runtime，通过 `input.inject: plugin-data` 让框架在 prompt 构建时把已有条目自动塞进 `<existing-entries>` 块，LLM 一次调用就决定 unlock 或 update。读没有跨 runtime 消费方，不需要拆。
- `char-creator/character-tracker`（post-turn）是 agent runtime，同样用 `input.inject: plugin-data` 把现有角色名册注入 `<existing-characters>` 块，再决定 create/update。它**不声明** `list-characters`——名册已在 prompt 里，多一次工具往返是纯浪费；只保留 `get-character` 作为"摘要被截断、需要看完整属性"时的逃生口。同理不需要拆。

判断标准：**这次"读"的结果有没有被别的 runtime 消费？**

- 是 → 拆出 pre runtime，通过 `input.inject` 显式声明数据流
- 否 → 留在原 runtime 里，作为内部 dedup / scratch state

### 让 agent runtime 看到自己的已有状态（plugin-data inject）

**场景**：任何需要"先看已有状态再决定新增 / 更新"的 agent runtime。典型代表：codex 要避免重复条目、tracker 要避免重复建 NPC、extractor 要避免重复建边。

**错误做法**：在 prompt 里写一句"你必须先调用 `plugin-data-list` 拿已有数据"。

- 依赖 LLM 的 instruction following，偶发偷懒就会退化成"每轮当全新条目处理" → 重复条目爆炸
- 多花一次 LLM round-trip（第一次拿数据，第二次才写入），成本和延迟都翻倍

**正确做法**：在 PLUGIN.md frontmatter 里声明 `input.inject: plugin-data`，让框架在 prompt 构建阶段自动把本插件已有的 plugin-data 注入到 system prompt。

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
      format: summary # summary | ids-only | full
      maxEntries: 100 # 1..500，超出走两段式截断
```

LLM 拿到的 prompt 里会有两个 XML 块：

```xml
<narrator-output>
...本轮叙事...
</narrator-output>
<existing-entries>
- codex-bailing-marsh | 2025-04-10T... | {"title":"百灵沼泽","rarity":"rare",...}
- codex-qingping-sect | 2025-04-09T... | {"title":"青萍宗",...}
...
[总计 120 条，展示 100 条]
</existing-entries>
```

LLM 直接对照两个块即可判断"这个发现在不在已有条目里"，一次 LLM 调用就决定 `unlock-codex-entries`（新）或 `update-codex-entry`（补）。

**要点：**

- **只能读自己**：`namespace` 是本插件（`pluginId` 由框架从 manifest 注入）的命名空间。跨插件读不支持，会直接拒绝。
- **format 选哪个**：`summary` 是默认，每行 `key | updatedAt | JSON-snippet(200)`，通用且不依赖 value schema；`ids-only` 最省 token；`full` 调试用。
- **maxEntries**：默认 50，codex 这类条目多的可以调到 100。超过 500 会被 schema 拒绝。
- **两段式截断**：条目数超过 `maxEntries` 时，前半按 `createdAt` 升序（最早的"锚"永远可见，防止 session 后期误把老条目当成新条目），后半按 `updatedAt` 倒序（最近活跃）。两段互斥。末尾追加 `[总计 N 条，展示 M 条]` 提示。
- **空 namespace**：返回 `<tag>暂无</tag>`，让 LLM 知道"空"而不是"被截断了"。
- **错误传播**：`listPluginData` 失败会让 runtime 直接失败，错误走观测通道（trace + `runtime_outputs.error`），不会污染下游 runtime 的 context（由 Phase 0 错误隔离审计保证）。

**框架如何识别**：只要 manifest 的 `input.inject` 里出现至少一个 `kind: plugin-data` 条目，`turn-executor` 就会把该 runtime 切到 `buildContextAsync` 路径，调 `store.listPluginData` 拿数据；其他 runtime 继续走原来的同步 `buildContext`，零开销零回归。

#### 写入治理

post-narrator 段的持久化写入优先走 proposal / commit chain。`plugin-data-set`、`plugin-data-set-batch` 和返回 `withPendingProposals(...)` 的 local tool 都会统一进入 `PreStateCommit` / `PostStateCommit`、trace 与事务路径。

function runtime 和框架内部镜像仍然可以直接使用 `store.*`。这条路径适合内部实现，插件对 runtime 暴露的稳定写接口优先保持在 proposal 模式。

## 5. 使用内置工具

框架提供三个内置 UI 工具，**无需写代码**，只需在 frontmatter 中声明，然后在提示词中告诉 LLM 如何调用即可。

在写工具前，先做一次选择：

1. 通用、重复、跨插件复用的操作，优先使用 `tools.builtin`
2. 插件自己的 schema、RAG、批量写入、领域动作，在 `entry` 模块里注册并用 `tools.plugin` 声明
3. local tool 文件保持在插件目录内，例如 `plugins/my-plugin/tools/*.js`

当前实现里，local tool 可以读取注入的 `store`，持久化写入优先返回 `withPendingProposals(...)`；deterministic function handler 继续使用 `store` 完成内部批量写入。插件自己的公开契约依旧建议通过 `PLUGIN.md + tools/ + tests/` 保持完整。

### create-form — 创建玩家表单

在 frontmatter 中声明：

```yaml
tools:
  builtin:
    - create-form
```

在提示词中告诉 LLM 调用方式：

```markdown
## 工具调用

调用 `create-form` 创建角色创建表单：

- `formId`: "char-creation"
- `title`: 表单标题
- `fields`: 字段列表，每个字段 { type, name, label, placeholder?, options?, required? }
  - type 可选: text / textarea / select / checkbox / number
- `submitLabel`: 提交按钮文本
- `narrativeTemplate`: 叙事模板，用 {{fieldName}} 作为占位符
```

`narrativeTemplate` 是关键——玩家提交表单后，框架用玩家填写的值替换占位符，生成自然语言注入下一轮上下文。例如：

```
narrativeTemplate: "你的名字叫 {{characterName}}，拥有 {{spiritRoot}} 灵根。"
```

玩家填了 `characterName=林清风, spiritRoot=水` 后，LLM 下一轮看到的消息就是：

> 你的名字叫 林清风，拥有 水 灵根。

完整示例参见 `plugins/char-creator/PLUGIN.md`。

### create-choices — 创建选项列表

```yaml
tools:
  builtin:
    - create-choices
```

```markdown
## 工具调用

当需要玩家做选择时，调用 `create-choices`：

- `choiceId`: 选项组 ID
- `prompt`: 引导文本（如"你要怎么做？"）
- `choices`: 至少 2 个选项，每个 { id, label, description?, category? }
  - category: safe / aggressive / creative / wild（可选）
```

`create-choices` 适合通用的 `interaction.request` 流程。像 guide、codex 这类持续存在的插件消息面，也可以采用 `ui.message + plugin_data + local tool` 的路径，把具体 UI 保持在插件包内。

### create-notification — 显示通知

```yaml
tools:
  builtin:
    - create-notification
```

```markdown
调用 `create-notification` 通知玩家：

- `level`: info / success / warning / error
- `title`: 通知标题
- `message`: 通知内容
```

例如 `codex` 每解锁一个图鉴条目就发一条通知：

```markdown
### create-notification

每解锁一个新条目，发一条通知。使用 `success` 级别，标题格式："📖 发现新知识：{title}"
```

## 6. 使用 references/ 目录

对于大量参考资料（如世界观细节、怪物图鉴数据），可以放在 `references/` 目录下，**按需注入**，避免每轮都消耗 token。

```
plugins/my-codex/
├── PLUGIN.md
└── references/
    ├── dragons.md
    ├── elven-history.md
    └── alchemy-recipes.md
```

**参考文件格式：**

```markdown
---
keywords: [龙族, 龙鳞, 上古战争, Drakon]
---

# 龙族传说

龙族是远古时代最强大的种族...
```

- `keywords` 是触发条件 —— 当玩家消息或叙事上下文中出现任一关键词时，这个参考文件的内容会自动注入到 LLM 上下文中
- 没有 `keywords`（或空数组）的参考文件**每次都会注入**
- 关键词匹配不区分大小写，支持子串匹配

**在 PLUGIN.md 中引用：**

在 Markdown 正文中用标准 Markdown 链接指向 references/ 路径，框架会自动发现并加载：

```markdown
更多关于龙族的信息请参见 [龙族传说](references/dragons.md)。
关于精灵历史请参见 [精灵编年史](references/elven-history.md)。
```

## 7. 配置字段（`userSettings`）

用 `userSettings` 声明让玩家在「设置 > Plugins > 你的插件」里调的旋钮，无需写任何前端代码：

```yaml
userSettings:
  - key: narrativeLength
    type: select
    default: medium
    label: { zh: 叙事长度, en: Narrative length }
    description: { zh: 控制每轮叙事的长度, en: Length of each narration }
    options:
      - { value: short, label: { zh: 短, en: Short } }
      - { value: medium, label: { zh: 中, en: Medium } }
      - { value: long, label: { zh: 长, en: Long } }
  - key: detailLevel
    type: integer
    min: 1
    max: 5
    default: 3
    label: { zh: 细节等级, en: Detail level }
    description: { zh: 环境描写的详细程度, en: Level of environmental detail }
  - key: enableCombatNarrative
    type: toggle
    default: true
    label: { zh: 战斗叙事, en: Combat narration }
```

支持的字段类型：

| type       | 说明         | 额外参数             |
| ---------- | ------------ | -------------------- |
| `text`     | 单行文本     | —                    |
| `textarea` | 多行文本     | —                    |
| `number`   | 小数         | `min`, `max`, `step` |
| `integer`  | 整数         | `min`, `max`, `step` |
| `slider`   | 滑块（数值） | `min`, `max`, `step` |
| `toggle`   | 开关         | —                    |
| `select`   | 下拉选择     | `options`（必需）    |
| `slot`     | 模型槽选择器 | —                    |

字段说明：`key` 用作存储键（`/^[a-zA-Z][a-zA-Z0-9_-]*$/`）；`label` / `description` 是 `I18nText`（`string` 或 `{ zh, en }`）；`default` 可省（如 cost-gate 靠 env 兜底）。声明的 `min` / `max` / `options` 会进 schema 校验——越界值会被拒，不只是 UI 提示。

框架会**自动**把每条注册成 `plugin.<pluginId>.<key>` 并渲染成对应控件，零前端代码。runtime 里读取：agent 用 `{{ userSettings.<key> }}` 模板变量；function/hook 用 `ctx.userSettings` / `ctx.getOwnSettings()`。

**`type: slot`——让玩家选服务配置**：插件要调用 LLM / 图像 / TTS 时，得知道走 `llm.toml` 里哪个 `[covel.<slot>]`。声明成 `slot` 类型后，框架把已配置的槽渲染成选择器（不是让玩家手打槽名），并在开局准备界面直接给出同一个选择器 + 「该槽未配置」的红字提示：

```yaml
userSettings:
  - key: modelPresetId # key 名随意，框架认的是 type
    type: slot
    default: image # 声明的默认槽即使还没配置，也始终出现在选项里
    label: { zh: 服务配置, en: Service setup }
```

`default` 指向的槽由插件自己传给 `ctx.images.generate({ presetId })` / `ctx.speech.generate()` 等接口。框架**按 `type` 发现**这个设置，与 `key` 叫什么无关。

> **多 runtime 插件注意**：`userSettings` 的存储键是 `plugin.<pluginId>.<key>`——**插件级**，不是 runtime 级。两个 runtime 声明同一个 `key` 就共用同一个值：完全相同的声明会自动去重（一个共享旋钮重复写在每个读它的 runtime 上，是正常写法），声明不一致则只有一个生效、另一个被丢弃，`pnpm validate:plugin <插件目录>` 会报错。

**世界可预置默认值**：世界包能在 `world.yaml` 顶层用 `pluginSettings` 给这些 `userSettings` 设世界级默认（玩家仍可覆盖）。解析链是 `玩家覆盖 → 世界默认 → 这里声明的 default`。见 [world-data.md](../reference/world-data.md#插件配置默认值pluginsettings)。

## 8. 世界包创建

世界包定义了游戏的世界观设定，是独立于插件的内容包。

```
worlds/my-world/
├── world.yaml       # 元信息清单
├── WORLD.md         # 世界观文本（Markdown）
└── data/
    ├── world.data.yaml
    ├── dimensions.yaml
    └── characters/cast.json
```

**world.yaml 示例：**

```yaml
schemaVersion: "1.0"
id: cloudmere
name: 九州・云梦泽
version: "0.1.0"
summary: 修仙世界，灵气复苏，宗门林立。你是偏僻小宗的外门弟子。
defaultLocale: zh-CN
supportedLocales:
  - zh-CN
tags:
  - xianxia
  - adventure

requiredPlugins:
  - pregame
  - world-init
  - char-creator
  - narrator
recommendedPlugins:
  - guide
  - codex
  - npc-graph
  - living-world-rules
optionalPlugins:
  - player-identity
excludedPlugins:
  - chat-mode-narrator
  - scene-cast
  - scene-prompts
  - branch-reply
pluginPolicy:
  preset: traditional-story
  preferTags:
    - mode:traditional-story
  avoidTags:
    - mode:dialogue
  packs:
    - id: focused-story
      label: 专注故事
      description: 主叙事器加低成本状态插件。
      plugins:
        - pregame
        - world-init
        - char-creator
        - narrator
      optionalPlugins:
        - memory
      excludedPlugins:
        - chat-mode-narrator
      tags:
        - mode:traditional-story
      reason: 适合长篇探索和较少插件干扰的开局。

worldData: data/world.data.yaml
```

`data/world.data.yaml` 示例：

```yaml
schemaVersion: 1
sources:
  dimensions:
    kind: yaml
    path: data/dimensions.yaml
    schema: covel://world/dimensions
    to: world:metadata.dimensions

  cast:
    kind: json
    path: data/characters/cast.json
    schema: plugin://character-blueprint/blueprints
    to: plugin:character-blueprint/blueprints
    key: id
    effects:
      - characters
    after: dimensions
```

`data/dimensions.yaml` 保存世界维度，格式与 `WorldDimensions` 相同。可以包含 `geography`、`factions`、`powerSystem`、`history`、`economy`、`socialStructure`、`tone`、`mechanics`、`startingConditions` 等字段。

`openingHook` / `openingChips` 都接受 `string` 或 `{ "zh-CN": ..., "en-US": ... }`，留空时前端会回落到 `world.name` + `world.tags`。

**WORLD.md** 是默认的世界观长文本，框架通过 `{{ world.lore }}` 注入到插件提示词中。支持多语言：`WORLD.zh.md`、`WORLD.en.md`。

**`requiredPlugins`** 是世界运行依赖，前端准备页会锁定这些插件。**`recommendedPlugins`** 会在准备页默认选中，**`excludedPlugins`** 会在准备页默认关闭。这三个字段写在顶层或 `pluginPolicy` 下都可以；**`pluginPolicy`** 额外能表达场景意图和组合包，可包含 `preset`、`preferTags`、`avoidTags`、`requireCapabilities`、`requiredPlugins`、`recommendedPlugins`、`excludedPlugins`、`packs`。内置前端组合包有 `traditional-story`、`dialogue-mode`、`low-cost`，世界可以用 `preset` 引用，也可以通过 `packs` 自定义。创建会话时，前端会把最终选择的插件列表传给 `POST /api/sessions`。

**`worldData`** 指向统一数据索引。`to: world:metadata.dimensions` 会把维度写入 world metadata；`to: plugin:character-blueprint/blueprints` 加上 `effects: [characters]` 会在创建 session 时导入角色卡、实例化 NPC，并镜像到角色面板。运行中也可以在 `character-blueprint` 右侧面板用表单创建蓝图；完整迁移或调试时使用 JSON 导入入口。

开始游戏前，Web 准备页会根据当前插件选择调用 `POST /api/worlds/<world-id>/world-data/preflight`，展示 planned writes、目标摘要和 diagnostics。已有 session 可以调用 `POST /api/worlds/<world-id>/sync-data` 同步 importer 管理的数据；接口默认 dry-run，传 `dryRun:false` 才会写入，传 `force:true` 才会覆盖冲突。

第三方内容包可以交付自己的 `world.data.yaml`，或把覆盖文件放到 `~/.covel/world-overrides/<world-id>/world.data.override.yaml`。导入第三方插件数据时，目标插件需要在 `PLUGIN.md` 声明 `dataSchemas`，并提供 JSON Schema。更多字段见 [World Data reference](../reference/world-data.md)。

## 9. 完整的零代码插件示例

下面创建一个"故事引导"插件，在每轮叙事后给玩家提供选择：

```
plugins/my-guide/
├── PLUGIN.md
└── package.json
```

**PLUGIN.md：**

```markdown
---
name: my-guide
description: 故事引导插件，在叙事后为玩家提供 2-4 个行动选项。
pluginType: plugin
stage: post-turn
needs:
  - capability: narrative-engine
model: plugin
capabilities:
  - guide
tags:
  - mode:traditional-story
  - role:guide
relations:
  recommends:
    - narrator
trigger:
  type: auto
tools:
  builtin:
    - create-choices
userSettings:
  - key: choiceCount
    type: integer
    min: 2
    max: 6
    default: 3
    label: { zh: 选项数量, en: Choice count }
    description: { zh: 每轮提供的选项数, en: Choices offered per turn }
---

你是故事引导助手。你的任务是在每轮叙事后为玩家提供行动选项。

## 当前叙事

{{ player.message }}

## 你的任务

1. 阅读当前叙事内容
2. 根据叙事情境生成 2-4 个合理的行动选项
3. 调用 `create-choices` 创建选项列表
4. 调用工具后不要输出额外文本

## 工具调用

调用 `create-choices`：

- `choiceId`: 格式 "guide-turn-{turnNumber}"
- `prompt`: 简短的引导文本（如"接下来你打算..."）
- `choices`: 每个选项包含：
  - `id`: 唯一标识（如 "a", "b", "c"）
  - `label`: 选项文本（10-20 字）
  - `description`: 补充说明（可选）
  - `category`: safe / aggressive / creative（标记风格）

## 硬规则

- 选项必须基于当前叙事情境，不可凭空创造
- 至少包含一个"安全"选项和一个"冒险"选项
- 选项之间要有明显区分度
- 调用工具后不输出额外文本
```

**package.json：**

```json
{
  "name": "@covel/plugin-my-guide",
  "version": "0.0.0",
  "private": true,
  "type": "module"
}
```

---

## 下一步

- 想让插件调用自己的 JS 工具、注入其他插件的输出、或暴露 RPC action？ → [进阶指南（agent + 本地 JS）](./plugin-authoring-agent.md)
- 想用完整 TypeScript 类型、自定义审批策略、多 runtime 或发布到社区？ → [高级指南（TypeScript + 审批 + 发布）](./plugin-authoring-advanced.md)
- 想看所有已实现插件的 frontmatter 速查？ → [插件注册表 `docs/reference/plugins.md`](../reference/plugins.md)
- 写交互 UI 面板的规范？ → [插件 UI 与 runtime 指南](./plugin-ui-runtime-guidelines.md)
