# Rules to know when writing a plugin

This page collects the rules that every plugin author runs into: what you must declare, which tools the model can use, how to work with other plugins, who owns the data, and where the prompt and its translations are written. It is organized by question, so come back to it when you have one.

Before you read this page, finish [your first plugin](./first-plugin.md). That page walks you through a complete run. This page explains the rules to follow after that run works.

## Where to read next

| What you want to do                                         | Read this page                             |
| ----------------------------------------------------------- | ------------------------------------------ |
| Write only configuration and prompts, with no code          | [Prompt-only plugins](./prompt-only.md)    |
| Let the model use tools you write, or write a function      | [Plugins with local code](./local-code.md) |
| Multiple runtimes, importable data, permissions, publishing | [Advanced](./advanced.md)                  |
| Write a good prompt                                         | [Prompt style](./prompt-style.md)          |
| Write tests for a plugin                                    | [Plugin testing](./testing.md)             |
| Add a panel to the interface                                | [Plugin UI](./ui.md)                       |

For all the fields, see the [plugin field reference](../reference/plugins.md).

## The minimal loop

Each time you change a plugin, follow three steps: generate (only once), validate, and run offline.

For a plugin you write for yourself or for the community, put it in the user plugin directory. It needs no dependency install:

```bash
pnpm create-plugin my-plugin
pnpm validate:plugin ~/.covel/plugins/my-plugin
pnpm test:runtime -- my-plugin --pretty
```

For a built-in plugin that goes into the Covel repository, generate it under `plugins/`. It comes with a local tool and unit tests:

```bash
pnpm create-plugin my-plugin --with-tools
pnpm install
pnpm validate:plugin plugins/my-plugin
pnpm --filter @covel/plugin-my-plugin test
```

The generator does not ask questions. Its arguments decide what it generates:

| Argument           | What it does                                                                             |
| ------------------ | ---------------------------------------------------------------------------------------- |
| No argument        | One function runtime (`note`) and one agent runtime (`analyst`)                          |
| `-r name:type,...` | List the runtimes yourself. `type` is `function` or `agent`. If left out, it is `agent`. |
| `-t <dir>`         | Generate into the directory you give, not into `~/.covel/plugins`                        |
| `--with-tools`     | Generate under the repository's `plugins/`: one runtime, plus `tools/` and unit tests    |

A minimal plugin has only three files: `PLUGIN.md`, `package.json` and `README.md`. Here is a complete `PLUGIN.md`. After each turn's story, it asks the model to add one observation:

```yaml
---
id: my-plugin
kind: plugin
description: Adds a brief observation after narration.
requires: [narrative-engine@1]
runtime:
  type: agent
  schedule:
    stage: post-turn
  io:
    inputs:
      narrative:
        from: { contract: narrative-engine@1 }
        select: /narrativeOutput
        required: true
    visibility: plugin
  agent:
    model: plugin
---
Write one observation grounded in runtime-inputs.narrative.value.
```

Three rules that are easiest to get wrong:

- `id` must be the same as the folder name.
- With only one runtime, put it in the `runtime:` section of `PLUGIN.md`. With several, put each one in `runtimes/<name>/RUNTIME.md`. You cannot use both styles at once. If you do, validation reports `inline runtime and runtimes/ cannot coexist`.
- When `PLUGIN.md` has a `version`, it must be the same as the `version` in `package.json`. `package.json` must also say `"type": "module"`: a plugin package is ESM only, and validation and installation both refuse a package without that line.

After validation passes, select the plugin on the session-prep screen of the game and authorize it. Only then does it run. See the last step in [your first plugin](./first-plugin.md). For packaging and trial installs, see [package and try install](../ship/package.md).

## Where to declare what my code registers

Everything a plugin contributes is written in the `contributes` section of `PLUGIN.md`. The names you register in code must match the names written here. If you have one too many or one too few, the plugin fails to load.

The code is in the entry file. `PLUGIN.md` points to it with `entry`:

| What you call in the entry file        | What to write in `contributes` |
| -------------------------------------- | ------------------------------ |
| `covel.registerTool(...)`              | `tools`                        |
| `covel.registerRpc(name, ...)`         | `actions`                      |
| `covel.registerService(...)`           | `services`                     |
| `covel.provideExtension(...)`          | `extensions`                   |
| `covel.on(event, ...)`                 | `hooks`                        |
| `covel.registerFormValidator(name, …)` | `forms`                        |

Three more items only need a declaration, with no code:

- `contributes.commands`: commands that the player uses in the input box. Each command points to a name in `actions`, so that name must also appear in `actions`.
- `contributes.prompt`: a fixed prompt fragment. See [prompt-only plugins](./prompt-only.md#add-a-fixed-reminder).
- `contributes.events`: events that the plugin emits.

In one session, only one plugin may declare a given event name. When two enabled plugins declare the same name, the later one is excluded from that session, with the reason `event-topic-conflict`. So give your event names your plugin's prefix:

```yaml
contributes:
  events:
    - topic: my-plugin.noted
      schema: ./schemas/noted.event.json
      description: Emitted after a note is saved.
```

> [!NOTE]
> The validation command only reads files. It does not run the entry file. So it cannot find "declared but never registered in code". That error appears only when the plugin loads. You can catch it early with [offline runs](./testing.md).

## Which tools the model can use

There are two lists, with different jobs:

| List                | Where it is written        | What it means                   |
| ------------------- | -------------------------- | ------------------------------- |
| `contributes.tools` | `PLUGIN.md`                | The tools this plugin registers |
| `agent.tools`       | The agent runtime's config | The tools this agent can call   |

`agent.tools` has two groups: `builtin` holds the tools that Covel provides, and `plugin` holds your own tools.

```yaml
agent:
  model: plugin
  tools:
    builtin: [plugin-data-set]
    plugin: [save-note]
```

Rules:

- The model can call only the tools listed here. A tool that is not listed is not visible to it.
- When the plugin has one runtime (written in `runtime:`) and does not write `agent.tools.plugin`, that runtime gets all the tools in `contributes.tools`. You do not need to list them again.
- When you write `plugin`, what you write is what counts. `plugin: []` means no tools of its own are given.
- In a plugin with several runtimes, each runtime lists the tools it uses.
- A tool name is unique only within its own plugin. One plugin cannot call another plugin's tool. Use a service instead. See [plugin extensions and communication](../reference/plugin-extensions.md).

For the list of built-in tools, see the [tools reference](../reference/tools.md).

## How to use another plugin's results

Find a plugin by capability, not by name. A capability has a versioned name, such as `narrative-engine@1`. To read the output of "the plugin that writes the story" for this turn, write three things:

```yaml
requires: [narrative-engine@1]
runtime:
  io:
    inputs:
      narrative:
        from: { contract: narrative-engine@1 }
        select: /narrativeOutput
        required: true
```

| This part               | What it does                                                                                        |
| ----------------------- | --------------------------------------------------------------------------------------------------- |
| `requires`              | When this plugin is enabled, Covel makes sure a plugin that provides this capability is enabled too |
| `io.inputs.<name>.from` | Reads that plugin's result for this turn                                                            |
| `select`                | Takes only part of the result                                                                       |
| `required: true`        | When the upstream fails or does not exist, this runtime does not run                                |

In a prompt, the value read is `runtime-inputs.narrative.value`. In a function, it is `ctx.inputs.narrative.value`.

There are two more fields that control order only: `schedule.needs` requires the upstream to succeed, and `schedule.after` only requires the upstream to have finished. An input with `required: true` already includes the condition "upstream succeeded", so you do not need to write `needs` again.

> [!IMPORTANT]
> A reference across plugins may only use a capability name. Writing another plugin's runtime name (for example `other-plugin/some-runtime`) in `needs`, `after` or `io.inputs` makes the manifest fail to load. Runtimes inside the same plugin can refer to each other by runtime name.

One capability can have several providers. Use `cardinality: one` to mean "only one is needed", and `cardinality: all` to mean "all of them are needed". To make your plugin mutually exclusive with other plugins that provide a capability, write `conflicts` in `PLUGIN.md`.

Runtimes triggered by an event can also be ordered. Among the runtimes triggered by the same event, `needs` and `after` still apply, and runtimes without a dependency still run at the same time. A dependency does not trigger a runtime that no event matched. Runtimes that run in the background cannot be ordered this way. To pass work along, send a follow-up event, or read the output the other side has already saved.

For the ways of communicating (results for the same turn, saved results, events, services and extension points), see [plugin extensions and communication](../reference/plugin-extensions.md).

## Some content must not be visible to the player early

A runtime that handles hidden plot or the answers to mysteries declares `io.concealed: true`:

```yaml
io:
  visibility: plugin
  concealed: true
```

Once it is declared:

- Its prompts, model replies, tool arguments, tool results and output do not appear in debug records, live progress, or the execution history the player can see. Only the name, the status, the duration and the usage remain.
- When it fails, the player sees a fixed generic message. The real reason is written only to the server log.
- The text it outputs is not written to the conversation record, and other runtimes cannot read it. Forms and interface blocks are still shown as usual.

`io.concealed: true` cannot be used together with `io.visibility: story`. Loading fails, because story runtime text is meant for the player to read anyway.

To pass hidden content to another plugin, send it with an output capability. The receiving plugin stores it in its own hidden data namespace. For examples, see the [story-events plot runtime](../../../plugins/story-events/runtimes/plot/RUNTIME.md) and [world data · hidden data](../reference/world-data.md#hidden-data-visibility-hidden).

## Data ownership

### Where my data lives

Each plugin has its own area of data. It is read and written by "namespace + key". No other plugin can read it.

| Where                           | How to read it                                                          | What you get                                                |
| ------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------- |
| Function, guard, extension code | `ctx.pluginData.get(namespace, key)`                                    | The stored value itself. When there is none, `null`.        |
| Same as above                   | `ctx.pluginData.list(namespace)`                                        | A set of `{ key, value, createdAt, updatedAt }`             |
| Function, RPC                   | `ctx.store.getPluginData(namespace, key)` / `listPluginData(namespace)` | A row such as `{ key, value }`. When there is none, `null`. |
| An agent's prompt               | List the namespace in `io.selfData`                                     | The contents of that namespace are put into the prompt      |

There are two ways to write: in a function, call `ctx.pluginData.set(namespace, key, value)`, or have a tool submit a request saying "I want to write this" (a proposal). Both are saved together at the end of the turn. When a runtime fails, none of its writes are left behind.

Limits to remember:

- A value can be at most 256 KiB once it is converted to JSON. When it is larger, the write fails. The error states the plugin, the `namespace/key`, the actual size and the limit. The original value does not change, and nothing is cut short. A list that keeps growing must be split across several keys, or trimmed by your code.
- A namespace that starts with `_` is reserved for Covel itself. Plugins cannot write to it.
- If two plugins need to share data, they must do it through a public capability. They cannot read each other's namespaces.

### Who owns characters

Characters, character field definitions and the lorebook are kept by Covel and shared by all plugins. Read them through `ctx.world`. To change them, submit a request. Do not copy characters into your own data namespace, and do not read another plugin's private data.

### When you want the world author to supply this data

Declare `version`, `schema` and `accepts` for a data namespace in `contributes.data`. Then a world package can import content into it. Adding `authoring` lets world authors and authoring tools know how to write the content. For how to do this, see [advanced · data contracts and world import](./advanced.md#data-contracts-and-world-import) and the [world data reference](../reference/world-data.md).

If an imported record contains a nested list, and the list items are told apart by a field other than `id` (for example `label`), declare `authoring.source.localeArrayKeys: [label]`. Then, after the author changes the order of the list in the main file, the translation still matches the same record.

### When you want memory retrieval to find this data

Add `search: { text: <field name> }` to the namespace declaration. See [searchable data](../reference/plugins.md#searchable-data).

Memory itself is managed by the memory plugin. When a world needs custom memory blocks, import them through `memory.blocks@1`. See the [world data reference](../reference/world-data.md). There are no fields such as `memoryBlocks` or `summaryFocus` in the manifest.

## Prompts and localization

### Where the prompt is written

| Content                           | Where it is written                                                                             |
| --------------------------------- | ----------------------------------------------------------------------------------------------- |
| An agent's prompt                 | The body of the `PLUGIN.md` or `RUNTIME.md` it is in                                            |
| A fixed extra fragment            | `contributes.prompt` in `PLUGIN.md`                                                             |
| A fragment that differs each turn | Provided by code. See [plugin extensions and communication](../reference/plugin-extensions.md). |

A fragment in `contributes.prompt` belongs to the whole plugin. It cannot apply to only one runtime. A rule that applies to one runtime only is written in the body of that runtime.

For how to write a good body, see [prompt style](./prompt-style.md).

### Which language to write in

| Content                                             | Language and location                                                                          |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Names, descriptions and setting labels              | English, written in `PLUGIN.md` / `RUNTIME.md`                                                 |
| Their translations                                  | `locales/<language>.yaml`. You can add any language.                                           |
| Prompt body                                         | English, written in the body of `PLUGIN.md` / `RUNTIME.md`                                     |
| Simplified Chinese version of the prompt (optional) | `PLUGIN.zh.md` / `RUNTIME.zh.md`. It holds only the body and the `content` of fixed fragments. |

The key points:

- A game in Simplified Chinese reads `*.zh.md`. A game in any other language reads the English body. Apart from Chinese, no other prompt language files are needed or read.
- The model outputs in the language of this game. Covel adds an instruction to the start of each agent's prompt that says which language to output in, so do not write it again in the body.
- The Chinese version cannot change the IDs or positions of tools, dependencies, capabilities or fragments. It can only change the wording. Parts that are not written fall back to the English version.
- Text generated by code (for example, a message a tool returns to the model) uses `ctx.locale` to choose the language. Do not translate the manifest and forget the tool's return values.
- The agent prompts of plugins built into the repository must have a Chinese version. After you change any language, run `pnpm check:prompts`. When both languages are updated, run `pnpm prompts:lock`. A Chinese version is optional for community plugins.

For the full rules, see the [multilingual reference](../reference/i18n.md#2-localize-a-plugin) and [prompt structure](../reference/prompt-structure.md).

## Validation and discovery

### What validation checks

```bash
pnpm validate:plugin ~/.covel/plugins/my-plugin
```

The argument can be the plugin's folder, its `PLUGIN.md`, or a `RUNTIME.md`. All three forms check the whole plugin.

It only reads files. It does not run the entry file, the guards or the functions. It checks fields, stages, tool names, the files referred to, the capabilities that inputs refer to, and schemas. When there is an error, it says which field of which file it is in.

An input that reads "saved results" (`scope: committed`) gets the complete result, so you cannot write `select` for it. To take only part of it, read the result for the same turn (the default).

### How to see what a plugin declares

A running server provides three query APIs:

| API                               | Returns                                                                                |
| --------------------------------- | -------------------------------------------------------------------------------------- |
| `GET /api/plugins/:id`            | This plugin's capabilities, settings, runtimes, tools, interface and data declarations |
| `GET /api/framework/capabilities` | All the basic capabilities and query entry points that Covel provides                  |
| `GET /api/worlds/:id/plugin-plan` | Which plugins this world enables by default                                            |

### How to limit the Covel versions it works with

Write a range such as `covel: ">=0.0.45"` in `PLUGIN.md`. Covel outside the range refuses to install the plugin, and an installed plugin is not loaded. A standalone plugin made by `pnpm create-plugin` already has the version at generation time written as its lower bound. For the syntax, see [collections · version ranges](../ship/collections.md#version-ranges).

### How to let players know who made it

Write `version`, `author`, `license` and `homepage` in `PLUGIN.md`. The author name, a short note for players, and a few `https` links are shown on the session-prep screen and in the installed list. Before a player opens a link, they see a warning about third-party links. For the fields and their limits, see [author information](../reference/plugins.md#author-information).

## What you can use in code

A plugin's code depends only on the public SDK `@covel/plugin-handlers-utils`. Do not import Covel's internal packages, database tables or front-end components.

> [!IMPORTANT]
> This SDK is not published to npm, and installing a plugin does not run `npm install`. A plugin in the user directory must be able to run by itself. What it needs must either come from the arguments Covel passes in (`ctx`, `covel.toolkit`), or be bundled into the plugin. Built-in plugins under the repository's `plugins/` can `import` it directly.

Helpers you will often use:

| Need                                          | Use                                                                                                          |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Dice rolls and other random numbers           | `ctx.random` (in a tool it is `context.random`; when generating IDs, it is the fourth argument of `shortId`) |
| Get the current language of multilingual text | `resolveI18nText` / `resolveI18nDeep`                                                                        |
| Estimate the token count of a piece of text   | `estimateTokens`                                                                                             |
| Sort your own text by relevance               | `rankTexts` / `searchTerms` / `searchExcerpt`. These do not call a model.                                    |
| Sort IDs, keys and timestamps                 | `compareText`                                                                                                |
| Load your own prompt template                 | `createPromptLoader(root)` from `@covel/plugin-handlers-utils/prompts`                                       |
| Validate forms and character fields           | The form tools and character field validation in the SDK                                                     |

Two rules about repeatability:

- Use `ctx.random` for random numbers only. Do not use `Math.random` or `node:crypto`. Only then can a test server started with `COVEL_RANDOM_SEED` repeat the same results in the same session.
- Sort with `compareText`. Do not use `localeCompare` without a language argument. Its results change with the server's system language.

Do not give the model bookkeeping fields: session IDs, record UUIDs and timestamps. Covel already removes them from what it puts into prompts. For text you assemble yourself, use `modelFacingJson`. When you need to say "which turn", use the turn number.

## When it does not work as expected

| Symptom                                                                         | Cause and fix                                                                                                                     |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Validation reports `inline runtime and runtimes/ cannot coexist`                | `PLUGIN.md` has a `runtime:` section, and there is also a `runtimes/` folder. Keep only one.                                      |
| Validation reports `Invalid option` or `Invalid input` for a field              | The field's value or shape is wrong. Check the field path reported against the [plugin field reference](../reference/plugins.md). |
| Validation passes, but the plugin fails to load                                 | The names the entry file registers do not match `contributes`.                                                                    |
| The model does not call my tool                                                 | The tool is not listed in `agent.tools.plugin`. A plugin with several runtimes must list it.                                      |
| The plugin is excluded from the session, with the reason `event-topic-conflict` | An event name is the same as another plugin's. Add your own prefix to the event name.                                             |
| A write fails, with a message that the size limit was exceeded                  | A value is over 256 KiB. Split it into several keys.                                                                              |
| In a game in Chinese, changes to the prompt have no effect                      | You changed only the English body. A game in Chinese reads `*.zh.md`.                                                             |

## Next

- Write only configuration and prompts: [prompt-only plugins](./prompt-only.md)
- Write tools and functions: [plugins with local code](./local-code.md)
- Testing: [plugin testing](./testing.md)
- Share with others: [verify and distribute](../ship/index.md)
