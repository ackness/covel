# 前端面板架构

这一页讲会话界面里“插件的东西显示在哪、怎么显示”：右侧面板、聊天消息里的插件卡片、舞台模式，以及顶部的状态显示。写插件界面的人、维护前端的人需要它。

基本做法只有一条：插件用一份 JSON 描述界面（下文叫 **UI spec**），框架负责发现它、把数据接上去并画出来。插件不写 React 代码。

- 每个组件叫什么、有哪些属性，见[组件目录](./ui-components.md)。
- 怎样动手写一个面板，见[插件界面](../plugins/ui.md)。

> [!NOTE]
> 文中的 DashScope / OpenAI 生图和 MiMo TTS 来自[官方社区插件仓库](https://github.com/covel-ai/covel-plugins)。安装并在会话中授权后，它们的工具和界面才会出现。

## 架构总览

```
┌─────────────────────────────────────────────────────────────────┐
│  Header: Session ID | Phase | Execution Status                  │
├──────────────────────────┬──────────────────┬───────────────────┤
│  Center: Message Area    │                  │  Right: Plugin    │
│  ────────────────────    │                  │  Panels           │
│                          │                  │  ──────────       │
│  - Turn messages         │                  │  vertical bar     │
│  - Plugin message surface│                  │  ┌──┐             │
│  - Prose / Form / Alert  │                  │  │  │ World       │
│  - Guide / Codex         │                  │  │  │ Character   │
│                          │                  │  │  │ World Data  │
│                          │                  │  │..│ (more)      │
│                          │                  │  └──┘             │
│  Player Input            │                  │  Panel Content    │
│  [输入你的行动...]  [→]  │                  │  (json-render)    │
└──────────────────────────┴──────────────────┴───────────────────┘
```

图里的导航位置和右侧的纵向图标条是 `classic` 布局的样子。主题包可以用 `layout` 改变这些结构：左侧图标导航、文字页签、场景图铺满会话区等，见[主题包 §3.1](./theme-packages.md#31-布局预设layout)。

布局只改变摆放位置。面板怎样被发现、分组、排序，数据怎样流动，都不随布局变化：插件声明一次 `ui.right` / `ui.message`，在每种布局下都按同一份 spec 渲染。

## 会话工具条、玩家状态与场景 HUD

会话顶部的工具条和状态显示只用内核自己的数据，不读任何插件的数据。所以它对每个世界都成立；某项没有数据时，对应的部分不显示。

| 显示内容             | 数据来源                                                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 世界名、回合数       | `WorldRecord.name`、`SessionRecord.completedPlayerTurns`                                                                                         |
| 当前场景名           | `stage.backdrop@1` 槽位的 `name`                                                                                                                 |
| 玩家状态量表         | 会话 World Model：`type: "player"` 的角色记录，加角色 schema 里 `category: "stats"`、`type: "number"` 且同时声明 `min` / `max` 的属性；最多 4 项 |
| 随身物品             | 同一条玩家角色记录里，角色 schema 中 `category: "equipment"`、`type: "array"` 的属性的字符串项，按 schema 顺序合并                               |
| 在场角色（场景 HUD） | `stage.cast@1` 的未退场演员（最多 3 位）与按角色 ID 取的 `character.visual@1` 头像；没有图时只显示名字                                           |
| “正在说话”标记       | `stage.dialogue@1` 的 `paragraphSpeakers` 里最后一个有署名的段落；名字与在场演员的 `displayName` 相同才显示                                      |
| 章节横幅             | `backdrop: "banner"` 的布局里，世界头图、世界名和前三个标签，放在第一条消息上方                                                                  |
| 状态摘要             | `session.summary@1` 槽位：任何插件都可以提供的几行“一眼就该看到”的内容（当前目标、时间、行囊），见下方 [Session summary](#session-summary)       |

这些内容放在哪：

- `panelTabs: "bar"` 的布局里，玩家名、状态量表和随身物品固定在右侧面板页签的下方。
- `backdrop: "scene"` 的布局里，它们和在场角色一起叠在场景图的左下角，这块叫场景 HUD。
- 场景 HUD 需要会话区够宽（约 66rem）。不够宽时它让位给故事栏，状态改由右侧面板显示。两处不会同时出现。
- `backdrop: "scene"` 且有场景名时，工具条把场景名作为大标题，世界名和回合数缩成它上方的一行。

世界作者和插件作者怎样让内容出现在这里：

- 想让一个数值显示成量表：在角色 schema 里把它声明为带范围的 `stats` 属性。没有声明范围的 `stats` 数值显示成一行数字，最多 4 项。
- 想让物品出现在随身物品里：把它声明为 `equipment` 类的字符串数组。
- 以上两种都不需要写插件界面。
- 插件自己的数据（任务、行囊、时间）不进角色记录。它们通过 `session.summary@1` 槽位出现在同一个位置。

工具条右侧依次是“文本 / 舞台”切换、设置、“更多”菜单和右侧面板开关。详情视图、原始视图、工作室配置、返回配置页和调试追踪收在“更多”里。

## 跨页面导航

别的页面可以带一个参数跳进会话，并要求打开某个面板：

```text
/session?sid=<sessionId>&panel=plugins|images
```

- 这个请求只用一次。会话恢复、`GameView` 挂载完成后，页面处理请求并把 `panel` 参数从地址里去掉。
- 在手机上，请求不会被抽屉吞掉：页面等抽屉和异步加载的 UI spec 都准备好，再选中目标面板。
- 会话 ID 变了，会话视图整个重建。这样草稿和面板选择不会和上一个会话混在一起。
- 调试页按地址里的 `sid` 切换数据。从调试页返回会话时，也以当前查看的 ID 为准。

## 右侧面板（Plugin-Driven）

右侧面板是插件展示状态的主要位置。先说几条玩家能直接看到的行为：

- 页签、spec 和交互状态由会话视图保存。手机上关掉抽屉再打开，状态还在。
- 加载失败时显示错误和重试入口，之前成功读到的面板保留。
- 历史回合里的只读插件卡片只在展开时才挂载。
- 执行状态会显示一个 runtime 被跳过的原因。订阅断线后可以手动重试。一次普通的 action 流结束后恢复后台订阅，不算网络重连。
- 执行步骤的本地显示缓存把 250ms 内的更新合并成一次，最多保留最近 500 行，离开会话时保存还没写入的内容。真正的恢复仍以服务端的执行记录为准。
- 选中项、字体、菜单或容器尺寸变化后，页签条保持当前页签可见。横向文字页签居中显示；纵向图标条只滚动到刚好露出选中项。

### 设计原则

- **插件的状态面板由 `ui.right` 声明。** 它们和框架自带的“世界”文档入口一起显示。原始的“数据库”页签只在打开开发者视图后出现，见下文。Lorebook 只有 HTTP API，见[世界文档](#世界文档框架自持-tab)一节末尾的说明。
- **框架不认识具体插件。** 它通过 `/api/ui-specs` 发现面板。
- **用 json-render 渲染。** 插件提供 JSON spec，框架提供一套固定的组件（catalog）。
- **数据来自 pluginData。** 插件数据变了，服务端发 `plugin-data.changed` SSE 事件，面板随之更新。

### 面板发现流程

```
session 建立 → GET /api/ui-specs?sessionId=<id>
  → server 按会话激活集（session plugin scope）过滤
  → { right: [...], message: [...], left: [...] }
  → 按 right[] 动态生成 Tab（icon + label）
  → 每个 Tab 对应一个 json-render Renderer
  → pluginData[pluginId][namespace] 注入为 state
```

> [!NOTE]
> 不带 `sessionId` 的请求返回注册表快照里的全部插件，用于启动和调试。`right-panel.tsx` 在切换会话时清空状态，并用新的 sessionId 重新拉取，所以不会留下上一个会话的页签。

切换会话时还会发生这些事：

- 所选分组、子面板和它们的本地界面状态一起重置。
- 插件数据的加载带着目标 sessionId，旧会话的响应写不进当前会话。
- 所选的插件分组被移除后，回到“世界”文档。
- 纵向导航可以独立滚动，窄屏的弹层也能容纳很长的面板列表。

**数据库页签是开发者视图。** 它按表原样列出每一行公开的插件数据，其中包括只写给叙述者看的内容，例如角色卡里的秘密。所以它默认不在游玩界面出现。

- 玩家在设置的“通用”里打开“开发者视图”（`ui.developerView`，默认关闭）后，右侧面板多出“数据库”页签。
- 关闭后页签和内容一起移除，`open-database` 导航请求回到“世界”文档。
- `/debug` 页始终提供完整视图。

数据库面板的手动刷新、失败重试和由状态事件触发的自动刷新共用一套请求生命周期。会话或刷新版本变了以后，旧请求返回的数据和错误都被忽略，也不能改动当前请求的加载状态。

### 当前注册的面板

第二列是面板 ID，也就是 UI spec 里的 `id`。内置插件的每个右侧和左侧面板都必须列在这张表里（有测试检查）。

| 插件/runtime                           | 面板 ID             | 图标               | group         | 数据 namespace     | 描述                                                                                                                                                                   |
| -------------------------------------- | ------------------- | ------------------ | ------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| affinity                               | affinity            | heart              | affinity      | affinity           | 好感度面板（玩家↔NPC score 双向条 + tier 徽标 + 最近变化原因）                                                                                                         |
| char-creator                           | character           | users              | character     | session.characters | 角色列表（类型由当前角色 schema 定义）                                                                                                                                 |
| character-blueprint                    | character-blueprint | id-card            | character     | blueprints         | 预设角色（世界作者预置的登场角色模板，只读；作为 `character` 组的子 Tab）                                                                                              |
| character-blueprint                    | character-presence  | image              | character-art | presence           | 角色立绘画廊（`PortraitGallery`，只读展示 + 玩家可上传替换头像，`alwaysRender`）                                                                                       |
| codex                                  | codex               | book-open          | codex         | entries            | 知识图鉴                                                                                                                                                               |
| core-quest                             | core-quest          | scroll-text        | core-quest    | quests             | 任务日志（进行中含 objectives 勾选清单 / 已完成 / 已失败 分组）                                                                                                        |
| dice-check                             | dice-check-panel    | dices              | （无）        | checks             | 判定记录（倒序回执列表：骰式 / 成败配色 / critical 强调，`alwaysRender`）                                                                                              |
| inventory                              | inventory           | backpack           | inventory     | items              | 行囊（已装备分组 + 背包列表，数量徽标 + tags pill，`alwaysRender`）                                                                                                    |
| dashscope-image-gen · openai-image-gen | `<plugin>-gallery`  | image              | image-studio  | images             | 剧情插图画廊（`MediaGallery`，`alwaysRender`）；两个图像插件各一套，组 ID 都是 `image-studio`；它们都提供单提供者扩展点 `media.image-flow@1`，同一会话只能启用其中一个 |
| dashscope-image-gen · openai-image-gen | `<plugin>-jobs`     | loader             | image-studio  | \_jobs             | 生成任务视图（`JobList`，`alwaysRender`）                                                                                                                              |
| dashscope-image-gen · openai-image-gen | `<plugin>-trigger`  | wand               | image-studio  | （无）             | “生成图片”manual 触发入口按钮（`expectsBackgroundFollower`，`alwaysRender`）                                                                                           |
| mimo-tts                               | mimo-tts-audio-tab  | headphones         | tts-studio    | tracks             | 旁白语音 playlist（`AudioPlayer`，`alwaysRender`）                                                                                                                     |
| living-world-rules                     | living-world-rules  | book-marked        | world-data    | rules              | 世界规则（长期设定 / 禁忌，只读；随 world-data 导入播种，作为 `world-data` 组的子 Tab）                                                                                |
| memory                                 | memory              | brain              | （无）        | blocks             | 记忆块。记忆插件在回合之后的后台任务里更新自己的记忆块，面板把它们展示出来                                                                                             |
| npc-graph                              | npc-graph           | network            | npc-graph     | nodes + edges      | NPC 关系图（force-directed 可视化）                                                                                                                                    |
| scene-stage                            | scene-stage         | image              | scene-stage   | stage              | 当前场景舞台（只读）：场景名 + 昼夜徽标 + `sourceLabel` 状态文案（未命中注册表时显示“无背景”）                                                                         |
| scene-stage                            | scene-cast          | users-round        | scene-stage   | active-cast        | 当前场景在场角色（只读，仅 name + role；内部选择信号留在 plugin_data，`alwaysRender`）                                                                                 |
| tabletop-rules                         | tabletop-rules      | dices              | （无）        | checks             | 属性检定入口按钮（调用 `tabletop-rules/check` 打开检定表单，`alwaysRender`）                                                                                           |
| world-init                             | world-overview      | map                | world-data    | session.dimensions | 任意维度当前值、版本（游玩中只读）及待结算恢复（`alwaysRender`）                                                                                                       |
| world-init                             | world-schema        | sliders-horizontal | world-data    | schema             | 角色属性 schema                                                                                                                                                        |
| world-time                             | world-time          | calendar-days      | （无）        | clock              | 当前世界时间（`/current/display` + 变化原因）                                                                                                                          |
| world-time                             | time-definition     | calendar-days      | （无）        | definitions        | 时间规则（当前日历定义，只读；无定义时说明默认日历）                                                                                                                   |

几个分组的说明：

- **`world-data` 组**（组名“世界资料”）汇集三份 spec：`world-init` 的 `world-overview` 和 `world-schema`，以及 `living-world-rules` 的 `living-world-rules`。它们合成一个外层页签，里面用横向子页签在总览、属性、世界规则之间切换。总览里的 `WorldDimensions` 直接读会话公开的当前值，不从 `entries` 或世界初值拼装；维度也不再同时写一份 constant lorebook。
- **`character` 组**汇集 `char-creator` 的角色列表和 `character-blueprint` 的预设角色。前者读会话 World Model 的 `session.characters`，是当前存档的活状态；后者是导入的只读模板。角色的创建和导入都经 World Model 写入，不靠插件之间互相镜像角色。
- **`npc-graph`** 的面板用 `dataSource.bindings` 把自己的 `nodes` 和 `edges` 两个 namespace 接进面板状态，再作为属性传给 `GraphCanvas` 画出关系图（`react-force-graph-2d`，按需加载）。
- **`memory`** 包注册了 `prompt.segment@1`、`memory.block-definitions@1` 服务和右侧面板。`runtimes/extract/RUNTIME.md` 读取冻结的 `turn-digest@1`，作为 `settle: before-next-execution` 的后台任务更新本插件的 `blocks` namespace。面板直接读这些块。它的提示词片段是回合级的，位于历史之后的回合上下文里。在禁用了这个插件的会话里，提取不运行，下一回合不等它的任务，记忆也不注入。

### 动态维度总览与修正

`WorldDimensions` 组件显示世界维度的当前值。它由通用的 `SessionDimensionsPanel` 接入会话快照里的 `dimensions`、`dimensionSettlements`，以及受信的 provider / recovery 元数据。它不按维度 ID 走不同的分支。

每个公开的维度项是 `{name,description?,schema,value,version}`。面板显示名称、稳定 ID 和值的版本，不显示初值和维护规则。

- **显示。** 标量直接显示。object 按字段展示。数组，或用动态名字作键的 object，可以按 schema 的 properties 显示成行和列，列标题用 `title` 或字段名。
- **只读与编辑。** 游玩界面里的维度面板是只读的，只有待结算恢复卡可以操作。字段编辑（`allowValueEditing`）只在调试页的会话数据视图里开启。开启后，基础 schema 支持字段编辑，以及数组、命名记录的增删；复杂的嵌套值有一个明确的 JSON 编辑入口。
- **校验。** 客户端和提交边界共用 `validateDimensionValue`。缺值、可空值、范围错误都不靠强行转换类型来修。`x-i18n` 节点按 locale 展示，普通 JSON 不去猜翻译。
- **保存。** 保存时带上开始编辑时的 `expectedVersion`，通过 host 指定的 `editorRuntimeId` 发 runtime RPC，不绕过保留 namespace 直接写。发生冲突时刷新当前值并显示错误，玩家检查后重新提交，不会悄悄覆盖。
- **待结算卡（pending）。** 卡片显示来源的逻辑回合和失败原因，提供三个操作：重试、明确人工处理、明确跳过。重试直接调用 `trackerRuntimeId`，并带回执 `sourceTurnId`。后两者由 editor 针对 `source.resultId` 写入终态。普通的保存值不会解除 pending。
- **禁用时机。** 回合执行中或请求处理中，编辑按钮禁用。操作之后重新取会话视图，检查已提交的值和回执，不把 runtime 返回的 `submitted` 当成已经落库。
- **没有恢复入口时。** 没有受信的恢复入口，面板只读，不退回到作者写的初值。

两个编辑器不要混淆：

- 世界作者的编辑器编辑的是完整、开放的 definition map。它允许任意合法的 ID，九类题材结构只是可选的模板。
- 调试页编辑的是会话的当前值，不能新建 definition，也不能改 schema。

原始声明格式、开发数据的重建要求和恢复调用见 [World Data](./world-data.md#动态世界维度dimensions) 和 [API](./api.md#维度编辑与待结算恢复)。隐藏事件的触发和载荷目前没有编辑器（#97）。

### 世界文档（框架自持 Tab）

“世界”页签由框架自己提供。它和插件的页签并列，但不受 `/api/ui-specs` 影响。

- **数据源**：当前会话的 `WorldRecord.lore`，也就是 `worlds/<id>/WORLD.md`。它按 `defaultLocale` 解析：先找完全相同的 locale，再找同一种文字的主语言，最后用主文件 `WORLD.md`。内容由 `world-seed-loader` 在启动时写入 store。
- **交互**：按 Markdown 渲染（`@/components/ui/markdown`，`react-markdown` + `remark-gfm`）。`lore` 为空时显示 `description`，再为空则显示“暂无世界文档”（`worldDocumentEmpty`）。
- **只给叙事者的正文**：`<!-- narrator-only -->` 和 `<!-- /narrator-only -->` 之间的内容不显示（`playerVisibleLore`，在 `@covel/shared`）。整篇都被标记时，按 `lore` 为空处理。开局准备页的“世界文档”和世界详情页用的是同一个函数。写法见 [World Data](./world-data.md#只给叙事者的正文narrator-only)。
- **实现**：`apps/web/src/components/session/world-document-panel.tsx`。它在 `right-panel.tsx` 里作为 `world` 页签挂载，`game-view.tsx` 把当前的 `world: WorldRecord | null` 传给它。
- **隔离规则**：这个页签的代码属于框架，只依赖 `WorldRecord` 的公开字段，不认识任何插件 ID。

> [!IMPORTANT]
> 隐藏 `narrator-only` 的内容是为了不剧透，不是保密。`WorldRecord.lore` 里仍然是整篇正文。

> [!NOTE]
> Lorebook 仍由 HTTP API 提供（`GET/PATCH/DELETE /api/sessions/:id/lorebook[/:entryId]`），目前没有内置界面使用它。需要展示时，插件可以用一份 `ui.right` 的 JSON spec 自己实现。

### 声明方式

插件在 `PLUGIN.md` 的 `contributes.ui.right` 里列出 JSON 文件的路径：

```yaml
# PLUGIN.md
contributes:
  ui:
    right:
      - ./ui/my-panel.json
```

本页说的 `ui.right`、`ui.message`、`ui.left` 都是指 `contributes.ui` 下的这几个键。

### JSON Spec 格式

```json
{
  "specVersion": 1,
  "id": "world-entries",
  "group": "world-data",
  "groupLabel": "World Data",
  "label": "Entries",
  "icon": "book-marked",
  "dataSource": { "namespace": "entries" },
  "emptyState": {
    "message": "World entries not yet generated, waiting for initialization…"
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

| 字段                   | 说明                                                                                                                                               |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `specVersion`          | UI spec 的版本。可以省略，省略时按 v1 处理。写得比服务端支持的版本高会被拒绝，见 [Spec 校验与版本](#spec-校验与版本)                               |
| `id`                   | 面板的唯一标识                                                                                                                                     |
| `group`                | `group` 相同的面板合并成一个外层页签                                                                                                               |
| `groupLabel`           | 合并后外层页签的名字。可选，省略时用第一份 spec 的 `label`                                                                                         |
| `label`                | 面板自己的名字，显示在子页签上                                                                                                                     |
| `shortLabel`           | 页签条上用的短名字。可选，见 [activity-bar 短标签](#activity-bar-短标签)                                                                           |
| `icon`                 | 图标名（Lucide，kebab-case）。只能用框架允许的那些，完整列表见[组件目录 / Display](./ui-components.md#display)                                     |
| `dataSource.namespace` | 面板读哪份数据：`pluginData[pluginId][namespace]`。`_jobs` 是特殊值，见下                                                                          |
| `dataSource.bindings`  | 可选。再接入最多 8 个自己的 namespace，见下                                                                                                        |
| `emptyState.message`   | 数据为空时显示的提示，见[空状态渲染](#空状态渲染)                                                                                                  |
| `view`                 | 界面本身：一棵用 catalog 组件搭成的树。Web 界面只执行这种声明式的 spec；`.tsx`、`.js` 等不是 JSON 的界面声明不受支持，API 会给出诊断并把这一项去掉 |

**`_jobs`：后台任务的虚拟数据源。** 把 `dataSource.namespace` 写成 `_jobs`，面板拿到的是这个插件的后台手动任务和事件任务（由 `_runtime_jobs` 映射而来）。它以 jobId 为键，值里有：

- `status`：`pending` / `done` / `failed`
- `runtimeId`、`turnId`、`startedAt`、`completedAt`、`durationMs`
- `message`、`error`、`reason`、`runtimeResults`、`deferredJobs`

`message` 只出现在以 `expectsBackgroundFollower` 排队的 prompt 生成任务上。进行中是“正在生成图像 Prompt”，排进后续任务后是“图像任务已入队”，按玩家的语言显示。

**`dataSource.bindings`：多接几份自己的数据。** 例如：

```json
{ "nodes": "characters", "edges": "relations" }
```

- 面板在 `/sources/nodes`、`/sources/edges` 下拿到这两个 namespace 在当前会话里的数据，用 `$state` 引用。
- 名称和 namespace 都必须是写死的字符串，不能指向别的插件。
- 切换会话时这些值随数据源一起刷新。不存在的 namespace 是空对象。
- 主 `namespace` 仍然决定普通的面板数据，以及面板算不算“空”。

### Spec 校验与版本

UI spec 是**不可信的插件输入**。`/api/ui-specs` 汇总时，对每份 spec 做 Zod 校验（外层结构和 `specVersion`）。

- **版本。** `specVersion` 可以省略，按 v1 处理。写得比服务端支持的版本高（当前 `CURRENT_UI_SPEC_VERSION = 1`，在 `apps/server/src/routes/misc-api/ui-spec-schema.ts`）会被拒绝。这样旧服务端遇到新插件包时会明确报错，而不是画出一个坏面板。
- **`view` 或 `webview`，二选一。** 每份 spec 必须声明 `view`（对象）或 `webview`（HTML 文档）。两个都写或都不写，校验失败。
- **`view` 递归校验。** 检查的内容有 `component` / `type`、`children`、命名的 `slots`、`repeat`，以及 `on` / `watch` 的 action 绑定结构。组件名必须在共享的 `PLUGIN_UI_COMPONENT_NAMES` 里；不认识的组件在服务端就产生带路径的诊断。`props` 和 directive 表达式不做限制，由组件和 json-render 在运行时解析，这样插件可以扩展数据的形状。
- **不是 JSON 的声明。** 加载器用 `_componentPath` 记下这类声明的位置，好让 API 给出具体的诊断。它不是有效的 UI spec，也不是让 Web 执行插件代码的入口。带这个字段的 spec 会被去掉，即使同时写了 `view`。同一个插件的其他合法 JSON spec 照常显示。
- **需要自定义组件时。** 声明 `webview.entry` 并提供一份独立的 HTML；或者组合 catalog 组件，绑定框架的 action。浏览器不会直接导入插件的 `.tsx` / `.js` 模块。
- **一份坏 spec 不拖累整个响应。** 校验失败的 spec 从它所在的位置去掉，响应顶层的 `diagnostics[]` 给出具体诊断：

  ```ts
  { pluginId, runtimeId, slot, specIndex, specId?, issues: [{ path, message, code }] }
  ```

  它指明哪个插件、哪个字段、什么问题，而不是一句笼统的 “Invalid panel spec”。

- **前端怎样用这些诊断。** `right-panel.tsx` 在开发模式下把诊断打到控制台。`plugin-panel.tsx` 的本地兜底消息也带上 spec 名和具体原因：缺 `view`、`view` 不是对象、转换失败。

UI 声明来自启动时的注册表快照。静态资源按需加载，并按快照缓存。GET 请求只做读取和按会话激活集过滤，不扫描插件目录，也不把 UI 定义写进 `plugin_data`（详见 [api.md](./api.md#get-apiui-specs)）。

读取静态资源时，会检查符号链接解析之后的真实路径：指向插件根目录以内的链接可以，指向根目录以外的文件或目录会被拒绝。某个资源加载失败时，只跳过对应 runtime 的界面，不影响其他 runtime 的面板。

### activity-bar 短标签

页签上显示什么名字，取决于布局的 `panelTabs`。

**`panelTabs: "bar"`（横向文字页签）**

- 页签显示 `shortLabel`。没有声明时显示完整的 `groupLabel` / `label`，不截断。
- 放不下全部页签时，页签条可以横向滚动，鼠标滚轮也能滚动它。被截断的一侧渐隐，选中的页签保持在中间。
- 页签条末尾多一个“全部面板”按钮。点开是全部页签的网格，显示完整名称。

**`panelTabs: "rail"`（右侧纵向图标条，activity-bar）**

每个页签只放得下很窄的文字。没有声明 `shortLabel` 时，框架对 `groupLabel`（或 `label`）做机械截断：

- 中文有 2 个以上汉字 → 取**前两个汉字**（“核心记忆” → “核心”）
- 多个英文词 → 取每个词的首字母并大写，最多 3 个（“Core Memory” → “CM”）
- 其他情况 → 取前 4 个字符

截断出来的名字认不出来、或者和别的页签撞名时，在 spec 顶层声明 `shortLabel`：

```json
{
  "label": "Core Memory",
  "shortLabel": "Memory"
}
```

```yaml
# locales/zh.yaml
messages:
  Core Memory: 核心记忆
  Memory: 记忆
```

合并规则和 `groupLabel` 一样：同一个 `group` 里，第一个声明的生效。建议同组的每份 spec 都写上同一个 `shortLabel`，这样结果不依赖加载顺序。

**界面文字归谁。** 插件的组名、短标签、面板标签、按钮和表单字段都写在 `plugins/<id>/ui/*.json` 里（English），译文写在 `plugins/<id>/locales/<locale>.yaml`。框架自己的 i18n 字典只放框架的导航、系统按钮和通用状态文字。几个插件共用一个 `group` 时，每个插件的 spec 都应该写上一致的 `groupLabel`；页签上的短标签由同组第一个 `shortLabel` 决定。

实现位置：`apps/web/src/lib/plugin-panel-tabs.ts` 的 `compactTabLabel()` 和 `aggregateSpecsIntoGroups()`。

### 空状态渲染

面板对应的 namespace 没有数据时（`Object.keys(data).length === 0`），`PluginPanel` 不渲染 `view`，而是显示一行居中的斜体提示。

**显示哪句话**：先用 spec 声明的 `emptyState.message`；没有声明时用自动生成的“`<面板名>` 暂无数据，等待游戏推进……”。

**怎么写**：spec 里写 English，译文写在 `locales/<locale>.yaml`，见下方[插件 UI 文本规范](#插件-ui-文本规范)。

```json
"emptyState": {
  "message": "No characters yet…"
}
```

**约定**：凡是依赖 namespace 数据来渲染的右侧面板，spec **必须**声明 `emptyState.message`，并且用符合这个面板业务的提示，不用通用文字。内置面板里的例子（中文译文）：

| 面板 spec              | 空状态提示                                         |
| ---------------------- | -------------------------------------------------- |
| `character-panel.json` | 尚未创建角色，完成角色创建流程后将在此显示……       |
| `codex-panel.json`     | 图鉴暂无词条，继续推进故事后会自动出现……           |
| `memory-panel.json`    | 记忆块尚未初始化，等待首轮游戏结束后自动填充……     |
| `npc-graph-panel.json` | 尚未发现角色或势力关系，继续推进故事后会自动出现…… |
| `world-schema.json`    | 角色属性定义尚未生成，等待世界初始化……             |

**`alwaysRender: true` 是例外。** 有些面板不靠 namespace 数据渲染。例如 `world-overview.json` 的 `WorldDimensions` 直接读会话上下文；`MediaGallery` 和 `JobList` 可以自己处理空列表。这类 spec 在顶层明确声明 `"alwaysRender": true`，框架只读取这个字段，不按组件名自动开启。它们**可以不写 `emptyState.message`**，因为 `PluginPanel` 不会走到空状态这一步。组件属性见 [UI 组件](./ui-components.md#structured-list-props-and-actions)。

**实现位置**：`apps/web/src/components/session/plugin-panel.tsx` 的 `PluginPanel` 组件（`isEmpty` 判断和 `alwaysRender` 短路）。

### 插件 UI 文本规范

UI spec 里只写一种语言：English。其他语言的文字写在插件根目录的 `locales/<locale>.yaml` 的 `messages` 一节。左边是 spec 里的 English 原文，右边是译文：

```json
// ui/codex-panel.json
{
  "label": "Codex",
  "shortLabel": "Codex",
  "emptyState": { "message": "No codex entries yet." },
  "view": {
    "component": "Text",
    "props": { "content": "{{count}} entries collected" }
  }
}
```

```yaml
# locales/zh.yaml
messages:
  Codex: 知识图鉴
  shortLabel|Codex: 图鉴
  No codex entries yet.: 图鉴暂无词条。
  "{{count}} entries collected": 共 {{count}} 条记录
```

规则：

- **哪些属性算文字。** 名为 `label`、`title`、`content`、`message`、`text`、`description`、`placeholder`、`footer`、`tooltip`、`hint`、`help`、`summary`、`subtitle` 的属性；以及名字以 `Label`、`Title`、`Message`、`Text`、`Placeholder`、`Description`、`Hint`、`Tooltip` 结尾的属性（`shortLabel`、`groupLabel`、`searchPlaceholder`、`emptyMessage`……）。
- **译文只作用于这些属性。** 所以翻译文件改不了组件名、action 和数据路径。`on`（action 的参数）、`dataSource` 和 `*PropMap` 里的内容是数据，不翻译。
- **同一句 English 需要两种译法时**，在 key 前加属性名和 `|`：`shortLabel|Codex` 只用于 `shortLabel`，其他位置用 `Codex`。
- **没有译文的文字显示 English。** 译文里的占位符（`{{count}}`）必须和原文一致。
- **English 原文改了，旧译文就不再匹配。** 界面回到 English，`pnpm validate:plugin` 把这条译文报为错误。不需要另外记录“译文是否过期”。
- **spec 里不写内联的 `{ "zh": …, "en": … }`，也不能出现中文。** `pnpm validate:plugin` 和 `pnpm check:i18n` 会拒绝。
- **内置插件的每一条界面文字都必须有中文译文**（`pnpm check:i18n` 检查）。和 English 相同的文字照原样重复一遍即可；没有字母的文字（符号、数字）不需要。

**前端拿到的是什么。** 加载器把译文编译成 `I18nText`（`string | Record<LocaleTag, string>`）交给前端。所以 `GET /api/ui-specs` 返回的仍然是 `{ "en": "Codex", "zh": "知识图鉴" }` 这样的值。统一的解析规则和回退顺序见 [Internationalization](./i18n.md)。组件不得自己判断 locale。

**框架端的解析器。** `resolveI18n(value, locale?)` 和 `useI18nResolver()` 由 `apps/web/src/lib/catalog/helpers.tsx` 导出，渲染器直接从这个模块导入。所有内置的 ComponentRenderer 都调用了这个 hook 来订阅语言变化，所以切换语言时 json-render 的子树自动重新渲染。

**验证。** `pnpm check:i18n` 跑两套扫描：`check-no-chinese-literal`（应用代码）和 `check-plugin-i18n`。后者检查两类内容：

- 插件 JSON、清单和 handler 里玩家能看到的标签。
- 发给模型的文本：插件和模板里，工具和参数的说明必须是英文。

框架源码里出现中文的文件和行数，记录在脚本的 `FRAMEWORK_CHINESE_LINES` 表里。新增或改动都要明确更新这张表。

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

> [!NOTE]
> `repeat.statePath` 接受一个以 `/` 开头的绝对状态路径字符串，或者在嵌套的 repeat 里接受 `{ "$item": "field" }`。它不是 `{ "$state": ... }`。item 的字段名不能带前导斜杠：`$item: "key"` 正确，`$item: "/key"` 错误，`$bindItem` 相同。`pnpm validate:plugin` 和 ZIP 安装会检查这些写法，报错给出 spec 文件和节点的路径。

**外部数据更新时，面板状态怎样同步。** 面板比较前后两次外部数据快照，只同步有差异的部分：

- 被删除的字段，以及数组变短后失效的派生索引，会被清空。空对象保留。
- `/_invoking` 和 `/sources` 整体替换，所以调用结束后按钮恢复可用。
- 外部值没变的字段，保留玩家用 `$bindState` 做的本地编辑。没有被外部数据占用的草稿字段也保留。切换面板后复用缓存时，同样遵守这条规则。
- 状态路径用 JSON Pointer 转义：字段名里的 `~` 写成 `~0`，`/` 写成 `~1`。

**数组怎样判断变没变。** 数组（包括自动生成的 `/entries`）按外部内容判断：

- 内容相同的新数组，保留已有的本地编辑。内容或顺序真的变了，整体替换。
- 递归比较最多检查 32 层。在这个范围内确认不了相同的深层子树，按“变了”处理，这样遍历的开销有上限。
- 对象里用数字作名字的字段仍按对象的键处理，不会被悄悄当成数组索引。

**按钮状态与交互锁。**

- 按钮的选中态和“调用中”状态，随 action 的动态参数读到的最新状态更新。
- 面板交互被锁定时，JSON 渲染区域不能用鼠标或键盘操作。action handler 也会检查锁定状态，避免已经保留下来的回调绕过界面锁。
- 锁是这样实现的：在祖先容器上设置 `inert` 和 `aria-disabled`，同时保留 action handler 里的检查。锁定期间，浏览器跳过里面控件的键盘焦点，并禁止用户输入。
- catalog 的 Input / Textarea / Select 用唯一的 ID 关联本地化的标签。Switch 用原生的、不会提交表单的按钮，支持 Tab、Space 和 Enter。
- 控件的可访问性不会绕过面板锁。spec 里也没有新增通用的 disabled 字段。

### 标准 directives

directive 是写在 spec 里的小计算，例如“把这两个值拼起来”。框架持有的所有 json-render Provider 共用同一组 directive：右侧插件面板、插件消息面和绑定到回合的消息块。

directive 可以写在组件 props 的任何动态值位置，也可以写在 `on.<event>.params` 里。所以按钮和输入框触发的 action 拿到的解析结果，和显示出来的内容一致。

| Directive    | 用途                                      |
| ------------ | ----------------------------------------- |
| `$format`    | number / date / currency / percent 格式化 |
| `$math`      | 加减乘除、取模、min/max、取整和绝对值     |
| `$concat`    | 拼接多个动态值                            |
| `$count`     | 获取字符串或数组长度                      |
| `$truncate`  | 截断文本                                  |
| `$pluralize` | 按数量选择 zero / one / other 文案        |
| `$join`      | 连接数组元素                              |

`$t` 暂不开放。插件的自然语言写在文本属性里，由 `locales/<locale>.yaml` 翻译，这样不会和现有的 i18next 资源形成两套翻译来源。directive 参数里的字符串（例如 `$concat` 的片段）不在翻译范围内；需要翻译的文字应该放在文本属性里。

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

开发构建只在当前激活的右侧插件面板上挂载 json-render Devtools。

- 按 `Cmd/Ctrl+Shift+J` 打开 Spec、State、Actions、Stream 和 Pick 调试面板。
- 切换右侧的子面板后，检查的目标跟着切换。
- 消息流里的插件消息面不挂 Devtools，避免多个实例抢同一个快捷键。
- Devtools 在开发环境里动态加载，不进入生产构建。

### 自动 `entries` 数组

插件数据 `pluginData[pluginId][namespace]` 是 `{ key: value }` 这样的结构。框架从它派生出一个 `/entries` 数组，格式是 `[{ key, value }, ...]`，给 `repeat` 迭代用。

原来的键仍然可以用 `$state: "/someKey"` 直接读。两种方式可以同时用。

### 多面板与分组（跨插件共享）

**`group` 是一个全局字符串，可以跨插件共用。** 几个插件，或者同一个插件的几份 spec，只要 `group` 的值相同，就合并到同一个外层页签里，各自的 spec 用横向子页签切换。

```
┌──────┬──────────────────────────────┐
│ [W]  │ 世界资料                     │  ← 外层 Tab（group="world-data"）
│ [C]  │ [总览] [属性] [世界规则] ... │  ← 子 Tab（多份 spec / 多个插件）
│ [B]  │ ┌──────────────────────────┐ │
└──────┤ │ (当前子 Tab 的面板内容)  │ │
       └──────────────────────────────┘
```

**两种典型用法**：

- 一个插件的多个面板：`world-init` 的 `world-overview` 和 `world-schema` 都声明 `group: "world-data"`。
- 跨插件组合：`char-creator` 提供角色列表，`character-blueprint` 提供预设角色，两者都声明 `group: "character"`，自动汇集到同一个外层页签。

**合并规则**：

| 字段                                                | 行为                                                                  |
| --------------------------------------------------- | --------------------------------------------------------------------- |
| 相同 `group`                                        | 合并为一个外层 Tab（横向子 Tab 切换）                                 |
| 不同 `group` 或省略                                 | 独立外层 Tab（兜底 key 为 `${pluginId}::${specId}`）                  |
| `groupLabel` / `shortLabel` / `icon` / `groupOrder` | 冲突时"**首个声明者赢**"，按 `/api/ui-specs` 返回顺序（插件加载顺序） |
| `groupOrder`                                        | 外层 Tab 在 activity bar 中的排序（数字小的排前，默认 500）           |

**命名约定**：跨插件的 group 名字和 CSS 类名是一个道理，作者自己加命名空间前缀来避免冲突，例如 `core.character`、`myorg.combat`。框架不会自动加前缀。

多个插件共用一个组时，提供者切换按钮显示插件的本地化 `displayName`；没有名字时显示插件 ID。所有组名都遵循这条规则，面板的 `label` / `shortLabel` 不改变提供者名字。

**实现位置**：`apps/web/src/lib/plugin-panel-tabs.ts` 的 `aggregateSpecsIntoGroups()`。它是纯函数，可以单独测试（见 Playwright smoke test）。

### 排序

- 外层页签按 `groupOrder` 排序。排序是稳定的：`groupOrder` 相同的保持加载顺序。
- 子页签按各 spec 加入的顺序显示。
- 子面板的选择和渲染状态用 `(pluginId, spec.id)` 来标识。重新排序后，选中的还是同一个面板。
- 所选的面板被移除后，回到这一组的第一项。
- 不同插件可以用相同的 `spec.id`，它们不会共用本地界面状态。

## 消息区（Message Area）

### 两条渲染链路

消息区里有两条并行的链路。它们用的是同一套 json-render catalog。

1. **Turn message 链路**：`chat-messages.tsx` 读取 `turn_messages` 和 SSE 事件，经 `messageToSpec()` 转成 json-render spec，由 `MessageBlockRenderer` 渲染。具体的 block 和基础组件拆在 `apps/web/src/components/session/chat-messages/` 下。
2. **Plugin message 链路**：同一个文件在 `block.type === "plugin_message"` 的分支里，通过 `/api/ui-specs?sessionId=` 发现 `ui.message`，再用 `PluginPanel` 和 `plugin_data` 渲染插件消息面。

| 链路           | 当前承载内容                                                                                                                                | 实现位置                                                                                              |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Turn message   | 叙事文本、玩家输入、`interaction.requested` 表单/选择、通知                                                                                 | `apps/web/src/components/session/chat-messages.tsx`, `apps/web/src/components/session/chat-messages/` |
| Plugin message | guide 建议卡、codex 本轮摘要、dice-check 判定结果块、core-quest 任务变更块、affinity 好感 toast、inventory 得失 toast、其他插件自定义消息面 | `apps/web/src/components/session/chat-messages.tsx`（`plugin_message` 分支）                          |

**每回合的更新默认折叠。** 在解析视图（`parsed`）下，每回合的只读插件卡片合并成一条默认折叠的“本回合更新 · N 项”，摘要里预览前三张卡片的标题。这样叙事占据主要版面。

- 会被折叠的：`ui.render`、`ui-spec`，以及 level 为 info / success 的通知，例如图鉴发现、成就和状态变更。
- 不折叠的：表单、选项、确认、图片，以及警告和错误通知。
- 建议块（`plugin_message`）在当前回合保持展开。出现更新的玩家消息后，它折叠成“历史建议”。
- 玩家可以在设置的“通用”里打开“展开本回合更新”（`ui.expandTurnUpdates`），改成默认展开。
- `detailed` / `raw` 视图不折叠。
- 主题包的 `layout.turnNotes` 决定这条更新放在哪：`fold` 是上面说的默认行为；`inline` 让最新一回合默认展开；`margin` 在会话区够宽时把它放到正文旁的页边栏。

实现见 `apps/web/src/components/session/chat-messages/turn-updates.tsx`。

**选项只有一种画法。** 给玩家选的东西最终都渲染成 `.ui-choice`：

- 插件 spec 里的 `ChoiceList` / `Choice`；
- 内核的选择题消息块（`choice` block，由框架转成 `ChoiceList`）；
- `CandidateList` 的回复变体（点一下就采用这个版本，“草稿 / 发送”是它下方的次要动作）；
- 舞台视图的决策面板。

所以选项在每套风格方案里长得一样。新插件只要走这几条路之一，就自动跟随。

**用数字键选。** 当前回合里的选项可以用数字键选：按 1–9 相当于点击屏幕上第 n 个选项。

- 同一回合里有多组选项时，编号是连续的，先出现的在前。画出来的序号和按键一致。
- 被禁用的选项保留编号，但不响应。
- 以下情况不响应：焦点在输入框里、按着修饰键、有对话框或菜单打开、回合还在执行。
- 舞台视图的决策面板同样支持。

实现见 `apps/web/src/hooks/use-choice-hotkeys.ts`。编号是 CSS 计数器（`apps/web/src/styles/ui-components.css` 的 `.ui-choice` 一节）。

### 消息 Block 声明

插件用 `ui.message` 声明消息区里一个块怎样渲染：

```yaml
contributes:
  ui:
    message:
      - ./ui/guide-block.json
```

> [!IMPORTANT]
> **消息块要先有数据才会出现。** `ui.message` 的块只有在它声明的 `message` namespace 里写入了数据之后才渲染。所以，一个只能靠块里的按钮来触发写入的插件永远启动不了：首屏没有数据，块不出现，按钮也就点不到。`branch-reply` 早期就因此完全不显示。
>
> 让块第一次出现的那次写入，必须来自一条**不是手动**的路径：`scheduled` / `auto` runtime（读到叙事引擎的输出后写入第一份数据）、上游 runtime 的 `plugin.data` 提案，或者 world-data 导入。`branch-reply` 用 `trigger: auto`（`stage: post-turn`，在叙事引擎之后）写入 candidate[0]，详见 [plugins.md § 代表性实现](./plugins.md#代表性实现)。

**回合绑定（`__turnId`）。** 消息块挂在哪一回合，由 `message` namespace 里的 `__turnId` 决定。有两种写法：

| 写法       | 怎么写                                                          | 结果                                                | 例子                    |
| ---------- | --------------------------------------------------------------- | --------------------------------------------------- | ----------------------- |
| 命名空间级 | 在 namespace 顶层写 `__turnId`                                  | 整个 namespace 是一个块，每回合覆盖，只留最近一回合 | core-quest 的 `changes` |
| 记录级     | 每回合写一条记录，键是回合 ID，值里带 `__turnId`（或 `turnId`） | 每回合一个块，历史可以回看                          | dice-check 的 `checks`  |

渲染时，以 `__` 开头的键不进入块的 `state`。

恢复重试时，内核（`packages/runtime/src/commit/plugin-message-turn.ts`）会把指向本次执行的 `__turnId` 改写成被恢复的源回合。这样卡片归属于被恢复的那段内容。

### 表单提交流程

表单必须带有回合 ID，并通过交互提交处理器发送。缺少任一项时，界面提示重新打开会话后重试，保留填写内容；不会把字段 JSON 当作玩家发言，也不会标成已提交。

```
玩家填写表单 → 点击提交按钮
  → submitInteraction():
    1. POST /api/actions (`submit_interaction`)：服务端在一次操作里
       保存 submission、填充 narrativeTemplate 并开始后续回合
    2. SSE `interaction.submitted`：表单标成已提交；交互没有声明
       `submitBehavior.echoFilledNarrative: false` 时回显自然语言
    3. 同一条流上的后续回合由对应插件读取 `player.lastFormValues` 完成业务写入
```

### 行动引导交互

```
guide 分析叙事 → `generate-guide` 写入 `plugin_data[message]`
  → `ui.message` 渲染情境回顾、当前决策与 3–4 条短句（舞台模式同时经 `stage.choices@1` 显示）
  → 玩家点击建议后进入待发送区
  → InputBar 统一发送待发送草稿与手写输入
```

## 舞台模式（Stage View）

舞台模式是视觉小说式的画面：场景背景、角色立绘和逐字出现的对话框。

它是第四种呈现方式，`viewMode: "stage"`，和 `parsed` / `detailed` / `raw` 并列，在头部的 `GameViewHeader` 里切换。进入舞台后，消息区的三件东西（`ChatMessages`、`PendingDraftsBar`、`MessageComposer`）整个换成全屏舞台，`GameViewHeader` 保留。

- **渲染条件**：`viewMode === "stage" && (session.phase === "playing" || hasSubmittedForm(...))`。角色创建表单仍在原来的消息流里完成。提交后立刻进入舞台，第一段叙事到达之前显示“生成中”的状态。
- **初值**：世界包 `world.yaml` 顶层写 `defaultViewMode: stage`（进入 `WorldRecord.metadata.defaultViewMode`），会话**第一次挂载**时就进舞台。玩家在头部切换之后，以玩家的选择为准；这个选择不保存。见 [world-data.md](./world-data.md#world-package)。

### 层级与数据源

舞台有五层，都是绝对定位，`z-index` 分档。DOM 顺序是 Backdrop → Sprites → Hud → Dialog → Choices，全部放在一个 `relative` 的有界容器里。

舞台读的是服务端的 `ui.slot@1` 投影。各个提供者从自己的数据、领域事件和 World Model 构造通用的槽位值；前端不按插件 namespace 自己拼舞台。

| 层           | 数据源                                                 | 前端用途                                           |
| ------------ | ------------------------------------------------------ | -------------------------------------------------- |
| **Backdrop** | `stage.backdrop@1`                                     | 展示背景、场景名称和状态；缺图时使用世界视觉回退   |
| **Sprites**  | `stage.cast@1` 与按角色 ID 索引的 `character.visual@1` | 站位、高亮、立绘与无图时的占位                     |
| **Hud**      | `stage.backdrop@1`                                     | 展示名称、变体和来源状态                           |
| **Dialog**   | 最新 story 正文与 `stage.dialogue@1`                   | 打字、段落切分和逐段署名                           |
| **Choices**  | `stage.choices@1` 与待提交 interaction choice block    | 情境回顾、决策问题、选项（`.ui-choice`）与自由输入 |

**打字与决策面板的切换。**

- “流式中”沿用内核的约定：没有 streaming 布尔值，判断条件是 `executing && story 消息 id 以 stream_ 开头`。
- 新叙事由 `StageDialog` 逐字显示，每一段停下来等玩家点击。最后一段读完同样停一次，等收尾的点击。自动播放按停顿时间自动往下走；正文末尾的空段落不产生空白的停顿。
- 正文独立于“点击继续对话”按钮，读屏可以读取。逐字显示时暂停实时朗读，段落显示完再朗读；Tab 可聚焦推进按钮，Enter 或空格继续。
- 打字追上流的结尾时，不会自动跳到决策面板。
- 读完，并且回合执行结束后，同一个位置换成统一的决策面板。它依次显示：场景、“当前信息”摘要、“现在需要决定”的问题、分组的选项、行内的自由输入。
- 提交后立刻隐藏整个旧的决策面板，包括插件扩展的区域。等新叙事时显示“生成中”，不重播已经读过的旧叙事。
- 恢复会话，或从别的视图切进舞台时，挂载之前就存在的最新叙事算已读，不会重新打字。
- `stage.choices@1` 的 `recap` 可省略；省略或为空时不显示“当前信息”，也不从叙事里截取摘要。`decision` 省略时，用 `scene` 或通用问题引导自由输入。没有建议提供者也能阅读叙事、提交自由输入。
- `turnId` 可省略，表示不按回合限制的选项。有 `turnId` 的选项只在它匹配当前 story 回合时显示；当前回合未知时不显示。已提交的重试可通过回合解析器匹配源故事。提供者应为随回合过期的选项填写 `turnId`，不要依赖框架猜测旧数据。

**槽位的预览与缓存。**

- 当前执行过程中，舞台槽位可以接收预览事件。提交之后由服务端重新计算并缓存。会话恢复时重新读取已提交的槽位。
- `watch` 只监听提供者自己的 namespace。预览在失败或取消时丢弃。私有的插件数据不会直接交给舞台。
- 服务端的槽位缓存按最近使用的顺序，最多保留 256 个会话。正在处理请求、排队投影或分发事件的会话不会被淘汰。并发期间允许暂时超过上限，工作结束后回收闲置的条目。
- 一次读取在释放会话状态之前拿到结果。所以缓存淘汰不会让一次已经成功的投影返回空结果。

**立绘高亮。** `stage.cast@1` 里每位演员有一个可选的 `active` 标记。只要有一位演员明确写了它，就按各自的布尔值显示。全部省略时，默认高亮第一位没有退场的演员。

**对白名牌。**

- 名牌读 `stage.dialogue@1` 的 `paragraphSpeakers`。每项是显示名字符串或 `null`（旁白），不是角色 ID 或对象。提供者负责把自己的数据转成这个形状，见[舞台槽位值](#舞台槽位值)。
- 同一回合的实时事件可以先预览。旧的已提交映射不会在同一回合重试的流式阶段被复用。
- 打字机和署名校验共用 `splitStageParagraphs`：CRLF 转成 LF，三个以上的换行算一个空行分隔。正文结束后，分段的数量必须和映射一致。
- 以下情况不显示人物名牌：旁白、身份未知、旧消息没有映射、回合对不上。演员的焦点不参与署名。

**尺寸与立绘。**

- 决策面板在窄屏最多占舞台下方的 60%，宽屏是 65%，始终在舞台范围内。
- 回顾默认折叠，点“当前信息”展开。回顾、问题和选项共用一个可以滚动的内容区；自由输入固定可见。
- 立绘底部渐隐。窄屏把站位抬高，让脸露在决策面板上方；宽屏保持原来的站位高度。
- 有角色图时不再叠一个名字徽标；缺图时保留姓名占位。

### 背景回退链（`resolveBackdrop`）

输入就是 `stage.backdrop@1` 的槽位值，符合 `stageBackdropSchema`。`label` 只用于显示状态文字，不影响回退。

| 档         | 触发                     | 表现                                                          |
| ---------- | ------------------------ | ------------------------------------------------------------- |
| `scene`    | 槽位 `ref` 是 `MediaRef` | 渲染场景图（换图 600ms crossfade）                            |
| `hero`     | 槽位缺失，或无有效 `ref` | 世界头图（`worldVisual().image`，即 `world.yaml` 的 `cover`） |
| `gradient` | 理论兜底                 | 世界 accent 渐变（选择器当前不返回）                          |

### 履历抽屉与表单模态

- **履历抽屉**：Hud 上的履历按钮打开一个 Radix `Dialog`。里面是用 `flex h-[80vh] flex-col` 包住的完整 `<ChatMessages viewMode="parsed">`，所以在舞台下仍然可以回看、滚动全部解析后的消息。
- **表单模态**：舞台的对话框只接选项和自由文本。所以消息里出现还没提交的 **form 类** interaction block 时（`extractPendingFormMessages`），舞台弹出一个 `Dialog`，用 `MessageBlockRenderer` 让玩家填写。提交后自动关闭。

实现位置：`apps/web/src/components/session/stage/`（`StageView.tsx` 负责组装，另有 `Stage{Backdrop,Sprites,Hud,Dialog,Choices}.tsx`、`stage-selectors.ts` 和 `use-typewriter.ts`）。

## 组件 Catalog

组件目录在单独的一页：[ui-components.md](./ui-components.md)。目前有 50 个组件，以 `apps/web/src/lib/catalog.tsx` 导出的 `covelRegistry` 为准。

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

下面三件事都不需要改框架代码。

添加一个右侧面板：

1. 在 `PLUGIN.md` 的 `contributes.ui.right` 里加上 `./ui/my-panel.json`。
2. 创建 `ui/my-panel.json`，用 catalog 里的组件写 json-render spec。
3. 在 local tool、builtin tool 或 function handler 里写入 `plugin_data`。
4. 框架自动发现面板，生成页签；之后插件数据一变，面板跟着更新。

添加一个插件消息面：

1. 在 `PLUGIN.md` 的 `contributes.ui.message` 里加上 `./ui/my-block.json`。
2. 创建 `ui/my-block.json`。
3. 在 runtime 或 tool 里写入 `plugin_data[pluginId][message]`。
4. `chat-messages.tsx` 的 `plugin_message` 分支自动发现 spec 并渲染。

添加一个绑定到回合的交互块：

1. 在 runtime 的输出或 tool 的返回值里写 `interaction`。
2. session-kernel 把它归一化成 `interaction.request`。
3. `chat-messages.tsx` 经 `messageToSpec()` 渲染表单、选择或确认界面。

### Gameplay completion and reading order

**阅读顺序。**

- 同一回合里，故事消息排在插件消息面之前。即使流式传输或恢复数据时插件消息面先到，也是这样。
- 消息顺序按回合归属来定，不按客户端的时间戳。

**失败要看得见。**

- 任务小标签收起之后，执行失败仍然可见，并带着受影响的 runtime 和它原有的重试操作。
- 只完成了一部分的回合，不能显示成干净地完成了。

**发送。**

- 输入框可以只提交排队的选择，不必再打字。
- 主发送按钮和选择栏都会把排队的动作和已输入的文字合在一起发送。
- 交互 RPC 被拒绝时，表单保持可编辑。它绝不会退回去把表单字段当成一条没有校验过的故事消息发出去。

**其他。**

- 面板尺寸变化的回调使用传入的尺寸，不在面板注册变化期间去主动查询约束。
- 明暗两种模式下的正文排版都使用当前主题的 token。

## 插件自带组件与舞台挂载

catalog 里的组件不够用时，插件可以带一份自己的 HTML。JSON spec 里用 `webview` 代替 `view`，两者只能写一个：

```json
{ "webview": { "entry": "./widget.html", "height": 280 } }
```

- **组件能做什么。** 它通过消息桥拿到当前的风格方案（`theme` 和 `--covel-*` CSS 变量），并且可以调用 `emitEvent`、`draftMessage` 等动作。
- **放大。** 右侧面板里的每个插件面板都可以“放大”到一个大对话框里显示。
- **显示在舞台上。** `ui.right` 的 spec 可以声明 `surfaces: ["panel", "stage"]`。不写时只显示在右侧面板。
- **玩家确认与加载失败。** 舞台插件面板的 `sendMessage` 只把文字填进输入框，由玩家编辑后发送。舞台复用会话已加载的面板定义；加载失败时显示提示和“重试”，不阻止玩家继续输入。
- **隔离方式。** HTML 放在两层 opaque-origin 的 sandbox iframe 里：
  - 外层是 Web 构建里的静态文档 `/plugin-frame.html`。它按 URL 加载，所以带自己的 CSP，不继承主页面的策略（主页面不允许内联脚本）。它的 CSP 禁止插件文档自己导航到网络地址，端口只转交一次。
  - 内层是插件的 HTML。它保留内联脚本和 `window.covel` 数据 / 动作桥。组件代码和业务状态的结构归插件自己。

两层的策略和桥接的校验见 [security.md](../internals/security.md#plugin-html)。完整协议、资源限制和示例见[插件扩展契约](./plugin-extensions.md#自定义组件与挂载)。

## Kernel UI slots

内核 UI 槽位是界面上几个固定的位置，例如舞台背景、在场角色、状态摘要。插件不直接画这些位置，而是提供一份数据，由框架来画。

**怎样提供。** 插件在 `contributes.extensions` 里为 `ui.slot@1` 声明提供者，并在服务端 `entry` 里注册处理函数。`slot` 选择要填的槽位：

- `stage.backdrop@1`
- `stage.cast@1`
- `stage.dialogue@1`
- `stage.choices@1`
- `character.visual@1`
- `session.summary@1`
- `stage.music@1`

**多个提供者怎样合在一起。**

- 提供者先按声明的顺序，再按插件 ID / 提供者 ID 的顺序依次运行。
- 处理函数收到 `{ slot, previous, events }`，还能用自己范围内的 `ctx.pluginData` 和内核的 `ctx.world` 视图。
- 宿主用槽位的模型校验每个提供者的输出。
- 失败的提供者被跳过。它不能替换掉前面那个有效的值。

**什么时候重新计算。**

- `watch` 列出提供者自己的 namespace。这些 namespace 有提交时，投影失效并重新计算，带 50 ms 的防抖。
- `preview` 列出经过校验的领域事件主题。提供者可以在提交之前，先根据这些事件给出预览。
- 预览是临时的，只属于当前回合。回合完成、失败或取消时丢弃。它永远不会替换已提交的缓存。
- 终止事件之后才到的结果会被丢弃。

**角色图像。**

- 角色图像的提供者返回 `{ characters: CharacterVisualModel[] }`，其中包括角色创建之前就导入的美术。
- 提供者负责把 ID 规范化。宿主为每个 `characterId` 发出一份带键的 `character.visual@1` 快照。
- 前端按完全相同的键来取，不去猜插件 namespace 或 ID 的后缀。
- 舞台、头像、立绘画廊和在场角色列表都读这些槽位。

### 舞台槽位值

以下是四个舞台槽位的返回值，定义在 `packages/shared/src/extension-points/ui-slot.ts`。每个提供者返回自己声明的 `slot` 对应的对象，不把四个对象打包在一起。没有改动时返回 `previous`，清空槽位时返回 `null`。

四个槽位对象，以及下列演员、`visual` 和选项对象，只接受列出的字段。输出不合法时跳过该提供者，保留前一个有效值，不会因此拒绝整个会话。`I18nText` 是字符串或 locale 到字符串的映射；`MediaRef` 是[媒体库](./media-store.md)返回的引用，不是路径或裸 URL。

#### `stage.backdrop@1`

所有字段都可省略，`{}` 也是合法值。

| 字段      | 类型                 | 必填 | 含义                                                                    |
| --------- | -------------------- | ---- | ----------------------------------------------------------------------- |
| `sceneId` | string               | 否   | 场景标识                                                                |
| `name`    | string               | 否   | HUD 显示的场景名                                                        |
| `ref`     | MediaRef             | 否   | 当前背景图；缺省时使用[背景回退链](#背景回退链resolvebackdrop)          |
| `variant` | `"day"` 或 `"night"` | 否   | 昼夜标记。HUD 只有 `night` 显示月亮，其余情况显示太阳；不能写其他枚举值 |
| `label`   | I18nText             | 否   | HUD 的补充状态文字，不影响背景回退                                      |
| `preload` | MediaRef[]           | 否   | 提前加载的图片列表；schema 没有条数上限，客户端跳过非 `image/*` 引用    |

#### `stage.cast@1`

值是 `{ actors, retainWhenEmpty }`，两项都必须写。

| 字段              | 类型                       | 必填 | 含义                                                                                  |
| ----------------- | -------------------------- | ---- | ------------------------------------------------------------------------------------- |
| `actors`          | 下表对象的数组，最多 64 项 | 是   | 当前舞台上的演员，空数组合法                                                          |
| `retainWhenEmpty` | boolean                    | 是   | `actors` 为空时，`true` 保留上一组立绘并取消高亮；`false` 清空立绘。schema 没有默认值 |

每位演员：

| 字段          | 类型                                                                          | 必填 | 含义                                         |
| ------------- | ----------------------------------------------------------------------------- | ---- | -------------------------------------------- |
| `characterId` | 非空 string                                                                   | 是   | 角色 ID，用同一个 ID 查 `character.visual@1` |
| `displayName` | 非空 string                                                                   | 是   | 显示名                                       |
| `type`        | string                                                                        | 否   | 角色类型                                     |
| `description` | string                                                                        | 否   | 角色说明                                     |
| `active`      | boolean                                                                       | 否   | 是否高亮；全部省略时高亮第一位未退场演员     |
| `exiting`     | boolean                                                                       | 否   | 是否处于退场状态                             |
| `visual`      | `{ variantId?: string, outfit?: string, expression?: string, pose?: string }` | 否   | 请求的立绘变体；四个字段都可省略             |
| `position`    | `left` / `center-left` / `center` / `center-right` / `right`                  | 否   | 请求的站位                                   |
| `transition`  | `none` / `fade` / `slide-left` / `slide-right` / `dissolve`                   | 否   | 立绘过渡方式；省略时客户端用 `fade`          |

#### `stage.dialogue@1`

| 字段                | 类型                             | 必填 | 含义                                                                        |
| ------------------- | -------------------------------- | ---- | --------------------------------------------------------------------------- |
| `turnId`            | string                           | 否   | 所署名的故事回合。给当前正文署名时应填写它；匹配当前 story 回合时才显示名牌 |
| `paragraphSpeakers` | `(string \| null)[]`，最多 80 项 | 是   | 逐段的显示名；`null` 表示旁白或不署名                                       |

例如 `{"turnId":"<story-turn-id>","paragraphSpeakers":["Mio",null,"Rin"]}` 表示三段依次由 Mio、旁白、Rin 署名；`turnId` 填当前故事的回合 ID。正文按空行分段，CRLF 先转 LF，三个以上换行折成两个。正文结束时，段落数必须等于数组长度，否则整份映射不显示名牌。实时映射还必须来自当前回合的预览，不能复用重试前的已提交映射。

#### `stage.choices@1`

| 字段       | 类型                       | 必填 | 含义                                                  |
| ---------- | -------------------------- | ---- | ----------------------------------------------------- |
| `turnId`   | string                     | 否   | 有值时选项只用于匹配的 story 回合；省略时不按回合限制 |
| `scene`    | I18nText                   | 否   | 决策面板的场景文字                                    |
| `recap`    | I18nText                   | 否   | “当前信息”回顾；省略或为空时不显示                    |
| `decision` | I18nText                   | 否   | 当前要决定的问题                                      |
| `choices`  | 下表对象的数组，最多 64 项 | 是   | 选项，空数组合法                                      |

每个选项：

| 字段    | 类型        | 必填 | 含义                                                       |
| ------- | ----------- | ---- | ---------------------------------------------------------- |
| `id`    | 非空 string | 是   | 选项标识                                                   |
| `text`  | string      | 是   | 显示并用于玩家消息的文字；客户端去掉首尾空白，跳过空白选项 |
| `label` | I18nText    | 否   | 补充说明，不替换 `text`                                    |

回合匹配、决策问题的缺省行为与自由输入见[舞台模式](#舞台模式stage-view)。

### Stage music

`stage.music@1` 保存的是“会话背后现在应该放什么音乐”：

```ts
{ trackId?, title?, ref?, loop?, volume?, fadeMs? }
```

它是状态，不是命令。

- 客户端播放 `ref`（一个 `audio/*` 媒体引用）。
- `trackId` 变了，就用交叉淡化换曲。
- 值里没有 `ref` 时保持安静。
- 所以刷新页面、恢复会话或分叉之后，听到的是同一段音乐。提供者再次给出同一首曲子时，也不会从头重放。

细节：

- `loop` 默认是 true。`volume`（0–1）是作者给这首曲子定的音量；玩家自己的音量和静音开关在它之上再起作用。
- 没有话要说的提供者返回 `previous`。这样几个插件可以按声明顺序共用这个槽位：一个播放世界自带的曲目，另一个在世界没有曲目的地方补一首生成的。
- 播放由客户端负责。页面上有别的声音在播（例如一句旁白）时，它把音乐压低；页面隐藏时暂停；浏览器不允许自动出声时，等到第一次点击或按键再开始。
- 玩家的开关在会话头部和“设置 → 通用”里（`audio.musicEnabled`、`audio.musicVolume`）。

内置的 `soundtrack` 插件用世界自带的曲目提供这个槽位。它记录情绪（`music.cue`）和场景（`scene.set`），在槽位被投影时选出曲目。见 [world-data.md](./world-data.md#background-music)。

### Session summary

`session.summary@1` 放的是插件希望玩家“一眼就看到”的东西：当前目标、时间、身上带着什么。

客户端把它显示在当前布局放状态的地方：带文字的面板页签下方，或者场景 HUD 上。所以插件只声明一次，不需要知道布局是什么。

**值的形状。** `{ entries: SessionSummaryEntry[] }`，最多 16 条。每条有 `id`、`label`（`I18nText`）和一个 `kind`：

| `kind`  | 字段                                  | 画成什么                                        |
| ------- | ------------------------------------- | ----------------------------------------------- |
| `text`  | `value` (`I18nText`), `tone?`         | 标签和一行文字                                  |
| `meter` | `value`, `max`, `min?` (0), `tone?`   | 标签、量表和 `value / max`                      |
| `list`  | `items` (`I18nText[]`, ≤24), `total?` | 标签和一排小标签；`total` 更大时在末尾显示 `+N` |

`tone` 是 `info`、`success`、`warning` 或 `danger`。

**写法上的规则。**

- 提供者是一条链：每个提供者返回前面已有的条目，再加上自己的。`@covel/plugin-handlers-utils` 的 `appendSummaryEntries(previous, entries)` 做的就是这件事。
- 条目 ID 加上插件自己的名字作前缀，例如 `inventory.items`。后面出现的同 `id` 条目会替换前面的。
- 保持简短：每个插件一到三条。细节留给插件自己的面板。

```yaml
entry: ./server/index.js
contributes:
  extensions:
    - point: ui.slot@1
      id: summary
      slot: session.summary@1
      order: 20 # lower runs first and shows first
      watch:
        - quests # own namespaces whose commits refresh the summary
```

```js
import { appendSummaryEntries, labelText } from "@covel/plugin-handlers-utils";

export default function (covel) {
  covel.provideExtension("ui.slot@1", "summary", {
    async handler({ previous }, ctx) {
      const quests = await ctx.pluginData.list("quests");
      return appendSummaryEntries(previous, [
        {
          id: "quest.current",
          kind: "text",
          // English here; `locales/<locale>.yaml` translates it under `messages`.
          label: labelText(ctx, "Objective"),
          value: quests[0]?.value?.name ?? "",
        },
      ]);
    },
  });
}
```

内置的 `world-time`（当前时间）、`core-quest`（下一个未完成的目标和进度）和 `inventory`（随身物品）都是这样提供条目的。

**数据归属的几条规则。**

- 面板的数据绑定和 action 的 `pluginId` 字段只能指向面板所属的插件。加载器拒绝指向别的插件、或者动态算出来的目标。
- 插件之间要共享数据，用内核槽位或 World Model。
- 一个组件在自己的 namespace 还没有记录时就要读内核数据，必须设置 `alwaysRender: true`。
- 历史消息里的面板按保存下来的 `stateOverride` 渲染。它不订阅实时的 namespace、任务或整个会话上下文。折叠起来的历史卡片不挂载。
- 实时的插件 namespace 在前端只有一个权威来源：外部的 plugin-data store。会话 reducer 只保留构建历史消息卡片快照所需的 `message` namespace，以及派生出来的持久任务执行步骤。无关 namespace 的更新不会替换会话上下文的值。

### 挂起恢复面板

agent runtime 调用 `suspend` 之后，会话工具条上出现一个徽标。点它打开“挂起的执行”对话框（`suspensions-panel.tsx`）。

每张卡片以 `reason` 为标题，并按 `resumeSchema` 选择作答的控件（`suspension-input.ts`）：

| `resumeSchema`                         | 控件                                |
| -------------------------------------- | ----------------------------------- |
| `boolean`                              | 是 / 否按钮                         |
| `enum`，或 `oneOf` 里的 `const`        | 选项按钮                            |
| `string`                               | 文本框                              |
| 维度值编辑器能覆盖的对象 / 数字 schema | 表单（复用 `DimensionValueEditor`） |
| 没有 schema，或没有控件能覆盖          | “高级”折叠区里的原始 JSON 文本框    |

### 加载更早消息与执行状态

- 向上滚动加载更早的一页失败时，消息区顶部显示翻译后的失败提示和“重试”按钮。成功后提示消失。
- 执行时间线遇到客户端不认识的 runtime 状态时，显示中性的“未知状态”标签，并在控制台记录一次。它不会被画成“已完成”。
