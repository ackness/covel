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

- **所有右侧面板均由插件通过 `ui.right` 声明**（无框架固定 Tab；Lorebook 只有 HTTP API，见下方「世界文档」章节后的说明）
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

| 插件/runtime                                                             | 面板 ID             | 图标               | group         | 数据 namespace | 描述                                                                                                |
| ------------------------------------------------------------------------ | ------------------- | ------------------ | ------------- | -------------- | --------------------------------------------------------------------------------------------------- |
| affinity                                                                 | affinity            | heart              | affinity      | affinity       | 好感度面板（玩家↔NPC score 双向条 + tier 徽标 + 最近变化原因）                                      |
| char-creator/player-init                                                 | character           | users              | character     | characters     | 角色列表（player + NPC + companion）                                                                |
| character-blueprint                                                      | character-blueprint | id-card            | character     | blueprints     | 预设角色（世界作者预置的登场角色模板，只读；作为 `character` 组的子 Tab）                           |
| character-presence                                                       | character-presence  | image              | character-art | presence       | 角色立绘画廊（`PortraitGallery`，只读展示 + 玩家可上传替换头像）                                    |
| codex                                                                    | codex               | book-open          | codex         | entries        | 知识图鉴                                                                                            |
| core-quest                                                               | core-quest          | scroll-text        | core-quest    | quests         | 任务日志（进行中含 objectives 勾选清单 / 已完成 / 已失败 分组）                                     |
| dice-check/recorder                                                      | dice-check-panel    | dices              | （无）        | checks         | 判定记录（倒序 🎲 回执列表：骰式 / 成败配色 / critical 强调）                                       |
| inventory                                                                | inventory           | backpack           | inventory     | items          | 行囊（已装备分组 + 背包列表，数量徽标 + tags pill，`alwaysRender`）                                 |
| dashscope-image-gen/image-generator · openai-image-gen/image-generator   | `<plugin>-gallery`  | image              | image-studio  | images         | 剧情插图画廊（`ImageGallery`，`alwaysRender`）；两个图像插件各一套，合并进同一 `image-studio` 组    |
| dashscope-image-gen/image-generator · openai-image-gen/image-generator   | `<plugin>-jobs`     | loader             | image-studio  | \_jobs         | 生成任务视图（`ImageJobs`，`alwaysRender`）                                                         |
| dashscope-image-gen/prompt-generator · openai-image-gen/prompt-generator | `<plugin>-trigger`  | wand               | image-studio  | （无）         | 「生成图片」manual 触发入口按钮（`expectsBackgroundFollower`，`alwaysRender`）                      |
| mimo-tts/auto-narrate                                                    | mimo-tts-audio-tab  | headphones         | tts-studio    | tracks         | 旁白语音 playlist（`AudioPlayer`，`alwaysRender`）                                                  |
| living-world-rules                                                       | living-world-rules  | book-marked        | world-data    | rules          | 世界规则（长期设定 / 禁忌，只读；随 world-data 导入播种，作为 `world-data` 组的子 Tab）             |
| memory                                                                   | memory              | brain              | memory        | （框架托管）   | 核心记忆面板：剧情摘要 / 当前场景 / 角色关系 / 玩家状态。纯 UI，由 `@covel/memory` 在每轮结束后写入 |
| npc-graph/extractor                                                      | npc-graph           | network            | npc-graph     | nodes + edges  | NPC 关系图（force-directed 可视化）                                                                 |
| scene-cast                                                               | scene-cast          | users-round        | （无）        | active-cast    | 当前场景在场角色（只读，仅 name + role；内部选择信号留在 plugin_data）                              |
| scene-stage/resolver                                                     | scene-stage         | image              | scene-stage   | stage          | 当前场景舞台（只读）：场景名 + 昼夜徽标 + `sourceLabel` 状态文案（`pending` 时"背景生成中…"）       |
| world-init/schema-gen                                                    | world-overview      | layout-dashboard   | world-data    | (汇总)         | 世界总览（词条 + 维度的概览页）                                                                     |
| world-init/schema-gen                                                    | world-schema        | sliders-horizontal | world-data    | schema         | 角色属性 schema                                                                                     |

> `world-data` 组（groupLabel "世界资料"）汇聚三个 spec：`world-init` 的 `world-overview` / `world-schema`，以及 `living-world-rules` 的 `living-world-rules`（世界规则）。合并为单个 activity-bar tab，内部横向子 Tab 在总览 / 属性 / 世界规则 之间切换。（旧 `world-entries` 子 Tab 已移除：对导入型世界它只是 `world-overview` 已格式化渲染的同一份 dimensions 的原始 JSON 重复；`entries` 的 lorebook/prompt 写入不变，`/debug` Data Explorer 仍可查看。）
> `character` 组汇聚 `char-creator` 的 character-panel（活角色列表，character-tracker runtime 共享 namespace `characters`，由 `create-character` / `update-character` builtin 工具写入）与 `character-blueprint` 的预设角色面板（世界作者预置的登场角色模板，只读）。前者是当前存档的活状态，后者是导入的只读源；同一批角色导入后会 mirror 成活的 `CharacterRecord`，两个子 Tab 分别呈现"源"与"当前"。
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
  "specVersion": 1,
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

- `specVersion` — UI spec schema 版本（可选，省略按 v1 处理）；声明高于服务端支持版本会被拒绝，见下方「Spec 校验与版本」
- `id` — 面板唯一标识
- `group` — 同 group 的面板合并为一个外层 Tab
- `groupLabel` — 合并后外层 Tab 的显示名（可选，省略时用第一个 spec 的 `label`）
- `label` — 面板自身名（在子 Tab 上显示）
- `shortLabel` — activity-bar 垂直 Tab 条上的短标签（可选，见下方「activity-bar 短标签」章节）
- `icon` — Lucide 图标名（kebab-case）
- `dataSource.namespace` — 从 `pluginData[pluginId][namespace]` 读取数据
- `emptyState.message` — 数据为空时显示的提示文字（见下方"空状态渲染"章节）
- `view` — json-render nested spec，使用框架 catalog 中的组件（与 `_componentPath` 二选一：`.tsx`/`.js` 自定义组件由 loader 写入 `_componentPath`）

### Spec 校验与版本

`/api/ui-specs` 聚合时对每个 spec 执行 Zod 校验（结构包络 + `specVersion`），spec 是**不可信的插件输入**：

- `specVersion` 可省略（按 v1 处理）。声明高于服务端支持版本（当前 `CURRENT_UI_SPEC_VERSION = 1`，见 `apps/server/src/routes/misc-api/ui-spec-schema.ts`）会被拒绝，旧服务端遇到新插件包时显式报错而非渲染坏面板。
- 每个 spec 必须声明 `view`（对象）或 `_componentPath`（自定义组件）之一，否则校验失败。
- **单个坏 spec 不污染整个响应**：校验失败的 spec 从对应 slot 中剔除，并在响应顶层 `diagnostics[]` 中给出具体诊断（`{ pluginId, runtimeId, slot, specIndex, specId?, issues[{ path, message, code }] }`）——指明哪个插件、哪个字段、什么问题，而非泛泛的 "Invalid panel spec"。
- 前端（`right-panel.tsx`）在 dev 模式下把这些诊断打到 console；`plugin-panel.tsx` 的本地兜底消息也会带上 spec 名与具体原因（缺 `view` / `view` 非对象 / 转换失败）。

加载与校验结果按插件目录布局缓存，失效信号为 `PLUGIN.md` 与 `ui/*` 文件的 mtime/size 内容签名；会话级 `plugin_data` 物化仅在签名变化或首次访问时触发（详见 [api.md](./api.md#get-apiui-specs)）。

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
- 跨插件组合：`char-creator` 贡献角色列表，`inventory` 贡献背包；声明相同 `group` 后自动汇聚到同一个外层 Tab

**合并规则**：

| 字段                                                | 行为                                                                  |
| --------------------------------------------------- | --------------------------------------------------------------------- |
| 相同 `group`                                        | 合并为一个外层 Tab（横向子 Tab 切换）                                 |
| 不同 `group` 或省略                                 | 独立外层 Tab（兜底 key 为 `${pluginId}::${specId}`）                  |
| `groupLabel` / `shortLabel` / `icon` / `groupOrder` | 冲突时"**首个声明者赢**"，按 `/api/ui-specs` 返回顺序（插件加载顺序） |
| `groupOrder`                                        | 外层 Tab 在 activity bar 中的排序（数字小的排前，默认 500）           |

**命名空间约定**：跨插件 group key 与 CSS class name 同理 —— 作者自觉使用命名空间前缀（`core.character`、`myorg.combat`）避免冲突，框架不做 magic 前缀。

**实现位置**：`apps/web/src/components/session/right-panel.tsx` 的 `aggregateSpecsIntoGroups()` 纯函数。该函数可独立测试（见 Playwright smoke test）。

### 排序

外层 Tab 按 `groupOrder` 排序（稳定排序，相同 order 保持加载顺序）。子 Tab 按贡献顺序展示。

## 消息区（Message Area）

### 两条渲染链路

当前消息区有两条并行链路：

1. **Turn message 链路**：`chat-messages.tsx` 读取 `turn_messages` / SSE 事件，经 `messageToSpec()` 转成 json-render spec，由 `MessageBlockRenderer` 渲染；具体 block/primitives 拆在 `apps/web/src/components/session/chat-messages/`
2. **Plugin message 链路**：同一文件在 `block.type === "plugin_message"` 分支里，通过 `/api/ui-specs?sessionId=` 发现 `ui.message`，再用 `PluginPanel` + `plugin_data` 渲染插件消息面

两条链路都使用同一套 json-render catalog。

| 链路           | 当前承载内容                                                                                                                                   | 实现位置                                                                                              |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Turn message   | 叙事文本、玩家输入、`interaction.requested` 表单/选择、通知                                                                                    | `apps/web/src/components/session/chat-messages.tsx`, `apps/web/src/components/session/chat-messages/` |
| Plugin message | guide 建议卡、codex 本轮摘要、dice-check 🎲 判定结果块、core-quest 任务变更块、affinity 好感 toast、inventory 得失 toast、其他插件自定义消息面 | `apps/web/src/components/session/chat-messages.tsx`（`plugin_message` 分支）                          |

### 消息 Block 声明

插件通过 `ui.message` 声明消息区 block 的渲染方式：

```yaml
ui:
  message:
    - ./ui/action-guide-block.json
```

> **Bootstrap 注意（重要）**：`ui.message` block 只有在其声明的 `message` namespace 被写入数据后才会渲染。因此一个**只能由 block 内部按钮触发的纯手动写入者无法自举**——首屏没有数据，block 不出现，按钮也就永远点不到（典型死锁：`branch-reply` 早期即如此完全不显示）。让 block 首次出现的写入必须来自一个**非手动**路径：`scheduled` / `auto` runtime（读取叙事引擎输出后播种）、上游 runtime 的 `plugin.data` 提案，或 world-data 导入。`branch-reply` 用 `trigger: auto`（`stage: post-turn`，叙事引擎之后）播种 candidate[0]，详见 [plugins.md#branch-reply](./plugins.md#branch-reply)。

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

## 舞台模式（Stage View）

`viewMode: "stage"` 是消息区之外的第四个呈现档（与 `parsed` / `detailed` / `raw` 并列，头部 `GameViewHeader` 的 Toggle 切换）。它把消息区三件（`ChatMessages` + `PendingDraftsBar` + `MessageComposer`）整体替换成全屏舞台（视觉小说式：场景背景 + 立绘 + 打字机对话框），`GameViewHeader` 保留。

- **渲染条件**：`viewMode === "stage" && session.turnCount >= 1`。Pre-Game（`turnCount === 0`）即使处于 stage 档也走原有消息流（角色创建 / begin-adventure 不受影响）。
- **初值**：世界包 `world.yaml` 顶层 `defaultViewMode: stage`（→ `WorldRecord.metadata.defaultViewMode`）让会话**首挂载**即进舞台；玩家在头部切换后以玩家选择为准（无持久化）。见 [world-data.md](./world-data.md#world-package)。

### 层级与数据源

五层绝对定位、`z-index` 分档，DOM 顺序 Backdrop → Sprites → Hud → Dialog → Choices，全部套在一个 `relative` 有界容器里。数据全部经 `usePluginNamespace(pluginId, namespace)` 读取（`StageView` 保持薄，逻辑在 `stage-selectors.ts`）：

| 层           | 数据源                                                                                        | 选择器                                                              |
| ------------ | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| **Backdrop** | `("scene-stage","stage")["current"]`                                                          | `resolveBackdrop`（四档回退，见下）                                 |
| **Sprites**  | `("scene-cast","active-cast")["current"].speakers` × `("character-presence","presence")`      | `computeSpriteSlots`（站位/高亮，无立绘则过滤）                     |
| **Hud**      | `("scene-stage","stage")["current"]`（`name` / `variant` / `sourceLabel` / `source`）         | —（无状态，按钮回调上抛）                                           |
| **Dialog**   | 最新 `kind === "story"` 消息的 `content`                                                      | `use-typewriter`（流式驱动、`\n\n` 分段、▼ 暂停）                   |
| **Choices**  | 未提交的 choice 类 interaction block + `("scene-prompts","message")` 的 `prompt{N}Text/Label` | `extractInteractionChoices` + `mergeChoices`（末位追加 ✎ 自由输入） |

“流式中”判定沿用内核约定——无 streaming 布尔，`executing && story 消息 id 以 stream_ 开头`；打字机读完（`done`）且 `!executing` 才浮现选择肢。

### 背景回退链（`resolveBackdrop`）

| 档                 | 触发                                      | 表现                                        |
| ------------------ | ----------------------------------------- | ------------------------------------------- |
| `scene`            | `stage/current.resolved` 是 `MediaRef`    | 渲染场景图（换图 600ms crossfade）          |
| `previous-or-hero` | `source === "pending"`（生成中）          | 保留上一帧场景图 + 呼吸徽标，无则退世界头图 |
| `hero`             | `source === "none"` 或无 scene-stage 数据 | 世界头图（`worldVisual().image`）           |
| `gradient`         | 理论兜底                                  | 世界 accent 渐变（选择器当前不返回）        |

### 履历抽屉与表单模态

- **履历抽屉**：Hud 的 📖 打开 Radix `Dialog`，内含 `flex h-[80vh] flex-col` 包裹的完整 `<ChatMessages viewMode="parsed">`（舞台下仍可回看/滚动全部解析消息）。
- **表单模态**：舞台对话框只接选择肢与自由文本，故 messages 里出现未提交的 **form 类** interaction block 时（`extractPendingFormMessages`），弹 `Dialog` 承载 `MessageBlockRenderer` 填写；提交后自动关闭。

实现位置：`apps/web/src/components/session/stage/`（`StageView.tsx` 组装 + `Stage{Backdrop,Sprites,Hud,Dialog,Choices}.tsx` + `stage-selectors.ts` + `use-typewriter.ts`）。

## 组件 Catalog

组件目录已抽出到独立页面，见 [docs/reference/ui-components.md](./ui-components.md)（当前 48 个组件，权威来源为 `apps/web/src/lib/catalog.tsx` 导出的 `covelRegistry`）。

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
Turn 执行 → 各 Runtime 按 stage 屏障 + stage 内 DAG 运行
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
