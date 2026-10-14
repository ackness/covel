# Plugin testing

This page explains how to write tests for a plugin: unit tests for tools and functions, and the full set of ways to write an offline case file. After you read it, you know what each kind of test can catch, which one to choose, and how to write the command.

If you are just starting, read [Test a plugin](../ship/test.md) first. That page takes about ten minutes to show you how to run validation and an offline run. This page is the detailed version.

Run all the commands from the root directory of the Covel repository.

## Choose a kind of test

From top to bottom, the tests get slower and closer to the real game:

| Test                 | Command                                               | What it can catch                                                       | Needs a server or model key? |
| -------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------- | ---------------------------- |
| Validation           | `pnpm validate:plugin <plugin directory>`             | Wrong configuration: fields, stages, tool names, missing files          | No                           |
| Unit test            | Vitest with `@covel/plugin-test-utils`                | Logic errors in one tool or one function                                | No                           |
| Offline run          | `pnpm test:runtime -- <plugin ID>`                    | A plugin that does not run: a tool is not registered, data is not saved | No                           |
| Real model check     | `pnpm e2e:verify`                                     | Real interfaces, event streams, and real model behavior                 | Yes                          |
| Package install test | `pnpm pack:test-plugin`, `pnpm test:plugin-lifecycle` | Install, authorization, restart, disable, and uninstall                 | No external keys needed      |

Choose based on what you changed:

| What you changed                                                         | At least run                                                         |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| Only `PLUGIN.md` / `RUNTIME.md`                                          | Validation                                                           |
| Code for a tool, a function, or a hook                                   | Validation, plus a unit test or an offline case                      |
| The agent's tool-calling flow, inputs, several runtimes, or event chains | Validation, plus an offline case                                     |
| Getting ready to release                                                 | All of the above, plus the [real model check](../ship/real-model.md) |

> [!IMPORTANT]
> A fake model passing does not mean that the real model, the authorization flow, or the server interfaces pass too. The first three kinds of test help you find your own mistakes quickly. The last two confirm that the plugin works in a real environment.

## Validation

```bash
pnpm validate:plugin ~/.covel/plugins/my-plugin
```

The argument can be the plugin's folder, a `PLUGIN.md`, or a `runtimes/<name>/RUNTIME.md`. All three forms check the whole package.

It checks:

- The name, type, and value of each field. A runtime that runs automatically and has no `stage` also raises an error.
- Whether the referenced files exist: code files, schemas, and interface files.
- The built-in tool names and the tool names the plugin declares.
- The capabilities that inputs reference, and the references between runtimes in the same package.
- Whether `version` is the same in `PLUGIN.md` and `package.json`.
- Whether there is a conflict between several runtimes.

When there is an error, it gives the path of the file and the field:

```text
✗ [plugin-loader] invalid manifest frontmatter
.../my-plugin/runtimes/analyst/RUNTIME.md: schedule.stage: Invalid option: expected one of "setup"|"pre-turn"|"narrative"|"post-turn"|"audit"; correct this field using the current plugin manifest reference
```

What it does not do: it does not run the entry file, the guards, or the functions. So it cannot find "a tool is declared, but the code never registers it". The two kinds of test below are needed for that.

## Unit tests

A unit test calls your tool or function directly, and checks its return value. It is the fastest, and it is the best way to test many edge cases.

### Where you can write them

A plugin that `pnpm create-plugin <name> --with-tools` generates under the repository's `plugins/` comes with unit tests of its own: there is an example in `tests/`, `package.json` has the `test` and `lint` scripts, and there is a `vitest.config.ts`.

A plugin generated into the user's plugin directory has no dependencies and no test configuration. These plugins are tested with validation and [offline cases](#offline-cases).

To run the tests of one plugin:

```bash
pnpm --filter @covel/plugin-my-plugin test
```

> [!NOTE]
> Run them from the plugin's own package. Do not run `pnpm vitest run plugins/<id>/tests` from the repository root. The `vitest.config.ts` in the package gives each run its own temporary directory and deletes it at the end. Running from the root skips it.

`pnpm --filter @covel/plugin-my-plugin lint` type-checks the code using JSDoc comments, so you do not have to convert the code to TypeScript. After you change code that calls the SDK, run both the type check and the tests.

### Test a tool

A tool is a function that receives helpers. In a test, pass the helpers in, and then call `execute` directly:

```js
import { expect, it } from "vitest";
import {
  getPendingProposals,
  getToolContent,
  withPendingProposals,
} from "@covel/plugin-handlers-utils";
import { tool, z } from "@covel/tools";
import makeSaveNote from "../tools/save-note.js";

const saveNote = makeSaveNote({ tool, z, withPendingProposals });
const ctx = {
  sessionId: "session",
  turnId: "turn",
  pluginId: "notebook",
  runtimeId: "notebook",
};

it("returns one plugin.data proposal", async () => {
  const result = await saveNote.execute(
    { id: "gate-is-locked", text: "The north gate is locked." },
    ctx,
  );

  expect(getToolContent(result)).toEqual({ saved: true, id: "gate-is-locked" });
  expect(getPendingProposals(result)[0]).toMatchObject({
    type: "plugin.data",
    payload: { namespace: "notes", key: "gate-is-locked" },
  });
});
```

A tool's return value has two parts. Use `getToolContent(result)` to get the "content returned to the model", and use `getPendingProposals(result)` to get the "data it wants to write". Do not assert on the whole return value as if it were the business content.

### Test a tool and really save

The test above only checks what the tool returned. To confirm that these writes really pass the checks and get saved, use `executeToolAndCommit`. It uses an in-memory store, and it goes through the same execution and save flow as in the game:

```js
import {
  createPluginTestStore,
  executeToolAndCommit,
} from "@covel/plugin-test-utils";

it("commits the note", async () => {
  const store = await createPluginTestStore(ctx);

  await executeToolAndCommit(
    saveNote,
    { id: "gate-is-locked", text: "The north gate is locked." },
    ctx,
    store,
  );

  const row = await store.getPluginData(
    "session",
    "notebook",
    "notes",
    "gate-is-locked",
  );
  expect(row?.value).toEqual({
    id: "gate-is-locked",
    text: "The north gate is locked.",
  });
});

it("rejects an empty id", async () => {
  const store = await createPluginTestStore(ctx);

  await expect(
    executeToolAndCommit(saveNote, { id: "", text: "x" }, ctx, store),
  ).rejects.toThrow("Tool parameter validation failed");
});
```

- When the arguments do not match the tool's `parameters`, the call is rejected, and nothing is saved.
- When a write is not valid (for example, a write into a namespace that starts with `_`), the save fails, and all writes from the whole execution are undone.
- To test several writes in the same execution, call the tool separately for each one first, and then save them together once with `commitToolResults([first, second], ctx, store)`.
- It does not include the server interfaces, authorization, or the event catalog. The server tests and the real model checks cover those boundaries.

### Test a function

`makeManualFunctionContext` builds the `ctx` that a function needs. You only provide the parts that this test uses:

```js
import { expect, it } from "vitest";
import { makeManualFunctionContext } from "@covel/plugin-test-utils";
import handler from "../runtimes/note/handler.js";

it("writes one note", async () => {
  const saved = new Map();
  const ctx = makeManualFunctionContext({
    pluginId: "my-plugin",
    manualPayload: { title: "Gate", text: "The gate is locked." },
    pluginData: {
      get: async (namespace, key) => saved.get(`${namespace}/${key}`) ?? null,
      set: async (namespace, key, value) => {
        saved.set(`${namespace}/${key}`, value);
      },
    },
  });

  const result = await handler(ctx);

  expect(result.outcome).toBe("success");
  expect(result.value.note.title).toBe("Gate");
  expect(saved.size).toBe(1);
});
```

Key points:

- It does not simulate saving. The `pluginData`, `world`, `tools`, `images`, `signal`, and `triggerEvent` that you pass in are given to the function as they are.
- If a `ctx.store` read method is not provided, calling it fails right away, for example with `store.getPluginData is not configured for this test context`. This way, a test does not quietly read empty data.
- By default, a fixed `ctx.random` is included, and it gives the same numbers on every run. So the result of a dice roll can be asserted directly.
- The effects that a function returns are in `result.effects`, for example `result.effects.interactions`.

### What the test kit contains

The exports of `@covel/plugin-test-utils`:

| Export                                                                 | Use                                                                                                                 |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `makeManualFunctionContext`                                            | Builds the `ctx` for a function                                                                                     |
| `makeRandom(seed?)`                                                    | The `ctx.random` for tests. Tests that write their own `ctx` put it in themselves                                   |
| `loadPluginMessages(pluginRoot, locale)`                               | Reads the translations in the plugin's `locales/` and gets `ctx.messages`. Use it when you assert on Chinese output |
| `createPluginTestStore` / `executeToolAndCommit` / `commitToolResults` | Makes a tool go through the real execution and save flow                                                            |
| `MockLLM`                                                              | A fake model. It records each call. It supports one default reply and a list of replies used in order               |
| `makeTurnInput` / `makeTriggerContext` / `makeRuntimeResult`           | Saves you writing test data. `makeTurnInput` defaults to `locale: "zh-CN"`, the same as the real game               |
| `expectAssetGenerated`                                                 | Asserts that `effects.assetGenerations` in the result has one valid media reference                                 |

Real tests you can follow:

- A function: [`plugins/character-blueprint/tests/presence.test.js`](../../../plugins/character-blueprint/tests/presence.test.js)
- A function triggered by an event: [`plugins/scene-stage/tests/handler.test.js`](../../../plugins/scene-stage/tests/handler.test.js)
- Generated media: [`packages/plugin-handlers-utils/tests/image-generation.test.ts`](../../../packages/plugin-handlers-utils/tests/image-generation.test.ts)

### Run a full turn in a test

In most cases, the offline cases in the next section are enough. Assemble a turn yourself only when you need exact control of each step in Vitest (for example, each runtime in an event chain):

1. Use `discoverPlugins` / `loadPluginDefinition` / `loadRuntime` from `@covel/plugin-loader` to load the real plugin.
2. Use `createMemoryStore` from `@covel/store/memory` as the store.
3. Run with `createToolExecutor` and `executeTurn` from `@covel/runtime`, and use `MockLLM` as the model.
4. Pass the whole `{ result, commit }` that `executeTurn` returns to `commitExecution` to save it. Do not split it up and write each item yourself.

A ready-made assembly is in [`packages/test-runtime/src/execution.ts`](../../../packages/test-runtime/src/execution.ts). For examples of event chains, see [`scene-stage-integration.test.ts`](../../../packages/runtime/tests/scene-stage-integration.test.ts) and [`emit-event-integration.test.ts`](../../../packages/runtime/tests/emit-event-integration.test.ts). For the boundary between execution and saving, see the [protocol reference](../reference/protocol.md#host-execution-and-commit-boundary).

<a id="coveltest-runtime"></a>

## Offline cases

`pnpm test:runtime` really runs your plugin. The only thing it swaps out is the model, for a fake one. It uses the same execution and save flow as the game: the settings defaults, tool permissions, and time limits are all the same, and a failed write leaves nothing behind.

### Two kinds of target

```bash
# Run every case in the plugin's case file
pnpm test:runtime -- my-plugin --pretty

# Trigger one runtime directly, without a case file
pnpm test:runtime -- my-plugin/note --payload '{"title":"Gate"}' --pretty
```

| Target                  | What it does                                                                            |
| ----------------------- | --------------------------------------------------------------------------------------- |
| `<plugin ID>`           | Runs the cases in `tests/runtime-cases.json` (or `covel.test.json` in the package root) |
| `<plugin ID>/<runtime>` | Triggers this one runtime by hand. Good for quick debugging                             |

Without a case file: a plugin with only one runtime is run once by the fake model, which only confirms that it loads and runs. A plugin with several runtimes reports `has no tests/runtime-cases.json or covel.test.json`.

The command looks for plugins in this order: `--plugins-dir`, the environment variable `COVEL_USER_PLUGINS_DIR`, `$COVEL_HOME/plugins`, and `~/.covel/plugins`. To test a plugin in the repository, add `--plugins-dir plugins`.

### Case file

A file can be an array of cases or `{ "$schema": "…", "cases": [...] }`. Each case requires non-empty `name` and `runtimeId` fields. `mode` accepts only `mock`, `live`, or `both`, and defaults to `both` when omitted. Unknown fields at the root, in a case, in `expect`, or in `artifacts` are errors with a file name and field path. Misspellings such as `expects` or `expect.runtimeResult` are never ignored. Plugin-defined payloads, settings, and mock reply objects can still use their own fields.

Scaffolded files include `$schema` for editor hints from [runtime-cases.schema.json](../../../packages/shared/schemas/runtime-cases.schema.json). Run the cases again after editing them; validation errors stop the run before any runtime executes.

```json
{
  "$schema": "https://raw.githubusercontent.com/AcKnEsS/covel/main/packages/shared/schemas/runtime-cases.schema.json",
  "cases": [
    {
      "name": "manual-note-writes-plugin-data",
      "runtimeId": "my-plugin/note",
      "payload": { "title": "Test checkpoint" },
      "expect": {
        "runtimeResults": [
          { "runtimeId": "my-plugin/note", "status": "success" }
        ],
        "pluginData": [{ "namespace": "notes", "field": "title" }],
        "logs": ["note.recorded"]
      }
    }
  ]
}
```

Fields of a case:

| Field                       | Meaning                                                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `name`                      | The name of the case. `--case <name>` runs only this one                                                            |
| `runtimeId`                 | Which runtime to run. For a plugin with only one runtime, its name is the plugin ID                                 |
| `message`                   | The player's input for this turn                                                                                    |
| `payload`                   | The data passed to the runtime on a manual trigger. In a function, it is `ctx.manualPayload`                        |
| `userSettings`              | Overrides this plugin's settings. If left out, the declared defaults are used                                       |
| `llmResponses`              | The fake model's replies. Each model call uses up one                                                               |
| `llmResponse`               | A shorthand for when there is only one reply                                                                        |
| `llmContent` / `llmObject`  | Shorter shorthands: the reply is a piece of text, or a JSON object                                                  |
| `withPlugins`               | Other plugins loaded along with this one. See [test together with other plugins](#test-together-with-other-plugins) |
| `ignoreUpstreams`           | Ignores this runtime's dependencies on upstream runtimes. Only for debugging this one by itself                     |
| `expectsBackgroundFollower` | Expects this run to queue a background task. If none is queued, the case fails                                      |
| `mode`                      | `mock`, `live`, or `both` (the default). The mode in which this case runs                                           |
| `expect`                    | What should be true after the run                                                                                   |
| `artifacts.saveImages`      | Saves the generated images to a directory so a person can look at them                                              |

> [!NOTE]
> The runtime in a case is triggered directly, and its upstream runtimes do not run. So the inputs it declares (for example, this turn's story text) are empty, and `message` is only the player's input. To test "what to do after reading an upstream result", load the upstream plugin with `withPlugins`, or [assemble a full turn](#run-a-full-turn-in-a-test) in a test.

### Fake model replies

A reply is one answer from the model. To make it call a tool:

```json
{
  "content": null,
  "finishReason": "tool_calls",
  "toolCalls": [
    {
      "id": "tc-1",
      "name": "save-note",
      "arguments": "{\"id\":\"gate-is-locked\",\"text\":\"The north gate is locked.\"}"
    }
  ]
}
```

- `arguments` is a piece of JSON text, so the quotes inside it need a backslash.
- If the model finishes in several steps, write several replies in order in `llmResponses`.
- The default fake model does not make up tool calls on its own. An agent that declares it "must call a tool" (`completion.require: tool-use`) must have replies provided in the case, or the run fails.

### What you can expect

| Field in `expect`  | What it checks                                                                                                                          |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `runtimeResults`   | A runtime ends in a certain status. `runtimeId` can be left out. `errorIncludes` checks that the error message contains a piece of text |
| `pluginData`       | A data space has a record. You can also give a `key`, and a `field` that the record must have                                           |
| `events`           | These events, by name, were emitted                                                                                                     |
| `logs`             | The plugin log has these messages                                                                                                       |
| `assetGenerations` | Media was generated. You can give a `modality`                                                                                          |

Expecting a failure is also allowed:

```json
"expect": {
  "runtimeResults": [
    { "runtimeId": "my-plugin/note", "status": "failed", "errorIncludes": "requires" }
  ]
}
```

In this case, only this one failure of this runtime is accepted. A failed save and other unexpected failures still make the case fail.

### Read the results

The output is JSON. Each case has a `status`, and `assertions` below it lists each expectation and whether it held:

```json
"assertions": [
  { "status": "passed", "message": "runtime:notebook:success" },
  { "status": "failed", "message": "pluginData:notes" }
]
```

If any case fails, the command exits with a non-zero exit code. This is also true when you trigger a runtime directly without a case: a failed save, a failed runtime, or a failed background task makes the command fail.

Some useful fields in the result:

| Field                          | Meaning                                                                                                                          |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `runtimeResults`               | The status, output, and tool calls of each runtime that ran                                                                      |
| `commitStatus` / `commitError` | Whether this execution was saved successfully                                                                                    |
| `pluginData`                   | After the run, the data of the plugin under test                                                                                 |
| `llmCalls`                     | Which role each model call used and which tools it could use. Add `--show-prompts` to also see the full prompt sent to the model |
| `jobs` / `deferredFollowers`   | The background tasks this run queued, and their results                                                                          |
| `pendingDeferredFollowers`     | Tasks that background tasks queued in turn. Offline runs do not execute them                                                     |
| `unsupportedCapabilities`      | Things the plugin registered that offline runs do not support                                                                    |

When the result is `skipped: upstream not success`, the runtime was skipped because an upstream runtime did not succeed. The runtime itself did not run.

### Common options

| Option                                             | What it does                                          |
| -------------------------------------------------- | ----------------------------------------------------- |
| `--plugins-dir <path>`                             | Which directory to look for plugins in                |
| `--case <name>`                                    | Runs only one case                                    |
| `--with-plugin <id>`                               | Loads another plugin too. You can repeat it           |
| `--message <text>`                                 | The player's input                                    |
| `--payload <json>`                                 | The data passed on a manual trigger                   |
| `--user-settings <json>`                           | Overrides the settings of the plugin under test       |
| `--llm-content <text>`                             | The fake model replies with a piece of text           |
| `--llm-object <json>`                              | The fake model replies with a JSON object             |
| `--llm-response <json>` / `--llm-responses <json>` | A full fake model reply, one or a list                |
| `--locale <locale>`                                | The language for this run. The default is `zh-CN`     |
| `--ignore-upstreams`                               | Ignores the dependencies on upstream runtimes         |
| `--expects-background-follower`                    | Fails if no background task is queued                 |
| `--show-prompts`                                   | Includes the messages sent to the model in the result |
| `--mode <mock\|live>` / `--live`                   | Use the fake model or a real model                    |
| `--pretty`                                         | Formats the JSON over multiple lines                  |

### Test together with other plugins

By default, only the plugin under test is loaded. When another plugin needs to take part (for example, to call its service), add it explicitly:

```bash
pnpm test:runtime -- lifecycle-probe/note \
  --plugins-dir tests/third-party \
  --with-plugin service-provider-probe \
  --payload '{"text":"Hello","providerPluginId":"service-provider-probe"}' \
  --pretty
```

- Plugins loaded together are looked for in the same `--plugins-dir`. If one is not found, the command fails before running any code.
- Loading is not the same as running. Only the target you name is triggered. Runtimes of other plugins run only when they receive an event they listen to.
- So a runtime that depends on upstream results still does not get those results. If you only want to debug the part that does not depend on upstream, use `--ignore-upstreams`.
- The `pluginData` in the result still shows only the data of the plugin under test. `userSettings` also overrides only the plugin under test. Other plugins use their own defaults.

> [!WARNING]
> This command runs the server-side code of these plugins, and it does not go through authorization. Use it only with local plugins that you trust.

### What it cannot test

An offline run really runs the entry file, registers tools and services, and runs the hooks in a turn. The following need a full server, and offline runs do not support them:

- Actions (RPC), form validators, and media protocols (wires).
- The hooks for session start and end, and before and after compression.
- The extension points `history.compact@2`, `ui.slot@1`, and `media.image-flow@1`.

When a plugin registers these, the command prints a warning and lists them in the result's `unsupportedCapabilities`:

```text
[test-runtime] Unsupported rpc: notebook/inspect-note. Verify with the server.
```

Also:

- It only runs this one run and the background tasks it queues directly. It does not run the long-running task queue.
- Real model providers, authorization, pause and resume, and multi-level background scheduling must be checked with [real model verification](../ship/real-model.md) or with browser tests.

### Run cases with a real model

```bash
pnpm test:runtime -- my-plugin --case happy-path --mode live --pretty
```

> [!CAUTION]
> `--mode live` sends requests to a real model provider, which can cost money. If you have no keys, stay in the default fake-model mode. Do not write keys into the repository.

It looks for the model configuration in this order: the file that the environment variable `COVEL_LLM_TOML` points to, `$COVEL_HOME/llm.toml`, and `llm.toml` in the current directory. It reads keys from `$COVEL_HOME/keys.env`. An environment variable with the same name that already exists takes priority. If `COVEL_HOME` is not set, it uses `~/.covel`.

It does **not** read the `.env` and `.env.llm` in the repository root automatically. This is different from the development server. To use the configuration in the repository root, load it explicitly:

```bash
COVEL_LLM_TOML=llm.toml pnpm exec tsx \
  --env-file-if-exists=.env --env-file-if-exists=.env.llm \
  packages/test-runtime/src/cli.ts my-plugin --case happy-path --mode live --pretty
```

This mode is good for a manual review before a release. Use the fake model for automatic checks.

## Packages and the player flow

To see how a truly independent community plugin is tested end to end, look at [`tests/third-party/lifecycle-probe`](../../../tests/third-party/lifecycle-probe/README.md) in the repository. It has its own ID and version. It is installed through the real install interface into a temporary user plugin directory, and it loads with the identity of a community plugin. It does not borrow the trust of a built-in plugin.

```bash
pnpm pack:test-plugin        # writes test-results/lifecycle-probe.zip
pnpm test:plugin-lifecycle
```

This set of tests covers installing, importing again, authorization, rediscovery after a restart, running, disabling, uninstalling, reinstalling, and the undoing of data after a failure.

These automatic tests all use fixed model replies. When a change touches the player flow, you also have to play through it on a real model on a release build before shipping. See [Browser tests · player flow check before a release](../internals/e2e-testing.md#player-flow-acceptance-before-a-release).

For how to package and trial-install your own plugin, see [Package and trial-install](../ship/package.md).

## What to test for a new feature

- **Normal case**: give valid input, and get the expected output and data.
- **Invalid input**: a missing field, the wrong type, or a value out of range. It should be rejected, and nothing should be saved.
- **No data**: the data space is empty, or this turn has no related content.
- **Repeated calls**: the same operation runs twice, and the result is still correct.
- **Data ownership**: only write to your own data space. The plugin ID in the write request is your own.
- **A failure leaves no trace**: after a failed run, no half-written data is saved.
- **Write first, then read**: in the same run, a later step can read what an earlier step wrote.

When you change a character tool, check it against the real character field definitions. Do not write a simplified copy of your own.

## When it does not work as expected

| Symptom                                                             | Cause and fix                                                                                                  |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `has no tests/runtime-cases.json or covel.test.json`                | A plugin with several runtimes has no case file. Add one, or give the full runtime name to trigger it directly |
| A case is `failed`, and `assertions` shows `pluginData:<name>`      | The data was not saved as expected. Check the `namespace`, `key`, and `field` in the case                      |
| A case is `failed`, and `assertions` shows `runtime:<name>:success` | The runtime did not succeed. Look at its `error` in `runtimeResults`                                           |
| `skipped: upstream not success`                                     | The upstream it depends on did not run. Add `--ignore-upstreams`, or load the upstream too                     |
| An agent that must call a tool fails                                | The case does not provide `llmResponses` with a tool call                                                      |
| A tool call is rejected                                             | The `arguments` in the fake reply do not match the tool's parameters, or they are not valid JSON text          |
| A warning such as `Unsupported rpc` is printed                      | This is normal. This part must be verified on a real server                                                    |
| `store.… is not configured for this test context` in a unit test    | The function reads data you did not provide. Add it to `store` in `makeManualFunctionContext`                  |
| The plugin cannot be found                                          | The plugin is not in the default directory. Add `--plugins-dir`                                                |

## Next steps

- [Verify with a real model](../ship/real-model.md)
- [Package and trial-install](../ship/package.md)
- A test template for AI assistants: [`.claude/skills/create-plugin/references/plugin-testing.md`](../../../.claude/skills/create-plugin/references/plugin-testing.md)
