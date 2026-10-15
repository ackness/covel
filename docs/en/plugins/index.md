# What a plugin is

A plugin adds behavior to the game: a way of telling the story, a set of check rules, a quest log, or a UI panel. The world decides the content, and the plugin decides how it is played.

A plugin is a folder. The simplest plugin has just one Markdown file with its configuration and prompt. It needs no code.

## What is inside a plugin

```text
my-plugin/
├── PLUGIN.md            description, the capabilities it depends on, the tools and UI it contributes; the only required file
├── README.md
├── runtimes/            optional: one or more runtime units
│   └── <name>/
│       ├── RUNTIME.md   when it runs, what it reads, what it outputs; an agent's prompt is written in the body
│       └── handler.js   the code of a function runtime unit
└── locales/             optional: translations of names and UI text
```

The top of `PLUGIN.md` is a block of YAML that declares what this package is. The body below it holds the instructions for the model.

## Runtime units: agents and functions

The thing that actually runs inside a plugin is called a **runtime** (a runtime unit). A plugin can have none, one, or several. There are two kinds:

| Type         | What it is                                                        | What it is good for                                                        | Does it cost model fees? |
| ------------ | ----------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------ |
| **agent**    | A prompt. The model reads it, then calls tools to finish the task | Writing the story, extracting facts from the story text, making judgments  | Yes                      |
| **function** | A JavaScript function                                             | Rolling dice, calculating, reading and writing data, calling external APIs | No                       |

A rule of thumb: **give anything that can be worked out from fixed rules to a function, and give anything that requires understanding the text to an agent.** Dice should be rolled by a function, so that the result cannot be rewritten to fit the text.

## When it runs

Each runtime declares the stage of the turn in which it runs:

| Stage       | When                                 | Typical use                                                           |
| ----------- | ------------------------------------ | --------------------------------------------------------------------- |
| `setup`     | At the start, before the game begins | Creating characters, initializing data                                |
| `pre-turn`  | Before the narrative                 | Retrieving reference material, rolling dice in advance                |
| `narrative` | The narrative                        | Writing the story of this turn                                        |
| `post-turn` | After the narrative                  | Updating quests, inventory, and relationships based on the story text |
| `audit`     | Last                                 | Checking and wrapping up                                              |

A stage starts only after every runtime of the previous stage has finished. Besides running automatically by stage, a runtime can also be triggered by the player pressing a button, or by an event.

## How plugins work together

Plugins do not name each other directly. One plugin says what capability it **provides**, and another says what capability it **needs**, and Covel connects them. A capability has a versioned name, for example `narrative-engine@1`, which means "the story-writing capability, version 1".

```yaml
requires: [narrative-engine@1]
```

This line means "I need a plugin that can write the story", not "I need the plugin named narrator". So the narrator can be replaced, and the plugins that depend on it do not have to change.

## How plugins save data

A plugin cannot change the save directly. It can only propose "I want to change this". Covel checks the proposals, and writes them all together when the turn ends. If the turn fails, no half-changed data is left behind.

Each plugin has its own block of data, which other plugins cannot read. Data that everyone shares, such as characters and the lorebook, is kept by Covel. Plugins can read it, but to change it they must also make a proposal first.

## Choose a path

| What you need                                                                  | Form                         | Where to start                                  |
| ------------------------------------------------------------------------------ | ---------------------------- | ----------------------------------------------- |
| Make the model do one more thing, for example add an observation to every turn | Prompt only                  | [A plugin with only a prompt](./prompt-only.md) |
| Let the model use a tool that you wrote                                        | Prompt plus code             | [A plugin with code](./local-code.md)           |
| Fixed rules, several steps working together, preset data                       | Several runtimes             | [Multiple runtimes and data](./advanced.md)     |
| Add a panel, a form, or a custom screen                                        | A file that describes the UI | [Add UI to a plugin](./ui.md)                   |

If you are not sure which to choose, start with the [first plugin](./first-plugin.md). The example it generates includes an agent, a function, and a panel all together.

## What this chapter covers

| Page                                                       | What you get                                                                                      |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| [The first plugin](./first-plugin.md)                      | Generate a plugin, run it offline, then install it in the game and see it work                    |
| [A plugin with only a prompt](./prompt-only.md)            | A plugin that has only `PLUGIN.md`                                                                |
| [A plugin with code](./local-code.md)                      | Your own tools, button actions, and functions                                                     |
| [Multiple runtimes and data](./advanced.md)                | Several runtimes working together, receiving data preset by the world, and requesting permissions |
| [Add UI to a plugin](./ui.md)                              | Side panels, blocks in the story text, forms, and custom pages                                    |
| [Rules every plugin author needs to know](./essentials.md) | The rules every plugin author runs into, organized by question                                    |
| [Prompt writing](./prompt-style.md)                        | How to write clear instructions for the model                                                     |
| [Testing in depth](./testing.md)                           | Unit tests, whole-turn tests, and every way to write offline cases                                |

## Look up details

| What you want to look up                          | Reference page                                                                      |
| ------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Fields of `PLUGIN.md` and `RUNTIME.md`            | [Plugin fields](../reference/plugins.md)                                            |
| Built-in tools and how to write a tool            | [Tools](../reference/tools.md)                                                      |
| Intercepting or rewriting at each point of a turn | [Hooks](../reference/hooks.md)                                                      |
| How plugins communicate with each other           | [Plugin extensions and communication](../reference/plugin-extensions.md)            |
| UI components and panels                          | [UI components](../reference/ui-components.md), [Panels](../reference/ui-panels.md) |
