# scene-stage 插件（场景解析运行时 B）设计

> GalGame 四部曲第三步（B），依赖 E（统一事件发射层）与 A（场景资产管线）先行。B 是 E 的第一个消费方：narrator 经 `emit-event` 发射 `scene.set`，scene-stage 解析并驱动 C 的舞台。
> 纯插件 + 世界包接线，零框架改动。

## 范围

**做**：`plugins/scene-stage/` 插件（scene.set 消费 runtime + 增量生成 runtime + dataSchemas + userSettings + 只读右栏面板）；haruka world.data.yaml 接入注册表；A 侧小改（emit-scenes 把 style 块带进 registry）；文档同步。

**不做**：舞台 UI（C）；"保存到世界级"入口（C）；时间系统（昼夜只来自叙事判定，经 scene.set 载荷）；传统 narrator 模式的场景语义差异化（两个 narrator 同样 advertise，行为一致）。

## §1 事件契约（E 声明）

`events` 声明（见 E 规格 E1）：

- topic `scene.set`，schema `./schemas/scene-set.event.json`：`{ location: string (必填，场景/地点名), timeOfDay: "day"|"night" (必填), visualHint?: string (可选，英文一句画面描述) }`。
- description 指导发射方："叙事确立或切换场景、或昼夜变化时发射；location 用叙事中的地点名；无把握时沿用上一次的值；**location 是世界已知地点之外的新去处时，附一句英文 visualHint 描述画面**（供背景增量生成）。"

## §2 runtime 一：`scene-stage`（解析器）

- **function** runtime，`trigger: {type: "event", topic: "scene.set"}`，outputKind: system，tags 对齐 scene-cast 家族（mode:dialogue、role:scene-state、cost:function）。
- 解析流程（工具箱全部既有）：
  1. 读自身 `plugin_data` 的 `scenes` namespace（世界注册表，经 dataSchemas 导入）+ `stage/current`（上一状态）。
  2. 匹配 `location`：精确（name/locationRef 全等）→ 归一化包含（去空格大小写、双向 substring）→ 会话内已生成场景（`stage/generated` 索引）。
  3. 命中 → 写 `stage/current`（形状见 §4）；与上一状态同 sceneId 同 variant 时 **no-op**（不写不发 SSE，防抖动）。
  4. 未命中 → 按 userSettings 门控：`autoGenerateScenes`（默认 true）且已生成数 < `maxGeneratedScenes`（默认 10）→ 写 `stage/current`（source: "pending"）+ `output.events` 发 `scene-stage.generate.requested`（内部事件，`advertise: false` 声明）；门控不过 → source: "none"（C 走回退链）。
  5. 昼夜：载荷 `timeOfDay` 直接采用；解析出的 `resolved` = 对应变体 MediaRef，夜图缺失回退日图（A §4 语义）。

## §3 runtime 二：`scene-stage/background-gen`（增量生成）

- **function** runtime，`execution: background`，`trigger: {type: "event", topic: "scene-stage.generate.requested"}`，capabilities `[image-generation]`（接受 D 的 asset 强制校验）。
- 调 **`ctx.images.generate`**（D 管线）：prompt = 注册表随带的 `style` 块拼接（prefix + subject + suffix，夜变体加 nightSuffix），subject 优先用事件载荷的 `visualHint`，缺失时回退 location 名；metadata `{kind: "scene-background", sceneId, variant}`；**day 先行，night 懒生成**（首次夜晚请求该场景时再补）。`scene-stage.generate.requested` 事件载荷携带 `{sceneId, location, visualHint?, variant}`。
- 完成 → 更新 `stage/generated` 索引 + 若 `stage/current` 仍指向该场景则刷新其 refs/source（"pending"→"session"）→ `plugin-data.changed` SSE 驱动 C 换图。
- promptHash 幂等（D3）天然防重复计费；失败走 D 的既有错误呈现，`stage/current` 保持 pending 状态由 C 回退。

## §4 C 的消费契约（plugin_data）

namespace `stage`，key `current`：

```jsonc
{
  "sceneId": "classroom-2b",
  "name": "二年 B 组教室",
  "variant": "day" | "night",
  "source": "world" | "session" | "pending" | "none",
  "day": MediaRef | null,        // source=world/session 时至少 day 非空
  "night": MediaRef | null,
  "resolved": MediaRef | null,   // variant 对应图，夜缺回退日；pending/none 为 null
  "turnId": "...",
  "updatedAt": "ISO"
}
```

- C 的回退链输入：`resolved` 为 null 时按 `source` 分档（pending → 回退图+等待 SSE；none → 世界头图/渐变）。
- namespace `generated`：sceneId → 会话内已生成变体索引（内部记账 + 会话帽计数）。

## §5 世界包接线与 A 侧小改

- `dataSchemas.scenes`（acceptsWorldData，schema `./schemas/scenes.schema.json` 对齐 registry 形状）。
- haruka world.data.yaml 新增 source：`kind: json, path: media/scenes.registry.json, schema: plugin://scene-stage/scenes, to: plugin:scene-stage/scenes, key: registryId, after: dimensions`（兑现 A 规格"B 接管消费"的注记；world-data.md 同步改写该段）。**导入力学**：json source 要求每条目可提取 key——registry 是单对象文档，emit-scenes 为其新增自描述字段 `registryId: "scene-registry"`，整份文档作为 scene-stage `scenes` namespace 下的**一行** plugin_data 导入（B 读一行即得 style+scenes 全量）。
- **A 侧小改**：`emit-scenes.mjs` 在 registry 顶层带上 `style` 块（从 scenes.json 复制）与 `registryId: "scene-registry"`——增量生成需要同源画风、导入需要 key；重跑 emit 后 registry 形状为 `{schemaVersion, registryId, style, scenes:[...]}`（schemaVersion 仍为 1：纯增字段，消费方尚未发布）。

## §6 UI（只读，App is for players）

`ui.right`: 当前场景面板（json-render）：场景名 + 变体徽标 + source 状态（生成中转圈文案）；零操作按钮（"保存到世界级"归 C）。

## 验收

- 插件单测（vitest，mock ctx 模式对齐 dashscope 迁移的 handler.test.js）：精确/模糊/会话内命中、no-op 防抖、门控与会话帽、pending→session 状态迁移、夜图回退、事件载荷非法时的容错（schema 校验在 E 层，插件仍防御性处理）。
- 集成（plugin-test-utils）：MockLLM 发 scene.set → 同回合 scene-stage 执行 → plugin_data 断言。
- e2e（用户执行）：真实叙事 3 轮含场景切换与入夜，右栏面板状态正确。
- 文档：plugins.md 注册表新条目、world-data.md registry 导入段改写、ui-panels.md 右栏新面板。

## 决策记录

1. 解析器从"专属小 agent + 本地工具"重构为 E 的事件消费 function runtime——每轮省一次 LLM 调用（用户选定方案一）。
2. 增量生成设置门控自动（默认开 + 会话帽 10），day 先行 night 懒生成（用户选定）。
3. 增量生成自持（ctx.images 直调），不依赖第三方图像插件——metadata 可控且零插件间耦合。
4. 昼夜信源 = scene.set 载荷（框架无时间系统；narrator 判定）。
