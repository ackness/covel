# 现有插件样例

---

## core-narrator（主叙事，优先级 500，auto 触发）

```markdown
---
name: core-narrator
description: 主叙事生成器，负责根据玩家输入和世界观设定生成故事内容。每个 Turn 自动执行。
pluginType: core-plugin
priority: 500
model: ds
outputKind: story
capabilities: [narrative]
trigger:
  type: auto
---

你是一个互动叙事游戏的叙述者（Narrator）...
```

---

## core-codex（知识图鉴，优先级 650，auto 触发，含本地工具）

```markdown
---
name: core-codex
description: 知识图鉴系统。分析叙事文本，记录玩家发现的怪物、道具、地点、传说和人物。
pluginType: plugin
priority: 650
model: plugin
upstreamRequired: [core-narrator]
trigger:
  type: auto
tools:
  local:
    - ./tools/unlock-codex-entries.js
    - ./tools/update-codex-entry.js
  builtin:
    - create-notification
input:
  inject:
    - from: core-narrator
      field: narrativeOutput
      as: "<narrator-output>"
    - kind: plugin-data
      namespace: entries
      as: "<existing-entries>"
      format: summary
      maxEntries: 100
---

你是知识图鉴系统（Codex Tracker）...
```

---

## core-char-creator（角色创建，优先级 700，仅首轮，含 builtin 工具）

```markdown
---
name: core-char-creator
description: 角色创建引导。在游戏首轮生成角色创建表单，玩家填写后生成个性化角色引入叙事。
pluginType: core-plugin
priority: 700
model: ds
trigger:
  type: scheduled
  interval: 1
  maxTriggerCount: 1
tools:
  builtin:
    - create-form
input:
  inject:
    - from: core-narrator
      field: narrativeOutput
      as: "<narrator-opening>"
---

你是角色创建引导师...
```

---

## 多 runtime 插件（手动按钮 + 事件链 + 后台图像生成）

这是一个综合样例，覆盖**第三方插件**应该掌握的全部范式：

- 多 runtime 结构（根目录只有 `package.json`，所有 runtime 在 `runtimes/<id>/PLUGIN.md`）
- 前端 json-render UI 声明按钮和画廊
- 框架 `invokeRuntime` 默认 handler 让按钮零代码触发 runtime
- `execution: background` 让 wan2.x 这种耗时任务不阻塞 UI
- 事件链：agent 输出 → event → function runtime
- 玩家可调 `userSettings`
- 通过 `ctx.gateway.generateImage` 调 slot

### 目录结构

```
plugins/dashscope-image-gen/
├── package.json
└── runtimes/
    ├── prompt-generator/
    │   ├── PLUGIN.md          # agent:依据场景写图像 prompt
    │   └── ui/
    │       └── generate-button.json
    └── image-generator/
        ├── PLUGIN.md          # function:调 dashscope 生成图
        ├── handler.js
        └── ui/
            └── gallery.json
```

### `package.json`

```json
{
  "name": "@covel/plugin-dashscope-image-gen",
  "version": "0.0.0",
  "private": true,
  "type": "module"
}
```

### runtimes/prompt-generator/PLUGIN.md

```markdown
---
name: dashscope-image-gen/prompt-generator
description: 依据当前剧情场景生成图像 prompt。按钮手动触发,生成后 emit event 把 prompt 传给 image-generator。
priority: 600
model: fast
outputKind: plugin
trigger:
  type: manual
execution: sync                 # 生成 prompt 很快,不需要后台
input:
  inject:
    - from: core-narrator
      field: narrativeOutput
      as: "<current-scene>"
# 事件链由 agent 在 runtime output 里声明,框架 normalizeOutput 会把
# output.events[] 转成 event.emit proposal。frontmatter 不支持声明式
# `output.events` —— outputConfigSchema 是 strict 的,只允许 schema/recordAs。
# agent 的 prompt 正文需要要求模型输出:
#   { "prompt": "...", "events": [{"topic": "image.generate.requested", "data": {"prompt": "..."}}] }
userSettings:
  - key: promptMode
    type: select
    default: plain
    label: { zh: "提示词模式", en: "Prompt mode" }
    options:
      - { value: plain,      label: { zh: "纯文本", en: "Plain" } }
      - { value: image-json, label: { zh: "结构化 JSON", en: "Structured JSON" } }
ui:
  right: [./ui/generate-button.json]
---

你是一个图像 prompt 撰写助手...（省略)
```

### runtimes/prompt-generator/ui/generate-button.json

```json
{
  "id": "dashscope-trigger",
  "group": "image-studio",
  "groupLabel": { "zh": "图像", "en": "Images" },
  "groupOrder": 450,
  "label": { "zh": "生成", "en": "Generate" },
  "icon": "wand",
  "alwaysRender": true,
  "view": {
    "component": "Card",
    "children": [{
      "component": "Button",
      "props": {
        "label": { "zh": "生成图片", "en": "Generate image" },
        "variant": "primary"
      },
      "on": {
        "click": {
          "action": "invokeRuntime",
          "params": {
            "runtimeId": "dashscope-image-gen/prompt-generator"
          }
        }
      }
    }]
  }
}
```

> `invokeRuntime` 是框架默认 handler（在 `PluginPanel` 中已注册），插件**不需要**额外 React 代码。`postPluginRpc` / 错误 toast 都由框架处理。

### runtimes/image-generator/PLUGIN.md

```markdown
---
name: dashscope-image-gen/image-generator
description: 消费 image.generate.requested 事件,调 DashScope wan2.x 生成图片。
priority: 610
runtimeType: function
handler: ./handler.js
execution: background             # wan2.x 异步任务,不阻塞 UI
trigger:
  type: event
  topic: image.generate.requested
userSettings:
  - key: model
    type: select
    default: wan2.7-image-pro
    label: { zh: "模型", en: "Model" }
    options:
      - { value: wan2.7-image-pro,   label: { zh: "wan2.7 Pro", en: "wan2.7 Pro" } }
      - { value: wan2.5-image-turbo, label: { zh: "wan2.5 Turbo", en: "wan2.5 Turbo" } }
  - key: imageSize
    type: select
    default: "1024*1024"
    label: { zh: "尺寸", en: "Size" }
    options:
      - { value: "1024*1024", label: { zh: "1:1", en: "1:1" } }
      - { value: "1024*1792", label: { zh: "9:16", en: "9:16" } }
ui:
  right: [./ui/gallery.json]
---

函数 runtime 不使用 prompt 正文,保留说明性文字即可。
```

### runtimes/image-generator/handler.js

```js
/**
 * DashScope wan2.x 文生图 function handler.
 *
 * 由 event trigger 激活,通过 ctx.gateway 调 image slot 生成图片,
 * 把结果写到插件的 `images` 命名空间。
 */
// 单参签名 —— 运行时只传 ctx。返回普通 JSON:框架识别 pluginData[] /
// events[] / statePatches[] 等字段,normalizeOutput 转成 Proposal 走
// commit pipeline。其它字段作为 runtime output 持久化供下游 runtime 读取。
export default async function handler(ctx) {
  const prompt = ctx.triggerEvent?.data?.prompt ?? ctx.manualPayload?.prompt;
  if (typeof prompt !== 'string' || prompt.length === 0) {
    // 失败时也通过 pluginData 写入一条状态记录,前端 gallery 看到即可展示 failed。
    return {
      pluginData: [
        {
          namespace: 'images',
          key: ctx.turnId,
          value: { status: 'failed', error: 'missing prompt', completedAt: new Date().toISOString() },
        },
      ],
    };
  }

  // NOTE: 玩家级 userSettings 的服务端注入点仍在设计中(审计 F7)。
  // 在那之前,用 manifest 默认值或 ctx.manualPayload 里透传的字段。
  const model = ctx.manualPayload?.model ?? 'wan2.7-image-pro';
  const imageSize = ctx.manualPayload?.imageSize ?? '1024*1024';
  const startedAt = new Date().toISOString();

  try {
    const { images } = await ctx.gateway.generateImage({
      presetId: 'image',
      prompt,
      providerRequestMetadata: { model, size: imageSize },
    });
    const first = images?.[0];
    return {
      url: first?.url ?? null,
      mimeType: first?.mimeType ?? 'image/png',
      pluginData: [
        {
          namespace: 'images',
          key: ctx.turnId,
          value: {
            status: 'done',
            prompt,
            imageSize,
            startedAt,
            completedAt: new Date().toISOString(),
            url: first?.url ?? null,
            base64: first?.base64 ?? null,
            mimeType: first?.mimeType ?? 'image/png',
          },
        },
      ],
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      error: msg,
      pluginData: [
        {
          namespace: 'images',
          key: ctx.turnId,
          value: {
            status: 'failed',
            prompt,
            error: msg,
            startedAt,
            completedAt: new Date().toISOString(),
          },
        },
      ],
    };
  }
}
```

### runtimes/image-generator/ui/gallery.json

```json
{
  "id": "dashscope-gallery",
  "group": "image-studio",
  "label": { "zh": "画廊", "en": "Gallery" },
  "icon": "image",
  "dataSource": { "namespace": "images" },
  "emptyState": {
    "message": { "zh": "暂无图片", "en": "No images yet" }
  },
  "view": {
    "component": "Stack",
    "props": { "gap": "sm" },
    "children": [{
      "component": "CardList",
      "repeat": { "statePath": "/entries", "key": "key" },
      "children": [{
        "component": "Card",
        "children": [
          {
            "component": "Image",
            "props": {
              "src":      { "$item": "value/url" },
              "base64":   { "$item": "value/base64" },
              "mimeType": { "$item": "value/mimeType" },
              "alt":      { "$item": "value/prompt" },
              "aspectRatio": "1/1",
              "rounded": "md"
            }
          },
          { "component": "Text", "props": { "content": { "$item": "value/prompt" }, "size": "xs", "variant": "muted" } }
        ]
      }]
    }]
  }
}
```

> `dataSource.namespace: images` 告诉 `PluginPanel` 从 `plugin_data` 表 `(sessionId, pluginId, 'images')` 读并把记录摊平成 `entries[]`（`key`/`value` 两字段可直接在 spec 里用 `$item` 绑定）。

### 关键协议点

- 按钮点击 → `POST /api/sessions/:id/plugin-rpc` `{ pluginId, runtimeId: ".../prompt-generator" }`（框架 `invokeRuntime` handler）
- agent runtime 成功后通过 `output.events` 发出 `image.generate.requested`
- event trigger 拉起 image-generator,`execution: background` → 202 立即返回,`setImmediate` 后台跑
- handler 写 `plugin-data[images][turnId] = {status: 'done', url, ...}`
- store-proxy 自动广播 `plugin-data.changed` SSE
- 前端 `PluginPanel` 重新渲染 `gallery.json`

### API 密钥

通过 `llm.toml` 配 `[covel.image]` section(不要让插件读 `.env`):

```toml
[covel.image]
provider = "openai"          # 兼容 OpenAI Responses API 形态即可
base_url = "https://dashscope.aliyuncs.com/compatible-mode/v1"
model = "wan2.7-image-pro"
tag = "image"
```

在 `keys.env`（desktop）或 localStorage（web）配 `DASHSCOPE_API_KEY`。请求时会按 `tag=image` 的 fallback 链自动路由。

---

## 现有插件一览

| ID | 优先级 | 触发 | 类型 | 说明 |
|----|--------|------|------|------|
| core-pregame | 10 | scheduled(首轮) | function | 游戏初始化 |
| core-world-init/check-existing | 80 | scheduled(首轮) | function | 世界维度门控 |
| core-world-init/schema-gen | 85 | scheduled(首轮) | agent | 世界维度生成 |
| core-narrator | 500 | auto | agent | 主叙事 |
| core-codex | 650 | auto | agent | 知识图鉴 |
| core-char-creator | 700 | scheduled(首轮) | agent | 角色创建 |
| dashscope-image-gen/prompt-generator | 600 | manual | agent | 手动触发 prompt 生成 |
| dashscope-image-gen/image-generator | 610 | event | function (background) | 调 DashScope wan2.x 生图 |
