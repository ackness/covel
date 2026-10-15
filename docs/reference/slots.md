# 模型用途（Slot）配置

Covel 把模型调用分成几类工作，例如写故事正文、插件更新状态、压缩历史。每一类叫一个“模型用途”，代码和配置文件里叫 slot。你给每个用途指定一个服务商和一个模型，游戏运行时就按用途找到要调用的模型。

这一页是用途的完整参考：`llm.toml` 怎么写、有哪些内置服务商、一次调用怎样选出模型、失败时怎样重试和回退。

- 只想在设置界面里连上模型开始玩，看[连接模型](../start/models.md)就够了，不需要读这一页。
- 想手写 `llm.toml`，读前三节。
- 开发插件或框架，按需查后面的小节。

## 一个用途长什么样

`llm.toml` 里每个 `[covel.<名字>]` 小节定义一个用途：

```toml
[covel.story]
provider = "deepseek"
model    = "deepseek-flash"

[covel.utility]
provider = "dashscope"
model    = "qwen3.8-flash"
fallback = "story"
```

这段配置的意思是：

- 写故事正文（`story`）用 DeepSeek 的 `deepseek-flash`。
- 辅助任务（`utility`）用阿里云百炼的 `qwen3.8-flash`，调用失败时改用 `story` 的模型。
- 文件里的第一个用途是默认用途。

常见的文本用途名有 `story`（故事正文）、`plugin`（插件任务）、`utility`（辅助任务）、`fast`（压缩历史）、`memory`（提取记忆）。图片、语音、向量和评估各有自己的用途，例如 `image`、`embed-default`、`evaluation`。名字可以自己起，插件按名字或能力标签找到它。完整的示例见仓库根目录的 [`llm.toml.example`](../../llm.toml.example)。

**文件放在哪里**

| 运行方式       | 读取的文件                                        |
| -------------- | ------------------------------------------------- |
| 设置了环境变量 | `COVEL_LLM_TOML` 指向的文件，优先于下面两项       |
| 从源码运行     | 仓库根目录的 `llm.toml`；没有时才读用户目录的配置 |
| 桌面版         | `~/.covel/llm.toml`，在设置里重新加载后不用重启   |

**密钥不写在这个文件里。** 密钥放在 `.env.llm`（源码运行）或 `~/.covel/keys.env`（桌面版），变量名是 `{PROVIDER}_API_KEY`，例如 `DEEPSEEK_API_KEY`。细节见 [API Key 流转](#api-key-流转)。

**没有 `llm.toml` 时**，服务器使用一个内置的 `story` 用途：

- 默认是 DeepSeek 的 `deepseek-v4-flash`。
- 设置了 `DEFAULT_BASE_URL` 时，改用这个兼容 OpenAI 的地址。服务商名为 `default`，密钥读 `DEFAULT_API_KEY`，模型读 `DEFAULT_MODEL`（没设置时仍是 `deepseek-v4-flash`）。

没有 DeepSeek 密钥的环境（例如云端测试）设置这三个变量，就能换成任意一家服务商，不必写 `llm.toml`。

> [!NOTE]
> 评估模型是另一类模型：它不写文字，只回答选择题、打分和是非题。配置里写 `output = ["evaluation"]`、`tag = "evaluation"`，调用时用 `gateway.evaluate()`。TypeSafe、OpenRouter、Vercel 和 OpenAI 的评估模型各用自己的接口，见[模型评估](./evaluation.md)。

## Slot 字段（`[covel.<slot>]`）

Schema：`packages/ai-provider/src/config/llm-schema.ts`。

<!-- prettier-ignore -->
| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `provider` | ✅ | 服务商标识，对应 `.env.llm` / `keys.env` 里的 `{PROVIDER}_API_KEY`。同一个 `provider` 的用途共用一个密钥 |
| `model` | ✅ | 模型 ID，原样发给服务商，带 `/` 的 ID 也不改动 |
| `baseUrl` | — | API 地址。[内置服务商](#内置服务商与协议)可以不写，其他服务商必填。远端地址必须是 https；本机地址只在 `self` 部署下允许，可以用 http |
| `protocol` | — | 接口协议，取值见[内置服务商与协议](#内置服务商与协议)。不写时用内置服务商自己的协议，其他服务商用 `openai-chat-v1` |
| `tag` | — | 能力标签：`text` / `image` / `embedding` / `speech` / `transcription` / `music` / `evaluation`。不写时从 `output` 推断（`audio` 推断为 `speech`，音乐用途必须明确写 `music`） |
| `fallback` | — | 调用失败时改用的用途名。目标用途必须是同一种能力，并且已经配置好密钥；回退关系不能成环 |
| `input` / `output` | — | 模型接受和产出的内容类型，不写时自动识别（见[模型能力从哪里来](#模型能力从哪里来)）。`output` 可以是 `text` / `image` / `audio` / `video` / `embedding` / `evaluation` |
| `features` | — | 模型特性（`function_calling`、`reasoning`、`vision`…） |
| `contextWindow` / `maxOutputTokens` | — | 覆盖上下文窗口和最大输出的 token 数 |
| `pricing` | — | 计价信息，只用于 `/debug` 的成本面板 |
| `reasoningEffort` | — | 思考档位（例如 `disabled` 关闭思考）。它是这个模型的默认值，发送时换成各家接口自己的字段，见[思考强度](#思考强度) |
| `embeddingFormat` | — | 向量用途的请求格式：`openai`（默认）或 `nemotron-multimodal` |
| `providerRequestMetadata` | — | 随生成请求发出的自由键值，单次调用给的值优先；评估请求不使用。选择图片、语音协议的键也放这里，见下文“媒体 wire 路由键”一节 |
| `providerOptions` | — | 按服务商或协议分组的原生参数，只用于文本、对象和流式调用，见[供应商参数](#供应商参数) |

`baseUrl` 等值可以引用环境变量，例如 `baseUrl = "${MY_API_BASE}"`。配置读不进来时，错误只写出行号、列号和出错的键，不会写出环境变量的值。旧字段 `reasoning_effort` 和 `thinking` 不再接受，写了会在加载时报错，改用 `reasoningEffort` 或 `providerOptions`。

## 内置服务商与协议

服务商和协议是两件事：

- **协议**是请求和回答的格式。
- **服务商**是使用某种协议的一个接口地址。

| 协议 ID                   | 设置页名称           | 产出 |
| ------------------------- | -------------------- | ---- |
| `openai-chat-v1`          | OpenAI Chat          | 文本 |
| `openai-responses-v1`     | OpenAI Responses     | 文本 |
| `anthropic-messages-v1`   | Anthropic Messages   | 文本 |
| `google-generative-ai-v1` | Google Gemini        | 文本 |
| `typesafe-systemone-v1`   | TypeSafe System One  | 评估 |
| `openrouter-decisions-v1` | OpenRouter Decisions | 评估 |
| `vercel-evaluation-v4`    | Vercel AI Gateway    | 评估 |
| `openai-decisions-v1`     | OpenAI Decisions     | 评估 |

内置服务商自带官方地址和默认协议。`llm.toml` 里只写 `provider` 和 `model` 就行，设置页里可以直接从列表选：

<!-- prettier-ignore -->
| `provider` | 名称 | 端点 | 协议 |
| --- | --- | --- | --- |
| `openai` | OpenAI | `https://api.openai.com/v1` | `openai-chat-v1` |
| `anthropic` | Anthropic | `https://api.anthropic.com` | `anthropic-messages-v1` |
| `google` | Google Gemini | `https://generativelanguage.googleapis.com/v1beta` | `google-generative-ai-v1` |
| `deepseek` | DeepSeek | `https://api.deepseek.com` | `openai-chat-v1` |
| `dashscope` | Alibaba DashScope (Qwen) | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `openai-chat-v1` |
| `xai` | xAI | `https://api.x.ai/v1` | `openai-chat-v1` |
| `mistral` | Mistral AI | `https://api.mistral.ai/v1` | `openai-chat-v1` |
| `groq` | Groq | `https://api.groq.com/openai/v1` | `openai-chat-v1` |
| `together` | Together AI | `https://api.together.xyz/v1` | `openai-chat-v1` |
| `fireworks` | Fireworks AI | `https://api.fireworks.ai/inference/v1` | `openai-chat-v1` |
| `moonshot` | Moonshot AI (Kimi) | `https://api.moonshot.cn/v1` | `openai-chat-v1` |
| `zhipu` | Zhipu AI (GLM) | `https://open.bigmodel.cn/api/paas/v4` | `openai-chat-v1` |
| `siliconflow` | SiliconFlow | `https://api.siliconflow.cn/v1` | `openai-chat-v1` |
| `volcengine` | Volcengine Ark (Doubao) | `https://ark.cn-beijing.volces.com/api/v3` | `openai-chat-v1` |
| `openrouter` | OpenRouter | `https://openrouter.ai/api/v1` | `openai-chat-v1` |
| `vercel` | Vercel AI Gateway | `https://ai-gateway.vercel.sh/v1` | `openai-chat-v1` |
| `typesafe` | TypeSafe | `https://api.typesafe.ai/v1` | `typesafe-systemone-v1` |
| `ollama` | Ollama（本机） | `http://localhost:11434/v1` | `openai-chat-v1` |
| `lmstudio` | LM Studio（本机） | `http://localhost:1234/v1` | `openai-chat-v1` |
| `llamacpp` | llama.cpp server（本机） | `http://localhost:8080/v1` | `openai-chat-v1` |
| `vllm` | vLLM（本机） | `http://localhost:8000/v1` | `openai-chat-v1` |
| `litellm` | LiteLLM Proxy（本机） | `http://localhost:4000/v1` | `openai-chat-v1` |

```toml
[covel.story]
provider = "zhipu"
model    = "glm-5"
```

不在表里的服务商照常填写 `baseUrl`。它只要兼容 OpenAI Chat，`protocol` 也可以不写。

**本机服务。** 标“本机”的条目，指运行 Covel 服务端的那台机器上的服务，端口是各自的默认值。

- 用了别的端口，或者一个端口上同时提供多种协议的本机网关，按自定义服务商添加：地址填 `http://127.0.0.1:<端口>/v1`，协议选它那一路用的协议。需要几种协议，就添加几个服务商。
- 本机地址（`localhost`、`127.0.0.1`、`::1`）上的模型不需要 API Key。没有密钥也算已就绪，可以开始游戏、运行后台任务和做连接测试。服务自己要求密钥时照常填写。

**读取模型列表。** 添加服务商或模型时，“从服务读取模型列表”向该服务请求它提供的模型 ID（`POST /api/ai/models`）。勾选即加入，可以按名称筛选；手动输入的 ID 保留。

| 协议                    | 读取的路径                            |
| ----------------------- | ------------------------------------- |
| OpenAI Chat / Responses | `/models`                             |
| Anthropic               | `/v1/models`                          |
| Gemini                  | `/models`，并去掉 ID 前面的 `models/` |
| 评估协议                | 没有列表                              |

服务端环境里的 `{PROVIDER}_API_KEY` 只会发往上表官方地址的同源地址，见[安全边界](../internals/security.md)。

### 新增服务商或协议

- **新增一个使用现有协议的服务商**：在 `packages/shared/src/utils/provider-defaults.ts` 的 `BUILTIN_PROVIDER_CONNECTIONS` 加一条（名称、端点、协议）。设置页列表、`llm.toml` 的缺省值和密钥的可信来源都从这张表读取。
- **新增一种协议**：
  1. 在 `packages/shared/src/provider-protocols.ts` 的 `PROVIDER_PROTOCOL_DESCRIPTORS` 加一条描述（ID、名称、产出文本还是评估）。
  2. 在 `packages/ai-provider/src/protocol-registry.ts` 的 `BUILTIN_PROTOCOLS` 加一条 `ProtocolDefinition`。

  配置校验、请求头校验、设置页下拉和类型都从描述表派生。漏写定义时 `tsc` 报错。

- 一条 `ProtocolDefinition` 写明这个协议的全部差异：
  - 适配器（`createAdapter`）
  - 缓存策略
  - 默认能力
  - `reasoningEffort` 档位到请求字段的转换（`reasoningFields`）
  - 它接受的 `providerOptions` 字段（`providerOptionFields`）
  - 它支持的可选生成参数（`parameters`）
  - 图像和语音是否必须明确指定 wire（`mediaWire`）

  网关和注册表只查这张表，不比较协议 ID。

- 请求追踪只记录白名单里的请求体字段（`packages/ai-provider/src/adapters/http/request-observation.ts` 的 `MODEL_FIELDS`）。新协议如果使用新的顶层字段名，要在那里加上，否则 trace 里看不到。
- 插件 SDK 不能依赖 `@covel/shared`，自己保留一份内置协议 ID 类型（`PluginProviderProtocol`）。两份不一致时 `packages/shared/src/provider-protocols.ts` 编译失败。
- **由插件提供一种协议**：不改框架。插件用 `covel.registerWires({ text: [...] })` 注册，模型的 `protocol` 写 `<pluginId>/<wireId>`。只有启用了该插件的会话能选用它，否则以配置错误失败。没有会话的请求（如连接测试）可以用内置插件的协议，`self` 部署下也可以用社区插件的。见 [plugin-extensions.md § 文本协议 wire](./plugin-extensions.md#文本协议-wire)。

## API Key 流转

密钥永远不写进 `llm.toml`：

| 运行方式 | 密钥保存的位置                      |
| -------- | ----------------------------------- |
| 源码开发 | `.env.llm`                          |
| 桌面版   | `~/.covel/keys.env`（文件权限 600） |
| 纯网页   | 浏览器 localStorage（`covel:keys`） |

每次 AI 请求把密钥放在 `X-Provider-Keys` 请求头里（base64 编码的 JSON `{provider: key}`）发给服务端。服务端按目标用途的 `provider` 名取出对应的密钥，所以 wire 拿到的 `config.apiKey` 已经是该用途服务商的密钥。客户端给的密钥优先于服务端环境变量里的密钥。

服务端环境密钥和程序里注册的默认凭据都绑定可信来源：

- 请求把地址改到另一个来源（origin）时，默认的 `apiKey` 和请求头被移除，也不注入环境密钥。调用方在这次请求里明确提供的密钥仍然可以用于该地址。
- 只改同一来源下的路径时，默认凭据保留。
- 解析请求不会修改已注册的配置。

## 配置分层与前端对应

先分清两个词：

- **模型能力**是模型能做什么，例如 `evaluation`（评估）。
- **用途名**是你起的名字，例如 `intent`、`risk-check`、`npc-choice`。

多个用途可以选同一个评估模型。`evaluation` 这个名字只是 `gateway.evaluate()` 没指定用途时用的约定名。服务商名、模型 ID 和用途名都不决定协议。

配置分四层，每一层在设置界面里有对应的位置：

| 层次           | 前端位置                   | 持久化与生效范围                                                              |
| -------------- | -------------------------- | ----------------------------------------------------------------------------- |
| 连接与模型     | 服务商与模型               | TOML 提供基础模型；`llm.providers` 保存本地连接及模型，模型可以覆盖连接的协议 |
| 用途与模型绑定 | 用途分配                   | `[covel.<name>]` 定义基础用途；`llm.slotConfig` 里的本地选择优先              |
| 用途参数与能力 | 生成参数、编辑能力         | `llm.paramOverrides` / `llm.capabilityOverrides` 随请求覆盖                   |
| 任务选择用途   | 世界准备页、会话的插件列表 | `runtimeModelOverrides` 只保存“任务 → 用途”的对应关系                         |

设置保存在哪里：

- 桌面版保存在 `settings.json`，网页版保存在当前浏览器。它们不回写 TOML。
- 重新加载 TOML 会保留本地绑定和参数。重置用途绑定后，恢复成文件里的模型。
- 参数和能力各有自己的重置入口。

服务商页面的规则：

- 模型按连接 ID 归组，同组共用 API Key 和价格倍率。
- TOML 里的模型保留各自文件里的地址和协议。本地添加的模型使用本地连接的地址，以及模型自己的协议覆盖。修改本地连接不会改动同组的 TOML 模型。
- 模型行和用途卡片显示生效的地址、协议和配置来源。

用途选择器的规则：

- 选择器按用途需要的产出类型过滤模型。同一个 OpenRouter / Vercel 连接里的聊天模型和评估模型不会混选。
- 已保存但无效的绑定显示错误，并从会话可用的用途里排除，不会悄悄改绑到别的模型。
- 服务端也校验明确的绑定。内置文本用途不能绑定评估模型。
- 自定义用途的能力从 TOML 的 `tag` 或所选模型的产出推导，不要求使用固定名称。

生成参数页按模型的实际能力显示参数。评估等不产出文本的模型不显示温度、输出 token 和思考参数，但仍然可以重置以前保存的参数覆盖。

### 实际选择优先级

一次调用用哪个用途，按下面的顺序决定：

1. 运行时的明确选择，包括会话的 `runtimeModelOverrides`。它决定用哪个用途或预设。
2. 没有明确选择时，runtime 自己写的用途名（`agent.model` / `function.model`）。没写时，当前请求绑定了 `default` 就用它，否则用系统的默认用途。
3. 这个用途先按当前请求里的 UI 用途绑定解析，没有绑定时按系统 `llm.toml` 的定义，以及可用文本用途的回退。

补充规则：

- 插件只说明想用哪个用途，不能自己指定服务商、模型、地址或协议。用哪个模型、请求发到哪里，由玩家（或运营者）的模型设置决定，所以玩家的密钥只会发到这些设置里的地址。插件目录里的 `llm.toml` 不会被读取，`pnpm validate:plugin` 遇到它会给出提醒。
- `fast`、`memory` 等文本用途没有定义时，回退到现有用途。这个用途同样读取当前请求的 UI 绑定、参数和能力。
- 准备页的任务对应关系必须先保存成功，并同步到服务端的临时镜像，之后才发布可运行的会话。保存失败时保留选择并回滚启动，不会用默认值继续启动。

价格覆盖和服务商倍率只用于调试时估算成本，不随模型请求发送，也不改变服务商实际收的钱。手动价格只在 trace 里的实际 provider/model 能唯一对应当前配置时才应用；对应不上时沿用资料库的估算。

### 备用策略归属用途

`fallback` 属于 TOML 里的用途，不属于模型。

- 你在界面里给 `utility` 换了模型后，原来的 `utility -> story` 备用关系仍然有效，`story` 也使用本次请求选的模型。
- 不会借用“新选的模型所属的其他用途”的备用关系。
- 重复的目标只算一次。备用链的防循环检查保持有效。
- `allowFallback: false` 时只调用主目标。

这条规则适用于原本就支持备用链的调用：文本、结构化输出、流式输出和评估。图片、语音和向量调用没有因此增加重试。

## Slot 解析链

一次调用按下面的步骤找到模型：

1. **请求绑定**。`X-Slot-Config.slotBindings` 优先。它区分本地的 `modelRef` 和服务端的 `presetId`；本地模型必须在这次请求里声明。密钥通过 `X-Provider-Keys` 提供，不写进插件或世界包。
2. **按名字命中**。按预设 ID 或用途名解析。所有显式目标都要支持本次调用的能力，包括语音、转写和音乐。不匹配时返回 `CONFIG_ERROR`，不调用服务商。图片调用要求名字完全一致，并且目标能产出图片。名字拼错、没有配置或者选到文本模型，都返回 `CONFIG_ERROR`，不调用服务商。
3. **没给名字**。`generateImage` 和 `resolveSlot({ fallbackTag: "image" })` 都使用 `image`。不会自动挑别的图像用途，也不会使用默认的文本模型。语音和转写使用各自的默认名 `speech` / `transcription`，并保留原有的同标签解析。
4. **同标签回退（图片除外）**。文本等调用按名字没找到时，可以回落到 `tag` 相同的用途。不会跨标签回退。
5. **任务选择用途**。Agent 的 `runtimeModelOverrides` 优先于 `manifest.model`。function 的图片任务由插件的 `modelPresetId` 设置选择用途。两者最后使用同一份请求级的模型绑定。

场景补图、社区插画插件、世界素材与协议的关系见[图像生成](./image-generation.md)。

### 模型能力从哪里来

模型能力指模型接受和产出的内容类型、特性、token 上限和计价。按下面的顺序取第一个有值的来源：

1. 请求级的覆盖（`X-Slot-Config.capabilityOverrides`）
2. `llm.toml` 里手写的字段
3. 内置模型资料
4. 带版本的 LiteLLM 快照
5. 协议的默认值

请求级覆盖的规则：

- 只包含 `input` / `output` / `features` / `contextWindow` / `maxOutputTokens`。价格覆盖只给客户端显示，不进入服务端的信任边界。
- `self` 部署允许本机用户扩大能力。`demo` / `commercial` 只接受基础能力的非空子集，token 上限取服务端值和请求值里较小的一个。
- 每次请求只复制生效的目标，不修改全局注册表。

仓库里的快照由维护者运行 `pnpm --filter @covel/ai-provider update-model-db`，从固定的提交生成。设置页的手动刷新会把更新的数据写到用户配置目录，以后启动时优先于内置快照加载。

**资料写着支持，不等于适配器能做。** 内置的 Chat、Responses、Anthropic 和 Gemini 原生文本适配器，输入只支持 text / image，输出只支持 text，不提供 `web_search` 或 `computer_use`。合并能力覆盖之后仍然受这层限制，手动勾选不能启用还没实现的协议功能。

- `GET /api/model-db/lookup` 保留原始的 `capability`。传入 `role` 和 `protocol` 后另外返回 `effectiveCapability`；能解析出连接时还返回 `usesBuiltinAdapter`。
- 设置页、`resolveSlot` 和实际的文本调用使用同一套计算。
- 程序注册的自定义 adapter，以及独立的图片、语音、转写、向量 wire，保留各自的能力。
- 未知模型仍然标注“由协议推断”，不把协议默认值当成核实过的模型事实。

### 上下文和输出额度

每次 agent 调用在 `PreLLMCall` 之后通过 `LLMAdapter.resolveBudget(slot)` 读取实际用途的 `contextWindow`、`maxOutputTokens` 和用户请求的 `requestedMaxOutputTokens`，先留出输出的空间，再裁剪输入。

- 上下文组装和 `PostContextAssembly` 不会提前按别的模型的窗口裁剪历史。
- `story` / `plugin` 各自使用实际目标的窗口；压缩历史使用 `fast` 的当前配置。
- 请求覆盖和 `llm.toml` 的热更新都通过同一个 adapter 解析。
- `createTurnContextBudget` 只给未知模型提供 262,144（256K）的窗口回退值。
- 明确设置的 `COVEL_COMPACTOR_CONTEXT_WINDOW` 通过 `BudgetOptions.contextWindowLimit` 保留为部署上限，不能扩大模型自身的能力。

输出额度由共用的 `resolveLlmTokenLimits` 计算：

- 默认 16,384，再按模型的输出能力收窄。
- 上下文窗口很小时，自动默认值最多用窗口的一半，给输入留出空间。
- 用户明确设置的额度可以高于或低于默认值，并且在校验之前读取。
- 有效输出不能占满上下文。输入和输出装不下时明确失败。
- gateway 对每个实际目标（包括备用模型）重新限制输出额度。agent 和 function 插件的 text / object / stream 调用都走这条路径。
- Anthropic 模型的输出能力未知时也默认 16k。

备用模型的切换：

- HTTP 429 限流允许切换到已配置的备用模型。
- 账户的失败（余额用完、密钥无效或无权使用这个模型，见下面的 `quota` / `auth`）也允许切换：它只属于这一家的账户，备用的目标可能还能用。没配备用模型，就直接失败，把原因告诉玩家。
- 账户失败后，同一次调用会跳过服务商、实际基础 URL 和密钥都相同的备用目标（即使模型不同）。其他服务商、端点或密钥的已配置备用仍会尝试。全部跳过时保留最后一次实际尝试的失败，跳过不消耗请求次数。
- 其他 4xx 保留原来的失败路径。
- 流式内容一旦已经输出，就禁止切换，避免把两个模型的结果混在一起。

### 失败时记录的是哪个模型

工具完成契约、输出校验、工具循环耗尽这类调用之后的失败，也保留最后一次回答的服务商和模型。这个身份由 `onTargetAttempt` 跟随实际请求更新，包括备用模型。普通执行和暂停后的恢复执行共用这套处理，不会用最初的用途绑定冒充最终回答的模型。

## Runtime 覆盖的作用域与 UI

模型配置分两层，值的含义不同：

| 层级         | 映射                    | 持久化位置                                   | 作用域                           |
| ------------ | ----------------------- | -------------------------------------------- | -------------------------------- |
| 模型用途     | `slot → provider/model` | `llm.toml` 基础配置 + 当前设备 Settings 覆盖 | 当前设备上所有使用该 slot 的执行 |
| runtime 覆盖 | `runtimeId → slot`      | `SessionRecord.runtimeModelOverrides`        | 单个会话；快照与 fork 会保留     |

**Agent runtime**

- 世界准备页从已启用的插件里找出所有 agent runtime。
- 不选，表示沿用 `PLUGIN.md` 的 `model`。选了，就写进 `runtimeModelOverrides`。
- 同一个插件有多个 runtime 时，key 必须是完整 ID（如 `char-creator/character-tracker`），可以分别绑定。
- 会话开始后，左侧插件列表通过 `PATCH /api/sessions/:id` 更新同一张表。下一次执行读取新值，正在运行的调用不受影响。

**界面上的两个值**

- “插件默认用途”显示的是插件清单里声明的用途。
- “服务商 · 模型”显示的是这个用途经过本设备覆盖之后，真正调用的目标。

两个同时出现是为了区分“走哪个用途”和“最后用哪个模型”，不代表配置不一致。改某个用途的服务商或模型，会影响所有仍指向这个用途的 runtime。改 runtime 覆盖只是换一个用途，不改用途本身。

**Function runtime**

Function runtime 不读取 `runtimeModelOverrides`。图像、语音等 function 插件通常用自己的 `userSettings.modelPresetId` 选择对应能力的用途。准备页把它显示成一个独立的选项，写进设备设置 `plugin.<pluginId>.modelPresetId`。不要把 agent runtime 的会话覆盖和 function runtime 的这个设置混用。

**连接测试和设置页**

- 连接测试经过和回合执行相同的请求头校验、用途绑定、参数覆盖和能力限制。用途测试保留用途名，不能先换成预设 ID 而丢掉这个用途的配置。
- `GET /api/presets` 和 `GET /api/llm-config` 返回模型能力和白名单里的 `parameterOverrides` 默认值。设置页据此显示 TOML 默认值和恢复默认后的预算。它们不返回任意的 provider metadata。
- 两个 token 设置入口共用覆盖数据和 `resolveLlmTokenLimits`。页面同时显示有效的输出预算和剩余的输入预算，并提示上下文和输出的冲突。
- 未知模型的协议默认值只声明内容类型和特性，不猜测具体模型的 token 上限。

**记忆提取**

- 记忆由 `memory` 插件的 post-turn function runtime 提取。它读取冻结的 `turn-digest@1`，作为 `completion.mode: detached` 的后台作业执行。
- `settle: before-next-execution` 让下一次执行在读取新快照之前，先等已入队的作业完成。最长等待时间由 `maxSettleWaitMs` 控制。
- 作业通过当前请求的 gateway 使用 `memory` 用途，默认 `reasoningEffort: disabled`。请求里的模型绑定、参数覆盖和授权仍然照常解析。
- 模型调用失败不回滚已提交的剧情。失败或取消的提取不会提交一部分记忆。
- 成功的提取写入 `memory` 插件自己的 `blocks` namespace，面板直接读取这份数据。提示词由它的 `prompt.segment@1` 扩展注入。
- `memory` 用途可以在模型配置里明确绑定。它的解析和回退遵循本页的通用规则。

## 请求中的模型身份

设备设置和 `X-Slot-Config.slotBindings` 使用同一种写法。每个用途只接受下面两种之一：

```json
{ "modelRef": "local-reference" }
```

```json
{ "presetId": "server-preset" }
```

- 本地引用必须在这次请求的 `customPresets` 里声明。同名的服务端预设不能顶替缺失的本地引用。
- 绑定的形状不对、模型引用重复、缺少定义或者路由头不合法时，在执行之前返回 `400 invalid_llm_configuration`。不会忽略配置去调用别的模型。
- 临时注册按这次请求的配置隔离。公共模型目录和默认的 text / embedding 选择只读取持久配置。一个请求不能通过内部 ID 访问另一个请求的模型。
- 本地选择和服务端选择同名时，模型标签、能力、参数编辑和连接测试都按选择的类型解析。

**连接测试 `POST /api/ai/ping`**

- 接受 `modelRef`、`presetId` 或 `slot` 三者之一，不能同时给多个。
- 本地模型测试会带上它在这次请求里的定义。用途测试保留用途名和它的参数。
- 明确指定的模型不存在时返回失败，不会去测别的模型。
- 没有指定目标，或者指定了没配置的用途时，仍然允许服务端按用途回退，并在 `testedTarget.resolvedVia` 里写明实际来源。
- 选定目标之后，Ping 固定这次的模型绑定，并保留原用途的参数和能力覆盖。同名预设不会再改变路由。
- 选中的模型失败时直接返回失败，不执行配置里的备用模型。
- 无效的 JSON、未知的请求字段、同时指定多个目标，返回 400。合法的 `{}` 表示测试默认用途。

**`allowFallback`**

底层 Gateway 的 `generateText`、`generateObject` 和 `streamText` 接受 `GatewayOptions.allowFallback`，默认 `true`，也就是保留普通生成的备用模型链。设为 `false` 时只解析并调用主目标；明确指定的目标不存在时仍然报错。这个选项不改变按用途名解析时的同标签规则。Ping 在固定实际绑定之后使用 `allowFallback: false`。

## 服务商与模型 ID

设置界面把连接信息和模型 ID 分开保存：

- 一个服务商配置一组 `baseUrl`、协议、API 密钥和价格倍率，下面可以有多个模型 ID。
- 用途绑定只引用其中一个模型。
- 发请求时，前端把这个引用转换成服务器认识的自定义预设（preset）。预设只是内部传输用的结构，用户不需要单独创建。

**保存的内容**

- 持久化层只保存 `llm.providers`。每个模型条目可以带一个 `reasoningEffort` 默认值。
- 添加服务商、批量添加模型和编辑现有模型时，都可以逐个模型设置；导入导出保留这个字段。
- `X-Slot-Config.customPresets` 是当前请求从 providers 临时生成的模型定义。
- 模型默认值是请求里模型身份的一部分。同一个模型引用在不同请求里用不同设置时，不会串用配置。

**`ref` 和 `modelId`**

- `ref` 是这条配置的身份。`modelId` 只是发给服务商的模型 ID。
- 同一个连接可以保存多条 `modelId` 相同的配置，各自起名字、设置思考档位。例如“快速工具 / 关闭思考”和“详细叙事 / 开启思考”。
- 添加时，只有模型 ID、名称和思考设置都相同的条目才会被复用。
- 复制配置会生成新的 `ref`。编辑名称或思考设置不改变 `ref`。
- 导入要求规范化后的 `ref` 在所有连接里唯一。有重复时整批拒绝，不按模型 ID 合并。

**界面行为**

- “服务商与模型”页面可以复制配置、编辑名称，思考设置自动保存。
- 用途分配、插件绑定和会话摘要显示配置名和思考设置。
- 主叙事、agent 插件、function 插件和记忆任务都通过同一条请求配置链继承所选模型的默认值，不用逐个用途重复设置。用途上明确的覆盖仍然优先于模型默认值。
- 目前 `automatic` 档位用于 Qwen，界面显示“开启思考”，发送 `enable_thinking: true`。它不是“按任务自动决定开或关”。

**添加第一个服务商**

- 第一次手动创建服务商和模型时，如果 `story` / `plugin` 还没有明确分配，设置页会把这两个用途同时绑定到这个模型。这样叙事和插件任务马上就能运行。
- 添加服务商时可以从列表里选一个[内置服务商](#内置服务商与协议)，对话框会填好它的 ID 和官方地址，协议用它自己的。选“自定义服务商”就手动填写。
- 内置服务商即使没填 `baseUrl`，也使用框架内置的官方地址和协议。用户填写的地址始终优先。

**Google 的两种接法**

- `google` 默认使用 `google-generative-ai-v1` 和 `https://generativelanguage.googleapis.com/v1beta`，密钥名是 `GOOGLE_API_KEY`。设置页的协议选项显示为“Google Gemini”。
- 要用 Google 的 OpenAI 兼容接口，需要明确选择 `openai-chat-v1`，并把地址设为 `https://generativelanguage.googleapis.com/v1beta/openai`。

**模型 ID 原样发送**

模型 ID 是一个不解释的字符串，发请求时不裁剪也不改写。例如服务商 `openai` 下的 `openai/gpt-5.6-sol` 和 `deepseek/deepseek-v4-flash` 都保持原样。

查询模型能力时，按下面的顺序尝试匹配。匹配结果只用来显示能力和价格：

1. 完整 ID；
2. 去掉与当前服务商相同的最外层路由前缀；
3. 最后一个 `/` 后的模型名；
4. 带版本后缀模型的最长已知前缀；
5. 接口协议的保守默认能力。

**价格**

- 通过聚合服务商匹配到上游模型资料时，价格标为“参考价”。实际费用以当前服务商的账单为准。
- 每个服务商的价格倍率默认是 `1`，接受 `0.1`、`2.5` 这样的正小数。调试成本面板按“模型参考价 × 服务商倍率”计算预估结算价。
- 没有精确识别的模型不会被猜成支持图片输入。可以在“用途分配”里手动覆盖能力。

## 思考强度

“生成参数”页面按模型 ID 里的上游厂商名识别思考档位。例如服务商是 `openai`、模型 ID 是 `deepseek/deepseek-v4-flash` 时，仍然使用 DeepSeek 的 `关闭 / high / max` 档位。选项由模型能力决定，不假定各家的强度是等价的。

TOML 里用 `reasoningEffort` 设置模型的默认档位：

```toml
[covel.story]
provider = "qwen"
model    = "qwen3.8-flash"
baseUrl  = "${QWEN_BASE_URL}"
protocol = "openai-chat-v1"
reasoningEffort = "disabled"
```

- 取值和界面、以及 runtime 的 `llm.reasoningEffort` 相同。
- 你只写一个通用的档位，适配器把它翻译成各家自己的字段。做法类似 AI SDK 顶层的 [`reasoning`](https://ai-sdk.dev/docs/ai-sdk-core/reasoning) 选项。
- 模型不支持的档位会记录一条 warning，并沿用服务商的默认行为。
- 它和在“服务商与模型”页面给模型设置的思考档位是同一份默认值。
- 需要直接写原生字段时，改用下文的 `providerOptions`。

**生效顺序**

用途上明确的覆盖 → 模型 / TOML 默认 → 任务默认 → 服务商默认。

- 用途留空表示继承。模型留空表示按任务决定。
- 明确写 `provider-default` 表示交给服务商决定：清除继承来的思考请求字段，并跳过任务默认。它不等于“没有配置”。
- 记忆提取的任务默认仍然是关闭思考。用户在用途或模型上设置的档位优先。
- 界面分别显示继承值和明确的覆盖，不把服务商文档里的默认档位当成本次任务的实际参数。

`REASONING_EFFORT_VALUES` 和 `ReasoningEffort` 由 `@covel/shared` 定义，前端保存、请求入口校验和 provider adapter 共用。模型参数只通过白名单字段传输，不会把任意导入的 JSON 合并进服务商请求。

**按协议转换**

统一的 `reasoningEffort` 按接口协议转换：

- **OpenAI Chat 和兼容接口**：`reasoning_effort`。
  - DeepSeek 同时发送 `thinking.type`。
  - Qwen 的开关使用 `enable_thinking`。
  - Qwen3.8 Chat 的原生档位 `low/medium/xhigh` 使用 `reasoning_effort`。
  - 已确认的 Qwen3.5–3.7 Max/Plus/Flash 使用 `thinking_budget` 预算预设（2048/8192/16384），界面写明 token 数值。预算预设不是服务商的原生档位，实际消耗可以少于预算。
  - 明确的档位会清掉继承来的预算，避免 Qwen3.8 同时发送两种参数。
- **OpenAI Responses**：`reasoning: { effort }`。
  - 已识别的 GPT-5 / o3 / o4 模型同时请求 `summary: "auto"`；明确的摘要设置保留。
  - 服务商是否保存对话见 [Responses 不让服务商保存对话](#responses-不让服务商保存对话)。
  - 函数工具带 `strict: false`。原因：这个接口在不带该字段时把工具当成严格模式（Chat 协议相反），所有可选参数都变成必填，模型会给每个可选参数填一个空值，工具随后拒绝这次调用。
- **Anthropic Messages**：`output_config: { effort }`。
  - 已识别的自适应思考模型选了档位时，启用 `thinking.type: "adaptive"`，默认请求可见的摘要 `display: "summarized"`。
  - 不能关闭思考的模型不显示关闭选项。
  - Claude 请求会移除和思考冲突的采样参数；关闭思考时清掉继承的 effort，避免组合后返回 400。
  - DeepSeek 的 Anthropic 兼容接口同时发送 `thinking.type`。
- **Gemini 原生 `generateContent`**：
  - Gemini 3 使用 `generationConfig.thinkingConfig.thinkingLevel`；Gemini 2.5 使用 `thinkingBudget`。
  - 3 Pro 只有 low/high；3.1 Pro 是 low/medium/high；3 Flash、3.5/3.6 Flash 和 3.1/3.5 Flash-Lite 是 minimal/low/medium/high；3.7/3.8 Flash 是 low/medium/high。
  - 2.5 Pro 不提供关闭。2.5 Flash / Flash-Lite 的 `none` 转成预算 0。
  - 2.5 的 low/medium/high 分别是应用的预算预设 1024/8192/24576 token，不是 Google 的原生档位。
  - 未知的 Gemini 型号不猜测档位。
  - Google 的 OpenAI 兼容接口仍然发送 `reasoning_effort`。其中 `minimal` 在 3.1 Pro 上对应 low，在 2.5 上对应 1024 token。这不代表原生协议支持这些型号的 `minimal` 档位。

**目前识别的档位**

| 厂商        | 档位                                                                                           |
| ----------- | ---------------------------------------------------------------------------------------------- |
| OpenAI      | `none/minimal/low/medium/high/xhigh`；GPT-6 及之后的型号按名称识别，另有 `max`，不记录默认档位 |
| Anthropic   | `low/medium/high/xhigh/max`，具体取决于模型                                                    |
| Gemini      | 按型号和协议限定的子集，见上                                                                   |
| xAI         | `low/medium/high`                                                                              |
| DeepSeek V4 | `high/max`                                                                                     |
| Qwen        | 关闭 / 开启、原生档位，或预算预设                                                              |

界面只列出目标模型已知支持的子集。没有识别的模型沿用服务商的默认行为。Gemini 的档位依据 [Google thinking 说明](https://ai.google.dev/gemini-api/docs/generate-content/thinking)和 [OpenAI 兼容映射](https://ai.google.dev/gemini-api/docs/openai)。

#### 档位数据

“哪个模型支持哪些档位”是数据，不是代码。

- 数据在 `packages/ai-provider/src/capability/reasoning-models.data.json`。它按服务商系列（`deepseek`、`anthropic`、`google`、`xai`、`qwen`、`openai`、`compatible`）列出模型名称的正则和对应的档位。
- 代码（`reasoning-effort.ts` 里各协议的 wire）只负责把选中的档位写成该协议的请求字段。
- 结构和 AI SDK 一致：先按模型名解析出能力，再由协议层写参数。区别是能力放在数据文件里。

每个系列的字段：

| 字段               | 含义                                                                                                                                                                         |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model`            | 模型 ID（小写）匹配其中任一正则即属于该系列；按文件中的系列顺序判断                                                                                                          |
| `provider`         | 没有任何系列的 `model` 匹配时，按服务商 ID 判断                                                                                                                              |
| `known`            | 已确认支持档位的名称。系列写了 `known` 或 `tableFlag` 时，模型要先通过其中之一才读 `rules`                                                                                   |
| `tableFlag`        | LiteLLM 模型表把模型标为 `reasoning` 时也算通过（只在查询带上模型表特性时生效，即设置页的档位列表；请求路径只按名称判断）                                                    |
| `thinkingAlwaysOn` | 不能关闭思考的模型：不提供 `disabled`                                                                                                                                        |
| `rules`            | 按顺序取第一条适用的规则。`match`（一个或多个正则，全部匹配）、`protocols`（适用的协议，`""` 表示未指定协议）、`whenThinkingAlwaysOn`、`default`、`levels`、`parameterStyle` |

- `levels` 的一项是档位名，或者 `{ "value", "budget", "protocols" }`。`budget` 表示这一档按思考 token 预算发送，`protocols` 表示只在这些协议上提供。
- `parameterStyle` 在一个系列有多种写法时选其中一种：Anthropic 的 `adaptive`（同时发送 `thinking.type: "adaptive"`）和 Qwen 的 `effort`（同时发送 `reasoning_effort`）。

**为什么由人工维护**

LiteLLM 模型表只提供 `reasoning` 这一个标记。它的 `supports_*_reasoning_effort`、`reasoning_effort_levels` 等字段目前只覆盖部分 OpenAI、Anthropic 和少数其他模型；Gemini 只有个别条目；Qwen、DeepSeek、xAI 没有；也不包含预算预设和各协议的差异。所以档位数据由人工维护，每周的模型表刷新不会改动它。

刷新会重新生成 `packages/ai-provider/tests/__snapshots__/reasoning-characterization.snap.txt`。这个文件记录每个模型名称在每个协议下得到的档位和请求字段，它的 diff 就是“新模型落在哪一类”的清单。

**不等发版就给新模型加档位**

在用户配置目录（桌面版是 `~/.covel/`，即 `COVEL_USER_CONFIG_DIR`）放一个同样格式的 `reasoning-models.json`，服务端启动时读取：

```json
{
  "families": [
    {
      "id": "compatible",
      "rules": [{ "match": "kimi-k3", "levels": ["low", "high", "max"] }]
    }
  ]
}
```

- 这个文件里的规则先于内置规则读取，并且不经过 `known` / `tableFlag`。所以每条规则必须写 `match`。
- `model`、`provider`、`thinkingAlwaysOn` 追加到内置列表。`known` 和 `tableFlag` 不能写。
- 文件无效时记一条警告，只使用内置数据。
- 没有设置 `COVEL_USER_CONFIG_DIR` 的部署（源码开发、Docker）不读取这个文件。

没有任何规则命中的模型，行为不变：

- 属于某个已命名系列的，不发送思考字段。
- 属于 `compatible` 系列的（名称和服务商都不属于任何系列），按所选档位原样发送。在这个系列里加了规则的模型，只发送规则列出的档位。

### Responses 不让服务商保存对话

Responses 协议的每个请求默认带 `store: false`。服务商不保存这次请求的提示和回答，玩家的对话只留在 Covel 自己的存储里。

OpenAI 的 Responses 接口在不带这个字段时，默认保存一段时间，所以 Covel 不依赖服务商的默认值。Chat 协议不受影响：只有用途配置了 `store` 时才发送它。

不保存时，服务商没法按 ID 找回上一次回答里的 reasoning 条目。工具续调时，Covel 要把它原样带回去：

- 请求没有关闭思考（`reasoning.effort` 不是 `none`）时，Covel 加上 `include: ["reasoning.encrypted_content"]`，不看模型名称。`include` 里已有的其他值保留。
- 续调时，上一次回答的输出条目按原顺序放回 `input`。
  - 带 `encrypted_content` 的 reasoning 条目原样带回。
  - 没有 `encrypted_content` 的 reasoning 条目不带回；同一次回答的其余条目去掉 `id` 后带回，避免服务商去查一个它没有保存的 ID。这时模型看不到上一步的思考，工具调用和结果仍然完整。
- 模型不接受加密 reasoning 时（返回 400，错误指向 `include` 或提到 encrypted content），Covel 去掉这一项重发一次，并在本进程里记住这个地址和模型，之后的请求不再带它。其他 400 不重试。
- 流式回答的结束事件里 `output` 为空时，Covel 用前面逐条收到的 `response.output_item.done` 组成续调条目。

需要服务商保存时（例如要在服务商控制台里查看回答），在该用途的 `providerOptions` 里写 `store = true`（见[供应商参数](#供应商参数)）。这时 Covel 不请求加密 reasoning，续调条目带原有 ID，由服务商按 ID 找回。

Covel 自己不使用 `previous_response_id`，每次请求都带完整的上下文。通过 `extraBody` 自己传 `previous_response_id` 的配置必须同时写 `store = true`，否则服务商找不到那次回答。

## 媒体 wire 路由键（`providerRequestMetadata`）

图像、语音合成（TTS）和语音转写（STT）的请求格式由 **wire** 决定。一个 wire 就是一家厂商的请求和回答格式。用途通过 `providerRequestMetadata` 里的路由键选择 wire：

| 路由键              | 适用 tag        | 内置 wire（缺省值加粗）                                                                                                                                    |
| ------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `imageWire`         | `image`         | **`openai-images`**、`dashscope-wan`（DashScope 原生图像面：wan2.x 走异步任务轮询；`qwen-image*` 系列——含 qwen-image-3.0-pro——自动切同步 multimodal 端点） |
| `speechWire`        | `speech`        | **`openai-speech`**（`POST /audio/speech`）                                                                                                                |
| `transcriptionWire` | `transcription` | **`openai-transcription`**（`/audio/transcriptions`）                                                                                                      |
| `musicWire`         | `music`         | 没有内置 wire，也没有缺省值：音乐服务商没有通用的请求格式，由插件注册                                                                                      |

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
# A wire registered by a plugin carries the <pluginId>/ prefix
providerRequestMetadata = { speechWire = "mimo-tts/mimo" }
```

**音乐**

音乐生成（`ctx.music.generate()` / `gateway.composeMusic`）解析名为 `music` 的用途。找不到时只回退到 `tag = "music"` 的其他用途。语音合成的用途同样输出音频，但不会被拿来生成音乐。

用途没有写 `musicWire`，或者写了没注册的 wire 时，在发出请求之前返回 `CONFIG_ERROR`。目前内核和内置插件都没有提供音乐 wire，这个用途要等插件注册之后才能用：

```toml
[covel.music]
provider = "example"
model = "example-music-1"
baseUrl = "https://api.example.com"
protocol = "openai-chat-v1"
tag = "music"
output = ["audio"]
providerRequestMetadata = { musicWire = "<pluginId>/<wireId>" }
```

**规则**

- 路由键在进入 wire 之前被去掉，不会出现在发给厂商的请求体里。
- wire ID 没有注册时，生成时抛 `CONFIG_ERROR`（报错信息里有修复办法），不会悄悄换成别的 wire。
- 插件注册的 wire 只服务启用了该插件的会话，规则和文本协议相同。别的会话用到它时抛 `CONFIG_ERROR`，报错里写明要启用哪个插件。
- 插件在 `entry` 模块里用 `covel.registerWires({ image?, speech?, transcription?, music?, text? })` 注册自定义 wire。wire 的 `id` 要写进清单的 `contributes.wires`；注册了没声明，或声明了没注册，插件都加载失败。见 [plugin-extensions.md § 模型与新协议](./plugin-extensions.md#模型与新协议)。
- wire 与 MediaStore 的关系见 [media-store.md](./media-store.md#media-wire-registries-image--speech--transcription--music)。

## 供应商参数

`generateText`、`generateObject`、`streamText` 和 TOML 里的用途都接受 `providerOptions`。它按“命名空间”分组，命名空间的键是实际的 provider ID 或协议 ID。

```toml
[covel.story.providerOptions.openai]
store = true
reasoningEffort = "high"

[covel.story.providerOptions."openai-responses-v1"]
reasoningSummary = "auto"

[covel.gemini.providerOptions.google.thinkingConfig]
thinkingLevel = "medium"
includeThoughts = true
```

- 一次解析先应用协议命名空间，再应用 provider 命名空间。
- 只校验当前目标的命名空间。备用目标的配置在真正切换过去时才生效。

**有类型的字段**

| 字段                              | 说明                                                                                                                                            |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `reasoningEffort`                 | 思考档位                                                                                                                                        |
| `reasoningSummary`                | 只用于 Responses                                                                                                                                |
| `parallelToolCalls`               | 是否并行调用工具                                                                                                                                |
| `store`                           | 是否让服务商保存，见 [Responses 不让服务商保存对话](#responses-不让服务商保存对话)                                                              |
| `seed`                            | 适用于 Chat 和 Gemini 原生协议                                                                                                                  |
| `user`                            | 用户标识                                                                                                                                        |
| `promptCacheKey`                  | 见[提示词缓存键](#提示词缓存键)                                                                                                                 |
| `thinking`                        | Anthropic。启用思考写 `{ type: "enabled", budgetTokens: 2048 }`，发送时转成 `budget_tokens`                                                     |
| `thinkingConfig`、`cachedContent` | 只用于 Gemini 原生协议。`thinkingConfig` 可以设 `thinkingBudget` 或 `thinkingLevel`（二选一）和 `includeThoughts`，值必须在目标型号支持的范围内 |

- 已知字段的值不合法时，在请求之前抛出不可重试的 `CONFIG_ERROR`。
- 不支持或不认识的字段被忽略，并记录到 `diagnostics.warnings`。
- 生成参数也会校验：数值必须有限，采样在范围内，输出额度是正整数。

**合并顺序**

1. 用途的自由 metadata
2. 用途的命名空间设置
3. 本次调用的自由 metadata
4. 本次调用的命名空间设置
5. 用途和 runtime 的生成参数限制

`extraBody` 可以传还没有类型的原生字段。下面这些框架字段受保护，不能借它覆盖，写了会被省略并产生 warning：`model`、`messages`、`tools`、`stream`、回答格式、输出预算，以及 Gemini 的 `contents`、`systemInstruction`、`generationConfig` 等。

**和 `providerRequestMetadata` 的关系**

- 自由格式的 `providerRequestMetadata` 仍然可以用。
- 本次调用里的原生字段只随最初的 provider、协议和端点发送。回退改变其中任何一个时，这些字段被省略，并记录 warning。
- 通用的 `parameterOverrides` 仍然保留。每个备用用途自己的配置仍然生效。
- 需要对多家服务商分别设置时，使用各自的 `providerOptions` 命名空间。
- 媒体 wire 路由和插件的 `resolveSlot().metadata` 约定不变。

这个接口参考了 [AI SDK 的 provider options](https://ai-sdk.dev/docs/foundations/provider-options) 和它按命名空间校验的方式，同时保留 Covel 的用途绑定和协议适配器。

### 提示词缓存键

OpenAI 按提示词开头的哈希把请求分到机器上。请求里的 `prompt_cache_key` 会并入这个哈希（[OpenAI 文档](https://developers.openai.com/api/docs/guides/prompt-caching)，AI SDK 的对应选项是 `promptCacheKey`）。没有它时，同一个 runtime 相邻两回合的请求可能落到不同的机器上，前缀相同也读不到缓存。

**键是什么**

agent runtime 的每次模型请求都带一个键：`covel-` 加上“会话 ID 和 runtime ID 的 SHA-256”的前 32 位十六进制字符（`promptCacheKeyFor`，`packages/runtime/src/llm/prompt-cache-key.ts`）。

- 同一个会话里同一个 runtime 的请求，键相同，它们共用一段前缀。
- 不同 runtime、不同会话的键不同。
- 键里没有会话 ID 的原文，也没有玩家的文字。长度在 OpenAI 允许的 64 个字符以内。

**发给谁**

键只在 `openai-chat-v1` 和 `openai-responses-v1` 两个协议上发送，而且默认只发给 `api.openai.com`。这个字段是 OpenAI 自己的。兼容 OpenAI 的服务遇到不认识的字段可能直接返回 400，一次被拒的请求比一次没命中的缓存代价更大，所以其他地址默认不发。

中转到 OpenAI 的服务如果会转发这个字段，在该用途的 `providerOptions` 里打开。写 `false` 则对 `api.openai.com` 也不发：

```toml
[covel.story.providerOptions.myrelay]
promptCacheKey = true
```

**其他规则**

- 想固定成自己的键，在 `extraBody` 或 `providerRequestMetadata` 里写 `prompt_cache_key`。它覆盖框架生成的键。
- function runtime 通过 `ctx.gateway.generateText` 发的请求也带键。宿主按同样的规则用会话 ID 和该 runtime 的 ID 生成，插件传入的 `promptCacheKey` 会被替换。
- 要读到缓存，请求的开头必须是不变的内容（指令、稳定的数据），变化的部分放在后面，并且前缀不少于 1,024 个 token。
- `generateObject`、历史压缩、记忆向量检索、世界生成和翻译不带键。原因分别是：压缩的固定指令很短，两次调用相隔很久；向量检索没有提示词缓存；世界生成和翻译没有会话，只有重试才会重复前缀。

**`lateSystemAsUser`**

这是 `openai-chat-v1` 和 `openai-responses-v1` 的一个 `providerOptions` 选项，默认 `false`。

打开后，第一条对话消息之后的 system 消息改作 `user` 消息发送，包在 `<system-instruction>` 标签里，位置和文字不变。

```toml
[covel.story.providerOptions.myrelay]
lateSystemAsUser = true
```

为什么需要它：框架把每回合都变的内容（数据块、本回合规则）放在历史之后的一条 system 消息里。有些中转服务会把所有 system 消息移到最前面，或者把请求转换成只有一个 system 位置的协议。这样每回合都变的文字就排到了历史前面，历史全部落在缓存之外。

- 实测（本机 Codex 式中转，叙事 runtime，8 回合）：每回合首个请求的缓存读取从 3,584 token（中转自带的固定指令）升到 8,704，占输入的比例从 22% 升到 55%；叙事全部请求从 54% 升到 75%。
- 这只是在那一个中转上的测量。`api.openai.com` 和其他兼容服务没有测过，也没有证据表明它们会移动 system 消息。
- 代价：模型看到的角色从 system 变成 user，回合规则和插件写的指令（如掷骰步骤）的权重可能略有不同。没有做过质量对比。
- Anthropic 协议始终这样处理，不受这个选项影响。

同一个选项在 `google-generative-ai-v1` 上的默认值相反：

- 不写或写 `true`：第一条对话消息之后的 system 消息留在原位，作为 `contents` 里带 `<system-instruction>` 的 user 文本。只有开头的 system 消息进入 `systemInstruction`。相邻的同角色纯文本合并成一条；函数响应始终紧跟函数调用，并且独占一条 user 内容。规则见[提示词结构](./prompt-structure.md)。
- 写 `false`：所有 system 消息都进 `systemInstruction`，每条消息一条内容。代价是每回合变化的文字排在历史之前，前缀缓存每回合从头断开。

```toml
[covel.story.providerOptions.google]
lateSystemAsUser = false
```

Gemini 上的默认形状只在一个模拟 Gemini 接口的本机中转上验证过，没有在 Google 的端点上验证。如果 Google 的端点拒绝请求，写 `false` 就是退回去的办法。这个选项只由适配器读取，不会发给服务商。

## 结构化输出

`gateway.generateObject({ schema, messages })` 在发送请求之前，把 Zod schema 的输入形态转换成 JSON Schema。各协议传递 schema 的方式不同：

| 协议        | 做法                                                                                 |
| ----------- | ------------------------------------------------------------------------------------ |
| Responses   | 把完整的 `name` / `schema` 放进 `text.format`                                        |
| OpenAI Chat | 使用兼容的 `json_object` 模式，并在系统消息里传递 schema                             |
| Anthropic   | 在系统消息里传递 schema 和 JSON 输出指令                                             |
| Gemini 原生 | 发送 `generationConfig.responseMimeType: "application/json"` 和 `responseJsonSchema` |

- Chat / Anthropic 的指令不保证模型一定遵守 schema。所有协议在返回之后仍然用原始 Zod schema 的 `safeParse` 校验，并应用默认值和转换。自定义的 refinement 也在这一步校验。
- 无法转换成 JSON Schema 的输入类型，在网络请求之前返回不可重试的 `CONFIG_ERROR`。
- 模型返回的不是 JSON，或者对象不符合 Zod schema，返回 `SCHEMA_VALIDATION_FAILED`。
- schema 指令保留已有的 Anthropic 缓存分段，并避免重复插入 runtime 已经提供的同一个 schema。

`gateway.generateText` 和 `gateway.streamText` 都接受 `responseFormat`，并把它传给每次实际调用的适配器，包括备用模型。流式输出仍然是文本增量：`responseFormat` 不提供增量的对象解析，也不能代替调用方对完整结果的校验。

## Provider 流式响应

只要 adapter 提供流式接口，所有 agent runtime 都使用它。只有故事 runtime 把文本增量转发到玩家界面。由此带来的规则：

| 情况                                                      | 处理                                                                                     |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 流在已有输出之后中断                                      | 故事 runtime 不重试；其他 runtime 丢弃半截输出，按 `maxRetries` 重试                     |
| 结果被 `length` / `max_tokens` 截断                       | 不能当作成功提交。重试一次，再次截断才以“调大输出额度”的错误失败，也不改用非流式调用重来 |
| 流在没有任何输出时失败，重试用完                          | 改用一次非流式调用                                                                       |
| provider 明确拒绝请求本身（401、400、配置或 schema 错误） | 不改用非流式调用，因为同一个请求会原样失败                                               |
| HTTP 200 里带 provider 错误                               | 保留消息、code/type。确定性的拒绝不会变成一个空的、可重试的错误                          |

其他规则：

- 备用模型在调用之前重新检查实际的消息、工具、结构化输出 schema 和输出预留需要多大的窗口。装不下的目标不会收到这个请求。
- 能力解析优先选模型数据库的精确匹配，再考虑精选表的前缀匹配，避免把语音子型号识别成文本模型。
- runtime 默认关闭思考时，已知型号使用它支持的关闭值；不支持关闭的，使用最低档并记一条诊断。未知的兼容型号不自动发送思考字段。用户明确的参数仍然优先。
- 较新的 OpenAI reasoning / GPT 型号使用 `max_completion_tokens`。不接受强制工具或关闭思考的 Anthropic 型号，按它的能力收窄请求。
- 内置的图片和语音生成不在 HTTP 层自动重发。超时或连接断开时，客户端没法据此判断上游是否已经生成。文本调用的重试策略不受这条规则影响。

### 连接测试与失败原因

模型接口失败的方式比普通 URL 多：密钥、余额、模型名、服务商负载，各有各的处理办法。连接测试（`POST /api/ai/ping`）、读取模型列表和回合中的模型调用失败时，除了服务商的原话，还给出一个类别 `errorKind`。界面按类别显示该怎么办：

| `errorKind`    | 含义                                     | 依据                                                                                             |
| -------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `unreachable`  | 连不上：服务没启动、地址端口错、DNS、TLS | 无 HTTP 状态；连接错误码（`ECONNREFUSED`、`ENOTFOUND` 等）或证书错误                             |
| `timeout`      | 连上了但没有按时应答                     | 超时错误码、请求预算耗尽、408、504                                                               |
| `auth`         | 密钥无效或无权使用该模型                 | 401、403                                                                                         |
| `quota`        | 余额或额度不足                           | 402；或服务商的错误码 / 文字说明额度不足（OpenAI 用 429 `insufficient_quota`，Anthropic 用 400） |
| `rate_limited` | 请求过于频繁                             | 429                                                                                              |
| `not_found`    | 地址路径或模型 ID 不存在                 | 404                                                                                              |
| `bad_request`  | 服务商拒绝了请求本身                     | 其余 4xx，多半是协议或参数不匹配                                                                 |
| `overloaded`   | 服务商当前过载                           | 503、529（Anthropic）                                                                            |
| `server`       | 服务商内部错误                           | 其余 5xx                                                                                         |
| `refused`      | 服务商拒绝回答                           | refusal / content filter                                                                         |
| `config`       | 模型配置无法发起这次调用                 | 配置错误、地址被出站规则拒绝                                                                     |

连接失败时，`error` 取底层原因（如 `connect ECONNREFUSED 127.0.0.1:11434`），不是笼统的 `fetch failed`。分类在 `@covel/ai-provider` 的 `classifyProviderFailure`，类别的类型 `ProviderFailureKind` 在 `@covel/shared`。

429 只按错误码判断是不是额度用完，不读文字：OpenAI 普通限流的提示里也带着账单页面的链接。

`quota` 和 `auth` 是账户的失败，`@covel/shared` 的 `isAccountFailure` 判断。同一个请求再发给同一家，只会同样失败，所以 HTTP 层和 runtime 都不再重发，只切换玩家配置的备用模型。

连接测试按模型类型选择探测方式：

- 文本模型：发一次最小的流式请求。收到第一段正文或思考内容的时间算作首字延迟。
- 评估模型：发一次评估请求。
- embedding 模型：发一次向量请求。

测试只发一个 HTTP 请求，不做传输重试，也不切换备用模型。所以报告的就是这一次请求的结果和耗时。

### 流的格式和结束

四种内置文本协议共用一个 SSE 帧解析器：

- 支持 LF、CRLF、CR 换行，包括被网络分片切开的 CRLF。
- `data:` 后面的空格可有可无。同一个事件里可以有多个 `data` 行，多行内容用换行连接后再解析 JSON。
- 事件必须以空行结束。流结束时丢弃没写完的事件。
- 收到 `[DONE]`，或者调用方提前停止读取时，解析器取消剩下的响应体并释放 reader，避免后台连接继续占用资源。

格式规则见 [WHATWG SSE 规范](https://html.spec.whatwg.org/multipage/server-sent-events.html#event-stream-interpretation)。

文本流必须带上各自协议的结束标志：

| 协议        | 结束标志                                                             |
| ----------- | -------------------------------------------------------------------- |
| Chat        | 非空的 `finish_reason`                                               |
| Responses   | `response.completed` / `response.incomplete`                         |
| Anthropic   | `message_stop`                                                       |
| Gemini 原生 | `streamGenerateContent` 的候选结束原因；不能用 `[DONE]` 判断它的结束 |

- 对 Chat、Responses 和 Anthropic，只有 EOF 或 `[DONE]` 不代表模型成功。
- 流内错误、`response.failed` 和缺少结束标志都抛出 provider error。
- 已经收到部分文本、思考或工具调用之后出错，runtime 不会把它保存成成功，也不会重试之后把两段结果拼起来。
- 没有任何输出的临时错误，仍然可以按既有策略重试或切换备用模型。

### 结束原因、诊断与拒绝

**统一的结束原因。** `generateText`、`generateObject` 的返回值和 stream 的 `done` 里，`finishReason` 是统一之后的结束原因，取值和协议无关：

| 值               | 含义                   |
| ---------------- | ---------------------- |
| `stop`           | 正常结束               |
| `length`         | 被输出或上下文上限截断 |
| `tool_calls`     | 请求调用工具           |
| `content_filter` | 服务商拦截或拒答       |
| `error`          | 出错                   |
| `other`          | 对照表里没有的原因     |

服务商自己的用词（如 Anthropic 的 `end_turn` / `max_tokens` / `tool_use`）保留在 `rawFinishReason`。对照表只有一份，在 `@covel/shared` 的 `unifyFinishReason`。网关在出口处应用它，runtime 和世界生成读同一张表；做法和 AI SDK 的 `unified` / `raw` 相同。插件通过 `ctx.gateway` 拿到的也是统一之后的值。

**只有 `stop` 和 `tool_calls` 算说完了**（`@covel/shared` 的 `isCompleteFinishReason`）。`other` 不算正常结束：服务商没说清为什么停（如 Anthropic 的 `pause_turn`、DeepSeek 的 `insufficient_system_resource`），回答可能停在任何地方。

- 叙事：已经写出来的正文保留，`llm.responded` 带着 `finishReason: other` 和 `rawFinishReason`，界面提示这段没写完，玩家可以重试这一回合。被输出上限截断（`length`）的叙事同样保留，提示的是另一句话。
- runtime 里其他的回答（带工具调用的、要求 JSON 的、不保留截断正文的 runtime）、世界生成、历史摘要：按失败处理，不保存半截结果，也不自动重试。
- function 插件通过 `ctx.gateway` 拿到的是原样的 `other`，由插件决定。后台输出应当和上面一样按失败处理。

**诊断。** 四种内置文本协议的 text / object 返回值和 stream 的 `done` 可以带 `diagnostics`，包含服务商和请求的 warning、URL / 文档来源和引用位置。runtime bridge 和 LLM trace 保留这些信息。

- `citations.location` 区分“回答文本里的位置”和“来源文本里的位置”。不能把 Anthropic 的文档页码或原文字符偏移当成回答里的偏移。
- 来源只记录已经收到的协议数据，不代表已经支持主动调用 web search 或文件工具。
- function 插件的 `PluginRuntimeGateway` 同样透传 `providerOptions` 和完整的返回诊断。这条路径的 `gateway.responded` / `gateway.failed` trace 保持原有的隐私约定：只记录 `diagnosticsSummary` 里的 warning 类型、来源和引用的数量、拒绝原因，不记录引用原文、来源 URL、标题或拒绝的全文。

**拒绝。** 明确的 refusal 或 content filter 抛出不可重试的 `REFUSAL`，拒绝原因保留在 `error.details.diagnostics.refusal`，不切换备用模型。

**失败也记下用掉的 token。** 拒答、`finishReason: error`、错误正文、流正常读到 EOF 却没有结束标志：服务商在失败之前报告过用量时，错误带着它（`error.details.usage`）。runtime 把它写进这次调用的 `llm.responded`，function 插件和扩展点提供方的调用写进 `gateway.failed`，调试页的用量和费用都算上它。服务商没报告用量，就不写 `usage`，不当成 0。绕过适配器收尾检查的底层网络异常仍可能丢失此前报告的用量。

- 即使已经有普通文本或工具内容，也不能把夹着拒绝的回答记成成功。
- 流式文本可能已经交付出去，但不会产生成功的 `done`。
- 内置文本适配器的完整工具调用，都等最终的拒绝检查通过之后才交付。

协议的回归测试使用 `packages/ai-provider/tests/protocol-fixtures/` 里的合成响应，覆盖字节分片、工具参数、未知扩展、拒绝和引用。这样不依赖付费 API，也不保存真实对话。

### 向量调用的模型身份

嵌入（embedding）调用可以传 `expectedModelId`（`provider/model`）和 `expectedConfiguration`。Gateway 在网络请求之前校验模型、地址、协议和编码格式。

- 服务端给会话锁定的身份是 `provider/model#hash`。hash 覆盖有效地址、协议和 embedding 格式，不包含密钥。维度缓存也按这个身份隔离。
- 请求级的模型和密钥同样作用于 embedding，包括该请求发起的异步摄入。它们不会写入会话或共享的凭证配置。
- Memory 的 `EmbedFn(texts, { sessionId, modelId })` 必须使用会话锁定的模型身份。
- 修改当前配置，不能把同维度的另一个模型写进旧索引。身份不匹配时，查询降级为关键词检索，摄入不推进进度，服务端日志对每个会话只记一次。恢复原来的模型配置后可以继续补录。
- 换了向量模型之后，会话里会提示“记忆检索现在只按关键词匹配”，并给出“重建索引”按钮（没有配置向量模型时是“清除索引”）。重建先向新模型发一次请求测出维度，失败时什么都不改；成功后在一个事务里删掉旧模型的向量和进度，把会话锁到新模型，再在后台重新建索引。见 [`POST /api/sessions/:id/memory-index/rebuild`](./api.md#post-apisessionsidmemory-indexrebuild)。
- 写入索引时，存储会核对会话当前锁定的模型。重建之前用旧模型算出的向量，不会写进新索引。

> [!NOTE]
> 换模型不会自动迁移旧索引：重建要把会话的历史重新发给向量模型，所以由玩家决定什么时候做。已经混入错误向量的索引，也用重建修复。

## 音频请求

- 内置的 `openai-speech` wire 把 `SpeechSynthesisParams.format` 对应到服务商请求的 `response_format`。
- 内置的 `openai-transcription` wire 只上传 `audio.data` 视图里的字节。它支持 `Uint8Array` 和 Node `Buffer` 的切片，不会带上底层共享 buffer 里的其他内容。
- OpenAI 的图片、语音和转写 wire 都会去掉只用于文本生成的 `parameterOverrides`，保留各自原生的媒体参数。

## HTTP retry cleanup

这一节讲一次模型请求在 HTTP 层怎样重试、等多久、最多发几次。

**清理**

- provider 和插件的 HTTP 工具在重试之前，会取消被拒绝的响应体，不把整段错误流读进内存。被拒绝的重定向响应同样取消。
- 等待 `Retry-After` 期间可以被取消。很长的有限等待被拆成定时器能安全处理的小段；不是有限数的等待明确失败，不会溢出成“立即重试”。

**重试哪些回答**

和 OpenAI、Anthropic 官方 SDK 以及 AI SDK 一致：

- 重试 408、409、429 和 5xx。
- 429 的错误码说额度用完（OpenAI 的 `insufficient_quota`）时不重试：先读出回答正文，再把带着原样正文的回答交给调用方。
- 服务商在 `x-should-retry` 头里给出的 `true` / `false` 优先于状态码。
- 等待时间先读更精确的 `retry-after-ms`（OpenAI、Azure），再读 `Retry-After`。
- `Retry-After` 同时接受整数秒和 HTTP-date。过去的日期立即重试，无效的值退回到退避策略。
- 服务商要求的等待超过 60 秒，或者超过本次调用剩下的时限时，不等待。这次回答直接返回给调用方，按限流处理，可以改用备用模型。

连接被拒绝或在回答之前断开（`ECONNREFUSED` / `ECONNRESET` / `EPIPE` / `UND_ERR_SOCKET`）和 429 / 5xx 一样重试：同一套退避、同一个重试上限（两类合计 3 次）、同一份请求预算。重启中的端点（本地代理最常见）片刻后就恢复，不该让一次 runtime 调用直接失败。超时不在其中。流式调用已经输出内容之后也不重试。

**请求预算**

每次文本、对象、流式、评估或 embedding 的 gateway 逻辑调用默认有一份预算：最多 8 次实际 HTTP 请求，首次输出最多等 120 秒。

- runtime 的一次逻辑调用只创建一份预算。HTTP 重试、备用目标和 runtime 重试传递同一个 `requestBudget`。
- runtime 的执行预算继续按原来的策略计算，并发排队保留原有的额度补偿。
- 每次实际调用同时受执行预算、逻辑总时限和取消信号约束。排队和退避也计入逻辑总时间。
- 已经输出内容的流仍然禁止重试。
- 预算用完时返回不可重试的 `REQUEST_BUDGET_EXCEEDED`。
- 调用方可以用 `createLlmRequestBudget` 明确设置更紧或更宽的策略，并在 `GatewayOptions.requestBudget` / `LLMAdapter` 参数里传递。

AI 世界创作（生成、修订、翻译）就是这样做的：回答长，有的模型输出慢，所以它按“无响应时间”限时，每次请求传入 30 分钟的明确预算，不受默认 120 秒的限制。见 [api.md](./api.md) 的 `POST /api/ai/generate-world`。

**120 秒是“没有输出的时间”**

默认预算按没有输出的时间限时：

- 流每产出一段正文、一段推理、一次工具调用，或者工具调用参数的一个分片，时限就顺延到此刻之后 120 秒。最晚不超过预算创建之后 30 分钟。
- 所以 120 秒限制的是两件事：第一次输出之前的等待（包括重试、退避和排队），以及两次输出之间的静默。它不是一条持续输出的流的总时长。
- 非流式调用没有进度信号，仍然受 120 秒总时限约束。
- 明确传入 `timeoutMs` 或 `deadline` 的预算保持固定。`deadline` 是任何输出都不会推后的绝对时限。
- 要让明确的预算也按无输出时间计算，另外传 `idleTimeoutMs`，并可以用 `ceilingMs` 设定顺延的上限。

Agent runtime 的一次模型调用以 `max(120 秒, runtime 剩余时间)` 为预算，并传入 `agent.loop.idleTimeoutMs`。这样 runtime 声明的重试次数都有时间执行：

- 流式调用在第一次输出之前，受 `firstTokenTimeoutMs` 和 runtime 时限约束。
- 之后只受 `idleTimeoutMs` 约束。输出花的时间不计入 runtime 的 `timeoutMs`。
- `callTimeoutMs` 只约束非流式调用。

函数 runtime 的每次 `generateText`、`generateObject`、`evaluate` 调用，由宿主按当时剩余的 `function.timeoutMs` 建立固定预算，截止时间不会超过 runtime 的截止时间。一次调用的 HTTP 重试、后备目标和停滞重发共用这份预算及 8 次传输额度；下一次调用重新计算剩余时间。排队也消耗函数的剩余时间，玩家取消会立即中止等待。

**文本调用并发**

`COVEL_LLM_MAX_CONCURRENT` 在 gateway 的每个文本目标尝试前取槽，覆盖文本、对象、流式和评估，包括 agent、函数、后台任务及直接调用。不同 gateway 实例共用一个进程级队列。流持续持槽直到结束、取消或调用方停止消费；失败和后备切换释放槽。agent 的排队通知暂停单次调用/首字计时，并给 runtime 截止时间补偿等候时间；逻辑请求预算仍计入排队。embedding 和媒体不占这个文本槽。

**媒体和 embedding**

- 媒体（图像、语音、音乐、转写）不自动套用这份预算，保留各自 wire 的时限和轮询策略。例如 DashScope WAN 仍然可以每 2 秒轮询一次，最多 300 秒。
- 媒体可以明确传入预算。这时所有 HTTP 请求（包括轮询）都计数。
- embedding 是一次短请求。后台的向量写入和回合内的检索都会调用它，所以它和文本调用使用同一份默认预算：端点不回答时，调用在 120 秒后以 `REQUEST_BUDGET_EXCEEDED` 结束，记忆层不再另外重试。
- 底层 HTTP 工具只消耗传给它的预算。

**观测数据**

在原有的 `transportAttempt` 之外，还提供可选的 `logicalAttempt` 和 `transportRetryReason`（`http-429` / `http-4xx` / `http-5xx` / `connection`）。408、409 和由 `x-should-retry` 触发的其他 4xx 记为 `http-4xx`。

**生命周期 hook 和自定义 adapter**

- 生命周期 hook 的每个通知阶段合计最多等 1 秒。普通 hook 抛错或超时，记录 warning 后继续。请求取消或逻辑时限到期会立即停止等待，不触发额外的重试。
- 预算到期时，gateway 也会停止等待不响应 signal 的自定义 adapter。自定义实现仍然应该用 signal 取消自己的底层 I/O。
- 请求次数由框架的 HTTP 工具在真正发送之前计数。自定义 adapter 如果直接用自己的网络客户端，应该在发送之前调用下面的函数（有预算时）。框架没法自动统计它内部的 HTTP 请求。

```ts
assertLlmRequestBudget(config.requestBudget, {
  signal: config.signal,
  consumeAttempt: true,
});
```

## 失败后的模型与参数调整

**重不重试，看什么**

- runtime 对同一个目标重试时，优先读取结构化 provider 错误的 `code`、`statusCode` 和 `retriable`。
- 配置和 schema 校验失败不重试。错误消息里的关键词不能推翻明确的“不可重试”判断。
- 账户的失败（`quota` / `auth`）不重试，即使状态码是 429。
- 网关整理错误时，保留已知临时网络故障的“可重试”属性。只有未知的第三方异常才根据消息判断。
- 调用方取消，或者已有部分流式输出，仍然禁止重试。备用模型的切换保留自己独立的规则。

**玩家怎样处理一个失败的任务**

1. 错误详情保留失败请求实际使用的 `provider` 和 `model`，包括备用模型最终失败的情况。之后修改配置不会改变已经记录的失败目标。
2. 在失败的任务上打开“更换模型 / 调整参数”，进入模型用途，选择服务商和模型。
3. 展开“生成参数”，调整上下文窗口、模型最大输出能力、单次输出、温度、采样和思考强度。能力字段也可以通过“编辑能力”入口覆盖，包括只在前端配置的模型用途。
4. 关闭设置后点“重试此任务”。请求重新读取当前的模型和参数。已提交的剧情和其他成功的任务仍然保留。

说明：

- 两处使用同一个 token 编辑组件，数据保存在 `llm.capabilityOverrides` / `llm.paramOverrides`。
- 资料库里的输出上限只供参考，不阻止你手动输入符合设置范围的参数。
- 最大输出限制和输入上下文窗口是两个独立的设置。调低输出不会删除会话历史。

**非流式调用的失败判定**

- 非流式的文本和对象生成同样拒绝 provider 错误正文或 `finishReason: error`。即使 HTTP 是 200、正文还能解析，也不会上报成功，或者交给 function 插件写入记忆。
- Responses 必须处于 `completed` 或 `incomplete` 结束状态。排队、处理中、取消、失败或缺少状态，都按 provider error 处理。
- `incomplete` 仍然对应 `length`，保留调用方已有的截断策略。
- 没有输出的 provider error 可以按已配置的备用模型策略回退。

**缓存价格**

模型的计价可以包含 `cacheReadPerMToken` 和 `cacheWritePerMToken`（每百万 token 的美元价格）。固定版本的 LiteLLM 数据库带有明确的读写价格，包括价格为零的情况。调试成本估算对这两部分单独计价；缺少价格时不计价，不会套用普通输入价格。

**服务商的错误码**

HTTP 错误整理之后，服务商原始的 `code` 和 `type` 保留在 `details.providerCode` / `details.providerType`。向量摄入利用明确的“输入被拒”错误码，把失败的一批对半拆开，只跳过出问题的那一条输入。认证、配置和临时故障不移动游标。
