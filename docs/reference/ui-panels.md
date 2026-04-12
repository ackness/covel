# 前端面板架构（V2）

> V2 前端（`apps/web-v2/`）采用插件驱动的 UI 架构。所有面板由插件通过 json-render 声明式定义，框架负责发现和渲染。

## 架构总览

```
┌─────────────────────────────────────────────────────────────────┐
│                         COVEL v2                                │
├──────────────────────────┬──────────────────┬───────────────────┤
│  Center: Message Area    │                  │  Right: Plugin    │
│  ────────────────────    │                  │  Panels           │
│                          │                  │  ──────────       │
│  所有消息通过 json-render │                  │  VSCode-style     │
│  统一渲染：               │                  │  vertical bar     │
│  - Prose (叙事文本)      │                  │  ┌──┐             │
│  - Form (角色创建)       │                  │  │📖│ Codex       │
│  - Alert (通知)          │                  │  │👤│ Character   │
│  - Button (选择)         │                  │  │🌍│ World Data  │
│  - EntryCard (图鉴)      │                  │  │..│ (更多插件)  │
│  - ActionGuide (引导)    │                  │  └──┘             │
│                          │                  │                   │
│  Player Input            │                  │  Panel Content    │
│  [输入你的行动...]  [→]   │                  │  (json-render)    │
├──────────────────────────┴──────────────────┴───────────────────┤
│  Header: Session ID | Phase | Execution Status                  │
└─────────────────────────────────────────────────────────────────┘
```

## 右侧面板（Plugin-Driven）

### 设计原则

- **仅 World Tab 由框架固定**，其余全部由插件通过 `ui.right` 声明
- **框架不知道具体插件**，通过 `/api/ui-specs` 发现面板
- **json-render 渲染**，插件提供 JSON spec，框架提供组件 catalog
- **pluginData 驱动数据**，通过 `plugin-data.changed` SSE 事件实时更新

### 面板发现流程

```
session 建立 → GET /api/ui-specs?sessionId=<id>
  → server 按会话激活集（session plugin scope）过滤
  → { right: [...], message: [...], left: [...] }
  → 按 right[] 动态生成 Tab（icon + label）
  → 每个 Tab 对应一个 json-render Renderer
  → pluginData[pluginId][namespace] 注入为 state
```

> 不带 `sessionId` 的请求返回所有已加载插件（向后兼容用于 boot/debug）。`right-panel.tsx` 在 session 切换时会清空状态并以新 sessionId 重新拉取，避免跨会话的 Tab 残留。

### 当前注册的面板

| 插件/runtime | 面板 ID | 图标 | group | 数据 namespace | 描述 |
|------|---------|------|-------|---------------|------|
| core-char-creator/player-init | character | users | character | characters | 角色列表（player + NPC + companion） |
| core-codex | codex | book-open | codex | entries | 知识图鉴 |
| core-npc-graph/extractor | npc-graph | network | npc-graph | nodes + edges | NPC 关系图（force-directed 可视化） |
| core-world-init/schema-gen | world-entries | book-marked | world-data | entries | 世界词条 |
| core-world-init/schema-gen | world-schema | sliders-horizontal | world-data | schema | 角色属性 schema |

> `core-world-init` 的 schema-gen runtime 注册两个 spec，通过相同 `group: "world-data"` + `groupLabel` 合并为单个 activity-bar tab "世界维度"，内部横向子 Tab 切换 `词条 / 属性`。
> `core-char-creator` 的 character-panel 由 player-init runtime 声明，character-tracker runtime 共享同一个 namespace `characters`（由 `create-character` / `update-character` builtin 工具写入）。
> `core-npc-graph/extractor` 的 npc-graph-panel 引用 `GraphCanvas` 组件读取 `nodes` + `edges` 两个 namespace，呈现 force-directed 关系图（react-force-graph-2d 懒加载）。

### 声明方式

插件在 PLUGIN.md frontmatter 中声明 `ui.right`，引用 `ui/` 目录下的 JSON 文件：

```yaml
# PLUGIN.md
ui:
  right:
    - ./ui/my-panel.json
```

### JSON Spec 格式

```json
{
  "id": "world-entries",
  "group": "world-data",
  "groupLabel": { "zh": "世界维度", "en": "World Data" },
  "label": { "zh": "词条", "en": "Entries" },
  "icon": "book-marked",
  "dataSource": { "namespace": "entries" },
  "view": {
    "component": "Accordion",
    "repeat": { "statePath": "/entries", "key": "key" },
    "children": [
      {
        "component": "Section",
        "props": { "title": { "$item": "key" }, "icon": "chevron-right" },
        "children": [
          { "component": "JsonView", "props": { "value": { "$item": "value" } } }
        ]
      }
    ]
  }
}
```

关键字段：
- `id` — 面板唯一标识
- `group` — 同 group 的面板合并为一个外层 Tab
- `groupLabel` — 合并后外层 Tab 的显示名（可选，省略时用第一个 spec 的 `label`）
- `label` — 面板自身名（在子 Tab 上显示）
- `icon` — Lucide 图标名（kebab-case）
- `dataSource.namespace` — 从 `pluginData[pluginId][namespace]` 读取数据
- `view` — json-render nested spec，使用框架 catalog 中的组件

### json-render 绑定速查

| 需求 | 写法 |
|------|------|
| 读状态 | `{ "$state": "/path" }` |
| 读写状态 | `{ "$bindState": "/path" }` |
| 迭代数组 | `repeat: { "statePath": "/path", "key": "id" }`（元素顶层字段，**非 props**） |
| 读当前 item 字段 | `{ "$item": "field" }`（字段名不带前导斜杠） |
| 读写当前 item 字段 | `{ "$bindItem": "field" }` |
| 当前 index | `{ "$index": true }` |

> ⚠️ `repeat` 只接受 `statePath`，不是 `$state`。字段名不能带前导斜杠（`$item: "key"` ✓，`$item: "/key"` ✗）。

### 自动 `entries` 数组

框架从 `pluginData[pluginId][namespace]`（record 结构 `{ key: value }`）派生一个 `/entries` 数组，格式为 `[{ key, value }, ...]`，供 `repeat` 迭代使用。原 record 键仍可通过 `$state: "/someKey"` 直接访问 —— 两种方式共存。

### 多面板与分组（跨插件共享）

**`group` 是全局字符串，跨插件共享**。任意多个插件或同一插件的多个 runtime 声明相同 `group` 值，会被合并到同一个外层 Tab，各自贡献的 spec 以横向子 Tab 切换。

```
┌──────┬──────────────────────────────┐
│ 🌍 │ 世界维度                          │  ← 外层 Tab（group="world-data"）
│ 👥 │ [词条] [属性] [背包] ...             │  ← 子 Tab（多 runtime/多插件）
│ 📖 │ ┌──────────────────────────┐   │
└──────┤ (当前子 Tab 的面板内容)          │
       └──────────────────────────┘
```

**核心用例**：
- 单插件多 runtime：`core-char-creator/player-init` + `core-char-creator/character-tracker` 共享 `character-panel.json`
- 跨插件组合：`core-char-creator` 贡献角色列表，未来 `core-inventory` 贡献背包，都声明 `group: "character"`，自动汇聚到同一个"角色"外层 Tab

**合并规则**：
| 字段 | 行为 |
|------|------|
| 相同 `group` | 合并为一个外层 Tab（横向子 Tab 切换） |
| 不同 `group` 或省略 | 独立外层 Tab（兜底 key 为 `${pluginId}::${specId}`） |
| `groupLabel` / `icon` / `groupOrder` | 冲突时"**首个声明者赢**"，按 `/api/ui-specs` 返回顺序（插件加载顺序） |
| `groupOrder` | 外层 Tab 在 activity bar 中的排序（数字小的排前，默认 500） |

**命名空间约定**：跨插件 group key 与 CSS class name 同理 —— 作者自觉使用命名空间前缀（`core.character`、`myorg.combat`）避免冲突，框架不做 magic 前缀。

**实现位置**：`apps/web-v2/src/components/panels/right-panel.tsx` 的 `aggregateSpecsIntoGroups()` 纯函数。该函数可独立测试（见 Playwright smoke test）。

### 排序

外层 Tab 按 `groupOrder` 排序（稳定排序，相同 order 保持加载顺序）。子 Tab 按贡献顺序展示。未来会支持用户拖拽。

## 消息区（Message Area）

### 统一 json-render 渲染

所有消息类型通过 `messageToSpec()` 转换为 json-render spec，由框架 catalog 渲染：

| 消息类型 | json-render 组件 | 来源 |
|----------|-----------------|------|
| 叙事文本 | `Prose` | core-narrator `narrative.completed` 事件 |
| 玩家输入 | `PlayerMessage` | 用户发送 |
| 角色创建表单 | `Form` + `FormField` + `SubmitButton` | core-char-creator `interaction.requested` |
| 行动引导 | `Card` + `Badge` + `Button` | core-guide `generate-guide` 工具 |
| 通知 | `Alert` | 任何插件的 `create-notification` 工具 |
| 图鉴发现 | `EntryCard` | core-codex `unlock-codex-entries` 工具 |

### 消息 Block 声明

插件通过 `ui.message` 声明消息区 block 的渲染方式：

```yaml
ui:
  message:
    - ./ui/action-guide-block.json
```

### 表单提交流程

```
玩家填写表单 → 点击提交按钮
  → submitFormInputs():
    1. POST /api/sessions/:id/submit-inputs
       (narrativeTemplate 填充 + 角色创建 + phase 转换)
    2. 返回 filledNarrative（叙事文本，非原始字段数据）
    3. 显示叙事文本为玩家消息
    4. POST /api/actions (player_action) → 触发下一轮 Turn
```

### 行动引导交互

```
core-guide 分析叙事 → 生成建议卡片
  → 按风格分类渲染：稳妥/激进/创意/疯狂
  → 每个建议是 Button 组件
  → 玩家点击 → sendMessage(建议文本) → 触发下一轮 Turn
```

## 组件 Catalog

框架内置 ~25 个 json-render 组件，所有插件共享：

### 布局
| 组件 | 用途 |
|------|------|
| Stack | 垂直排列，可设 gap |
| Row | 水平排列 |
| Grid | 网格布局 |
| Separator | 分隔线 |

### 展示
| 组件 | 用途 |
|------|------|
| Text | 文本（支持 variant/weight/size） |
| Badge | 彩色标签 |
| Icon | Lucide 图标 |
| TagList | 标签列表 |
| Prose | Markdown 叙事文本（段落分割 + 加粗） |
| Source | 来源归属标签 |

### 数据
| 组件 | 用途 |
|------|------|
| Card | 卡片容器 |
| CardList | 卡片列表 |
| EntryCard | 图鉴条目卡片（分类图标 + 稀有度 + 标签） |
| StatBar | 数值条（label + value/max + 进度条） |
| Progress | 进度条 |
| Accordion | 折叠面板容器（与 `repeat` + `Section` 组合） |
| Section | 可折叠 section（props: `title`, `icon`, `defaultOpen`） |
| JsonView | 递归渲染任意 JSON 值（props: `value`） |

### 交互
| 组件 | 用途 |
|------|------|
| Button | 按钮（default/primary/danger） |
| Input | 文本输入 |
| SearchInput | 带搜索图标的输入框 |
| Select | 下拉选择 |
| Switch | 开关 |
| FilterBar | 分类筛选栏 |

### 表单
| 组件 | 用途 |
|------|------|
| Form | 表单容器 |
| FormHeader | 表单标题栏 |
| FormField | 单个表单字段（text/select） |
| SubmitButton | 提交按钮（支持 disabled） |

### 消息
| 组件 | 用途 |
|------|------|
| PlayerMessage | 玩家消息气泡（右对齐） |
| Alert | 通知（info/success/warning/error） |

### 可视化
| 组件 | 用途 |
|------|------|
| GraphCanvas | 力导向关系图（react-force-graph-2d）。读取 `pluginId` 下两个 namespace 的数据（节点 + 边），按 `node.type` 着色，按边的 `strength` 正负染色。点击节点弹出档案。基于 lazy import，仅在打开面板时加载 ~60KB gzip 的额外 chunk。Props: `pluginId`, `nodesNamespace`, `edgesNamespace`, `height?`。当前由 `core-npc-graph` 使用。 |

## 数据流

### 右侧面板数据流

```
插件工具调用 plugin-data-set
  → store 写入
  → eventBus 发射 plugin-data.changed
  → SSE 推送到前端
  → pluginData store 更新
  → json-render Renderer 自动重渲染
```

### 消息区数据流

```
Turn 执行 → 各 Runtime 按优先级运行
  → SSE 事件流:
    narrative.delta → 流式叙事追加
    narrative.completed → 完整叙事消息
    interaction.requested → 交互 block（表单/选择）
    execution.started/completed → 执行步骤状态
    plugin-data.changed → 插件数据更新
  → messageToSpec() 转换为 json-render spec
  → Renderer 渲染
```

## 迁移说明（V1 → V2）

| V1（`apps/web/`） | V2（`apps/web-v2/`） |
|--------------------|----------------------|
| 7 个硬编码 Tab | 1 个固定 Tab (World) + 插件动态注册 |
| React 组件直接渲染 | json-render 声明式渲染 |
| gameState 字段驱动 | pluginData namespace 驱动 |
| CodexPanel/EventPanel 等框架组件 | 插件 `ui/*.json` spec |
| State Tab 在右侧 | 移到 `/debug` 页面 |
| 框架代码引用插件数据格式 | 框架不知道任何插件数据结构 |

## 扩展指南（第三方插件）

添加新的右侧面板（零框架代码修改）：

1. 在 `PLUGIN.md` frontmatter 添加 `ui.right: [./ui/my-panel.json]`
2. 创建 `ui/my-panel.json`，使用 catalog 中的组件编写 json-render spec
3. 在工具中通过 `plugin-data-set` 写入数据
4. 框架自动发现面板 → 渲染 Tab → pluginData 驱动更新

添加新的消息 block：

1. 在 `PLUGIN.md` frontmatter 添加 `ui.message: [./ui/my-block.json]`
2. 创建 `ui/my-block.json`
3. 在工具返回值中设置 `ui: [{ type: "my-block", ...data }]`
4. 框架匹配 block type → 渲染 json-render spec
