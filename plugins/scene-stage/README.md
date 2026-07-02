# scene-stage

跟踪叙事当前所在的场景与昼夜，为舞台背景提供数据。是统一事件发射层（`emit-event`）里 `scene.set` 事件的第一个消费方。

## 运行时结构

- `PLUGIN.md`：事件触发函数 runtime 声明（消费 `scene.set`）。
- `handler.js`：场景匹配与舞台状态写入。
- `runtimes/background-gen/PLUGIN.md` + `handler.js`：后台函数 runtime，消费内部信令 `scene-stage.generate.requested`，调用 `ctx.images` 增量生成缺失的场景背景。
- `schemas/scene-set.event.json`：`scene.set` 载荷校验。
- `schemas/generate-requested.event.json`：`scene-stage.generate.requested` 载荷校验（内部信令，`advertise: false`，不进 `<available-events>` 目录）。
- `schemas/scenes.schema.json`：`scenes` namespace 校验，对齐世界包导入的场景注册表形状（`schemaVersion` + `registryId` + `style` + `scenes[]`）。
- `ui/scene-stage-panel.json`：右侧只读场景面板。

## 数据与行为

- `scenes` namespace（`dataSchemas.scenes`，`acceptsWorldData: true`）：从世界包导入的场景注册表，key 为固定值 `scene-registry`，一行文档即整份 registry。
- `stage/current`：解析后的当前场景状态（场景 id、名称、昼夜变体、来源、日/夜 `MediaRef`、解析后的展示图）。命中注册表或会话内已生成的场景时写入 `source: "world" | "session"`；未命中且门控放行时写入 `source: "pending"` 并向 `background-gen` 发内部事件；门控不放行则 `source: "none"`。同时写入 `sourceLabel`（`I18nText`，`source` 的展示文案，例如 `pending` → "背景生成中…"）供只读面板直接渲染——json-render spec 不支持按枚举值条件选文案，翻译需在 handler 侧算好（对齐 `scene-cast` 的 `signalView()`/`reasonLabel` 做法）。
- `stage/generated`：会话内已增量生成的场景索引，供 `background-gen` 记账、场景解析器做会话内命中匹配、以及 `maxGeneratedScenes` 帽计数。

## userSettings

- `autoGenerateScenes`（默认 `true`）：场景未命中注册表时，是否自动请求背景生成。关闭后未命中场景的 `stage/current.source` 恒为 `"none"`，由消费方（舞台 UI）走世界头图/渐变等回退链。
- `maxGeneratedScenes`（默认 `10`）：单会话内允许增量生成的场景数上限，达到后新场景同样回退到 `source: "none"`，即使门控开启。

## 开发

修改场景匹配逻辑、增量生成 prompt 拼装或面板数据路径后，运行本插件测试。
