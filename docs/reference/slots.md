# 模型 Slot 配置

Slot 是 Covel 的模型路由单元：`llm.toml` 里每个 `[covel.<slot>]` 小节定义一个具名 slot，运行时（narrator、插件、图像/语音管线）按 slot 名或 tag 解析到具体 provider + model。开发环境读仓库根 `llm.toml`，桌面端读 `~/.covel/llm.toml`（Settings 内热重载）。`llm.toml` 缺失时服务器回落到内置 DeepSeek `story` slot 照常启动。

## Slot 字段（`[covel.<slot>]`）

Schema：`packages/ai-provider/src/config/llm-schema.ts`。

| 字段                                | 必填 | 说明                                                                                             |
| ----------------------------------- | ---- | ------------------------------------------------------------------------------------------------ |
| `provider`                          | ✅   | Provider 标识，对应 `.env.llm` / `keys.env` 里的 `{PROVIDER}_API_KEY`                            |
| `model`                             | ✅   | 传给 provider API 的模型 ID                                                                      |
| `baseUrl`                           | ✅   | API 端点（受 SSRF 守卫约束：远端必须 https，loopback 允许 http）                                 |
| `protocol`                          | ✅   | `openai-chat-v1` / `openai-responses-v1` / `anthropic-messages-v1`                               |
| `tag`                               | —    | 能力标签：`text` / `image` / `embedding` / `speech` / `transcription`。缺省从 output 模态推断    |
| `fallback`                          | —    | 失败时回落的 slot 名                                                                             |
| `input` / `output`                  | —    | 模态覆盖（缺省自动检测，见下）。`output` 支持 `text` / `image` / `audio` / `video` / `embedding` |
| `features`                          | —    | 特性旗标（`function_calling`、`reasoning`、`vision`…）                                           |
| `contextWindow` / `maxOutputTokens` | —    | token 上限覆盖                                                                                   |
| `pricing`                           | —    | 计价信息（用于 /debug 成本面板）                                                                 |
| `thinking` / `reasoning_effort`     | —    | 思考模式控制（DeepSeek `thinking`、`reasoning_effort`）                                          |
| `embeddingFormat`                   | —    | embed slot 的请求体形态：`openai`（默认）/ `nemotron-multimodal`                                 |
| `providerRequestMetadata`           | —    | 自由 KV，合入该 slot 每次请求体（per-call metadata 优先）。媒体 wire 路由键也放这里，见下        |

## Slot 解析链

1. **具名命中** — 请求指定 `presetId`（如 `ctx.images.generate({ presetId: "image" })`）时直接按名解析；`default` 自动别名到 llm.toml 里定义的第一个 slot。
2. **Tag-aware fallback** — 具名未命中时，回落到第一个**同 tag** 的 slot（`gateway-slot-resolution.ts`）。**跨 tag fallback 被禁止**：image 请求永远不会静默路由到 text slot。
3. **省略 presetId** — 媒体操作有约定默认名：`generateImage` → `"image"`、`synthesizeSpeech` → `"speech"`、`transcribeAudio` → `"transcription"`，保证进入同 tag fallback 链而不是落到默认 text slot。
4. **Per-runtime 覆盖** — `sessions.runtime_model_overrides`（runtimeId → slot 名）先于 `manifest.model` 与 gateway 默认（`packages/runtime/src/agent-loop/agent-loop-policy.ts`；请求级 `modelOverride` 只对 `outputKind: story` 的 runtime 优先于它）。
5. **Per-request 覆盖** — 前端经 `X-Slot-Config` / `X-Provider-Keys` header 注入的自定义 preset 与 key 覆盖同名配置（`middleware/per-request-llm.ts`）。

模型能力（模态 / 特性 / 上限 / 计价）自动检测优先级：前端 localStorage 覆盖 → `llm.toml` 手动字段 → `known-models.ts` → LiteLLM DB（`pnpm --filter @covel/ai-provider update-model-db`）→ 协议默认。

## 媒体 wire 路由键（`providerRequestMetadata`）

图像 / TTS / STT 的请求体格式由 **wire** 决定（一个 wire = 一家厂商的请求/响应形态），slot 通过 `providerRequestMetadata` 里的路由键选 wire：

| 路由键              | 适用 tag        | 内置 wire（缺省值加粗）                                                                                                                                    |
| ------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `imageWire`         | `image`         | **`openai-images`**、`dashscope-wan`（DashScope 原生图像面：wan2.x 走异步任务轮询；`qwen-image*` 系列——含 qwen-image-3.0-pro——自动切同步 multimodal 端点） |
| `speechWire`        | `speech`        | **`openai-speech`**（`POST /audio/speech`）                                                                                                                |
| `transcriptionWire` | `transcription` | **`openai-transcription`**（`/audio/transcriptions`）                                                                                                      |

```toml
[covel.image]
provider = "dashscope"
model = "wan2.7-image-pro"
baseUrl = "https://dashscope.aliyuncs.com"
protocol = "openai-chat-v1"
tag = "image"
output = ["image"]
providerRequestMetadata = { imageWire = "dashscope-wan" }

[covel.mimo-tts]
provider = "xiaomi"
model = "mimo-v2.5-tts"
baseUrl = "https://token-plan-cn.xiaomimimo.com/v1"
protocol = "openai-chat-v1"
tag = "speech"
output = ["audio"]
# 插件注册的 wire 带 <pluginId>/ 前缀
providerRequestMetadata = { speechWire = "mimo-tts/mimo" }
```

- 路由键在进入 wire 前被剥离，不会泄漏到厂商请求体。
- 未注册的 wire id 在生成时抛 `CONFIG_ERROR`（报错信息含修复指引），不会静默回落。
- 插件在 `entry` 模块里用 `covel.registerWires({ image?, speech?, transcription? })` 注册自定义 wire（frontmatter 的 `wires` 字段仍被接受但已弃用）—— 见 [plugin-authoring-advanced.md § 注册自定义 wire](../guide/plugin-authoring-advanced.md#注册自定义-wirewires-frontmatter-字段)；wire 与 MediaStore 的关系见 [media-store.md](./media-store.md#media-wire-registries-image--speech--transcription)。

## API Key 流转

Key 永远不进 `llm.toml`：dev 放 `.env.llm`，桌面端放 `~/.covel/keys.env`（mode 600），纯 web 放 localStorage（`covel:keys`）。每次 AI 请求经 `X-Provider-Keys` header（base64 JSON `{provider: key}`）到达服务端，按目标 slot 的 `provider` 名分发绑定 —— wire 拿到的 `config.apiKey` 已是该 slot provider 的 key，客户端 key 覆盖 env key。
