# Model role (slot) configuration

Covel splits model calls into several kinds of work, for example writing story text, updating plugin state, and compressing history. Each kind is called a "model role". In code and config files it is called a slot. You give each role a provider and a model. At run time, the game uses the role to find the model it should call.

This page is the full reference for roles: how to write `llm.toml`, which built-in providers exist, how one call picks its model, and how retries and fallbacks work when a call fails.

- If you only want to connect a model in the settings screen and start playing, [Connect a model](../start/models.md) is enough. You do not need this page.
- If you want to write `llm.toml` by hand, read the first three sections.
- If you develop plugins or the framework, look up the later sections as you need them.

## What a role looks like

Each `[covel.<name>]` section in `llm.toml` defines one role:

```toml
[covel.story]
provider = "deepseek"
model    = "deepseek-flash"

[covel.utility]
provider = "dashscope"
model    = "qwen3.8-flash"
fallback = "story"
```

This config means:

- Story text (`story`) uses `deepseek-flash` from DeepSeek.
- Utility tasks (`utility`) use `qwen3.8-flash` from Alibaba Cloud Model Studio. If a call fails, the call uses the model of `story` instead.
- The first role in the file is the default role.

Common text role names are `story` (story text), `plugin` (plugin tasks), `utility` (utility tasks), `fast` (history compression), and `memory` (memory extraction). Images, speech, vectors, and evaluation each have their own roles, for example `image`, `embed-default`, and `evaluation`. You can choose any name. Plugins find a role by its name or by its capability tag. For a full example, see [`llm.toml.example`](../../../llm.toml.example) in the root of the repository.

**Where the file is**

| How you run Covel           | File that is read                                                                           |
| --------------------------- | ------------------------------------------------------------------------------------------- |
| Environment variable is set | The file that `COVEL_LLM_TOML` points to. It takes priority over the two rows below         |
| Run from source             | `llm.toml` in the repository root. If it is missing, the config in your user folder is used |
| Desktop app                 | `~/.covel/llm.toml`. Reload it in settings, and you do not need to restart                  |

**Keys are not written in this file.** Keys go in `.env.llm` (run from source) or `~/.covel/keys.env` (desktop app). The variable name is `{PROVIDER}_API_KEY`, for example `DEEPSEEK_API_KEY`. For details, see [API key flow](#api-key-flow).

**If there is no `llm.toml`**, the server uses a built-in `story` role:

- The default is `deepseek-v4-flash` from DeepSeek.
- If `DEFAULT_BASE_URL` is set, the server uses that OpenAI-compatible address instead. The provider name is `default`, the key is read from `DEFAULT_API_KEY`, and the model is read from `DEFAULT_MODEL`. If `DEFAULT_MODEL` is not set, it is still `deepseek-v4-flash`.

In an environment without a DeepSeek key (for example, cloud tests), set these three variables. You can then use any provider without writing `llm.toml`.

> [!NOTE]
> An evaluation model is a different kind of model. It does not write text. It only answers multiple-choice questions, gives scores, and answers yes-or-no questions. In the config, write `output = ["evaluation"]` and `tag = "evaluation"`, and call it with `gateway.evaluate()`. TypeSafe, OpenRouter, Vercel, and OpenAI evaluation models each use their own interface. See [Model evaluation](./evaluation.md).

## Slot fields (`[covel.<slot>]`)

Schema: `packages/ai-provider/src/config/llm-schema.ts`.

| Field                               | Required | Description                                                                                                                                                                                                                                                                     |
| ----------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `provider`                          | ✅       | Provider name. It matches `{PROVIDER}_API_KEY` in `.env.llm` or `keys.env`. Roles that use the same `provider` share one key                                                                                                                                                    |
| `model`                             | ✅       | Model ID. It is sent to the provider as written. An ID with a `/` is not changed                                                                                                                                                                                                |
| `baseUrl`                           | —        | API address. You can leave it out for [built-in providers](#built-in-providers-and-protocols). Other providers must set it. A remote address must use https. A local address is allowed only in a `self` deployment, and it can use http                                        |
| `protocol`                          | —        | API protocol. The values are listed in [Built-in providers and protocols](#built-in-providers-and-protocols). If you leave it out, a built-in provider uses its own protocol. Other providers use `openai-chat-v1`                                                              |
| `tag`                               | —        | Capability tag: `text` / `image` / `embedding` / `speech` / `transcription` / `music` / `evaluation`. If you leave it out, the tag is inferred from `output` (`audio` becomes `speech`). A music role must set `music`                                                          |
| `fallback`                          | —        | Name of the role to use when a call fails. The target role must have the same capability, and its key must already be set. Fallbacks cannot form a loop                                                                                                                         |
| `input` / `output`                  | —        | Types of content that the model accepts and produces. If you leave them out, they are detected automatically (see [Where model capabilities come from](#where-model-capabilities-come-from)). `output` can be `text` / `image` / `audio` / `video` / `embedding` / `evaluation` |
| `features`                          | —        | Model features (`function_calling`, `reasoning`, `vision`, and so on)                                                                                                                                                                                                           |
| `contextWindow` / `maxOutputTokens` | —        | Overrides the context window and the maximum output in tokens                                                                                                                                                                                                                   |
| `pricing`                           | —        | Price information. It is used only by the cost panel in `/debug`                                                                                                                                                                                                                |
| `reasoningEffort`                   | —        | Thinking level (for example `disabled`, which turns thinking off). It is the default for this model. When Covel sends the request, it becomes each provider's own field. See [Thinking strength](#thinking-strength)                                                            |
| `embeddingFormat`                   | —        | Request format for vector roles: `openai` (default) or `nemotron-multimodal`                                                                                                                                                                                                    |
| `providerRequestMetadata`           | —        | Free-form key-value pairs sent with generation requests. A value given for a single call takes priority. Evaluation requests do not use it. The keys that choose the image and speech protocols also go here. See the section "Media wire routing keys" below                   |
| `providerOptions`                   | —        | Native parameters grouped by provider or protocol. They are used only for text, object, and streaming calls. See [Provider parameters](#provider-parameters)                                                                                                                    |

Values such as `baseUrl` can read an environment variable, for example `baseUrl = "${MY_API_BASE}"`. When the file cannot be read, the error gives the line, the column and the key, never the value of an environment variable. The old fields `reasoning_effort` and `thinking` are no longer accepted. If you write them, loading fails with an error. Use `reasoningEffort` or `providerOptions` instead.

## Built-in providers and protocols

A provider and a protocol are two different things:

- A **protocol** is the format of a request and its answer.
- A **provider** is one API address that uses a protocol.

| Protocol ID               | Name in settings     | Output     |
| ------------------------- | -------------------- | ---------- |
| `openai-chat-v1`          | OpenAI Chat          | Text       |
| `openai-responses-v1`     | OpenAI Responses     | Text       |
| `anthropic-messages-v1`   | Anthropic Messages   | Text       |
| `google-generative-ai-v1` | Google Gemini        | Text       |
| `typesafe-systemone-v1`   | TypeSafe System One  | Evaluation |
| `openrouter-decisions-v1` | OpenRouter Decisions | Evaluation |
| `vercel-evaluation-v4`    | Vercel AI Gateway    | Evaluation |
| `openai-decisions-v1`     | OpenAI Decisions     | Evaluation |

Built-in providers come with their official address and default protocol. In `llm.toml`, you only need to write `provider` and `model`. In the settings screen, you can pick them from a list:

| `provider`    | Name                     | Endpoint                                            | Protocol                  |
| ------------- | ------------------------ | --------------------------------------------------- | ------------------------- |
| `openai`      | OpenAI                   | `https://api.openai.com/v1`                         | `openai-chat-v1`          |
| `anthropic`   | Anthropic                | `https://api.anthropic.com`                         | `anthropic-messages-v1`   |
| `google`      | Google Gemini            | `https://generativelanguage.googleapis.com/v1beta`  | `google-generative-ai-v1` |
| `deepseek`    | DeepSeek                 | `https://api.deepseek.com`                          | `openai-chat-v1`          |
| `dashscope`   | Alibaba DashScope (Qwen) | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `openai-chat-v1`          |
| `xai`         | xAI                      | `https://api.x.ai/v1`                               | `openai-chat-v1`          |
| `mistral`     | Mistral AI               | `https://api.mistral.ai/v1`                         | `openai-chat-v1`          |
| `groq`        | Groq                     | `https://api.groq.com/openai/v1`                    | `openai-chat-v1`          |
| `together`    | Together AI              | `https://api.together.xyz/v1`                       | `openai-chat-v1`          |
| `fireworks`   | Fireworks AI             | `https://api.fireworks.ai/inference/v1`             | `openai-chat-v1`          |
| `moonshot`    | Moonshot AI (Kimi)       | `https://api.moonshot.cn/v1`                        | `openai-chat-v1`          |
| `zhipu`       | Zhipu AI (GLM)           | `https://open.bigmodel.cn/api/paas/v4`              | `openai-chat-v1`          |
| `siliconflow` | SiliconFlow              | `https://api.siliconflow.cn/v1`                     | `openai-chat-v1`          |
| `volcengine`  | Volcengine Ark (Doubao)  | `https://ark.cn-beijing.volces.com/api/v3`          | `openai-chat-v1`          |
| `openrouter`  | OpenRouter               | `https://openrouter.ai/api/v1`                      | `openai-chat-v1`          |
| `vercel`      | Vercel AI Gateway        | `https://ai-gateway.vercel.sh/v1`                   | `openai-chat-v1`          |
| `typesafe`    | TypeSafe                 | `https://api.typesafe.ai/v1`                        | `typesafe-systemone-v1`   |
| `ollama`      | Ollama (local)           | `http://localhost:11434/v1`                         | `openai-chat-v1`          |
| `lmstudio`    | LM Studio (local)        | `http://localhost:1234/v1`                          | `openai-chat-v1`          |
| `llamacpp`    | llama.cpp server (local) | `http://localhost:8080/v1`                          | `openai-chat-v1`          |
| `vllm`        | vLLM (local)             | `http://localhost:8000/v1`                          | `openai-chat-v1`          |
| `litellm`     | LiteLLM Proxy (local)    | `http://localhost:4000/v1`                          | `openai-chat-v1`          |

```toml
[covel.story]
provider = "zhipu"
model    = "glm-5"
```

For a provider that is not in the table, set `baseUrl` as usual. It only needs to be compatible with OpenAI Chat. You can leave out `protocol`.

**Local services.** An entry marked "local" means a service on the same machine that runs the Covel server. The port is that service's default.

- If you use a different port, or a local gateway that offers several protocols on one port, add it as a custom provider. Set the address to `http://127.0.0.1:<port>/v1`, and choose the protocol that this route uses. If you need several protocols, add several providers.
- A model on a local address (`localhost`, `127.0.0.1`, `::1`) does not need an API key. Without a key it still counts as ready. You can start a game, run background tasks, and run connection tests. If the service itself asks for a key, fill it in as usual.

**Reading the model list.** When you add a provider or a model, "Read the model list from the service" asks that service for the model IDs it offers (`POST /api/ai/models`). Tick the models you want to add. You can filter them by name. IDs you typed by hand are kept.

| Protocol                | Path that is read                                        |
| ----------------------- | -------------------------------------------------------- |
| OpenAI Chat / Responses | `/models`                                                |
| Anthropic               | `/v1/models`                                             |
| Gemini                  | `/models`, with the `models/` prefix removed from the ID |
| Evaluation protocols    | No list                                                  |

A server-side `{PROVIDER}_API_KEY` from the environment is sent only to a same-origin address of the official addresses in the table above. See [Security boundaries](../internals/security.md).

### Add a provider or a protocol

- **Add a provider that uses an existing protocol**: add one entry (name, endpoint, protocol) to `BUILTIN_PROVIDER_CONNECTIONS` in `packages/shared/src/utils/provider-defaults.ts`. The provider list in settings, the default values in `llm.toml`, and the trusted sources for keys all read from this table.
- **Add a new protocol**:
  1. Add a description (ID, name, and whether it outputs text or evaluations) to `PROVIDER_PROTOCOL_DESCRIPTORS` in `packages/shared/src/provider-protocols.ts`.
  2. Add a `ProtocolDefinition` entry to `BUILTIN_PROTOCOLS` in `packages/ai-provider/src/protocol-registry.ts`.

  Config validation, request header validation, the dropdown in settings, and the types are all derived from the description table. If you forget the definition, `tsc` reports an error.

- A `ProtocolDefinition` states all the differences of the protocol:
  - The adapter (`createAdapter`)
  - The cache policy
  - The default capabilities
  - How a `reasoningEffort` level becomes a request field (`reasoningFields`)
  - Which `providerOptions` fields it accepts (`providerOptionFields`)
  - Which optional generation parameters it supports (`parameters`)
  - Whether images and speech must name their wire explicitly (`mediaWire`)

  The gateway and the registry look only at this table. They do not compare protocol IDs.

- Request tracing records only the body fields on an allowlist (`MODEL_FIELDS` in `packages/ai-provider/src/adapters/http/request-observation.ts`). If a new protocol uses new top-level field names, add them there. Otherwise they do not appear in the trace.
- The plugin SDK cannot depend on `@covel/shared`. It keeps its own copy of the built-in protocol ID type (`PluginProviderProtocol`). If the two copies differ, `packages/shared/src/provider-protocols.ts` fails to compile.
- **A plugin can provide a protocol**, and the framework does not need to change. The plugin registers it with `covel.registerWires({ text: [...] })`, and the role's `protocol` is written as `<pluginId>/<wireId>`. Only sessions that enable that plugin can select it. Otherwise the call fails with a configuration error. A request without a session (such as a connection test) can use a protocol from a built-in plugin. In a `self` deployment it can also use one from a community plugin. See [plugin-extensions.md § Text protocol wire](./plugin-extensions.md#text-protocol-wire).

## API key flow

A key is never written into `llm.toml`:

| How you run Covel  | Where the key is saved                    |
| ------------------ | ----------------------------------------- |
| Source development | `.env.llm`                                |
| Desktop app        | `~/.covel/keys.env` (file permission 600) |
| Web page only      | Browser localStorage (`covel:keys`)       |

Each AI request sends the keys in the `X-Provider-Keys` request header (a base64-encoded JSON object `{provider: key}`) to the server. The server takes the key that matches the `provider` name of the target role, so the `config.apiKey` that the wire receives is already the key for that role's provider. A key sent by the client takes priority over a key from the server's environment variables.

Keys from the server's environment, and default credentials registered in the program, are bound to trusted sources:

- If a request changes the address to another origin, the default `apiKey` and headers are removed. No environment key is injected either. A key that the caller gives explicitly in this request can still be used for that address.
- If only the path changes within the same origin, the default credentials are kept.
- A resolve request does not change a registered config.

## Config layers and the front end

First, two terms:

- **Model capability** is what a model can do, for example `evaluation`.
- **Role name** is a name you choose, for example `intent`, `risk-check`, or `npc-choice`.

Several roles can use the same evaluation model. The name `evaluation` is only the agreed default name that `gateway.evaluate()` uses when no role is given. Provider names, model IDs, and role names do not decide the protocol.

The config has four layers. Each layer has a place in the settings screen:

| Layer                            | Place in the front end                   | Saved where and scope                                                                                                                   |
| -------------------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Connections and models           | Providers & Models                       | The TOML file gives the base models. `llm.providers` saves local connections and models. A model can override the connection's protocol |
| Role and model binding           | Model Roles                              | `[covel.<name>]` defines the base roles. A local choice in `llm.slotConfig` takes priority                                              |
| Role parameters and capabilities | Generation, Edit Capabilities            | `llm.paramOverrides` / `llm.capabilityOverrides` override values per request                                                            |
| Task role choice                 | Session-prep screen, session plugin list | `runtimeModelOverrides` saves only the "task to role" mapping                                                                           |

Where settings are saved:

- The desktop app saves to `settings.json`. The web version saves in the current browser. Neither writes back to the TOML file.
- Reloading the TOML keeps your local bindings and parameters. If you reset a role binding, it goes back to the model in the file.
- Parameters and capabilities each have their own reset.

Rules for the providers page:

- Models are grouped by connection ID. A group shares one API key and one price multiplier.
- A model from the TOML keeps its own address and protocol from its file. A model you add locally uses the address of the local connection, plus its own protocol override. Changing a local connection does not change the TOML models in the same group.
- Model rows and role cards show the effective address, protocol, and config source.

Rules for the role picker:

- The picker shows only models whose output type matches what the role needs. Chat models and evaluation models from the same OpenRouter or Vercel connection are not mixed.
- A saved binding that is no longer valid shows an error. It is also left out of the roles that the session can use. It is never quietly rebound to another model.
- The server also checks explicit bindings. A built-in text role cannot be bound to an evaluation model.
- The capability of a custom role comes from the TOML `tag` or from the output of the chosen model. The role name does not have to follow a fixed pattern.

The generation parameters page shows parameters that match the model's actual capabilities. For a model that does not output text, such as an evaluation model, it hides the temperature, output token, and thinking parameters. You can still reset parameter overrides that were saved before.

### Actual selection priority

For one call, the role is chosen in this order:

1. An explicit choice made by the runtime, including the session's `runtimeModelOverrides`. It decides which role or preset to use.
2. If there is no explicit choice, the role the runtime names itself (`agent.model` / `function.model`). If it names none, the `default` binding of the current request is used when there is one, otherwise the system's default role.
3. That role is resolved first with the UI role binding in the current request. Without a binding, it is resolved with the system `llm.toml`, and the fallback of an available text role.

Extra rules:

- A plugin only says which role it wants. It cannot choose a provider, model, address, or protocol. Which model is used, and where the request goes, is decided by the model settings of the player (or the operator), so the player's keys only go to addresses in those settings. An `llm.toml` in a plugin's directory is not read, and `pnpm validate:plugin` warns when it finds one.
- If a text role such as `fast` or `memory` is not defined, it falls back to an existing role. That role also reads the UI binding, parameters, and capabilities of the current request.
- The task mapping on the session-prep screen must be saved successfully first. It must also be synced to the server's temporary copy before a runnable session is published. If saving fails, the choice is kept and the start is rolled back. The session does not start with defaults.

Price overrides and provider multipliers are used only to estimate cost while debugging. They are not sent with a model request, and they do not change what the provider actually charges. A manual price applies only when the actual provider and model in the trace match the current config uniquely. If they do not match, the estimate from the model data is used.

### Fallback belongs to the role

`fallback` belongs to the role in the TOML file. It does not belong to the model.

- If you change the model of `utility` in the interface, the original `utility -> story` fallback still applies. `story` also uses the model that you picked for this request.
- The system never borrows a fallback from another role that the newly chosen model belongs to.
- Duplicate targets count only once. The loop check for fallback chains still applies.
- With `allowFallback: false`, only the main target is called.

This rule applies to calls that already supported fallback chains: text, structured output, streaming output, and evaluation. Image, speech, and vector calls do not gain extra retries from it.

## Slot resolution chain

A call finds its model in these steps:

1. **Request binding.** `X-Slot-Config.slotBindings` comes first. It tells a local `modelRef` apart from a server `presetId`. A local model must be declared in this request. Keys are given through `X-Provider-Keys`, and they are not written into a plugin or a world package.
2. **Match by name.** The name is resolved as a preset ID or a role name. An image call needs an exact name match, and the target must be able to output images. A wrong name, a missing config, or a text model picked for an image all return `CONFIG_ERROR`, and no provider is called.
3. **No name given.** `generateImage` and `resolveSlot({ fallbackTag: "image" })` both use `image`. The system does not pick a different image role on its own, and it does not use the default text model. Speech and transcription use their own default names, `speech` and `transcription`, and keep the existing same-tag resolution.
4. **Same-tag fallback (not for images).** If a text call does not find its name, it can fall back to a role with the same `tag`. It never falls back across tags.
5. **Task role choice.** For an agent, `runtimeModelOverrides` takes priority over `manifest.model`. For an image task in a function, the plugin's `modelPresetId` setting picks the role. Both end up using the same request-level model binding.

For how scene pictures, community illustration plugins, world assets, and protocols relate, see [Image generation](./image-generation.md).

### Where model capabilities come from

Model capabilities are the content types that a model accepts and produces, its features, its token limits, and its pricing. The system takes the first source that has a value, in this order:

1. The request-level override (`X-Slot-Config.capabilityOverrides`)
2. Fields written by hand in `llm.toml`
3. Built-in model data
4. A versioned LiteLLM snapshot
5. The protocol's defaults

Rules for request-level overrides:

- They contain only `input` / `output` / `features` / `contextWindow` / `maxOutputTokens`. A price override is shown only to the client. It is not part of the server's trust boundary.
- A `self` deployment lets a local user widen capabilities. `demo` and `commercial` accept only a non-empty subset of the basic capabilities. For token limits, the smaller of the server value and the request value is used.
- Each request copies only the effective target. It does not change the global registry.

The snapshot in the repository is made by a maintainer running `pnpm --filter @covel/ai-provider update-model-db`, from a fixed commit. A manual refresh on the settings page writes newer data to the user's config folder. From then on, that data is loaded at startup in preference to the built-in snapshot.

**A model listing a feature does not mean the adapter can use it.** The built-in native text adapters for Chat, Responses, Anthropic, and Gemini accept only text and image as input, and output only text. They do not provide `web_search` or `computer_use`. This limit still applies after capability overrides are merged. A manual tick cannot enable a protocol feature that is not implemented yet.

- `GET /api/model-db/lookup` keeps the original `capability`. When you pass `role` and `protocol`, it also returns `effectiveCapability`. When it can resolve the connection, it also returns `usesBuiltinAdapter`.
- The settings page, `resolveSlot`, and the actual text calls use the same calculation.
- A custom adapter registered by a program, and separate image, speech, transcription, and vector wires, keep their own capabilities.
- An unknown model is still marked "inferred from protocol". The protocol defaults are not treated as checked facts about the model.

### Context and output budget

For each agent call, after `PreLLMCall`, `LLMAdapter.resolveBudget(slot)` reads the actual role's `contextWindow`, its `maxOutputTokens`, and the user's `requestedMaxOutputTokens`. It keeps room for the output first, and then trims the input.

- Context assembly and `PostContextAssembly` do not trim the history early using another model's window.
- `story` and `plugin` each use the window of their actual target. History compression uses the current config of `fast`.
- Request overrides and hot updates to `llm.toml` both go through the same adapter.
- `createTurnContextBudget` gives a fallback window of 262,144 (256K) only to unknown models.
- If `COVEL_COMPACTOR_CONTEXT_WINDOW` is set explicitly, it is kept as a deployment limit through `BudgetOptions.contextWindowLimit`. It cannot widen the model's own capability.

The output limit is calculated by the shared `resolveLlmTokenLimits`:

- The default is 16,384. It is then narrowed by the model's output capability.
- When the context window is small, the automatic default uses at most half the window, so there is room for input.
- A limit that the user sets explicitly can be higher or lower than the default. It is read before validation.
- The effective output cannot fill the whole context. If input and output do not fit together, the call fails clearly.
- The gateway limits the output again for each actual target, including fallback models. The text, object, and stream calls of agent and function plugins all take this path.
- When the output capability of an Anthropic model is unknown, the default is also 16k.

Switching to a fallback model:

- An HTTP 429 (rate limit) allows a switch to a configured fallback model.
- An account failure (no balance left, or a key that is wrong or not allowed to use this model; see `quota` / `auth` below) also allows a switch. It belongs only to the account at this provider, so the fallback target may still work. With no fallback model configured, the call fails and the player is told why.
- Other 4xx errors keep their original failure path.
- Once streamed content has been output, switching is not allowed. This prevents mixing the results of two models.

### Which model is recorded when a call fails

After a failure in steps such as the tool completion contract, output validation, or running out of tool loops, the provider and model of the last answer are still kept. This identity is updated by `onTargetAttempt` as the actual requests happen, including fallback models. Normal runs and runs resumed after a pause share this handling. A model is never recorded by mistake from the first role binding when a different model gave the final answer.

## Runtime override scope and the UI

Model config has two layers, and the values mean different things:

| Layer            | Mapping                 | Where it is saved                                             | Scope                                     |
| ---------------- | ----------------------- | ------------------------------------------------------------- | ----------------------------------------- |
| Model role       | `slot → provider/model` | Base config in `llm.toml` + Settings overrides on this device | All runs on this device that use the slot |
| Runtime override | `runtimeId → slot`      | `SessionRecord.runtimeModelOverrides`                         | One session; snapshots and forks keep it  |

**Agent runtime**

- The session-prep screen finds every agent runtime in the enabled plugins.
- If you pick nothing, the runtime uses the `model` in `PLUGIN.md`. If you pick a role, it is written into `runtimeModelOverrides`.
- When one plugin has several runtimes, the key must be the full ID (for example `char-creator/character-tracker`). Each one can be bound separately.
- After the session starts, the plugin list on the left updates the same table through `PATCH /api/sessions/:id`. The next run reads the new value. Calls that are already running are not affected.

**The two values shown in the UI**

- "Runtime default" shows the role declared in the plugin manifest.
- "Provider · model" shows the target that is actually called, after this device's override for the role.

Both appear together so you can see "which role is used" and "which model is finally used". It does not mean the config is inconsistent. If you change the provider or model of a role, every runtime that still points to that role is affected. Changing a runtime override only switches to another role. It does not change the role itself.

**Function runtime**

A function runtime does not read `runtimeModelOverrides`. Image and speech function plugins usually choose a role for their capability through their own `userSettings.modelPresetId`. The session-prep screen shows it as a separate option and writes it to the device setting `plugin.<pluginId>.modelPresetId`. Do not mix the session override of an agent runtime with this setting of a function runtime.

**Connection tests and the settings page**

- A connection test goes through the same header validation, role binding, parameter overrides, and capability limits as a turn. A role test keeps the role name. It must not swap in a preset ID first and lose that role's config.
- `GET /api/presets` and `GET /api/llm-config` return model capabilities and the defaults of `parameterOverrides` on the allowlist. The settings page uses them to show the TOML defaults and the budget after restoring defaults. They do not return any arbitrary provider metadata.
- The two token settings entries share the override data and `resolveLlmTokenLimits`. The page shows both the effective output budget and the remaining input budget. It also warns when context and output conflict.
- The protocol defaults of an unknown model declare only content types and features. They do not guess the token limit of a specific model.

**Memory extraction**

- Memory is extracted by the post-turn function runtime of the `memory` plugin. It reads the frozen `turn-digest@1` and runs as a background job with `completion.mode: detached`.
- `settle: before-next-execution` makes the next run wait for queued jobs to finish before it reads the new snapshot. The longest wait is set by `maxSettleWaitMs`.
- The job uses the `memory` role through the gateway of the current request. By default, `reasoningEffort: disabled`. The model binding, parameter overrides, and authorization in the request are still resolved as usual.
- If a model call fails, the committed story is not rolled back. A failed or cancelled extraction does not commit part of the memories.
- A successful extraction writes to the `blocks` namespace of the `memory` plugin's own data. The panel reads this data directly. The prompt is injected by its `prompt.segment@1` extension.
- The `memory` role can be bound explicitly in the model config. Its resolution and fallback follow the general rules on this page.

## Model identity in a request

Device settings and `X-Slot-Config.slotBindings` use the same format. Each role accepts only one of these two forms:

```json
{ "modelRef": "local-reference" }
```

```json
{ "presetId": "server-preset" }
```

- A local reference must be declared in this request's `customPresets`. A server preset with the same name cannot stand in for a missing local reference.
- If the shape of a binding is wrong, a model reference is repeated, a definition is missing, or the route header is invalid, the server returns `400 invalid_llm_configuration` before running. It never ignores the config and calls another model.
- Temporary registrations are isolated to the config of this request. The public model catalog and the default text and embedding choices read only the saved config. One request cannot reach another request's model through an internal ID.
- When a local choice and a server choice have the same name, the model tag, capabilities, parameter editing, and connection test all resolve by the type that was chosen.

**Connection test `POST /api/ai/ping`**

- It accepts exactly one of `modelRef`, `presetId`, or `slot`. You cannot give more than one.
- A test of a local model includes its definition from this request. A role test keeps the role name and its parameters.
- If the explicitly named model does not exist, the test fails. It does not test a different model.
- If no target is given, or a role that is not configured is named, the server may still fall back by role. It records the actual source in `testedTarget.resolvedVia`.
- After the target is chosen, the ping fixes this request's model binding, and keeps the parameter and capability overrides of the original role. A preset with the same name no longer changes the route.
- If the chosen model fails, the test fails right away. It does not run the fallback models in the config.
- Invalid JSON, unknown request fields, or more than one target return 400. A valid `{}` tests the default role.

**`allowFallback`**

The low-level Gateway methods `generateText`, `generateObject`, and `streamText` accept `GatewayOptions.allowFallback`. It defaults to `true`, which keeps the normal fallback chain for generation. When it is `false`, only the main target is resolved and called. If an explicitly named target does not exist, it still returns an error. This option does not change the same-tag rule when a role is resolved by name. The ping uses `allowFallback: false` after it fixes the actual binding.

## Provider and model IDs

The settings screen stores connection info and model IDs separately:

- One provider has one set of `baseUrl`, protocol, API key, and price multiplier. It can have several model IDs under it.
- A role binding refers to just one of those models.
- When a request is sent, the front end turns this reference into a custom preset that the server understands. A preset is only an internal transfer structure. The user does not create it separately.

**What is saved**

- The persistent layer saves only `llm.providers`. Each model entry can have a `reasoningEffort` default.
- When you add a provider, add models in bulk, or edit an existing model, you can set this for each model. Import and export keep this field.
- `X-Slot-Config.customPresets` holds the model definitions that the current request builds temporarily from the providers.
- The model defaults are part of the model identity in a request. When the same model reference is used with different settings in different requests, the configs are not mixed.

**`ref` and `modelId`**

- `ref` is the identity of this config. `modelId` is only the model ID sent to the provider.
- One connection can save several configs with the same `modelId`. Each one has its own name and thinking level. For example, "Fast tools / thinking off" and "Detailed narrative / thinking on".
- When you add a model, an entry is reused only if the model ID, name, and thinking settings are all the same.
- Copying a config creates a new `ref`. Editing the name or the thinking setting does not change `ref`.
- An import requires that the normalized `ref` be unique across all connections. If there are duplicates, the whole batch is rejected. Entries are not merged by model ID.

**Interface behavior**

- On the "Providers & Models" page, you can copy a config and edit its name. The thinking setting saves automatically.
- Model Roles, plugin bindings, and the session summary show the config name and the thinking setting.
- The main narrative, agent plugins, function plugins, and memory tasks all inherit the chosen model's defaults through the same request config chain. You do not have to set them for each role. An explicit override on a role still takes priority over the model default.
- At the moment, the `automatic` level is used for Qwen. The interface shows "Thinking on", and it sends `enable_thinking: true`. It does not mean "decide on or off for each task".

**Adding the first provider**

- The first time you create a provider and a model by hand, if `story` and `plugin` have no explicit assignment, the settings page binds both roles to this model. This way, story and plugin tasks can run right away.
- When you add a provider, you can pick one of the [built-in providers](#built-in-providers-and-protocols) from the list. The dialog fills in its ID and official address, and it uses that provider's own protocol. Choose "Custom provider" to fill in everything by hand.
- A built-in provider uses the framework's built-in official address and protocol even if you leave `baseUrl` empty. An address that the user fills in always takes priority.

**Two ways to connect Google**

- `google` uses `google-generative-ai-v1` and `https://generativelanguage.googleapis.com/v1beta` by default. Its key name is `GOOGLE_API_KEY`. The protocol option in settings is shown as "Google Gemini".
- To use Google's OpenAI-compatible interface, explicitly choose `openai-chat-v1`, and set the address to `https://generativelanguage.googleapis.com/v1beta/openai`.

**Model IDs are sent as written**

A model ID is an opaque string. It is not trimmed or rewritten when a request is sent. For example, `openai/gpt-5.6-sol` and `deepseek/deepseek-v4-flash` under the provider `openai` are both kept as they are.

When Covel looks up model capabilities, it tries these matches in order. A match is used only to show capabilities and prices:

1. The full ID;
2. The ID with the outermost routing prefix removed, when that prefix is the same as the current provider;
3. The model name after the last `/`;
4. The longest known prefix of a model with a version suffix;
5. The conservative default capabilities of the API protocol.

**Prices**

- When a model is matched to upstream model data through an aggregator provider, its price is marked "reference price". The real cost is what the current provider bills.
- Each provider's price multiplier is `1` by default. It accepts positive decimals such as `0.1` and `2.5`. The cost panel for debugging calculates the estimated settlement price as "model reference price × provider multiplier".
- A model that is not identified exactly is never guessed to accept image input. You can override its capabilities by hand in "Model Roles".

## Thinking strength

The "Generation" page identifies the thinking levels by the upstream vendor name in the model ID. For example, if the provider is `openai` and the model ID is `deepseek/deepseek-v4-flash`, it still uses DeepSeek's `off / high / max` levels. The options depend on the model's capabilities. The page does not assume that every vendor's strength levels are equivalent.

In `llm.toml`, use `reasoningEffort` to set the default level of a model:

```toml
[covel.story]
provider = "qwen"
model    = "qwen3.8-flash"
baseUrl  = "${QWEN_BASE_URL}"
protocol = "openai-chat-v1"
reasoningEffort = "disabled"
```

- The values are the same as in the interface and in the runtime's `llm.reasoningEffort`.
- You write one general level, and the adapter translates it into each vendor's own field. This works like the top-level [`reasoning`](https://ai-sdk.dev/docs/ai-sdk-core/reasoning) option in the AI SDK.
- If a model does not support a level, a warning is logged, and the provider's default behavior is used.
- This is the same default value as the thinking level you set for the model on the "Providers & Models" page.
- If you need to write a native field directly, use `providerOptions` below instead.

**Order of effect**

Explicit override on the role → model / TOML default → task default → provider default.

- An empty role means "inherit". An empty model means "decided by the task".
- Writing `provider-default` explicitly means "let the provider decide". It clears the inherited thinking request fields and skips the task default. It does not mean "not configured".
- The task default for memory extraction is still thinking off. A level set on the role or the model takes priority.
- The interface shows inherited values and explicit overrides separately. It does not treat the provider's documented default level as the actual parameter for this task.

`REASONING_EFFORT_VALUES` and `ReasoningEffort` are defined in `@covel/shared`. The front end's saving, the request entry check, and the provider adapter all share them. Model parameters are sent only through allowlisted fields. Arbitrary imported JSON is never merged into a provider request.

**Conversion by protocol**

The shared `reasoningEffort` is converted according to the API protocol:

- **OpenAI Chat and compatible APIs**: `reasoning_effort`.
  - DeepSeek also sends `thinking.type`.
  - Qwen's on/off switch uses `enable_thinking`.
  - Qwen3.8 Chat's native levels `low/medium/xhigh` use `reasoning_effort`.
  - The confirmed Qwen3.5–3.7 Max/Plus/Flash models use `thinking_budget` presets (2048/8192/16384). The interface states the token numbers. A budget preset is not a native level of the provider, and the actual use can be less than the budget.
  - An explicit level clears the inherited budget, so Qwen3.8 does not send both kinds of parameter.
- **OpenAI Responses**: `reasoning: { effort }`.
  - A recognized GPT-5 / o3 / o4 model also requests `summary: "auto"`. An explicit summary setting is kept.
  - Whether the provider stores the conversation is described in [Responses does not let the provider store the conversation](#responses-does-not-let-the-provider-store-the-conversation).
  - Function tools carry `strict: false`. Reason: without this field, this API treats tools as strict mode (the Chat protocol does the opposite). Then every optional parameter becomes required. The model fills each optional parameter with an empty value, and the tool then rejects the call.
- **Anthropic Messages**: `output_config: { effort }`.
  - For a recognized adaptive-thinking model that has a level chosen, `thinking.type: "adaptive"` is enabled. The default request also asks for a visible summary with `display: "summarized"`.
  - A model that cannot turn thinking off does not show the off option.
  - For Claude requests, sampling parameters that conflict with thinking are removed. When thinking is off, the inherited effort is cleared, to avoid a 400 error from the combination.
  - DeepSeek's Anthropic-compatible API also sends `thinking.type`.
- **Gemini native `generateContent`**:
  - Gemini 3 uses `generationConfig.thinkingConfig.thinkingLevel`. Gemini 2.5 uses `thinkingBudget`.
  - 3 Pro has only low and high. 3.1 Pro has low, medium, and high. 3 Flash, 3.5/3.6 Flash, and 3.1/3.5 Flash-Lite have minimal, low, medium, and high. 3.7/3.8 Flash has low, medium, and high.
  - 2.5 Pro cannot be turned off. For 2.5 Flash and Flash-Lite, `none` becomes a budget of 0.
  - For 2.5, low, medium, and high are the applied budget presets of 1024, 8192, and 24576 tokens. They are not Google's native levels.
  - For an unknown Gemini model, no level is guessed.
  - Google's OpenAI-compatible API still sends `reasoning_effort`. On 3.1 Pro, `minimal` maps to low. On 2.5, it maps to 1024 tokens. This does not mean the native protocol supports a `minimal` level for these models.

**Levels recognized now**

| Vendor      | Levels                                                                                                                                 |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| OpenAI      | `none/minimal/low/medium/high/xhigh`. GPT-6 and later models are recognized by name, and also have `max`. No default level is recorded |
| Anthropic   | `low/medium/high/xhigh/max`, depending on the model                                                                                    |
| Gemini      | A subset limited by model and protocol. See above                                                                                      |
| xAI         | `low/medium/high`                                                                                                                      |
| DeepSeek V4 | `high/max`                                                                                                                             |
| Qwen        | Off / on, native levels, or budget presets                                                                                             |

The interface lists only the subset that the target model is known to support. A model that is not recognized uses the provider's default behavior. The Gemini levels are based on the [Google thinking guide](https://ai.google.dev/gemini-api/docs/generate-content/thinking) and the [OpenAI compatibility mapping](https://ai.google.dev/gemini-api/docs/openai).

#### Level data

"Which model supports which levels" is data, not code.

- The data is in `packages/ai-provider/src/capability/reasoning-models.data.json`. It lists, for each provider family (`deepseek`, `anthropic`, `google`, `xai`, `qwen`, `openai`, `compatible`), regular expressions for model names and the matching levels.
- The code (the wire for each protocol in `reasoning-effort.ts`) only writes the chosen level as that protocol's request field.
- The structure matches the AI SDK. The capability is first resolved from the model name, and then the protocol layer writes the parameter. The difference is that the capability lives in a data file.

Fields for each family:

| Field              | Meaning                                                                                                                                                                                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model`            | A lowercase model ID that matches any one of the regular expressions belongs to the family. Families are checked in the order they appear in the file                                                                                                         |
| `provider`         | When no family's `model` matches, the provider ID is checked                                                                                                                                                                                                  |
| `known`            | Names of levels confirmed as supported. When a family has `known` or `tableFlag`, a model must pass one of them before its `rules` are read                                                                                                                   |
| `tableFlag`        | A model that the LiteLLM model table marks as `reasoning` also passes. This applies only when the query includes the model-table feature, which is the level list on the settings page. The request path checks only by name                                  |
| `thinkingAlwaysOn` | A model that cannot turn thinking off. It does not offer `disabled`                                                                                                                                                                                           |
| `rules`            | The first rule that applies is used, in order. `match` (one or more regular expressions, all must match), `protocols` (the protocols it applies to, where `""` means no protocol is specified), `whenThinkingAlwaysOn`, `default`, `levels`, `parameterStyle` |

- An item in `levels` is a level name, or `{ "value", "budget", "protocols" }`. `budget` means this level is sent as a thinking-token budget. `protocols` means it is offered only on these protocols.
- `parameterStyle` picks one of several ways to write a family. For Anthropic it is `adaptive` (which also sends `thinking.type: "adaptive"`). For Qwen it is `effort` (which also sends `reasoning_effort`).

**Why it is maintained by hand**

The LiteLLM model table provides only one flag, `reasoning`. Its fields such as `supports_*_reasoning_effort` and `reasoning_effort_levels` currently cover only some OpenAI, Anthropic, and a few other models. Gemini has only a few entries. Qwen, DeepSeek, and xAI have none. It also does not include budget presets or the differences between protocols. So the level data is maintained by hand, and the weekly model-table refresh does not change it.

A refresh regenerates `packages/ai-provider/tests/__snapshots__/reasoning-characterization.snap.txt`. This file records the level and request fields that each model name gets under each protocol. Its diff is a list of "which category a new model falls into".

**Add levels for a new model without waiting for a release**

Put a `reasoning-models.json` in the same format in the user config folder (on desktop, `~/.covel/`, which is `COVEL_USER_CONFIG_DIR`). The server reads it at startup:

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

- The rules in this file are read before the built-in rules, and they do not go through `known` / `tableFlag`. So every rule must have a `match`.
- `model`, `provider`, and `thinkingAlwaysOn` are added to the built-in lists. `known` and `tableFlag` cannot be set here.
- If the file is invalid, a warning is logged, and only the built-in data is used.
- A deployment that does not set `COVEL_USER_CONFIG_DIR` (source development, Docker) does not read this file.

A model that no rule matches keeps its current behavior:

- A model that belongs to a named family does not send thinking fields.
- A model in the `compatible` family (its name and provider do not belong to any family) sends the chosen level as is. If a rule was added for a model in this family, only the levels listed in the rule are sent.

### Responses does not let the provider store the conversation

Every request on the Responses protocol carries `store: false` by default. The provider does not keep the prompt or the answer of that request. The player's conversation stays only in Covel's own storage.

OpenAI's Responses API stores data for a period when this field is absent. So Covel does not rely on the provider's default. The Chat protocol is not affected: it sends `store` only when the role sets it.

When nothing is stored, the provider cannot look up the reasoning item of the previous answer by its ID. When a tool call continues, Covel must send it back as it was:

- If the request does not turn thinking off (`reasoning.effort` is not `none`), Covel adds `include: ["reasoning.encrypted_content"]`. It does not check the model name. Other values already in `include` are kept.
- When a call continues, the output items of the previous answer are put back into `input` in their original order.
  - A reasoning item with `encrypted_content` is sent back as is.
  - A reasoning item without `encrypted_content` is not sent back. The other items of the same answer are sent back with `id` removed, so the provider does not look up an ID it did not store. In this case the model cannot see its earlier thinking, but the tool call and its result are still complete.
- If the model does not accept encrypted reasoning (it returns 400, with the error pointing to `include` or mentioning encrypted content), Covel removes that item and sends the request again once. It also remembers this address and model in this process, and later requests do not include it. Other 400 errors are not retried.
- In a streamed answer, if `output` is empty in the final event, Covel builds the continuation items from the `response.output_item.done` events it received one by one earlier.

When the provider does need to store data (for example, so you can view the answer in the provider's console), write `store = true` in the role's `providerOptions` (see [Provider parameters](#provider-parameters)). Then Covel does not request encrypted reasoning. The continuation items keep their original IDs, and the provider looks them up by ID.

Covel does not use `previous_response_id` itself. Each request carries the full context. A config that passes `previous_response_id` itself through `extraBody` must also set `store = true`. Otherwise the provider cannot find that answer.

## Media wire routing keys (`providerRequestMetadata`)

The request format for images, speech synthesis (TTS), and speech transcription (STT) is decided by a **wire**. A wire is the request and answer format of one vendor. A role selects its wire with a routing key in `providerRequestMetadata`:

| Routing key         | Tag that applies | Built-in wire (default in bold)                                                                                                                                                                                                         |
| ------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `imageWire`         | `image`          | **`openai-images`**, `dashscope-wan` (DashScope's native image interface: wan2.x uses asynchronous task polling. The `qwen-image*` series, including qwen-image-3.0-pro, switches automatically to the synchronous multimodal endpoint) |
| `speechWire`        | `speech`         | **`openai-speech`** (`POST /audio/speech`)                                                                                                                                                                                              |
| `transcriptionWire` | `transcription`  | **`openai-transcription`** (`/audio/transcriptions`)                                                                                                                                                                                    |
| `musicWire`         | `music`          | No built-in wire and no default. Music providers have no common request format, so a plugin registers it                                                                                                                                |

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

**Music**

Music generation (`ctx.music.generate()` / `gateway.composeMusic`) resolves the role named `music`. If it is not found, it falls back only to other roles with `tag = "music"`. A speech synthesis role also outputs audio, but it is never used to generate music.

If a role has no `musicWire`, or names a wire that is not registered, the call returns `CONFIG_ERROR` before any request is sent. Right now, neither the kernel nor the built-in plugins provide a music wire. This role can be used only after a plugin registers one:

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

**Rules**

- The routing key is removed before the wire is used. It does not appear in the request body sent to the vendor.
- If a wire ID is not registered, generation throws `CONFIG_ERROR`. The error message includes a fix. The system does not quietly switch to another wire.
- A wire a plugin registers serves only sessions that enable that plugin, by the same rule as a text protocol. Another session that uses it gets `CONFIG_ERROR`, and the message names the plugin to enable.
- A plugin registers a custom wire in its `entry` module with `covel.registerWires({ image?, speech?, transcription?, music?, text? })`. The frontmatter `wires` field is still accepted, but it is deprecated. See [plugin-extensions.md § Models and new protocols](./plugin-extensions.md#models-and-new-protocols).
- For how wires relate to MediaStore, see [media-store.md](./media-store.md#media-wire-registries-image--speech--transcription--music).

## Provider parameters

`generateText`, `generateObject`, `streamText`, and the roles in TOML all accept `providerOptions`. It is grouped by namespace. The namespace key is the actual provider ID or protocol ID.

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

- A single resolution applies the protocol namespace first, and then the provider namespace.
- Only the namespace of the current target is checked. The config of a fallback target takes effect only when the switch to it actually happens.

**Typed fields**

| Field                             | Description                                                                                                                                                                                                   |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reasoningEffort`                 | Thinking level                                                                                                                                                                                                |
| `reasoningSummary`                | Used only for Responses                                                                                                                                                                                       |
| `parallelToolCalls`               | Whether tools are called in parallel                                                                                                                                                                          |
| `store`                           | Whether the provider stores the data. See [Responses does not let the provider store the conversation](#responses-does-not-let-the-provider-store-the-conversation)                                           |
| `seed`                            | Applies to the Chat and native Gemini protocols                                                                                                                                                               |
| `user`                            | User identifier                                                                                                                                                                                               |
| `promptCacheKey`                  | See [Prompt cache key](#prompt-cache-key)                                                                                                                                                                     |
| `thinking`                        | Anthropic. To enable thinking, write `{ type: "enabled", budgetTokens: 2048 }`. It is converted to `budget_tokens` when sent                                                                                  |
| `thinkingConfig`, `cachedContent` | Used only for the native Gemini protocol. `thinkingConfig` can set `thinkingBudget` or `thinkingLevel` (choose one), and `includeThoughts`. The values must be within the range supported by the target model |

- If a known field has an invalid value, a non-retryable `CONFIG_ERROR` is thrown before the request.
- An unsupported or unknown field is ignored, and it is recorded in `diagnostics.warnings`.
- Generation parameters are also checked. Numbers must be finite, sampling values must be within range, and the output limit must be a positive integer.

**Merge order**

1. The role's free-form metadata
2. The role's namespace settings
3. This call's free-form metadata
4. This call's namespace settings
5. The generation parameter limits of the role and the runtime

`extraBody` can carry native fields that do not have a type yet. These framework fields are protected and cannot be overridden through it. If they are written, they are omitted and a warning is produced: `model`, `messages`, `tools`, `stream`, the response format, the output budget, and for Gemini `contents`, `systemInstruction`, `generationConfig`, and so on.

**Relation to `providerRequestMetadata`**

- Free-form `providerRequestMetadata` can still be used.
- Native fields in a call are sent only to the original provider, protocol, and endpoint. When a fallback changes any of them, these fields are omitted and a warning is recorded.
- The general `parameterOverrides` still apply. The config of each fallback role still applies on its own.
- When you need separate settings for several providers, use each one's `providerOptions` namespace.
- Media wire routing and the `resolveSlot().metadata` convention are unchanged.

This interface is based on [AI SDK provider options](https://ai-sdk.dev/docs/foundations/provider-options) and its namespace validation. It keeps Covel's role binding and protocol adapters.

### Prompt cache key

OpenAI uses a hash of the start of the prompt to route a request to a machine. The `prompt_cache_key` in a request is mixed into this hash ([OpenAI documentation](https://developers.openai.com/api/docs/guides/prompt-caching). The matching option in the AI SDK is `promptCacheKey`). Without it, two consecutive turns of the same runtime may land on different machines, and even with the same prefix, the cache is not read.

**What the key is**

Every model request of an agent runtime carries a key: `covel-` followed by the first 32 hexadecimal characters of the SHA-256 of the session ID and the runtime ID (`promptCacheKeyFor`, `packages/runtime/src/llm/prompt-cache-key.ts`).

- Requests from the same runtime in the same session have the same key, so they share one prefix.
- Different runtimes and different sessions have different keys.
- The key does not contain the raw session ID, and it does not contain any text from the player. Its length is within the 64 characters that OpenAI allows.

**Who receives it**

The key is sent only on the two protocols `openai-chat-v1` and `openai-responses-v1`, and by default only to `api.openai.com`. This field belongs to OpenAI. A service that is compatible with OpenAI may return 400 on a field it does not know. A rejected request costs more than a cache miss, so other addresses do not receive it by default.

If a relay service that forwards to OpenAI does pass this field along, turn it on in the role's `providerOptions`. Writing `false` stops it from being sent even to `api.openai.com`:

```toml
[covel.story.providerOptions.myrelay]
promptCacheKey = true
```

**Other rules**

- To use your own key, write `prompt_cache_key` in `extraBody` or `providerRequestMetadata`. It overrides the key that the framework generates.
- Requests that a function runtime sends through `ctx.gateway.generateText` also carry a key. The host generates it from the session ID and that runtime's ID by the same rule. A `promptCacheKey` passed in by the plugin is replaced.
- To read the cache, the start of the request must be unchanging content (instructions and stable data). The changing part goes at the end, and the prefix must be at least 1,024 tokens.
- `generateObject`, history compression, memory vector retrieval, world generation, and translation do not carry a key. The reasons: compression uses a short fixed instruction and its calls are far apart in time. Vector retrieval has no prompt cache. World generation and translation have no session, so only a retry would repeat a prefix.

**`lateSystemAsUser`**

This is an option in `providerOptions` for `openai-chat-v1` and `openai-responses-v1`. It defaults to `false`.

When it is on, each system message after the first conversation message is sent as a `user` message instead. It is wrapped in a `<system-instruction>` tag. Its position and wording do not change.

```toml
[covel.story.providerOptions.myrelay]
lateSystemAsUser = true
```

Why it is needed: the framework puts content that changes every turn (data blocks and this turn's rules) in a system message after the history. Some relay services move all system messages to the front, or convert the request into a protocol that has only one system position. In that case, text that changes every turn lands before the history, and the whole history falls outside the cache.

- Measured (a local Codex-style relay, narrative runtime, 8 turns): on the first request of each turn, cache reads rose from 3,584 tokens (the relay's own fixed instructions) to 8,704. The share of input rose from 22% to 55%. Across all narrative requests, the share rose from 54% to 75%.
- This is a measurement on that one relay only. `api.openai.com` and other compatible services were not tested, and there is no evidence that they move system messages.
- Cost: the role the model sees changes from system to user. The weight of turn rules and instructions written by plugins (such as the dice-roll steps) may shift slightly. No quality comparison has been done.
- The Anthropic protocol always works this way, and this option does not affect it.

On `google-generative-ai-v1`, the default for the same option is the opposite:

- Not set, or `true`: system messages after the first conversation message stay in place. They are sent as user text with a `<system-instruction>` tag, inside `contents`. Only the system message at the start goes into `systemInstruction`. Adjacent plain-text messages with the same role are merged into one. A function response always follows its function call and takes up a user content entry on its own. For the rules, see [Prompt structure](./prompt-structure.md).
- `false`: all system messages go into `systemInstruction`, with one content entry per message. The cost is that text that changes every turn is placed before the history, so the prefix cache breaks from the start on every turn.

```toml
[covel.story.providerOptions.google]
lateSystemAsUser = false
```

The default shape on Gemini has been verified only on a local relay that imitates the Gemini interface. It has not been verified on Google's endpoint. If Google's endpoint rejects the request, writing `false` is the fallback. This option is read only by the adapter and is never sent to the provider.

## Structured output

Before it sends a request, `gateway.generateObject({ schema, messages })` converts the input shape of the Zod schema into JSON Schema. Each protocol passes the schema in a different way:

| Protocol      | How it is done                                                                         |
| ------------- | -------------------------------------------------------------------------------------- |
| Responses     | Puts the full `name` / `schema` into `text.format`                                     |
| OpenAI Chat   | Uses the compatible `json_object` mode, and passes the schema in a system message      |
| Anthropic     | Passes the schema and the JSON output instruction in a system message                  |
| Gemini native | Sends `generationConfig.responseMimeType: "application/json"` and `responseJsonSchema` |

- An instruction on Chat and Anthropic does not guarantee that the model follows the schema. All protocols still check the answer with `safeParse` against the original Zod schema after it comes back. They also apply default values and transforms. Custom refinements are checked at this step too.
- An input type that cannot be converted to JSON Schema returns a non-retryable `CONFIG_ERROR` before any network request.
- If the model returns something that is not JSON, or an object that does not match the Zod schema, the call returns `SCHEMA_VALIDATION_FAILED`.
- The schema instruction keeps the existing Anthropic cache segments. It also avoids inserting again a schema that the runtime already provides.

`gateway.generateText` and `gateway.streamText` both accept `responseFormat`. It is passed to the adapter of each actual call, including fallback models. Streamed output is still text deltas. `responseFormat` does not provide incremental object parsing, and it does not replace the caller's check of the complete result.

## Provider streaming responses

Every agent runtime uses streaming whenever the adapter offers a streaming interface. Only the story runtime forwards text deltas to the player's screen. This leads to these rules:

| Situation                                                                               | What happens                                                                                                                                                                                   |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The stream breaks after some output has already arrived                                 | The story runtime does not retry. Other runtimes discard the partial output and retry according to `maxRetries`                                                                                |
| The result is cut off by `length` / `max_tokens`                                        | It cannot count as a success. It is retried once. If it is cut off again, it fails with an error that says to raise the output limit. It does not switch to a non-streaming call to start over |
| The stream fails before any output, and the retries are used up                         | Switches to one non-streaming call                                                                                                                                                             |
| The provider clearly rejects the request itself (401, 400, or a config or schema error) | Does not switch to a non-streaming call, because the same request would fail the same way                                                                                                      |
| An HTTP 200 response carries a provider error                                           | Keeps the message and the code/type. A definite rejection does not turn into an empty, retryable error                                                                                         |

Other rules:

- Before a call, a fallback model checks again the actual messages, tools, structured output schema, and how much window the output reservation needs. A target that does not fit does not receive the request.
- Capability resolution first picks an exact match from the model database, and only then considers a prefix match from the curated table. This avoids mistaking a speech sub-model for a text model.
- When a runtime turns thinking off by default, a known model uses the off value it supports. A model that cannot turn thinking off uses its lowest level, and a diagnostic is recorded. An unknown compatible model does not get thinking fields sent automatically. An explicit user parameter still takes priority.
- Newer OpenAI reasoning and GPT models use `max_completion_tokens`. Anthropic models that do not accept forced tools or turning thinking off have their requests narrowed to match their capabilities.
- Built-in image and speech generation is not automatically sent again at the HTTP layer. On a timeout or a dropped connection, the client cannot tell whether the upstream has already generated the result. The retry policy for text calls is not affected by this rule.

### Connection tests and failure reasons

A model API can fail in more ways than an ordinary URL. Keys, balance, model names, and provider load each need their own handling. When a connection test (`POST /api/ai/ping`) or a model list read fails, the result gives a category, `errorKind`, in addition to the provider's own words. The interface shows what to do for each category:

| `errorKind`    | Meaning                                                              | Basis                                                                                                                            |
| -------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `unreachable`  | Cannot connect: service not running, wrong address or port, DNS, TLS | No HTTP status. A connection error code (`ECONNREFUSED`, `ENOTFOUND`, and so on) or a certificate error                          |
| `timeout`      | Connected, but no answer in time                                     | A timeout error code, an exhausted request budget, 408, 504                                                                      |
| `auth`         | The key is invalid, or it has no permission to use the model         | 401, 403                                                                                                                         |
| `quota`        | Balance or quota is not enough                                       | 402. Or the provider's error code or text says the quota is exhausted (OpenAI uses 429 `insufficient_quota`, Anthropic uses 400) |
| `rate_limited` | Too many requests                                                    | 429                                                                                                                              |
| `not_found`    | The address path or the model ID does not exist                      | 404                                                                                                                              |
| `bad_request`  | The provider rejected the request itself                             | Other 4xx, most often a protocol or parameter mismatch                                                                           |
| `overloaded`   | The provider is overloaded right now                                 | 503, 529 (Anthropic)                                                                                                             |
| `server`       | An internal error at the provider                                    | Other 5xx                                                                                                                        |
| `refused`      | The provider refused to answer                                       | Refusal / content filter                                                                                                         |
| `config`       | The model config cannot make this call                               | A config error, or the address was rejected by an outbound rule                                                                  |

When a connection fails, `error` gives the underlying cause (for example `connect ECONNREFUSED 127.0.0.1:11434`), not a general `fetch failed`. The classification is done by `classifyProviderFailure` in `@covel/ai-provider`; the type of the kinds, `ProviderFailureKind`, is in `@covel/shared`.

A 429 counts as an exhausted quota only by its error code, never by its text: OpenAI's ordinary rate-limit message links the billing page too.

`quota` and `auth` are account failures, as `isAccountFailure` in `@covel/shared` decides. Sending the same request to the same provider again only fails the same way, so neither the HTTP layer nor the runtime sends it again; only a fallback model the player configured is tried.

A connection test picks its probe by model type:

- Text model: sends one minimal streaming request. The time until the first piece of body text or thinking content counts as the time to first token.
- Evaluation model: sends one evaluation request.
- Embedding model: sends one vector request.

A test sends only one HTTP request. It does not retry at the transport level, and it does not switch to a fallback model. So the report is the result and the time of that one request.

### Stream format and end

The four built-in text protocols share one SSE frame parser:

- It supports LF, CRLF, and CR line endings, including a CRLF that a network split in the middle.
- The space after `data:` is optional. One event can have several `data` lines. Their content is joined with newlines before the JSON is parsed.
- An event must end with a blank line. When the stream ends, an unfinished event is discarded.
- When `[DONE]` arrives, or the caller stops reading early, the parser cancels the rest of the response body and releases the reader. This keeps a background connection from holding resources.

For the format rules, see the [WHATWG SSE specification](https://html.spec.whatwg.org/multipage/server-sent-events.html#event-stream-interpretation).

A text stream must carry the end marker of its own protocol:

| Protocol      | End marker                                                                                                |
| ------------- | --------------------------------------------------------------------------------------------------------- |
| Chat          | A non-empty `finish_reason`                                                                               |
| Responses     | `response.completed` / `response.incomplete`                                                              |
| Anthropic     | `message_stop`                                                                                            |
| Gemini native | The candidate's finish reason from `streamGenerateContent`. `[DONE]` cannot be used to tell that it ended |

- For Chat, Responses, and Anthropic, an EOF or `[DONE]` alone does not mean the model succeeded.
- An error inside the stream, `response.failed`, and a missing end marker all throw a provider error.
- If an error happens after some text, thinking, or a tool call has already arrived, the runtime does not save the result as a success. It also does not retry and then join the two parts together.
- A temporary error with no output at all can still be retried or switched to a fallback model under the existing policy.

### Finish reasons, diagnostics, and refusals

**A unified finish reason.** In the return value of `generateText` and `generateObject`, and in the `done` event of a stream, `finishReason` is the unified reason. Its values do not depend on the protocol:

| Value            | Meaning                                |
| ---------------- | -------------------------------------- |
| `stop`           | Ended normally                         |
| `length`         | Cut off by the output or context limit |
| `tool_calls`     | The request calls a tool               |
| `content_filter` | Blocked or refused by the provider     |
| `error`          | Failed                                 |
| `other`          | A reason the table does not cover      |

The provider's own words (for example Anthropic's `end_turn` / `max_tokens` / `tool_use`) are kept in `rawFinishReason`. There is only one mapping table, `unifyFinishReason` in `@covel/shared`. The gateway applies it at the exit point, and the runtime and world generation read the same table. The approach is the same as the `unified` / `raw` of the AI SDK. A plugin that gets values through `ctx.gateway` also gets the unified values.

**Only `stop` and `tool_calls` mean the answer is finished** (`isCompleteFinishReason` in `@covel/shared`). `other` is not a normal end: the provider did not say why it stopped (for example Anthropic's `pause_turn` or DeepSeek's `insufficient_system_resource`), and the answer may stop anywhere.

- Story: the text already written is kept. `llm.responded` carries `finishReason: other` and `rawFinishReason`, the app says that this part is not finished, and the player can retry the turn. A story cut at the output limit (`length`) is kept too, with a different notice.
- Every other answer in the runtime (one with tool calls, one that must be JSON, a runtime that does not keep cut text), world generation and the history summary: the call fails. No half result is saved, and the call is not retried on its own.
- A function plugin gets `other` as it is through `ctx.gateway` and decides for itself. A background output should fail in the same way.

**Diagnostics.** The text and object return values of the four built-in text protocols, and the `done` event of a stream, can carry `diagnostics`. They include the provider's and request's warnings, URL and document sources, and citation positions. The runtime bridge and the LLM trace keep this information.

- `citations.location` tells apart "a position in the answer text" and "a position in the source text". An Anthropic document page number or a character offset in the original text must not be taken as an offset in the answer.
- A source records only protocol data that has already arrived. It does not mean that actively calling web search or file tools is supported.
- The `PluginRuntimeGateway` for function plugins also passes through `providerOptions` and the full returned diagnostics. On this path, the `gateway.responded` / `gateway.failed` traces keep the existing privacy rule. They record only the warning types, the counts of sources and citations, and the reason for a refusal, as they appear in `diagnosticsSummary`. They do not record citation text, source URLs, titles, or the full text of a refusal.

**Refusals.** A clear refusal or content filter throws a non-retryable `REFUSAL`. The reason for the refusal is kept in `error.details.diagnostics.refusal`. No fallback model is used.

**A failure still records the tokens it used.** A refusal, `finishReason: error`, an error body, or a stream that reaches EOF without its terminal event: when the provider reported usage before the failure, the error carries it (`error.details.usage`). The runtime writes it into the call's `llm.responded`; a call from a function plugin or an extension provider writes it into `gateway.failed`. The debug page counts it in usage and cost. When the provider reported no usage, `usage` is left out rather than written as 0. Low-level transport exceptions that bypass adapter completion checks may still omit earlier usage.

- Even if ordinary text or tool content already exists, an answer that contains a refusal cannot be recorded as a success.
- Streamed text may already have been delivered, but it will not produce a successful `done`.
- For the built-in text adapters, a complete tool call is delivered only after the final refusal check has passed.

The protocol regression tests use synthetic responses in `packages/ai-provider/tests/protocol-fixtures/`. They cover byte splits, tool arguments, unknown extensions, refusals, and citations. So they do not depend on a paid API, and they do not store real conversations.

### Model identity for vector calls

An embedding call can pass `expectedModelId` (`provider/model`) and `expectedConfiguration`. Before any network request, the gateway checks the model, address, protocol, and encoding format.

- The identity the server locks to a session is `provider/model#hash`. The hash covers the effective address, the protocol, and the embedding format. It does not include the key. The dimension cache is also isolated by this identity.
- The request-level model and key apply to embedding too, including the asynchronous ingestion that the request starts. They are not written to the session or to the shared credential config.
- Memory's `EmbedFn(texts, { sessionId, modelId })` must use the model identity locked to the session.
- Changing the current config cannot write another model of the same dimension into an old index. When the identity does not match, a query falls back to keyword search, and ingestion does not advance. After the original model config is restored, backfilling can continue.

> [!WARNING]
> When you switch the vector model, you must rebuild the development sessions and indexes. The system does not migrate them automatically. Data that already has wrong vectors mixed in must also be rebuilt.

## Audio requests

- The built-in `openai-speech` wire maps `SpeechSynthesisParams.format` to the provider request's `response_format`.
- The built-in `openai-transcription` wire uploads only the bytes in the `audio.data` view. It supports slices of `Uint8Array` and Node `Buffer`. It does not include anything else from the underlying shared buffer.
- The OpenAI image, speech, and transcription wires all remove the `parameterOverrides` that are used only for text generation. They keep each wire's own native media parameters.

## HTTP retry cleanup

This section describes how one model request retries at the HTTP layer, how long it waits, and the maximum number of sends.

**Cleanup**

- Before a retry, the HTTP tools of the provider and plugins cancel the body of a rejected response. They do not read the whole error stream into memory. A rejected redirect response is cancelled the same way.
- The wait for `Retry-After` can be cancelled. A very long finite wait is split into small pieces that a timer can handle safely. A wait that is not a finite number fails clearly, and it does not overflow into "retry immediately".

**Which answers are retried**

This matches the official OpenAI and Anthropic SDKs and the AI SDK:

- Retries 408, 409, 429, and 5xx.
- A 429 whose error code says the quota is used up (OpenAI's `insufficient_quota`) is not retried: the body is read first, and the answer goes back to the caller with that body unchanged.
- A `true` / `false` in the `x-should-retry` header from the provider takes priority over the status code.
- For the wait time, it reads the more precise `retry-after-ms` first (OpenAI, Azure), and then `Retry-After`.
- `Retry-After` accepts both whole seconds and an HTTP date. A date in the past retries immediately. An invalid value falls back to the backoff policy.
- If the provider asks for a wait longer than 60 seconds, or longer than the time left for this call, it does not wait. The answer goes straight back to the caller, is handled as a rate limit, and a fallback model can be used.

A refused connection, or one dropped before any answer (`ECONNREFUSED` / `ECONNRESET` / `EPIPE` / `UND_ERR_SOCKET`), is retried the same way as 429 and 5xx. It uses the same backoff, the same retry limit (3 in total for the two kinds together), and the same request budget. A restarting endpoint (most often a local proxy) recovers after a moment, so one runtime call should not fail outright. A timeout is not in this group. A streamed call that has already produced output is not retried.

**Request budget**

Gateway calls for text, objects, streams, evaluation, and embedding share one budget by default: at most 8 actual HTTP requests, and a 120-second total time limit.

- One logical call of a runtime creates only one budget. HTTP retries, fallback targets, and runtime retries all pass the same `requestBudget`.
- The execution budget of the runtime is still calculated by the existing policy. Queued concurrency keeps its existing quota compensation.
- Each actual call is bound by the execution budget, the logical total time limit, and the cancel signal. Queuing and backoff also count toward the logical total time.
- A stream that has already produced output is still not allowed to retry.
- When the budget runs out, it returns a non-retryable `REQUEST_BUDGET_EXCEEDED`.
- A caller can set a tighter or looser policy explicitly with `createLlmRequestBudget`, and pass it through `GatewayOptions.requestBudget` or the `LLMAdapter` parameters.

AI world creation (generate, revise, translate) works this way. Its answers are long, and some models produce output slowly. So it is limited by "time without a response", and each request passes an explicit 30-minute budget. It is not limited by the default 120 seconds. See `POST /api/ai/generate-world` in [api.md](./api.md).

**120 seconds is "time with no output"**

The default budget is limited by time without output:

- Each time the stream produces a piece of body text, a piece of reasoning, a tool call, or a fragment of tool call arguments, the time limit is extended to 120 seconds after that moment. The latest it can reach is 30 minutes after the budget was created.
- So the 120-second limit covers two things: the wait before the first output (including retries, backoff, and queuing), and the silence between two outputs. It is not the total length of a stream that keeps producing output.
- A non-streaming call has no progress signal, so it is still bound by the 120-second total time limit.
- A budget with an explicit `timeoutMs` or `deadline` stays fixed. A `deadline` is an absolute limit that no output can push back.
- To make an explicit budget also count time without output, pass `idleTimeoutMs` as well. You can also set the upper limit of the extensions with `ceilingMs`.

One model call of an agent runtime uses `max(120 seconds, the runtime's remaining time)` as its budget, and passes `agent.loop.idleTimeoutMs`. This way, the retries the runtime declares all have time to run:

- Before the first output, a streamed call is bound by `firstTokenTimeoutMs` and the runtime's time limit.
- After that, it is bound only by `idleTimeoutMs`. The time spent on output does not count toward the runtime's `timeoutMs`.
- `callTimeoutMs` applies only to non-streaming calls.

**Media and embedding**

- Media (images, speech, music, transcription) does not automatically use this budget. It keeps the time limits and polling policy of its own wire. For example, DashScope WAN can still poll every 2 seconds, up to 300 seconds.
- Media can take an explicit budget. In that case, every HTTP request counts, including polls.
- Embedding is one short request. Background vector writes and in-turn retrieval both call it, so it uses the same default budget as text calls. If the endpoint does not answer, the call ends after 120 seconds with `REQUEST_BUDGET_EXCEEDED`, and the memory layer does not retry it separately.
- The low-level HTTP tools use up only the budget passed to them.

**Observation data**

In addition to the existing `transportAttempt`, there are an optional `logicalAttempt` and `transportRetryReason` (`http-429` / `http-4xx` / `http-5xx` / `connection`). A 408, a 409, and other 4xx errors triggered by `x-should-retry` are recorded as `http-4xx`.

**Lifecycle hooks and custom adapters**

- Each notification stage of a lifecycle hook waits at most 1 second in total. If an ordinary hook throws or times out, a warning is recorded and the call continues. When a request is cancelled or its logical time limit expires, waiting stops right away, and no extra retry is triggered.
- When the budget expires, the gateway also stops waiting for a custom adapter that does not respond to the signal. A custom implementation should still use the signal to cancel its own low-level I/O.
- The framework's HTTP tools count requests just before they are actually sent. If a custom adapter uses its own network client directly, it should call the function below before it sends (when there is a budget). The framework cannot count HTTP requests inside it automatically.

```ts
assertLlmRequestBudget(config.requestBudget, {
  signal: config.signal,
  consumeAttempt: true,
});
```

## Changing the model and parameters after a failure

**What decides whether to retry**

- When a runtime retries the same target, it first reads the structured provider error's `code`, `statusCode`, and `retriable`.
- A failed config or schema check is not retried. A keyword in an error message cannot overturn a clear "not retryable" decision.
- An account failure (`quota` / `auth`) is not retried, even when the status is 429.
- When the gateway organizes errors, it keeps the "retryable" attribute of a known temporary network failure. Only an unknown third-party exception is judged by its message.
- A cancellation by the caller, or a stream that already has partial output, is still not allowed to retry. A fallback model switch follows its own separate rules.

**How a player handles a failed task**

1. The error details keep the `provider` and `model` that the failed request actually used, including the case where the final fallback model failed. Changing the config later does not change a failed target that was already recorded.
2. On the failed task, open "Change model / parameters". Go to the model role, and pick a provider and a model.
3. Expand "Generation parameters", and adjust the context window, the maximum output the model can produce, the output per call, temperature, sampling, and thinking strength. Capability fields can also be overridden through the "Edit Capabilities" entry. This includes model roles that are configured only in the front end.
4. Close the settings, and click "Retry this task". The request reads the current model and parameters again. The story that has been committed and other successful tasks are kept.

Notes:

- Both places use the same token editing component. The data is saved in `llm.capabilityOverrides` / `llm.paramOverrides`.
- The output limit in the model data is only a reference. It does not stop you from typing parameters that fit the settings range by hand.
- The maximum output limit and the input context window are two separate settings. Lowering the output does not delete the session history.

**Failure detection for non-streaming calls**

- Non-streaming text and object generation also rejects a provider error body or `finishReason: error`. Even if the HTTP status is 200 and the body can still be parsed, it is not reported as a success, and it is not handed to a function plugin to write into memory.
- Responses must be in the `completed` or `incomplete` end state. Queued, in progress, cancelled, failed, or missing status are all treated as provider errors.
- `incomplete` still maps to `length`, and it keeps the caller's existing truncation policy.
- A provider error with no output can fall back according to the configured fallback model policy.

**Cache prices**

A model's pricing can include `cacheReadPerMToken` and `cacheWritePerMToken` (the price in US dollars per million tokens). The pinned LiteLLM database carries explicit read and write prices, including the case where the price is zero. The debugging cost estimate prices these two parts separately. If a price is missing, nothing is priced, and the ordinary input price is not used in its place.

**Provider error codes**

After HTTP errors are organized, the provider's original `code` and `type` are kept in `details.providerCode` / `details.providerType`. Vector ingestion uses the explicit "input rejected" error code to split a failed batch in half, so that only the problem input is skipped. Authentication, config, and temporary failures do not move the cursor.
