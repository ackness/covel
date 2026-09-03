# openai-image-gen

OpenAI Images API 图像生成插件。生成走框架统一的 `ctx.images.generate()` 管线——插件只负责拼 prompt 和把返回的 `MediaRef[]` 落进画廊，HTTP 调用、SSRF 守卫、响应解析、幂等去重全部由框架处理。默认模型是 `gpt-image-2`；只有实现标准 OpenAI Images 请求和响应形状的第三方服务才能复用当前 `openai-images` wire。

**全部凭据走 `~/.covel/llm.toml`**，与 dashscope-image-gen 同构——加新供应商只改一个 `[covel.<slot>]` 块，不动插件代码。

## 与 dashscope-image-gen 的差异

| 维度       | openai-image-gen                                               | dashscope-image-gen                                     |
| ---------- | -------------------------------------------------------------- | ------------------------------------------------------- |
| 默认模型   | `gpt-image-2`                                                  | `wan2.7-image-pro`                                      |
| 尺寸格式   | `1024x1024`（小写 x）                                          | `1024*1024`（星号）                                     |
| 事件 topic | `openai-image.generate.requested`                              | `image.generate.requested`                              |
| 凭据来源   | `~/.covel/llm.toml` 的 `[covel.<slot>]`（默认 `openai-image`） | `~/.covel/llm.toml` 的 `[covel.<slot>]`（默认 `image`） |

两个插件可以同时启用，事件 topic 不同所以不会双触发，画廊也各自独立（`pluginData` 按 `pluginId` 隔离）。两者的 wire 都由框架的 image-wire 注册表处理，插件本身没有任何 HTTP / SDK 依赖。

## 配置 llm.toml + keys.env

### `~/.covel/llm.toml`

加一个 slot：

```toml
[covel.openai-image]
provider = "openai"
model    = "gpt-image-2"
baseUrl  = "https://api.openai.com/v1"      # 第三方就改这一行
apiKey   = "${env:OPENAI_API_KEY}"           # 第三方就改 env 变量名
protocol = "openai-chat-v1"
tag      = "image"
output   = ["image"]
```

`tag = "image"` 是关键——框架靠它把 `modelPresetId` 解析到 image wire。默认 wire 是 `openai-images`，无需额外声明；如果第三方响应体不是标准 OpenAI Images 形状，在 slot 里加 `providerRequestMetadata.imageWire = "<其他已注册的 wire id>"`。

### `~/.covel/keys.env`

```
OPENAI_API_KEY=sk-xxx
```

第三方 key + baseUrl **必须同时**给——两行同时改。

### 同时启用两个图像插件

```toml
[covel.image]                              # dashscope wan2.7
provider = "dashscope"
model    = "wan2.7-image-pro"
baseUrl  = "https://dashscope.aliyuncs.com"
apiKey   = "${env:DASHSCOPE_API_KEY}"
protocol = "openai-chat-v1"
tag      = "image"
output   = ["image"]

[covel.openai-image]                       # OpenAI / 第三方 GPT-Image
provider = "openai"
model    = "gpt-image-2"
baseUrl  = "https://api.openai.com/v1"
apiKey   = "${env:OPENAI_API_KEY}"
protocol = "openai-chat-v1"
tag      = "image"
output   = ["image"]
```

dashscope-image-gen 默认 `modelPresetId = "image"` → wan2.7；openai-image-gen 默认 `modelPresetId = "openai-image"` → gpt-image-2。前端右侧面板各有独立的「生成」按钮和画廊。

## 组成

| Runtime                             | 类型                  | 触发                                    | 职责                                                                                                                                                                                      |
| ----------------------------------- | --------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `openai-image-gen/prompt-generator` | agent (background)    | manual                                  | 后台读取最近 prompt 历史，按 `composition` × `promptMode` 组合写出图像 prompt，并调用对应提交工具统一留档、发出固定事件、唤醒下游                                                         |
| `openai-image-gen/image-generator`  | function (background) | event:`openai-image.generate.requested` | 调用 `ctx.images.generate()`（框架选 wire、发请求、落 MediaStore、按 promptHash 去重）→ 拿到 `MediaRef[]` 后写索引记录（含 `ref`）进 `images` 命名空间，并 emit `asset.generate` proposal |

## userSettings

prompt-generator（与 dashscope 同构，便于熟悉的玩家无缝切换）：

| Key                | 类型   | 默认          | 说明                                                      |
| ------------------ | ------ | ------------- | --------------------------------------------------------- |
| `composition`      | select | `comic-strip` | `single-scene` 单一时刻；`comic-strip` 整页多格漫画时间线 |
| `comicPanels`      | select | `auto`        | 仅 `comic-strip` 生效；`auto` 让模型自定 2-6 格           |
| `comicLayoutStyle` | select | `dynamic`     | `strict-grid` / `dynamic` / `splash-led`                  |
| `promptMode`       | select | `text`        | `text` 自然语言 / `image-json` 结构化 JSON                |

image-generator：

| Key             | 类型   | 默认           | 说明                                                                                                                           |
| --------------- | ------ | -------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `modelPresetId` | slot   | `openai-image` | 对应 `~/.covel/llm.toml` 里的 `[covel.<slot>]` 名字，UI 渲染成已配置槽的选择器。换第三方 / 换模型 = 加一个新 slot 然后改这个值 |
| `imageSize`     | text   | `1024x1024`    | OpenAI Images API size 参数（小写 x）                                                                                          |
| `n`             | number | `1`            | 一次生成几张图                                                                                                                 |
| `quality`       | text   | `low`          | GPT Image 可填 `low` / `medium` / `high` / `auto`                                                                              |
| `style`         | text   | _(空)_         | 可选；没有独立的 wire 参数，会拼进 prompt 文案末尾（`<prompt>, style: <style>`）                                               |

> **画质保证**：4K / ultra detailed / masterpiece 等关键词写在 prompt-generator 的 PLUGIN.md 系统提示里，模型在每条 prompt 末尾或 `quality` 字段强制带上。漫画模式额外追加 `crisp ink lines, clean panel borders, professional manga / comic page composition`。

### 废弃字段

统一图像管线上线前，`image-generator` 曾提供 `model`（per-call 模型覆盖）、`maxRetries`（失败重试次数）、`extraProviderOptions`（透传额外 JSON 参数）三个设置。现已从 PLUGIN.md 中移除：

- **`model`**：框架的 `ctx.images.generate()` 只接受 `presetId`，不再接受 per-call 模型覆盖——想换模型，加一个新 `[covel.<slot>]` 再切 `modelPresetId`。
- **`maxRetries`**：迁移前就是死字段（handler 从未真正实现过重试逻辑），移除是诚实化，不是功能回归。
- **`extraProviderOptions`**：不再有插件侧透传路径。改在 llm.toml 的 slot 里配置**静态**的 `providerRequestMetadata`（对所有走该 slot 的请求生效，不是 per-call）：

```toml
[covel.openai-image]
provider = "openai"
model    = "gpt-image-2"
baseUrl  = "https://api.openai.com/v1"
apiKey   = "${env:OPENAI_API_KEY}"
protocol = "openai-chat-v1"
tag      = "image"
output   = ["image"]

[covel.openai-image.providerRequestMetadata]
# 任意会被合并进 wire 请求体的额外字段，供应商相关
moderation = "low"
```

## 测试

```bash
# Mock 模式 — 不调真实 API，验证工具提交与固定事件（image-generator 在 mock 模式下
# ctx.images 不可用，预期 status: failed，这是正常现象，不是回归）
pnpm test:runtime -- openai-image-gen --plugins-dir plugins --pretty

# Live 模式 — 需要 keys.env 里有 OPENAI_API_KEY 且 llm.toml 配好 openai-image slot，
# 会真实出图保存到 tests/tmp/
pnpm test:runtime -- openai-image-gen --plugins-dir plugins --mode live --pretty
```

## 第三方供应商

当前 `openai-images` wire 固定调用 `POST /images/generations`，并解析 `data[].b64_json` / `data[].url`。以下两个供应商的官方文档明确提供该兼容接口：

- **Together AI**: `baseUrl=https://api.together.xyz/v1`，`model=black-forest-labs/FLUX.1-schnell`。不要使用已下线的 `black-forest-labs/FLUX.1-schnell-Free`。参见 [Together Images API](https://docs.together.ai/reference/post-images-generations) 和 [Together 模型下线记录](https://docs.together.ai/docs/deprecations)。
- **DeepInfra**: `baseUrl=https://api.deepinfra.com/v1/openai`，`model=black-forest-labs/FLUX-1-schnell`。参见 [DeepInfra Image Generation API](https://docs.deepinfra.com/apis/image-generation)。

Fireworks 当前使用模型 workflow 端点且响应形状不同，fal.ai 当前官方接口是 `fal.run`/队列协议；两者都不能配成当前 `openai-images` wire。除非框架后续注册对应专用 wire，不要把它们的 Base URL 填入本插件示例。

## 注意事项

- `gpt-image-2` 是 OpenAI 默认模型。使用第三方服务时，必须改成该服务实际提供的模型 ID。`gpt-image-1` 已弃用，`dall-e-3` 已从 API 移除，不再作为可用备选；参见 [OpenAI GPT Image 2](https://developers.openai.com/api/docs/models/gpt-image-2)。
- SSRF 守卫、baseUrl 校验、重试都由框架的 `ctx.images.generate()` 统一处理，插件不再自己做这些检查
- 画廊 UI 接 `images` 命名空间；`ctx.images.generate()` 已经把字节落进 MediaStore 并返回 `MediaRef[]`，handler 只需把 `ref` 写进 `images.<imageId>` 记录；多图请求会发布 `images.<imageId>-1`、`images.<imageId>-2` 这类独立记录，SSE `plugin-data.changed` 自动刷新；前端用 `<Media src={ref}>` 组件解析
- **凭据流向**：插件**不**持久化 apiKey/baseUrl 在 settings.json；`ctx.images.generate()` 内部通过 `modelPresetId` 从框架解析 slot，与 dashscope-image-gen 完全同模式
- 本插件不引入第三方 HTTP SDK；依赖由 Covel 根 workspace 统一安装。
