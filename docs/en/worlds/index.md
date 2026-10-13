# What is a world package?

A world package is a folder. It holds the setting and content of one world: what kind of place it is, which characters and rules it has, where the story begins, and which plugins it wants to be played with. Covel reads this folder and can start a game from it.

A world package has content only, and no code. You do not need to know how to program to make a world.

## What is in a world package

```text
my-world/
├── world.yaml           identity, languages, plugin set, character attributes
├── WORLD.md             the world's setting text, which the model reads every turn
├── data/                optional: lorebook, rules, quests, items and other data
├── characters/          optional: preset characters
└── media/               optional: cover, portraits, scene pictures
```

Only the first two files are required. The rest are added on as you go. You can play without portraits, and you can play without preset characters.

| File          | The question it answers                                                                                        |
| ------------- | -------------------------------------------------------------------------------------------------------------- |
| `world.yaml`  | What the world is called, which language it uses, which plugins start on, and which attributes characters have |
| `WORLD.md`    | What the world is like, and where the story begins                                                             |
| `data/`       | What material can be looked up during play, and which quests, items, and relationships exist from the start    |
| `characters/` | Which characters are already set up                                                                            |
| `media/`      | What the world looks like                                                                                      |

## How worlds and plugins work together

A world does not implement gameplay. It **chooses** gameplay. The `pluginPolicy` in `world.yaml` says which plugins the world wants on, for example the narrator, dice checks, and a quest log. The player can adjust this choice on the session-prep screen.

A world can also prepare data for plugins. A quest plugin receives the starting quests, an inventory plugin receives the starting items, and an affinity plugin receives the starting relationships. You put the data files at the agreed paths, and the matching plugin reads them when it is turned on.

So the same world can be played in very different ways. With only the narrator on, it is an interactive novel. Add dice, quests, and an inventory, and it becomes a tabletop role-playing game.

## Three ways to make one

| Way                                   | Good for                                                         | How to start                                                                                                   |
| ------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| **Create with AI in the app**         | Getting a playable world quickly                                 | "AI Create World" on the world selection page. Fill in a creative brief                                        |
| **Write the files by hand**           | Full control over the content, or learning the package structure | [The first world](./first-world.md)                                                                            |
| **Have a development agent write it** | Working in the code repository with tools such as Claude Code    | The repository includes a `/create-world` skill. See [Use a development agent for tasks](../agent-workflow.md) |

All three ways produce the same kind of world package, and you can switch between them and keep editing.

## In this chapter

| Page                                  | What you get                                                                     |
| ------------------------------------- | -------------------------------------------------------------------------------- |
| [The first world](./first-world.md)   | A world you can import and start, written in four files, in about twenty minutes |
| [Art direction](./art-direction.md)   | A single visual style for the world, and what to check before you hand it off    |
| [Character portraits](./portraits.md) | Portraits generated for characters, shown in the game                            |
| [Scene pictures](./scenes.md)         | Day and night scene pictures for locations, used as backgrounds in stage mode    |

## What to do next

| What you want to do                                | Where to go                                                                         |
| -------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Preset quests, items, and affinity                 | [Give the world preset quests, items, and affinity](../recipes/starting-content.md) |
| Starting point buy and dice checks                 | [Starting point buy and dice checks](../recipes/point-buy.md)                       |
| Publish a world together with the plugins it needs | [Collections](../ship/collections.md)                                               |

## Find the details

| What you want to look up                                  | Reference page                                                  |
| --------------------------------------------------------- | --------------------------------------------------------------- |
| How data files are imported, and what can be preset       | [World data](../reference/world-data.md)                        |
| All the fields of `world.yaml`                            | [world.yaml field table](../reference/schema/world-manifest.md) |
| The structure of characters, attributes, and the lorebook | [World model](../reference/world-model.md)                      |
| World state that changes as the story goes on             | [Dynamic dimensions](../reference/dynamic-dimensions.md)        |
| Time passing, and day and night                           | [World time](../reference/world-time.md)                        |
| Providing a second language                               | [Multiple languages](../reference/i18n.md)                      |
