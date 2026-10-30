# Prompt structure

This page explains how the request that Covel sends each time it calls the model is put together. It covers which content goes into the system prompt, which goes into the conversation messages, where each piece is placed, and what gets trimmed first when the budget is exceeded. Read it if you want to know what the model actually sees, if you want to make requests more likely to hit the provider's cache, or if you write a plugin that extends prompts.

There is only one entry point: `buildContext(params)`. It is asynchronous, and it decides whether to read this plugin's data based on the runtime's input declarations. The plugin body, the declared inputs, the lorebook, and the extension segments are assembled into `systemPrompt` and `messages` in `packages/context/src/prompt-assembler.ts`. The policies for memory content and history summaries are provided by plugins.

## 1. Build entry and history pipeline

| Entry                        | Purpose                                                                                                                                                                                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `await buildContext(params)` | Assembles the context. When it needs to read the `plugin-data` in the compiled `input.inject` (written by authors as `io.selfData`), it uses the `store` that is passed in. Injecting the hidden world data `_hidden.*` throws an error directly. |

During one execution, the history is handled in this order:

1. Read the part of `turn_messages` that has not been compacted yet, along with the statistics for all messages. The current player input stays in the execution journal for now, and it is written to the database only after the commit succeeds.
2. Run `prompt.history-transform@1` on a copy of the history. Each provider receives the result of the previous provider. This step does not change the messages in the database, and it does not change the counts used for scheduling.
3. Filter by the current runtime: remove the structured history output of other plugins, and remove runtime rows that have no text. Then assemble the actual system prompt, and merge in the summaries that have already been saved. A runtime that declares `agent.history.maxTurns` keeps only the visible messages from its last N turns (counted by `turnId`), and by default it does not merge summaries. Setting `agent.history.includeSummaries: true` keeps the summaries.
4. Attach the story text that this execution has already produced after the current player input (see [this turn's story text](#this-turns-story-text) below).
5. The first agent that uses the shared history view estimates, using this system prompt, whether compaction is needed. In the same turn, agents of this kind share one compaction barrier. After compaction succeeds, the history and summaries are loaded again, projected again, and the context is assembled again. A runtime that declares a history window does not trigger this barrier and does not wait for it.
6. Run `PostContextAssembly` and apply the budget. After that, each time after `PreLLMCall`, the budget is checked once more against the actual request.

### This turn's story text

Committed history goes only up to the previous turn. The messages of this turn are written to the database only after the execution commits. So the framework also puts the not-yet-committed parts of the execution journal into the conversation:

- The current player input.
- The story text already produced successfully by runtimes with `outputKind: story` in earlier stages.

The story text appears as an assistant message, in the same form it takes in the history of the next turn. After it comes a framework hint with the `user` role. The hint says the text was written in this turn and that the plot stops at its end.

Rules:

- Only results from **earlier stages** are taken. There is a barrier between stages, so their results are settled. Runtimes running in parallel in the same stage cannot see each other's story text. When needed, declare the dependency with `io.inputs`. Runtimes with no stage (event followers inside a turn) come after all stages.
- Only story text produced by **this execution** is taken. Results from a source turn that were carried in as seeds during a retry are not projected. Their text is already in the history.
- `agent.history.maxTurns` does not count this turn. Writing `0` still sends the current player input and this turn's story text.
- This story text and the ending hint belong to the current turn. When the budget is trimmed, they are protected together with the current player input. Messages the player inserts in the middle of a turn also count as part of the current turn. When a runtime resumes after being paused, the protected range is saved with the continuation (`currentTurnUserMessages`), and it stays the same as before the pause.

**The story text is sent only once.** When a `cardinality: one` input in `io.inputs` has a value that is entirely this story text (the built-in `narrative` and `narrator-output` bindings are of this kind), its `value` in `<runtime-inputs>` is replaced with one sentence that points to the message in the conversation. The full text is not repeated.

- `source` is kept as usual.
- `ctx.inputs` for a function runtime, and `ctx.inputSlots` read by tools, still have the original value.
- A value that only contains this story text (for example, an object with a `summary` field) is not replaced.
- For an execution retried after a commit, where the story text was not projected, the input keeps its original value.

**Why this is done.** Without this step, an agent that runs after the narrative reads a conversation that ends with "the previous turn's story text + this turn's player input". The model then takes the previous turn's ending as the present. The story text of this turn is in `<runtime-inputs>`, but that is one field of a data block, not part of the conversation. When the same runtime is retried after a commit, the history already contains this turn's story text. With this step, both cases read the same conversation.

### History compaction

`history.compact@2` is an extension point that allows only one provider (single).

- The framework handles the threshold, the validation of return values, and saving the summary and the message markers together, atomically.
- The default `history-compaction` plugin handles choosing a continuous history prefix, calling the summary model, and limiting the summary length.

Default policy:

- Protect the last two user turns and the last five messages.
- Choose a continuous prefix based on how much input the fast model can read, and generate a separate summary for the new history.
- The original text of old segments stays stable. Only when the total budget, or the "at most eight segments" limit, requires shrinking are the oldest continuous segments merged.
- The length of the summary actually generated decides whether to merge. When the window is small, the budget is split between "merge old segments" and "new segment".
- When a single source message cannot fit in the fast model, its original text is kept. The source message is not truncated.

| Budget         | Target                                    | Lower limit | Upper limit                                        |
| -------------- | ----------------------------------------- | ----------- | -------------------------------------------------- |
| Single segment | 25% of the source text's estimated tokens | 128         | The smaller of 4% of the effective window and 2048 |
| All summaries  | 12% of the effective window               | 128         | 8192, and not more than the window itself          |

The effective window is the smaller of the input capacities of the story model and the fast model (each one after subtracting the response reserve). The summary model's request still uses the fast model's own capacity. The compaction trigger window is also the smaller of the input windows of the story slot and the summary call slot.

The output is `{ summaries: [{ messageIds, replacesSummaryIds, content, focusSections, truncated? }] }`.

- Each segment can cover either new messages or old summaries, but not both.
- The framework accepts only message IDs from the same session that form a continuous, uncompacted prefix, and old summary IDs selected continuously starting from the oldest segment. Skipped, reordered, duplicated, and externally sourced entries are all rejected.
- The kept segments plus the new segment must satisfy the limits on total size, single segment size, and number of segments.
- A merge keeps the ID, starting turn, and creation time of the oldest segment being replaced. Only the selected old segments are deleted, and the corresponding messages are marked again. Kept segments do not change. All writes are committed in the same transaction.
- A provider must implement `@2`. There is no branch for the old contract. The shape of the saved summary records has not changed.
- A summary enters the context as a `user`-role data envelope, `<compacted_history>`, with XML escaping applied.
- The original messages are still kept in the log. Compaction only replaces how they are represented in the prompt.

Two safeguards:

- Before saving a generated segment, the transaction compares its message IDs with a bounded read of the "uncompacted prefix" in the database. A history transform that rewrote or reordered this prefix can still affect the prompt, but it cannot mark a set of non-adjacent messages as compacted. In that case, this compaction is skipped and the original history is left unchanged.
- When the summary model's reply ends with `length` / `max_tokens`, the reply is discarded before any history marker or summary is changed. A complete summary that is explicitly shortened because of the budget is still marked `truncated`.

### Images that have been shown

When an image is submitted (`asset.generate`, with `modality: "image"`), the framework writes the message the player sees. In addition, it writes one row of description in `turn_messages`.

- The `sourceType` of this row is `"system"`, and its `role` is `"user"`.
- The text is one sentence: an image was shown to the player here, and what the image contains.
- The description of what the image contains is taken from `meta.caption`. If there is none, `meta.prompt` is used. It is folded onto one line and capped at 600 characters. If neither exists, only the first half of the sentence is written.
- The description contains no media ID, session ID, time, or path.
- It sits in the history in the order of its submission time, and it is never rewritten afterwards. So every model that reads the history knows an image appeared here, and the prefix cache is not affected.
- Other media, such as audio, do not get this row.

More rules:

- **A description row does not count as a turn.** `agent.history.maxTurns` counts player turns. Description rows between turns in the window are kept with the window.
- **The image itself is not put into the history.** An agent with `outputKind: story` gets one extra user message after the turn context and before the current player input. The message lists the two most recent images in the uncompacted history (from oldest to newest, each with the same description of what it contains). Before each model call, the framework checks the model role that this call actually uses. If the model table or `llm.toml` `input` setting says the model accepts images, the bytes are read from the MediaStore and sent as inline base64 images. Otherwise the whole message is dropped, and only the description in the history remains. The decision is based on [model capabilities](./slots.md), not on the model name.
- **Limits.** At most 2 images per call. The raw bytes of one image must not exceed 3,750,000 (5 MB after base64, which is the tightest single-image limit among the providers). The formats are limited to PNG, JPEG, WebP, and GIF. Images that exceed the limit, have the wrong format, fail to read, or do not belong to this session are not sent, and the description stays. The budget estimate counts 1,500 tokens per image.
- **Why they are placed in the turn area.** This is a cost trade-off. If the images stayed in the history, then when an image slid out of the "latest 2" the old message would have to be rewritten, and the cache for all history after it would be invalidated. In the turn area, the history prefix stays the same from turn to turn. The cost is that each image is billed as uncached input on every call (about 800–1,600 tokens per image, about 3,000 tokens for two). Later requests in the same turn's tool loop can hit the cache.
- **Trace.** `llm.calling` and `providerRequests` do not record image bytes. They record only the length.

## 2. Sections and order

```text
systemPrompt
  Framework Preamble
  the localized body of the current runtime
  stable / session extension segments
  WorldInfo: before-plugin
  event catalog; activations that run within a stage
  WorldInfo: after-plugin
  turn extension segments that require pre-history

messages
  pre-history non-system extension messages
  history after summary substitution
  turn context: this turn's data blocks and turn extension segments (one system message)
  recently shown images (one user message; only for story runtimes whose model accepts image input)
  the current player input
  story text and ending hint produced by this execution (only for runtimes after the narrative)
  lorebook and extension messages inserted by depth
  post-history extension messages
```

Empty sections are skipped. System sections are joined with a blank line. Extension segments are placed in different positions depending on `position` and `volatility`:

| How the segment is declared                                | Where it goes                        |
| ---------------------------------------------------------- | ------------------------------------ |
| `position: system`, with `volatility` of stable or session | system prompt                        |
| `position: pre-history`, with the default system role      | system prompt                        |
| `position: system`, `volatility: turn`                     | [turn context](#turn-context)        |
| `position: pre-history`, with user or assistant role       | messages before the history          |
| `position: post-history`                                   | end of messages                      |
| `position: { depth: n }`                                   | inserted at a relative message depth |

Extension segments are first filtered by `audience`. Then they are sorted by `volatility` (stable, session, turn), `order`, the provider's plugin ID, and the segment ID, in that order.

- `audience: self` covers all runtimes of the providing plugin.
- `audience: story` matches runtimes that output story text.
- `audience: { contract: "narrative-engine@2" }` matches the output contract of a runtime.

### Turn context

Content that changes every turn is not put in the system prompt. It is combined into one system message, which comes after the history and before the current player input. It contains:

- This turn's data blocks: `io.selfData` and injected blocks, `<runtime-inputs>`, `<runtime-exports>`, and `<runtime-activation>` for event-triggered or manually triggered activations (with their payload). Activations that run within a stage are the same every turn, so they stay in the system prompt.
- Extension segments with `position: system` and `volatility: turn`, such as memory blocks and `<world-dimensions>`.

**The reason is the provider's prefix cache.** In one request, only the part that is identical to the previous request from the very first byte can hit the cache. If the data blocks are in the system prompt, the system prompt is different every turn. Then the whole history after it cannot hit the cache, and the longer the session, the more is wasted. Once they are moved out, the system prompt stays the same from turn to turn, and the cache can cover the history up to the previous turn.

How each provider's protocol sends this message:

- **Anthropic**: the content is still the system role in the context. Anthropic only puts the leading system messages into the top-level system. A turn instruction that comes after the history keeps its position, and it is sent as user content wrapped in `<system-instruction>`.
- **OpenAI Chat and Responses**: by default it is sent as system, unchanged. The slot's `lateSystemAsUser = true` makes them send it in the way described above (`lateSystemMessagesAsUser`, `packages/ai-provider/src/adapters/common.ts`). This is for relays that move system messages to the front. For the numbers and costs, see [prompt cache keys](./slots.md#prompt-cache-key). `packages/ai-provider/tests/late-system-messages.test.ts` fixes two things: when the option is on, two requests that differ only in the turn context are byte-for-byte identical up to the end of the history; and by default the roles are not changed.
- **Gemini native protocol** (`google-generative-ai-v1`): by default it is handled the same way as Anthropic. Details are in the next section.

Other rules:

- It is not placed at the end of the request. The request still ends with this turn's messages and the post-history segments. Reason: when the data block sits right next to the reply, a smaller model copies the data block's format into its tool arguments. For example, it wraps the arguments in the shape of an input block, or adds a closing tag after a field.
- Insertion by depth counts conversation messages. The turn context takes no position.
- When the budget is trimmed, the system message right before the protected turn is kept together with it, so it is not dropped. The estimate for the compaction threshold counts it together with the system prompt.
- `AssembledContext.turnContext` holds its content. It is an empty string when there is none.
- The tag names do not change. The text still writes `runtime-inputs.<binding>.value`.

#### How the Gemini native protocol sends it

- Only the leading system message goes into `systemInstruction`. It comes before `contents`. If text that changes every turn were put there, the prefix cache would break from the start.
- Later system messages stay in place, as user text with `<system-instruction>` inside `contents`. `contents` has no system role. This is the only way to keep their position.
- Adjacent plain-text content with the same role is merged into one item.
- Model content that has function calls is not merged with the content that follows it.
- A user content that holds a function response contains only the function response. The text that follows it (a player message, a correction hint, or an instruction placed between a function call and its response) is the next user content. So a function response always comes right after its function call, and it does not share a content item with text.
- Setting the slot's `lateSystemAsUser = false` restores the old approach: all system messages go into `systemInstruction`, and adjacent content is not merged. This is used when Google's endpoint rejects the request shape above. See [prompt cache keys](./slots.md#prompt-cache-key).

Cost: to the model, this text changes from a system instruction into user text. The weight of turn rules and plugin instructions may differ a little. No quality comparison has been done.

Basis, and the parts that have not been verified:

- The Google provider of the AI SDK does not support this kind of message. When it meets a system message after the conversation has started, it throws an error (`system messages are only supported at the beginning of the conversation`). It neither moves the message forward nor rewrites it. So sending in place is Covel's own rule.
- "A user content for the function response, then a separate user content for the text that follows" has two sources of support. First, this adapter sent "a tool result followed by a player message" this way even before in-place sending was introduced. Second, the Google provider of the AI SDK (`convert-to-google-messages.ts` in `@ai-sdk/google` 4.0.93) also sends a separate content item for a tool message and for the user message after it, without merging them. The AI SDK puts text and function responses into the same content in only one case (a tool result with a file, on older models). Covel does not send that shape.
- The request shape with instructions has been run through the tool loop (call, function response, then the instruction) only on one local relay that imitates a Gemini interface. It has not been verified on Google's endpoint, and the cache hit rate on Gemini has not been measured.
- `packages/ai-provider/tests/google-late-system.test.ts` fixes three rules (the prefix, merging of plain text, and a function response taking a content item by itself), as well as the old shape used when the option is `false`.

### Layout for bookkeeping runtimes

Bookkeeping agents that run after the narrative each send one request per turn. Together, these requests are larger than the narrative request itself. They declare `agent.history.maxTurns`, and their history window slides every turn. So the only things that can repeat across turns are the tool definitions and the system prompt. Everything else is new content each turn. For this kind of runtime:

- **Put data that stays the same for the whole game in the system prompt** (segments with `volatility: session`). Keep only the values that change in the turn context. The bundled `world-init` puts the dimension rules and schema in `<dimension-rules>` (a session segment). The current values go in `<dimension-values>` (a turn segment). A dimension definition without an `updateRule` is also placed in a segment that is stable within the session. Tracked values go in the turn segment.
- **When a record has parts that rarely change and parts that change often, split it into two blocks, with the rarely changing part first.** The roster `<existing-characters>` of the built-in `char-creator` has only the id, name, type, and description (session segment). Each character's current `fields` are in `<character-fields>` (turn segment). When one value of a character changes, the roster does not change.
- **Pick the history window by need.** The current player input and this turn's story text are always sent, and they do not count toward `maxTurns`.

  | `maxTurns`         | Suited to                                                                    | Built-in examples                                                |
  | ------------------ | ---------------------------------------------------------------------------- | ---------------------------------------------------------------- |
  | `0`                | Settles only this turn's facts; existing state comes from the data block     | `affinity`, `codex`, `npc-graph/extractor`, `world-time/advance` |
  | `1`                | Reads the story text directly; needs the previous turn to resolve references | `char-creator/character-tracker`, `world-init/dimension-tracker` |
  | `2` with summaries | For writing a recap of earlier events                                        | `guide`                                                          |

- **A runtime that builds its own request puts the fields that change least first.** The user message of `world-ir` is, in order: the character roster, the vocabulary, and this turn's story text.

`pnpm prompt:prefix <covel.db>` lists, for each runtime in a session, the size of the first request in each turn, how much of it is identical from the start to the previous turn's request, and where the first difference appears (see [section 5](#5-token-budget-and-cache)).

Cases that still make the request prefix change early:

- A template variable interpolated into the body has a different value (for example `{{ characters.npcs }}` or `{{ player.character }}`; for alternatives, see [section 4](#4-template-variables-and-the-data-boundary)).
- A lorebook entry triggered by a keyword has changed.
- A turn extension segment that requires `pre-history` has changed.
- The history has been compacted.

For a runtime that declares `agent.history.maxTurns`, the history window slides every turn, so it cannot hit the history cache across turns in any case.

## 3. Plugin extension segments

### Fixed instructions

Fixed instructions are written in `contributes.prompt` of the root `PLUGIN.md`.

- The host registers static segments automatically. The author does not need to declare an extension point.
- Static segments apply to this plugin. At load time they are frozen together with the language variants of the root file, and at run time the one for the locale is selected.
- Static segments do not get template interpolation. Runtime-private instructions that need template variables are written in the body of that runtime.

```yaml
contributes:
  prompt:
    - id: narrative-style
      content: Keep the narrator's perspective consistent.
      position: pre-history
```

### Dynamic content

Dynamic content is provided through `prompt.segment@1`. The root manifest declares `contributes.extensions`. The entry calls `provideExtension`, and the handler returns an array of segments:

```js
api.provideExtension("prompt.segment@1", "status", {
  async handler(input, ctx) {
    const status = await ctx.pluginData.get("status", "current");
    return status
      ? [
          {
            id: "current-status",
            content: JSON.stringify(status),
            position: "pre-history",
            audience: "self",
            volatility: "turn",
          },
        ]
      : [];
  },
});
```

- The provider gets the locale of the current execution, a read-only view of the world, and the ability to access its own data.
- Within one execution, the same extension point input reuses the result. A provider cannot return different content based on "which runtime is calling it".
- `providerPluginId` is added by the host. A plugin cannot fake its ownership.

### How the built-in plugins use it

- The `memory` plugin uses this extension point to render its own `blocks` data as turn segments. Block definitions are collected through the `memory.block-definitions@1` service.
- The kernel does not read the private namespace of any memory plugin, and it does not provide segments specific to Core Memory, Working Memory, or persona.
- Supplementary world structure is returned by `session.world-context@1`: `schema` / `entries`, and the current values in `dimensions`. Dimensions are not `entries`, and they are not a copy of constant lorebook entries.
- Lorebook entries still use the prompt position of their own domain record.
- The `PostContextAssembly` hook of `world-ir` is responsible for trimming its own history output and related memories. It does not append a prompt segment. This kind of "transform" keeps the hook. To add content, use `prompt.segment@1`.

### `PostContextAssembly` and the framework preamble

`PostContextAssembly` can rewrite the final `systemPrompt` / `messages`. But the framework preamble cannot be discarded. It has three blocks. All three are written in the session's [instruction language](./i18n.md). A Simplified Chinese session is entirely in Chinese:

| Block          | Content                                                                                                                                                                                                                                          |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `[RUNTIME]`    | The runtime framework                                                                                                                                                                                                                            |
| `[LANGUAGE]`   | The output language instruction                                                                                                                                                                                                                  |
| `[COMPLETION]` | The completion convention. There are three forms depending on how the runtime ends: a runtime with an output schema ends with JSON or a completion tool; a story runtime ends with the story text in its reply; the rest end with `runtime-done` |

- If the `systemPrompt` returned by a hook does not start with it, the framework puts it back at the very front. So a trimming hook that returns only its own body does not need to remove it, and it cannot remove it.
- `frameworkHead` in the payload is a read-only copy of this text.
- Without this segment, the model would not know what language the session uses.
- The raw localized `promptTemplate`, the resolved `inputSlots`, and the character summary that a hook receives are read-only sources. Hooks cannot replace them.
- When a runtime is suspended, its input slots are frozen into the continuation. On resume, the same inputs are used.

### Default LLM request settings for runtimes

The `agent` group of a runtime can declare two request preferences:

- `agent.reasoning: false`
- `agent.toolChoice: { name: submit-facts }` (a named tool), or `agent.toolChoice: required` (a declared tool must be called, and the model chooses which)

**When to force a tool.** A bookkeeping runtime after the narrative receives a conversation whose latest text is the story text. If the tool is not forced, the model tends to just continue the plot.

- `required` suits a runtime where "no change" is also expressed through the same write tool (for example `update-dimensions({updates: []})`).
- If "no change" is instead expressed by calling `runtime-done`, a forced tool makes the model first submit a rejected empty write. A failed write cannot be cancelled by the `runtime-done` that follows.

**Scope of this preference.**

- It is a request preference of this runtime. It does not rewrite the session or provider configuration, and it is not derived automatically from `requireToolUse`.
- Retries, non-streaming calls, streaming calls, and fallbacks all use the same preference.
- The player's slot parameter overrides and the preset's provider metadata take priority.
- It cannot replace runtime tool execution or output schema validation.

**How each provider maps it.**

- Disabling reasoning: the provider adapter applies the default "off" value only when there is no explicit reasoning configuration. Based on the existing model capability mapping, this becomes `enable_thinking: false` for Qwen, disabled for DeepSeek, or the matching value for models that support `none`. Models that cannot turn it off keep their existing capability.
- Naming a tool: mapped to Chat Completions, Responses, and the Anthropic native protocol respectively.
- Qwen / Anthropic requests that explicitly enable thinking fall back to automatic selection.
- Claude models that do not accept forced tool calls (Fable 5.1, Mythos 5.1, Opus 5.5, Sonnet 5.5) also fall back to `auto`.
- An `auto` / `none` that the player set is sent as is.
- For DeepSeek thinking requests, the incompatible `tool_choice` is left out. When `deepseek-flash` and the V4 models have no explicit switch, they are also treated as thinking enabled by default. When thinking is explicitly turned off, the plugin's tool choice preference is kept. This follows the [DeepSeek Chat Completions tool choice restriction](https://api-docs.deepseek.com/api/create-chat-completion/). It prevents the plugin's preference from overriding the player's configuration and causing a 400 error.

## 4. Template variables and the data boundary

The body of the root `PLUGIN.md` for an inline runtime, or the body of a child runtime's `RUNTIME.md`, supports `{{ variable }}` interpolation.

Template variables read only the object's own properties. Lookups in `inputs` by plugin and runtime use string keys, so a plugin or field named `constructor` or `toString` reads its explicit value as normal. It does not touch or change JavaScript's inherited objects.

Common variables:

- `player.message`, `player.lastFormValues`, `player.character`. `player.character` is the current character of the primary seat (see [seats](./world-model.md#seats)), and empty when there is none.
- `characters.npcs`: the profiles of all characters except the current one. The other characters the player controls carry their `[player]` tag. Each line is `name [type] | description | fields`. If a character has an alias, `(aka alias, …)` follows the name. The description and fields are each cut to 400 characters. The total is about 8000 characters. Characters beyond that are listed by name only. It does not include an id. The model looks characters up by name or alias with `get-character`. Putting this in the body means the model does not have to call `get-character` once for each character who appears.
- `session.id`, `session.turnNumber`.
- `inputs.<pluginId>.<runtimeId>.<field>`.
- `world.name`, `world.description`, `world.tags`, `world.lore`, `world.schema`, `world.entries`, `world.dimensions`. `world.lore` is the whole body text, including the [part shown only to the narrator](./world-data.md#narrator-only-lore-narrator-only). It does not include the two marker lines.
- `userSettings.*`, composed from the defaults in the root `contributes.settings` and the player's configuration.

The extended view of the world is provided through public extension points. A plugin cannot build it from another plugin's private data. Long world content should be selected for the current task. Do not inline all the lore in every turn. `world-dimension-get` and `world-dimension-list` are built-in framework tools. They read on demand from the same frozen `world.dimensions@1` snapshot.

### Writing that keeps the system prompt unchanged

The values of `player.character` and `characters.npcs` change as the story goes on. If they are written in the body, the system prompt changes with them. In a session that records injuries or status, they change every turn, and the prefix cache stops at that point.

A runtime that wants the system prompt to stay the same from turn to turn writes only a block name in the body. The plugin's entry provides turn-level prompt segments, and the content goes into the [turn context](#turn-context):

```js
import {
  characterSheetSegments,
  currentCharacterOf,
  primarySeat,
} from "@covel/plugin-handlers-utils";

covel.provideExtension("prompt.segment@1", "character-sheets", {
  handler: (_input, ctx) =>
    characterSheetSegments(ctx.world.characters, {
      currentCharacterId: currentCharacterOf(
        primarySeat(ctx.world.seats),
        ctx.world.characters,
        ctx.world.seats,
      )?.id,
      profiles: true,
      locale: ctx.locale,
      schema: ctx.world.characterSchema,
    }),
});
```

- `<player-character>` is the sheet of the `currentCharacterId` character, the one the player plays right now. It is the same JSON as `player.character`. Without `currentCharacterId` there is no such block.
- When `profiles: true` is set, `<character-profiles>` is added too. Its line format is the same as `characters.npcs`, and it leaves out only the current character.
- `locale` decides whether the "profiles not listed" line is in Chinese or English. It matches the language of the body.
- `schema` makes numeric attributes that declare min and max show their range (`"might": "2/5"`). Otherwise the model sees a bare number and cannot tell 2/5 from 2/100.

The built-in `narrator` and `chat-mode-narrator` do this.

### Prompt projection of dynamic dimensions

`world.dimensions.<id>` contains `{name,description?,schema,value,version}`. To get a specific value, write `{{ world.dimensions.reputation.value }}`.

- `worldRecord.dimensions` / `metadata.dimensions` are the author's declarations. They are not the session's progress.
- The old raw value paths and `world.tone/openingScenario` are not public shortcut fields.

**Segment for the narrative.** The built-in `world-init` provides the `<world-dimensions>` turn segment for the story audience through `prompt.segment@1`. It keeps the ID, the version, and the localized values within the budget.

- The default total budget is 12000 characters. When everything fits, every value is given in full. Each truncated value would make the model call `world-dimension-get` one more time, and that round would resend the whole prompt.
- When the budget is exceeded, the longest values are cut to 240 characters (marked with an ellipsis).
- Dimensions that still do not fit have their count stated explicitly in the segment. The segment directs the model to query them by ID / path or by page.
- An omission does not mean the value does not exist. The preview does not pass itself off as complete JSON.
- Choosing a template path does not mean the framework automatically expands every row set in full.

**Character notes for the narrative.** The built-in `character-blueprint` provides the `<character-notes>` session segment for the story audience through the same extension point. The content is each character's roleplay notes in the world's character file (the `blueprint` field: tone, manner, personality, goals, fears, secrets, relationships, rules, and sample lines).

- Only the characters in the session are written (not the player's character). They are sorted by character ID.
- Within a budget of about 6000 tokens, they are trimmed level by level. Sample lines are trimmed first, then rules. Tone is never trimmed.
- It is stable text within the session, placed in the stable part of the system prompt. It changes only when the character roster changes.
- For the fields and trimming rules, see the [plugin README](../../../plugins/character-blueprint/README.md#角色卡怎样进入叙事).

**Projection does not change the source data.**

- A projection changes only what is shown. It does not change the original snapshot or its version.
- Plain JSON is not guessed to be translated. Only nodes that carry an `x-i18n` annotation are localized.
- Story segments, public get / list, and client snapshots do not carry `initialValue/updateRule/lastTrackedSource`.

**Segments for the tracker itself.** The self-only segments of a tracker carry the full rules, schema, and frozen values, within the budget:

| Segment              | Type    | Content                         | Position      |
| -------------------- | ------- | ------------------------------- | ------------- |
| `<dimension-rules>`  | session | Rules and schema                | system prompt |
| `<dimension-values>` | turn    | One line per `id: frozen value` | turn context  |

- Neither segment carries a version number. The version changes on every update, and the write tool reads it itself.
- Dimensions beyond the budget are listed under "truncated" in `<dimension-rules>`. They are then fetched page by page with `dimension-rule-get`.
- When there are no valid rules, the maintenance model is not called.

**The order within one turn.**

- The pre-turn stage publishes Sₙ read-only. The narrative and the tracker's public reads use the same Sₙ.
- After the post-turn commit, a new execution publishes a new version. It does not bind back to the tracker's output, and it does not fall back on `recordAs` or the world's initial values.
- A source retry uses the artifact of the original turn through `retryFromTurnId`. A failure or an unsettled state is not the same as "no change".
- For the full state, see [World Model](./world-model.md#turn-timing-and-settlement-receipts).
- A dimension has no payload for hidden events, and it has no conditional trigger layer.

### Data boundary

**Bookkeeping fields do not enter the prompt.** Records that the kernel writes into the prompt do not carry bookkeeping fields:

- Rows of `io.selfData` are `- <key> | <JSON of the value>`. A row has no `updatedAt`. An `id` in the value that is the same as the key is not repeated.
- In these rows, in the values of `<runtime-inputs>` / `<runtime-exports>`, in the payload of `<runtime-activation>`, and in `{{ world.schema }}`, UUID-type IDs, ISO times, and `sessionId` are removed.
- The player table and NPC fields of `characterSheetSegments()`, and the fields of `{{ characters.npcs }}`, also use the same projection recursively before serialization.
- Readable semantic IDs and story fields such as `date` are kept.

For the rules and the reasons, see [plugin reference](./plugins.md#inputs-and-outputs).

**Input blocks are data and are not interpolated again.** A declared input block carries upstream output or this plugin's data. It is injected as data after XML escaping, and **template interpolation is not run on it again**. Templates are interpreted once, only in the runtime's own body. This stops `{{ ... }}` inside the data from being expanded again and getting past the data boundary.

- The typed slots resolved from `io.inputs` keep their cardinality, value / items, and provenance. They are injected into the agent through `<runtime-inputs>` in the [turn context](#turn-context). A function runtime reads them from `ctx.inputs`.
- The only provenance in the prompt is `pluginId` and `runtimeId`. `resultId` is a UUID meant only for tools and the kernel. Tools read it from `ctx.inputSlots`, and it does not enter the prompt. The same applies to `<runtime-exports>`.

**Template variables inside tag blocks are escaped.** For a line in the body that starts with `<name>`, the `{{ ... }}` values up to the next `</name>` are XML-escaped before they are written. So a `</world-summary>` in the world text or in a character description cannot close the block. Variables outside a block, and variables in prose that mentions a tag in a line, are written as they are.

The `<world-lore>` that the kernel writes itself only rewrites a `</world-lore>` that appears in the body (it becomes `&lt;/world-lore>`). World text is long Markdown. Quote markers `>`, comment markers, and `&` in it enter the prompt unchanged.

**`io.selfData` takes only a limited number of rows.** When plugin data is injected, the framework asks the store for a bounded projection. It does not read the whole namespace first and then trim it.

- The default is 50 rows. It keeps the earliest 25 rows as anchors, plus up to 25 other rows updated most recently.
- A namespace with fewer rows keeps creation order.
- The total number of rows is still written in the truncation note.

**The form is read only once.** During one execution, `getLatestPlayerInput` reads the latest form once. That row is reused in the context snapshot.

**The scan range of lorebook entries.** A lorebook entry can use `extra.scanDepth` to choose to scan a number of messages already committed before (0–20). The current player message is always scanned. The scan reads a bounded tail of history from the database, including messages that have already been compacted. The built-in Emberback world activates lorebook entries by keyword, and it leaves out character biographies that are already in the character records.

## 5. Token budget and cache

### Budget

Budget trimming runs only when there is an estimator and a context budget. Budget checks happen in three places: when the context is assembled, after `PostContextAssembly`, and on the actual request after each `PreLLMCall`. The actual request includes tool and response schemas, tool results, steering, and retry content.

- **The response schema is counted twice.** The bridge layer writes it into the system prompt. The Responses and Gemini protocols also send it again as a native field. The budget stage does not know which protocol will finally be used.
- **Protected content.** The current user turn (including the turn context before it, this turn's story text, and the ending hint) and the summary envelope are protected during ordinary history trimming. A tool call and its result must be kept as a pair.
- **Trimming order.** When needed, overly long tool read-backs are shortened first. Then the summaries in this call are shortened. The raw records in the database are not affected.
- **Still over the limit.** If the fixed content is still over the limit, the request is refused and not sent to the provider.
- **Output limit.** The response reserve also limits the maximum output of this request.
- **Hard trimming.** Hard trimming keeps room for later turns. The trim marker does not contain a message count that changes.

### Cache boundaries in the system prompt

`serializeSystemPrompt(segments, true)` inserts an internal PUA sentinel (``) after the following non-empty sections, in at most four places:

1. framework preamble
2. runtime body
3. stable / session extension segments
4. after-plugin lorebook

- A turn extension segment that stays in the system prompt (a `pre-history` segment with the system role) is placed after the last cache boundary, and it sets no breakpoint.
- A turn extension segment with `position: system` is not in the system prompt. See the [turn context](#turn-context).
- `pre-history`, `post-history`, and depth segments with user or assistant roles keep their own message positions. These messages are not guaranteed to fall within any system cache boundary.
- The Anthropic adapter turns the marker into a text block with `cache_control`. Other providers have their adapters strip the internal marker, and they use the caching method that they support.

### Anthropic's four boundaries

Anthropic keeps at most two stable system cache boundaries, and it sets two boundaries in the messages. The four boundaries are the upper limit of this API.

| Boundary in the messages                                                                   | Who can read it                                                                             |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| On the last message of the history (before the first turn instruction in the conversation) | The next turn's request: it is identical to this turn up to the end of the history          |
| On the last cacheable block of the request                                                 | Later requests in the same turn's tool loop: what is written here includes this turn's data |

- When cache boundaries are enabled, the text of each message is sent as an array of text blocks, not as a string shorthand. The reason: the boundary moves later every turn, so a message that carries a boundary must be a block array. When the same message has no boundary in the next turn, it keeps the same form, so the prefix stays byte-for-byte identical.
- When the request has no history (a runtime with `maxTurns: 0`, where the turn context is merged into the top-level system), only the last boundary is set.
- Thinking blocks carry no cache control.
- Other protocols remove the internal `COVEL_CACHE_BREAK` marker when they serialize. The two OpenAI protocols additionally send a `prompt_cache_key` generated per session and per runtime. See [slots.md § prompt cache key](./slots.md#prompt-cache-key).

### Measuring the prefix

Run from the repository root. These examples use the development server's fallback path. If you configured another database, substitute its absolute path; see [path selection](./env-registry.md#plugin-extension-development-data).

```bash
pnpm prompt:prefix apps/server/data/covel.db                      # One table per session
pnpm prompt:prefix apps/server/data/covel.db --session <id> --show world-init/dimension-tracker
pnpm prompt:prefix apps/server/data/covel.db --json
```

The script reads `llm.calling` in `trace_events`, which records the request body sent to the provider. It needs no model, and the service does not need to be running.

- For each runtime, it takes the first request of each turn. It follows the order in which the provider computes the cache key (tool definitions first, then each message). It compares this character by character with the first request of the previous turn.
- In the table, `req tok` is the size of the request. `shared` is the part that is identical from the start. The last column shows which message and offset the first difference is in.
- `--show` prints the text before and after that point.
- Later requests in a tool loop within the same turn are appended after the previous request, and they are not part of the comparison.

> [!NOTE]
> This is a measurement of the prefix, not the provider's bill. Token counts are estimated by characters (about one token per CJK character, and about one token per four other characters). Whether the cache is actually hit also depends on the provider's minimum cache length, how long the cache lives, and its own tokenization.

Putting stable content first keeps the same prefix. `volatility` decides three things: the sorting, the cache boundaries, and whether a `position: system` section sits in the system prompt or in the turn context. It does not guarantee that content never changes, and it does not cancel the reuse of extension results within an execution.

## 6. External templates and localization

- The shared `prompts/server` holds the templates for world generation and lore repair.
- The templates for history summaries are kept by `plugins/history-compaction/prompts/server`. The plugin loads them through `createPromptLoader(root)` from the SDK. Like a plugin body, they exist only in English and Simplified Chinese; see [i18n](./i18n.md).
- Changing `COVEL_PROMPTS_DIR` replaces only the default shared prompt root. It does not take over a plugin's own directory.

The shared framework loader tries these in order: an exact locale match, the main language that the writing system is compatible with, English, and the default file with no language suffix.

- An invalid locale does not enter the path lookup.
- `zh-Hant` does not match the simplified `zh`.
- A standalone loader falls back only within its own directory.
- `CreateWorldOptions.loadPrompt` can inject the host's loader.
- The manifests of running plugins, their localized bodies, and their static extension segments follow the registry generation that was captured.

### Fixed text that the code writes into prompts

Apart from templates and bodies, the assembly code writes a few sentences of its own:

- The title of the world rules
- The event-emission notes for `<available-events>`
- The explanatory sentence after the history summary block
- Markers for content that was trimmed or truncated
- Retry hints
- The JSON rules for runtimes with `output.schema`

All of these are written in the session's instruction language. A Simplified Chinese session reads Chinese, and every other session reads English. Tag names, markers such as `[retry N]`, and IDs do not change. For the full list, the way plugin code handles this, and the few kinds of text that are not translated, see [i18n · text that code puts into prompts](./i18n.md#text-the-code-puts-into-prompts).

Tool definitions, the results returned to the model inside the tool loop, and the reasons for refusals are always in English.

## 7. Related implementation

- `packages/runtime/src/turn-executor/session-state.ts`: loading the canonical history and projecting extensions.
- `packages/runtime/src/agent-loop/turn-agent-runtime.ts`: collecting extension segments, the compaction barrier, and the agent context.
- `packages/context/src/prompt-assembler.ts`, `extension-segments.ts`: segment assembly, audience filtering, and sorting.
- `packages/context/src/prompt-serialization.ts`: system segments and cache markers.
- `packages/runtime/src/commit/commit-ui.ts`, `packages/runtime/src/agent-loop/picture-attachments.ts`: image description rows, and reading image bytes and their limits.
- `packages/context/src/history-budget.ts`: compaction admission and atomic persistence.
- `plugins/history-compaction/server/strategy.ts`: the default summary strategy.
- `packages/context/src/session-context.ts`: the world and lorebook views.

For the declaration and call boundaries of extensions, see the [plugin extension reference](./plugin-extensions.md). For the author format, see the [plugin reference](./plugins.md).
