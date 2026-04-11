# Plugin UI Decoupling Design

> 框架-插件-数据完全解耦：插件通过声明式 JSON 定义 UI，框架负责发现、加载和渲染，第三方插件作者不需要修改框架源码。

## 1. 问题陈述

当前框架存在以下耦合：

- 右侧面板 7 个 Tab 硬编码在 `right-panel.tsx`，第三方插件无法注册新面板
- 面板组件（CodexPanel、EventPanel、CharacterPanel 等）直接读取 `gameState` 中约定的字段，数据 schema 和 UI 耦合
- `GameStatusPanel` 硬编码 WorldState/Quests/Inventory 等分区名
- `block-renderer.tsx` 中 20+ 个 block type → 组件的映射是静态 `CUSTOM_RENDERERS` 对象
- 面板数据源不统一：有的读 gameState，有的读 pluginData，有的调 API

**目标**：第三方开发者只需要写 PLUGIN.md + tools/ + ui/，不碰框架代码就能做出带完整 UI 面板的插件。

## 2. 架构概览

### 2.1 声明式 UI 贡献

插件在 PLUGIN.md frontmatter 中声明 UI，引用独立的 JSON 文件（和 tools 声明方式对称）：

```yaml
tools:
  local:
    - ./tools/my-tool.js
  builtin:
    - plugin-data-set

ui:
  right:                         # 右侧状态面板
    - ./ui/my-panel.json
  message:                       # 中间消息栏行内 block
    - ./ui/my-block.json
  left:                          # 左侧栏
    - ./ui/my-settings.json
```

### 2.2 渲染引擎

采用 [json-render](https://github.com/vercel-labs/json-render)（Vercel Labs）作为声明式 UI 渲染引擎：

- 框架定义组件目录（catalog），插件只能使用目录中的组件
- 每个组件的 props 经过 Zod 校验，恶意 JSON 直接拒绝
- 支持状态管理（`$state`/`$bindState`）、条件渲染（`$cond`）、循环（`repeat`）、事件（`on`）
- 内置 shadcn/ui 适配器，与现有 UI 栈一致

### 2.3 三层面板渲染

```
Tier 1: Custom React       — 插件提供 .tsx/.js 组件（escape hatch）
Tier 2: json-render         — 插件提供 .json spec（主要路径，覆盖 80% 场景）
Tier 3: Raw JSON            — pluginData 直接展示（开发调试）
```

文件扩展名决定渲染方式：`.json` → json-render，`.tsx/.js` → 动态 import React 组件。

## 3. UI Slot 定义

三个位置对应三种用途：

```
┌─────────────┬──────────────────────────┬─────────────────┐
│  left        │  message                 │  right          │
│  左侧栏      │  中间消息/对话栏          │  右侧状态栏     │
│              │                          │                 │
│  不限定用途   │  行内 block              │  插件面板       │
│  插件自由声明 │  （发现卡、战斗结果等）    │  （图鉴、状态等）│
└─────────────┴──────────────────────────┴─────────────────┘
```

| Slot | 用途 | 渲染时机 |
|------|------|---------|
| `right` | 插件状态面板（右侧 Tab） | 始终可见，pluginData 驱动 |
| `message` | 行内消息 block | 工具返回 `ui` 字段时渲染 |
| `left` | 插件自由内容（设置、快捷操作等） | 用户打开时渲染 |

## 4. UI JSON 文件格式

### 4.1 右侧面板 `ui/my-panel.json`

```json
{
  "id": "codex",
  "group": "codex",
  "label": { "zh": "知识图鉴", "en": "Codex" },
  "icon": "book-open",
  "dataSource": { "namespace": "entries" },
  "view": {
    "component": "Stack",
    "children": [
      {
        "component": "SearchInput",
        "props": {
          "placeholder": { "zh": "搜索图鉴...", "en": "Search codex..." },
          "value": { "$bindState": "/search" }
        }
      },
      {
        "component": "CardList",
        "repeat": { "$state": "/filteredEntries" },
        "children": [
          {
            "component": "EntryCard",
            "props": {
              "title": { "$bindItem": "/title" },
              "category": { "$bindItem": "/category" },
              "rarity": { "$bindItem": "/rarity" }
            }
          }
        ]
      }
    ]
  }
}
```

### 4.2 消息 block `ui/my-block.json`

```json
{
  "id": "codex-discovery",
  "trigger": "codex-discovery",
  "view": {
    "component": "Card",
    "children": [
      {
        "component": "Row",
        "children": [
          { "component": "Icon", "props": { "name": { "$state": "/style/icon" } } },
          { "component": "Text", "props": { "content": { "$state": "/title" }, "weight": "bold" } },
          { "component": "Badge", "props": { "label": { "$state": "/rarity" } } }
        ]
      },
      { "component": "Text", "props": { "content": { "$state": "/content" }, "variant": "muted" } }
    ]
  }
}
```

### 4.3 左侧栏 `ui/my-settings.json`

```json
{
  "id": "codex-config",
  "label": { "zh": "图鉴设置", "en": "Codex Settings" },
  "icon": "settings",
  "view": {
    "component": "Form",
    "children": [
      {
        "component": "Switch",
        "props": {
          "label": "自动解锁",
          "checked": { "$bindState": "/autoUnlock" }
        }
      },
      {
        "component": "Select",
        "props": {
          "label": "最低稀有度",
          "value": { "$bindState": "/minRarity" },
          "options": [
            { "value": "common", "label": "普通" },
            { "value": "rare", "label": "稀有" }
          ]
        }
      },
      {
        "component": "Button",
        "props": { "label": "保存" },
        "on": {
          "click": {
            "action": "apiCall",
            "params": { "method": "PUT", "path": "/plugin-data/config/settings" }
          }
        }
      }
    ]
  }
}
```

## 5. 多面板与分组

一个插件可以向同一个 slot 注册多个面板。通过 `group` 字段控制是合并还是独立：

```json
// combat-dashboard.json
{ "id": "combat-dashboard", "group": "combat", "label": "仪表盘" }

// skill-tree.json
{ "id": "skill-tree", "group": "combat", "label": "技能树" }
```

- 相同 `group` → 合并为一个 Tab，内部子 Tab 切换
- 不同 `group` 或无 `group` → 独立 Tab

## 6. 面板排序

框架不强制排序。用户可拖拽调整面板 Tab 顺序，偏好存储在 localStorage 中。首次加载按插件加载顺序排列。

## 7. 数据流

### 7.1 pluginData 作为统一数据源

所有面板数据来自 `pluginData[pluginId][namespace]`。pluginData 直接注入为 json-render 的 state，无需额外映射层。

```
pluginData["core-codex"]["entries"]
  → json-render state: { "codex-fire-magic": { title: "...", ... }, ... }
  → UI: { "$state": "/codex-fire-magic/title" }
```

- `$state` 读取 pluginData 数据
- `$bindState` 用于前端临时状态（如搜索输入）
- 持久化写操作通过 Action 完成

### 7.2 实时更新

```
插件工具调用 plugin-data-set
  → store 写入
  → eventBus 发射 plugin-data.changed 事件
  → SSE 推送到前端
  → session-store 更新 pluginData
  → json-render 自动重渲染面板
```

## 8. Actions（双通道）

插件 UI 中的交互操作支持两种通道：

### 8.1 直接读写 pluginData（纯前端，简单操作）

```json
{
  "on": {
    "click": {
      "action": "apiCall",
      "params": {
        "method": "PUT",
        "path": "/api/session/:id/plugin-data/:pluginId/config/settings",
        "body": { "value": { "$state": "/formData" } }
      }
    }
  }
}
```

适合：改配置、保存用户偏好、删除条目。

### 8.2 触发 Kernel 事件（走服务端，复杂操作）

```json
{
  "on": {
    "click": {
      "action": "emitEvent",
      "params": {
        "type": "codex.export-requested",
        "data": { "format": "json" }
      }
    }
  }
}
```

适合：需要 LLM 参与的操作、触发工具调用、跨插件协作。

## 9. 右侧栏重构

### 9.1 迁移计划

| 当前 Tab | 迁移方案 |
|----------|---------|
| World | 框架保留（世界信息是框架层的） |
| Game Status | 迁移为通用插件面板（或删除，数据由各插件面板展示） |
| Character | 迁移为 `core-char-creator` 插件的 `ui.right` |
| Events | 迁移为 `core-narrator` 插件的 `ui.right` |
| Codex | 迁移为 `core-codex` 插件的 `ui.right` |
| Records | 迁移为插件的 `ui.right` |
| State | 移到 `/debug` 页面 |

### 9.2 最终结构

```
右侧栏 = [🌍 World (框架固定)] + [插件动态注册的面板...]
```

面板按用户拖拽顺序排列，偏好存 localStorage。

## 10. 自定义 React 组件（Escape Hatch）

对于 json-render 表达不了的复杂 UI，插件可提供 React 组件：

```yaml
ui:
  right:
    - ./client/BattleMap.tsx      # 或 ./client/dist/BattleMap.js
```

### 10.1 加载优先级

1. `client/dist/*.js` 存在 → 直接加载（插件作者预编译）
2. `client/src/*.tsx` 存在 → esbuild 即时编译 → 加载
3. `ui/*.json` → json-render 渲染

### 10.2 标准 Props 接口

所有自定义面板组件接收统一 props：

```typescript
interface PluginPanelProps {
  pluginId: string;
  data: Record<string, unknown>;                        // pluginData[pluginId][namespace]
  config: Record<string, unknown>;                      // 插件当前配置
  onAction: (action: string, payload: unknown) => void; // 触发动作（apiCall 或 emitEvent）
}
```

### 10.3 服务端编译

框架使用 esbuild 即时编译 `.tsx` 文件，产物通过 HTTP 提供给前端：

```
GET /api/plugins/:pluginId/client/:filename
→ 返回编译后的 JS 模块
```

## 11. 热加载

插件目录使用 chokidar 监听。用户拖入新插件时：

```
chokidar 检测到新文件/目录
  → 解析 PLUGIN.md
  → 加载 ui/*.json
  → 编译 client/*.tsx（如有）
  → 注册到 PluginRegistry
  → eventBus 发射 plugin.registered 事件
  → SSE 推送 plugin.registered 给前端
  → 前端动态添加 Tab / block 渲染器
```

已有的 `world-file-watcher.ts` 提供了相同的热更新模式可复用。

## 12. 组件目录（Catalog）

框架内置 ~40 个通用组件，基于 shadcn/ui：

```
布局:    Stack, Row, Grid, Separator, Accordion, Tabs, ScrollArea
展示:    Text, Badge, Icon, Image, TagList, Avatar, Tooltip
数据:    CardList, Table, StatBar, Progress, Timeline, Tree
交互:    Button, Input, Select, Checkbox, Switch, SearchInput, FilterBar
表单:    Form, FormField, RadioGroup, Slider, DatePicker
游戏:    EntryCard, StatBlock, InventorySlot, QuestItem
```

### 12.1 扩展预留

manifest 中预留 `ui.components` 字段用于插件注册自定义组件到全局 catalog，但**第一版不实现**。未来开放后，插件可以贡献新组件供其他插件使用。

## 13. 服务端 API

### 13.1 新增端点

```
GET /api/ui-specs
```

返回所有活跃插件的 UI 声明，按 slot 分组：

```json
{
  "right": [
    {
      "pluginId": "core-codex",
      "specs": [{ "id": "codex", "group": "codex", "label": {...}, "icon": "book-open", "view": {...} }]
    }
  ],
  "message": [
    {
      "pluginId": "core-codex",
      "specs": [{ "id": "codex-discovery", "trigger": "codex-discovery", "view": {...} }]
    }
  ],
  "left": [
    {
      "pluginId": "core-codex",
      "specs": [{ "id": "codex-config", "label": {...}, "view": {...} }]
    }
  ]
}
```

### 13.2 自定义组件端点

```
GET /api/plugins/:pluginId/client/:filename
```

返回编译后的 JS 模块（esbuild 编译或预编译的 dist 文件）。

## 14. 前端启动流程

```
boot():
  1. GET /api/ui-specs → 获取所有插件 UI 声明
  2. 右侧栏：World Tab (固定) + right[] 动态生成插件 Tab
  3. 消息栏：注册 message[] 的 blockType → json-render spec 映射
  4. 左侧栏：渲染 left[] 内容
  5. 订阅 plugin.registered / plugin.unregistered SSE 事件 → 动态增删
```

## 15. 插件目录结构

```
plugins/my-plugin/
  PLUGIN.md                    # Manifest（引用 tools + ui）
  package.json
  tools/                       # 服务端工具
    my-tool.js
  ui/                          # UI 声明（json-render spec）
    my-panel.json              # 右侧面板
    my-block.json              # 消息 block
    my-settings.json           # 左侧设置
  client/                      # 可选：自定义 React 组件
    src/
      ComplexPanel.tsx          # 源码
    dist/
      ComplexPanel.js           # 预编译产物
```

## 16. 第三方插件作者体验

**最简插件**（纯 JSON，零代码）：

```
my-bestiary/
  PLUGIN.md
  tools/
    record-creature.js
  ui/
    bestiary-panel.json
```

写 PLUGIN.md 声明 trigger + tools + ui → 写工具逻辑 → 写面板 JSON → 完成。不需要 React、不需要构建工具、不需要了解框架内部。

**高级插件**（自定义 React）：

```
my-battle-system/
  PLUGIN.md
  tools/
    attack.js
  ui/
    stats-panel.json            # 简单面板用 JSON
  client/
    src/BattleMap.tsx           # 复杂面板用 React
    dist/BattleMap.js           # 预编译
```

## 17. 实现分期

### Phase 1: 声明层

- `RuntimeManifest` 增加 `ui` 字段类型定义
- plugin-loader 解析 `ui` 声明，加载引用的 JSON 文件
- 新增 `GET /api/ui-specs` 端点

### Phase 2: 渲染层

- 引入 json-render，定义 covel catalog（~40 组件）
- 新建 `PluginPanelRenderer` 组件
- 重构右侧栏：World Tab (固定) + 动态插件 Tab

### Phase 3: 数据层

- pluginData 注入为 json-render state
- 实现 Action 双通道（apiCall + emitEvent）
- 消息栏 block 改为 json-render 渲染

### Phase 4: 迁移

- core-codex 迁移为 ui.right JSON 声明
- core-char-creator 角色面板迁移
- core-narrator 事件面板迁移
- 删除硬编码面板组件
- State Tab 移到 Debug 页面

### Phase 5: 高级能力

- 自定义 React 组件加载（esbuild 编译 + dist 直接加载）
- 插件热加载（chokidar 监听 + SSE 推送）
- 用户拖拽排序 Tab + localStorage 持久化
- 左侧栏插件内容渲染
