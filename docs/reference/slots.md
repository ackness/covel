# 模型用途（Slot）配置

Slot 是 Covel 内部的模型路由单元，设置界面称为“模型用途”。`llm.toml` 里每个 `[covel.<slot>]` 小节定义一个具名用途，插件任务按 slot 名或 tag 解析到具体服务商和模型。开发环境读仓库根 `llm.toml`，桌面端读 `~/.covel/llm.toml`（设置内可热重载）。`llm.toml` 缺失时，服务器使用内置的 DeepSeek `story` 用途和 `deepseek-v4-flash`。

## Slot 字段（`[covel.<slot>]`）

Schema：`packages/ai-provider/src/config/llm-schema.ts`。

| 字段                                | 必填 | 说明                                                                                             |
| ----------------------------------- | ---- | ------------------------------------------------------------------------------------------------ |
| `provider`                          | ✅   | 服务商标识，对应 `.env.llm` / `keys.env` 里的 `{PROVIDER}_API_KEY`                               |
| `model`                             | ✅   | 原样传给服务商 API 的模型 ID                                                                     |
| `baseUrl`                           | ✅   | API 端点（受 SSRF 守卫约束：远端必须 https，loopback 允许 http）                                 |
| `protocol`                          | ✅   | `openai-chat-v1` / `openai-responses-v1` / `anthropic-messages-v1`                               |
| `tag`                               | —    | 能力标签：`text` / `image` / `embedding` / `speech` / `transcription`。缺省从 output 模态推断    |
| `fallback`                          | —    | 失败时回落的 slot 名                                                                             |
| `input` / `output`                  | —    | 模态覆盖（缺省自动检测，见下）。`output` 支持 `text` / `image` / `audio` / `video` / `embedding` |
| `features`                          | —    | 特性旗标（`function_calling`、`reasoning`、`vision`…）                                           |
| `contextWindow` / `maxOutputTokens` | —    | token 上限覆盖                                                                                   |
| `pricing`                           | —    | 计价信息（用于 /debug 成本面板）                                                                 |
| `thinking` / `reasoning_effort`     | —    | 思考模式与强度；按目标协议转换为对应请求字段                                                     |
| `embeddingFormat`                   | —    | embed slot 的请求体形态：`openai`（默认）/ `nemotron-multimodal`                                 |
| `providerRequestMetadata`           | —    | 自由 KV，合入该 slot 每次请求体（per-call metadata 优先）。媒体 wire 路由键也放这里，见下        |

## Slot 解析链

1. **具名命中** — 请求指定 `presetId`（如 `ctx.images.generate({ presetId: "image" })`）时直接按名解析；`default` 自动别名到 llm.toml 里定义的第一个 slot。
2. **Tag-aware fallback** — 具名未命中时，回落到第一个**同 tag** 的 slot（`gateway-slot-resolution.ts`）。**跨 tag fallback 被禁止**：image 请求永远不会静默路由到 text slot。
3. **省略 presetId** — 媒体操作有约定默认名：`generateImage` → `"image"`、`synthesizeSpeech` → `"speech"`、`transcribeAudio` → `"transcription"`，保证进入同 tag fallback 链而不是落到默认 text slot。
4. **Per-runtime 覆盖** — `sessions.runtime_model_overrides`（runtimeId → slot 名）先于 `manifest.model` 与 gateway 默认（`packages/runtime/src/agent-loop/agent-loop-policy.ts`；请求级 `modelOverride` 只对 `outputKind: story` 的 runtime 优先于它）。
5. **Per-request 覆盖** — 前端经 `X-Slot-Config` / `X-Provider-Keys` header 注入的自定义 preset 与 key 覆盖同名配置（`middleware/per-request-llm.ts`）。

模型能力（模态 / 特性 / 上限 / 计价）自动检测优先级：请求级 operational 覆盖 → `llm.toml` 手动字段 → 内置模型资料 → 版本化 LiteLLM 快照 → 协议默认。请求覆盖经 `X-Slot-Config.capabilityOverrides` 下发，只包含 input/output/features/contextWindow/maxOutputTokens；价格覆盖仅供客户端显示，绝不进入服务端信任边界。`self` 部署允许本机用户扩张能力；`demo` / `commercial` 只接受基础能力的非空子集，并对 token 上限取服务端值与请求值的较小者。每次请求只克隆 effective target，不修改全局 registry。服务端 turn 可能同时执行 story / plugin / fast slot，因此共享的 compactor 与 hard-prune budget 取所有已启用 text slot 的最小 `contextWindow` 和最小 `maxOutputTokens`；请求 overlay 再与这个基础预算取较小值，显式 `COVEL_COMPACTOR_CONTEXT_WINDOW` 始终优先覆盖 window。最终 response reserve 会作为 provider 请求的硬输出上限。仓库快照由维护者通过 `pnpm --filter @covel/ai-provider update-model-db` 从固定 commit 生成；设置页的手动刷新会把较新数据写入用户配置目录，并在后续启动时优先于内置快照加载。

## Runtime 覆盖的作用域与 UI

模型配置分两层，值的含义不同：

| 层级         | 映射                    | 持久化位置                                   | 作用域                           |
| ------------ | ----------------------- | -------------------------------------------- | -------------------------------- |
| 模型用途     | `slot → provider/model` | `llm.toml` 基础配置 + 当前设备 Settings 覆盖 | 当前设备上所有使用该 slot 的执行 |
| runtime 覆盖 | `runtimeId → slot`      | `SessionRecord.runtimeModelOverrides`        | 单个会话；快照与 fork 会保留     |

开局准备页从已启用插件发现所有 agent runtime。空选择表示沿用 `PLUGIN.md` 的 `model`；非空选择写入 `runtimeModelOverrides`。同一插件包含多个 runtime 时，key 必须是完整 ID（如 `char-creator/character-tracker`），可以分别绑定。会话开始后，左侧插件列表通过 `PATCH /api/sessions/:id` 更新同一张 map；下一次执行快照该值，正在运行的调用不受中途修改影响。

UI 的“默认用途”展示的是 manifest 声明，“服务商 · 模型”展示的是该 slot 经设备覆盖后的有效目标。二者同时出现是为了区分路由和最终模型，不代表配置不一致。改变某个 slot 的 provider/model 会影响仍指向该 slot 的 runtime；改变 runtime 覆盖只切换 slot，不改 slot 本身。

Function runtime 不读取 `runtimeModelOverrides`。图像、语音等函数插件通常从自己的 `userSettings.modelPresetId` 选择对应 tag 的 provider slot；开局准备页把它显示为独立的“提供方 slot”，并写入 `plugin.<pluginId>.modelPresetId` 设备设置。Agent runtime 的会话覆盖与 function runtime 的 provider slot 不应混用。

## 服务商与模型 ID

设置界面将连接信息和模型 ID 分开保存：一个服务商配置一组 `baseUrl`、协议、API 密钥和价格倍率，并可包含多个模型 ID。用途绑定只引用其中一个模型。请求时前端把该引用编译为兼容服务器的自定义 preset；preset 是内部传输结构，用户无需单独创建。

持久化层只保存 `llm.providers`。旧版 `llm.customPresets` 在启动时执行一次可重试的单向迁移，成功后删除；兼容 facade 和 `X-Slot-Config.customPresets` 均按请求从 providers 投影，不再双写。

首次手动创建服务商与模型时，若 `story` / `plugin` 尚未显式分配，设置页会把这两个用途同时绑定到该模型，保证叙事与插件任务都能立即运行。DeepSeek、OpenAI、Anthropic、DashScope 即使首次配置未填写 `baseUrl`，也会使用框架内置的官方端点与协议；用户填写的地址始终优先。

模型 ID 是不透明字符串，发送请求时不会被裁剪或改写。例如服务商 `openai` 下的 `openai/gpt-5.6-sol` 和 `deepseek/deepseek-v4-flash` 会保持原样。能力查询按以下候选顺序匹配，匹配结果只用于显示能力和价格：

1. 完整 ID；
2. 去掉与当前服务商相同的最外层路由前缀；
3. 最后一个 `/` 后的模型名；
4. 带版本后缀模型的最长已知前缀；
5. 接口协议的保守默认能力。

通过聚合服务商匹配到上游模型资料时，价格标记为“参考价”，实际费用以当前服务商账单为准。每个服务商的价格倍率默认是 `1`，接受 `0.1`、`2.5` 等正小数；调试成本面板按“模型参考价 × 服务商倍率”计算预估结算价。未精确识别的模型不会被猜成支持图片输入；用户可在“用途分配”中手动覆盖能力。

## 思考强度

“生成参数”页面按原始模型 ID 的上游命名空间识别思考档位。例如服务商为 `openai`、模型 ID 为 `deepseek/deepseek-v4-flash` 时仍使用 DeepSeek 的 `关闭 / high / max` 档位。留空表示沿用服务商默认行为，不发送强度覆盖。

统一的 `reasoningEffort` 设置会按接口协议转换：

- OpenAI Chat 和兼容接口：`reasoning_effort`；DeepSeek 同时发送 `thinking.type`，Qwen 使用 `enable_thinking`。
- OpenAI Responses：`reasoning: { effort }`。
- Anthropic Messages：`output_config: { effort }`；DeepSeek 的 Anthropic 兼容接口同时发送 `thinking.type`。

当前识别的主流档位包括 OpenAI 的 `none/minimal/low/medium/high/xhigh`、Anthropic 的 `low/medium/high/xhigh/max`（具体取决于模型）、Gemini 的 `minimal/low/medium/high`、xAI 的 `low/medium/high`、DeepSeek V4 的 `high/max`，以及 Qwen 的关闭/自动模式。界面只列出目标模型已知支持的子集；未识别模型沿用服务商默认行为。

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
- 插件在 `entry` 模块里用 `covel.registerWires({ image?, speech?, transcription? })` 注册自定义 wire（frontmatter 的 `wires` 字段仍被接受但已弃用）—— 见 [plugin-authoring-advanced.md § 注册自定义 wire](../guide/plugin-authoring-advanced.md#注册自定义-wireentry-里的-covelregisterwires)；wire 与 MediaStore 的关系见 [media-store.md](./media-store.md#media-wire-registries-image--speech--transcription)。

## API Key 流转

Key 永远不进 `llm.toml`：dev 放 `.env.llm`，桌面端放 `~/.covel/keys.env`（mode 600），纯 web 放 localStorage（`covel:keys`）。每次 AI 请求经 `X-Provider-Keys` header（base64 JSON `{provider: key}`）到达服务端，按目标 slot 的 `provider` 名分发绑定 —— wire 拿到的 `config.apiKey` 已是该 slot provider 的 key，客户端 key 覆盖 env key。
