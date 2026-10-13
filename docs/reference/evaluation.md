# 模型评估（Evaluation）

评估模型不写文字。你给它一段状态和几个问题，它回答三种题：从几个选项里选一个、打一个分、判断是或否的概率。这一页讲怎样配置评估模型、怎样用 `gateway.evaluate()` 调用它、返回值是什么形状，以及接入 Covel 时的边界。

它适合写插件或框架代码的开发者。普通游玩不需要评估模型：配置了它，也不会自动给玩法加上评估。

几个要点：

- 一次调用可以针对同一份状态问多个问题，一起返回。
- 它使用现有的服务商、用途、密钥绑定、请求记录和生命周期钩子。
- 内置四种接口：TypeSafe System One、OpenRouter Decisions、Vercel AI Gateway Evaluation 和 OpenAI Decisions。不依赖任何服务商 SDK 或 AI SDK。
- 用哪种接口由配置里的协议决定，不看服务商名称或模型 ID。

`evaluation` 是一种模型能力，不是固定的用途名。你可以定义 `[covel.intent]`、`[covel.risk-check]` 等用途，让它们绑定同一个评估模型，调用时用 `presetId` 选择用途。设置里的文本用途不会列出评估模型，服务端也拒绝不兼容的绑定。

## 配置与调用

### 在设置里添加

打开 **设置 → 模型 → 服务商与模型**，像添加其他模型一样填写服务商、API 地址、API 密钥和模型 ID。

- 服务商的协议是默认值。添加模型时，或者在模型那一行，可以单独给模型选协议。所以同一个连接下可以同时有聊天模型和评估模型。
- 模型自己的协议会随保存、复制、导入导出和请求一起保留。选“使用服务商协议”就去掉这个覆盖，恢复继承。
- 评估模型作为第一个模型添加时，不会自动绑定到剧情或插件的文本用途。

设置页把四种评估接口收在 **Evaluation（评估）** 下面，选中之后显示“评估接口”：

- TypeSafe、OpenRouter、Vercel 和 OpenAI 的内置连接会预先选好各自的接口。
- 自定义连接可以手动选它兼容的接口。代理地址不影响协议的选择。
- 模型已经有明确的协议时，按保存的配置显示。

`Evaluation` 只是界面上的分类。TOML、保存的数据和请求里仍然使用下表的协议 ID。Covel 不会根据模型名称、地址或连接名称去猜协议。这种分层参考了 AI SDK：[EvaluationModelV4](https://github.com/vercel/ai/blob/main/packages/provider/src/evaluation-model/v4/evaluation-model-v4.ts) 统一评估模型的约定，各服务商适配自己的 HTTP 格式。

| Provider 示例 | Base URL                          | 模型 ID 示例        | 评估模型的协议            |
| ------------- | --------------------------------- | ------------------- | ------------------------- |
| `typesafe`    | `https://api.typesafe.ai/v1`      | `jev-latest`        | `typesafe-systemone-v1`   |
| `openrouter`  | `https://openrouter.ai/api/v1`    | `typesafe/jev-1.13` | `openrouter-decisions-v1` |
| `vercel`      | `https://ai-gateway.vercel.sh/v1` | `typesafe-ai/jev`   | `vercel-evaluation-v4`    |
| `openai`      | `https://api.openai.com/v1`       | `gpt-6-luna`        | `openai-decisions-v1`     |

- `openrouter`、`vercel`、`openai` 的内置连接默认使用 OpenAI Chat。给评估模型选 Evaluation 时，会预先选好表里的评估接口，仍然可以手动改。
- 表格只是当前服务商的例子。Provider 名称、Base URL 和模型 ID 都可以自己定。兼容同一种接口的代理或其他模型可以直接使用。

### 各接口的请求地址

适配器只替换下面这些已知的末尾路径，保留主机和自定义的代理前缀。例如 `https://proxy.example/router/api/v1` 对应 `https://proxy.example/router/api/alpha/decisions`。

| 接口       | 请求路径                  | `baseUrl` 可以写成                             |
| ---------- | ------------------------- | ---------------------------------------------- |
| OpenRouter | `/api/alpha/decisions`    | 根地址、`/api/v1`、`/api/alpha` 或评估端点本身 |
| Vercel     | `/v4/ai/evaluation-model` | 根地址、`/v1`、`/v4/ai` 或评估端点本身         |
| TypeSafe   | `/v1/systemone`           | 根地址、`/v1` 或评估端点本身                   |
| OpenAI     | `/v1/decisions`           | 根地址、`/v1` 或评估端点本身                   |

Vercel 用 `ai-model-id` 请求头传模型 ID，并发送它的原生协议版本和 API Key 认证头。它的请求体里 Boolean 类型保持 `boolean`。

### 在 llm.toml 里配置

```toml
[covel.evaluation]
provider = "typesafe"
model = "jev-latest"
baseUrl = "https://api.typesafe.ai/v1"
protocol = "typesafe-systemone-v1"
```

- 写了评估协议，就自动得到 `output = ["evaluation"]`、`supportedModes = ["evaluate"]` 和 `tag = "evaluation"`。
- 内置的 `typesafe` 连接也可以直接在服务商设置页里添加。
- 密钥变量是 `TYPESAFE_API_KEY`、`OPENROUTER_API_KEY`、`VERCEL_API_KEY`，和其他服务商的命名方式一样。Vercel AI Gateway 的密钥填到本项目的 `vercel` 连接里。
- 密钥的位置：开发环境放 `.env.llm`，桌面版放 `keys.env`，浏览器通过服务商设置保存。不要把密钥写进 TOML。

用途字段的完整说明见[模型用途配置](./slots.md)。

### 调用

服务端代码持有已配置的 gateway 时：

```ts
const result = await gateway.evaluate(
  {
    presetId: "evaluation",
    state: { action: "The player asks the guard for directions." },
    questions: {
      intent: {
        type: "choice",
        instructions: "What does the player intend to do?",
        criteria: {
          conversation: "Talk or request information",
          combat: "Attack or threaten",
          other: "None of the listed intents",
        },
      },
      relevant: {
        type: "boolean",
        instructions: "Is this action relevant to finding a location?",
      },
      risk: {
        type: "score",
        instructions: "How likely is the action to escalate conflict?",
        criteria: ["Peaceful", "Tense", "Violent"],
      },
    },
  },
  {
    envApiKeys: providerApiKeysFromEnv(),
    signal: AbortSignal.timeout(10_000),
  },
);

// providerApiKeysFromEnv is exported by @covel/shared.
const intent = result.answers.intent.choice;
const probability = result.answers.relevant.probability;
const risk = result.answers.risk.score;
```

**选哪个模型**

- `presetId` 可以写用途名或预设 ID。不写时解析 `evaluation` 用途，以及 `tag` 相同的用途。
- 失败时按这个用途配置的 `fallback` 链回退。`allowFallback: false` 禁用备用模型。备用模型也必须支持评估。
- 取消会终止当前请求和重试，不再尝试备用模型。
- 没有评估用途时，不会自动借用文本用途。

**密钥、超时和传输**

- `apiKeys` 是这次请求明确提供的密钥，优先于 `envApiKeys`。
- 服务端密钥仍然受可信来源的约束：请求把 base URL 改到另一个来源时，不会带上原服务商的服务端密钥。
- 协议适配器复用现有的 HTTP 传输，包括桌面代理、DNS 防护、拒绝重定向，以及 429 / 5xx 重试。
- 调用方通过 `signal` 设置超时和取消。

## 公共契约

| 问题类型  | 参数                                    | 返回值                                           |
| --------- | --------------------------------------- | ------------------------------------------------ |
| `choice`  | `criteria` 为选项名到描述的映射         | `choice`、可选的各选项 `probabilities`           |
| `score`   | `criteria` 为从 0 开始的有序等级数组    | 可带小数的 `score`、可选的各等级 `probabilities` |
| `boolean` | 可选 `criteria.true` / `criteria.false` | `probability`，表示 P(true)，不自动转成布尔值    |

**输入**

- `state`、`instructions` 和各项描述接受文本、JSON 对象、JSON 数组或 `null`。
- `questions` 不能为空。
- 模型 ID 原样发送。

**返回**

- 结果包含 `provider`、`answers` 和整理过的 `usage.inputTokens / outputTokens`。
- 返回的 `model` 是服务商报告的实际版本；服务商没报告时，使用请求里的 ID。
- Choice 的选项类型从问题里推断出来。

**适配器做的校验**

- Jev 的请求限制在适配器里校验：Choice 为 1–255 个选项，Score 为 2–10 个等级。
- 适配器校验问题和答案是否一一对应、选项集合、概率的范围和总和、评分范围和 token 计数。

**各家的差别**

- TypeSafe / OpenRouter：公共的 `boolean` 在请求里对应 `noul`，回答转换成 `probability`。
- TypeSafe 的概率保留两位小数。校验总和时允许每一项的舍入误差，不重新归一化。
- `providerMetadata.typesafe.confidence` 或 `providerMetadata.openrouter.confidence` 保留服务商自己的置信度统计。它不能当成各家通用的概率。
- Vercel 返回的 `providerMetadata` 会保留。舍入说明和警告存入 `providerMetadata.vercel`。概率总和按它声明的精度校验。
- OpenRouter / Vercel 允许不返回概率分布，所以公共的 `probabilities` 是可选字段。服务商没提供时，Covel 不会自己编一个分布。

### OpenAI Decisions 的转换

OpenAI Decisions（`openai-decisions-v1`，2026-10 公测，当前只有 `gpt-6-luna`）的请求形状和另外三种不同。适配器在边界上转换，公共契约不变：

| 公共契约                         | OpenAI wire                                                                                        |
| -------------------------------- | -------------------------------------------------------------------------------------------------- |
| `state`                          | `input`：文本原样发送，JSON 值序列化成文本                                                         |
| `questions` 是以问题名为键的 map | `questions` 是数组，问题名放在每项的 `name`；应答的 `answers` 也是数组，按 `name` 对回             |
| `boolean`                        | `predicate`；`criteria.true` / `criteria.false` 以“Criteria for true/false”段落并入 `instructions` |
| `choice` 的 `criteria`           | `choices: [{ value, description }]`，要求 2–255 项（只有 1 项时在发送前报配置错误）                |
| `score` 的 `criteria`            | `levels: [{ label, description }]`，`label` 取等级下标                                             |
| `probabilities` map              | `[{ value, probability }]` 数组，转换成 map 后按同一套规则校验                                     |

- 模型拒答某个问题时（`answers` 里有 `refusal`），整次调用以不可重试的 `REFUSAL` 失败，`error.details.question` 是被拒的问题名。公共契约要求每个问题都有答案，不返回部分结果。
- `usage` 带回 `cachedInputTokens` / `cacheWriteInputTokens`。
- 各题的 `confidence` 存入 `providerMetadata.openai.confidence`。
- 请求只发送 `model`、`input`、`questions`。不发送 `safety_identifier`，也不发送图片（公共契约的 `state` 没有图片类型）。

### 请求里有什么、没有什么

- 评估请求只发送 `state / questions` 和模型标识：TypeSafe / OpenRouter 放在请求体的 `model`，Vercel 放在 `ai-model-id` 请求头。
- 不会混入文本生成的 temperature、工具、思考参数，也不会混入用途的自由 metadata。
- `onProviderRequest` 可以记录这些实际发出的字段。记录和普通 LLM 提示词一样可能包含私有内容，但不包含认证头。
- 服务商连接测试对评估模型发送一个最小的 Boolean 问题，返回总耗时。它不伪造流式的首字延迟。

评估模型不支持 `generateText / generateObject / streamText / embed`，错误在发送请求之前抛出。“生成一个任意对象”和“在封闭的答案范围里评估”是两种独立的能力。

## 新供应商接入

**服务商使用已支持的接口**：只需要配置自己的 provider、base URL、模型和对应的协议。

**服务商使用另一种接口**：

1. 实现 `ModelProviderAdapter.evaluate`。
2. 在协议注册表里加入适配器和 `evaluation` 能力的默认值。
3. 更新协议枚举和配置入口。

现有的 provider 注册接口允许替换适配器。gateway 不需要按服务商或插件 ID 分支。服务商特有的数量限制、字段命名和统计信息留在协议边界里。

**在插件里使用**

- function runtime 提供 `ctx.gateway.evaluate({ presetId, state, questions, signal })`。它继承请求配置、取消和 gateway trace。
- 可选的 [Jev 推荐 Demo](https://github.com/covel-ai/covel-plugins/tree/main/examples/jev-choice-demo) 通过插件公共服务调用它，并自带显示概率的 UI。默认玩法不会自动启用它。
- 全新的接口也可以通过[插件服务](./plugin-extensions.md#模型与新协议)封装，不用先扩展框架的标准协议枚举。需要它成为框架的原生协议时，再走上面的适配器入口。

## Covel 接入评估

建议先做“旁路评估”：评估结果不改变游戏状态，只用来收集项目自己的样本。有了样本，再决定阈值和失败时怎么办。

| 场景                     | 适用能力        | 接入边界                                             |
| ------------------------ | --------------- | ---------------------------------------------------- |
| 剧情与世界规则一致性检查 | Boolean / Score | 对生成内容做评估，确定性禁止规则仍由代码执行         |
| 玩家意图分类             | Choice          | 在已定义意图之间分流，保留 `other`，避免替代自由叙事 |
| 记忆候选相关性评分       | Score           | 现有检索后排序；不替代 embedding 或记忆生成          |
| 场景与 NPC 行为候选选择  | Choice / Score  | 对代码已枚举的候选评分，状态写入仍由插件负责         |

> [!IMPORTANT]
> Covel 的主要内容是中文，而官方说明 Jev 目前英语准确率最好。先在中文样本上测量错误率、概率阈值、端到端延迟和失败率，再判断它值不值得进入主流程。不要把服务商宣传的性能数字当成本项目的实测结果。

- 按校准的结果固定模型版本，并记录回答里的实际版本。`jev-latest` 会随着发布移动。
- 截至 2026-09-19，官方文档列出：`jev-1.13.0`；总请求上限 64k token；state 加最长的问题上限 32k；输入 $0.042 / 百万 token，输出免费。价格和别名可能变化。
- 模型目录里记录的是总请求上限。第二个限制没有本地的 tokenizer 可以估算，由服务端校验。
- `maxOutputTokens = 0` 表示不提供文本生成的预算，不表示请求的 output token 用量一定为零。

> [!NOTE]
> 还没有用真实的密钥验证过线上延迟、中文表现或费用。OpenAI Decisions 同样只按官方参考文档和模拟回答实现，没有用真实密钥调用过。

参考资料：

- [OpenAI Decisions 指南](https://developers.openai.com/api/docs/guides/decisions)、[OpenAI Decisions 接口参考](https://developers.openai.com/api/reference/resources/decisions/methods/create)、[AI SDK 的 OpenAI Decisions 适配器](https://github.com/vercel/ai/blob/main/packages/openai/src/openai-decision-model.ts)
- [OpenRouter Decisions](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-questions-and-answers-request)
- [Vercel 原生评估 wire](https://github.com/vercel/ai/blob/main/packages/gateway/src/gateway-evaluation-model.ts)、[Vercel 模型目录](https://ai-gateway.vercel.sh/v1/models)
- [TypeSafe API](https://docs.typesafe.ai/api)、[模型限制](https://docs.typesafe.ai/models)、[AI SDK 的评估适配器](https://github.com/vercel/ai/blob/main/packages/typesafe-ai/src/typesafe-ai-evaluation-model.ts)
- [用户提供的用例合集](https://github.com/Anil-matcha/awesome-jev-by-typesafe)
