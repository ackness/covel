# 插件开发指南 · 零代码

> 面向**内容创作者**：只写 Markdown + YAML frontmatter，不写任何 JS/TS。一个合法的 Covel 插件最少只需要一个 `PLUGIN.md`。

> **读完你能做到**
> - 写一个只靠 `PLUGIN.md` 就能运行的插件
> - 根据场景选对触发类型（`auto` / `scheduled` / `event` / `manual` / `conditional`）
> - 用框架内置的三个 UI 工具（`create-form` / `create-choices` / `create-notification`）产生玩家可交互块
> - 通过 `references/` 目录按关键词按需注入参考资料，避免每轮烧 token
> - 用 `config` 字段暴露玩家可调参数
> - 打包一个 `worlds/<id>/` 世界包并指定 `requiredPlugins` / `recommendedPlugins`

---

## 1. 最简插件：只需一个 PLUGIN.md

一个合法的 Covel 插件最少只需要一个文件：

```
plugins/my-narrator/
└── PLUGIN.md
```

`PLUGIN.md` 由两部分组成：

1. **YAML frontmatter**（`---` 包裹）— 告诉框架"这个插件是什么、何时运行"
2. **Markdown 正文** — 直接作为 LLM 的 system prompt 发送

以 `core-narrator`（主叙事插件）为例，这就是一个**零代码**插件的完整实现：

```markdown
---
name: core-narrator
description: 主叙事生成器，负责根据玩家输入和世界观设定生成故事内容。每个 Turn 自动执行。
pluginType: core-plugin
priority: 500
model: ds
outputKind: story
capabilities: [narrative]
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

| 字段 | 必需 | 类型 | 说明 |
|------|------|------|------|
| `name` | 是 | string | 插件唯一标识（建议与目录名一致） |
| `description` | 是 | string | 插件功能描述（展示给玩家） |
| `pluginType` | 否 | `core-plugin` / `plugin` | `core-plugin` 不可禁用，`plugin` 可按需启用/禁用。默认 `plugin` |
| `priority` | 是 | number (0-1000) | 执行优先级，数字越小越先执行 |
| `model` | 否 | string | 使用的模型 slot（如 `ds`、`fast`、`balance`）。不填则用 `default` |
| `outputKind` | 否 | `story` / `plugin` / `system` | 输出在 UI 中的展示方式。`story` 显示在主聊天流，`plugin`（默认）可能被隐藏，`system` 不展示 |
| `capabilities` | 否 | string[] | 能力标签，框架通过能力发现插件而非 ID。如 `[narrative]`、`[world-data-provider]`、`[image-generation]` |
| `trigger` | 否 | object | 触发配置（见下方详解） |
| `tools` | 否 | object | 工具声明（见[进阶指南](./plugin-authoring-agent.md)） |
| `input` | 否 | object | 输入注入声明（见[进阶指南](./plugin-authoring-agent.md)） |
| `config` | 否 | object | 配置字段定义（见第 7 节） |
| `timeoutMs` | 否 | number | Runtime 总时长硬上限，默认 60000 |
| `maxSteps` | 否 | number | 单次 attempt 内的 tool-call 步数上限，默认 10 |
| `maxRetries` | 否 | number | LLM 调用失败/超时/工具循环时的重试次数，默认 1 |
| `callTimeoutMs` | 否 | number | 单次 LLM 调用时长（ms），默认从 `timeoutMs` + `maxRetries` 推算 |
| `firstTokenTimeoutMs` | 否 | number | 流式首 token 超时（ms），默认 30000 |
| `loopDetectionThreshold` | 否 | number | 连续相同 tool call 的判定阈值，默认 3；0 关闭 |

**智能重试说明（默认已启用）：**

- Runtime 会在以下四种情况自动重试一次并向 prompt 追加 `[retry N]` 扰动消息：
  1. provider 返回 transient 错误（5xx / 网络错误 / rate limit）
  2. 单次调用超过 `callTimeoutMs`（默认 `min(60s, timeoutMs / 2)`)
  3. 流式调用 `firstTokenTimeoutMs` 内未收到任何 token
  4. 外层连续 3 次相同 `(tool name + args)` 调用
- 重试总数不会让整个 runtime 超过 `timeoutMs`。
- `llm.toml` 中的 `fallback = "story"` 仍然生效：同 preset 重试完再沿 gateway fallback chain 尝试。

**优先级参考区间：**

| 区间 | 用途 | 示例 |
|------|------|------|
| 0-199 | 系统初始化 | core-persona (100) |
| 200-399 | 预处理 | — |
| 400-599 | 核心叙事 | core-narrator (500) |
| 600-799 | 后处理/追踪 | core-codex (650), core-char-creator (700) |
| 800-999 | 后台任务 | core-image (800), core-memory (900) |
| 1000 | 清理 | — |

## 3. 提示词编写技巧

PLUGIN.md 的 Markdown 正文就是发给 LLM 的 system prompt。框架会在发送前替换模板变量。

**可用模板变量：**

```markdown
{{ world.lore }}              <!-- 世界观 Markdown 文本 -->
{{ world.dimensions }}        <!-- 世界维度信息（地理、势力等） -->
{{ world.openingScenario }}   <!-- 开场场景描述 -->
{{ world.tone }}              <!-- 叙事风格设定 -->
{{ player.message }}          <!-- 当前玩家输入 -->
{{ codex.entries }}           <!-- 已有图鉴条目（如插件需要） -->
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
priority: 650
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
  interval: 5          # 每 5 轮触发一次
```

适用于：记忆总结（每 N 轮整理一次）、定期检查。

加 `maxTriggerCount` 限制总次数：

```yaml
trigger:
  type: scheduled
  interval: 1
  maxTriggerCount: 1   # 只触发一次（如角色创建）
```

### event — 监听事件触发

```yaml
trigger:
  type: event
  topic: combat-start  # 当 combat-start 事件发出时触发
```

适用于：战斗系统（收到战斗事件才运行）、特殊场景插件。

### manual — 手动触发

```yaml
trigger:
  type: manual
```

适用于：玩家主动点击按钮触发的功能（如查看角色面板）。

### conditional — 条件触发

```yaml
trigger:
  type: conditional
  condition: "turnNumber > 10"
```

适用于：到特定条件才激活的插件。

### 冷却和重试

所有触发类型都支持：

```yaml
trigger:
  type: auto
  cooldownTurns: 3     # 触发后至少间隔 3 轮
  maxTriggerCount: 10  # 整个会话最多触发 10 次
  startTurn: 2         # 等到 playing 阶段第 2 轮起才开始介入
```

> `startTurn` 是按 **playing 段** 计数（不是全局 turnNumber），所以"等待玩家先经历两轮再介入"在 pre-game 多少初始化轮次都不影响结果。

### 段职责约定（软约束）

Covel 的 turn pipeline 把每一轮拆成三段：

| 段 | 优先级 | 推荐职责 | 对 store 的权限 |
|---|---|---|---|
| **pre-narrator** | 101–499 | 检索、加载、向本轮 context 注入信息 | **建议只读**（不改持久状态） |
| **narrator** | 500 | 生成本轮叙事 | 只写 narrativeOutput |
| **post-narrator** | 501–1000 | 状态变更、抽取、结算、为下一轮准备 | 可写（state.patch / record.upsert / plugin-data-set） |

#### 为什么需要这个约定

如果一个插件既在 pre 段读、又在 pre 段写，那「Turn N 的 post」和「Turn N+1 的 pre」职责就会混淆。后果：

- 同样的数据可能在两个时间点被写入，谁覆盖谁难判断
- 跨 turn 状态传递的语义不清楚（来自上一轮还是本轮？）
- 调试观测时间线会乱

#### 落地方式（软约束 — 框架不拦截）

**首选模式**：把"既读又写"的插件拆成两个 runtime：

| 插件 | pre runtime（只读）| post runtime（写）|
|---|---|---|
| `core-npc-graph` | `rag-retriever` (490) — 查图谱注入 npcContext | `extractor` (620) — 基于叙事 upsert 节点和边 |

**例外是 OK 的**：

如果一个 runtime 内部的"读"只是**自身去重**而非"为别的 runtime 注入 context"，单 runtime 既读又写没问题：

- `core-codex` (650) 是 agent runtime，通过 `input.inject: plugin-data` 让框架在 prompt 构建时把已有条目自动塞进 `<existing-entries>` 块，LLM 一次调用就决定 unlock 或 update。读没有跨 runtime 消费方，不需要拆。
- `core-char-creator/character-tracker` (750) 是 agent runtime，先 `list-characters` 给自己看现有角色 id 列表，再决定 create/update。同理不需要拆。

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
    - from: core-narrator
      field: narrativeOutput
      as: "<narrator-output>"
    - kind: plugin-data
      namespace: entries
      as: "<existing-entries>"
      format: summary          # summary | ids-only | full
      maxEntries: 100          # 1..500，超出走两段式截断
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

#### 框架不拦截写入

PR-1 阶段评估过 commit-service 拒绝 pre 段的写入 proposal，最终决定**不做硬约束**。原因：

1. 约束是为了"结构稳定 + 后续扩展"，不是为了防滥用
2. 部分 function runtime 用 `store.*` 直接写（绕过 proposal），硬拦截要么漏要么误伤
3. 早期生态优先迭代速度

PR review 会盯着新插件是否符合段职责约定。代码评审可能因为段位违规打回，但运行时不会拒绝执行。

## 5. 使用内置工具

框架提供三个内置 UI 工具，**无需写代码**，只需在 frontmatter 中声明，然后在提示词中告诉 LLM 如何调用即可。

在写工具前，先做一次选择：

1. 通用、重复、跨插件复用的操作，优先使用 `tools.builtin`
2. 插件自己的 schema、RAG、批量写入、领域动作，放进插件自己的 `tools.local`
3. local tool 文件保持在插件目录内，例如 `plugins/my-plugin/tools/*.js`

当前实现里，local tool 与 deterministic function handler 可以使用注入的 `store` 完成插件包内批量写入。插件自己的公开契约依旧建议通过 `PLUGIN.md + tools/ + tests/` 保持完整。

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

完整示例参见 `plugins/core-char-creator/PLUGIN.md`。

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

例如 `core-codex` 每解锁一个图鉴条目就发一条通知：

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

## 7. 配置字段

让玩家在 UI 中调整插件行为，无需修改 PLUGIN.md：

```yaml
config:
  narrativeLength:
    type: enum
    options: [short, medium, long]
    default: medium
    label: 叙事长度
    description: 控制每轮叙事的长度
  detailLevel:
    type: integer
    min: 1
    max: 5
    default: 3
    label: 细节等级
    description: 环境描写的详细程度
  enableCombatNarrative:
    type: boolean
    default: true
    label: 战斗叙事
    description: 是否在战斗中生成详细叙事
```

支持的字段类型：

| type | 说明 | 额外参数 |
|------|------|---------|
| `string` | 文本输入 | — |
| `integer` | 整数 | `min`, `max` |
| `number` | 小数 | `min`, `max` |
| `boolean` | 开关 | — |
| `enum` | 下拉选择 | `options`（必需） |

框架会自动根据 config 定义渲染设置面板。

## 8. 世界包创建

世界包定义了游戏的世界观设定，是独立于插件的内容包。

```
worlds/my-world/
├── world.yaml       # 元信息清单
└── WORLD.md         # 世界观文本（Markdown）
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
  - core-persona
  - core-narrator
recommendedPlugins:
  - core-guide
  - core-inventory
  - core-combat

dimensions:
  geography:
    overview: 九州大陆东南的广袤灵域...
    regions:
      - name: 青萍山
        description: 青萍宗所在的灵脉山峰
        climate: 四季如春，常有灵雾缭绕
        landmarks:
          - name: 试炼场
            description: 年度试炼大会的比武场地

  factions:
    - id: qingping-sect
      name: 青萍宗
      description: 偏居一隅的中小宗门
      type: guild
      influence: minor
      leader: 宗主・陆沉渊（金丹后期）

  powerSystem:
    name: 灵气修炼
    type: cultivation
    tiers:
      - name: 练气
        rank: 1
        description: 感应灵气并引入体内

  tone:
    genres:
      - xianxia
    narrativeStyle: 古风仙侠笔触，山水灵秀中暗藏宗门权谋。

  startingConditions:
    openingScenario: >-
      试炼大会三日后举行，你正在坊市采购备战物资...
    startingLocation: 青萍山・坊市
```

**WORLD.md** 是默认的世界观长文本，框架通过 `{{ world.lore }}` 注入到插件提示词中。支持多语言：`WORLD.zh.md`、`WORLD.en.md`。

**`requiredPlugins`** 和 **`recommendedPlugins`** 会在创建会话时自动激活对应的插件。

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
priority: 600
model: plugin
trigger:
  type: auto
tools:
  builtin:
    - create-choices
config:
  choiceCount:
    type: integer
    min: 2
    max: 6
    default: 3
    label: 选项数量
    description: 每轮提供的选项数
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
