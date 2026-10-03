# 插件 UI 与交互运行时指南

这份文档总结 Covel 当前插件 UI 与交互的推荐做法，并先明确最重要的架构原则：

- **Covel 框架是独立的 Agent 编排框架。**
- **插件包是功能与体验的完整承载单元。**
- **插件适配优先在插件包内完成。**
- **大型框架改动先确认，再进入实现。**

适用范围：

- 右侧面板 `ui.right`
- 聊天流内插件消息面 `ui.message`
- 通用表单 / 选项提交协议
- 插件数据写入与前端渲染联动

## UI component reference

查组件时先翻 [docs/reference/ui-components.md](../reference/ui-components.md) —— 框架注册的全部 json-render 组件（Stack / Row / Card / FilterContainer / GraphCanvas …）以及各自的关键 props 都在那张目录里。本指南聚焦使用策略与交互约定，具体到某个组件叫什么、接什么参数，优先查目录。面板装配链路（发现、合并、空态、i18n）仍然在 [docs/reference/ui-panels.md](../reference/ui-panels.md)。

---

## 1. 架构原则

### 1.1 框架定位

Covel 框架承担的是 **Agent 编排层**。

它的职责是：

- 加载插件 manifest、prompt、tools、UI spec
- 调度 runtime 执行顺序
- 管理 session、turn、phase、SSE、snapshot
- 提供通用数据通道：`plugin_data`、`turn_messages`、`session state`
- 提供通用 UI 基础组件：`Card`、`Text`、`Row`、`Grid`、`Badge`、`Button`、`Input`、`GraphCanvas`

这层能力对所有插件都成立，它服务的是“插件生态的运行”，而不是某一个具体插件。

### 1.2 插件定位

插件包承担的是 **功能、数据结构、交互与 UI 体验的完整适配层**。

一个插件包内优先承载：

- 功能逻辑
- 提示词
- 本地工具
- `plugin_data` 结构
- `ui.message / ui.right / ui.left`
- 插件自己的文案、布局、动作设计

这条原则意味着：

- guide 的建议样式属于 `guide`
- codex 的摘要与图鉴属于 `codex`
- 关系图谱的命名、面板说明、节点呈现属于 `npc-graph`

### 1.3 适配位置

插件适配优先放在插件包内完成。

推荐顺序：

1. 先改插件自己的 prompt / tool / handler
2. 再改插件自己的 `ui/*.json`
3. 再改插件自己的 `plugin_data` 结构
4. 最后才评估是否需要新增框架级原语

这条顺序可以保证：

- 框架保持稳定
- 插件保持独立演进
- UI 风格、交互策略、数据组织都由插件自己负责

### 1.4 框架变更门槛

大型框架改动先确认，再进入实现。

这里的“大型框架改动”包括：

- 新的通用协议
- 新的 store 表 / 全局 schema
- 新的 runtime 生命周期语义
- 新的全局 UI slot / 渲染原语
- 对所有插件都会生效的行为变化

这类改动的工作流是：

1. 先说明为什么需要升级到框架层
2. 说明对现有插件的影响范围
3. 说明插件内适配方案为什么已经不够
4. 获得确认后再改框架

### 1.5 工具调用方向

Covel 当前的工具层分成两类：

- `tools.builtin`：框架提供的通用 building blocks
- `tools.plugin`：插件在 `entry` 模块里注册、自己维护、自己测试的本地工具

推荐选择顺序：

1. 通用、重复、跨插件复用的操作，直接复用 builtin
2. 插件专属的数据 schema、批量写入、RAG 检索、图谱维护、图鉴整理，定义 local tool
3. 多个插件长期复用且契约稳定的能力，再提案升级为框架级 builtin

当前代码状态：

- `apps/server/src/routes/api/bootstrap.ts` 会统一注册 builtin 工具
- builtin 插件的 `entry` 模块在启动时执行，其 `covel.registerTool()` 注册的工具随即可用；community 插件延迟到审批通过后激活
- local tool 访问权限按 `pluginId` 隔离，调用方只能访问自己声明的 local tool
- local tool 与 deterministic handler 当前可以使用注入的 `store` 完成插件包内批量写入

### 1.6 插件工具目录归属

插件自己的工具保持在插件目录内组织。

推荐位置：

- `plugins/<plugin-id>/tools/*.js`
- `plugins/<plugin-id>/runtimes/<runtime-id>/tools/*.js`

声明方式：

- 在 `entry` 模块里 `covel.registerTool()` 注册，并在 `PLUGIN.md` 的 `tools.plugin` 列出名字
- 路径解析以插件根目录为基准

当前框架会校验路径边界，确保工具文件位于插件包目录内。

### 1.7 插件测试要求

每个插件至少覆盖四类测试：

1. manifest / runtime 能被框架发现并正确加载
2. local tool 的参数 schema、持久化写入、返回结构符合预期
3. handler 或 agent runtime 的核心输出形状稳定
4. `plugin_data` 与 `ui.message / ui.right` 的契约稳定

当前 core 插件已经有这类样例：

- `plugins/codex/tests/codex.test.js`
- `plugins/npc-graph/tests/npc-graph.test.js`
- `packages/runtime/tests/session-kernel.test.ts`

---

## 2. 基本边界

### 2.1 框架负责什么

框架负责：

- 通用编排
- 通用状态与数据通道
- 通用基础组件
- 通用交互协议

### 2.2 插件负责什么

插件负责：

- 功能定义
- 体验设计
- 交互细节
- 业务数据组织
- 插件 UI

### 2.3 当前推荐实践

当前开发里优先采用这条判断：

- 能在插件包内解决的事情，优先放在插件包内解决
- 需要跨插件复用、稳定长期存在、能形成通用原语的事情，再进入框架层

---

## 2. UI 通道

插件的内容通过下面几条通道出现在界面上。每条通道都是通用的：框架不认识具体插件，只认通道的契约；风格方案（主题包）决定每条通道画成什么样，所以走了通道的内容自动跟随所有方案。先用 [2.6 怎么选](#26-怎么选) 找到合适的通道，再看对应小节。

### 2.1 主叙事流

主叙事流来自 runtime 的 `outputKind: story`。

用途：

- narrator 主剧情
- 玩家输入
- 少量必须进入主时间线的叙事文本

推荐：

- 叙事层只放真正需要玩家阅读的文本
- 初始化提示、后台跟踪摘要、结构化建议优先放到 `system` 或插件自己的 `ui.message`

### 2.2 插件消息面 `ui.message`

`ui.message` 适合高频、轻量、结构化的聊天内插件 UI。

用途：

- guide 建议卡
- codex 本轮新增术语摘要
- 小型任务卡、风险提示卡、投票卡、局部操作卡

推荐：

- 内容短
- 信息密度高
- 细节摘要克制
- 详情跳转或引导用户去右侧 panel 深看

### 2.3 插件侧栏 `ui.right`

`ui.right` 适合持续存在、可浏览、信息更完整的插件面板。

用途：

- 角色面板
- 图鉴
- 关系图谱
- 世界维度

推荐：

- 用它承接 message 面中被压缩掉的细节
- 面板命名直接反映数据模型
- 例如 `人物图谱` 改成 `关系图谱`，更贴合“角色 / 群体 / 势力关系”
- activity-bar 默认取 `label` 前两个汉字；若截断后识别力弱（如 `核心记忆` → `核心`），在 spec 顶层显式声明 `shortLabel`（如 `{ "zh": "记忆", "en": "Memory" }`），见 [ui-panels.md](../reference/ui-panels.md#activity-bar-短标签)

### 2.3.1 选项

给玩家选的东西只有一种画法：`.ui-choice`。走下面任意一条路都会得到它，并自动支持数字键 1–9：

- 插件 spec 里用 `ChoiceList` / `Choice`（点击动作通常是 `draftMessage`，进入待发送区）
- 工具发出内核的 `choice` 交互块（必须回答的选择题，框架转成 `ChoiceList`）
- `CandidateList`（同一段文字的多个版本，点击即采用）
- `stage.choices@1` 槽位（舞台视图的决策面板）

不要用 `Card` + `Button` 自己拼选项：那样在各套风格方案里不会变样，数字键也不认。

### 2.4 状态摘要 `session.summary@1`

「一眼就该看到」的东西——当前目标、时间、行囊——由插件往 `session.summary@1` 槽位里放一到三行（文字、量表或短列表）。框架把它放在当前方案显示状态的位置：文字页签布局在右侧面板页签下方，场景布局在场景图上的 HUD 里。插件不需要知道当前是哪种布局。

写法见 [ui-panels.md 的 Session summary](../reference/ui-panels.md#session-summary)。细节仍然放在插件自己的 `ui.right` 面板里；摘要只是一瞥。

### 2.5 自定义组件 `webview`

catalog 组件画不出来的界面（地图、解谜、棋盘、小游戏）用 `ui.right` 的 `webview`：插件带一个单文件 HTML，在沙箱 iframe 里运行，用 `window.covel` 读自己的数据、调用自己的动作。声明 `surfaces: ["panel", "stage"]` 后，同一个组件也挂在舞台视图的决策区。完整协议见 [插件扩展契约](../reference/plugin-extensions.md#自定义组件与挂载)。

`webview` 能做什么：

- `window.covel.subscribe(({ data, locale, locked, context, uiState, theme }) => …)`：`data` 是本插件声明 namespace 的数据，后端一提交就推过来；舞台上的 `context` 带当前回合和当前选项
- 跟随风格方案：`theme` 带当前方案的明暗和一组配色、圆角、字体，同时以 `--covel-*` CSS 变量的形式出现在组件文档上（`color: var(--covel-foreground)`），玩家换方案时自动更新
- `window.covel.invoke("invokeRuntime" | "invokePluginAction" | "invokeCommand" | "emitEvent", …)`：触发自己的后端逻辑或发出自己声明的领域事件
- `window.covel.invoke("draftMessage", { text })`（右侧面板）：把一句话放进输入框的待发送区，玩家确认后发出；舞台上是 `sendMessage({ text })`
- `window.covel.invoke("setUiState", { value })`：记住草稿这类临时界面状态

需要大画面时不用另做一份：右侧面板的每个插件面板都能「放大」到大对话框里，`webview` 在那里占用约 72vh 高。

目前做不到的：

- 沙箱里加载不了宿主的字体文件，`--covel-font-*` 只在系统装有对应字体时生效，要写回退字体
- 挂载位置只有右侧面板（含放大后的对话框）和舞台决策区；想放到别处（例如盖在场景图上）需要宿主新增位置

### 2.6 怎么选

| 想做的事                                     | 用什么                                                        | 显示在哪                                | 要写什么                 |
| -------------------------------------------- | ------------------------------------------------------------- | --------------------------------------- | ------------------------ |
| 玩家要读的故事                               | `outputKind: story` 的 runtime                                | 主叙事流                                | 提示词                   |
| 聊天里的结构化内容（建议、摘要、提示）       | `ui.message` + catalog 组件                                   | 聊天流，跟着回合走                      | JSON spec                |
| 给玩家选的选项                               | `ChoiceList` / `Choice`，或内核 `choice` 交互块               | 聊天流；舞台视图的决策面板              | JSON spec 或一次工具调用 |
| 必须回答才能继续的表单、确认                 | `interaction.request`（`form` / `choice` / `confirmation`）   | 聊天流，回答前锁住输入                  | 工具调用                 |
| 可以随时翻看的完整数据（图鉴、背包、关系图） | `ui.right` + catalog 组件                                     | 右侧面板的一个页签                      | JSON spec                |
| 一眼就该看到的状态（目标、时间、行囊）       | `session.summary@1` 提供者                                    | 状态条或场景 HUD                        | `entry` 里十几行         |
| 场景图、立绘、谁在说话                       | 内核槽位 `stage.*` / `character.visual@1`                     | 舞台视图、场景背景、HUD、头像           | `entry` 里的提供者       |
| 数值量表、随身物品                           | 世界的角色 schema（带范围的 `stats`、`equipment` 字符串数组） | 状态条或场景 HUD                        | 不用写插件               |
| catalog 画不出来的界面（地图、解谜、小游戏） | `ui.right` 的 `webview`                                       | 右侧面板；声明 `stage` 后也在舞台决策区 | 一个 HTML 文件           |

判断顺序和 [1.3 适配位置](#13-适配位置) 一致：先看 catalog 组件够不够，不够再用 `webview`，都放不下再考虑让框架加新通道。

### 2.7 交互闭环

界面上的点击要变成游戏里的事，再变回界面上的变化。框架已有的接口：

**界面 → 插件**（catalog 组件的 `on.click.action`，或 `webview` 的 `window.covel.invoke`）

| 动作                 | 效果                                                                           | 聊天消息块 | 右侧面板 | 舞台挂载 |
| -------------------- | ------------------------------------------------------------------------------ | ---------- | -------- | -------- |
| `draftMessage`       | 把一句话放进待发送区，玩家可以再补充，一起发出                                 | ✓          | ✓        | —        |
| `sendMessage`        | 直接作为玩家消息发出，开始新回合                                               | ✓          | —        | ✓        |
| `selectChoice`       | 回答一个内核选择题（框架生成的选择题块自带，插件不用自己绑）                   | ✓          | —        | —        |
| `invokePluginAction` | 调插件的 RPC action：立即执行、立即写入，不开回合、不调模型                    | ✓          | ✓        | ✓        |
| `invokeRuntime`      | 触发 `trigger.type: manual` 的 runtime：写入走 proposal 提交，多条记录一起成败 | ✓          | ✓        | ✓        |
| `invokeCommand`      | 执行清单里声明的玩家命令（`/bag` 这类）                                        | ✓          | ✓        | ✓        |
| `emitEvent`          | 发出本插件声明的领域事件；订阅它的 runtime 以后台任务执行                      | ✓          | ✓        | ✓        |

`invoke*` 和 `emitEvent` 自动绑定当前插件，不能改写成别的插件。

社区插件第一次发某个事件时，玩家要授权两样：发这个事件，以及运行订阅它的社区 runtime；内置插件不需要。订阅者是后台任务，会话没有可用的模型凭据时不会执行。

`emitEvent({ topic, data })` 和 `invokeRuntime` 的区别：`invokeRuntime` 指名一个 runtime，同步跑完并返回结果；`emitEvent` 只说「发生了什么」，由订阅者决定做什么——订阅者可以属于别的插件，各自在后台执行、各自提交，点击立刻返回。topic 必须写在本插件的 `contributes.events` 里（界面专用的可以设 `advertise: false`，不让叙事模型看到），`data` 按它的 schema 校验。

**插件 → 界面**

- 写 `plugin_data`：提交后 `plugin-data.changed` 推到前端，绑定该 namespace 的 spec 和 `webview` 重新渲染；声明了 `watch` 的槽位提供者重新投影
- RPC 返回 `clientAction: { type: "open-plugin-panel", panelId }`：让前端打开这个插件的面板
- 发 `notification` 或 `ui.message` 块：出现在聊天流

**插件 ↔ 插件、插件 ↔ 叙事**

- 领域事件：`contributes.events` 声明 topic 和 schema，叙事 runtime 用 `emit-event` 发出，其他插件用 `trigger.type: event` 的 runtime 接；槽位提供者可以用 `preview` 在提交前先行显示
- 同回合取上游结果用 `io.inputs`，跨插件请求/响应用 services（见 [选择通信方式](../reference/plugin-extensions.md#选择通信方式)）

把它们连起来，一个「可点击的地图」是这样的（可运行的版本在 [`tests/third-party/clickable-map`](../../tests/third-party/clickable-map/README.md)）：

1. 地点和玩家位置存在插件的 `plugin_data`（例如 `locations` namespace），世界包可以预置
2. `ui.right` 声明一个 `webview`，用 SVG 或 Canvas 画地图，`subscribe` 拿到 `data` 就重画
3. 点击一个地点 → `invoke("emitEvent", { topic: "map.location-selected", data: { locationId } })`。地图插件自己订阅这个 topic 的 runtime 校验能不能去、更新位置；场景、遭遇这类别的插件也订阅它，各自响应
4. 各订阅者提交后数据推回来，地图重画
5. 想让「去码头」成为玩家的一次行动而不是瞬移，用 `draftMessage`（右侧面板）或 `sendMessage`（舞台）把这句话交给玩家，让叙事来处理
6. 侧栏太窄时，玩家点面板右上角的「放大」在大对话框里操作

「解谜」同理：谜面和进度在 `plugin_data`，`webview` 画棋盘或机关，每一步用 `invokePluginAction`（即时反馈）或 `invokeRuntime`（要和别的状态一起提交）校验，解开时由 runtime 的结果发出事件（或界面直接 `emitEvent`），由叙事或任务插件接着推进。答案之类不该让玩家看到的数据放在 `_hidden.*` namespace，只在后端校验。

### 2.8 现有边界

做更复杂的面板前先知道宿主现在给了什么、没给什么。下面这些是当前的限制，不是设计上的禁止；确实需要时按 [1.4 框架变更门槛](#14-框架变更门槛) 提出：

| 方面       | 现在                                                                               | 意味着                                                                 |
| ---------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 挂载位置   | 聊天消息块、右侧面板页签、舞台决策区；状态条 / 场景 HUD 只接受 `session.summary@1` | 想盖在场景图上的面板，需要宿主新增位置                                 |
| 面板尺寸   | 侧栏宽度由玩家拖动决定；任何插件面板可以放大到大对话框（`webview` 约 72vh 高）     | 大画面组件不必另做，但没有常驻的中央大区域                             |
| 外观       | catalog 组件自动跟随风格方案；`webview` 通过 `theme` 和 `--covel-*` 变量跟随       | 自绘组件用这些变量即可；宿主字体文件进不了沙箱                         |
| 回合上下文 | 舞台挂载的 `context` 带当前回合和选项；右侧面板的 `context` 为空                   | 侧栏组件要判断「这是哪一回合的结果」得自己在数据里带 `turnId`          |
| 界面事件   | `emitEvent` 把事件交给订阅者后台执行，不返回它们的结果                             | 需要立刻拿到结果的操作用 `invokeRuntime` / `invokePluginAction`        |
| 内核槽位   | 槽位名是封闭集合，每个槽位有固定的数据模型                                         | 新的「框架来画」的内容需要改内核契约；「插件自己画」的内容走 `webview` |

---

## 3. 数据通路

### 3.1 推荐写法

插件 runtime / tool 先写 `plugin_data`，前端再通过 `ui spec` 消费。

推荐命名：

- `entries`：稳定词条 / 实体数据
- `message`：聊天内临时摘要数据
- `nodes / edges / index`：图谱类数据

### 3.2 典型链路

#### Guide

1. runtime 分析叙事引擎输出
2. tool 生成情境回顾、当前决策与 3–6 条短句
3. tool 把 `recap`、`decision`、`prompt1Text`、`prompt1Label` 等写入 `plugin_data[guide][message]`
4. `plugins/guide/ui/guide-block.json` 从 `message` namespace 读取并渲染；`stage.choices@1` 槽位把同一组短句交给舞台模式

#### Codex

1. runtime 从 narrator 文本提取术语
2. handler 把完整词条写入 `plugin_data[codex][entries]`
3. 同时把本轮摘要写入 `plugin_data[codex][message]`
4. `ui.message` 只显示关键词摘要
5. `ui.right` 显示完整图鉴

---

## 4. 交互协议

### 4.1 通用 `interaction.request`

框架提供通用交互协议：

- `form`
- `choice`
- `confirmation`

这些协议适合：

- 角色创建
- 多步确认
- 结构化输入

### 4.2 `submitBehavior`

交互块可以声明通用提交行为：

```ts
submitBehavior: {
  echoFilledNarrative?: boolean
  immediate?: boolean
}
```

字段语义：

- `echoFilledNarrative`（默认 `true`）：把填充后的叙事作为玩家气泡回显到聊天流。设为 `false` 时只用作下一轮的隐藏输入，不出现在对话里。
- `immediate`：玩家提交后立即关闭表单并继续执行。

这条协议是框架级能力，不绑定任何具体插件。

### 4.3 聚合发送

当前推荐体验：

- 插件建议点击后进入“待发送区”
- 玩家可以继续补充自定义输入
- 底部发送按钮一次性把建议草稿 + 手写说明一起发出

这套机制适合未来更多插件同时出现：

- guide 选择
- 任务确认
- 道具选择
- 小型表单输入

### 4.4 玩家选择回放（自动）

任何走 `draftMessage` / `selectChoice` / `selectSuggestion` 进入"待发送区"的交互，
框架会在玩家点击底部发送时自动：

1. 将每个 draft 按 `sourceBlockId`（即原 `StreamMessage.id`）汇总；
2. 调用内部 `submitBlock(sourceBlockId, { _kind: "selection", _label, items })`，把选择持久化到浏览器 app-KV 的 `submittedBlocks` store；
3. 重新渲染该 block 时，框架追加一行 `你的选择：xxx` 的 `SubmittedSelectionFooter`。

`form` 类提交（`submitForm` → `submitInteraction`）走另一条路径：原始字段值已经直接烘焙进 disabled 表单 spec，所以框架**不会**再额外渲染 footer。

插件作者无需特殊适配——只要按 [`guide/ui/guide-block.json`](../../plugins/guide/ui/guide-block.json) 的方式使用 `draftMessage` 等动作，玩家选择就会被自动记录与回放。

---

## 5. Message UI 设计建议

### 5.1 Guide

推荐结构：

- 顶部一段场景回顾和当前要做的决定
- 中间一个 `ChoiceList`，每条建议是一个 `Choice`（`title` 写可直接执行的行动，`tag` 写策略类别）
- 底部一个自定义行动输入区

给玩家选的东西都用 `ChoiceList` / `Choice`，不要用 `Card` + `Button` 自己拼：选项的排法（带标签的卡片、编号列表、键帽）由风格方案决定，数字键快捷选择也只对 `Choice` 生效。

推荐约束：

- 三类建议足够稳定
- 每类建议数保持 1-3
- 词句直接可执行

### 5.2 Codex

推荐结构：

- 聊天流里只给“本轮新增术语摘要”
- 右侧图鉴保留完整内容

推荐摘要内容：

- 术语标题
- 类型 badge

推荐详细内容存放位置：

- `ui.right` 图鉴面板

---

## 6. 图鉴抽取建议

### 6.1 记录什么

推荐记录：

- 地点
- 物件
- 世界设定
- 技法 / 阵法 / 术式

### 6.2 内容写法

推荐写成术语解释体：

- `百灵沼泽：当前剧情中的关键地点，与眼前事件直接相关。`
- `佩剑：当前剧情里明确出现的物件，可作为线索或行动资源。`

这类内容适合图鉴。

### 6.3 聊天内摘要

聊天内摘要只列新增术语标题即可。

完整解释放右侧图鉴。

---

## 7. 图谱边界

### 7.1 当前图谱适合什么

当前 `npc-graph` 模型适合：

- 个人 `individual`
- 群体 `group`
- 势力 `faction`

以及它们之间的关系边。

### 7.2 当前图谱不承担什么

术语表、地点百科、物件百科更适合放在 codex。

这意味着：

- `codex = 术语 / 词条 / 世界知识`
- `graph = 角色 / 群体 / 势力关系`

后续如果需要“世界图谱”，推荐新建独立数据模型，而不是直接把 codex 条目塞进 NPC 图谱。

---

## 8. UI Spec 编写建议

### 8.1 推荐

- 小而稳定的 message 面优先用固定字段
- 高频 UI 优先用浅层数据结构
- `ui.message` 与 `ui.right` 分开设计
- `emptyState` 永远提供清晰说明

### 8.2 当前经验

对于高频消息面：

- 直接写 `decision`
- `prompt1Label`
- `prompt1Text`
- `item1Title`
- `item1Category`

这类固定字段最稳定。

对于右侧面板：

- 使用 `repeat.statePath`
- 数据结构可以更完整

### 8.3 跟随风格方案

玩家可以在设置里切换风格方案（主题包），每套方案的配色、字体、圆角甚至界面结构都不同。插件 UI 不需要为每套方案各写一份：

- **用 catalog 组件表达语义，不写外观。** `Section`、`Badge`、`Alert`、`Progress`、`Choice` 等组件的外观来自主题 token 和 `.ui-*` 语义 hook，换方案时自动跟着变。用 `tone` / `variant` 这类语义 props 表达「警告」「成功」「次要」，不要在 spec 里指定具体颜色、字体或圆角。
- **声明内容，不声明位置。** `ui.right` 的面板在一种布局里是纵向图标页签，在另一种里是顶部文字页签；`surfaces: ["panel", "stage"]` 的面板在舞台视图里会另外挂载一次。位置由布局决定，spec 只需要给好 `label`、`shortLabel`、`icon`、`group`。
- **`shortLabel` 和 `icon` 都要给。** 文字页签显示 `shortLabel`（没有则显示完整标签），图标页签显示 `icon` 加截断后的标签；两者都声明才能在所有布局下好认。
- **不要假设面板宽度或明暗。** 面板宽度随布局和玩家拖动变化，内容用可换行、可滚动的结构；图片和图表不要依赖深色底。
- **「一眼就该看到」的状态走状态摘要槽位。** 当前目标、时间、行囊这类内容通过 `session.summary@1` 提供一到三行，框架会把它放到当前方案显示状态的位置（面板页签下方或场景 HUD）；不要为此在面板里再做一个常驻卡片。写法见 [ui-panels.md 的 Session summary](../reference/ui-panels.md#session-summary)。
- **场景图、立绘走内核槽位。** `stage.backdrop@1`、`stage.cast@1`、`character.visual@1` 的提供者不需要知道当前布局：舞台视图和 `backdrop: "scene"` 的文本视图读的是同一份槽位数据。
- **`webview` 自带组件用宿主给的方案变量。** iframe 是隔离的，宿主的样式表进不去，但消息桥会把当前方案的明暗、配色、圆角和字体交给组件，并写成 `--covel-*` CSS 变量。用这些变量上色，不要写死颜色；见 [2.5 自定义组件](#25-自定义组件-webview)。

自查方法：在设置 → 外观里依次切到「面板」「书卷」「舞台」，各看一眼自己的面板和消息块。

### 8.4 热更新

当前 `/api/ui-specs` 已经改成按请求同步最新插件 UI spec 到 store，再从 store 返回。

效果：

- 修改插件 `ui/*.json`
- 刷新页面
- 前端拿到最新 spec

---

## 9. Session 起始流程建议

推荐默认插件集：

- `pregame`
- `world-init`
- `narrator`
- `char-creator`

扩展插件建议手动启用：

- `guide`
- `codex`
- `npc-graph/extractor`

这样起始体验更干净：

1. 世界选择
2. Session prep
3. 角色创建
4. 自动进入 `playing`
5. narrator 自动给开场场景
6. 其他插件按需补充

---

## 10. 给插件作者的直接建议

如果你正在写一个新插件：

1. 先决定信息属于 `story`、`ui.message` 还是 `ui.right`
2. 先设计 `plugin_data` 结构，再设计 spec
3. 聊天面只放摘要和动作
4. 右侧面放详情和浏览
5. 表单 / 选择 / 确认优先用框架通用协议
6. 样式放在插件自己的 spec 里完成，框架只补通用基础组件变体

这套方式最符合 Covel 的基本原则：**框架编排，插件定义体验。**
