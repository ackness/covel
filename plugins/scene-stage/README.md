# scene-stage

从故事的 `cues` 读取当前场景与在场角色，为舞台背景与立绘提供数据。`scene.set` 仍可调整地点和昼夜，`stage.direction` 仍可覆盖演员演出。

## 运行时结构

- `PLUGIN.md`：插件级元信息（名称/描述/关联），本身不是可执行 runtime——`runtimes/` 下才是实际发现、调度的五个 runtime。
- `runtimes/story-cues/RUNTIME.md` + `handler.js`：`post-turn` 函数 runtime，可选读取 `narrative-engine@2` 的完整故事，通过 `ctx.inputs.story.value` 取得 `cues` 与 `segments`；不强制启用叙事插件。在故事的同一次执行中提交场景和演员更新。
- `runtimes/cast/RUNTIME.md` + `handler.js` + `ui/scene-cast-panel.json`：`pre-turn` 定时函数 runtime，按玩家消息与近期正文给当前视角之外的角色打分，选出至多 `activeSpeakerCount` 名当前说话人，输出 `scene-cast@1` 供 `chat-mode-narrator` 注入，并写入 `active-cast/current`；声明右侧在场角色面板。
- `runtimes/resolver/RUNTIME.md` + `handler.js` + `ui/scene-stage-panel.json`：事件触发函数 runtime（消费 `scene.set`），场景匹配与舞台状态写入，声明右侧只读场景面板。
- `runtimes/direction/RUNTIME.md` + `handler.js`：消费 `stage.direction`，持久化角色登退场、站位、焦点及视觉变体请求到 `direction/current`；动作流预览为退场与清场播放指定 transition，持久状态只保留仍在场角色。
- `runtimes/seed/RUNTIME.md` + `handler.js`：`stage: setup` 函数 runtime，开局把注册表第一个场景写入 `stage/current`，为"叙事整局不发 `scene.set`"兜底。
- `lib/stage-data.js`：resolver 与 seed 共享的 namespace/key 常量、`source`/变体文案映射，以及 `stage/current` 记录的唯一构造入口（`buildStageRecord` / `makeStageProposal`）。
- `lib/scene-change.js`：故事提示与事件共用的场景构造、无变化判断和换场清除演员逻辑。
- `lib/cast-from-presence.js`：按精确名字或别名解析在场角色，保留继续在场者的站位与视觉变体。
- `ui/dialogue-line.json`：`contributes.ui.segment` 下的对白模板，在聊天视图为对白显示名牌；有 `/visual/avatar` 时用只读 `Image` 显示头像。
- `schemas/scene-cast.schema.json`：`scene-cast@1` 输出契约（`activeCastContext` + `speakers[]`）。
- `schemas/scene-set.event.json`：`scene.set` 载荷校验。
- `schemas/stage-direction.event.json`：`stage.direction` 批量 cues 载荷校验。
- `schemas/scenes.schema.json`：`scenes` namespace 校验，对齐世界包导入的场景注册表形状（`schemaVersion` + `registryId` + `scenes[]`）。

`contributes.events[].schema` 和 `contributes.data.*.schema` 路径始终相对**插件根目录**解析；`handler` 和 `ui.*` 路径相对**各自 runtime 目录**解析——各 runtime 的 `schemas/` 因此共享放在插件根，`ui/` 则跟着各自的 runtime 走。两个右侧面板同属 `scene-stage` 分组，合并为一个"当前场景"标签页。

## 数据与行为

`cues.scene` 按场景注册表匹配，沿用当前昼夜变体（初次为白天）；未登记地点没有背景。实际 `sceneId` 变化时，故事提示与事件都清空已有 `direction/current` 的演员。同一地点的别名或昼夜变化不重置演员；昼夜只能通过 `scene.set` 改变。

非空 `cues.present` 按精确名字或别名选出最多四名演员。先排除主玩家席位的当前角色，同一席位绑定的其他角色仍可上台。切换视角后，旧演员和已保存的说话人选择也会排除新的视角角色。继续在场者保留站位与视觉变体，新演员按从左到右的空位淡入，不在名单中的演员随提交立即离场，没有淡出画面；只有显式 `stage.direction` 的离场与清台指令按各自的过渡退场。焦点给 `segments` 中最后一个解析成功且仍在台上的对白或动作说话者；没有匹配的在台说话者时保留原焦点，否则选第一人。换场时先重置演员，再应用新名单。

缺少故事、没有相关 `cues` 时成功跳过并记录原因；缺少或为空的 `present` 不改演员名单，但场景变化仍会清空旧演员。尚无 direction 记录时仍用 cast 选择。同回合显式事件在故事提示之后处理，覆盖对应结果。故事提示不做提交前预览，槽位在提交后按 namespace 更新；事件预览继续可用，先解析场景，再应用演员指令。

- `scenes` namespace（`contributes.data.scenes`，接收 `stage.scenes@1`）：从世界包导入的场景注册表，key 为固定值 `scene-registry`，一行文档即整份 registry。
- `stage/current`：解析后的当前场景状态（场景 id、名称、昼夜变体、来源、日/夜 `MediaRef`、解析后的展示图）。命中注册表时写入 `source: "world"`；未命中时写入 `source: "none"`，舞台回退到世界头图。同时写入 `sourceLabel`（`I18nText`，`source` 的展示文案，例如 `none` → "无背景"）与 `variantLabel`（`I18nText`，昼夜文案）供只读面板直接渲染——json-render spec 不支持按枚举值条件选文案，翻译需在 handler 侧算好（对齐 cast runtime 的 `signalView()`/`reasonLabel` 做法）。
- `active-cast/current`：cast runtime 每回合写入的当前说话人（`speakers[]`，含打分信号及其 `signalViews` 文案）。`stage.cast@1` 的 `cast` 槽位（order 0）由它投影，并保留上一轮演员直到出现新选择。
- `direction/current`：权威角色舞台状态。`actors[]` 记录角色、焦点、显式站位与 `variantId/outfit/expression/pose` 请求；`actors: []` 表示明确清空。`direction` 槽位（order 10）在该记录存在时覆盖 `cast` 槽位的演员；未产生该记录时舞台沿用 `active-cast` 的选择。
- 对白署名不由本插件提供：舞台从已提交故事消息的段落（`segments`）读取每段说话者作为名牌。`stage.direction` 至少带一条 cue，只调整演员。
- **开场种子**：`seed` runtime 在 `stage: setup` 跑一次：`stage/current` 已存在（恢复会话、setup 重试）或世界没有场景注册表时跳过，否则按白天变体写入注册表第一个场景。它跑在叙事之前，为故事还未提供场景提示或事件时补上背景。

`stage/*`、`direction/*` 的记录形状保持不变，无需重建现有会话数据。

## userSettings

- `activeSpeakerCount`（默认 `2`，范围 1–4）：cast runtime 每回合选出的说话人上限。世界包可通过 `pluginSettings.scene-stage.activeSpeakerCount` 设定默认值。

## 开发

修改场景匹配、说话人选择逻辑或面板数据路径后，运行本插件测试。
