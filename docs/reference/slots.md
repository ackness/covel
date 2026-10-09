# 模型用途（Slot）配置

Slot 是 Covel 内部的模型路由单元，设置界面称为“模型用途”。`llm.toml` 里每个 `[covel.<slot>]` 小节定义一个具名用途，插件任务按 slot 名或 tag 解析到具体服务商和模型。开发环境读仓库根 `llm.toml`，桌面端读 `~/.covel/llm.toml`（设置内可热重载）。`llm.toml` 缺失时，服务器使用内置的 DeepSeek `story` 用途和 `deepseek-v4-flash`。

评估模型使用 `output = ["evaluation"]`、`tag = "evaluation"` 和 `gateway.evaluate()`。TypeSafe、OpenRouter 和 Vercel 的评估模型使用各自的原生协议，配置与能力边界见 [模型评估](evaluation.md)。

## 配置分层与前端对应

模型能力类型与用途名称分开：`evaluation` 是模型能力，`intent`、`risk-check`、`npc-choice` 是可自定义的用途。多个用途可以选择同一个评估模型；`evaluation` 只是 `gateway.evaluate()` 省略用途时使用的约定名称。供应商、模型 ID 或用途名称不决定协议。

| 层次           | 前端位置           | 持久化与生效范围                                                          |
| -------------- | ------------------ | ------------------------------------------------------------------------- |
| 连接与模型     | 服务商与模型       | TOML 提供基础模型；`llm.providers` 保存本地连接及模型，模型可覆盖连接协议 |
| 用途与模型绑定 | 用途分配           | `[covel.<name>]` 定义基础用途；`llm.slotConfig` 的本地选择优先            |
| 用途参数与能力 | 生成参数、编辑能力 | `llm.paramOverrides` / `llm.capabilityOverrides` 随请求覆盖               |
| 任务选择用途   | 会话模型分配       | `runtimeModelOverrides` 只保存任务到用途的映射                            |

桌面设置保存在 `settings.json`，网页设置保存在当前浏览器；它们不回写 TOML。重新加载 TOML 保留本地绑定及参数，重置用途绑定后恢复文件中的模型。参数与能力仍有各自的重置入口。

服务商页面按连接 ID 归组模型，API Key 和价格倍率共享。TOML 模型保留各自文件中的地址与协议，本地模型使用本地连接地址及模型协议覆盖；修改本地连接不会修改同组的 TOML 模型。模型行和用途卡片显示生效地址、协议及配置来源。

用途选择器按所需输出能力过滤模型，同一 OpenRouter / Vercel 连接中的聊天与评估模型不会混选。已保存的无效绑定显示错误并从会话可用用途中排除，不静默改绑。服务端也校验显式绑定；内置文本用途不能绑定评估模型。自定义用途从 TOML 的 tag 或所选模型输出推导能力，不要求使用固定名称。

生成参数页按实际模型能力展示参数。评估等非文本输出模型不显示温度、输出 token 和思考参数，仍可重置此前保存的参数覆盖。

### 实际选择优先级

运行时显式选择（包括会话 `runtimeModelOverrides`）先决定要使用的用途或预设。未显式选择时，当前请求的 UI 用途绑定优先于插件 `llm.toml` 的角色偏好，再使用系统 `llm.toml` 默认及可用文本用途回退。插件偏好保留完整 provider、model、baseUrl 和 protocol，不把裸 model ID 当作系统用途。文件重载不丢失插件目标。

未定义的 `fast` / `memory` 等文本角色回退到现有用途时，该用途也读取当前请求的 UI 绑定、参数和能力。准备页的任务映射必须保存成功，并同步到服务端临时镜像后，才发布可运行会话；保存失败保留选择并走启动回滚，不使用默认值继续启动。

价格覆盖和服务商倍率仅用于调试成本估算，不随模型请求发送。手动价格只在 trace 的实际 provider/model 能唯一对应当前配置时应用；冲突目标沿用资料库估算。它们不会改变服务商实际收费。

集成 `createModelResolver` 和 `createGatewayAdapter` 时必须共享同一个 `Map<string, PluginLlmModelTarget>`；服务端 bootstrap 通过 `pluginModelTargets` 接收它，请求 adapter 同样使用该 map。内部引用只用于保留完整插件目标，不作为客户端模型 ID；`isRoleSelected` 用于识别当前请求的显式用途绑定。

### 备用策略归属用途

`fallback` 属于 TOML 用途。前端为 `utility` 换模型后，原来的 `utility -> story` 备用关系仍然生效，`story` 也使用本次请求选择的模型。不会借用新选模型所属其它用途的备用关系。重复目标去重，基础备用链的循环防护保持有效；`allowFallback: false` 仍只调用主目标。此规则适用于原本支持备用链的文本、结构化输出、流式输出和评估调用，不为图片、语音、embedding 新增重试机制。

## Slot 字段（`[covel.<slot>]`）

Schema：`packages/ai-provider/src/config/llm-schema.ts`。

| 字段                                | 必填 | 说明                                                                                                                                                                          |
| ----------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `provider`                          | ✅   | 服务商标识，对应 `.env.llm` / `keys.env` 里的 `{PROVIDER}_API_KEY`                                                                                                            |
| `model`                             | ✅   | 原样传给服务商 API 的模型 ID                                                                                                                                                  |
| `baseUrl`                           | ✅   | API 端点（受 SSRF 守卫约束：远端必须 https，loopback 允许 http）                                                                                                              |
| `protocol`                          | ✅   | `openai-chat-v1` / `openai-responses-v1` / `anthropic-messages-v1` / `google-generative-ai-v1` / `typesafe-systemone-v1` / `openrouter-decisions-v1` / `vercel-evaluation-v4` |
| `tag`                               | —    | 能力标签：`text` / `image` / `embedding` / `speech` / `transcription` / `music` / `evaluation`。缺省从 output 模态推断（`audio` 推断为 `speech`，音乐用途须显式写 `music`）   |
| `fallback`                          | —    | 失败时回落的 slot 名                                                                                                                                                          |
| `input` / `output`                  | —    | 模态覆盖（缺省自动检测，见下）。`output` 支持 `text` / `image` / `audio` / `video` / `embedding` / `evaluation`                                                               |
| `features`                          | —    | 特性旗标（`function_calling`、`reasoning`、`vision`…）                                                                                                                        |
| `contextWindow` / `maxOutputTokens` | —    | token 上限覆盖                                                                                                                                                                |
| `pricing`                           | —    | 计价信息（用于 /debug 成本面板）                                                                                                                                              |
| `reasoningEffort`                   | —    | 可移植的思考档位（如 `disabled` 关闭思考），作为模型默认按目标协议转换，见[思考强度](#思考强度)                                                                               |
| `embeddingFormat`                   | —    | embed slot 的请求体形态：`openai`（默认）/ `nemotron-multimodal`                                                                                                              |
| `providerRequestMetadata`           | —    | 生成请求的自由 KV（per-call 优先）；评估请求不使用。媒体 wire 路由键也放这里，见下                                                                                            |
| `providerOptions`                   | —    | 文本 / 对象 / 流式调用的供应商或协议命名空间参数，只解析当前目标的设置，见下                                                                                                  |

## Slot 解析链

1. **请求绑定** — `X-Slot-Config.slotBindings` 优先，区分本地 `modelRef` 与服务端 `presetId`；本地模型必须随请求声明。密钥经 `X-Provider-Keys` 提供，不写入插件或世界包。
2. **具名命中** — 按 preset ID 或具名 slot 解析。图片调用要求精确命中且目标具有 image 输出能力；拼错名称、缺配置或选到文本模型均返回 `CONFIG_ERROR`，不调用服务商。
3. **省略名称** — `generateImage` 与 `resolveSlot({ fallbackTag: "image" })` 都使用 `image`。不会自动挑选其它图像用途，也不会使用默认文本模型。语音与转写保留各自 `speech` / `transcription` 默认名及原有同 tag 解析。
4. **非图片同 tag 回退** — 文本等既有调用具名未命中时可回落到同 tag slot；不跨 tag 回退。图片用途不适用此规则。
5. **任务选择用途** — Agent 的 `runtimeModelOverrides` 优先于 `manifest.model`；function 图片任务由插件的 `modelPresetId` 设置选择用途。两者最终使用同一请求级模型绑定。

场景补图、社区插画插件、世界素材与协议的关系见 [图像生成](image-generation.md)。

模型能力（模态 / 特性 / 上限 / 计价）自动检测优先级：请求级 operational 覆盖 → `llm.toml` 手动字段 → 内置模型资料 → 版本化 LiteLLM 快照 → 协议默认。请求覆盖经 `X-Slot-Config.capabilityOverrides` 下发，只包含 input/output/features/contextWindow/maxOutputTokens；价格覆盖仅供客户端显示，绝不进入服务端信任边界。`self` 部署允许本机用户扩张能力；`demo` / `commercial` 只接受基础能力的非空子集，并对 token 上限取服务端值与请求值的较小者。每次请求只克隆 effective target，不修改全局 registry。每次 agent 调用在 `PreLLMCall` 之后通过 `LLMAdapter.resolveBudget(slot)` 读取实际用途的 `contextWindow`、`maxOutputTokens` 和用户请求的 `requestedMaxOutputTokens`，再预留输出并裁剪输入；上下文组装和 `PostContextAssembly` 不再提前按其他模型的窗口裁剪历史。story / plugin 各自使用实际目标的窗口，compactor 使用 `fast` 的当前配置；请求覆盖与 `llm.toml` 热更新都通过同一 adapter 解析。`createTurnContextBudget` 仅提供未知模型的 262,144（256K）窗口回退值；显式 `COVEL_COMPACTOR_CONTEXT_WINDOW` 通过 `BudgetOptions.contextWindowLimit` 保留为部署上限，不能扩大模型自身能力。

输出额度由共享的 `resolveLlmTokenLimits` 计算：默认 16,384，按模型输出能力收窄；小上下文的自动默认值最多使用窗口的一半，为输入保留空间。用户显式额度可高于或低于默认值，并在校验前读取；有效输出不能占满上下文，最终输入与输出无法同时容纳时明确失败。gateway 对每次实际目标（包括备用模型）重新限制输出额度，agent 与函数插件的 text / object / stream 调用均沿用这条路径；Anthropic 未知输出能力也默认 16k，不再回退 1024 或把资料库最大能力当默认请求量。HTTP 429 限流允许切换已配置的备用模型，其他 4xx 保留原失败路径；流式内容一旦输出，仍禁止切换，避免混入两个模型的结果。

仓库快照由维护者通过 `pnpm --filter @covel/ai-provider update-model-db` 从固定 commit 生成；设置页的手动刷新会把较新数据写入用户配置目录，并在后续启动时优先于内置快照加载。

模型资料与当前适配器可执行的能力分开处理。内置 Chat、Responses、Anthropic 和 Gemini 原生文本适配器的输入只支持 text/image，输出只支持 text，不声明 `web_search` 或 `computer_use`。能力覆盖合并后仍受这层限制，不能通过手动勾选启用尚未实现的协议功能。`GET /api/model-db/lookup` 保留原始 `capability`；传入 `role` 与 `protocol` 后另返回 `effectiveCapability`，并在能解析连接时返回 `usesBuiltinAdapter`。设置页、`resolveSlot` 和实际文本调用上下文使用同一投影。程序化注册的自定义 adapter 与独立图片、语音、转写、embedding wire 保留自身能力。未知模型仍标注协议推断来源，不把协议默认值当作已核实的模型事实。

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

记忆由 `memory` 插件的 post-turn function runtime 提取。它消费冻结的 `turn-digest@1`，作为 `completion.mode: detached` 作业执行；`settle: before-next-execution` 使下一次执行在获取新快照前等待已入队作业，最长等待由 `maxSettleWaitMs` 控制。作业通过当前请求的 gateway 使用 `memory` 用途和 `reasoningEffort: disabled` 默认值；请求上下文中的模型绑定、参数覆盖和授权仍经普通 gateway 解析。模型调用失败不回滚已提交剧情，失败或取消的提取不提交部分记忆。

成功的提取写入 `memory` 插件自己的 `blocks` namespace，面板直接读取该数据；提示词由其 `prompt.segment@1` 扩展注入。没有独立的框架记忆服务、`memory-panel` capability 或 `_memory/update` 镜像。`memory` 用途仍可在模型配置中显式绑定；具体解析与回退遵循本页通用 slot 规则。

## 请求中的模型身份

设备设置与 `X-Slot-Config.slotBindings` 共用显式联合合同：每个用途只接受
`{ "modelRef": "local-reference" }` 或 `{ "presetId": "server-preset" }`。
本地引用必须由本次 `customPresets` 声明；同名服务端预设不能补足缺失的本地引用。
错误的绑定形状、重复模型引用、缺失定义和非法路由头在执行前返回
`400 invalid_llm_configuration`，不会忽略配置后调用其他模型。

临时注册按本次配置隔离；公共模型目录与默认 text/embedding 选择只读取持久配置，
请求不能通过内部 scoped ID 访问另一个请求的模型。显式本地与服务端选择同名时，
模型标签、能力、参数编辑和连接测试均按选择类型解析。

`POST /api/ai/ping` 接受互斥的 `modelRef`、`presetId` 或 `slot`。
本地模型测试会附带其本次定义；用途测试保留用途名及其参数。
显式模型不存在时返回失败，不测试其它模型。省略目标或指定未配置用途仍允许服务端
用途回退，并在 `testedTarget.resolvedVia` 中标明实际来源。
选定目标后，Ping 固定本次模型绑定并保留原用途的参数和能力覆盖，同名预设不会再次
改变路由。选中模型失败时直接返回失败，不执行配置中的备用模型。无效 JSON、未知
请求字段及同时指定多个目标返回 400；合法 `{}` 仍表示默认用途测试。

底层 Gateway 的 `generateText`、`generateObject` 和 `streamText` 接受
`GatewayOptions.allowFallback`，默认 `true`，保留普通生成的备用模型链。
设为 `false` 时只解析并调用主目标，缺失的显式目标仍报错；此选项不改变具名用途的
同 tag 解析规则。Ping 在固定实际绑定后使用 `allowFallback: false`。

## 服务商与模型 ID

设置界面将连接信息和模型 ID 分开保存：一个服务商配置一组 `baseUrl`、协议、API 密钥和价格倍率，并可包含多个模型 ID。用途绑定只引用其中一个模型。请求时前端把该引用编译为兼容服务器的自定义 preset；preset 是内部传输结构，用户无需单独创建。

持久化层只保存 `llm.providers`，其中每个模型条目可携带 `reasoningEffort` 默认值。添加服务商、批量添加模型和编辑现有模型时均可逐模型设置；导入/导出保留该字段。不迁移、双写或读取旧模型配置。`X-Slot-Config.customPresets` 是当前请求从 providers 投影的临时模型定义。模型默认值参与请求 overlay 的完整身份，避免同一模型引用在不同请求中使用不同设置时串用配置。

模型条目的 `ref` 是配置身份，`modelId` 只是发送给服务商的原始 API 模型 ID。同一连接允许保存多个相同 `modelId` 的配置，分别设置名称和思考档位，例如“快速工具 / 关闭思考”和“详细叙事 / 开启思考”。添加时仅复用模型 ID、名称和思考设置均相同的条目；复制配置生成独立 `ref`，编辑名称或思考设置不改变引用。导入要求规范化后的 `ref` 在全部连接中唯一，重复引用整批拒绝；不按 API 模型 ID 合并。

服务商与模型页面支持复制配置、编辑名称、自动保存思考设置；用途分配、插件绑定和会话摘要显示配置名及思考设置。主叙事、代理插件、函数插件和记忆任务通过同一请求配置链路继承所选模型默认值，无需逐用途重复设置。显式用途覆盖仍优先于模型默认。当前 `automatic` 档位用于 Qwen，界面显示“开启思考”，发送 `enable_thinking: true`，并非按任务自动选择开关。

首次手动创建服务商与模型时，若 `story` / `plugin` 尚未显式分配，设置页会把这两个用途同时绑定到该模型，保证叙事与插件任务都能立即运行。DeepSeek、OpenAI、Anthropic、Google、DashScope 即使首次配置未填写 `baseUrl`，也会使用框架内置的官方端点与协议；用户填写的地址始终优先。`google` 缺省使用 `google-generative-ai-v1` 和 `https://generativelanguage.googleapis.com/v1beta`，密钥名为 `GOOGLE_API_KEY`。设置页的协议选择显示为“Google Gemini”。若使用 Google 的 OpenAI 兼容端点，需显式选择 `openai-chat-v1` 并设地址为 `https://generativelanguage.googleapis.com/v1beta/openai`。

模型 ID 是不透明字符串，发送请求时不会被裁剪或改写。例如服务商 `openai` 下的 `openai/gpt-5.6-sol` 和 `deepseek/deepseek-v4-flash` 会保持原样。能力查询按以下候选顺序匹配，匹配结果只用于显示能力和价格：

1. 完整 ID；
2. 去掉与当前服务商相同的最外层路由前缀；
3. 最后一个 `/` 后的模型名；
4. 带版本后缀模型的最长已知前缀；
5. 接口协议的保守默认能力。

通过聚合服务商匹配到上游模型资料时，价格标记为“参考价”，实际费用以当前服务商账单为准。每个服务商的价格倍率默认是 `1`，接受 `0.1`、`2.5` 等正小数；调试成本面板按“模型参考价 × 服务商倍率”计算预估结算价。未精确识别的模型不会被猜成支持图片输入；用户可在“用途分配”中手动覆盖能力。

## 思考强度

“生成参数”页面按原始模型 ID 的上游命名空间识别思考档位。例如服务商为 `openai`、模型 ID 为 `deepseek/deepseek-v4-flash` 时仍使用 DeepSeek 的 `关闭 / high / max` 档位。选项由模型能力决定，不把各厂商的强度假定为等价。

TOML 槽位用 `reasoningEffort` 设置模型默认，取值与界面和 runtime 的 `llm.reasoningEffort` 相同，类似 AI SDK 顶层的 [`reasoning`](https://ai-sdk.dev/docs/ai-sdk-core/reasoning) 选项：只写一个可移植档位，由适配器翻译成各家的原生字段，模型不支持的档位记录 warning 并沿用服务商默认。它与在“服务商与模型”页面为模型设置的思考档位是同一份默认值。需要原生字段时改用下文的 `providerOptions`。

```toml
[covel.story]
provider = "qwen"
model    = "qwen3.8-flash"
baseUrl  = "${QWEN_BASE_URL}"
protocol = "openai-chat-v1"
reasoningEffort = "disabled"
```

用户设置的生效顺序为：用途显式覆盖 → 模型 / TOML 默认 → 任务默认 → 服务商默认。用途留空表示继承；模型留空表示按任务决定。显式 `provider-default` 表示让服务商决定，清除继承的思考请求字段并跳过任务默认，不能把它当成未配置。记忆提取的任务默认仍为关闭思考，用户在用途或模型上设置的档位优先。界面分别显示继承值和显式覆盖，不把服务商文档中的默认档位冒充本次任务的实际参数。

`REASONING_EFFORT_VALUES` 与 `ReasoningEffort` 由 `@covel/shared` 定义，前端持久化、请求入口校验和 provider adapter 共用。模型参数只通过白名单字段传输；不会把任意导入 JSON 合并进服务商请求。现有 `disabled` / `automatic` 等值保持兼容，老配置不需要迁移。

统一的 `reasoningEffort` 设置会按接口协议转换：

- OpenAI Chat 和兼容接口：`reasoning_effort`；DeepSeek 同时发送 `thinking.type`，Qwen 开关使用 `enable_thinking`；Qwen3.8 Chat 的原生 `low/medium/xhigh` 使用 `reasoning_effort`，已确认的 Qwen3.5–3.7 Max/Plus/Flash 使用 `thinking_budget` 预算预设（2048/8192/16384），界面明确标注 token 数值。预算预设不是服务商原生档位，实际消耗可以少于预算。显式档位会清理继承的预算，避免 Qwen3.8 同时发送两种参数。
- OpenAI Responses：`reasoning: { effort }`。已识别的 GPT-5/o3/o4 模型同时请求 `summary: "auto"`；保留显式摘要设置。`store: false` 时请求加密 reasoning，用于工具续调。
- Anthropic Messages：`output_config: { effort }`；已识别的自适应思考模型选择档位时启用 `thinking.type: "adaptive"`，默认请求可见摘要 `display: "summarized"`；不可关闭思考的模型不显示关闭选项。Claude 请求会移除与思考冲突的采样参数，关闭思考时清理继承的 effort，避免组合产生 400 错误。DeepSeek 的 Anthropic 兼容接口同时发送 `thinking.type`。
- Gemini 原生 `generateContent`：Gemini 3 使用 `generationConfig.thinkingConfig.thinkingLevel`；Gemini 2.5 使用 `thinkingBudget`。3 Pro 仅有 low/high，3.1 Pro 为 low/medium/high，3 Flash、3.5/3.6 Flash 及 3.1/3.5 Flash-Lite 为 minimal/low/medium/high，3.7/3.8 Flash 为 low/medium/high。2.5 Pro 不提供关闭；2.5 Flash/Flash-Lite 的 `none` 转为预算 0。2.5 的 low/medium/high 分别是应用预算预设 1024/8192/24576 token，不是 Google 原生档位。未知 Gemini 型号不推测档位。Google OpenAI 兼容接口仍发送 `reasoning_effort`，其中 `minimal` 在 3.1 Pro 映射为 low、在 2.5 映射为 1024 token；这不代表原生协议支持这些型号的 `minimal` 档位。

当前识别的主流档位包括 OpenAI 的 `none/minimal/low/medium/high/xhigh`（GPT-6 及之后的型号按名称识别，另有 `max`，不记录默认档位）、Anthropic 的 `low/medium/high/xhigh/max`（具体取决于模型）、Gemini 按型号与协议限定的子集、xAI 的 `low/medium/high`、DeepSeek V4 的 `high/max`，以及 Qwen 的关闭/开启、原生档位或预算预设。界面只列出目标模型已知支持的子集；未识别模型沿用服务商默认行为。Gemini 档位依据 [Google thinking 说明](https://ai.google.dev/gemini-api/docs/generate-content/thinking) 和 [OpenAI 兼容映射](https://ai.google.dev/gemini-api/docs/openai)。

## 媒体 wire 路由键（`providerRequestMetadata`）

图像 / TTS / STT 的请求体格式由 **wire** 决定（一个 wire = 一家厂商的请求/响应形态），slot 通过 `providerRequestMetadata` 里的路由键选 wire：

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
# 插件注册的 wire 带 <pluginId>/ 前缀
providerRequestMetadata = { speechWire = "mimo-tts/mimo" }
```

音乐生成（`ctx.music.generate()` / `gateway.composeMusic`）解析名为 `music` 的用途，找不到时只回退到 `tag = "music"` 的其他用途——语音合成的用途同样输出音频，但不会被拿来生成音乐。用途没有写 `musicWire`、或写了未注册的 wire 时，在发出请求前返回 `CONFIG_ERROR`。目前内核和内置插件都没有提供音乐 wire，这个用途要等插件注册后才能使用：

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

- 路由键在进入 wire 前被剥离，不会泄漏到厂商请求体。
- 未注册的 wire id 在生成时抛 `CONFIG_ERROR`（报错信息含修复指引），不会静默回落。
- 插件在 `entry` 模块里用 `covel.registerWires({ image?, speech?, transcription?, music? })` 注册自定义 wire（frontmatter 的 `wires` 字段仍被接受但已弃用）—— 见 [plugin-extensions.md § 模型与新协议](plugin-extensions.md#模型与新协议)；wire 与 MediaStore 的关系见 [media-store.md](./media-store.md#media-wire-registries-image--speech--transcription--music)。

## 供应商参数

`generateText`、`generateObject`、`streamText` 与 TOML preset 接受 `providerOptions`。命名空间键使用实际 provider ID 或协议 ID；单次解析先应用协议命名空间，再应用 provider 命名空间。只校验当前目标的命名空间，备用目标的配置在真正切换时才生效。

```toml
[covel.story.providerOptions.openai]
store = false
reasoningEffort = "high"

[covel.story.providerOptions."openai-responses-v1"]
reasoningSummary = "auto"

[covel.gemini.providerOptions.google.thinkingConfig]
thinkingLevel = "medium"
includeThoughts = true
```

当前类型化字段包括 `reasoningEffort`、`reasoningSummary`、`parallelToolCalls`、`store`、`seed`、`user`、Anthropic `thinking`，以及仅供 Gemini 原生协议使用的 `thinkingConfig` 和 `cachedContent`。`seed` 适用于 Chat 和 Gemini 原生协议，`reasoningSummary` 只用于 Responses。Anthropic 启用 thinking 使用 `{ type: "enabled", budgetTokens: 2048 }`，转换为 wire 的 `budget_tokens`。Gemini `thinkingConfig` 可设置 `thinkingBudget` 或 `thinkingLevel`（二选一）及 `includeThoughts`；选具体值时仍须符合目标型号支持范围。非法已知字段在请求前抛不可重试 `CONFIG_ERROR`；不支持或未知字段被忽略并记录 `diagnostics.warnings`。生成参数也校验有限数值、采样范围和正整数输出额度。

合并顺序是 preset 的自由 metadata → preset 的命名空间设置 → 本次调用的自由 metadata → 本次调用的命名空间设置 → 用途和 runtime 的生成参数限制。`extraBody` 可传尚未类型化的原生字段；model、messages、tools、stream、响应格式、输出预算，以及 Gemini 的 `contents`、`systemInstruction`、`generationConfig` 等框架字段受保护，不能借此覆盖，省略时产生 warning。

自由格式的 `providerRequestMetadata` 仍可使用。本次调用中的原生字段只随最初的 provider、协议和端点发送；fallback 改变其中任意一个时会省略这些字段并记录 warning。可移植的 `parameterOverrides` 仍保留，每个备用 preset 自己的配置仍然生效。需要跨供应商设置时应使用各自的 `providerOptions` 命名空间。媒体 wire 路由和插件的 `resolveSlot().metadata` 契约不变。

此接口参考 [AI SDK 的 provider options](https://ai-sdk.dev/docs/foundations/provider-options) 与其命名空间校验方式，保留 Covel 的用途绑定和协议适配器。

## 结构化输出

`gateway.generateObject({ schema, messages })` 在发送请求前，将 Zod schema 的输入形态转换为 JSON Schema。Responses 将完整的 `name` / `schema` 放入 `text.format`；OpenAI Chat 使用兼容的 `json_object` 模式，并在系统消息中传递 schema；Anthropic 在系统消息中传递 schema 和 JSON 输出指令；Gemini 原生协议发送 `generationConfig.responseMimeType: "application/json"` 和 `responseJsonSchema`。Chat / Anthropic 的指令不保证模型一定遵守 schema，所有协议仍在返回后通过原始 Zod schema 的 `safeParse` 校验，应用默认值和转换。自定义 refinement 也在这一步校验。

无法转换为 JSON Schema 的输入类型会在网络请求前返回不可重试的 `CONFIG_ERROR`。模型返回非 JSON 或不符合 Zod schema 的对象则返回 `SCHEMA_VALIDATION_FAILED`。schema 指令保留已有 Anthropic 缓存分段，并避免重复插入 runtime 已提供的同一 schema。

`gateway.generateText` 与 `gateway.streamText` 均接受 `responseFormat`，并将它传给每次实际调用的适配器，包括备用模型。流式输出仍是文本增量；`responseFormat` 不提供增量对象解析，也不替代调用方对完整结果的校验。

## Provider 流式响应

所有 agent runtime 在 adapter 提供流式接口时都使用它；只有故事 runtime 将文本增量转发到玩家界面。因此流在已有输出之后中断时，只有故事 runtime 不重试；其他 runtime 丢弃半截输出，按 `maxRetries` 重试。`length` / `max_tokens` 截断结果不能作为成功结果提交：调用重试一次，再次截断才以"调大输出额度"的错误失败，也不再改用非流式调用重来。流在没有任何输出时失败且重试用尽，会改用一次非流式调用；provider 明确拒绝请求本身时（401、400、配置或 schema 错误）不改用，因为同一请求会原样失败。HTTP 200 内的 provider 错误保留消息、code/type，确定性拒绝不会变成空的可重试错误。

备用模型在调用前重新检查实际消息、工具、结构化输出 schema 和输出预留所需的窗口。装不下的目标不会收到该请求。能力解析优先选择模型数据库的精确匹配，再考虑精选表的前缀匹配，避免把语音子型号识别为文本模型。

runtime 默认关闭思考时，已知型号使用支持的关闭值，否则使用其最低档并记诊断；未知兼容型号不自动发送思考字段。用户显式参数仍优先。较新的 OpenAI reasoning/ GPT 型号使用 `max_completion_tokens`；不接受强制工具或关闭思考的 Anthropic 型号按其能力收窄请求。

内置图片和语音生成提交不做 HTTP 层自动重发；超时或连接断开时，客户端不能据此判断上游是否已生成。文本调用的重试策略不受此规则改变。

四种内置文本协议共用的 SSE 帧解析器支持 LF、CRLF、CR 换行（包括跨网络分片的 CRLF）、`data:` 后可选的空格和同一事件内多个 `data` 行；多行内容以换行连接后解析 JSON。事件必须以空行结束，流结束时丢弃未完成事件。收到 `[DONE]` 或调用方提前结束消费时，解析器取消剩余响应体并释放 reader，避免后台连接继续占用资源。格式规则见 [WHATWG SSE 规范](https://html.spec.whatwg.org/multipage/server-sent-events.html#event-stream-interpretation)。Gemini 原生协议使用 `streamGenerateContent` 的响应格式，不能用 `[DONE]` 判定其终态。

Chat、Responses、Anthropic 的文本流必须包含各自协议终态：Chat 的非空 `finish_reason`、Responses 的 `response.completed` / `response.incomplete`、Anthropic 的 `message_stop`。仅 EOF 或 `[DONE]` 不代表这些协议的模型成功。流内错误、`response.failed` 与缺失终态抛出 provider error；已收到部分文本、思考或工具调用后，runtime 不会保存为成功，也不会重试后拼接结果。无输出的瞬态错误仍可按既有策略重试或切换备用模型。Gemini 原生流依据 `streamGenerateContent` 的候选结束原因判定完成，不依赖 OpenAI 的 `[DONE]` 标记。

`generateText`、`generateObject` 的返回值和 stream 的 `done` 里，`finishReason` 是统一后的结束原因，取值与协议无关：`stop`（正常结束）、`length`（被输出或上下文上限截断）、`tool_calls`（请求调用工具）、`content_filter`（服务商拦截或拒答）、`error`、`other`。服务商自己的用词（如 Anthropic 的 `end_turn` / `max_tokens` / `tool_use`）保留在 `rawFinishReason`。对照表只有一份，在 `@covel/shared` 的 `unifyFinishReason`，网关在出口处应用，runtime 和世界生成读同一张表；做法与 AI SDK 的 `unified` / `raw` 相同。插件通过 `ctx.gateway` 拿到的也是统一后的值。

四种内置文本协议的 text/object 返回值和 stream 的 `done` 可携带 `diagnostics`，包含供应商及请求 warning、URL/文档来源和引用位置；runtime bridge 和 LLM trace 保留这些信息。`citations.location` 区分回答文本位置与来源文本位置，不能把 Anthropic 文档页码或原文字符偏移当作回答偏移。来源只记录已收到的协议数据，不代表已支持主动调用 web search 或文件工具。

function 插件的 `PluginRuntimeGateway` 同样透传 `providerOptions` 与完整返回诊断。该路径的 `gateway.responded` / `gateway.failed` trace 保持原有隐私约定，只记录 `diagnosticsSummary` 中的 warning 类型、来源/引用数量及拒绝原因，不记录引用原文、来源 URL、标题或拒绝全文。

显式 refusal 或 content filter 抛出不可重试的 `REFUSAL`，在 `error.details.diagnostics.refusal` 保留拒绝原因；不切换备用模型。即使已有普通文本或工具内容，也不能把混合拒绝记成成功。流式文本可能已经交付，但不会产生成功 `done`；内置文本适配器的完整工具调用都等最终拒绝检查通过后才交付。协议回归使用 `packages/ai-provider/tests/protocol-fixtures/` 中的合成响应，覆盖字节分片、工具参数、未知扩展、拒绝和引用，避免依赖付费 API 或保存真实对话。

嵌入调用可传 `expectedModelId`（`provider/model`）及 `expectedConfiguration`；Gateway 在网络请求前校验模型、地址、协议和编码格式。服务端会话锁定的身份为 `provider/model#hash`，hash 覆盖有效地址、协议和 embedding 格式，不包含密钥。维度缓存也按此身份隔离。请求级模型与密钥同样作用于 embedding，包括该请求发起的异步摄入；不会写入会话或共享凭证配置。本次身份合同变更后，旧开发期向量会话及索引需要重建，不自动迁移。Memory 的 `EmbedFn(texts, { sessionId, modelId })` 必须使用会话锁定的模型身份。修改当前配置不能把同维度的另一个模型写入旧索引；不匹配时查询降级为关键词检索，摄入不推进进度。恢复原模型配置后可继续补录；需要切换模型时重建开发期会话及索引，已混入错误向量的数据也需重建。

## API Key 流转

Key 永远不进 `llm.toml`：dev 放 `.env.llm`，桌面端放 `~/.covel/keys.env`（mode 600），纯 web 放 localStorage（`covel:keys`）。每次 AI 请求经 `X-Provider-Keys` header（base64 JSON `{provider: key}`）到达服务端，按目标 slot 的 `provider` 名分发绑定 —— wire 拿到的 `config.apiKey` 已是该 slot provider 的 key，客户端 key 覆盖 env key。

服务端环境密钥和程序化注册的默认凭据均绑定可信 origin。请求级覆盖将地址改为其它 origin 时，移除默认 `apiKey` 和 headers，并禁止注入环境密钥；调用方明确提供的请求密钥仍可用于该地址。同源路径调整保留默认凭据，请求解析不会修改注册配置。

## 音频请求

内置 `openai-speech` wire 将 `SpeechSynthesisParams.format` 映射为服务商请求的 `response_format`。内置 `openai-transcription` wire 只上传 `audio.data` 视图中的字节，支持 `Uint8Array` 和 Node `Buffer` 切片，不包含底层共享 buffer 的其它内容。OpenAI 图片、语音与转写 wire 均剥离文本生成专用的 `parameterOverrides`，保留各自原生媒体参数。

## HTTP retry cleanup

Provider and plugin HTTP helpers cancel rejected response bodies before retrying instead of buffering the entire error stream. Redirect responses are also cancelled when rejected. `Retry-After` waits remain abortable; long finite delays are split into timer-safe intervals, and non-finite delays fail explicitly instead of overflowing into immediate retries.

`Retry-After` 同时接受整数秒和 HTTP-date；过去的日期立即重试，无效值退回退避策略。文本 / 对象 / 流式 / 评估的 gateway 调用默认共享最多 8 次实际 HTTP 请求和 120 秒总时限。runtime 的一次逻辑调用只创建一次预算，HTTP 重试、备用目标和 runtime 重试传递同一个 `requestBudget`；runtime 执行预算继续按原策略计算，并发排队保留原有的额度补偿；每次实际调用同时受执行预算、逻辑总时限和取消信号约束。排队和退避也计入逻辑总时间，已经输出内容的流仍禁止重试。耗尽返回不可重试的 `REQUEST_BUDGET_EXCEEDED`。调用方可通过 `createLlmRequestBudget` 显式设置更紧或更宽的策略，并在 `GatewayOptions.requestBudget` / `LLMAdapter` 参数中传递。AI 世界创作（生成、修订、翻译）就是这样做的：回答长、有的模型输出慢，所以它按“无响应时间”限时，每次请求传入 30 分钟的显式预算，不受默认 120 秒限制（见 `docs/reference/api.md` 的 `POST /api/ai/generate-world`）。

媒体和 embedding 不自动套用文本预算，保留独立 wire 的时限及轮询策略；例如 DashScope WAN 仍可每 2 秒轮询、最多 300 秒。它们可以显式传入预算，此时所有 HTTP 请求（含轮询）都计数。底层 HTTP helper 只消耗传入的预算。观测数据在原 `transportAttempt` 之外提供可选 `logicalAttempt` 和 `transportRetryReason`（`http-429` / `http-5xx` / `connection`）。

连接被拒绝或在应答前断开（`ECONNREFUSED` / `ECONNRESET` / `EPIPE` / `UND_ERR_SOCKET`）与 429 / 5xx 一样重试：同一套退避、同一个重试上限（两类合计 3 次）、同一份请求预算。重启中的端点（本地代理最常见）片刻后就恢复，不该让一次 runtime 调用直接失败。超时不在其列，流式调用已经输出内容后也不重试。

默认预算按无输出时间限时。流每产出一段正文、推理、一次工具调用或工具调用参数的一个分片，时限就顺延到此刻之后 120 秒，最晚不超过预算创建后 30 分钟。所以上文的 120 秒约束的是首次输出之前的等待（含重试、退避和排队）以及两次输出之间的静默，不是持续输出的流的总时长；非流式调用没有进度信号，仍受 120 秒总时限约束。显式传入 `timeoutMs` 或 `deadline` 的预算保持固定，`deadline` 是任何输出都不会推后的绝对时限；要让显式预算也按无输出时间计算，另传 `idleTimeoutMs`，并可用 `ceilingMs` 设定顺延的上限。Agent runtime 的一次模型调用以 `max(120 秒, runtime 剩余时间)` 为预算并传入 `agent.loop.idleTimeoutMs`，因此 runtime 声明的重试次数都有时间执行：流式调用在首次输出前受 `firstTokenTimeoutMs` 和 runtime 时限约束，之后只受 `idleTimeoutMs` 约束，输出所用的时间不计入 runtime 的 `timeoutMs`；`callTimeoutMs` 只约束非流式调用。

生命周期 hook 的每个通知阶段合计最多等待 1 秒。普通 hook 异常或超时记录 warning 后继续；请求取消或逻辑 deadline 会立即停止等待，不触发额外重试。预算到期时，gateway 也会停止等待不响应 signal 的自定义 adapter；自定义实现仍应使用 signal 取消其底层 I/O。

请求次数由框架 HTTP helper 在真正发送前计数。自定义 adapter 如果直接使用自己的网络客户端，应在发送前调用 `assertLlmRequestBudget(config.requestBudget, { signal: config.signal, consumeAttempt: true })`（存在预算时）；框架无法自动统计其内部 HTTP 请求。

## 失败后的模型与参数调整

Runtime 的同目标重试优先读取结构化 provider 错误的 `code`、`statusCode` 和 `retriable`，配置与 schema 校验失败不重试，错误消息中的关键词不能覆盖明确的不可重试判断。网关在归一化时保留已知临时网络故障的可重试属性；未知第三方异常才使用消息判断。调用方取消和已有部分流式输出仍禁止重试，备用模型切换保留独立的既有规则。

错误详情保留失败请求实际使用的 `provider` 和 `model`，包含备用模型最终失败的情况；后续修改配置不会改变已记录的失败目标。可在失败任务上打开“更换模型 / 调整参数”，进入模型用途选择服务商和模型，并展开“生成参数”调整上下文窗口、模型最大输出能力、单次输出、温度、采样和思考强度；能力字段也可以通过原“编辑能力”入口覆盖，包括仅在前端配置的模型用途。两处复用同一个 token 编辑组件，并沿用 `llm.capabilityOverrides` / `llm.paramOverrides`，无需迁移旧设置。资料库输出上限仅供参考，不阻止输入符合设置范围的手动参数。

关闭设置后点击“重试此任务”，请求重新读取当前模型和参数；已提交的剧情和其他成功任务仍保留。最大输出限制与输入上下文窗口是两个独立的设置，调低输出不会删除会话历史。

非流式文本与对象生成同样拒绝 provider 错误正文或 `finishReason: error`，即使 HTTP 为 200、正文仍可解析，也不会上报成功或交给函数插件写入记忆。Responses 必须处于 `completed` 或 `incomplete` 终态；排队、处理中、取消、失败或缺失状态均按 provider error 处理。`incomplete` 仍映射为 `length`，保留调用方既有截断策略。无输出的 provider error 可按已配置的备用模型策略回退。

Model pricing may include `cacheReadPerMToken` and `cacheWritePerMToken` (USD per million tokens). The pinned LiteLLM database carries explicit read/write rates, including zero rates. Debug cost estimates price these subsets separately; missing rates remain unpriced rather than using the regular input price.

HTTP error normalization preserves the provider's original `code` and `type` in `details.providerCode` / `details.providerType`. Vector ingestion uses explicit input-rejection codes to bisect a failed batch and skip only the offending input; authentication, configuration, and transient failures keep the cursor unchanged.
