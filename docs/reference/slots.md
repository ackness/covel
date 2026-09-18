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

模型能力（模态 / 特性 / 上限 / 计价）自动检测优先级：请求级 operational 覆盖 → `llm.toml` 手动字段 → 内置模型资料 → 版本化 LiteLLM 快照 → 协议默认。请求覆盖经 `X-Slot-Config.capabilityOverrides` 下发，只包含 input/output/features/contextWindow/maxOutputTokens；价格覆盖仅供客户端显示，绝不进入服务端信任边界。`self` 部署允许本机用户扩张能力；`demo` / `commercial` 只接受基础能力的非空子集，并对 token 上限取服务端值与请求值的较小者。每次请求只克隆 effective target，不修改全局 registry。每次 agent 调用在 `PreLLMCall` 之后通过 `LLMAdapter.resolveBudget(slot)` 读取实际用途的 `contextWindow`、`maxOutputTokens` 和用户请求的 `requestedMaxOutputTokens`，再预留输出并裁剪输入；上下文组装和 `PostContextAssembly` 不再提前按其他模型的窗口裁剪历史。story / plugin 各自使用实际目标的窗口，compactor 使用 `fast` 的当前配置；请求覆盖与 `llm.toml` 热更新都通过同一 adapter 解析。`createTurnContextBudget` 仅提供未知模型的 32,768 窗口回退值；显式 `COVEL_COMPACTOR_CONTEXT_WINDOW` 通过 `BudgetOptions.contextWindowLimit` 保留为部署上限，不能扩大模型自身能力。

输出额度由共享的 `resolveLlmTokenLimits` 计算：默认 16,384，按模型输出能力收窄；小上下文的自动默认值最多使用窗口的一半，为输入保留空间。用户显式额度可高于或低于默认值，并在校验前读取；有效输出不能占满上下文，最终输入与输出无法同时容纳时明确失败。gateway 对每次实际目标（包括备用模型）重新限制输出额度，agent 与函数插件的 text / object / stream 调用均沿用这条路径；Anthropic 未知输出能力也默认 16k，不再回退 1024 或把资料库最大能力当默认请求量。HTTP 429 限流允许切换已配置的备用模型，其他 4xx 保留原失败路径；流式内容一旦输出，仍禁止切换，避免混入两个模型的结果。

仓库快照由维护者通过 `pnpm --filter @covel/ai-provider update-model-db` 从固定 commit 生成；设置页的手动刷新会把较新数据写入用户配置目录，并在后续启动时优先于内置快照加载。

调用后的工具完成契约、输出校验和工具循环耗尽等失败也保留最后一次响应的服务商和模型。该身份由 `onTargetAttempt` 跟随实际请求更新，包含备用模型；普通执行和暂停后的恢复执行共用失败身份处理，不能用初始用途绑定冒充最终响应模型。

## Runtime 覆盖的作用域与 UI

模型配置分两层，值的含义不同：

| 层级         | 映射                    | 持久化位置                                   | 作用域                           |
| ------------ | ----------------------- | -------------------------------------------- | -------------------------------- |
| 模型用途     | `slot → provider/model` | `llm.toml` 基础配置 + 当前设备 Settings 覆盖 | 当前设备上所有使用该 slot 的执行 |
| runtime 覆盖 | `runtimeId → slot`      | `SessionRecord.runtimeModelOverrides`        | 单个会话；快照与 fork 会保留     |

开局准备页从已启用插件发现所有 agent runtime。空选择表示沿用 `PLUGIN.md` 的 `model`；非空选择写入 `runtimeModelOverrides`。同一插件包含多个 runtime 时，key 必须是完整 ID（如 `char-creator/character-tracker`），可以分别绑定。会话开始后，左侧插件列表通过 `PATCH /api/sessions/:id` 更新同一张 map；下一次执行快照该值，正在运行的调用不受中途修改影响。

UI 的“默认用途”展示的是 manifest 声明，“服务商 · 模型”展示的是该 slot 经设备覆盖后的有效目标。二者同时出现是为了区分路由和最终模型，不代表配置不一致。改变某个 slot 的 provider/model 会影响仍指向该 slot 的 runtime；改变 runtime 覆盖只切换 slot，不改 slot 本身。

Function runtime 不读取 `runtimeModelOverrides`。图像、语音等函数插件通常从自己的 `userSettings.modelPresetId` 选择对应 tag 的 provider slot；开局准备页把它显示为独立的“提供方 slot”，并写入 `plugin.<pluginId>.modelPresetId` 设备设置。Agent runtime 的会话覆盖与 function runtime 的 provider slot 不应混用。

连接测试通过与回合执行相同的请求头校验、用途绑定、参数覆盖和能力限制；用途测试保留 slot 名，不能先替换成 preset ID 后丢失该用途的配置。`GET /api/presets` 与 `GET /api/llm-config` 返回模型能力和白名单中的 `parameterOverrides` 默认值，设置页据此显示 TOML 默认值及恢复默认后的预算，不返回任意 provider metadata。新旧 token 设置入口共用覆盖数据与 `resolveLlmTokenLimits`；页面同时显示有效输出预算和剩余输入预算，并提示上下文与输出冲突。未知模型的协议默认值只声明模态和特性，不推测具体模型的 token 上限。

后台记忆更新使用触发它的请求 adapter，切换模型或调整输出参数后重试同样生效。请求包装器共享记忆管理器及按 session 串行的 pending 队列：`MemoryUpdater.updateAfterTurn(params, llmOverride?)` 捕获本次 adapter，`awaitPending(sessionId)` 仍等待同一队列。恢复暂停任务时重新使用当前请求的上下文预算。调用前预算超限、provider 初始化失败和上游请求失败均在错误详情保留实际 provider/model；无效输出参数归为不可重试的配置错误。

记忆提取是框架服务。用途分配始终列出 `memory`，即使服务端未定义该 slot：浏览器显式绑定优先；未绑定时服务端依次选择 `memory`、`plugin`、`story`、首个 text slot。每次任务读取最新基础配置，支持热重载；排队任务保留各自请求的 adapter 和 slot。纯 UI、无 model/stage 的自动声明不会在会话插件列表显示无效的 runtime 模型选择器。

记忆请求每次调用的整体超时为 120 秒（包含该调用内部的传输重试），默认关闭额外思考以降低事实提取耗时；用户显式配置的思考参数仍优先。memory 库保留有限瞬态重试，gateway 返回的不可重试错误（包括整体超时）不会重试。`{}` 表示合法的无变化；非法 JSON、非对象或没有有效记忆块的非空结果均记录失败。结果以 `memory.updated` 写入该回合 trace，并在 `memory-panel` capability 的宿主下持久化 `_memory/update` 状态。已结束的 provider / 解析失败会清除该任务的待恢复记录，下一轮不会立即重复同一失败请求；进程中断或持久化失败的任务仍保留恢复能力。失败不回滚已提交剧情；下一次有叙事输出的成功回合会提取新剧情，成功后清除失败提示。

## 服务商与模型 ID

设置界面将连接信息和模型 ID 分开保存：一个服务商配置一组 `baseUrl`、协议、API 密钥和价格倍率，并可包含多个模型 ID。用途绑定只引用其中一个模型。请求时前端把该引用编译为兼容服务器的自定义 preset；preset 是内部传输结构，用户无需单独创建。

持久化层只保存 `llm.providers`，其中每个模型条目可携带 `reasoningEffort` 默认值。添加服务商、批量添加模型和编辑现有模型时均可逐模型设置；导入/导出保留该字段。旧版 `llm.customPresets` 在启动时执行一次可重试的单向迁移，成功后删除；兼容 facade 和 `X-Slot-Config.customPresets` 均按请求从 providers 投影，不再双写。模型默认值参与请求 overlay 的完整身份，避免同一模型引用在不同请求中使用不同设置时串用配置。

模型条目的 `ref` 是配置身份，`modelId` 只是发送给服务商的原始 API 模型 ID。同一连接允许保存多个相同 `modelId` 的配置，分别设置名称和思考档位，例如“快速工具 / 关闭思考”和“详细叙事 / 开启思考”。添加时仅复用模型 ID、名称和思考设置均相同的条目；复制配置生成独立 `ref`，编辑名称或思考设置不改变引用。导入按 `ref` 去重，不按 API 模型 ID 合并。

服务商与模型页面支持复制配置、编辑名称、自动保存思考设置；用途分配、插件绑定和会话摘要显示配置名及思考设置。主叙事、代理插件、函数插件和记忆任务通过同一请求配置链路继承所选模型默认值，无需逐用途重复设置。显式用途覆盖仍优先于模型默认。存储中的 `automatic` 为兼容旧版而保留；目前该档位用于 Qwen，界面显示“开启思考”，发送 `enable_thinking: true`，并非按任务自动选择开关。

首次手动创建服务商与模型时，若 `story` / `plugin` 尚未显式分配，设置页会把这两个用途同时绑定到该模型，保证叙事与插件任务都能立即运行。DeepSeek、OpenAI、Anthropic、DashScope 即使首次配置未填写 `baseUrl`，也会使用框架内置的官方端点与协议；用户填写的地址始终优先。

模型 ID 是不透明字符串，发送请求时不会被裁剪或改写。例如服务商 `openai` 下的 `openai/gpt-5.6-sol` 和 `deepseek/deepseek-v4-flash` 会保持原样。能力查询按以下候选顺序匹配，匹配结果只用于显示能力和价格：

1. 完整 ID；
2. 去掉与当前服务商相同的最外层路由前缀；
3. 最后一个 `/` 后的模型名；
4. 带版本后缀模型的最长已知前缀；
5. 接口协议的保守默认能力。

通过聚合服务商匹配到上游模型资料时，价格标记为“参考价”，实际费用以当前服务商账单为准。每个服务商的价格倍率默认是 `1`，接受 `0.1`、`2.5` 等正小数；调试成本面板按“模型参考价 × 服务商倍率”计算预估结算价。未精确识别的模型不会被猜成支持图片输入；用户可在“用途分配”中手动覆盖能力。

## 思考强度

“生成参数”页面按原始模型 ID 的上游命名空间识别思考档位。例如服务商为 `openai`、模型 ID 为 `deepseek/deepseek-v4-flash` 时仍使用 DeepSeek 的 `关闭 / high / max` 档位。选项由模型能力决定，不把各厂商的强度假定为等价。

用户设置的生效顺序为：用途显式覆盖 → 模型 / TOML 默认 → 任务默认 → 服务商默认。用途留空表示继承；模型留空表示按任务决定。显式 `provider-default` 表示让服务商决定，清除继承的思考请求字段并跳过任务默认，不能把它当成未配置。记忆提取的任务默认仍为关闭思考，用户在用途或模型上设置的档位优先。界面分别显示继承值和显式覆盖，不把服务商文档中的默认档位冒充本次任务的实际参数。

`REASONING_EFFORT_VALUES` 与 `ReasoningEffort` 由 `@covel/shared` 定义，前端持久化、请求入口校验和 provider adapter 共用。模型参数只通过白名单字段传输；不会把任意导入 JSON 合并进服务商请求。现有 `disabled` / `automatic` 等值保持兼容，老配置不需要迁移。

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

## Provider 流式响应

三个文本协议共用的 SSE 解析器支持 LF、CRLF、CR 换行（包括跨网络分片的 CRLF）、`data:` 后可选的空格和同一事件内多个 `data` 行；多行内容以换行连接后解析 JSON。事件必须以空行结束，流结束时丢弃未完成事件。收到 `[DONE]` 或调用方提前结束消费时，解析器取消剩余响应体并释放 reader，避免后台连接继续占用资源。格式规则见 [WHATWG SSE 规范](https://html.spec.whatwg.org/multipage/server-sent-events.html#event-stream-interpretation)。

## API Key 流转

Key 永远不进 `llm.toml`：dev 放 `.env.llm`，桌面端放 `~/.covel/keys.env`（mode 600），纯 web 放 localStorage（`covel:keys`）。每次 AI 请求经 `X-Provider-Keys` header（base64 JSON `{provider: key}`）到达服务端，按目标 slot 的 `provider` 名分发绑定 —— wire 拿到的 `config.apiKey` 已是该 slot provider 的 key，客户端 key 覆盖 env key。

## HTTP retry cleanup

Provider and plugin HTTP helpers cancel rejected response bodies before retrying instead of buffering the entire error stream. Redirect responses are also cancelled when rejected. `Retry-After` waits remain abortable; long finite delays are split into timer-safe intervals, and non-finite delays fail explicitly instead of overflowing into immediate retries.

## 失败后的模型与参数调整

错误详情保留失败请求实际使用的 `provider` 和 `model`，包含备用模型最终失败的情况；后续修改配置不会改变已记录的失败目标。可在失败任务上打开“更换模型 / 调整参数”，进入模型用途选择服务商和模型，并展开“生成参数”调整上下文窗口、模型最大输出能力、单次输出、温度、采样和思考强度；能力字段也可以通过原“编辑能力”入口覆盖，包括仅在前端配置的模型用途。两处复用同一个 token 编辑组件，并沿用 `llm.capabilityOverrides` / `llm.paramOverrides`，无需迁移旧设置。资料库输出上限仅供参考，不阻止输入符合设置范围的手动参数。

关闭设置后点击“重试此任务”，请求重新读取当前模型和参数；已提交的剧情和其他成功任务仍保留。最大输出限制与输入上下文窗口是两个独立的设置，调低输出不会删除会话历史。
