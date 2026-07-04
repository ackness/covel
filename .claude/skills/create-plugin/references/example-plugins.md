# 现有插件样例

---

## narrator（主叙事，优先级 500，auto 触发）

```markdown
---
name: narrator
description: 主叙事生成器，负责根据玩家输入和世界观设定生成故事内容。每个 Turn 自动执行。
pluginType: core-plugin
priority: 500
model: story
outputKind: story
capabilities: [narrative]
trigger:
  type: auto
---

你是一个互动叙事游戏的叙述者（Narrator）...
```

---

## codex（知识图鉴，优先级 650，auto 触发，含本地工具）

```markdown
---
name: codex
description: 知识图鉴系统。分析叙事文本，记录玩家发现的怪物、道具、地点、传说和人物。
pluginType: plugin
priority: 650
model: plugin
upstreamRequired: [narrator]
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
    - from: narrator
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

## char-creator（角色创建，优先级 700，仅首轮，含 builtin 工具）

```markdown
---
name: char-creator
description: 角色创建引导。在游戏首轮生成角色创建表单，玩家填写后生成个性化角色引入叙事。
pluginType: core-plugin
priority: 700
model: story
trigger:
  type: scheduled
  interval: 1
  maxTriggerCount: 1
tools:
  builtin:
    - create-form
input:
  inject:
    - from: narrator
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
- 通过 `ctx.gateway.resolveSlot` 取 slot 配置，自管 provider wire 后落 `ctx.media`

> **图像生成已有更短路径**：框架现在内置图像 wire（`openai-images` / `dashscope-wan`，含 submit+poll），**写图像插件时把下面 handler 的整段自管 wire 替换为一次 `ctx.images.generate({prompt, metadata})`**——落 MediaStore、promptHash 去重全由框架完成，参考 `plugins/scene-stage/runtimes/background-gen/handler.js`。本样例的 wire 段保留作为「自管 wire」通用范式，对音频/视频/框架 wire 不覆盖的 provider 仍然适用；按钮 / 事件链 / 后台执行 / 画廊部分不受影响。

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
execution: sync # 生成 prompt 很快,不需要后台
input:
  inject:
    - from: narrator
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
      - { value: plain, label: { zh: "纯文本", en: "Plain" } }
      - {
          value: image-json,
          label: { zh: "结构化 JSON", en: "Structured JSON" },
        }
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
    "children": [
      {
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
      }
    ]
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
execution: background # wan2.x 异步任务,不阻塞 UI
trigger:
  type: event
  topic: image.generate.requested
userSettings:
  - key: model
    type: select
    default: wan2.7-image-pro
    label: { zh: "模型", en: "Model" }
    options:
      - {
          value: wan2.7-image-pro,
          label: { zh: "wan2.7 Pro", en: "wan2.7 Pro" },
        }
      - {
          value: wan2.5-image-turbo,
          label: { zh: "wan2.5 Turbo", en: "wan2.5 Turbo" },
        }
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
 * 由 event trigger 激活,通过 ctx.gateway.resolveSlot 取 image slot 配置,
 * 自管 provider wire 生成图片,落 MediaStore,再把 MediaRef 写到
 * 插件的 `images` 命名空间。
 */
// 单参签名 —— 运行时只传 ctx。返回普通 JSON:框架识别 pluginData[] /
// events[] / statePatches[] 等字段,normalizeOutput 转成 Proposal 走
// commit pipeline。其它字段作为 runtime output 持久化供下游 runtime 读取。
import { generateDashScopeImage } from "../../lib/dashscope.js";

export default async function handler(ctx) {
  const prompt = ctx.triggerEvent?.data?.prompt ?? ctx.manualPayload?.prompt;
  if (typeof prompt !== "string" || prompt.length === 0) {
    // 失败时也通过 pluginData 写入一条状态记录,前端 gallery 看到即可展示 failed。
    return {
      pluginData: [
        {
          namespace: "images",
          key: ctx.turnId,
          value: {
            status: "failed",
            error: "missing prompt",
            completedAt: new Date().toISOString(),
          },
        },
      ],
    };
  }

  // 玩家可调设置通过 ctx.userSettings 注入(框架 resolveUserSettings
  // 已把 manifest 默认和玩家值合并好)。按钮透传 ctx.manualPayload
  // 作为临时覆盖。
  const settings = ctx.userSettings ?? {};
  const model =
    ctx.manualPayload?.model ?? settings.model ?? "wan2.7-image-pro";
  const imageSize =
    ctx.manualPayload?.imageSize ?? settings.imageSize ?? "1024*1024";
  const startedAt = new Date().toISOString();

  try {
    const slot = ctx.gateway.resolveSlot({
      presetId: "image",
      fallbackTag: "image",
    });
    if (!slot?.baseUrl || !slot?.apiKey) {
      return {
        status: "failed",
        error: "image slot missing baseUrl/apiKey",
        pluginData: [
          {
            namespace: "images",
            key: ctx.turnId,
            value: {
              status: "failed",
              prompt,
              error: "image slot missing baseUrl/apiKey",
              startedAt,
            },
          },
        ],
      };
    }

    const guard = ctx.utils.validateBaseUrl(slot.baseUrl);
    if (!guard.ok) {
      return {
        status: "failed",
        error: `invalid image baseUrl: ${guard.reason}`,
        pluginData: [
          {
            namespace: "images",
            key: ctx.turnId,
            value: {
              status: "failed",
              prompt,
              error: `invalid image baseUrl: ${guard.reason}`,
              startedAt,
            },
          },
        ],
      };
    }

    // 自管 provider wire。真实 DashScope wan2.x 通常是 submit + poll;
    // 生产插件把 provider 细节放到 lib/dashscope.js,handler 只处理
    // Covel ctx / MediaRef / pluginData 契约。
    const generated = await generateDashScopeImage({
      baseUrl: slot.baseUrl,
      apiKey: slot.apiKey,
      model,
      prompt,
      imageSize,
    });

    const ref = generated.url
      ? await ctx.media.ingestUrl(generated.url, {
          allowedMimes: ["image/png", "image/jpeg", "image/webp"],
        })
      : await ctx.media.put(
          generated.bytes,
          generated.mimeType ?? "image/png",
          {
            plugin: "dashscope-image-gen",
            turnId: ctx.turnId,
            prompt,
            model,
            imageSize,
          },
        );

    const completedAt = new Date().toISOString();
    const expiresAt = generated.url
      ? new Date(Date.parse(completedAt) + 24 * 60 * 60 * 1000).toISOString()
      : null;
    return {
      ref,
      mimeType: ref.mime,
      pluginData: [
        {
          namespace: "images",
          key: ctx.turnId,
          value: {
            status: "done",
            prompt,
            imageSize,
            startedAt,
            completedAt,
            ref,
            mimeType: ref.mime,
            ...(expiresAt ? { expiresAt } : {}),
          },
        },
      ],
      assetGenerations: [
        { ref, modality: "image", meta: { prompt, imageSize, model } },
      ],
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      error: msg,
      pluginData: [
        {
          namespace: "images",
          key: ctx.turnId,
          value: {
            status: "failed",
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
    "children": [
      {
        "component": "CardList",
        "repeat": { "statePath": "/entries", "key": "key" },
        "children": [
          {
            "component": "Card",
            "children": [
              {
                "component": "Image",
                "props": {
                  "ref": { "$item": "value/ref" },
                  "alt": { "$item": "value/prompt" },
                  "aspectRatio": "1/1",
                  "rounded": "md"
                }
              },
              {
                "component": "Text",
                "props": {
                  "content": { "$item": "value/prompt" },
                  "size": "xs",
                  "variant": "muted"
                }
              }
            ]
          }
        ]
      }
    ]
  }
}
```

> `dataSource.namespace: images` 告诉 `PluginPanel` 从 `plugin_data` 表 `(sessionId, pluginId, 'images')` 读并把记录摊平成 `entries[]`（`key`/`value` 两字段可直接在 spec 里用 `$item` 绑定）。

### 关键协议点

- 按钮点击 → `POST /api/sessions/:id/plugin-rpc` `{ pluginId, runtimeId: ".../prompt-generator" }`（框架 `invokeRuntime` handler）
- agent runtime 成功后通过 `output.events` 发出 `image.generate.requested`
- event trigger 拉起 image-generator,`execution: background` → HTTP 立即返回 jobId(框架内部 `_jobs/<jobId>` 记录),handler 在后台跑
- handler 写 `plugin-data[images][turnId] = {status: 'done', ref, ...}` 并返回 `assetGenerations[]`
- store-proxy 自动广播 `plugin-data.changed` SSE
- 前端 `PluginPanel` 重新渲染 `gallery.json`

### API 密钥

通过 `llm.toml` 配 `[covel.image]` section(不要让插件读 `.env`):

```toml
[covel.image]
provider = "dashscope"       # 插件自管 wire 时主要用于标识和 key 解析
baseUrl = "https://dashscope.aliyuncs.com"
model = "wan2.7-image-pro"
tag = "image"
```

在 `keys.env`（desktop）或 localStorage（web）配 `DASHSCOPE_API_KEY`。handler 通过 `ctx.gateway.resolveSlot({ presetId: 'image', fallbackTag: 'image' })` 读取 `baseUrl/apiKey/model`，再自管 DashScope submit + poll。

---

## mimo-tts（自动 + 手动 + 多媒体音频范式）

跟 dashscope-image-gen 同形态，但产出 audio 而不是 image，并演示「auto-trigger 接 narrator」+ 「ui.message 内嵌按钮」+ 「provider 用自定义 header」三个新点。完整代码：`~/.covel/plugins/mimo-tts/`。

### 目录

```
~/.covel/plugins/mimo-tts/
├── package.json
├── PLUGIN.md                          # 包级摘要(name/description/pluginType)
├── README.md
├── lib/
│   └── mimo-tts.js                    # 共享 wire(api-key 头 + base64 解码) + persistTrack
├── runtimes/
│   ├── auto-narrate/
│   │   ├── PLUGIN.md                  # function · auto · upstreamRequired:[narrator] · priority 700
│   │   ├── handler.js
│   │   └── ui/audio-tab.json          # 右侧 Tab,Media as=audio,纯原生控件
│   └── manual-narrate/
│       ├── PLUGIN.md                  # function · manual · execution: background · priority 750
│       ├── handler.js
│       └── ui/play-button.json        # ui.message 嵌入消息流(像「插入图像」)
└── tests/                             # vitest L2,mock fetch + ctx.media
    ├── mimo-tts-wire.test.js
    └── handlers.test.js
```

### 关键决策点

1. **自动 + 手动 = 两个 runtime 共享 lib**。auto runtime `trigger.type: auto` + `upstreamRequired:[narrator]` + `priority: 700` 让它跑在 narrator 之后；manual runtime `trigger.type: manual` + `execution: background`，按钮点击 → POST /plugin-rpc → 框架立即返回 jobId，handler 后台跑。两边都写到同一个 `tracks` namespace,所以右侧 Tab 是统一时间轴。
2. **Provider 自管 wire**。MiMo 用 `api-key: <KEY>` 头(不是 `Authorization: Bearer`),且文本要塞在 `messages: [{role: 'assistant', content}]`(违反 OpenAI 习惯)。所以 handler 里直接 `await fetch(slot.baseUrl + '/v1/chat/completions', { headers: { 'api-key': slot.apiKey } ... })`,不调 `gateway.generateText`。`ctx.gateway.resolveSlot({presetId, fallbackTag: 'speech'})` 只用来取配置,**不**触发框架的统一 wire。
3. **音频字节 → MediaStore**。

   ```js
   const ref = await ctx.media.put(bytes, mime, { plugin: 'mimo-tts', turnId, ... });
   return {
     pluginData: [{ namespace: 'tracks', key: trackId, value: { ref, status: 'done', ... } }],
     assetGenerations: [{ ref, modality: 'audio', meta: { turnId, model, voice, ... } }],
   };
   ```

   `assetGenerations[]` 让框架 emit `asset.generate` proposal,trace + SSE + render 链路自动广播。

4. **UI 渲染靠 `<Media as="audio">`**。json-render spec:

   ```json
   {
     "component": "Media",
     "props": {
       "ref": { "$item": "value/ref" },
       "as": "audio",
       "alt": { "$item": "value/text" }
     }
   }
   ```

   浏览器原生 `<audio controls>` 就给了播放/暂停/时间轴拖动;overflow 菜单可下载,右键改速度。autoplay / 速度按钮 / 流式播放都是后续路线图(README 已写明)。

5. **按钮放消息流**。manual runtime 的 `ui.message: [./ui/play-button.json]` 把按钮渲染到剧情泡里,跟「插入图像」交互一致;auto runtime 的 `ui.right: [./ui/audio-tab.json]` 把全部音轨列表放右侧 Tab。

### Slot 配置（用户侧）

```toml
[covel.tts]
provider = "mimo"
baseUrl  = "https://api.xiaomimimo.com"
apiKey   = "${env:MIMO_API_KEY}"
model    = "mimo-v2.5-tts"
tag      = "speech"
```

`MIMO_API_KEY` 写到 `~/.covel/keys.env`(desktop)或 localStorage(web)。`tag: speech` 让任何后续未配置的 speech slot 自动 fallback 到这里。

---

## 现有插件一览（截至 v0.0.3）

来源:`plugins/**/PLUGIN.md` 真实 frontmatter。priority 数字若与本表对不上,以仓库实际为准。

| Runtime                              | 优先级 | 触发                       | 类型                  | 说明                                                              |
| ------------------------------------ | ------ | -------------------------- | --------------------- | ----------------------------------------------------------------- |
| pregame                              | 10     | scheduled(首轮)            | function              | 游戏初始化                                                        |
| world-init/schema-gen                | 40     | scheduled(首轮)            | agent + guard         | 世界维度生成,guard 已存在则跳过                                   |
| char-creator/player-init             | 50     | scheduled(首轮)            | agent                 | 玩家建角表单                                                      |
| npc-graph/rag-retriever              | 400    | auto                       | function              | 给 narrator 拉 NPC 结构化检索                                     |
| narrator                             | 500    | auto                       | agent                 | 主叙事                                                            |
| codex                                | 600    | auto                       | agent                 | 知识图鉴                                                          |
| guide                                | 600    | auto                       | agent                 | 行动引导                                                          |
| npc-graph/extractor                  | 600    | auto                       | agent                 | NPC 关系抽取                                                      |
| char-creator/character-tracker       | 600    | auto                       | agent                 | 角色状态跟踪                                                      |
| memory                               | —      | UI only                    | UI                    | 仅前端面板                                                        |
| dashscope-image-gen/prompt-generator | 600    | manual                     | agent                 | 手动触发 prompt 生成(`~/.covel/plugins/`,样例)                    |
| dashscope-image-gen/image-generator  | 610    | event                      | function (background) | 调 DashScope wan2.x 生图(`~/.covel/plugins/`,样例)                |
| mimo-tts/auto-narrate                | 700    | auto + upstream:[narrator] | function              | narrator 后自动 TTS,写 tracks namespace(`~/.covel/plugins/`,样例) |
| mimo-tts/manual-narrate              | 750    | manual                     | function (background) | 手动「朗读」按钮,ui.message 嵌入消息流(`~/.covel/plugins/`,样例)  |
