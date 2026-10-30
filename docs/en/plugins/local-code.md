# Plugins with local code

This page shows you how to add your own code to a plugin: a tool a model can call, an action that a UI or a player command can call, and a function that does not go through a model. When you finish, you have a plugin called "notebook". After each turn of the story, the model calls the `save-note` tool you wrote, to record one fact.

The rule behind the split is: **the model reads the text, and your code checks and writes the data.** If something can be worked out fully from rules, do not use a model. Write a function.

## Before you start

- Finish the [first plugin](./first-plugin.md), and read [the rules you need to know to write a plugin](./essentials.md).
- You should be able to write a little JavaScript.
- Run the commands below from the root directory of the Covel repository.

> [!IMPORTANT]
> The plugin on this page lives in the user plugin directory. Covel provides `@covel/plugin-handlers-utils` and `zod`, so the code can import them directly. Installing a plugin does not run `npm install`. Bundle other dependencies into the plugin.

## 1. Create the folders

```bash
mkdir -p ~/.covel/plugins/notebook/{server,tools,schemas,tests}
```

After step 5, the folder contains these files:

```text
notebook/
├── PLUGIN.md                  config and prompt
├── README.md
├── server/
│   └── index.js               entry file: registers tools and actions
├── tools/
│   └── save-note.js           tool
├── schemas/
│   └── note.schema.json       what one record looks like
└── tests/
    └── runtime-cases.json     cases for offline runs
```

No `package.json` is needed: Covel loads the plugin's `.js` files as ES modules, and the version is in `PLUGIN.md`.

## 2. Write `PLUGIN.md`

```yaml
---
version: 0.1.0
description: Saves a brief note after narration.
requires: [narrative-engine@2]
contributes:
  tools: [save-note]
  data:
    notes:
      schema: ./schemas/note.schema.json
runtime:
  schedule: { stage: post-turn }
  io:
    inputs:
      narrative:
        from: { contract: narrative-engine@2 }
        select: /narrativeOutput
  agent:
    history: { maxTurns: 2 }
    finishWith: save-note
---
Read `runtime-inputs.narrative.value`. Call `save-note` one time with one fact that the narrative states.
```

Compared with a plugin that has only a prompt, these parts are new:

| This part                        | Meaning                                                                                                                                                   |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`                        | The plugin's version. A plugin with an entry file needs one, raised with each release; `pnpm validate:plugin` reminds you when it is missing              |
| `server/index.js`                | The entry file. Covel runs it when it loads the plugin, and it registers the tools. Put it here and you need no `entry`                                   |
| `contributes.tools`              | The tools this plugin registers. The names must match the names registered in the entry file                                                              |
| `contributes.data.notes`         | Declares the `notes` data space, and the shape (schema) of one record                                                                                     |
| `agent.history: { maxTurns: 2 }` | The model sees the conversation of only the last 2 turns. See [controlling how much history the model sees](#controlling-how-much-history-the-model-sees) |
| `agent.finishWith`               | After `save-note` succeeds, this agent ends right away, and does not ask the model one more time                                                          |

This plugin has only one runtime, so you do not need to write `agent.tools.plugin`. It gets all the tools in `contributes.tools` automatically.

## 3. Write the tool

`tools/save-note.js`:

```js
import { makeProposal } from "@covel/plugin-handlers-utils";

export default function makeSaveNote({
  tool,
  z,
  withPendingProposals,
  withModelView,
}) {
  return tool({
    name: "save-note",
    description: "Save one short fact that the current narrative states.",
    annotations: { idempotent: true },
    parameters: z.object({
      id: z.string().min(1).describe("Stable short key, e.g. gate-is-locked"),
      text: z.string().min(1).max(300),
    }),
    async execute(params, context) {
      const proposal = makeProposal(
        context,
        new Date().toISOString(),
        "plugin.data",
        {
          namespace: "notes",
          key: params.id,
          value: { id: params.id, text: params.text },
        },
      );
      return withModelView(
        withPendingProposals({ id: params.id }, [proposal]),
        { summary: "Queued a note." },
      );
    },
  });
}
```

This file exports one function. Covel passes a set of helpers to it:

| Helper                 | What it does                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------------- |
| `tool`                 | Defines a tool                                                                                          |
| `z`                    | Describes the shape of the parameters (Zod). If the model passes wrong parameters, the call is rejected |
| `withPendingProposals` | Hands back "what the tool returns to the model" together with "the data it wants to write"              |
| `withModelView`        | Select the model-facing summary and/or data without changing content                                    |
| `ToolError`            | Throw a coded failure with an optional hint                                                             |
| `shortId`              | Generates a short ID. Pass `context.random` as the fourth argument                                      |

The model reads the [unified tool envelope](../reference/tools.md#unified-result-format-and-error-codes). This example sends only a summary plus the automatic staged notice; code still reads `{id}`. Use `new ToolError("not-found", "The requested note was not found.", { hint: "Check the name." })` for a coded failure. `ctx.tools.call` returns full content on success and rejects with `ToolError` on failure; its message is plain text, and `code` and `hint` are separate fields.

The tool does not write to the save directly. It returns a **write request** (a proposal). Its type is `plugin.data`, and its content means "write this one record into `notes`". Covel checks these requests when the execution commits. If this runtime fails or its commit is rejected, this write is not saved.

This tool overwrites the same record by a stable key, so it declares `idempotent: true`. Read tools can also declare `readOnly` and `concurrencySafe`; use `timeoutMs` for a per-call limit. See [Annotations and timeout](../reference/tools.md#annotations-and-timeout) for defaults and validation rules.

Three rules:

- Take the plugin ID and the session ID from `context`. Do not let the model pass them in as parameters.
- A successful tool call does not mean the data is saved. Saving happens when the turn ends.
- A tool that only reads data can return its content directly. It does not need `withPendingProposals`.

> [!NOTE]
> `makeProposal` fills in the request's ID, source and turn information. Use `context.random` for game randomness; the SDK generates request IDs.

`schemas/note.schema.json` describes the shape of one record. When a world package imports content into this data space, it checks the content against this schema. See [Advanced · Data contracts and world import](./advanced.md#data-contracts-and-world-import). The `parameters` above validate tool arguments. This example declares no `datasets`: `contributes.data` alone does not enable dataset validation for tool writes. To validate records at commit too, declare a [dataset](../reference/plugins.md#datasets-contributesdatasets) and keep its schema aligned with the tool arguments and import schema:

```json
{
  "type": "object",
  "required": ["id", "text"],
  "additionalProperties": false,
  "properties": {
    "id": { "type": "string", "minLength": 1 },
    "text": { "type": "string", "minLength": 1 }
  }
}
```

## 4. Write the entry file

`server/index.js`:

```js
import makeSaveNote from "../tools/save-note.js";

export default function register(covel) {
  covel.registerTool(makeSaveNote(covel.toolkit));
}
```

`covel.toolkit` is the set of helpers used in the previous step.

After changing entry registrations, run these commands from the repository root:

```bash
pnpm plugin:extract ~/.covel/plugins/notebook
pnpm plugin:extract ~/.covel/plugins/notebook --check
pnpm plugin:extract ~/.covel/plugins/notebook --check --json
```

The first command runs the entry factory on the author's machine, writes the six registration lists (`tools`, `actions`, `services`, `forms`, `wires`, `hooks`) into `contributes` in the root `PLUGIN.md`, and prints changed keys. When already in sync, it prints `Declarations are in sync.`. Lists are deduplicated in first-registration order; normal hooks become event names, and other phases become `{ event, enforce }`. Empty list keys are removed. Comments, other fields and the Markdown body are preserved.

`--check` writes nothing and shows removed names with `-` and added names with `+` per key; changes only to order or spelling are described separately. It exits 1 on drift and 0 when in sync, for CI. `--json` emits `extracted` and `drift`. Extraction errors exit 1; invalid arguments exit 2.

Extension registrations and command metadata are reported without rewriting: `extensions` can carry declaration-only options, and `commands` has no entry registration method. Authors still maintain those declarations. Only canonical `PLUGIN.md` is changed; a `PLUGIN.<locale>.md` containing these registration lists, `extensions` or `commands` is reported by filename and left intact. Localized `contributes.prompt` is allowed.

> [!CAUTION]
> This command executes plugin entry code with your permissions and is meant for your own package. It records registrations without invoking tool, action, service or hook handlers; calling host capabilities such as `covel.http` during registration fails. A throwing factory, an entry path escaping the package or executable frontmatter prevents write-back. Installation and approval still read static declarations, and loading still [checks both directions](../reference/plugins.md#contributes-fields).

## 5. Validate and run offline

```bash
pnpm validate:plugin ~/.covel/plugins/notebook
```

```text
✓ Static package validation: /Users/you/.covel/plugins/notebook
  languages: text en; instructions en
```

Validation does not run your code. To confirm that the tool is really registered and really can write, add an offline case. `tests/runtime-cases.json`:

```json
{
  "cases": [
    {
      "name": "saves-one-note",
      "runtimeId": "notebook",
      "message": "The north gate is locked at dusk.",
      "llmResponses": [
        {
          "content": null,
          "finishReason": "tool_calls",
          "toolCalls": [
            {
              "id": "tc-1",
              "name": "save-note",
              "arguments": "{\"id\":\"gate-is-locked\",\"text\":\"The north gate is locked at dusk.\"}"
            }
          ]
        }
      ],
      "expect": {
        "runtimeResults": [{ "runtimeId": "notebook", "status": "success" }],
        "pluginData": [
          { "namespace": "notes", "key": "gate-is-locked", "field": "text" }
        ]
      }
    }
  ]
}
```

This case pretends the model called `save-note` once, and then checks whether the record is in `notes`. Run it:

```bash
pnpm test:runtime -- notebook --pretty
```

The start of the output:

```json
{
  "status": "ok",
  "mode": "mock",
  "pluginId": "notebook",
  "cases": [
    {
      "name": "saves-one-note",
      "status": "passed",
```

Further down, you can see the saved data:

```json
"pluginData": {
  "notes": [
    {
      "key": "gate-is-locked",
      "value": {
        "id": "gate-is-locked",
        "text": "The north gate is locked at dusk."
      }
    }
  ]
},
```

At this point, the tool works end to end. To go into the game, use the same method as the last step of the [first plugin](./first-plugin.md). For every way to write a case file, see [Plugin testing](./testing.md).

## The model can write only through tools

Even if the agent's final reply includes fields that look like "data to save", they have no effect. Covel removes these fields and writes a warning to the server log:

`statePatches`, `pluginData`, `notifications`, `assetGenerations`, `interactions`, `ui`, and `events` that have a `topic`.

To let an agent write something, give it a tool, and list it in `agent.tools`:

| What you want to do                 | Tool                                                                                                              |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Write its own data                  | Its own tool, or the built-in `plugin-data-set`                                                                   |
| Emit an event                       | The built-in `emit-event` (session topic enum and payload schemas; see [tools](../reference/tools.md#emit-event)) |
| Send the player a notice            | The built-in `create-notification`                                                                                |
| Ask the player for structured input | The built-in `create-form`                                                                                        |

If you want to require the agent to call a tool successfully on every run, write `completion: { require: tool-use }`. In this case, "no change" must also be submitted through a tool (for example, by submitting an empty list). Otherwise the run counts as failed.

The value of one `plugin.data` can be at most 256 KiB. See [Data ownership](./essentials.md#data-ownership).

## Controlling how much history the model sees

If you do not write `agent.history`, the agent sees the history shared by the whole game: the messages that are not yet compacted, plus the compacted summary. This grows as the game gets longer.

An agent that only works on the content of this turn should limit its scope:

```yaml
agent:
  history: { maxTurns: 2 } # 0 means no history
```

| Setting                               | Effect                                                                            |
| ------------------------------------- | --------------------------------------------------------------------------------- |
| `maxTurns: 2`                         | Keeps only the messages the player could see in the last 2 turns, with no summary |
| `maxTurns: 0`                         | No history                                                                        |
| `maxTurns: 2, includeSummaries: true` | The last 2 turns, plus the summary                                                |

Whatever you set, these stay in place: the player's input for this turn, the story text of this turn, the inputs you declared, `io.selfData`, and the fragments that code provides.

Two more points:

- An agent that runs after the story (`post-turn`, `audit`) reads a conversation that ends with the story text of this turn. In your prompt, you can say "the last story text in the conversation is the narrative of this turn". When you need to take a value by field, still read `runtime-inputs.<name>.value`. For details, see [Prompt structure · Story text of this turn](../reference/prompt-structure.md#this-turns-story-text).
- Variables in the prompt that change with the plot (`{{ player.character }}`, `{{ characters.npcs }}`) make the prompt different every turn, so the model provider's cache cannot be used. For how to change this, see [Prompt structure · Variables and data boundaries](../reference/prompt-structure.md#4-template-variables-and-the-data-boundary).

For a plugin that needs to look back over a long time, store the key points in its own data, or [read the complete records page by page](#read-the-complete-story-record) in a function.

## Add an action and a player command

An action (RPC action) is a piece of code that the UI or a command can call directly, without going through the model. A command is the `/name` the player types into the input box. The two are declared separately: an action can be for the UI only, with no command.

Add this to `contributes` in `PLUGIN.md`:

```yaml
contributes:
  actions: [inspect-note]
  commands:
    - name: note
      description: List the saved notes.
      action: inspect-note
```

Register the action with the same name in the entry file:

```js
export default function register(covel) {
  covel.registerTool(makeSaveNote(covel.toolkit));

  covel.registerRpc("inspect-note", async (_payload, ctx) => {
    const rows = await ctx.store.listPluginData("notes");
    return { ok: true, data: rows.map((row) => row.value) };
  });
}
```

Notes:

- The `payload` that the UI sends is external input. Check it before you use it.
- An action's writes take effect at once. They do not belong to a turn, so if a later step fails, they are not undone. To "save only if everything succeeds", use a function runtime that is triggered manually.
- Keep actions quick. An action that runs longer than 30 seconds fails: `ctx.signal` aborts and every later `ctx.store` call is refused. Put slow work in a runtime with `schedule.background: true`.
- Offline runs do not support actions. When one runs, it prints `Unsupported rpc: notebook/inspect-note. Verify with the server.`, and this is not an error. Verify actions on a real server.

## Write a function

A fixed rule does not need a model. Give the runtime a `function` block, and it is a function instead of an agent:

```yaml
runtime:
  schedule: { stage: post-turn }
  io:
    inputs:
      narrative:
        from: { contract: narrative-engine@2 }
        select: /narrativeOutput
  function:
    timeoutMs: 30000
    tools: { builtin: [get-character] }
```

The code is in `handler.js` next to the manifest by default; when it is somewhere else, point `function.handler` at it. When no other setting is needed, write `function: {}`.

`handler.js` exports one function by default:

```js
/** @type {import("@covel/plugin-handlers-utils").PluginFunctionHandler} */
export default async function handler(ctx) {
  const text = String(ctx.inputs?.narrative?.value ?? "");
  const words = text.split(/\s+/).filter(Boolean).length;

  await ctx.pluginData.set("stats", "last-turn", { words });

  return { outcome: "success", value: { words } };
}
```

The comment at the top is only a type hint for your editor. It is not a real `import`.

A function's return value has three separate parts:

| Field        | Meaning                                                                 |
| ------------ | ----------------------------------------------------------------------- |
| `value`      | The business result. Another runtime reads this through its inputs      |
| `effects`    | Effects to produce: events, notifications, forms, and so on             |
| `completion` | A function in the opening stage uses it to report "finished" (`"done"`) |

Putting effects inside `value` has no effect. On failure, return `{ outcome: "failed", error: "原因" }`.

Things a function often uses:

| Form                                                                          | What it does                                                                                                                                                                                                                             |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ctx.inputs.<名字>.value`                                                     | An input you declared                                                                                                                                                                                                                    |
| `ctx.playerMessage`                                                           | The player's input for this turn                                                                                                                                                                                                         |
| `ctx.playerActions`                                                           | The player's resolved actions of this turn (seat, kind, character, text, `fields`); see [action kinds](../reference/plugins.md#action-kinds-contributesactionkinds). Empty without player input                                          |
| `ctx.manualPayload`                                                           | The data the UI sends with a manual trigger                                                                                                                                                                                              |
| `ctx.pluginData.get/list/set/update`                                          | Reads and writes your own data; see [change data](#change-data)                                                                                                                                                                          |
| `ctx.world`                                                                   | Characters, character field definitions, lorebook and the session's seats, `seats`. Read-only. For the character the player is acting as, see [Who the player is](#who-the-player-is)                                                    |
| `ctx.userSettings`                                                            | The player's settings                                                                                                                                                                                                                    |
| `ctx.random`                                                                  | Random numbers. Use only this for dice rolls                                                                                                                                                                                             |
| `ctx.locale`                                                                  | The language of this game                                                                                                                                                                                                                |
| `ctx.tools.call(name, args)`                                                  | Calls a tool listed in `function.tools`                                                                                                                                                                                                  |
| `ctx.logger`                                                                  | Writes to the plugin log                                                                                                                                                                                                                 |
| `ctx.signal`                                                                  | Gets notified when the run is cancelled                                                                                                                                                                                                  |
| `ctx.recursiveCall({ playerMessage, manualTrigger: { runtimeId, payload } })` | Calls a runtime in your own package within this turn; see [nested calls](../reference/plugins.md#nested-calls-ctxrecursivecall). Use [services or events](../reference/plugin-extensions.md#choose-a-way-to-communicate) across packages |
| `ctx.recursionDepth`                                                          | Above 0 when `recursiveCall` runs this one nested. Check it before doing what belongs to the top level only                                                                                                                              |
| `ctx.execution?.sourceTurnId`                                                 | When an old turn is retried, the ID of that turn. Key rolls and reveals by it, and a retry does not draw again                                                                                                                           |
| `ctx.store.getSession()`                                                      | This game's phase, turn count, language, and the progress of the opening steps (read-only)                                                                                                                                               |

- Every field above is in the `PluginFunctionContext` type, so the type comment at the top lets the editor suggest and check them.
- The tools a function can call are listed in `function.tools`. The function's time limit is `function.timeoutMs`. Do not write these two under `agent`: a function runtime cannot have an `agent` setting.
- To let the next turn or another run read this result, declare `io.output.recordAs` on this side, and declare `scope: committed` with the same `recordAs` on the reading side.
- A function has no assembled conversation. It reads this turn's content from `ctx.playerMessage`, from the inputs you declared, or from the `turn-digest@1` input that Covel provides (which includes `playerMessage` and `narrativeText`).

## Read data

```js
const notes = await ctx.store.listPluginData("notes"); // [{ key, value }, ...]
const row = await ctx.store.getPluginData("notes", "gate-is-locked"); // { key, value } or null
const value = await ctx.pluginData.get("notes", "gate-is-locked"); // the value itself, or null
const characters = ctx.world?.characters ?? [];
```

The data space here belongs to the current plugin. Covel decides which session it is read from. There is no way to pass in another plugin's ID to read its data. To use something from another plugin, go through inputs, services, or extensions. See [Plugin extensions and communication](../reference/plugin-extensions.md).

Character data that a tool or a function reads already includes the changes that earlier steps of this turn proposed and that are not saved yet. So "write first, then read" returns what was just written. Do not get around this by reading old saved data, and do not submit the earlier steps' write requests a second time.

Plugin data works the same way: what you read includes what earlier, completed runtimes of the same plugin wrote in this execution and has not been saved yet. When such a write is refused at save time, the runtimes that read it are dropped too (the story excepted). The rules are under [In-execution plugin-data visibility](../reference/plugins.md#in-execution-plugin-data-visibility).

### Who the player is

A session may have several `type: player` characters (one person playing two characters, for example). The action's `actorId` identifies the character being played; without an actor, use the primary seat's current character from `ctx.world.seats`. Find that character with the SDK helper:

```js
import { actingCharacterOf } from "@covel/plugin-handlers-utils";

const player = actingCharacterOf(
  ctx.playerActions,
  ctx.world.characters,
  ctx.world.seats,
); // the character record, or undefined when no actor or current character exists
```

- Do not use `ctx.world.characters.find((c) => c.type === "player")`: with several player characters it finds only the first.
- A detached job uses `ctx.inputs.turn.value.actions ?? []` to retain its source turn’s actor. Tools and extension providers have no actions and pass `[]`. The action’s actor takes precedence over the primary seat’s current character; see [Seats](../reference/world-model.md#seats) for the full rule.
- `seatCharacterIds(seat, characters, seats)` gives every character ID bound to a seat, including the other characters the player controls.
- Seats are read-only. After the player switches the current character, reads see the new one from the next turn. For the binding and current-character rules, see [Seats](../reference/world-model.md#seats).

### Read the complete story record

`ctx.store.readTurnMessages` reads all saved messages page by page, including the original text that has been replaced by a summary. Store the position you reached, and next time read only what was added:

```js
const saved = await ctx.store.getPluginData("progress", "cursor");
let after = saved?.value ?? undefined;
let page;
do {
  page = await ctx.store.readTurnMessages({ after, limit: 200 });
  for (const message of page.messages) collect(message); // { turnId, role, content, compacted, ... }
  after = page.cursor ?? undefined;
} while (page.hasMore);
await ctx.pluginData.set("progress", "cursor", after ?? null);
```

- `limit` defaults to 100, and the maximum is 500.
- `cursor` is a string you do not need to understand. It points to the last message read. When the page is empty, it returns the `after` you passed in, unchanged.
- `hasMore` being `false` means you have reached the end.
- Messages come in the order they were saved. A background execution's message can carry an earlier time than the message before it, but it was saved later, so it still comes after the position you stored and is not missed.
- It returns only saved messages. It does not include the turn that is still running.

## Change data

`ctx.pluginData.set(namespace, key, value)` writes a whole value. When the value is computed from the stored one (3 gold less, one more item in a list), submit a list of operations with `ctx.pluginData.update` instead:

```js
try {
  await ctx.pluginData.update("wallet", "gold", [
    { op: "inc", by: -3, min: 0 },
  ]);
} catch (error) {
  // The ops fail against the current value: here, not enough gold.
  return { outcome: "failed", error: "not enough gold" };
}
const gold = await ctx.pluginData.get("wallet", "gold"); // the value after the ops
```

The bundled [inventory ledger](../../../plugins/inventory/lib/update-inventory.js) and [affinity tool](../../../plugins/affinity/tools/update-affinity.js) are complete examples of operation-based dataset (数据集) writes: existing counters use `inc`, new records use `set`, and derived fields such as affinity tiers and progress bars are computed from the read value plus the delta, then written with `merge`. Concurrent commits combine the counter deltas; derived fields and history written as a whole array still follow the tool’s prediction and can lag the final counter.

- The operations apply at commit to the latest stored value. When two runs each take 3 at the same time, both take effect; neither overwrites the other.
- The call first tries them on the value it sees now. When they fail (for example the result is below `min`), it throws and writes nothing, so you can handle it right there.
- It returns nothing. Read the key again for the new value.
- The operations are `set`, `merge`, `inc`, `append`, `insert`, `remove`, `upsertItem` and `delete`. For the rules at commit, see [Transactions · Operation-based writes](../reference/transactions.md#operation-based-writes-plugindataupdate).

The affinity plugin also uses the existing `prompt.segment@1` to project its own committed scores for story runtimes, without copying them into character fields. See [current-affinity](../../../plugins/affinity/server/current-affinity.js) and the [extension contract](../reference/extension-points.md).

## Ask the player for input: a form

Use a form when the player must fill in structured content (creating a character, allocating points).

- For an agent: call the built-in tool `create-form`.
- For a function: return `{ type: "form", interactionId, title, fields, submitLabel }` in `effects.interactions`.

The optional `notice` is a line of text above the fields. It tells the player why they are seeing the form again (for example, the last submission could not be used). Write it in the language of this game.

A form checks required fields, ranges, and options by itself. Write more complex rules as a validator. Three places must match:

1. List the validator's name in `contributes.forms` in `PLUGIN.md`.
2. Write `validation: { name: "point-buy" }` in the form.
3. Register it in the entry file:

```js
covel.registerFormValidator("point-buy", (values, data, context) => {
  const text = "Strength is at most 15.";
  const issues = [];
  if (Number(values.strength) > 15) {
    issues.push({
      field: "strength",
      message: context.messages?.translations?.[text] ?? text,
    });
  }
  return issues.length > 0 ? issues : undefined;
});
```

A validator must be synchronous, and it must not produce other effects. The third argument has the language of this game, and the translations you wrote for that language in `locales/`.

| What the validator returns               | What the player sees                                               |
| ---------------------------------------- | ------------------------------------------------------------------ |
| `undefined`                              | The submission succeeds                                            |
| A string                                 | One error for the whole form                                       |
| `{ field, message }` or an array of them | One message under each field that has an error, all listed at once |

A rejected submission writes nothing and does not start a turn. The values the player entered are kept. In the event stream, it appears as `error.occurred` with `code: "form_rejected"`.

A form can be answered only once. Submitting it again gives `code: "interaction_already_submitted"`. For the submit endpoint and its fields, see [Tools reference](../reference/tools.md) and [API reference](../reference/api.md). For a full example, see the [point-buy form](../recipes/point-buy.md).

## When it does not work as expected

| Symptom                                                                    | Cause and fix                                                                                                                                                     |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Validation passes, but the plugin fails to load                            | The tool and action names registered in the entry file do not match `contributes`                                                                                 |
| The entry file reports that `@covel/plugin-handlers-utils` cannot be found | Load the plugin through Covel, or resolve the public SDK in the repository test environment. Standalone Node does not automatically receive host-supplied modules |
| A tool call is rejected in an offline case                                 | The `arguments` of the fake model do not match the tool's `parameters`                                                                                            |
| A tool call succeeds, but the data is not saved                            | The runtime ends as a failure at the end, so none of its writes are saved. Check the reason it failed on the debug page                                           |
| The case reports `Unsupported rpc`                                         | This is normal. Offline runs do not support actions. Verify on a real server                                                                                      |
| In a function, `ctx.tools.call` reports the tool is unavailable            | The tool is not listed in `function.tools`                                                                                                                        |
| The model writes data in its reply, but nothing happens                    | Data fields in a reply have no effect. Give it a tool                                                                                                             |
| An agent that declares `require: tool-use` always fails                    | It must successfully call a tool once even when there is "no change"                                                                                              |

## What's next

- Write unit tests for tools and functions: [Plugin testing](./testing.md)
- Several runtimes working together, world packages supplying data, and calling external APIs: [Advanced](./advanced.md)
- Add a panel that shows these records: [Plugin UI](./ui.md)
- Built-in plugin code you can look at: [the guide's tool](../../../plugins/guide/tools/generate-guide.js) and [world-time's action](../../../plugins/world-time/rpc/time.js)
