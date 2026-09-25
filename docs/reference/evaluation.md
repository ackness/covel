# 模型评估（Evaluation）

Covel 的 provider 层提供 `gateway.evaluate()`：针对同一份状态，批量返回分类、评分和布尔概率。它使用现有 provider、preset、slot、密钥绑定、请求记录与生命周期钩子。原生支持 TypeSafe System One、OpenRouter Decisions 和 Vercel AI Gateway Evaluation，不依赖任何供应商 SDK 或 AI SDK。协议由配置选择，不通过服务商名称或模型 ID 判断。

`evaluation` 表示模型能力类型，不限定用途名称。可定义 `[covel.intent]`、`[covel.risk-check]` 等用途并绑定同一个评估模型；调用时通过 `presetId` 选择用途。设置中的文本用途会过滤评估模型，服务端也拒绝不兼容的显式绑定。

## 配置与调用

设置 → 服务商与模型：像其他模型一样填写 Provider、Base URL、API Key 和模型 ID。Provider 的协议作为默认值；添加模型时或模型行内可单独选择协议，同一连接可同时包含聊天模型与评估模型。模型级协议覆盖会随保存、复制、导入导出和请求 overlay 保留。删除覆盖（选择“使用服务商协议”）后恢复继承。评估模型作为首个模型添加时，不自动绑定剧情或插件文本用途。

设置页将三种评估接口统一收在 **Evaluation（评估）** 下，选中后显示“评估接口”。TypeSafe、OpenRouter 和 Vercel 内置连接预选各自的接口；自定义连接可手动选择所兼容的接口，代理地址不影响协议选择。模型已有明确协议时按已保存配置显示，选择“使用服务商协议”则继续继承连接配置。

这遵循 AI SDK 的分层方式：[EvaluationModelV4](https://github.com/vercel/ai/blob/main/packages/provider/src/evaluation-model/v4/evaluation-model-v4.ts) 统一评估模型契约，各服务商适配自己的 HTTP 格式。`Evaluation` 是界面分类；TOML、保存数据和请求 overlay 仍使用下表的明确 wire 协议，不新增通过模型名称、地址或连接名称猜测协议的运行时逻辑。

| Provider 示例 | Base URL                          | 模型 ID 示例        | 评估模型的协议            |
| ------------- | --------------------------------- | ------------------- | ------------------------- |
| `typesafe`    | `https://api.typesafe.ai/v1`      | `jev-latest`        | `typesafe-systemone-v1`   |
| `openrouter`  | `https://openrouter.ai/api/v1`    | `typesafe/jev-1.13` | `openrouter-decisions-v1` |
| `vercel`      | `https://ai-gateway.vercel.sh/v1` | `typesafe-ai/jev`   | `vercel-evaluation-v4`    |

`openrouter`、`vercel` 内置连接默认使用 OpenAI Chat，Jev 模型选择 Evaluation 即预选表中的评估接口，仍可手动调整。表格只是当前服务商示例；Provider 名称、Base URL 和模型 ID 均可自定义，兼容相同 wire 的代理或其他模型可以直接使用。

OpenRouter 请求路径为 `/api/alpha/decisions`，接受根地址、`/api/v1`、`/api/alpha` 或评估端点本身作为 base。Vercel 请求路径为 `/v4/ai/evaluation-model`，接受根地址、`/v1`、`/v4/ai` 或评估端点本身作为 base；TypeSafe 同理接受 `/v1/systemone`。适配器仅替换这些已知末尾路径，保留主机和自定义代理前缀，例如 `https://proxy.example/router/api/v1` 对应 `https://proxy.example/router/api/alpha/decisions`。Vercel 用 `ai-model-id` header 传模型 ID，并发送其原生协议版本和 API Key 认证头；其请求 body 中 Boolean 类型保持 `boolean`。

服务端 TOML 示例：

```toml
[covel.evaluation]
provider = "typesafe"
model = "jev-latest"
baseUrl = "https://api.typesafe.ai/v1"
protocol = "typesafe-systemone-v1"
```

协议默认推导 `output = ["evaluation"]`、`supportedModes = ["evaluate"]` 和 `tag = "evaluation"`。内置 `typesafe` 连接也可直接通过服务商设置页添加。`TYPESAFE_API_KEY`、`OPENROUTER_API_KEY`、`VERCEL_API_KEY` 遵循现有 provider 密钥命名（Vercel AI Gateway 的 key 填到本项目的 `vercel` 连接）：开发环境放 `.env.llm`，桌面端放 `keys.env`，浏览器通过服务商设置保存。不要把 key 写进 TOML。

服务端持有已配置的 gateway 时：

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

`presetId` 可指定 slot 或 preset，省略时解析 `evaluation` 用途及同 tag 用途。失败时遵循该用途配置的 fallback 链；`allowFallback: false` 禁用备用模型。备用模型也必须支持评估。取消会终止当前请求及重试，不再尝试备用模型。没有评估用途时不会自动借用文本用途。

`apiKeys` 是请求明确提供的 key，优先于 `envApiKeys`。服务端 key 仍受可信 origin 约束：请求覆盖 base URL 为其他 origin 时不会携带原服务商的服务端 key。协议适配器复用现有 HTTP 传输，包括桌面代理、DNS 防护、重定向拒绝和 429 / 5xx 重试。调用方通过 `signal` 设置超时和取消。

## 公共契约

| 问题类型  | 参数                                    | 返回值                                           |
| --------- | --------------------------------------- | ------------------------------------------------ |
| `choice`  | `criteria` 为选项名到描述的映射         | `choice`、可选的各选项 `probabilities`           |
| `score`   | `criteria` 为从 0 开始的有序等级数组    | 可带小数的 `score`、可选的各等级 `probabilities` |
| `boolean` | 可选 `criteria.true` / `criteria.false` | `probability`，表示 P(true)，不自动转成布尔值    |

`state`、`instructions` 和描述接受文本、JSON 对象、JSON 数组或 `null`。问题 map 必须非空。模型 ID 原样发送；返回的 `model` 保留供应商报告的实际版本（未报告时使用请求 ID）。结果包含 `provider`、`answers` 和规范化的 `usage.inputTokens / outputTokens`。Choice 的选项联合类型从问题推断。

当前三个评估协议使用的 Jev 请求限制在适配器内校验：Choice 为 1–255 个选项，Score 为 2–10 个等级。TypeSafe / OpenRouter 的公共 `boolean` 在 wire 上映射为 `noul`，响应转换为 `probability`。适配器校验问题/答案对应关系、选项集合、概率范围及总和、评分范围和 token 计数。TypeSafe 的概率保留两位小数，校验总和时允许逐项舍入误差，不重新归一化。`providerMetadata.typesafe.confidence` 或 `providerMetadata.openrouter.confidence` 保留供应商的独立置信度统计，不能当作跨供应商通用概率。Vercel 返回的 `providerMetadata` 会保留，舍入说明与警告存入 `providerMetadata.vercel`；概率总和按其声明精度校验。OpenRouter / Vercel 允许省略概率分布，公共 `probabilities` 因此为可选字段，未提供时不合成分布。

评估请求只发送 `state / questions` 和模型标识（TypeSafe / OpenRouter 的 body `model`，Vercel 的 `ai-model-id` header），不会混入文本生成的 temperature、工具、思考参数或 slot 的自由 metadata。`onProviderRequest` 可记录这些实际 wire 字段；记录与普通 LLM prompt 一样可能包含私有内容，不包含认证 header。服务商连通测试对评估模型发送最小 Boolean 问题，返回总耗时，不伪造流式 TTFB。

评估模型不支持 `generateText / generateObject / streamText / embed`，错误在发送请求前抛出。通用对象生成与封闭答案空间的评估是两个独立能力。

## 新供应商接入

使用已支持 wire 的供应商只需配置自己的 provider、base URL、模型和对应协议。不同 wire 的供应商实现 `ModelProviderAdapter.evaluate`，在协议注册表加入适配器与 `evaluation` 能力默认值，并更新协议枚举和配置入口。现有 provider 注册接口允许替换适配器；gateway 无须按服务商或插件 ID 分支。供应商特有的数量限制、字段命名及统计信息留在协议边界。

function runtime 已公开 `ctx.gateway.evaluate({ presetId, state, questions, signal })`，继承请求配置、取消和 gateway trace。可选的 [Jev 推荐 Demo](https://github.com/covel-ai/covel-plugins/tree/main/examples/jev-choice-demo) 通过插件公共服务调用它，并自带概率展示 UI；默认玩法不自动启用。全新 wire 也可通过 [插件服务](plugin-extensions.md#模型与新协议) 封装，无须先扩展框架的标准协议枚举；需要作为框架原生协议时再使用上面的适配器入口。

## Covel 接入评估

建议首先以不改变游戏状态的旁路评估收集项目样本，再决定阈值和失败策略：

| 场景                     | 适用能力        | 接入边界                                             |
| ------------------------ | --------------- | ---------------------------------------------------- |
| 剧情与世界规则一致性检查 | Boolean / Score | 对生成内容做评估，确定性禁止规则仍由代码执行         |
| 玩家意图分类             | Choice          | 在已定义意图之间分流，保留 `other`，避免替代自由叙事 |
| 记忆候选相关性评分       | Score           | 现有检索后排序；不替代 embedding 或记忆生成          |
| 场景与 NPC 行为候选选择  | Choice / Score  | 对代码已枚举的候选评分，状态写入仍由插件负责         |

中文是 Covel 的主要工作负载，而官方说明 Jev 当前英语准确率最佳。应测量中文样本上的错误率、概率阈值、端到端延迟和失败率，再判断是否值得进入主流程。不要把供应商宣传的性能数字当作本项目实测结果。按校准结果固定模型版本，记录响应的实际版本；`jev-latest` 会随发布移动。

截至 2026-09-19，官方文档列出 `jev-1.13.0`、64k 总请求 token 上限、state 加最长问题 32k 上限、输入 $0.042 / 百万 token、输出免费。目录记录总请求上限；第二个限制没有本地 tokenizer 估算，由服务端校验。`maxOutputTokens = 0` 表示不提供文本生成预算，并不表示 wire 的 output token 用量恒为零。价格和别名可能变化。尚未用真实 key 验证线上延迟、中文表现或费用。

参考：[OpenRouter Decisions](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-questions-and-answers-request)、[Vercel 原生评估 wire](https://github.com/vercel/ai/blob/main/packages/gateway/src/gateway-evaluation-model.ts)、[Vercel 模型目录](https://ai-gateway.vercel.sh/v1/models)、[TypeSafe API](https://docs.typesafe.ai/api)、[模型限制](https://docs.typesafe.ai/models)、[AI SDK 的评估适配器](https://github.com/vercel/ai/blob/main/packages/typesafe-ai/src/typesafe-ai-evaluation-model.ts)、[用户提供的用例合集](https://github.com/Anil-matcha/awesome-jev-by-typesafe)。
