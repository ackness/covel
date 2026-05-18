# 前端面板架构

> 前端（`apps/web/`）采用插件驱动的 UI 架构，右侧面板与聊天内插件消息面都由插件通过 json-render spec 声明，框架负责发现、装配与渲染。

> 另见：[docs/reference/ui-components.md](./ui-components.md) — json-render 组件目录（每个组件的名字、用途、关键 props），本页是面板装配逻辑，组件目录单独抽出以便索引。

## 架构总览

```
┌──────────────────────────────────────────────────────────────┐
│                         COVEL                                   │
├──────────────────────────┬──────────────────┬───────────────────┤
│  Center: Message Area    │                  │  Right: Plugin    │
│  ────────────────────    │                  │  Panels           │
│                          │                  │  ──────────       │
│  两条 json-render 链路   │                  │  VSCode-style     │
│  - Turn messages         │                  │  vertical bar     │
│  - Plugin message surface│                  │  ┌──┐             │
│  - Prose / Form / Alert  │                  │  │📖│ Codex       │
│  - Guide / Codex 摘要    │                  │  │👤│ Character   │
│                          │                  │  │🌍│ World Data  │
│                          │                  │  │..│ (更多插件)  │
│                          │                  │  └──┘             │
│                          │                  │                   │
│  Player Input            │                  │  Panel Content    │
│  [输入你的行动...]  [→]   │                  │  (json-render)    │
├──────────────────────────┴──────────────────┴───────────────────┤
│  Header: Session ID | Phase | Execution Status                  │
└─────────────────────────────────────────────────────────────────┘
```

## 右侧面板（Plugin-Driven）

### 设计原则

- **Lorebook Tab 由框架固定**，其余右侧面板由插件通过 `ui.right` 声明
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

| 插件/runtime             | 面板 ID        | 图标               | group      | 数据 namespace | 描述                                                                                                |
| ------------------------ | -------------- | ------------------ | ---------- | -------------- | --------------------------------------------------------------------------------------------------- |
| char-creator/player-init | character      | users              | character  | characters     | 角色列表（player + NPC + companion）                                                                |
| codex                    | codex          | book-open          | codex      | entries        | 知识图鉴                                                                                            |
| memory                   | memory         | brain              | memory     | （框架托管）   | 核心记忆面板：剧情摘要 / 当前场景 / 角色关系 / 玩家状态。纯 UI，由 `@covel/memory` 在每轮结束后写入 |
| npc-graph/extractor      | npc-graph      | network            | npc-graph  | nodes + edges  | NPC 关系图（force-directed 可视化）                                                                 |
| world-init/schema-gen    | world-overview | layout-dashboard   | world-data | (汇总)         | 世界总览（词条 + 维度的概览页）                                                                     |
| world-init/schema-gen    | world-entries  | book-marked        | world-data | entries        | 世界词条                                                                                            |
| world-init/schema-gen    | world-schema   | sliders-horizontal | world-data | schema         | 角色属性 schema                                                                                     |

> `world-init` 的 schema-gen runtime 注册三个 spec（`world-overview` / `world-entries` / `world-schema`），通过相同 `group: "world-data"` + `groupLabel` 合并为单个 activity-bar tab "世界维度"，内部横向子 Tab 在总览 / 词条 / 属性 之间切换。
> `char-creator` 的 character-panel 由 player-init runtime 声明，character-tracker runtime 共享同一个 namespace `characters`（由 `create-character` / `update-character` builtin 工具写入）。
> `npc-graph/extractor` 的 npc-graph-panel 引用 `GraphCanvas` 组件读取 `nodes` + `edges` 两个 namespace，呈现 force-directed 关系图（react-force-graph-2d 懒加载）。
> `memory` 是纯 UI 插件（`pluginType: core-plugin`，`trigger.type: manual`）：插件自身不写入 plugin-data，框架的 Memory System (`@covel/memory`) 负责在每轮结束后落 working memory / recall / archival，spec 直接读取这些表。

### 世界文档（框架自持 Tab）

`世界` 是 activity bar 中**框架自持**的 Tab，与插件驱动的 Tab 并列但不受 `/api/ui-specs` 影响：

- **数据源**：当前 session 的 `WorldRecord.lore`（即 `worlds/<id>/WORLD.md`，按 `defaultLocale` 解析 `WORLD.<lang>.md` → `WORLD.md`），由 `world-seed-loader` 在启动时写入 store。
- **交互**：以 Markdown 渲染（`@/components/ui/markdown`，`react-markdown` + `remark-gfm`）。`lore` 为空时回退展示 `description`，再为空展示 `worldDocumentEmpty` 文案。
- **实现**：`apps/web/src/components/session/world-document-panel.tsx`，在 `right-panel.tsx` 中以 `world` Tab 挂载，由 `game-view.tsx` 注入当前 `world: WorldRecord | null` prop。
- **隔离规则**：Tab 代码属于框架，仅依赖 `WorldRecord` 公开字段，不感知任何插件 ID。

> Lorebook 仍由 HTTP API（`GET/PATCH/DELETE /api/sessions/:id/lorebook[/:entryId]`）提供，目前没有内置 UI 消费方；如需展示，可由插件通过 `ui.right` JSON spec 自行实现。

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
  "emptyState": {
    "message": {
      "zh": "世界维度词条尚未生成，等待初始化完成……",
      "en": "World entries not yet generated, waiting for initialization…"
    }
  },
  "view": {
    "component": "Accordion",
    "repeat": { "statePath": "/entries", "key": "key" },
    "children": [
      {
        "component": "Section",
        "props": { "title": { "$item": "key" }, "icon": "chevron-right" },
        "children": [
          {
            "component": "JsonView",
            "props": { "value": { "$item": "value" } }
          }
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
- `shortLabel` — activity-bar 垂直 Tab 条上的短标签（可选，见下方「activity-bar 短标签」章节）
- `icon` — Lucide 图标名（kebab-case）
- `dataSource.namespace` — 从 `pluginData[pluginId][namespace]` 读取数据
- `emptyState.message` — 数据为空时显示的提示文字（见下方"空状态渲染"章节）
- `view` — json-render nested spec，使用框架 catalog 中的组件

### activity-bar 短标签

activity-bar（右侧垂直 Tab 条）每个 Tab 只能显示极窄的文字。框架默认对 `groupLabel`（或 `label`）做机械截断：

- 中文 ≥2 个汉字 → 取**前两个汉字**（"核心记忆" → "核心"）
- 多个英文词 → 每个词首字母大写、最多 3 个（"Core Memory" → "CM"）
- 否则 → 取前 4 个字符

当截断结果识别力弱（前缀通用、与其他 Tab 撞名）时，在 spec 顶层声明 `shortLabel` 显式覆盖：

```json
{
  "label": { "zh": "核心记忆", "en": "Core Memory" },
  "shortLabel": { "zh": "记忆", "en": "Memory" }
}
```

合并规则与 `groupLabel` 一致——同 `group` 内首个声明者赢；为 robustness 建议同 group 的所有 spec 都重复声明同一 `shortLabel`，避免依赖加载顺序。

插件拥有自己的 UI 文案命名空间。插件组名、插件短标签、面板标签、按钮和表单字段都应写在 `plugins/<id>/ui/*.json` 的 `I18nText` 中；框架 i18n 字典只承载框架自有导航、系统按钮和通用状态文案。多个插件共享同一 `group` 时，每个插件 spec 都应重复声明一致的 `groupLabel`，activity-bar 的短标签由同组第一个 `shortLabel` 决定。

实现位置：`apps/web/src/components/session/right-panel.tsx` 的 `compactTabLabel()` 与 `aggregateSpecsIntoGroups()`。

### 空状态渲染

当面板对应的 namespace 数据为空时（`Object.keys(data).length === 0`），`PluginPanel` 不渲染 `view`，而是显示一段居中的斜体提示文字。

**优先级**：`emptyState.message`（spec 声明）> 自动回退（`${panelLabel} 暂无数据，等待游戏推进……`）

**消息格式**：必须使用 I18nText 对象（至少包含 `zh` + `en` 两种 locale）；见下方「插件 UI 文本 I18nText 规范」：

```json
"emptyState": {
  "message": { "zh": "尚未创建角色，完成角色创建流程后将在此显示……", "en": "No characters yet…" }
}
```

**约定**：所有依赖 namespace 数据渲染的右侧面板 spec **必须**声明 `emptyState.message`，使用与面板业务语境匹配的提示语，而非通用文字。已内置 `emptyState` 的面板：

| 面板 spec              | 空状态提示                                                |
| ---------------------- | --------------------------------------------------------- |
| `character-panel.json` | 尚未创建角色，完成角色创建流程后将在此显示……              |
| `codex-panel.json`     | 图鉴暂无词条，等待 narrator 发现新知识……                  |
| `memory-panel.json`    | （核心记忆，由 `@covel/memory` 在每轮结束后写入）         |
| `npc-graph-panel.json` | 尚未识别到角色或势力关系，narrator 推进剧情后将自动浮现…… |
| `world-schema.json`    | 角色属性定义尚未生成，等待世界初始化……                    |
| `world-entries.json`   | 世界维度词条尚未生成，等待初始化完成……                    |

**`alwaysRender: true` 豁免**：spec 顶层声明 `"alwaysRender": true`（或 `view.component` 是 `ImageGallery` / `ImageJobs`，由 `specUsesComponent` 隐式判定）的 panel 不依赖 namespace 数据渲染——例如 `world-overview.json` 的 `WorldDimensions` 直接读 session 上下文，`gallery.json` / `jobs.json` 的 `ImageGallery` / `ImageJobs` 自行处理空态。这类 spec **可省略 `emptyState.message`**：前端 `PluginPanel` 根本不会进入空态分支。

**实现位置**：`apps/web/src/components/session/plugin-panel.tsx` 的 `PluginPanel` 组件（`isEmpty` 判断与 `alwaysRender` 短路）。

### 插件 UI 文本 I18nText 规范

**所有**面向用户的 UI 字符串（`label` / `groupLabel` / `shortLabel` / `emptyState.message` / `searchPlaceholder` / `emptyMessage` / `footer` 以及 json-render spec 内 `Text/Button/Badge/FormField/Alert/...` 的 `content` / `label` / `placeholder` / `title` / `message`）必须使用 `I18nText` 对象：

```ts
type I18nText = string | Record<LocaleTag, string>;
```

- 合法 locale key：`zh`、`zh-CN`、`zh-TW`、`en`、`en-US`、`en-GB`。框架匹配顺序：当前 locale → 前缀匹配（`zh-CN` → `zh`）→ `en-US` → `en` → 对象中任一值。
- **必须同时提供中文与英文**：只有英文 key（`en` 或 `en-US`）存在时，中文回退才能切回；反之亦然。
- 单一纯字符串**仅限**以下场景：value 不是自然语言（ID / 图标名 / 路径 / URL / 状态值），或者已经是翻译后的英文短语且被所有 locale 共用（如 `"NEW"`、`"Ping"`）。
- 禁止出现孤立的纯中文字符串。CI 脚本 `scripts/check-plugin-i18n.mjs` 会拒绝任何未被 I18nText 对象包裹的 CJK 字面量。

```json
// ✓ 合法
{ "label": { "zh": "世界维度", "en": "World Dimensions" } }
{ "content": { "zh-CN": "……", "en-US": "…" } }
{ "icon": "book-open" }                 // 非自然语言
{ "label": "Ping" }                     // 共用英文短语

// ✗ 非法（脚本阻断）
{ "content": "已收录到右侧图鉴" }         // 裸中文
{ "label": { "zh": "世界" } }            // 缺少英文 locale
```

**框架端解析器**：`apps/web/src/lib/catalog.tsx` 重新导出 `resolveI18n(value, locale?)` 与 `useI18nResolver()`；实现位于 `apps/web/src/lib/catalog/helpers.tsx`。所有内置 ComponentRenderer 已调用 hook 订阅 locale 变更；切语言时 json-render 子树会自动重渲染。

**验证**：`pnpm check:i18n` 会同时跑 `check-no-chinese-literal`（应用代码）与 `check-plugin-i18n`（插件 JSON）两套扫描。

### json-render 绑定速查

| 需求               | 写法                                                                          |
| ------------------ | ----------------------------------------------------------------------------- |
| 读状态             | `{ "$state": "/path" }`                                                       |
| 读写状态           | `{ "$bindState": "/path" }`                                                   |
| 迭代数组           | `repeat: { "statePath": "/path", "key": "id" }`（元素顶层字段，**非 props**） |
| 读当前 item 字段   | `{ "$item": "field" }`（字段名不带前导斜杠）                                  |
| 读写当前 item 字段 | `{ "$bindItem": "field" }`                                                    |
| 当前 index         | `{ "$index": true }`                                                          |

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

- 单插件多 runtime：`char-creator/player-init` + `char-creator/character-tracker` 共享 `character-panel.json`
- 跨插件组合：`char-creator` 贡献角色列表，未来 `inventory` 贡献背包，都声明 `group: "character"`，自动汇聚到同一个"角色"外层 Tab

**合并规则**：
| 字段 | 行为 |
|------|------|
| 相同 `group` | 合并为一个外层 Tab（横向子 Tab 切换） |
| 不同 `group` 或省略 | 独立外层 Tab（兜底 key 为 `${pluginId}::${specId}`） |
| `groupLabel` / `shortLabel` / `icon` / `groupOrder` | 冲突时"**首个声明者赢**"，按 `/api/ui-specs` 返回顺序（插件加载顺序） |
| `groupOrder` | 外层 Tab 在 activity bar 中的排序（数字小的排前，默认 500） |

**命名空间约定**：跨插件 group key 与 CSS class name 同理 —— 作者自觉使用命名空间前缀（`core.character`、`myorg.combat`）避免冲突，框架不做 magic 前缀。

**实现位置**：`apps/web/src/components/session/right-panel.tsx` 的 `aggregateSpecsIntoGroups()` 纯函数。该函数可独立测试（见 Playwright smoke test）。

### 排序

外层 Tab 按 `groupOrder` 排序（稳定排序，相同 order 保持加载顺序）。子 Tab 按贡献顺序展示。未来会支持用户拖拽。

## 消息区（Message Area）

### 两条渲染链路

当前消息区有两条并行链路：

1. **Turn message 链路**：`chat-messages.tsx` 读取 `turn_messages` / SSE 事件，经 `messageToSpec()` 转成 json-render spec，由 `MessageBlockRenderer` 渲染；具体 block/primitives 拆在 `apps/web/src/components/session/chat-messages/`
2. **Plugin message 链路**：同一文件在 `block.type === "plugin_message"` 分支里，通过 `/api/ui-specs?sessionId=` 发现 `ui.message`，再用 `PluginPanel` + `plugin_data` 渲染插件消息面

两条链路都使用同一套 json-render catalog。

| 链路           | 当前承载内容                                                | 实现位置                                                                                              |
| -------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Turn message   | 叙事文本、玩家输入、`interaction.requested` 表单/选择、通知 | `apps/web/src/components/session/chat-messages.tsx`, `apps/web/src/components/session/chat-messages/` |
| Plugin message | guide 建议卡、codex 本轮摘要、其他插件自定义消息面          | `apps/web/src/components/session/chat-messages.tsx`（`plugin_message` 分支）                          |

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
    1. POST /api/sessions/:id/plugin-rpc (`framework.submit-form`)
       (记录 submission + narrativeTemplate 填充)
    2. 根据 `submitBehavior` 决定是否回显自然语言与是否自动继续下一轮
    3. 下一轮由对应插件读取 `player.lastFormValues` 完成业务写入
```

### 行动引导交互

```
guide 分析叙事 → `generate-guide` 写入 `plugin_data[message]`
  → `ui.message` 渲染三组策略卡 + 自定义输入
  → 玩家点击建议后进入待发送区
  → InputBar 统一发送待发送草稿与手写输入
```

## 组件 Catalog

框架内置 ~25 个 json-render 组件，所有插件共享：

### 布局

| 组件      | 用途               |
| --------- | ------------------ |
| Stack     | 垂直排列，可设 gap |
| Row       | 水平排列           |
| Grid      | 网格布局           |
| Separator | 分隔线             |

### 展示

| 组件    | 用途                                 |
| ------- | ------------------------------------ |
| Text    | 文本（支持 variant/weight/size）     |
| Badge   | 彩色标签                             |
| Icon    | Lucide 图标                          |
| TagList | 标签列表                             |
| Prose   | Markdown 叙事文本（段落分割 + 加粗） |
| Source  | 来源归属标签                         |

### 数据

| 组件      | 用途                                                    |
| --------- | ------------------------------------------------------- |
| Card      | 卡片容器                                                |
| CardList  | 卡片列表                                                |
| EntryCard | 图鉴条目卡片（分类图标 + 稀有度 + 标签）                |
| StatBar   | 数值条（label + value/max + 进度条）                    |
| Progress  | 进度条                                                  |
| Accordion | 折叠面板容器（与 `repeat` + `Section` 组合）            |
| Section   | 可折叠 section（props: `title`, `icon`, `defaultOpen`） |
| JsonView  | 递归渲染任意 JSON 值（props: `value`）                  |

### 交互

| 组件        | 用途                           |
| ----------- | ------------------------------ |
| Button      | 按钮（default/primary/danger） |
| Input       | 文本输入                       |
| SearchInput | 带搜索图标的输入框             |
| Select      | 下拉选择                       |
| Switch      | 开关                           |
| FilterBar   | 分类筛选栏                     |

### 表单

| 组件         | 用途                        |
| ------------ | --------------------------- |
| Form         | 表单容器                    |
| FormHeader   | 表单标题栏                  |
| FormField    | 单个表单字段（text/select） |
| SubmitButton | 提交按钮（支持 disabled）   |

### 消息

| 组件          | 用途                               |
| ------------- | ---------------------------------- |
| PlayerMessage | 玩家消息气泡（右对齐）             |
| Alert         | 通知（info/success/warning/error） |

### 可视化

| 组件        | 用途                                                                                                                                                                                                                                                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GraphCanvas | 力导向关系图（react-force-graph-2d）。读取 `pluginId` 下两个 namespace 的数据（节点 + 边），按 `node.type` 着色，按边的 `strength` 正负染色。点击节点弹出档案。基于 lazy import，仅在打开面板时加载 ~60KB gzip 的额外 chunk。Props: `pluginId`, `nodesNamespace`, `edgesNamespace`, `height?`。当前由 `npc-graph` 使用。 |

## 数据流

### 右侧面板数据流

```
插件 local tool / builtin tool / function handler 写入 plugin_data
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
  → chat-messages 渲染 turn messages
  → 同组件 `plugin_message` 分支渲染 `ui.message`
```

## 扩展指南（第三方插件）

添加新的右侧面板（零框架代码修改）：

1. 在 `PLUGIN.md` frontmatter 添加 `ui.right: [./ui/my-panel.json]`
2. 创建 `ui/my-panel.json`，使用 catalog 中的组件编写 json-render spec
3. 在 local tool、builtin tool 或 function handler 中写入 `plugin_data`
4. 框架自动发现面板 → 渲染 Tab → pluginData 驱动更新

添加新的插件消息面：

1. 在 `PLUGIN.md` frontmatter 添加 `ui.message: [./ui/my-block.json]`
2. 创建 `ui/my-block.json`
3. 在 runtime / tool 中写入 `plugin_data[pluginId][message]`
4. `chat-messages.tsx` 的 `plugin_message` 分支自动发现 spec 并渲染

添加新的 turn-bound 交互块：

1. 在 runtime 输出或 tool 返回值里写 `interaction`
2. 由 session-kernel 归一化为 `interaction.request`
3. `chat-messages.tsx` 经 `messageToSpec()` 渲染表单、选择或确认 UI
