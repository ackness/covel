# scene-stage

跟踪叙事当前所在的场景与昼夜，为舞台背景提供数据。是统一事件发射层（`emit-event`）里 `scene.set` 事件的第一个消费方。

## 运行时结构

- `PLUGIN.md`：插件级元信息（名称/描述/关联），本身不是可执行 runtime——`runtimes/` 下才是实际发现、调度的三个 runtime。
- `runtimes/resolver/PLUGIN.md` + `handler.js` + `ui/scene-stage-panel.json`：事件触发函数 runtime（消费 `scene.set`），场景匹配与舞台状态写入，声明右侧只读场景面板。
- `runtimes/background-gen/PLUGIN.md` + `handler.js`：后台函数 runtime，消费内部信令 `scene-stage.generate.requested`，调用 `ctx.images` 增量生成缺失的场景背景。
- `runtimes/seed/PLUGIN.md` + `handler.js`：`stage: setup` 函数 runtime，开局把注册表第一个场景写入 `stage/current`，为"叙事整局不发 `scene.set`"兜底。
- `lib/stage-data.js`：三个 runtime 共享的 namespace/key 常量、`source`/变体文案映射，以及 `stage/current` 记录的唯一构造入口（`buildStageRecord` / `makeStageProposal`）。
- `schemas/scene-set.event.json`：`scene.set` 载荷校验。
- `schemas/generate-requested.event.json`：`scene-stage.generate.requested` 载荷校验（内部信令，`advertise: false`，不进 `<available-events>` 目录）。
- `schemas/scenes.schema.json`：`scenes` namespace 校验，对齐世界包导入的场景注册表形状（`schemaVersion` + `registryId` + `style` + `scenes[]`）。

`events[].schema` 和 `dataSchemas.*.schema` 路径始终相对**插件根目录**解析（不管声明它们的 PLUGIN.md 放在哪个 runtime 下）；`handler` 和 `ui.*` 路径相对**各自 runtime 目录**解析——两个 runtime 的 `schemas/` 因此共享放在插件根，`ui/` 则跟着 `resolver` runtime 走。

## 数据与行为

- `scenes` namespace（`dataSchemas.scenes`，`acceptsWorldData: true`）：从世界包导入的场景注册表，key 为固定值 `scene-registry`，一行文档即整份 registry。
- `stage/current`：解析后的当前场景状态（场景 id、名称、昼夜变体、来源、日/夜 `MediaRef`、解析后的展示图）。命中注册表或会话内已生成的场景时写入 `source: "world" | "session"`；未命中且门控放行时写入 `source: "pending"` 并向 `background-gen` 发内部事件；门控不放行则 `source: "none"`。同时写入 `sourceLabel`（`I18nText`，`source` 的展示文案，例如 `pending` → "背景生成中…"）与 `variantLabel`（`I18nText`，昼夜文案）供只读面板直接渲染——json-render spec 不支持按枚举值条件选文案，翻译需在 handler 侧算好（对齐 `scene-cast` 的 `signalView()`/`reasonLabel` 做法）。
- `stage/generated`：会话内已增量生成的场景索引，供 `background-gen` 记账、场景解析器做会话内命中匹配、以及 `maxGeneratedScenes` 帽计数。
- **开场种子**：`scene.set` 的唯一发射方是叙事 LLM（事件目录的【必做】指示是提示词约束，不是保证）。整局不发时 `resolver` 作为 `event` 触发的 runtime 永远不跑，舞台恒空。`seed` runtime 在 `stage: setup` 跑一次补上这条下限：`stage/current` 已存在（恢复会话、setup 重试）或世界没有场景注册表时跳过，否则按白天变体写入注册表第一个场景。它跑在任何叙事输出之前，因此不与 LLM 发的 `scene.set` 竞争——两者若落在同一回合，事件扇出顺序不定，后写的会盖掉正确场景。

## userSettings

- `autoGenerateScenes`（默认 `true`）：场景未命中注册表时，是否自动请求背景生成。关闭后未命中场景的 `stage/current.source` 恒为 `"none"`，由消费方（舞台 UI）走世界头图/渐变等回退链。
- `maxGeneratedScenes`（默认 `10`）：单会话内允许增量生成的场景数上限，达到后新场景同样回退到 `source: "none"`，即使门控开启。

## 已知边界

- **门控中途从关切换到开，同场景同变体不会立即补图**：`stage/current` 的 no-op 防抖（`previous.sceneId` 与 `previous.variant` 都不变时直接跳过）在补图判断之前就早退了，所以如果 `autoGenerateScenes` 关闭期间某场景/变体已经写过一次 `stage/current`（未命中或缺变体），随后开启门控但叙事仍反复发同一场景/变体的 `scene.set`，不会补发生成请求——需要先切换地点或昼夜（打破 no-op 条件）才能让 resolver 重新评估门控。
- ~~**生成期间会话锁被长时间持有**~~：**已解决**（2026-07-28）。deferred follower 的执行（含 60-300s 的图像生成）现在跑在会话锁**外**，只有提交阶段（`processTurnResults`：finalize 事务 + auto-snapshot）进锁，玩家因此只需等毫秒级的提交而不是整张图。同一 runtime 的并发 follower 由一把 `<sessionId>::<runtimeId>` 作业锁串行，所以"是否已生成"这类 check-then-act 仍是原子的、不会重复计费。提交前会在锁内重读一次会话状态，玩家中途暂停/结束会话时 follower 的写入会被丢弃而不是提交进去。
- **`execution: background` 任务不跨进程重启恢复**：`background-gen` 由框架的 `_jobs` 挂起队列（`setImmediate` + `_jobs/<jobId>` pending 行）驱动，没有持久化的任务队列；服务进程在生成请求排队后、完成前重启，该请求就丢了。框架**不会**自动重跑——重跑要再计一次费，且请求级 `userSettings` 没有持久化在任务行上，重跑等于换参数重新扣费。现在服务重启后的开机扫描会按 owner 判定把这类孤儿任务立即标为 `failed`（`reason: "orphaned"`，并保留 `triggerEvent` 供重试），前端因此会弹出失败提示，不再是无声的永久转圈。但 `stage/current.source` 仍会停在 `"pending"`——那是插件自己的状态，框架不碰。玩家需要重新触发一次同场景/变体的 `scene.set`（例如切走再切回）才能重新排队；让 resolver 订阅任务失败并把 `stage/current` 回落到 `none` 是尚未做的改进。

## 开发

修改场景匹配逻辑、增量生成 prompt 拼装或面板数据路径后，运行本插件测试。
