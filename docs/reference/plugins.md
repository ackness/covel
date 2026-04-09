# 插件注册表

> 所有已实现的 Covel 插件。每个插件以 `PLUGIN.md` 为核心定义，包含 frontmatter 元信息和 Markdown 提示词。

---

## 概览

| ID | 类型 | 优先级 | 触发方式 | 模型 slot | 描述 |
|----|------|--------|----------|-----------|------|
| core-narrator | core-plugin | 500 | auto（每轮） | `ds` | 主叙事生成器 |
| core-codex | plugin | 650 | auto（每轮） | `fast` | 知识图鉴系统 |
| core-char-creator | core-plugin | 700 | scheduled（仅首轮） | `ds` | 角色创建引导 |

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

## 待迁移插件（v1 → 当前格式）

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

### pluginType

| 值 | 含义 |
|----|------|
| `core-plugin` | 核心插件，Session 中不可禁用 |
| `plugin` | 普通插件，可按需启用/禁用 |

### trigger 类型

| 类型 | 说明 |
|------|------|
| `auto` | 每个 Turn 自动触发 |
| `manual` | 仅玩家手动触发 |
| `scheduled` | 每 N 轮触发一次（配合 `interval` + `maxTriggerCount`） |
| `conditional` | 满足条件时触发 |
| `event` | 监听特定事件触发 |
| `error-retry` | 前序 Runtime 出错时触发 |
