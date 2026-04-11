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
启动 → GET /api/ui-specs → { right: [...], message: [...], left: [...] }
  → 按 right[] 动态生成 Tab（icon + label）
  → 每个 Tab 对应一个 json-render Renderer
  → pluginData[pluginId][namespace] 注入为 state
```

### 当前注册的面板

| 插件 | 面板 ID | 图标 | 数据 namespace | 描述 |
|------|---------|------|---------------|------|
| core-char-creator | character | user | character | 角色属性展示 |
| core-codex | codex | book-open | entries | 知识图鉴（搜索 + 分类） |
| core-world-init | world-data | globe | entries | 世界维度数据 |

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
  "id": "codex",
  "group": "codex",
  "label": { "zh": "知识图鉴", "en": "Codex" },
  "icon": "book-open",
  "dataSource": { "namespace": "entries" },
  "view": {
    "component": "Stack",
    "children": [
      { "component": "SearchInput", "props": { ... } },
      { "component": "CardList", "repeat": { "$state": "/entries" }, "children": [...] }
    ]
  }
}
```

关键字段：
- `id` — 面板唯一标识
- `group` — 同 group 的面板合并为一个 Tab + 子 Tab
- `icon` — Lucide 图标名（kebab-case）
- `dataSource.namespace` — 从 `pluginData[pluginId][namespace]` 读取数据
- `view` — json-render nested spec，使用框架 catalog 中的组件

### 多面板与分组

一个插件可以注册多个面板。`group` 字段控制合并策略：
- 相同 `group` → 合并为一个 Tab，内部子 Tab 切换
- 不同 `group` 或无 `group` → 独立 Tab

### 排序

面板按加载顺序显示，用户可拖拽调整，偏好存 localStorage。

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
