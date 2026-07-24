# dashscope-image-gen

基于阿里云 DashScope（通义万相 wan2.x）的 Covel 文生图插件。两段式流水线：LLM 撰写提示词 → 框架统一的 `ctx.images.generate()` 管线出图 → 写入 MediaStore → `images` 命名空间保存 `MediaRef` 画廊索引，右侧画廊面板自动刷新。

生成不再由插件自己发 HTTP 请求：DashScope wan2.x 的异步任务提交/轮询、`x`→`*` 尺寸分隔符转换、`wan2.7-image*` 系列剥离 `negative_prompt`（改为返回一条 warning）、按模型的 `n` 上限 clamp（wan2.6/wan2.7 image 系列 1–4，旧 wan2.x 单图）、`X-DashScope-Async` header、SSRF/重定向守卫、OSS URL 落 MediaStore，全部由框架的 `dashscope-wan` image wire（`@covel/ai-provider`）处理。插件本身没有任何 HTTP / SDK 依赖，只负责拼 prompt 和把返回的 `MediaRef[]` 落进画廊。

## 用途

- 玩家在剧情任意时刻点击「生成图片」按钮，根据当前氛围生成一张「此刻画面」或一页「多格漫画」
- 两条正交的画面控制轴：
  - **composition**：`single-scene`（单一画面）/ `comic-strip`（多格漫画时间线）
  - **promptMode**：`text`（自然语言段落）/ `image-json`（结构化 JSON）
- 漫画模式下支持「严格网格 / 动态跨格 / 大跨页主导」三种排版风格，可选 2-6 格
- 所有模式默认带上 4K / ultra detailed / masterpiece 等画质关键词，让模型按最高品质渲染
- 想在 `wan2.6-t2i` / `wan2.6-image` / `wan2.7-image` / `wan2.7-image-pro` 等模型间切换，加一个新 `llm.toml` slot 再改 `modelPresetId`（见「废弃字段」）。选型速记：`wan2.6-t2i` 纯文生图且**支持 `negative_prompt`**；`wan2.7-image` 快、`wan2.7-image-pro` 支持 4K 文生图，但两者都**不支持 `negative_prompt`**（wire 自动剥离）；这四个模型都支持一次 1–4 张（`n`）

## 组成

| Runtime                                | 类型                  | 触发                             | 职责                                                                                                                                                                                      |
| -------------------------------------- | --------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dashscope-image-gen/prompt-generator` | agent                 | manual                           | 读取最近的 prompt 历史，按 `promptMode` 产出 JSON envelope（顶层 `prompt` 字段 + `events[image.generate.requested]`），唤醒下游                                                           |
| `dashscope-image-gen/image-generator`  | function (background) | event:`image.generate.requested` | 调用 `ctx.images.generate()`（框架选 wire、发请求、落 MediaStore、按 promptHash 去重）→ 拿到 `MediaRef[]` 后写索引记录（含 `ref`）进 `images` 命名空间，并 emit `asset.generate` proposal |

## userSettings

prompt-generator：

| Key                | 类型   | 默认           | 说明                                                                                                                                                    |
| ------------------ | ------ | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `composition`      | select | `single-scene` | `single-scene` 画一张单一时刻画面；`comic-strip` 把整页当一张图，按时间线刻画多格连续瞬间                                                               |
| `comicPanels`      | select | `auto`         | 仅 `comic-strip` 生效。`auto` 让模型自定 2-6 格；其余值锁定 2/3/4/6 格                                                                                  |
| `comicLayoutStyle` | select | `dynamic`      | 仅 `comic-strip` 生效。`strict-grid` 规整网格、统一边框；`dynamic` 允许跨格构图、人物/动作打破 gutter；`splash-led` 一格大跨页占主导 + 小格作为时间锚点 |
| `promptMode`       | select | `text`         | `text` 输出 140-240 字（漫画模式 240-420 字）自然语言；`image-json` 输出结构化 JSON 控制镜头/光照/主体/风格/分格                                        |

> **画质保证**：所有模式都强制要求模型在 prompt 末尾或 `quality` 字段带上 `4K, 8K, ultra HD, ultra detailed, highly detailed, masterpiece, best quality, sharp focus, intricate details` 等关键词；漫画模式额外追加 `crisp ink lines, clean panel borders, professional manga / comic page composition`。这是写在 PLUGIN.md 里的硬规则，不是 image-generator 适配器层的拼接。
>
> **漫画模式建议尺寸**：在 image-generator 把 `imageSize` 切到 `1440x720`（横向条漫）/ `720x1440`（竖向卷轴）/ `1024x1024`（方形格）之一，避免方块裁切毁掉构图（统一写 `x` 分隔形式，wire 负责转换成 DashScope 的 `*` 形式）。

image-generator：

| Key                | 类型     | 默认                                                                     | 说明                                                                                                                                                                         |
| ------------------ | -------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `modelPresetId`    | text     | `image`                                                                  | `llm.toml` 中的 slot/preset id，决定 provider/baseUrl/apiKey/model。换模型 = 加一个新 slot 然后改这个值                                                                      |
| `imageSize`        | text     | `1024x1024`                                                              | 写 `x` 分隔像素形式（`1024x1024` / `1440x720` 等），wire 内部转成 DashScope 的 `*` 分隔；wan2.6/wan2.7 也接受 `1K` / `2K`（`4K` 仅 `wan2.7-image-pro` 文生图）档位，原样透传 |
| `n`                | number   | `1`                                                                      | 一次生成几张图；`wan2.6-image` / `wan2.6-t2i` / `wan2.7-image*` 支持 1–4（超出 clamp 到 4），更早的 wan2.x 仍为单图任务（clamp 到 1），均附 warning                          |
| `requestTimeoutMs` | number   | `300000`                                                                 | 单次生成最多等待多久（含轮询），避免图片任务一直停住                                                                                                                         |
| `quality`          | text     | `low`                                                                    | 画质提示；wan2.x 原生接口没有对应参数，wire 会忽略，仅作为记录里的展示字段保留                                                                                               |
| `negativePrompt`   | textarea | `low quality, blurry, watermark, text, extra fingers, distorted anatomy` | 透传给 wire；`wan2.7-image` 系列模型不支持，wire 自动剥离并返回 warning（记进 `_logs` + 记录的 `warnings` 字段）                                                             |

### 废弃字段

统一图像管线上线前，`image-generator` 曾提供 `model`（per-call 模型覆盖）设置，现已从 PLUGIN.md 中移除：

- **`model`**：框架的 `ctx.images.generate()` 只接受 `presetId`，不再接受 per-call 模型覆盖——想在 `wan2.7-image` / `wan2.7-image-pro` 之间切换，加一个新 `[covel.<slot>]` 再改 `modelPresetId`，而不是在同一个 slot 里临时换模型。

## 配置 llm.toml + keys.env

`~/.covel/llm.toml`：

```toml
[covel.image]
provider = "dashscope"
model    = "wan2.6-t2i"   # 文生图推荐：支持 negative_prompt + n 1–4；老部署可继续用 wan2.2-t2i-turbo
baseUrl  = "https://dashscope.aliyuncs.com"
apiKey   = "${env:DASHSCOPE_API_KEY}"
protocol = "openai-chat-v1"
tag      = "image"
output   = ["image"]
providerRequestMetadata = { imageWire = "dashscope-wan" }   # wan2.x 原生异步端点必须显式声明；不配则默认走 openai-images wire
```

想同时提供 `wan2.7-image-pro`（4K 文生图）作为可选模型？再加一个 slot，切 `modelPresetId` 即可：

```toml
[covel.image-pro]
provider = "dashscope"
model    = "wan2.7-image-pro"
baseUrl  = "https://dashscope.aliyuncs.com"
apiKey   = "${env:DASHSCOPE_API_KEY}"
protocol = "openai-chat-v1"
tag      = "image"
output   = ["image"]
providerRequestMetadata = { imageWire = "dashscope-wan" }
```

`~/.covel/keys.env`：

```
DASHSCOPE_API_KEY=sk-xxx
```

## 测试

通过 `@covel/test-runtime` 在仓库根目录直接跑，无需启动 server。Cases 定义在 [tests/runtime-cases.json](tests/runtime-cases.json)，每条 case 通过 `mode` 字段声明它是 mock-only / live-only / both。

### Mock 模式（默认）

只跑 `mode: "mock"` 的 case：用 stub LLM + mock slot，秒级完成，CI 友好。

```bash
pnpm test:runtime -- dashscope-image-gen --plugins-dir plugins --pretty
```

预期：全部 `mock-*` case passed（正向 envelope 触发 + 负路径可见失败，具体清单见 runtime-cases.json）。

正向 case 模拟 `prompt-generator` 输出包含 `events[image.generate.requested]` 的 envelope，框架自动唤醒 `image-generator` follower。mock harness 不装配 `ctx.images`（没有真实 gateway/MediaStore），follower 在拿到 `ctx.images` 之前直接返回可见失败（`status: "failed"`），这是预期行为、不是回归。断言验证：事件触发、follower 失败被正确记录。

### 单元测试（handler 入参断言）

`tests/handler.test.js` 直接 import `handler.js`，用手写的 mock `ctx.images.generate` 断言 wire 调用入参（`negativePrompt` 透传、`size` 保持原始 `x` 分隔形态不做本地转换、`n`/`quality`/`metadata` 等字段）。

```bash
pnpm --filter @covel/plugin-dashscope-image-gen test
```

### Live 模式

只跑 `mode: "live"` 的 case：真实调用 DeepSeek + DashScope，自动下载生成的 PNG 到 `tests/tmp/`。

```bash
pnpm test:runtime -- dashscope-image-gen --plugins-dir plugins --mode live --pretty
```

预期：

```text
live-text-cyberpunk-shrine         passed   (~30s)  → tests/tmp/live-text-cyberpunk-shrine-img-*.png
live-image-json-cyberpunk-shrine   passed   (~30s)  → tests/tmp/live-image-json-cyberpunk-shrine-img-*.png
```

只跑单条：

```bash
pnpm test:runtime -- dashscope-image-gen \
  --plugins-dir plugins \
  --case live-text-cyberpunk-shrine \
  --mode live --pretty
```

直接调用 `image-generator` 不经 LLM（手动给 prompt）：

```bash
pnpm test:runtime -- dashscope-image-gen/image-generator \
  --plugins-dir plugins \
  --payload '{"prompt":"a serene koi pond at dusk","promptMode":"text"}' \
  --user-settings '{"modelPresetId":"image","imageSize":"1024x1024"}' \
  --ignore-upstreams --mode live --pretty
```

## 对比结果

两条 live case 使用同一场景（赛博朋克和风神社、披风旅人持发光智能伞、湿石板反射霓虹），仅 `promptMode` 不同：

| 模式                          | 图片                                                                              | 风格观察                                                                                            |
| ----------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `text`（自然语言段落）        | ![text](tests/tmp/live-text-cyberpunk-shrine-img-modtaah5-an9mcs.png)             | 鸟居占比大，环境元素繁复，人物较小靠后；模型自由发挥构图                                            |
| `image-json`（结构化 schema） | ![image-json](tests/tmp/live-image-json-cyberpunk-shrine-img-modtb0tm-nvgy8i.png) | 低角度仰拍生效更明显，左右石灯笼对称严格，悬浮投影更密集，全息符纸辨识度高；JSON 字段被模型严格遵守 |

经验：`text` 适合追求氛围和氛围多样性；`image-json` 适合精确控制镜头/光照/构图（schema 字段几乎全被模型尊重）。

## 注意事项

- DashScope wan2.x 的 OSS 结果 URL 24h 后过期；`ctx.images.generate()` 内部把字节拉进框架的 `MediaStore` 并返回 `MediaRef`（`{ id, mime, size }`），永久内容寻址，画廊不会再出现 24h 后断图
- handler 同时 emit 一条 `asset.generate` proposal（`{ ref, modality: 'image', meta }`），由 kernel 落 trace + SSE，前端 `<Media>` / `AssetRender` 自动解析
- `wan2.7-image` 系列模型不支持 `negative_prompt`，框架的 `dashscope-wan` wire 自动剥离并返回一条 warning（不会报错），warning 会附在 `_logs` 的 `image.generate.completed` 条目和对应 `images` 记录的 `warnings` 字段上
- `image-json` 模式下 `prompt` 字段值是已经 stringify 的 JSON 字符串，DashScope 会把它当作 prompt 文本送入模型
- 相同参数（`presetId` + `prompt` + `negativePrompt` + `size` + `quality` + `n` + `background`）重复调用会命中框架的 promptHash 去重缓存，不会重新发起 DashScope 任务；命中时记录带 `cached: true`

### `images` namespace 字段

| 字段                                                                                                                                                          | 类型                 | 说明                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ref`                                                                                                                                                         | `MediaRef`           | 主图字节的内容寻址引用，`<Media src={ref} />` 解析                                                                                               |
| `refs`                                                                                                                                                        | `MediaRef[]`（可选） | 多图时的全部 refs，仅在图片源数量大于 1 时存在                                                                                                   |
| `warnings`                                                                                                                                                    | `string[]`（可选）   | wire 返回的非致命提示（如 negative_prompt 被剥离、n 被 clamp），仅在非空时出现                                                                   |
| `cached`                                                                                                                                                      | `boolean`（可选）    | 命中 promptHash 去重缓存时为 `true`，仅在命中时出现                                                                                              |
| `imageId` / `prompt` / `promptMode` / `presetId` / `imageSize` / `n` / `quality` / `requestTimeoutMs` / `status` / `startedAt` / `completedAt` / `durationMs` | —                    | 元数据，便于画廊过滤；不再包含 `provider` / `baseUrl` / `model`——`ctx.images.generate()` 不向插件回传这些字段，需要时去对应 `llm.toml` slot 里看 |
