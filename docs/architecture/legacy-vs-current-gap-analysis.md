# 旧项目与当前 `covel` 的差异分析

更新时间：`2026-03-26`

这份文档只做一件事：把 `../ai-gamestudio-dev` 的成熟能力，和当前 `covel` 的真实落地状态对齐，明确还差什么。

## 结论先说

当前 `covel` 已经有更清晰的模块边界，但整体能力还没追上旧项目。

- 旧项目强在：完整玩法闭环、前端工作台成熟、插件/块/UI/状态联动完整。
- 当前项目强在：底层拆分更现代，`model-gateway` / `flow-engine` / `package-runtime` 的边界更干净。
- 当前项目弱在：主链路没有完全装配，前端还停留在“最小宿主”，很多能力只有骨架，没有产品化。

## 总体对照

```text
旧项目
  world/project -> prompt assembly -> plugin agent -> block dispatch -> frontend renderer -> resume

当前 covel
  world/session -> flow-engine -> model-gateway/command-system -> SSE -> web host
  但 context / renderer / package-owned resume / rich workspace 还没完全接上
```

## 后端主链路差异

### 旧项目已经有的

- 双阶段回合：叙事 LLM + 插件 Agent。
- 明确 Hook：`pre_model_input`、`post_model_output`、`frontend_action`、`post_dispatch`。
- 插件工具循环：`emit`、`db_read`、`db_log_append`、`db_log_query`、`db_graph_add`、`execute_script`。
- block 校验与分发：`emit.items` -> schema 校验 -> handler -> 前端渲染。
- 插件启用合并：`required`、world 默认插件、用户开关、依赖补全、`supersedes`。
- runtime settings / plugin storage / archive / memory / observability 都有明确入口。

### 当前 `covel` 还差的

- `context-graph -> prompt-graph -> flow-engine` 还没成为稳定主链路。
- package command 已经进链路，但 context provider、renderer provider、artifact type 还没有同等深度。
- block response 仍偏“泛型恢复”，还没有完全变成 package-owned state machine。
- provider/profile/binding 还处在过渡态，离 `Connection Profile + Task Preset + World/Session taskBindings` 还有距离。
- `image / speech / transcription` 这类 capability 还没形成统一 provider kernel。

## 前端差异

### 1. 产品形态

旧项目前端是“游戏工作台 + 编辑器 + 调试台”三合一。

- 有项目列表页。
- 有项目编辑页。
- 有调试表格页。
- 还有大量面向玩法的独立面板。

当前 `covel` 前端更像“受信任宿主 + 会话工作区”。

- 主入口是单页工作台。
- 重点放在 world / session / preset / timeline / block。
- 更强调运行时推进，而不是完整的项目编辑器生态。

从代码形态上看，这个差异非常明显：

- 旧项目从 `frontend/src/App.tsx` 开始就是 `ProjectListPage`、`ProjectEditorPage`、`DebugTablesPage` 的多页面结构。
- 当前 `covel` 的 `apps/web/src/App.tsx` 基本上是一个单页工作台，把世界、会话、时间线、预设、归档、trace 都堆在一个宿主里。

这意味着旧项目面向的是“完整创作与运行工作台”，当前项目面向的是“最小可运行宿主”。

### 2. 页面与工作区深度

旧项目有很完整的前端面：

- `ProjectListPage`
- `ProjectEditorPage`
- `DebugTablesPage`
- `GamePanel`
- `CharacterSheetRenderer`
- `StoryImageRenderer`
- `PluginPanel`
- `ModelConfigPanel`
- `RuntimeSettingsPanel`
- `ArchiveRestoreModal`
- `DebugLogPanel`
- `QuestPanel` / `EventPanel` / `CodexPanel` / `WorldStatePanel`

当前 `covel` 的前端能力集中在：

- world / session 创建与切换
- timeline 渲染
- slash command
- preset 编辑
- archive / trace 摘要
- 少量 host block renderer

也就是说，旧项目是“全功能桌面式工作台”，当前项目还是“精简型宿主工作台”。

更直白一点说：旧项目有很多“设置页 / 配置页 / 状态页 / 调试页”，当前 `covel` 还没有把这些产品面真正做出来。

如果按用户体感来描述：

- 旧项目像一个完整 IDE / GM 控制台。
- 当前项目更像一个还没长出侧边能力面的原型工作区。

### 2.1 设置面差距

旧项目前端里，设置不是一个单点面板，而是一整套系统：

- model 配置与连接设置。
- runtime settings。
- plugin 启用与冲突控制。
- project / world / session 级别的参数编辑。
- 快捷动作和运行时开关。

当前 `covel` 只有更轻量的 preset / session 绑定思路，离“全局设置台”还差很多。

更具体地说，旧项目至少有这些设置类产品面：

- 模型配置面板。
- 运行时设置面板。
- 插件启用与冲突处理面板。
- 项目级配置与编辑页。
- 会话级切换与操作栏。
- 图像生成相关入口。
- 快捷动作面板。

而当前 `covel` 里真正已经成形的设置面，主要只有：

- preset 列表。
- preset 的最小编辑表单。
- session 绑定 preset。

而且这个 preset editor 目前还是非常薄的：主要改 `model / enabled / isDefault`，离旧项目那种“按运行时语义组织设置”的层次还差得远。

### 2.2 状态面差距

旧项目把状态拆得非常细，前端能直接看到很多运行时事实：

- world state。
- scene state。
- character / party 状态。
- quest / event / codex 状态。
- notification 状态。
- token / cost 状态。
- debug log 和执行轨迹。
- block interaction / pending block 状态。

当前 `covel` 还主要是：

- 世界列表。
- 会话时间线。
- pending block。
- archive / trace 摘要。

所以你会感觉“几乎什么都没有”，不是错觉，而是当前宿主还没把这些状态产品化。

从状态管理粒度上看，旧项目拆得明显更细：

- `sessionStore` 负责消息流、stream status、pending blocks、phase、plugin progress、plugin summary。
- `gameStateStore` 负责角色、world state、事件、任务。
- `pluginStore` 负责插件启用态、依赖、冲突。
- 还有 `tokenStore`、`notificationStore`、`blockSchemaStore`、`uiStore`、`messageImageStore` 等专门 store。

当前 `covel` 的前端状态明显更轻：

- `WorkspaceState` 主要只有 `timeline`、`pendingBlock`、`lastTraceId`。
- `WebState` 也只是 `timeline`、`pendingBlocks`、`requestStates`、`errors` 这一层。

这种设计更简单，但它也直接解释了为什么你会觉得前端“空”：很多旧项目里独立存在的状态域，在当前项目里还没有被建模成前端产品对象。

### 2.3 状态可视化差距

旧项目前端不仅“内部有状态”，而且“状态能看见”：

- `WorldStatePanel`
- `CharacterPanel`
- `QuestPanel`
- `EventPanel`
- `CodexPanel`
- `NotificationPanel`
- `DebugLogPanel`
- `TokenUsageBar`

这些组件共同形成了一个很重要的能力：玩家和开发者都能直接看到系统到底在发生什么。

当前 `covel` 在这方面只有初级形态：

- timeline
- pending interactive block
- archive summary
- trace summary

这还不足以支撑复杂 RPG 运行时，因为你看不到：

- 世界状态是否变化。
- 事件树怎么推进。
- 角色数据怎么变化。
- 任务状态怎么推进。
- 当前 package / capability 做了什么。
- 一轮执行的 phase 和副作用是什么。

### 3. 状态面板差距

旧项目前端把运行时状态拆得很细：

- 插件启用态
- token / cost
- game state
- scene / quest / event
- notification / debug log
- block interaction 状态
- session hydration / local storage 兜底

当前 `covel` 前端已经有：

- timeline
- pending block
- trace summary
- archive summary

但还缺：

- 更完整的实时状态侧栏。
- 对 session / world / task binding 的可视化编辑。
- 对模型路由、preset 选择、provider profile 的可见控制面板。
- 更细的调试日志和执行过程拆解。

这一点对你原来的产品体验影响特别大：旧项目里“系统的内脏是外露的”，现在 `covel` 的内脏还基本都藏在 runtime 里，没有形成前端操作面。

### 4. Block 渲染差距

旧项目的 block 体系更完整：

- 有大量领域 block renderer。
- 有 schema 驱动的 `GenericBlockRenderer`。
- 有 renderer 优先级：自定义 renderer -> schema -> fallback。
- block 既影响前端展示，也能触发后端状态变化和恢复。

当前 `covel` 的 block 体系更收敛：

- 已有宿主 block 容器。
- 已有少量 host known block：`choices`、`dice_result`、`image_card`、`audio_clip`。
- package renderer 只有部分动态装载能力。

而且旧项目的 block 体系不只是“能显示几个组件”，而是已经形成了完整层次：

- 自定义 renderer 注册。
- schema 驱动 generic renderer。
- fallback JSON 展示。
- block interaction state。
- 与消息、会话、插件执行状态联动。

当前 `covel` 这边虽然也有 `block-renderer-registry.tsx`，并且已经开始做 package renderer 动态加载，但整体仍然偏早期：

- host built-in renderer 仍然是主力。
- schema fallback 还是兜底，不是成熟的通用 block runtime。
- block 交互还没扩展成丰富的领域组件系统。

差距在于：

- 没有像旧项目那样丰富的领域 block 族。
- 没有形成完整的 schema-driven 通用渲染回退层。
- 没有把 block / resume 做成足够强的交互状态机。

### 5. 前端数据层差距

旧项目前端有更完整的本地数据与同步层：

- WebSocket 主链路。
- HTTP fallback。
- IndexedDB / local storage 兜底。
- 会话、项目、插件、状态、通知等 store 拆分。
- session hydration 和本地缓存协同。

当前 `covel` 前端更偏服务端驱动：

- 以 HTTP + SSE 为主。
- 主要由服务端提供 session/world/preset/archive/trace 数据。
- 前端 state 结构更轻。

这让当前前端更稳，但也意味着旧项目那种“前端自带更强交互内核”的感觉还没回来。

再具体一点：

- 旧项目是 `WebSocket + HTTP fallback + IndexedDB/local cache` 的前端运行内核。
- 当前 `covel` 是 `HTTP /actions + SSE` 的受控宿主模式。

前者更重，但交互能力强；后者边界更干净，但很多“复杂前端体验”还没补回来。

### 6. 前端交互动作差距

旧项目已经有一组很成熟的游戏交互动作：

- 发送消息。
- 初始化游戏。
- retry。
- force trigger 某类 block。
- 为消息生成图片。
- scene switch。
- retrigger plugins。

当前 `covel` 目前更集中在三类动作：

- `send_message`
- `execute_command`
- `submit_block_response`

这说明当前 action protocol 更统一，但玩法层动作密度远低于旧项目。

### 7. 插件与包管理前端差距

旧项目在前端已经把插件管理做成一等公民：

- 能看到插件列表。
- 能开关插件。
- 能看依赖关系。
- 能看 block conflict。
- 能看 prompt / outputs / capability 详情。
- 能看到脚本能力风险提示。

当前 `covel` 前端对 package 的呈现还很浅：

## 附录 A：前端专项补充

这一部分专门服务下次复用，不再泛泛而谈，而是按 6 个角度总结：

1. 运行逻辑
2. 触发逻辑
3. 配置逻辑
4. UI 设计
5. 插件/扩展前端
6. 状态栏/运行控制台

补充说明：

- 旧项目前端源码已复制到：
  - [`_compare/ai-gamestudio-dev-frontend`](/Users/wuyong/codes/game/covel/_compare/ai-gamestudio-dev-frontend)

### A.1 运行逻辑差距

旧项目前端已经是“多 store + 多 hook + transport + hydration + panel orchestration”的完整运行时。

关键证据：

- [`_compare/ai-gamestudio-dev-frontend/src/App.tsx`](/Users/wuyong/codes/game/covel/_compare/ai-gamestudio-dev-frontend/src/App.tsx)
- [`_compare/ai-gamestudio-dev-frontend/src/components/game/GamePanel.tsx`](/Users/wuyong/codes/game/covel/_compare/ai-gamestudio-dev-frontend/src/components/game/GamePanel.tsx)
- [`_compare/ai-gamestudio-dev-frontend/src/hooks/useGameWebSocket.ts`](/Users/wuyong/codes/game/covel/_compare/ai-gamestudio-dev-frontend/src/hooks/useGameWebSocket.ts)
- [`_compare/ai-gamestudio-dev-frontend/src/hooks/useSessionHydration.ts`](/Users/wuyong/codes/game/covel/_compare/ai-gamestudio-dev-frontend/src/hooks/useSessionHydration.ts)
- [`_compare/ai-gamestudio-dev-frontend/src/hooks/useWsCallbacks.ts`](/Users/wuyong/codes/game/covel/_compare/ai-gamestudio-dev-frontend/src/hooks/useWsCallbacks.ts)
- [`_compare/ai-gamestudio-dev-frontend/src/stores/sessionStore.ts`](/Users/wuyong/codes/game/covel/_compare/ai-gamestudio-dev-frontend/src/stores/sessionStore.ts)
- [`_compare/ai-gamestudio-dev-frontend/src/stores/gameStateStore.ts`](/Users/wuyong/codes/game/covel/_compare/ai-gamestudio-dev-frontend/src/stores/gameStateStore.ts)
- [`_compare/ai-gamestudio-dev-frontend/src/stores/pluginStore.ts`](/Users/wuyong/codes/game/covel/_compare/ai-gamestudio-dev-frontend/src/stores/pluginStore.ts)

当前 `covel` 前端虽然已经开始长出宿主运行时基础，但整体仍偏薄：

- [App.tsx](/Users/wuyong/codes/game/covel/apps/web/src/App.tsx)
- [state.ts](/Users/wuyong/codes/game/covel/apps/web/src/state.ts)
- [panel-registry.tsx](/Users/wuyong/codes/game/covel/apps/web/src/panel-registry.tsx)
- [inspector-registry.tsx](/Users/wuyong/codes/game/covel/apps/web/src/inspector-registry.tsx)
- [runtime-activity-panel.tsx](/Users/wuyong/codes/game/covel/apps/web/src/components/runtime-activity-panel.tsx)

一句话总结：

- 旧项目前端像“系统的一部分”
- 当前 `covel` 前端更像“系统的宿主页”

### A.2 触发逻辑差距

旧项目是 phase-driven / event-driven 的前端。

前端原生理解：

- phase
- stream status
- plugin processing
- plugin progress
- pending blocks
- scene update
- notifications
- token usage

关键证据：

- [`_compare/ai-gamestudio-dev-frontend/src/services/websocket.ts`](/Users/wuyong/codes/game/covel/_compare/ai-gamestudio-dev-frontend/src/services/websocket.ts)
- [`_compare/ai-gamestudio-dev-frontend/src/hooks/useWsCallbacks.ts`](/Users/wuyong/codes/game/covel/_compare/ai-gamestudio-dev-frontend/src/hooks/useWsCallbacks.ts)
- [`_compare/ai-gamestudio-dev-frontend/src/stores/sessionStore.ts`](/Users/wuyong/codes/game/covel/_compare/ai-gamestudio-dev-frontend/src/stores/sessionStore.ts)

当前 `covel` 虽然已有：

- `workflow.suspended`
- `workflow.resumed`
- `state.patch.applied`
- `artifact.updated`

但还没形成“自动触发 + phase 可视化 + package activity”统一模型。

所以旧项目和当前项目在用户体感上的一个核心差别是：

- 旧项目很多事情是系统自己推进
- 当前 `covel` 还更依赖手动发消息、手动 slash command、手动恢复

### A.3 配置逻辑差距

旧项目的配置体系是多层的：

- project 级
- session 级
- plugin 级
- runtime settings
- LLM profile / preset
- browser-side override

关键证据：

- [`_compare/ai-gamestudio-dev-frontend/src/components/status/RuntimeSettingsPanel.tsx`](/Users/wuyong/codes/game/covel/_compare/ai-gamestudio-dev-frontend/src/components/status/RuntimeSettingsPanel.tsx)
- [`_compare/ai-gamestudio-dev-frontend/src/components/plugins/PluginPanel.tsx`](/Users/wuyong/codes/game/covel/_compare/ai-gamestudio-dev-frontend/src/components/plugins/PluginPanel.tsx)
- [`_compare/ai-gamestudio-dev-frontend/src/services/settingsStorage.ts`](/Users/wuyong/codes/game/covel/_compare/ai-gamestudio-dev-frontend/src/services/settingsStorage.ts)
- [`_compare/ai-gamestudio-dev-frontend/src/utils/browserLlmConfig.ts`](/Users/wuyong/codes/game/covel/_compare/ai-gamestudio-dev-frontend/src/utils/browserLlmConfig.ts)

当前 `covel` 主要还停在：

- preset 列表
- preset 最小编辑
- session preset binding

还明显缺：

- package settings 面
- package state 面
- capability/debug 面
- world/session scoped config UI
- project 级配置工作流

### A.4 UI 设计差距

旧项目已经是完整 workbench，不只是“聊天页 + 侧栏”。

中间区包括：

- ChatMessages
- ChatInput
- SceneBar
- QuickActions
- ArchiveRestoreModal
- DebugLogPanel

右侧状态栏包括：

- Characters
- Quests
- Events
- World
- Codex
- Plugins
- Settings
- Notifications

关键证据：

- [`_compare/ai-gamestudio-dev-frontend/src/components/Layout.tsx`](/Users/wuyong/codes/game/covel/_compare/ai-gamestudio-dev-frontend/src/components/Layout.tsx)
- [`_compare/ai-gamestudio-dev-frontend/src/components/status/SidePanel.tsx`](/Users/wuyong/codes/game/covel/_compare/ai-gamestudio-dev-frontend/src/components/status/SidePanel.tsx)

当前 `covel` 虽然三栏结构已经有了，但右栏还远不是旧项目那个量级：

- session / preset
- archive
- runtime activity
- traces

这解释了为什么你会觉得“差很多”：不是视觉问题，而是工作台层次差很多。

### A.5 插件/扩展前端差距

旧项目的前端是真的把插件当一等公民来处理：

- 能看到插件列表
- 能开关插件
- 能看依赖关系
- 能看冲突
- 能看 prompt / outputs / capability 详情
- 能看脚本能力风险提示

关键证据：

- [`_compare/ai-gamestudio-dev-frontend/src/components/plugins/PluginPanel.tsx`](/Users/wuyong/codes/game/covel/_compare/ai-gamestudio-dev-frontend/src/components/plugins/PluginPanel.tsx)
- [`_compare/ai-gamestudio-dev-frontend/src/stores/pluginStore.ts`](/Users/wuyong/codes/game/covel/_compare/ai-gamestudio-dev-frontend/src/stores/pluginStore.ts)

当前 `covel` 虽然后端 extension runtime 已经开始成型，但前端对 extension 的理解还很浅：

- 显示已启用包
- 少量 slash command / block surface
- 几乎没有 package detail / settings / state / capability 面

### A.6 状态栏专项差距

如果单独只看状态栏，旧项目领先一个完整代际。

旧项目状态栏像一套运行控制台：

- Characters
- Quests
- Events
- World State
- Codex
- Notifications
- Runtime Settings
- Plugins
- Token Usage
- Debug Log

关键证据：

- [`_compare/ai-gamestudio-dev-frontend/src/components/status/CharacterPanel.tsx`](/Users/wuyong/codes/game/covel/_compare/ai-gamestudio-dev-frontend/src/components/status/CharacterPanel.tsx)
- [`_compare/ai-gamestudio-dev-frontend/src/components/status/QuestPanel.tsx`](/Users/wuyong/codes/game/covel/_compare/ai-gamestudio-dev-frontend/src/components/status/QuestPanel.tsx)
- [`_compare/ai-gamestudio-dev-frontend/src/components/status/EventPanel.tsx`](/Users/wuyong/codes/game/covel/_compare/ai-gamestudio-dev-frontend/src/components/status/EventPanel.tsx)
- [`_compare/ai-gamestudio-dev-frontend/src/components/status/WorldStatePanel.tsx`](/Users/wuyong/codes/game/covel/_compare/ai-gamestudio-dev-frontend/src/components/status/WorldStatePanel.tsx)
- [`_compare/ai-gamestudio-dev-frontend/src/components/status/CodexPanel.tsx`](/Users/wuyong/codes/game/covel/_compare/ai-gamestudio-dev-frontend/src/components/status/CodexPanel.tsx)
- [`_compare/ai-gamestudio-dev-frontend/src/components/status/NotificationPanel.tsx`](/Users/wuyong/codes/game/covel/_compare/ai-gamestudio-dev-frontend/src/components/status/NotificationPanel.tsx)
- [`_compare/ai-gamestudio-dev-frontend/src/components/game/TokenUsageBar.tsx`](/Users/wuyong/codes/game/covel/_compare/ai-gamestudio-dev-frontend/src/components/game/TokenUsageBar.tsx)
- [`_compare/ai-gamestudio-dev-frontend/src/components/game/DebugLogPanel.tsx`](/Users/wuyong/codes/game/covel/_compare/ai-gamestudio-dev-frontend/src/components/game/DebugLogPanel.tsx)

当前 `covel` 的右栏还只是这条路的第一步：

- [runtime-activity-panel.tsx](/Users/wuyong/codes/game/covel/apps/web/src/components/runtime-activity-panel.tsx)
- [trace-summary.ts](/Users/wuyong/codes/game/covel/apps/web/src/components/trace-summary.ts)
- [preset-editor.ts](/Users/wuyong/codes/game/covel/apps/web/src/components/preset-editor.ts)

所以如果只问“状态栏差距大不大”，答案是：非常大，而且主要差的是**信息架构和运行时可视化**，不是视觉风格。

## 附录 B：前端专项一句话结论

如果只看前端，不看后端内核，旧项目现在仍然明显更强。

最大差距不是某个组件，而是这四个：

1. 缺少真正的前端 runtime 模型
2. 缺少 phase/workflow/plugin activity 的统一触发与可视化
3. 缺少 project/session/plugin 多层配置体系
4. 缺少多面板状态工作台

如果继续做，优先级应是：

1. 先把右栏重构成旧项目风格的 `SidePanel`
2. 再补 phase / workflow / plugin activity 的统一前端状态层
3. 再补 package detail / settings / state / capability 面板
4. 最后把中栏升级成 `timeline + block surface + artifact surface`

### 进展更新（`2026-03-27`）

这一轮已经把上面第 `1` 步落了第一版可用实现：

- 右栏已经改成 `WorkbenchSidePanel` 多 tab 工作台。
- 已接入 `session / characters / quests / events / world / packages / settings / debug` 八类宿主面板。
- 前端已读取 `GET /sessions/:id/package-state` 与 `GET /sessions/:id/workflow-snapshots`，不再只看即时 SSE。
- `starter world` 已改成创建后自动发送开场消息。
- 首轮叙事如果没有 block，会自动补一次 `/guide <topic>`，把旧项目里“自动弹出引导选项”的关键体验接回来。
- 当前 pending interactive block 已提升为 composer 上方的独立 dock，不再只埋在 timeline 里。
- 浏览器实测已经打通：
  - 创建示例世界
  - 自动开场 narration
  - 自动 guide block 弹出
  - 点击选项后 `submit_block_response`
  - 右栏 debug/trace/state 同步更新

浏览器验证里有一个需要记录的细节：

- `agent-browser` 的原生 `click` 在这个 React choice button 场景下没有稳定触发提交。
- 但直接在页面 DOM 上执行 `element.click()` 时，`POST /actions`、后续 `workflow-snapshots/package-state/traces` 刷新都已正常发生。
- 这更像自动化工具兼容性问题，不像当前产品逻辑仍然损坏；不过后续仍建议再用 Playwright 或真人手点补一次确认。

这意味着前端已经不再是“只有 timeline 的最小宿主”，而是开始接近旧项目的运行时工作台形态。

- 主要是 package 列表与 enabled 状态。
- 还没有完整的 package 详情、冲突、依赖、能力面板。
- 也没有成熟的 package authoring / inspection 工作台。

这点会直接影响“平台感”：旧项目已经像插件平台，当前项目还更像宿主列出了一批已装包。

### 8. 调试与观测前端差距

旧项目的调试能力更接近工程台：

- Debug page。
- Debug log panel。
- token / cost 可视化。
- plugin progress / plugin summary。
- message block 更新可回放。

当前 `covel` 的观测前端还比较薄：

- 有 trace summary。
- 有 archive summary。
- 有最小错误态。

但还没有把下面这些做成真正的前端工作面：

- phase 可视化。
- request / flow 级别执行时间线。
- package/capability 调用观察。
- retrieval / archive / prompt 组合诊断。
- token / cost / provider fallback 观测。

### 9. 创作与编辑工作流差距

旧项目不只是“玩游戏”，它已经包含比较完整的创作流：

- project editor。
- markdown/world 编辑。
- init prompt 编辑。
- model settings。
- plugin 面板。
- runtime settings 面板。

当前 `covel` 离这个创作面还有明显差距：

- 还没有完整的世界内容编辑器。
- 还没有 persona / character card / worldbook 的正式 UI。
- 还没有 package 驱动的配置编辑工作流。
- 还没有把 task binding 做成日常可操作的产品面。

所以现在的 `covel` 更像“引擎宿主”，还不像“内容创作工作台”。

## 前端差距一句话归纳

如果只看前端：旧项目是“有设置、有状态、有调试、有插件面、有创作面”的完整工作台；当前 `covel` 还是“能跑主链路、能显示 timeline、能处理少量 block”的最小宿主。

## 关键缺口清单

### 高优先级

- `context provider` 主链路接入。
- `renderer registry` 真正动态化。
- `block response -> package-owned resume handler`。
- `Connection Profile + Task Preset + taskBindings` 的完整产品化。
- 更完整的 Web Host 工作台：状态、调试、provider、binding、archive、trace。
- 前端设置面补齐：package、runtime settings、model/profile、task binding。
- 前端状态面补齐：world state、character、quest、event、notification、token、phase。

### 中优先级

- 更丰富的 first-party package 能力。
- `memory-rag / archive / observability` 的工作台化。
- 更完整的 block 族与通用 schema UI。
- 玩法相关面板：角色卡、世界设定、事件、任务、关系、资源。
- package 详情、冲突、依赖、能力检查面。
- trace/debug/retrieval 的工程化工作台。

### 低优先级

- 更强的本地兜底与离线缓存。
- 更完整的 debug tables / diagnostics 页面。
- 更细的多设备/多宿主适配。

## 一句话判断

旧项目是“能玩、能扩、能看、能调”的完整框架；当前 `covel` 是“边界更清晰、骨架更现代”的新底座，但还没把旧项目的玩法密度和前端工作台能力迁完整。

## 建议的补齐顺序

1. 先把 `provider / preset / binding` 收敛成正式产品模型。
2. 再把 `context provider -> prompt graph -> flow-engine` 接到主回合。
3. 然后补 `package-owned resume` 和动态 renderer。
4. 最后把前端扩成完整工作台：状态、调试、archive、trace、package、preset。
