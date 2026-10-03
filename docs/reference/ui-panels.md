# 前端面板架构

文中的 DashScope / OpenAI 生图和 MiMo TTS 由 [官方社区插件仓库](https://github.com/covel-ai/covel-plugins) 提供，需安装并在会话中授权后才会注册对应工具和 UI。

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

## 跨页面导航

`/session?sid=<sessionId>&panel=plugins|images` 可携带一次性的面板打开请求。
会话恢复和 `GameView` 挂载完成后消费请求并清理 `panel` 参数；图像或插件面板请求
保留在移动端抽屉之外，等抽屉与异步 UI spec 准备好后再选择目标。会话 ID 改变时
重建会话视图，避免草稿、面板选择与上一个会话混用。调试页按 URL 中的 `sid`
切换数据，从调试页返回会话时同样以当前查看的 ID 为准。

## 右侧面板（Plugin-Driven）

### 设计原则

- **插件状态面板由 `ui.right` 声明**，与框架提供的世界文档、数据库入口共同显示；Lorebook 只有 HTTP API，见下方「世界文档」章节后的说明。
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

> 不带 `sessionId` 的请求返回 registry 快照中的全部插件（用于 boot/debug）。`right-panel.tsx` 在 session 切换时会清空状态并以新 sessionId 重新拉取，避免跨会话的 Tab 残留。

切换会话时同时重置所选分组、子面板及其本地 UI 状态。插件数据加载带有目标 sessionId，旧会话响应不能写入当前会话。所选插件分组移除后回到世界文档；纵向导航可独立滚动，窄屏弹层同样支持长面板列表。

数据库面板的手动刷新、失败重试与状态事件触发的自动刷新共用请求生命周期。会话或刷新版本变化后，旧请求返回的数据和错误均被忽略，也不能修改当前请求的加载状态。

### 当前注册的面板

| 插件/runtime                                                             | 面板 ID             | 图标               | group         | 数据 namespace     | 描述                                                                                             |
| ------------------------------------------------------------------------ | ------------------- | ------------------ | ------------- | ------------------ | ------------------------------------------------------------------------------------------------ |
| affinity                                                                 | affinity            | heart              | affinity      | affinity           | 好感度面板（玩家↔NPC score 双向条 + tier 徽标 + 最近变化原因）                                   |
| char-creator/player-init                                                 | character           | users              | character     | session.characters | 角色列表（类型由当前角色 schema 定义）                                                           |
| character-blueprint/import                                               | character-blueprint | id-card            | character     | blueprints         | 预设角色（世界作者预置的登场角色模板，只读；作为 `character` 组的子 Tab）                        |
| character-blueprint/presence                                             | character-presence  | image              | character-art | presence           | 角色立绘画廊（`PortraitGallery`，只读展示 + 玩家可上传替换头像）                                 |
| codex                                                                    | codex               | book-open          | codex         | entries            | 知识图鉴                                                                                         |
| core-quest                                                               | core-quest          | scroll-text        | core-quest    | quests             | 任务日志（进行中含 objectives 勾选清单 / 已完成 / 已失败 分组）                                  |
| dice-check/recorder                                                      | dice-check-panel    | dices              | （无）        | checks             | 判定记录（倒序 🎲 回执列表：骰式 / 成败配色 / critical 强调）                                    |
| inventory                                                                | inventory           | backpack           | inventory     | items              | 行囊（已装备分组 + 背包列表，数量徽标 + tags pill，`alwaysRender`）                              |
| dashscope-image-gen/image-generator · openai-image-gen/image-generator   | `<plugin>-gallery`  | image              | image-studio  | images             | 剧情插图画廊（`ImageGallery`，`alwaysRender`）；两个图像插件各一套，合并进同一 `image-studio` 组 |
| dashscope-image-gen/image-generator · openai-image-gen/image-generator   | `<plugin>-jobs`     | loader             | image-studio  | \_jobs             | 生成任务视图（`ImageJobs`，`alwaysRender`）                                                      |
| dashscope-image-gen/prompt-generator · openai-image-gen/prompt-generator | `<plugin>-trigger`  | wand               | image-studio  | （无）             | 「生成图片」manual 触发入口按钮（`expectsBackgroundFollower`，`alwaysRender`）                   |
| mimo-tts/auto-narrate                                                    | mimo-tts-audio-tab  | headphones         | tts-studio    | tracks             | 旁白语音 playlist（`AudioPlayer`，`alwaysRender`）                                               |
| living-world-rules                                                       | living-world-rules  | book-marked        | world-data    | rules              | 世界规则（长期设定 / 禁忌，只读；随 world-data 导入播种，作为 `world-data` 组的子 Tab）          |
| memory                                                                   | memory              | brain              | memory        | blocks             | 记忆插件在脱离回合的 post-turn function runtime 中更新自己的记忆块并展示                         |
| npc-graph/extractor                                                      | npc-graph           | network            | npc-graph     | nodes + edges      | NPC 关系图（force-directed 可视化）                                                              |
| scene-stage/resolver                                                     | scene-stage         | image              | scene-stage   | stage              | 当前场景舞台（只读）：场景名 + 昼夜徽标 + `sourceLabel` 状态文案（未命中注册表时"无背景"）       |
| scene-stage/cast                                                         | scene-cast          | users-round        | scene-stage   | active-cast        | 当前场景在场角色（只读，仅 name + role；内部选择信号留在 plugin_data）                           |
| world-init/schema-gen                                                    | world-overview      | map                | world-data    | session.dimensions | 任意维度当前值、版本、编辑及待结算恢复                                                           |
| world-init/schema-gen                                                    | world-schema        | sliders-horizontal | world-data    | schema             | 角色属性 schema                                                                                  |

> `world-data` 组（groupLabel "世界资料"）汇聚三个 spec：`world-init` 的 `world-overview` / `world-schema`，以及 `living-world-rules` 的 `living-world-rules`（世界规则）。合并为单个 activity-bar tab，内部横向子 Tab 在总览 / 属性 / 世界规则之间切换。总览的 `WorldDimensions` 直接读取公开会话当前值，不从 `entries` 或世界初值拼装；维度不再双写 constant lorebook。
> `character` 组汇聚 `char-creator` 的 character-panel（从会话 World Model 的 `session.characters` 读取活角色）与 `character-blueprint` 的预设角色面板（世界作者预置的登场角色模板，只读）。前者是当前存档的活状态，后者是导入的只读源；角色创建或导入经 World Model 写入，不依靠跨插件角色镜像。
> `npc-graph/extractor` 的 npc-graph-panel 通过 `dataSource.bindings` 把自身 `nodes` + `edges` 两个 namespace 注入面板状态，再作为 props 传给 `GraphCanvas` 呈现关系图（react-force-graph-2d 懒加载）。
> `memory` 包注册 `prompt.segment@1`、`memory.block-definitions@1` 服务和右侧面板。`runtimes/extract/RUNTIME.md` 消费冻结的 `turn-digest@1`，以 `settle: before-next-execution` 的脱离回合任务更新本插件 `blocks` namespace。面板直接读取这些块；提示词片段位于缓存边界之后。禁用该插件的会话不运行提取、不等待它的任务，也不注入其记忆。

### 动态维度总览与修正

`WorldDimensions` 由通用 `SessionDimensionsPanel` 接入 session snapshot 的 `dimensions`、`dimensionSettlements` 与受信 provider/recovery 元数据，不按维度 ID 分支。公共项为 `{name,description?,schema,value,version}`；显示名称、稳定 ID 和值版本，不展示初值或维护规则。

- 标量直接显示；object 按字段展示，数组或动态命名 object 的记录可按 schema properties 呈现为行和列，列标题使用 `title` 或字段名。
- 基础 schema 支持字段编辑及数组/命名记录的增删；复杂嵌套值提供明确 JSON 编辑入口。客户端与提交边界共用 `validateDimensionValue`，缺值、可空值、范围错误不靠类型强转修复。`x-i18n` 节点按 locale 展示，普通 JSON 不猜翻译。
- 保存携带编辑开始时的 `expectedVersion`，通过 host 指定的 `editorRuntimeId` 发 runtime RPC，不绕过保留 namespace 写入。冲突刷新当前值并显示错误，玩家检查后重新提交，不静默覆盖。
- pending 卡显示源逻辑回合及失败原因，提供重试、明确人工处理、明确跳过。重试直接调用 `trackerRuntimeId` 并带回执 `sourceTurnId`；后两者由 editor 针对 `source.resultId` 写终态。普通保存值不解除 pending。
- 回合执行或请求处理中编辑按钮禁用；操作后重新取 session view，检查已提交值与回执，不把 runtime 的 `submitted` 当作落库凭据。没有受信恢复入口时只读，不回退到作者初值。

世界作者编辑器编辑的是完整开放 definition map，允许任意合法 ID，九类题材结构只是可选模板；游戏面板编辑的是会话当前值，不能新建 definition 或修改 schema。原始声明格式、开发数据重建要求及恢复调用见 [World Data](world-data.md#动态世界维度dimensions) 和 [API](api.md#维度编辑与待结算恢复)。本期没有隐藏事件的触发/载荷编辑器（#97）。

### 世界文档（框架自持 Tab）

`世界` 是 activity bar 中**框架自持**的 Tab，与插件驱动的 Tab 并列但不受 `/api/ui-specs` 影响：

- **数据源**：当前 session 的 `WorldRecord.lore`（即 `worlds/<id>/WORLD.md`，按 `defaultLocale` 解析 exact locale → script 兼容主语言 → canonical `WORLD.md`），由 `world-seed-loader` 在启动时写入 store。
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
- `icon` — 框架允许列表内的 Lucide 图标名（kebab-case）；完整列表见
  [UI Components / Display](ui-components.md#display)
- `dataSource.namespace` — 从 `pluginData[pluginId][namespace]` 读取数据。`_jobs` 是框架虚拟源：数据为该插件后台手动/事件任务（由 `_runtime_jobs` 映射），以 jobId 为键，值含 `status`（`pending` / `done` / `failed`）、`runtimeId`、`turnId`、`startedAt`、`completedAt`、`durationMs`、`message`、`error`、`reason`、`runtimeResults`、`deferredJobs`。`message` 只出现在以 `expectsBackgroundFollower` 排队的 prompt 生成任务上：进行中为「正在生成图像 Prompt」，排入 follower 后为「图像任务已入队」，按玩家语言显示
- `dataSource.bindings` — 可选的至多 8 个具名自有 namespace 绑定，例如 `{ "nodes": "characters", "edges": "relations" }`；面板在 `/sources/nodes`、`/sources/edges` 暴露其当前会话数据供 `$state` 引用。名称与 namespace 必须为字面量，无法指定其他插件；切换会话时这些值随数据源刷新，缺失的 namespace 为空对象。主 `namespace` 仍决定普通面板数据和空态。
- `emptyState.message` — 数据为空时显示的提示文字（见下方"空状态渲染"章节）
- `view` — json-render nested spec，使用框架 catalog 中的组件。当前 Web UI 只执行这类声明式 spec；`.tsx`、`.js` 等非 JSON UI 声明不受支持，API 会给出对应诊断并剔除该项

### Spec 校验与版本

`/api/ui-specs` 聚合时对每个 spec 执行 Zod 校验（结构包络 + `specVersion`），spec 是**不可信的插件输入**：

- `specVersion` 可省略（按 v1 处理）。声明高于服务端支持版本（当前 `CURRENT_UI_SPEC_VERSION = 1`，见 `apps/server/src/routes/misc-api/ui-spec-schema.ts`）会被拒绝，旧服务端遇到新插件包时显式报错而非渲染坏面板。
- 每个 spec 必须声明 `view`（对象）或 `webview`（HTML 文档），两者互斥，否则校验失败。
- `view` 会递归校验 `component` / `type`、`children`、命名 `slots`、`repeat` 与 `on` / `watch` action binding 包络。组件名必须来自共享的 `PLUGIN_UI_COMPONENT_NAMES`；未知组件在服务端即产生带路径的诊断。`props` 和 directive 表达式保持开放，由组件和 json-render 在运行时解析，以便插件扩展数据形状。
- loader 用 `_componentPath` 保留非 JSON 声明的位置，以便 API 返回具体诊断；它不是有效 UI spec，也不是 Web 插件执行入口。含该字段的 spec 会被剔除，即使同时声明了 `view`。需要自定义组件时，可声明 `webview.entry` 并提供独立 HTML；也可组合 catalog 组件并绑定 framework action。浏览器不直接导入插件 `.tsx` / `.js` 模块。同一插件的其它合法 JSON spec 继续显示。
- **单个坏 spec 不污染整个响应**：校验失败的 spec 从对应 slot 中剔除，并在响应顶层 `diagnostics[]` 中给出具体诊断（`{ pluginId, runtimeId, slot, specIndex, specId?, issues[{ path, message, code }] }`）——指明哪个插件、哪个字段、什么问题，而非泛泛的 "Invalid panel spec"。
- 前端（`right-panel.tsx`）在 dev 模式下把这些诊断打到 console；`plugin-panel.tsx` 的本地兜底消息也会带上 spec 名与具体原因（缺 `view` / `view` 非对象 / 转换失败）。

UI 声明来自启动时 registry 快照，静态资源惰性加载并按快照缓存。GET 只做读取与会话激活集过滤，不扫描插件目录，也不向 `plugin_data` 物化 UI 定义（详见 [api.md](./api.md#get-apiui-specs)）。

静态资源读取会校验符号链接解析后的真实路径：允许指向插件根目录内的链接，拒绝指向根目录外的文件或目录。资源加载失败时跳过对应 runtime 的 UI，不影响其他 runtime 的面板。

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

**消息格式**：必须使用 I18nText 对象（目标 locale + English fallback；中文可选）；见下方「插件 UI 文本 I18nText 规范」：

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
| `memory-panel.json`    | 记忆插件首轮提取前尚无记忆块                              |
| `npc-graph-panel.json` | 尚未识别到角色或势力关系，narrator 推进剧情后将自动浮现…… |
| `world-schema.json`    | 角色属性定义尚未生成，等待世界初始化……                    |

**`alwaysRender: true` 豁免**：spec 顶层声明 `"alwaysRender": true`（或 `view.component` 是 `ImageGallery` / `ImageJobs`，由 `specUsesComponent` 隐式判定）的 panel 不依赖 namespace 数据渲染——例如 `world-overview.json` 的 `WorldDimensions` 直接读 session 上下文，`gallery.json` / `jobs.json` 的 `ImageGallery` / `ImageJobs` 自行处理空态。这类 spec **可省略 `emptyState.message`**：前端 `PluginPanel` 根本不会进入空态分支。

**实现位置**：`apps/web/src/components/session/plugin-panel.tsx` 的 `PluginPanel` 组件（`isEmpty` 判断与 `alwaysRender` 短路）。

### 插件 UI 文本 I18nText 规范

**所有**面向用户的 UI 字符串（`label` / `groupLabel` / `shortLabel` / `emptyState.message` / `searchPlaceholder` / `emptyMessage` / `footer` 以及 json-render spec 内 `Text/Button/Badge/FormField/Alert/...` 的 `content` / `label` / `placeholder` / `title` / `message`）必须使用 `I18nText` 对象：

```ts
type I18nText = string | Record<LocaleTag, string>;
```

- 合法 locale key 使用 BCP 47 风格，例如 `zh`、`en-US`、`ru-RU`、`sr-Latn`、`zh-Hant-TW`。统一解析契约和完整回退顺序见 [Internationalization](./i18n.md)；组件不得自行判断 locale。
- **必须提供 English fallback**：目标 locale 可以是 `zh`、`ru` 或其他语言；中文不再是必需项。
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

**框架端解析器**：`resolveI18n(value, locale?)` 与 `useI18nResolver()` 由 `apps/web/src/lib/catalog/helpers.tsx` 导出，渲染器直接从该模块导入。所有内置 ComponentRenderer 已调用 hook 订阅 locale 变更；切语言时 json-render 子树会自动重渲染。

**验证**：`pnpm check:i18n` 会同时跑 `check-no-chinese-literal`（应用代码）与 `check-plugin-i18n`（插件 JSON）两套扫描。

### json-render 绑定速查

| 需求                   | 写法                                                                                      |
| ---------------------- | ----------------------------------------------------------------------------------------- |
| 读状态                 | `{ "$state": "/path" }`                                                                   |
| 读写状态               | `{ "$bindState": "/path" }`                                                               |
| 迭代状态数组           | `repeat: { "statePath": "/path", "key": "id" }`（元素顶层字段，**非 props**）             |
| 在 repeat 内迭代子数组 | `repeat: { "statePath": { "$item": "items" }, "key": "id" }`                              |
| 读当前 item 字段       | `{ "$item": "field" }`（字段名不带前导斜杠）                                              |
| 读写当前 item 字段     | `{ "$bindItem": "field" }`                                                                |
| 当前 index             | `{ "$index": true }`                                                                      |
| 命名插槽               | `"slots": { "header": [{ "component": "Text" }], "content": [{ "component": "Stack" }] }` |
| 数值/文本动态处理      | `{ "$math": "add", "a": 1, "b": 2 }`、`{ "$concat": ["HP ", { "$state": "/hp" }] }`       |

> ⚠️ `repeat.statePath` 接受绝对状态路径字符串，或嵌套 repeat 中的 `{ "$item": "field" }`；它不是 `{ "$state": ... }`。item 字段名不能带前导斜杠（`$item: "key"` ✓，`$item: "/key"` ✗）。

面板按前后两次外部数据快照的差异同步状态。删除的字段与数组缩短后失效的派生索引会清空，空对象会保留；`/_invoking` 和 `/sources` 整体替换，因此调用结束后按钮恢复可用。外部值未变化的字段保留 `$bindState` 本地编辑，未被外部数据占用的草稿字段也会保留；切换面板后复用缓存仍遵循这一规则。状态路径使用 JSON Pointer 转义，字段名中的 `~` 写为 `~0`，`/` 写为 `~1`。

数组（包括自动生成的 `/entries`）按外部内容判断变化：内容相同的新数组保留已有本地编辑，真实内容或顺序变化时整体替换。递归比较最多检查 32 层；在此范围内无法确认相同的深层子树按变化处理，保持遍历成本有界。对象中的数字字段名仍按对象键处理，不会被隐式转换为数组索引。

按钮的选中态和调用中状态随 action 动态参数读取的最新状态更新。面板交互锁定时，JSON 渲染区域不可通过鼠标或键盘操作，action handler 也会检查锁定状态，避免已保留的回调绕过界面锁定。

### 标准 directives

所有框架持有的 json-render Provider（右侧插件面板、插件消息面和 turn-bound 消息块）共享同一组 directives。directive 可以写在组件 props 的任意动态值位置，也可以写在 `on.<event>.params` 中；因此按钮与输入框触发的 action 会得到和显示内容一致的解析结果。

| Directive    | 用途                                      |
| ------------ | ----------------------------------------- |
| `$format`    | number / date / currency / percent 格式化 |
| `$math`      | 加减乘除、取模、min/max、取整和绝对值     |
| `$concat`    | 拼接多个动态值                            |
| `$count`     | 获取字符串或数组长度                      |
| `$truncate`  | 截断文本                                  |
| `$pluralize` | 按数量选择 zero / one / other 文案        |
| `$join`      | 连接数组元素                              |

`$t` 暂不开放。插件自然语言继续使用 `I18nText`，避免与现有 i18next locale 资源形成两套翻译源。

```json
{
  "component": "Button",
  "props": {
    "label": { "$concat": ["Items: ", { "$count": { "$state": "/entries" } }] }
  },
  "on": {
    "click": {
      "action": "invokeCommand",
      "params": {
        "command": "bag",
        "args": {
          "pageSize": { "$math": "max", "a": 1, "b": { "$state": "/pageSize" } }
        }
      }
    }
  }
}
```

### 开发调试

开发构建只在当前激活的右侧插件面板挂载 json-render Devtools。按 `Cmd/Ctrl+Shift+J` 打开 Spec、State、Actions、Stream 和 Pick 调试面板；切换右侧子面板后检查目标也随之切换。消息流里的 surface 不挂 Devtools，避免多个实例争用快捷键。Devtools 通过开发环境动态 import 加载，不进入生产构建。

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

子面板选择和渲染状态以 `(pluginId, spec.id)` 标识，重新排序时保持选中同一个面板；所选面板移除后回到该组首项。不同插件可以使用相同 `spec.id`，不会共享本地 UI 状态。

## 消息区（Message Area）

### 两条渲染链路

当前消息区有两条并行链路：

1. **Turn message 链路**：`chat-messages.tsx` 读取 `turn_messages` / SSE 事件，经 `messageToSpec()` 转成 json-render spec，由 `MessageBlockRenderer` 渲染；具体 block/primitives 拆在 `apps/web/src/components/session/chat-messages/`
2. **Plugin message 链路**：同一文件在 `block.type === "plugin_message"` 分支里，通过 `/api/ui-specs?sessionId=` 发现 `ui.message`，再用 `PluginPanel` + `plugin_data` 渲染插件消息面

两条链路都使用同一套 json-render catalog。

解析视图（`parsed`）下，每回合的只读插件卡片（`ui.render`、`ui-spec`，以及 level 为 info/success 的通知，例如图鉴发现、成就和状态变更）会合并成一条默认折叠的「本回合更新 · N 项」，摘要里预览前三个卡片标题，让叙事占据主要版面。表单、选项、确认、建议块（`plugin_message`）、图片和警告/错误通知不折叠。玩家可在设置「通用」中打开 `ui.expandTurnUpdates` 改为默认展开；`detailed` / `raw` 视图不折叠。实现见 `apps/web/src/components/session/chat-messages/turn-updates.tsx`。

| 链路           | 当前承载内容                                                                                                                                   | 实现位置                                                                                              |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Turn message   | 叙事文本、玩家输入、`interaction.requested` 表单/选择、通知                                                                                    | `apps/web/src/components/session/chat-messages.tsx`, `apps/web/src/components/session/chat-messages/` |
| Plugin message | guide 建议卡、codex 本轮摘要、dice-check 🎲 判定结果块、core-quest 任务变更块、affinity 好感 toast、inventory 得失 toast、其他插件自定义消息面 | `apps/web/src/components/session/chat-messages.tsx`（`plugin_message` 分支）                          |

### 消息 Block 声明

插件通过 `ui.message` 声明消息区 block 的渲染方式：

```yaml
ui:
  message:
    - ./ui/guide-block.json
```

> **Bootstrap 注意（重要）**：`ui.message` block 只有在其声明的 `message` namespace 被写入数据后才会渲染。因此一个**只能由 block 内部按钮触发的纯手动写入者无法自举**——首屏没有数据，block 不出现，按钮也就永远点不到（典型死锁：`branch-reply` 早期即如此完全不显示）。让 block 首次出现的写入必须来自一个**非手动**路径：`scheduled` / `auto` runtime（读取叙事引擎输出后播种）、上游 runtime 的 `plugin.data` 提案，或 world-data 导入。`branch-reply` 用 `trigger: auto`（`stage: post-turn`，叙事引擎之后）播种 candidate[0]，详见 [plugins.md § 代表性实现](./plugins.md#代表性实现)。

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
  → `ui.message` 渲染情境回顾、当前决策与 3–6 条短句（舞台模式同时经 `stage.choices@1` 显示）
  → 玩家点击建议后进入待发送区
  → InputBar 统一发送待发送草稿与手写输入
```

## 舞台模式（Stage View）

`viewMode: "stage"` 是消息区之外的第四个呈现档（与 `parsed` / `detailed` / `raw` 并列，头部 `GameViewHeader` 的 Toggle 切换）。它把消息区三件（`ChatMessages` + `PendingDraftsBar` + `MessageComposer`）整体替换成全屏舞台（视觉小说式：场景背景 + 立绘 + 打字机对话框），`GameViewHeader` 保留。

- **渲染条件**：`viewMode === "stage" && (session.phase === "playing" || hasSubmittedForm(...))`。角色创建表单仍在原消息流完成；提交后立即进入舞台，并在首段叙事到达前显示生成状态。
- **初值**：世界包 `world.yaml` 顶层 `defaultViewMode: stage`（→ `WorldRecord.metadata.defaultViewMode`）让会话**首挂载**即进舞台；玩家在头部切换后以玩家选择为准（无持久化）。见 [world-data.md](./world-data.md#world-package)。

### 层级与数据源

五层绝对定位、`z-index` 分档，DOM 顺序 Backdrop → Sprites → Hud → Dialog → Choices，全部套在一个 `relative` 有界容器里。舞台消费服务端 `ui.slot@1` 投影；提供者从各自数据、领域事件和 World Model 构造通用槽位，前端不按插件 namespace 拼接舞台：

| 层           | 数据源                                                 | 前端用途                                         |
| ------------ | ------------------------------------------------------ | ------------------------------------------------ |
| **Backdrop** | `stage.backdrop@1`                                     | 展示背景、场景名称和状态；缺图时使用世界视觉回退 |
| **Sprites**  | `stage.cast@1` 与按角色 ID 索引的 `character.visual@1` | 站位、高亮、立绘与无图时的占位                   |
| **Hud**      | `stage.backdrop@1`                                     | 展示名称、变体和来源状态                         |
| **Dialog**   | 最新 story 正文与 `stage.dialogue@1`                   | 打字、段落切分和逐段署名                         |
| **Choices**  | `stage.choices@1` 与待提交 interaction choice block    | 情境回顾、决策问题、选项与自由输入               |

“流式中”判定沿用内核约定——无 streaming 布尔，`executing && story 消息 id 以 stream_ 开头`。新叙事由 `StageDialog` 打字展示，逐段暂停等待点击；最后一段读完同样停一次等收尾点击（自动播放按停顿计时自动推进，正文尾部空段落不产生空白暂停），不会在打字追上流结束时自动跳到决策面板。读完且回合执行结束后，同一位置切换为统一决策面板，依次显示场景、“当前信息”摘要、“现在需要决定”的问题、分组选项和行内自由输入。提交后立即隐藏整个旧决策面板，包括插件扩展区域；等待新叙事时显示生成状态，不重播已读的旧叙事。恢复会话或从其他视图切入时，挂载前已经存在的最新叙事视为已读，不会重新打字。旧版行动建议行没有 `recap/decision` 时，面板从最新 story 提取最多三句、180 字符的情境回顾，并用 `scene` 生成带上下文的决策问题；新数据始终优先使用 agent 生成字段。

舞台槽位在当前执行中可接收预览事件，提交后由服务端重算并缓存；会话恢复时重新读取已提交槽位。`watch` 仅监听提供者自己的 namespace，预览失败或取消时丢弃，不把私有插件数据直接交给舞台。

服务端槽位缓存按最近使用顺序保留最多 256 个会话。正在处理请求、排队投影或分发事件的会话不会被淘汰；并发期间允许暂时超过上限，工作结束后回收闲置条目。单次读取在释放会话状态前取得结果，缓存淘汰不会使已成功的投影返回空结果。

`stage.cast@1` 中演员的可选 `active` 标记控制立绘高亮。只要有演员明确指定该标记，就按各自的布尔值显示；全部省略时默认高亮第一位未退场的演员。

对白名牌读取当前回合 `dialogue/<turnId>.paragraphSpeakers`，由 `stage.direction` 显式提供角色 ID 并解析为 `{ characterId, displayName } | null`。同回合实时事件可以先行预览，旧的已提交映射不会在同回合重试的流式阶段复用。打字机与署名校验共用 `splitStageParagraphs`（CRLF 转 LF，三个以上换行视为一个空行分隔）；正文结束后的分段数量必须和映射一致。旁白、未知身份、旧消息无映射或回合不匹配时不显示人物名牌，演员焦点不参与署名。

决策面板在窄屏最多占舞台下方 60%，宽屏为 65%，始终在舞台范围内。回顾默认折叠、点击“当前信息”可展开；回顾、问题和选项共用可滚动内容区，自由输入保持固定可见。立绘底部渐隐，窄屏提高站位以让脸部露出决策面板，宽屏保留原有站位高度；有角色图时不重复叠加名字徽标，缺图时保留姓名占位。

### 背景回退链（`resolveBackdrop`）

输入直接是 `stage.backdrop@1` 槽位值，符合 `stageBackdropSchema`；`label` 供状态文案展示，不控制回退。

| 档         | 触发                     | 表现                                 |
| ---------- | ------------------------ | ------------------------------------ |
| `scene`    | 槽位 `ref` 是 `MediaRef` | 渲染场景图（换图 600ms crossfade）   |
| `hero`     | 槽位缺失，或无有效 `ref` | 世界头图（`worldVisual().image`）    |
| `gradient` | 理论兜底                 | 世界 accent 渐变（选择器当前不返回） |

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

### Gameplay completion and reading order

Story messages precede same-turn plugin message surfaces even when streaming or hydration delivers the surface first. Message order uses turn attribution, not client timestamps. Execution failures remain visible after the task chips collapse, with the affected runtime and its existing retry action. A partially completed turn must not be presented as a clean completion.

The story composer can submit queued selections without additional text. Both the main send button and the selection bar combine queued actions with typed text. Rejected interaction RPCs keep the form editable and never fall back to sending its fields as an unvalidated story message.

Responsive panel resize callbacks use the supplied dimensions, avoiding imperative constraint queries during panel registration changes. Typography uses active theme tokens for both light and dark prose.

## 插件自带组件与舞台挂载

JSON spec 支持与 `view` 互斥的 `webview: { entry: "./widget.html", height: 280 }`。`ui.right` spec 可声明 `surfaces: ["panel", "stage"]`，缺省仅显示右侧面板。HTML 使用双层 opaque-origin sandbox iframe；可信外层的 CSP 禁止插件文档向网络地址自行导航，端口仅转交一次。内层保留内联脚本与 `window.covel` 数据/动作桥，组件代码和业务状态结构属于插件。完整协议、资源限制与示例见 [插件扩展契约](plugin-extensions.md#自定义组件与挂载)。

## Kernel UI slots

Plugins declare `contributes.extensions` providers for `ui.slot@1` and register
handlers from their server entry. `slot` selects `stage.backdrop@1`,
`stage.cast@1`, `stage.dialogue@1`, `stage.choices@1`, or `character.visual@1`.
Providers compose in declared order, then plugin/provider ID order. Handlers
receive `{ slot, previous, events }`, own scoped `ctx.pluginData`, and the kernel
`ctx.world` view. The host validates each provider output against its slot model.
A failing provider is skipped; it cannot replace the previous valid value.

`watch` lists the provider's own namespaces. Their commits invalidate projections
with a 50 ms debounce. `preview` lists validated domain-event topics that the
provider can project before commit. Previews are ephemeral, scoped to the turn,
and discarded on completion, failure, or cancellation. They never replace the
committed cache. Late results after a terminal event are discarded.

Character visual providers return `{ characters: CharacterVisualModel[] }`,
including imported art before characters are created. Providers normalize IDs;
the host emits one keyed `character.visual@1` snapshot per `characterId`.
Front-end consumers join exact keys and do not infer plugin namespaces or ID
suffixes. The stage, avatar, portrait gallery, and cast list read these slots.

Panel data bindings and action `pluginId` fields may reference only the owning
plugin. The loader rejects foreign or dynamic plugin targets. Use kernel slots
or World Model for data shared between plugins. A component that reads kernel
data before its namespace has records must set `alwaysRender: true`.
