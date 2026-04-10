# 插件注册表

> 所有已实现的 Covel 插件。每个插件以 `PLUGIN.md` 为核心定义，包含 frontmatter 元信息和 Markdown 提示词。

---

## 概览

| ID | 类型 | 优先级 | 触发方式 | 模型 slot | 描述 |
|----|------|--------|----------|-----------|------|
| core-pregame | core-plugin | 10 | scheduled（仅首轮） | — | 游戏初始化（function runtime） |
| core-world-init | core-plugin | 85 | scheduled（仅首轮） | `fast` | 世界维度初始化（guard + agent） |
| core-narrator | core-plugin | 500 | auto（每轮） | `ds` | 主叙事生成器 |
| core-codex | plugin | 650 | auto（每轮） | `fast` | 知识图鉴系统 |
| core-char-creator | core-plugin | 700 | scheduled（仅首轮） | `ds` | 角色创建引导 |

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

**职责**: 游戏开始时第一个执行的插件。读取世界观设定，发送欢迎通知，输出世界观摘要供后续叙事插件（narrator、codex、char-creator）作为上下文引导。

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
| model | `fast` |
| guard | `../../guard.js` |
| capabilities | `[world-data-provider]` |
| tools.local | `set-world-schema`, `set-world-entries-batch` |
| tools.builtin | `plugin-data-get`, `plugin-data-list` |

**Guard 门控**: `guard.js` 在 LLM 调用前执行（纯函数，零 LLM 开销）。检查 plugin_data 中是否已有世界维度数据，或从 world.yaml 导入 dimensions。若数据已存在，返回 `{ skip: true }` 跳过 LLM。

**Agent 职责**: 读取世界观文档，通过专用 local tools 批量生成角色属性 schema 和世界词条。只需 2 次工具调用（`set-world-schema` + `set-world-entries-batch`）。

**数据存储结构**:
- namespace `schema` — 维度 schema 定义
- namespace `entries` — 世界词条数据

---

## core-narrator

**路径**: `plugins/core-narrator/`

| 字段 | 值 |
|------|----|
| pluginType | `core-plugin`（不可禁用） |
| priority | 500 |
| trigger | `auto` — 每个 Turn 自动执行 |
| model | `ds`（DeepSeek slot） |
| tools | 无 |
| input.inject | 无 |

**职责**: 根据玩家输入、世界观和历史上下文生成主线叙事。输出 `narrativeOutput` 字段供其他插件引用。

---

## core-codex

**路径**: `plugins/core-codex/`

| 字段 | 值 |
|------|----|
| pluginType | `plugin`（可禁用） |
| priority | 650 |
| trigger | `auto` — 每个 Turn 自动执行 |
| model | `fast`（轻量模型 slot） |
| tools.local | `unlock-codex-entries`, `update-codex-entry` |
| tools.builtin | `create-notification` |
| input.inject | 无 |

**职责**: 分析叙事文本，识别并记录玩家发现的知识条目（怪物、道具、地点、传说、人物）。通过本地工具生成带稀有度分级的"知识发现"UI 卡片。

---

## core-char-creator

**路径**: `plugins/core-char-creator/`

| 字段 | 值 |
|------|----|
| pluginType | `core-plugin`（不可禁用） |
| priority | 700 |
| trigger | `scheduled`，`interval: 1`，`maxTriggerCount: 1` — 仅首轮触发 |
| model | `ds`（DeepSeek slot） |
| tools.builtin | `create-form` |
| input.inject | `core-narrator` → `narrativeOutput` → `<narrator-opening>` |

**职责**: 读取 narrator 的开场叙事，生成角色创建表单（含 `narrativeTemplate`）。玩家填写后，框架用玩家输入替换模板占位符，生成个性化的角色引入叙事。

---

## 待迁移插件（待开发）

以下插件在 v1 中存在，计划逐步迁移到 PLUGIN.md 格式：

| 插件 | 预期优先级 | 描述 |
|------|-----------|------|
| core-persona | 100 | AI 人格配置 |
| core-combat | 420 | 回合制战斗 |
| core-guide | 600 | 故事引导 + 选择面板 |
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

示例 frontmatter：
```yaml
capabilities: [narrative, world-data-provider]
```

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
