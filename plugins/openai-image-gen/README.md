# openai-image-gen

OpenAI 兼容图像生成插件。生成走框架统一的 `ctx.images.generate()` 管线——插件只负责拼 prompt 和把返回的 `MediaRef[]` 落进画廊，HTTP 调用、SSRF 守卫、响应解析、幂等去重全部由框架处理。可指向任何 OpenAI-API 兼容的第三方供应商，默认模型 `gpt-image-2`。

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
| `openai-image-gen/prompt-generator` | agent                 | manual                                  | 读取最近 prompt 历史，按 `composition` × `promptMode` 组合写出图像 prompt（默认带 4K / ultra detailed 等画质词；漫画模式额外带 crisp ink lines / clean panel borders），唤醒下游          |
| `openai-image-gen/image-generator`  | function (background) | event:`openai-image.generate.requested` | 调用 `ctx.images.generate()`（框架选 wire、发请求、落 MediaStore、按 promptHash 去重）→ 拿到 `MediaRef[]` 后写索引记录（含 `ref`）进 `images` 命名空间，并 emit `asset.generate` proposal |

## userSettings

prompt-generator（与 dashscope 同构，便于熟悉的玩家无缝切换）：

| Key                | 类型   | 默认           | 说明                                                      |
| ------------------ | ------ | -------------- | --------------------------------------------------------- |
| `composition`      | select | `single-scene` | `single-scene` 单一时刻；`comic-strip` 整页多格漫画时间线 |
| `comicPanels`      | select | `auto`         | 仅 `comic-strip` 生效；`auto` 让模型自定 2-6 格           |
| `comicLayoutStyle` | select | `dynamic`      | `strict-grid` / `dynamic` / `splash-led`                  |
| `promptMode`       | select | `text`         | `text` 自然语言 / `image-json` 结构化 JSON                |

image-generator：

| Key             | 类型   | 默认           | 说明                                                                                                |
| --------------- | ------ | -------------- | --------------------------------------------------------------------------------------------------- |
| `modelPresetId` | text   | `openai-image` | 对应 `~/.covel/llm.toml` 里的 `[covel.<slot>]` 名字。换第三方 / 换模型 = 加一个新 slot 然后改这个值 |
| `imageSize`     | text   | `1024x1024`    | OpenAI Images API size 参数（小写 x）                                                               |
| `n`             | number | `1`            | 一次生成几张图                                                                                      |
| `quality`       | text   | _(空)_         | 可选；`standard` / `hd`；空 = 不传                                                                  |
| `style`         | text   | _(空)_         | 可选；没有独立的 wire 参数，会拼进 prompt 文案末尾（`<prompt>, style: <style>`）                    |

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
# Mock 模式 — 不调真实 API，验证事件包络（image-generator 在 mock 模式下
# ctx.images 不可用，预期 status: failed，这是正常现象，不是回归）
pnpm test:runtime -- openai-image-gen --plugins-dir plugins --pretty

# Live 模式 — 需要 keys.env 里有 OPENAI_API_KEY 且 llm.toml 配好 openai-image slot，
# 会真实出图保存到 tests/tmp/
pnpm test:runtime -- openai-image-gen --plugins-dir plugins --mode live --pretty
```

## 第三方供应商示例

某些 OpenAI 兼容图像供应商：

- **Together AI**: `baseUrl=https://api.together.xyz/v1`, model 如 `black-forest-labs/FLUX.1-schnell-Free`
- **Fireworks**: `baseUrl=https://api.fireworks.ai/inference/v1`, model 如 `accounts/fireworks/models/flux-1-schnell`
- **DeepInfra**: `baseUrl=https://api.deepinfra.com/v1/openai`
- **fal.ai (OpenAI shim)**: 见 fal-ai 文档配置

框架的 `openai-images` wire 认标准 OpenAI Images 响应形状（`data[].b64_json` / `data[].url`）；供应商响应形状不同时通过 `providerRequestMetadata.imageWire` 切换到其他已注册 wire，而不是改插件代码。

## 注意事项

- `gpt-image-2` 是默认占位；如果你的供应商没有这个模型，把 llm.toml 里 slot 的 `model` 改成实际可用的（`gpt-image-1` / `dall-e-3` 等）
- SSRF 守卫、baseUrl 校验、重试都由框架的 `ctx.images.generate()` 统一处理，插件不再自己做这些检查
- 画廊 UI 接 `images` 命名空间；`ctx.images.generate()` 已经把字节落进 MediaStore 并返回 `MediaRef[]`，handler 只需把 `ref` 写进 `images.<imageId>` 记录；多图请求会发布 `images.<imageId>-1`、`images.<imageId>-2` 这类独立记录，SSE `plugin-data.changed` 自动刷新；前端用 `<Media src={ref}>` 组件解析
- **凭据流向**：插件**不**持久化 apiKey/baseUrl 在 settings.json；`ctx.images.generate()` 内部通过 `modelPresetId` 从框架解析 slot，与 dashscope-image-gen 完全同模式
- 本插件不依赖任何 npm 包（`package.json` 无 `dependencies`），无需 `npm install`
