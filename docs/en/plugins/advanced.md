# Advanced: Multiple Runtimes, Data Contracts, Permissions, and Publishing

This page covers what a plugin needs as it grows: splitting work into several runtimes, letting a world package supply data to the plugin, running in the background, calling external APIs, intercepting tool calls, and the fields to fill in before publishing. The example is a plugin called "fact-index". An agent extracts facts from the story, and a function looks them up on demand.

Before you read this page, read [Plugins with Local Code](./local-code.md). You can read each section on its own, and read the section you need when you need it.

## Layout for multiple runtimes

When a plugin has several runtimes, each runtime lives in its own folder under `runtimes/`:

```text
fact-index/
├── PLUGIN.md                    package description, capabilities, shared declarations
├── README.md
├── server/index.js              optional: entry file
├── schemas/facts.schema.json
└── runtimes/
    ├── extract/
    │   └── RUNTIME.md           agent: extracts facts
    └── query/
        ├── RUNTIME.md           function: query
        └── handler.js
```

`PLUGIN.md` only says "what this package is". It no longer has a `runtime:` section:

```yaml
---
description: Extracts and retrieves narrative facts.
requires: [narrative-engine@2]
contributes:
  data:
    facts:
      accepts: [facts.index@1]
      schema: ./schemas/facts.schema.json
---
```

`runtimes/extract/RUNTIME.md` is an agent. It has no `id`. The folder name is its name, so its full name is `fact-index/extract`:

```yaml
---
schedule: { stage: post-turn }
io:
  inputs:
    narrative:
      from: { contract: narrative-engine@2 }
      select: /segments
  output:
    contract: facts.index@1
    schema: ../../schemas/facts.schema.json
    recordAs: extracted-facts
---
Extract only the facts that `runtime-inputs.narrative.value` states.
```

Read each segment with its `speaker` to distinguish who speaks or acts; an NPC’s quoted “I” is not the player. See [story output](../reference/plugins.md#story-output) for input selection.

`runtimes/query/RUNTIME.md` is a function that is triggered manually. It has a `function` block, and its code is in `handler.js` in the same folder:

```yaml
---
schedule:
  trigger: { type: manual }
io:
  output: { contract: facts.query@1 }
function:
  timeoutMs: 90000
---
```

What is new here:

| This part             | Meaning                                                                                                                                            |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `io.output.contract`  | The output of this runtime is the content of this capability. The plugin then provides it, and other plugins can `requires` it.                    |
| `io.output.schema`    | The shape the output must match. If it does not match, this run fails.                                                                             |
| `io.output.recordAs`  | Saves the output under a name. Later turns can read it with `scope: committed`.                                                                    |
| `schedule.background` | Left out, the caller waits for it to finish. `true` moves it to the background. See [Background work and failures](#background-work-and-failures). |

Rules:

- Within one plugin, two runtimes cannot output the same capability.
- The capabilities a plugin provides are the `io.output.contract` of its runtimes; you do not write them in `provides`. Write in `provides` only a capability that no runtime outputs (for example, one a service in the entry file provides).
- Paths are relative to the file they appear in. `./handler.js` in `RUNTIME.md` is in its own folder. Paths in `PLUGIN.md` start from the package root. No path or symbolic link may point outside the package.
- `RUNTIME.md` cannot contain package-wide fields such as `contributes` or `id`. Settings, data declarations, and the tool list are written in `PLUGIN.md`, and all runtimes share them.
- In a plugin with several runtimes, each agent lists the tools it uses in `agent.tools.plugin`.

When you validate, passing the folder, `PLUGIN.md`, or any one `RUNTIME.md` checks the whole package:

```bash
pnpm validate:plugin ~/.covel/plugins/fact-index
pnpm validate:plugin ~/.covel/plugins/fact-index/runtimes/query/RUNTIME.md
```

```text
✓ Static package validation: /Users/you/.covel/plugins/fact-index
  languages: text en; instructions en
```

To run one runtime offline, write its full name: `pnpm test:runtime -- fact-index/query --pretty`. If you write only `fact-index`, it runs all of the plugin's test cases. A plugin with several runtimes that has no test-case file produces this error if you write only the plugin name: `plugin "fact-index" has no tests/runtime-cases.json or covel.test.json`.

## Data contracts and world import

A world package can supply data to a plugin. For example, a detective world can include "facts known at the start". To do this, the plugin declares "this data namespace accepts this kind of data", and the world package puts its files in an agreed location.

### Declaring what is accepted

The `PLUGIN.md` above already has this:

```yaml
contributes:
  data:
    facts:
      accepts: [facts.index@1]
      schema: ./schemas/facts.schema.json
```

This means: the `facts` namespace accepts data named `facts.index@1`, and each record must match `schema`.

- When a data namespace accepts a kind of data, its `schema` is the public shape of that kind of data. You do not need to write it again in `contracts`.
- Only a capability that no data namespace accepts (for example, the output of a runtime) needs `contracts.<name>.schema`.
- When several plugins accept the same kind of data, their schemas must match. A mismatch is reported as an error before loading or importing.

### Telling world authors how to write it

Add an `authoring` section, so that world authors and authoring tools know where this content goes and how to write it:

```yaml
contributes:
  data:
    facts:
      schema: ./schemas/facts.schema.json
      accepts: [facts.index@1]
      authoring:
        title: Known facts
        hint: >-
          Write one record for each fact the story starts with. Keep `text` to
          one sentence.
        example: ./examples/facts.json
        source:
          path: data/facts.yaml
```

| Field        | Meaning                                                                                                                                                                                                                                        |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `title`      | The name of this kind of content, shown to authors                                                                                                                                                                                             |
| `hint`       | How to write good records of this kind. Use short, clear English sentences.                                                                                                                                                                    |
| `summary`    | One sentence for players. The in-app authoring screen uses it as the option description.                                                                                                                                                       |
| `example`    | A valid example (JSON). It is checked against the `schema` above.                                                                                                                                                                              |
| `source`     | The agreed location of this content in the world package: `path`, and optionally `key` (default `id`), `visibility: hidden` and `lorebook: true`. The file format comes from `path`: `.yaml`, `.json`, or a media folder without an extension. |
| `references` | Which values in a record are the `id` of a character attribute of the world. `pnpm validate:world` checks them before a session starts. For how to write it, see the [plugin reference](../reference/plugins.md)                               |
| `generate`   | Allows the in-app world generator to create this content from only `hint` and `example`. See below.                                                                                                                                            |

`title` is a label, so the manifest is in English and the Chinese goes in `locales/zh.yaml`:

```yaml
PLUGIN.md:
  contributes:
    data:
      facts:
        authoring:
          title: 已知事实
```

The world package puts the file where `source.path` says, and it is imported. No other configuration is needed. When two plugins enabled in the same session declare the same `path`, that path no longer counts as an agreed location. So choose a path that no other plugin uses. The kernel's and the world package's own paths (such as `data/dimensions.yaml` and `world.yaml`) cannot be declared; the list is in [World data](../reference/world-data.md).

`generate` takes two values. `offer` lists this kind of content as an option on the authoring screen. `default` lists it and selects it by default. It requires an `example`. Its `source` must be public, not media, and use `id` as the `key`. When a player selects it, the generator writes the schema, the hint, and the example into its prompt. It also adds this plugin to the plugins the world enables. Declare it only for content whose generation quality has been checked with a real model.

### Checking the declarations

```bash
pnpm describe:authoring --plugins ~/.covel/plugins
```

This command combines the `authoring` sections of all plugins into one summary. Your section appears in it:

```text
### Known facts — `facts.index@1` (plugin `fact-index`)

How to write it: Write one record for each fact the story starts with. Keep `text` to one sentence.

Put the file at `data/facts.yaml`: it is imported without a descriptor. The same source in a descriptor:

    facts:
      kind: yaml
      path: data/facts.yaml
      schema: contract:facts.index@1
      to: contract:facts.index@1
      key: id
```

The world-authoring skill and the in-app generator read the same data. So once a new plugin declares `authoring`, you do not need to update any other document.

Add `--check`, and it checks each example against its schema. When every example passes, the last line is:

```text
Authoring examples match their schemas.
```

### The world side

World authors only need to put files in the agreed locations. When they need to specify a source themselves, they write `to: contract:facts.index@1` in the world's data descriptor file. Covel gives the data to the active plugins that declare they accept it. A world does not name a particular plugin's data namespace, and it cannot.

To turn other world content into your own data, use `contributes.worldProjections`. Its output must match an importable data namespace. For the full rules, see the [World data reference](../reference/world-data.md). For the fields, see the [plugin manifest field table](../reference/schema/plugin-manifest.md).

Business formats such as character cards belong to the plugin that handles them. Covel handles only the general "source to target" flow and the characters themselves. It does not wrap data for any particular plugin. A plugin's data about a character can be written in the world's character record: declare `authoring.characterField` on the receiving data space, and Covel gives you that field of the record, keyed by the character ID. See [one character file per world](../reference/world-data.md#one-character-file-per-world).

## Services and extensions

There are two ways to let other code call yours:

| Way           | Who calls it                                                 | Declared in              | Registered with                        |
| ------------- | ------------------------------------------------------------ | ------------------------ | -------------------------------------- |
| **Service**   | Another plugin, when it needs it                             | `contributes.services`   | `covel.registerService(...)`           |
| **Extension** | Covel, which asks you for content or a policy at fixed times | `contributes.extensions` | `covel.provideExtension(point, id, …)` |

- Both use versioned names, and both inputs and outputs are checked against a schema.
- The registered name must match the manifest.
- Fixed fragments in `contributes.prompt` are registered by Covel automatically, so you do not need to declare them as extensions.

A service handler can read its provider's own non-hidden data. It cannot write:

```js
const item = await ctx.pluginData.get("items", key);
return { item };
```

For the inputs and outputs of each extension point, how several providers are combined, and how errors are handled, see [Plugin extensions and communication](../reference/plugin-extensions.md) and the [Extension point reference](../reference/extension-points.md).

> [!IMPORTANT]
> If an existing extension point cannot express what you need, do not work around it by reading another plugin's private data. That data is its internal implementation, and it can change at any time.

## Background work and failures

### Not making the player wait

There are three ways to keep a runtime from blocking the turn:

| Setting                               | Effect                                                                                                             |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `schedule.detached: true`             | The turn ends first; an eligible function leaf continues in the durable queue. Only for `post-turn` and `audit`.   |
| `schedule.detached: { settle: true }` | Keeps running in the background, but the player's next action waits for it to finish.                              |
| `schedule.background: true`           | A runtime triggered manually or by an event moves to the background, and the caller gets a task number right away. |

A runtime triggered by an event is written with `schedule.trigger: { type: event, topic: ... }`.

A staged detached runtime must be a function with no downstream runtime still waiting in the foreground for its result. It cannot recurse or suspend. Manual and event background jobs are separate executions. Validation and runtime checks enforce these boundaries; an ineligible node stays in the foreground with a diagnostic. See the [turn pipeline](../internals/flow.md) for the full conditions.

A function that runs in the background and calls a model itself must declare which model role it uses:

```yaml
function:
  model: memory
```

In the code, pass the same name when calling `ctx.gateway` (`presetId: "memory"`). Covel uses this declaration to check whether the model's key is ready, and then decides whether to start the background job at all. This line does not change the parameters in your code for you. You must make both match yourself.

A plugin can only name a role. Which model is used, and where the request goes, is decided by the player's model settings. An `llm.toml` in the plugin's directory does nothing, and `pnpm validate:plugin` reminds you to delete it.

### Time limits

| Type     | Field                      | Meaning                                                                                                                             |
| -------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Function | `function.timeoutMs`       | The total time limit for one run. Time spent calling external APIs counts toward it.                                                |
| Agent    | `agent.loop.timeoutMs`     | The total time limit for one run. The default is 120 seconds, 240 seconds for a `story` runtime.                                    |
| Agent    | `agent.loop.callTimeoutMs` | The time limit for a single model call (a call that is not streamed). The default is 60 seconds, 120 seconds for a `story` runtime. |
| Agent    | `agent.loop.maxRetries`    | How many times to retry when a model call gets no reply. The default is 3, 1 for a `story` runtime, and the maximum is 5.           |

For the full rules, see the [Plugin fields reference](../reference/plugins.md#timeouts-and-retries-agentloop).

### How the loop behaves

The rest of the agent loop's behaviour comes from a loop profile: whether text is shown to the player as it is written, whether the player's interjections are read, and what happens when the model keeps calling the same tool. The profile is worked out from `io.visibility`, so you rarely write it.

An agent that only answers a brief and writes no story text can use `actor`. The difference from `system`: when the model goes in circles, `actor` turns the tools off and answers, while `system` fails.

```yaml
agent:
  loop:
    profile: actor
    finalizer:
      deadlineReserveMs: 10000 # with 10 seconds left, stop calling tools and answer
```

A [sub-agent](#sub-agents) that names no profile uses `actor`. Fields, values and checks are in [Plugin reference · Loop profile](../reference/plugins.md#loop-profile-agentloopprofile).

### Sub-agents

A sub-agent is a small job handed to another agent: you give it a brief, it gives back one result. For example, an orchestrator asks the "guard" character for a line of dialogue. A sub-agent runs inside the caller's execution and returns output only: it writes no data and emits no events.

The provider is an agent runtime with `schedule.subagentOnly: true`. The scheduler never runs it on its own, and the player cannot run it manually:

```yaml
# runtimes/guard/RUNTIME.md
schedule:
  subagentOnly: true
io:
  output:
    contract: gate-actor@1
    schema: ./output.schema.json
agent:
  model: actor
  tools:
    builtin: [plugin-data-get]
```

A function runtime calls it with `ctx.agents.run`:

```js
export default async function handler(ctx) {
  const reply = await ctx.agents?.run({
    target: { contract: "gate-actor@1" }, // or { runtimeId: "my-plugin/guard" } (own package)
    brief: "A stranger asks to pass the gate.",
    data: { stranger: "Mara" },
    budget: { maxSteps: 4, timeoutMs: 20000 },
  });
  if (!reply?.ok) return { outcome: "success", value: { line: "..." } };
  return { outcome: "success", value: { line: reply.output.line } };
}
```

An agent runtime that declares `delegate` in `agent.tools.builtin` lets its model call it, with `target`, `brief` and optionally `data` and `maxSteps`.

- The sub-agent sees only the brief and `data`, not the session history or the caller's conversation.
- It can use read-only tools only. Write tools the provider declares, `suspend` and `delegate` are taken away.
- A failure does not throw: the result is `{ ok: false, error: { code, message } }`, and the caller decides what to do.
- One execution runs at most 8 sub-agents at a time, and a sub-agent cannot call another one. A full pool refuses at once (`unavailable`); nothing queues.
- When the caller is cancelled or times out, the sub-agent stops with it.
- It uses the model role it declares. The player can bind another model to this runtime in the session.

The full request, result and error codes are in [Plugin reference · Sub-agents](../reference/plugins.md#sub-agents).

### When something fails

- A runtime that fails saves none of its writes, and the events it sent do not trigger other runtimes.
- So return only valid results. Do not "write half first and fill in the rest if something goes wrong".
- The same operation may be retried. Make repeated runs produce the same result by writing data under stable keys, not by generating a new key each time.
- Long-running work should respond to `ctx.signal`, so it stops as soon as the player cancels.

### Capabilities that are not tools

A function has several things it calls directly. These do not go through the tool list or the authorization flow: `ctx.gateway` (calls a model), `ctx.images`, `ctx.speech`, and `ctx.music` (generate media), `ctx.media` (saves media), and `ctx.utils` (network requests).

They are all in the `PluginFunctionContext` type. The host gives them only when it has a model and media storage set up, so check before use: `if (!ctx.images) return …`.

To generate an image, call `ctx.images.generate(...)` directly in the function. Do not make a "generate image" tool for the model to call, and do not write your own request to an image provider. For details, see [Image generation](../reference/image-generation.md) and [Media store](../reference/media-store.md).

## Permissions

### Calling external APIs

A runtime that calls an external API must first declare which addresses it will call:

```yaml
permissions:
  http:
    - origin: https://api.example.com
      methods: [GET]
```

- `origin` must be an `https` address. It cannot include a path, query parameters, or a user name and password.
- `methods` is optional. The values are `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, and `HEAD`.
- Requests are sent with `ctx.utils.fetchWithRetry`. A community plugin that calls an address it did not declare is refused.
- For entry code that sends requests with `covel.http.fetchWithRetry`, declare `permissions.http` in the root `PLUGIN.md`. See the [plugin reference](../reference/plugins.md#runtime-field-groups) for package permissions and wire endpoints.
- Do not pass a URL that the player typed straight to the backend to fetch. Check it first with `ctx.utils.validateBaseUrl`.

> [!WARNING]
> Declaring a permission does not grant it. The code of a community plugin runs only after the player approves it. Covel enforces the approval, the quotas, and the URL checks. For the boundaries and the reasons for them, see [Security boundaries](../internals/security.md).

### Declaring what is read and written

`effects` says what this runtime reads and writes:

```yaml
effects:
  reads: ["plugin-data:self:facts"]
  writes: ["plugin-data:self:facts", "http:https://api.example.com"]
```

Values you can write:

| Form                                                                                                   | Meaning                                 |
| ------------------------------------------------------------------------------------------------------ | --------------------------------------- |
| `plugin-data:self:<data namespace>`                                                                    | One of the plugin's own data namespaces |
| `event:<event name>`                                                                                   | A certain event                         |
| `http:https://<host>`                                                                                  | A certain external address              |
| `state:*`, `narrative:*`, `characters:*`, `lorebook:*`, `assets:*`, `media:*`, `ui:*`, `interaction:*` | The matching kind of shared resource    |

`parallelSafe: true` means the runtime can run at the same time as other runtimes in the same stage. Any runtime that changes shared data or calls an external API should declare `permissions` and `effects`.

## Hooks

Hooks let you step in at fixed moments: before a tool call, before a model call, when a turn starts, and so on. They are for **intercepting, rewriting, or recording** only. Do not put gameplay logic in them.

List the moments you want to listen to in `PLUGIN.md`:

```yaml
contributes:
  hooks: [PreToolUse]
```

Register them in the entry file. The two must match:

```js
export default function register(covel) {
  covel.on("PreToolUse", async (ctx, payload) => {
    if (ctx.runtimeId !== "fact-index/extract") return { action: "continue" };
    if (payload.toolCall.name !== "plugin-data-delete") {
      return { action: "continue" };
    }
    return { action: "abort", reason: "This runtime may not delete facts." };
  });
}
```

- To tell which runtime the hook is about, read `ctx.pluginId` and `ctx.runtimeId`. `payload` does not contain them. If you read `payload.runtimeId`, it never matches, and the hook does nothing.
- `ctx.locale` is the language of this game session. When you add text to a prompt, use `instructionLocaleFor(ctx.locale)` to choose the language. Do not guess it from the prompt text.
- `ctx.getOwnSettings()` reads this plugin's own settings.

For the moments that exist, the data each one carries, and what can be returned, see the [Hook reference](../reference/hooks.md).

## World model and memory

- `ctx.world` gives you "the world as this run sees it". That is the saved state, plus the legal changes that earlier steps in this turn have proposed but not yet saved.
- Changing a character, or changing a character's field definitions, goes through the same checks.
- Do not copy the write requests of earlier steps into your own result and commit them again.
- Memory blocks are data and services of the memory plugin. World-defined memory blocks are imported through `memory.blocks@1`. The default definitions are provided by the `memory.block-definitions@1` service. History compression is handled by the `history.compact@2` extension point. The manifest has no fields such as `memoryBlocks` or `summaryFocus`.

For details, see the [World model reference](../reference/world-model.md).

## Localization and hot reload

- The Chinese versions of prompts are `PLUGIN.zh.md` at the package root, and `RUNTIME.zh.md` for each runtime. Files of the same kind for other languages are not read.
- A Chinese version can contain only the parts to translate. Anything it leaves out falls back to the English version.
- If a Chinese version changes something it should not (a fragment's ID, its position, inputs, tools, or time limits), validation reports it. At run time, the English version's values are still used.
- Prompts are read when the plugin loads, and they are not read from disk again while it runs. After a hot reload, runs that start later use the new content, and runs that have already started keep using the content they started with. So do not reread the manifest yourself in code.

## Before you publish

### Filling in publishing fields

Add these to `PLUGIN.md`:

```yaml
version: 0.1.0
covel: ">=0.0.51"
author:
  name: Jane Doe
  url: https://example.com
  about: I write small mystery worlds.
license: MIT
homepage: https://example.com/fact-index
```

| Field      | Meaning                                                                                                                                                                                       |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`  | The plugin's version. It is written only here; `package.json` has no version.                                                                                                                 |
| `covel`    | The range of Covel versions it works with. A Covel outside that range does not install or load it. For the syntax, see [Collections · Version ranges](../ship/collections.md#version-ranges). |
| `author`   | The author's name, home page, a note written for players, and a few links. Links must be `https`.                                                                                             |
| `license`  | The license                                                                                                                                                                                   |
| `homepage` | The plugin's own page                                                                                                                                                                         |

For the length limits of these fields and where they are shown, see [Author information](../reference/plugins.md#author-information).

> [!WARNING]
> After `version` changes, existing games run this plugin's opening runtime again (the `setup` stage). The guard of an opening runtime must check whether the work has already been done. If it has, it returns `{ skip: true }`.

### Writing the README

Explain these things clearly: what the player can see, the inputs and outputs, the settings, the permissions needed, the runtimes there are, and how to test it.

### Checking what is in the package

- When there is a `package.json`, it has `"type": "module"`. A plugin may have none.
- A plugin in the user directory must run on its own, without depending on `npm install`.
- Do not include secrets, generated data, or paths from your own computer.

### A final run-through

```bash
pnpm validate:plugin ~/.covel/plugins/fact-index
pnpm test:runtime -- fact-index --pretty
```

The second command runs all the cases in `tests/runtime-cases.json`. So before you publish, write at least one case for each runtime.

For plugins in the repository, add your own unit tests and run the repository-wide checks:

```bash
pnpm --filter @covel/plugin-fact-index test
pnpm check
```

The key things your tests should cover: the boundaries of the data shape, not being able to read or write other plugins' data, repeated calls, not leaving half-written data after a failure, and writing then reading within the same run. For how to write them, see [Plugin testing](./testing.md). For packaging and trial installs, see [Package and try install](../ship/package.md).

## Rarely needed fields

No bundled plugin uses the fields below. Write them only when you have a special need:

| Field                                                    | Meaning                                                                                                                           |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `agent.loop.maxSteps`                                    | The most tool-call steps                                                                                                          |
| `agent.loop.firstTokenTimeoutMs`                         | In a streamed call, the time to wait for the first token. A model that is slow to produce it needs this, and a larger `timeoutMs` |
| `agent.loop.idleTimeoutMs`                               | In a streamed call, the longest silence between two outputs. The default is 120 seconds.                                          |
| `agent.loop.loopDetection`                               | How many times the model can repeat the same call in a row before it counts as going in circles. The default is 3.                |
| `agent.loop.maxRecursionDepth`                           | How deep `ctx.recursiveCall()` may nest. The default is 10.                                                                       |
| `contributes.events[].advertise: false`                  | The model that writes the story does not see this event; only the UI and code use it                                              |
| `contributes.prompt[].position: {depth: N}`              | Inserts a static prompt section into the history by message depth                                                                 |
| `contributes.commands[].context`                         | Host information a command passes to its action                                                                                   |
| `contributes.commands[].arguments[].variadic`, `choices` | Collects the remaining words into the last argument; lists the values an argument may take                                        |
| `contributes.wires`                                      | Provider wires the entry file registers with `registerWires`                                                                      |
| `contributes.settings[].type`                            | Besides `number`, `toggle` and `select`: `text`, `textarea`, `integer`, `slider`, `slot`                                          |

Every advanced field is in [Plugin reference · Advanced fields](../reference/plugins.md#advanced-fields).

## When something does not work as expected

| Symptom                                                          | Cause and fix                                                                                              |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Validation reports `inline runtime and runtimes/ cannot coexist` | `PLUGIN.md` still has `runtime:`. Remove it from a package that has several runtimes.                      |
| Validation reports `ambiguous output contract …`                 | Two runtimes output the same capability. Each capability is output by one runtime only.                    |
| The world package's data is not imported                         | The file is not at `source.path`, or another plugin declares the same path, or this plugin is not enabled. |
| `describe:authoring --check` reports an example as invalid       | The `example` file does not match the `schema`.                                                            |
| A background runtime stays in the queue                          | It calls a model but does not declare `function.model`.                                                    |
| A request to an external API is refused                          | The address is not in `permissions.http`, or it is not `https`.                                            |
| A hook is registered but never takes effect                      | It looks for the runtime's name in `payload`. Change it to read `ctx.runtimeId`.                           |
| The opening steps run again after a version upgrade              | This is normal. Make the opening runtime's guard return `{ skip: true }` for work already done.            |

## Next steps

- [Plugin testing](./testing.md)
- [Package and try install](../ship/package.md), [Publish and update](../ship/publish.md)
- Publish a plugin together with a world: [Collections](../ship/collections.md)
- All fields: [Plugin fields reference](../reference/plugins.md)
