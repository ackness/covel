# Model evaluation (Evaluation)

An evaluation model does not write text. You give it a state and a few questions, and it answers three kinds of question: pick one option from a list, give a score, or give the probability that something is yes. This page explains how to configure an evaluation model, how to call it with `gateway.evaluate()`, what the return value looks like, and the limits when you connect it to Covel.

It is meant for developers who write plugins or framework code. Normal play does not need an evaluation model. Configuring one does not add evaluation to gameplay automatically.

Key points:

- One call can ask several questions about the same state, and they all come back together.
- It uses the existing providers, roles, key bindings, request records, and lifecycle hooks.
- It has four built-in interfaces: TypeSafe System One, OpenRouter Decisions, Vercel AI Gateway Evaluation, and OpenAI Decisions. It does not depend on any provider SDK or AI SDK.
- The interface used is decided by the protocol in the configuration. It is not decided by the provider name or the model ID.

`evaluation` is a model capability, not a fixed role name. You can define roles such as `[covel.intent]` and `[covel.risk-check]` and bind them to the same evaluation model. When you call it, you pick the role with `presetId`. Text roles in the settings do not list evaluation models, and the server rejects incompatible bindings.

## Setup and calls

### Add it in Settings

Open **Settings → LLM → Providers & Models**. Fill in the provider, API URL, API key, and model ID the same way you would for any other model.

- The provider's protocol is the default. When you add a model, or on the model's row, you can choose a protocol for that model alone. So one connection can have both a chat model and an evaluation model.
- A model's own protocol is kept when you save, copy, import, export, and send requests. Choosing "Use provider protocol" removes this override and goes back to inheriting.
- When you add an evaluation model as the first model, it is not bound automatically to the story or plugin text roles.

The settings page puts the four evaluation interfaces under **Evaluation**. When you select it, the page shows "Evaluation API":

- The built-in TypeSafe, OpenRouter, Vercel, and OpenAI connections pick their own interface in advance.
- A custom connection can choose manually any interface it is compatible with. A proxy address does not change the protocol choice.
- When a model already has a clear protocol, the page shows the saved setting.

`Evaluation` is only a category in the interface. In TOML, in the saved data, and in requests, the protocol IDs in the table below are still used. Covel does not guess the protocol from the model name, the address, or the connection name. This layering follows the AI SDK: [EvaluationModelV4](https://github.com/vercel/ai/blob/main/packages/provider/src/evaluation-model/v4/evaluation-model-v4.ts) defines the shared evaluation model contract, and each provider adapts its own HTTP format.

| Provider example | Base URL                          | Model ID example    | Evaluation model protocol |
| ---------------- | --------------------------------- | ------------------- | ------------------------- |
| `typesafe`       | `https://api.typesafe.ai/v1`      | `jev-latest`        | `typesafe-systemone-v1`   |
| `openrouter`     | `https://openrouter.ai/api/v1`    | `typesafe/jev-1.13` | `openrouter-decisions-v1` |
| `vercel`         | `https://ai-gateway.vercel.sh/v1` | `typesafe-ai/jev`   | `vercel-evaluation-v4`    |
| `openai`         | `https://api.openai.com/v1`       | `gpt-6-luna`        | `openai-decisions-v1`     |

- The built-in `openrouter`, `vercel`, and `openai` connections use OpenAI Chat by default. When you choose Evaluation for an evaluation model, the interface from the table is selected in advance. You can still change it by hand.
- The table is only examples for the providers listed. Provider names, Base URLs, and model IDs can be anything you set. A proxy or another model that is compatible with the same interface can be used directly.

### Request URL for each interface

The adapter only replaces the known trailing paths below. It keeps the host and any custom proxy prefix. For example, `https://proxy.example/router/api/v1` maps to `https://proxy.example/router/api/alpha/decisions`.

| Interface  | Request path              | `baseUrl` can be written as                                                  |
| ---------- | ------------------------- | ---------------------------------------------------------------------------- |
| OpenRouter | `/api/alpha/decisions`    | The root address, `/api/v1`, `/api/alpha`, or the evaluation endpoint itself |
| Vercel     | `/v4/ai/evaluation-model` | The root address, `/v1`, `/v4/ai`, or the evaluation endpoint itself         |
| TypeSafe   | `/v1/systemone`           | The root address, `/v1`, or the evaluation endpoint itself                   |
| OpenAI     | `/v1/decisions`           | The root address, `/v1`, or the evaluation endpoint itself                   |

Vercel sends the model ID in the `ai-model-id` header, and it sends its native protocol version and the API key authentication header. In its request body, the Boolean type stays as `boolean`.

### Configure in llm.toml

```toml
[covel.evaluation]
provider = "typesafe"
model = "jev-latest"
baseUrl = "https://api.typesafe.ai/v1"
protocol = "typesafe-systemone-v1"
```

- Setting an evaluation protocol automatically gives you `output = ["evaluation"]`, `supportedModes = ["evaluate"]`, and `tag = "evaluation"`.
- The built-in `typesafe` connection can also be added directly on the provider settings page.
- The key variables are `TYPESAFE_API_KEY`, `OPENROUTER_API_KEY`, and `VERCEL_API_KEY`, named the same way as for other providers. Put the Vercel AI Gateway key in this project's `vercel` connection.
- Where keys go: in development, use `.env.llm`. In the desktop app, use `keys.env`. In the browser, save them through the provider settings. Do not put keys in the TOML.

For the full description of role fields, see [Model role configuration](./slots.md).

### Calling it

In server code that holds a configured gateway:

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

**Which model is chosen**

- `presetId` can be a role name or a preset ID. If it is not given, the `evaluation` role is resolved, along with any roles that have the same `tag`.
- If a call fails, it falls back through the `fallback` chain configured for this role. `allowFallback: false` turns off the backup models. A backup model must also support evaluation.
- Cancelling stops the current request and any retries. It does not try a backup model.
- If there is no evaluation role, a text role is not borrowed automatically.

**Keys, timeouts, and transport**

- `apiKeys` are the keys this request provides explicitly. They take priority over `envApiKeys`.
- Server keys are still limited by trusted origins. If a request changes the base URL to another origin, the original provider's server key is not sent.
- The protocol adapters reuse the existing HTTP transport. This includes the desktop proxy, DNS protection, refusing redirects, and retries for 429 / 5xx responses.
- The caller sets timeouts and cancellation through `signal`.

## Public contract

| Question type | Parameters                                              | Return value                                                                   |
| ------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `choice`      | `criteria` is a map from option name to description     | `choice`, and optionally `probabilities` for each option                       |
| `score`       | `criteria` is an ordered array of levels, starting at 0 | `score` (can be a decimal), and optionally `probabilities` for each level      |
| `boolean`     | Optional `criteria.true` / `criteria.false`             | `probability`, meaning P(true). It is not converted to a boolean automatically |

**Input**

- `state`, `instructions`, and the descriptions of each item accept text, a JSON object, a JSON array, or `null`.
- `questions` cannot be empty.
- The model ID is sent as it is.

**Return**

- The result contains `provider`, `answers`, and a summarized `usage.inputTokens / outputTokens`.
- The returned `model` is the actual version the provider reports. If the provider does not report one, the ID from the request is used.
- The option type for `choice` is inferred from the question.

**Checks the adapter makes**

- The limits for Jev requests are checked in the adapter: Choice takes 1 to 255 options, and Score takes 2 to 10 levels.
- The adapter checks that questions and answers match one to one, the option set, the range and total of the probabilities, the score range, and the token counts.

**Differences between providers**

- TypeSafe / OpenRouter: the shared `boolean` maps to `noul` in the request, and the answer is converted to `probability`.
- TypeSafe keeps probabilities to two decimal places. When the total is checked, a rounding error is allowed for each item. It does not normalize again.
- `providerMetadata.typesafe.confidence` or `providerMetadata.openrouter.confidence` keeps the provider's own confidence statistics. It cannot be treated as a general probability for all providers.
- The `providerMetadata` returned by Vercel is kept. Rounding notes and warnings are stored in `providerMetadata.vercel`. The total of the probabilities is checked against the precision it declares.
- OpenRouter / Vercel may not return a probability distribution, so the shared `probabilities` field is optional. If the provider does not supply one, Covel does not invent a distribution.

### Conversion for OpenAI Decisions

The request shape of OpenAI Decisions (`openai-decisions-v1`, public beta from 2026-10, currently only `gpt-6-luna`) is different from the other three. The adapter converts at the boundary, and the shared contract does not change:

| Shared contract                           | OpenAI wire                                                                                                                                       |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `state`                                   | `input`: text is sent as it is, and JSON values are serialized into text                                                                          |
| `questions`, a map keyed by question name | `questions` is an array, and the question name is in each item's `name`. The `answers` in the reply is also an array, and it is matched by `name` |
| `boolean`                                 | `predicate`. `criteria.true` / `criteria.false` are merged into `instructions` as a "Criteria for true/false" section                             |
| `criteria` of `choice`                    | `choices: [{ value, description }]`. It requires 2 to 255 items (with only 1 item, a configuration error is reported before sending)              |
| `criteria` of `score`                     | `levels: [{ label, description }]`. `label` is the index of the level                                                                             |
| `probabilities` map                       | An array of `[{ value, probability }]`. After it is converted to a map, it is checked by the same rules                                           |

- When the model refuses a question (there is a `refusal` in `answers`), the whole call fails with a `REFUSAL` error that cannot be retried. `error.details.question` is the name of the refused question. The shared contract requires an answer for every question, so no partial result is returned.
- `usage` brings back `cachedInputTokens` / `cacheWriteInputTokens`.
- The `confidence` for each question is stored in `providerMetadata.openai.confidence`.
- The request sends only `model`, `input`, and `questions`. It does not send `safety_identifier`, and it does not send images (the shared contract's `state` has no image type).

### What a request contains and what it does not

- An evaluation request sends only `state / questions` and the model identifier. For TypeSafe / OpenRouter the identifier goes in the request body as `model`. For Vercel it goes in the `ai-model-id` header.
- No text-generation temperature, tools, or thinking parameters are mixed in, and no free-form metadata from the role is mixed in either.
- `onProviderRequest` can record the fields that were actually sent. A record, like any normal LLM prompt, may contain private content, but it does not contain authentication headers.
- The provider connection test sends one minimal Boolean question to the evaluation model, and it returns the total time taken. It does not fake a first-token latency for streaming.

An evaluation model does not support `generateText / generateObject / streamText / embed`. These errors are thrown before any request is sent. "Generate an arbitrary object" and "evaluate within a closed set of answers" are two separate capabilities.

## Connecting a new provider

**The provider uses an interface that is already supported**: you only need to set its own provider, base URL, model, and the matching protocol.

**The provider uses a different interface**:

1. Implement `ModelProviderAdapter.evaluate`.
2. Add the adapter and the default values for the `evaluation` capability to the protocol registry.
3. Update the protocol enum and the configuration entry points.

The existing provider registration interface allows the adapter to be replaced. The gateway does not need to branch by provider or by plugin ID. Provider-specific count limits, field names, and statistics stay inside the protocol boundary.

**Using it in a plugin**

- A function runtime provides `ctx.gateway.evaluate({ presetId, state, questions, signal })`. It inherits the request configuration, cancellation, and the gateway trace.
- The optional [Jev recommendation demo](https://github.com/covel-ai/covel-plugins/tree/main/examples/jev-choice-demo) calls it through the plugin's public service, and includes a UI that shows probabilities. The default gameplay does not turn it on automatically.
- A brand-new interface can also be wrapped in a [plugin service](./plugin-extensions.md#models-and-new-protocols), without first extending the framework's standard protocol enum. When it needs to become a native protocol of the framework, use the adapter entry point above.

## Using evaluation in Covel

It is recommended to start with "side evaluation": the evaluation result does not change the game state, and it is only used to collect your own project samples. With samples in hand, you can then decide the thresholds and what to do when it fails.

| Scenario                                   | Capability used | Integration boundary                                                                                     |
| ------------------------------------------ | --------------- | -------------------------------------------------------------------------------------------------------- |
| Checking story and world rule consistency  | Boolean / Score | Evaluate the generated content. Rules that must be enforced deterministically are still enforced by code |
| Classifying player intent                  | Choice          | Route between defined intents. Keep `other`, so it does not replace free narrative                       |
| Scoring the relevance of memory candidates | Score           | Sort after the existing retrieval. It does not replace embeddings or memory generation                   |
| Choosing NPC behavior and scene candidates | Choice / Score  | Score candidates that the code has already listed. The plugin is still responsible for writing state     |

> [!IMPORTANT]
> Most of Covel's content is in Chinese, and the official notes say Jev currently has the best accuracy in English. First measure the error rate, probability thresholds, end-to-end latency, and failure rate on Chinese samples. Only then decide whether it is worth putting into the main flow. Do not treat the performance numbers the provider advertises as measured results for this project.

- Fix the model version based on calibrated results, and record the actual version that appears in the answers. `jev-latest` moves with each release.
- As of 2026-09-19, the official documentation lists `jev-1.13.0`, a total request limit of 64k tokens, a limit of 32k for state plus the longest question, and input at $0.042 per million tokens, with output free. Prices and aliases may change.
- The model catalog records the total request limit. There is no local tokenizer to estimate the second limit, so the server checks it.
- `maxOutputTokens = 0` means no text-generation budget is provided. It does not mean the request's output token usage is necessarily zero.

> [!NOTE]
> Online latency, Chinese-language performance, and cost have not yet been verified with real keys. OpenAI Decisions is also implemented only from the official reference documentation and simulated answers. It has not been called with a real key.

References:

- [OpenAI Decisions guide](https://developers.openai.com/api/docs/guides/decisions), [OpenAI Decisions API reference](https://developers.openai.com/api/reference/resources/decisions/methods/create), [the OpenAI Decisions adapter in the AI SDK](https://github.com/vercel/ai/blob/main/packages/openai/src/openai-decision-model.ts)
- [OpenRouter Decisions](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-questions-and-answers-request)
- [Vercel native evaluation wire](https://github.com/vercel/ai/blob/main/packages/gateway/src/gateway-evaluation-model.ts), [Vercel model catalog](https://ai-gateway.vercel.sh/v1/models)
- [TypeSafe API](https://docs.typesafe.ai/api), [model limits](https://docs.typesafe.ai/models), [the evaluation adapter in the AI SDK](https://github.com/vercel/ai/blob/main/packages/typesafe-ai/src/typesafe-ai-evaluation-model.ts)
- [User-supplied use case collection](https://github.com/Anil-matcha/awesome-jev-by-typesafe)
