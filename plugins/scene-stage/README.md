# scene-stage

跟踪叙事当前所在的场景、昼夜和在场角色，为舞台背景与立绘提供数据。是统一事件发射层（`emit-event`）里 `scene.set` 事件的第一个消费方。

## 运行时结构

- `PLUGIN.md`：插件级元信息（名称/描述/关联），本身不是可执行 runtime——`runtimes/` 下才是实际发现、调度的四个 runtime。
- `runtimes/cast/RUNTIME.md` + `handler.js` + `ui/scene-cast-panel.json`：`pre-turn` 定时函数 runtime，按玩家消息与近期正文给非玩家角色打分，选出至多 `activeSpeakerCount` 名当前说话人，输出 `scene-cast@1` 供 `chat-mode-narrator` 注入，并写入 `active-cast/current`；声明右侧在场角色面板。
- `runtimes/resolver/RUNTIME.md` + `handler.js` + `ui/scene-stage-panel.json`：事件触发函数 runtime（消费 `scene.set`），场景匹配与舞台状态写入，声明右侧只读场景面板。
- `runtimes/direction/RUNTIME.md` + `handler.js`：消费 `stage.direction`，持久化角色登退场、站位、焦点及视觉变体请求到 `direction/current`；动作流预览为退场与清场播放指定 transition，持久状态只保留仍在场角色。
- `runtimes/seed/RUNTIME.md` + `handler.js`：`stage: setup` 函数 runtime，开局把注册表第一个场景写入 `stage/current`，为"叙事整局不发 `scene.set`"兜底。
- `lib/stage-data.js`：resolver 与 seed 共享的 namespace/key 常量、`source`/变体文案映射，以及 `stage/current` 记录的唯一构造入口（`buildStageRecord` / `makeStageProposal`）。
- `schemas/scene-cast.schema.json`：`scene-cast@1` 输出契约（`activeCastContext` + `speakers[]`）。
- `schemas/scene-set.event.json`：`scene.set` 载荷校验。
- `schemas/stage-direction.event.json`：`stage.direction` 批量 cues 载荷校验。
- `schemas/scenes.schema.json`：`scenes` namespace 校验，对齐世界包导入的场景注册表形状（`schemaVersion` + `registryId` + `scenes[]`）。

`events[].schema` 和 `dataSchemas.*.schema` 路径始终相对**插件根目录**解析；`handler` 和 `ui.*` 路径相对**各自 runtime 目录**解析——各 runtime 的 `schemas/` 因此共享放在插件根，`ui/` 则跟着各自的 runtime 走。两个右侧面板同属 `scene-stage` 分组，合并为一个"当前场景"标签页。

## 数据与行为

- `scenes` namespace（`dataSchemas.scenes`，`acceptsWorldData: true`）：从世界包导入的场景注册表，key 为固定值 `scene-registry`，一行文档即整份 registry。
- `stage/current`：解析后的当前场景状态（场景 id、名称、昼夜变体、来源、日/夜 `MediaRef`、解析后的展示图）。命中注册表时写入 `source: "world"`；未命中时写入 `source: "none"`，舞台回退到世界头图。同时写入 `sourceLabel`（`I18nText`，`source` 的展示文案，例如 `none` → "无背景"）与 `variantLabel`（`I18nText`，昼夜文案）供只读面板直接渲染——json-render spec 不支持按枚举值条件选文案，翻译需在 handler 侧算好（对齐 cast runtime 的 `signalView()`/`reasonLabel` 做法）。
- `active-cast/current`：cast runtime 每回合写入的当前说话人（`speakers[]`，含打分信号及其 `signalViews` 文案）。`stage.cast@1` 的 `cast` 槽位（order 0）由它投影，并保留上一轮演员直到出现新选择。
- `direction/current`：权威角色舞台状态。`actors[]` 记录角色、焦点、显式站位与 `variantId/outfit/expression/pose` 请求；`actors: []` 表示明确清空。`direction` 槽位（order 10）在该记录存在时覆盖 `cast` 槽位的演员；未产生该记录时舞台沿用 `active-cast` 的选择。
- `dialogue/<turnId>`：独立于演员焦点的正文分段署名。`stage.direction.dialogue.paragraphSpeakers` 按空行分段顺序提交准确角色 ID 或 `null`，持久化为 `{ schemaVersion: 1, turnId, paragraphSpeakers: [{ characterId, displayName } | null] }`。每轮 1–80 项，未知 ID 记录诊断并降级为 `null`；只有对白映射时允许 `cues: []`，不会清空舞台。旧消息无映射、回合不匹配或最终段数不一致时，Web 不显示人物署名。
- **开场种子**：`scene.set` 的唯一发射方是叙事 LLM（事件目录的【必做】指示是提示词约束，不是保证）。整局不发时 `resolver` 作为 `event` 触发的 runtime 永远不跑，舞台恒空。`seed` runtime 在 `stage: setup` 跑一次补上这条下限：`stage/current` 已存在（恢复会话、setup 重试）或世界没有场景注册表时跳过，否则按白天变体写入注册表第一个场景。它跑在任何叙事输出之前，因此不与 LLM 发的 `scene.set` 竞争——两者若落在同一回合，事件扇出顺序不定，后写的会盖掉正确场景。

## userSettings

- `activeSpeakerCount`（默认 `2`，范围 1–4）：cast runtime 每回合选出的说话人上限。世界包可通过 `pluginSettings.scene-stage.activeSpeakerCount` 设定默认值。

## 开发

修改场景匹配、说话人选择逻辑或面板数据路径后，运行本插件测试。
