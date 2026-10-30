# Your first plugin

This page first writes a plugin that is a single file, then walks you through a plugin called "Tavern Rumors." After each turn ends, it reads the story that was just written, records the rumors the protagonist heard, and shows them in a panel in the sidebar. When you finish, you will have gone through the full plugin workflow: generate, validate, run offline, change, and install into the game.

It takes about thirty minutes. You use the command line. To read the generated code, you need some basic JavaScript, but this page does not ask you to write code.

## Before you start

- You have already [run Covel from source](../start/run-from-source.md). The scaffold and the validation commands are in the repository.
- You have already [connected a model](../start/models.md). The last step runs the plugin for real in the game.
- You have read [What is a plugin](./index.md), and you know the difference between an agent and a function.

Run the commands below from the root of the Covel repository.

## 1. One file is a plugin

The smallest plugin is a single `PLUGIN.md`: one sentence of description, one stage to run in, and a prompt. Make a folder. The folder name is the plugin ID:

```bash
mkdir -p ~/.covel/plugins/observer
```

Save `PLUGIN.md` in it:

```yaml
---
description: Adds a short observation after each turn.
runtime:
  schedule: { stage: post-turn }
---
Write one short observation grounded in the latest narrative.
```

Validate it:

Players without a source checkout can click **Validate** in **Settings → Install & manage**.

```bash
pnpm validate:plugin ~/.covel/plugins/observer
```

```text
✓ Static package validation: /Users/you/.covel/plugins/observer
  languages: text en; instructions en
```

This is already a complete plugin. Covel works out everything that is not written: the ID is the folder name, `observer`; there is no `function` block, so it is an agent driven by a model, and the body is its prompt; it runs after the story in each turn. It needs no `package.json`.

Next, the scaffold generates a fuller starting point, with a panel, a function and test cases.

## 2. Generate the plugin

```bash
pnpm create-plugin tavern-rumors
```

The scaffold writes the plugin into the user plugin directory, which is `~/.covel/plugins/tavern-rumors/` by default. It does not need to install any dependencies. The last line of the output is:

```text
插件创建完成！路径：/Users/you/.covel/plugins/tavern-rumors
```

## 3. See what was generated

```text
tavern-rumors/
├── PLUGIN.md                    package version and the panel it contributes
├── README.md
├── locales/
│   └── zh.yaml                  Chinese translations of the name and interface text
├── runtimes/
│   ├── analyst/
│   │   └── RUNTIME.md           agent: reads the story, decides whether to record a rumor
│   └── note/
│       ├── RUNTIME.md           function: records a rumor by hand when a button is clicked
│       ├── handler.js           the code of this function
│       └── ui/
│           └── panel.json       the sidebar panel
└── tests/
    └── runtime-cases.json       test cases for the offline run
```

This example has two runtimes, one for each of the two types:

| runtime   | type     | When it runs                                          | What it does                                                              |
| --------- | -------- | ----------------------------------------------------- | ------------------------------------------------------------------------- |
| `analyst` | agent    | Automatically, after the narrative of each turn       | Reads the story of this turn, and records a rumor if there is new content |
| `note`    | function | By hand, when the player clicks a button on the panel | Writes one record directly, without calling a model                       |

Both write their records into this plugin's own `notes` data space. The panel shows what is in that space.

There is no `package.json`: the plugin ID is the folder name, the version is in `PLUGIN.md`, and Covel loads `handler.js` as an ES module.

Open `runtimes/analyst/RUNTIME.md` and look at the YAML at the top:

```yaml
schedule:
  stage: post-turn
io:
  inputs:
    narrator-output:
      from:
        contract: narrative-engine@2
      select: /narrativeOutput
      required: false
  selfData:
    - namespace: notes
      as: <existing-notes>
agent:
  tools:
    builtin:
      - plugin-data-set
```

| This part                                | What it means                                                                                                                            |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| No `function` block                      | This is a runtime driven by a model. The body of the file is the prompt for the model                                                    |
| `schedule.stage: post-turn`              | Runs after the narrative                                                                                                                 |
| `io.inputs.narrator-output`              | Reads the story text of this turn. It comes from "any plugin that provides `narrative-engine@2`," not from one specific plugin           |
| `io.selfData`                            | Puts the records it already has into the prompt, so the model can avoid recording the same thing twice                                   |
| Fields left out                          | Take their defaults: it uses the model role `plugin`, and its output is not story text. See [Defaults](../reference/plugins.md#defaults) |
| `agent.tools.builtin: [plugin-data-set]` | The model can call only this one tool: write one record into its own data space                                                          |

The model can use only the tools listed here. It cannot read or write other plugins' data, and it cannot bypass the kernel to change the save directly.

## 4. Validate

```bash
pnpm validate:plugin ~/.covel/plugins/tavern-rumors
```

When it passes, the output is:

```text
✓ Static package validation: /Users/you/.covel/plugins/tavern-rumors
  languages: text en, zh; instructions en
```

The second line says that this plugin has interface text in English and Chinese, and that its prompt is in English.

Validation only reads the files. It does not run your code. It checks the fields in the configuration, the stages, the tool names, and the files it refers to. When something is wrong, it says which field in which file has the problem. For example, if you write `stage: post-turn` as `stage: after-turn`:

```text
✗ [plugin-loader] invalid manifest frontmatter
.../tavern-rumors/runtimes/analyst/RUNTIME.md: schedule.stage: Invalid option: expected one of "setup"|"pre-turn"|"narrative"|"post-turn"|"audit"; correct this field using the current plugin manifest reference
```

## 5. Run offline

You can run the plugin without starting the game and without calling a real model:

```bash
pnpm test:runtime -- tavern-rumors --pretty
```

It reads the cases in `tests/runtime-cases.json`, uses prewritten "model replies" in place of a real model, and then checks the results. The output is a JSON document that starts with:

```json
{
  "status": "ok",
  "mode": "mock",
  "pluginId": "tavern-rumors",
  "cases": [
    {
      "name": "manual-note-writes-plugin-data",
      "status": "passed",
```

When both cases show `"status": "passed"`, this means:

- After the `note` function is called, there is one more record in `notes`.
- After the model calls `plugin-data-set`, the record written by `analyst` is committed.

> [!TIP]
> This is the fastest feedback while you develop. After each change to the manifest or the code, run the validation first, then run this command. Only go into the game once both pass. It costs no model fees.

## 6. Change it into your own plugin

Now change this generic example into a plugin that records rumors. You change three places.

**The plugin's description.** Open `PLUGIN.md`, and change `description` to:

```yaml
description: "Keeps a list of the rumors the player hears."
```

The name and description in the manifest are written in English. The Chinese goes in the matching place in `locales/zh.yaml`:

```yaml
PLUGIN.md:
  description: "记下主角听到的每一条传闻。"
```

**The agent's goal.** Open `runtimes/analyst/RUNTIME.md`, find the `## Plugin Goal` section in the body, and replace the placeholder sentence with:

```markdown
Record each rumor the player hears: who said it, and what it claims. A rumor is something a character reports second-hand, not something the player sees directly.
```

Write the prompt in English. The model outputs in the language of the game session, so a rumor recorded in a Chinese game is still written in Chinese.

After the change, run steps 4 and 5 again, and confirm that they still pass.

## 7. Run it in the game

Start Covel:

```bash
pnpm dev
```

A plugin in the user directory is a **community plugin**. It is discovered, but its code runs only after you authorize it in a game.

1. Open <http://localhost:5173>, choose a world, and click "Enter."
2. On the session-prep screen, expand "Customize plugins and advanced settings." Find `tavern-rumors` in the plugin list and select it.
3. Click "Start Game." When "Authorize plugin action" appears, authorize `tavern-rumors`.
4. Finish the opening, then write an action that makes someone speak, for example "Ask the innkeeper what strange things have happened in town lately."
5. Wait for "Turn complete" to appear.

Now open the "Plugin Notes" tab in the right panel:

| What you do                              | What you should see                                                                             |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Look at the panel                        | One more record, with the rumor the innkeeper told                                              |
| Click "Add note"                         | One more record right away, added by hand. This is the `note` function, and no model was called |
| Play another turn in which nobody speaks | No new record. The agent decides there is no new rumor, and it ends right away                  |

At this point, your plugin has read the story, called a tool, written data, and shown it, all in a real game.

> [!NOTE]
> `pnpm dev` watches the user plugin directory, so you never restart by hand. When you change a manifest, a UI file or a translation, the plugin reloads in place and stays authorized. When you change a code file that has already run (for example `handler.js`), the backend restarts itself once, and you authorize the plugin again in the game.

## When it does not work as expected

| Symptom                                      | Cause and fix                                                                                                                                                                                    |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| It is not in the plugin list                 | It is not in the user plugin directory, or its manifest has an error. Run the validation from step 4, then restart the backend once                                                              |
| Selected, but it does not run                | It is not authorized. Handle the "Authorize plugin action" prompt in the game                                                                                                                    |
| The panel stays empty                        | There was no rumor in this turn's story, or the model did not call the tool. Check the request and reply for the `tavern-rumors/analyst` step on the debug page at <http://localhost:5173/debug> |
| The `plugin` role is reported as unavailable | Under **Settings → LLM → Model Roles**, choose a model for it, or change this task to use a different role on the session-prep screen                                                            |
| Offline run reports a failed case            | You changed the shape of the data but did not update the expectations in `tests/runtime-cases.json`                                                                                              |

## What you just used

| Concept                        | In this plugin                                                                              |
| ------------------------------ | ------------------------------------------------------------------------------------------- |
| One file                       | `observer` is a single `PLUGIN.md`, and Covel works out the rest                            |
| Two kinds of runtime           | `analyst` is an agent, `note` is a function                                                 |
| Stage                          | `analyst` runs automatically at `post-turn`                                                 |
| Finding a plugin by capability | Reads the story through `narrative-engine@2`, and does not name a specific narrative plugin |
| Limited tools                  | The agent can call only `plugin-data-set`                                                   |
| Its own data                   | Both runtimes write only to their own `notes` space                                         |
| Interface                      | `panel.json` describes what the panel looks like, and no front-end code is needed           |
| Trust                          | A community plugin's code runs only after the player authorizes it                          |

## What's next

- **Change the function.** Open `runtimes/note/handler.js`, and change the structure of the record to the fields you need.
- **Change the panel.** Open `runtimes/note/ui/panel.json`, and adjust the layout. For the components available, see the [UI component reference](../reference/ui-components.md).
- **You only want a prompt-only plugin.** See [Plugins with only a prompt](./prompt-only.md). The example there has only one `PLUGIN.md`.
- **Write your own tools.** See [Plugins with local code](./local-code.md).
- **Share it with others.** See [Verify and distribute](../ship/index.md).

For every field, see the [plugin field reference](../reference/plugins.md).
