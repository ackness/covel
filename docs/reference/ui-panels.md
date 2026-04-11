# 右侧面板 Tab 定义

游戏工作台右侧面板的 7 个 Tab，每个 Tab 有明确的职责和数据源，互不重叠。

## Tab 总览

| Tab | 图标 | 职责 | 数据源 | 更新时机 |
|-----|------|------|--------|----------|
| 游戏 | Gamepad2 | 运行时游戏状态总览 | `gameState.*` (SSE push) | 每轮实时更新 |
| 角色 | User | 玩家/NPC 角色属性面板 | `/api/sessions/:id/characters` + snapshot API | 角色创建/变更时 |
| 事件 | Flame | 剧情事件追踪树 | `gameState.events` | 插件 emit event 时 |
| 图鉴 | Library | 知识百科（怪物/物品/地点/传说/人物） | `gameState.codex` | 插件写入 codex 时 |
| 状态 | Database | State change 历史记录 | `statePatches` (SSE push) | state.patch 提交时 |
| 世界观 | MapIcon | 世界 lore 文档（Markdown） | `world.lore` (世界包 WORLD.md) | 静态，会话开始时加载 |
| 知识库 | BookOpen | 长期记录（角色日记/任务档案） | `gameState.records` | 插件 record.upsert 时 |

## 各 Tab 详细说明

### 游戏 (Game)

**组件**: `GameStatusPanel`

显示当前游戏的运行时状态，由插件通过 `state.patch` proposal 写入 `gameState`。

包含的 section（按 gameState key 匹配）：

| Section | gameState key | 内容 |
|---------|---------------|------|
| 世界状态 | `worldState` | 当前位置、时间、天气 |
| 任务 | `quests` | 任务列表及进度 |
| 背包 | `inventory` | 物品 + 货币 |
| 战斗 | `combat` | 回合制战斗状态 |
| 记忆 | `memoryArchive` | 对话/事件摘要 |
| 其他 | 任意未知 key | 格式化渲染（含 characterSchema 角色属性模板） |

**过滤的 key**（由专属 Tab 处理）：`characters`, `characterFieldSchema`, `events`, `codex`, `records`, `state`

### 角色 (Character)

**组件**: `CharacterPanel`

Schema-driven 角色属性面板。根据世界初始化插件定义的 `CharacterAttributeSchema` 渲染结构化属性。

**渲染模式**：

1. **Schema 模式**（有 `characterSchema` 时）：按分类分组，每类有专属图标：
   - `bio` (基本) — 枚举用 Badge，数值用 text
   - `stats` (数值) — 带进度条（min/max）
   - `abilities` (能力) — 带进度条
   - `equipment` (装备) — key-value
   - `social` (社交) — key-value

2. **Fallback 模式**（无 schema）：简单 key-value 列表

**数据流**：
- 首次加载：`GET /api/sessions/:id/characters`
- 刷新恢复：`GET /api/sessions/:id/snapshot` → `characters` + `characterSchema`
- 实时更新：`submitInteraction` 后自动刷新 snapshot

### 事件 (Events)

**组件**: `EventPanel`

读取 `gameState.events`，渲染为可过滤的事件树。

- 4 种状态：active / evolved / resolved / ended
- 支持父子事件嵌套（`parentId` 引用）
- 可见性标记：visible / hidden / partial

### 图鉴 (Codex)

**组件**: `CodexPanel`

读取 `gameState.codex`，渲染为可搜索、可按分类过滤的百科词条列表。

- 5 种分类：monster / item / location / lore / character
- 支持搜索过滤
- 新发现标记（`isNew` badge）

### 状态 (State)

显示 `statePatches` 列表 — 每次 `state.patch` proposal 提交的变更记录。

### 世界观 (World)

显示世界包的 lore 文档（`WORLD.md` / `WORLD.zh.md`），使用 Markdown 渲染。这是玩家在开始游戏前可以查看/编辑的世界观原始文档。

**数据源**：`world.lore` — 从世界包 manifest 加载，静态内容。

### 知识库 (Records)

长期记录面板。与图鉴的区别：

- **图鉴**：插件发现的百科知识（怪物图鉴、物品手册、地点指南）— 客观世界知识
- **知识库**：与玩家相关的长期记录（任务档案、角色关系日记、重要决策历史）— 主观游戏历程

数据源：`gameState.records`（通过 `record.upsert` proposal 写入）

## 数据流架构

```
Runtime 执行
  → Proposal (narrative.append / state.patch / event.emit / record.upsert / ...)
  → Session Kernel commit
  → SSE 事件推送到前端
  → session-store dispatch
  → gameState 更新
  → 各 Tab 组件响应渲染

Snapshot 恢复（刷新）
  → GET /api/sessions/:id/snapshot
  → messages + characters + characterSchema + gameState + executionSteps
  → session-store dispatch
  → 各 Tab 组件恢复状态
```

## 扩展指南

添加新的右侧面板 Tab：

1. 在 `right-panel.tsx` 添加 `TabsTrigger` + `TabsContent`
2. 创建对应的 panel 组件（如 `xxx-panel.tsx`）
3. 确定数据源：`gameState.xxx`（插件写入）或独立 API
4. 在 `GameStatusPanel` 的 `KNOWN_KEYS` 中添加对应 key（避免重复显示）
5. 更新本文档
