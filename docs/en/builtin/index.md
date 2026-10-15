# Built-in Plugins and Features

Covel comes with a set of plugins and four worlds. This chapter tells you what each one is, what you will see in the game, and what you can adjust. To find out which plugin gives you a certain panel, or whether a feature can be turned off, look here.

The built-in plugins and worlds are only demos, and you do not have to use them.

## What is in this chapter

| Page                                   | What it covers                                                                                        |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| [Narrative and Memory](./story.md)     | Who writes the story, action suggestions, other versions of a reply, and how the story is remembered  |
| [RPG Mechanics](./rpg.md)              | Dice checks, point buy at the start, quests, inventory, affinity, hidden story events                 |
| [Characters and World](./world.md)     | Setup at the start, creating a character, character profiles, world state, time, codex, relationships |
| [Stage and Sound](./stage.md)          | Stage mode, scenes and characters on stage, background music                                          |
| [Built-in App Features](./features.md) | Features that belong to no plugin: views, appearance, AI world creation, debugging, and more          |

## Gameplay packs: pick a set of plugins at once

When you start a game, you do not need to choose plugins one by one. A **gameplay pack** is a ready-made set of plugins. Pick one on the session-prep screen. There are four built in:

| Gameplay pack                         | Good for                                   | Plugins it includes                                                                                 |
| ------------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| Traditional Story `traditional-story` | Long exploration, reading a story          | Narrator, Action Suggestions, Codex, Relationship Graph, World Rules                                |
| Dialogue Mode `dialogue-mode`         | Character dialogue, visual novel           | Dialogue Narrator, Scene Stage, Action Suggestions, Character Profiles, World Rules, Reply Variants |
| Low Cost `low-cost`                   | Keeping model costs down                   | Narrator, World Rules                                                                               |
| Narrative Only `narrative-only`       | Just reading the story, at the lowest cost | Narrator                                                                                            |

The first three packs also include Pre-Game Setup, World Dimensions and Character Creator, and they recommend turning on Story Memory. Narrative Only turns off the other plugins that are on by default: there is no opening form, character creation or world dimensions, and no world time, Story Memory or history compaction. The world's declared dimensions are not imported, and the session starts as usual.

The "Back to the minimal set" button on the session-prep screen gets you to such a set in one click: only the narrative plugins and the plugins that they and the world require.

A world can have its own gameplay pack. For example, "Lantern Barrow" (提灯古冢) has a "Classic Tabletop" pack. It builds on Traditional Story and adds Tabletop Rules, Dice Check, Quest Log, Inventory and Affinity. After you pick a pack, you can still add or remove plugins under "Customize plugins and advanced settings" on the session-prep screen.

## All built-in plugins

Plugins marked "On by default" are added to every game automatically, and you can turn them off on the session-prep screen. Some plugins need other plugins to work with them, so turning one off can make a game fail to start. The others are chosen by the gameplay pack, the world, or you.

### Narrative and memory

| Plugin                                                | What it does                                                                   | On by default |
| ----------------------------------------------------- | ------------------------------------------------------------------------------ | ------------- |
| [Narrator](./story.md) `narrator`                     | Writes the story text for each turn                                            | Yes           |
| [Dialogue Narrator](./story.md) `chat-mode-narrator`  | Tells the story as character dialogue, for stage mode                          |               |
| [Action Suggestions](./story.md) `guide`              | Gives a few actions you can tap below the story text                           |               |
| [Reply Variants](./story.md) `branch-reply`           | Writes another version of the same turn                                        |               |
| [Story Memory](./story.md) `memory`                   | Remembers the ongoing plot, the current scene and the player character's state | Yes           |
| [History Compaction](./story.md) `history-compaction` | When the conversation gets long, summarizes the older part                     | Yes           |

### RPG mechanics

| Plugin                                         | What it does                                                                      | On by default |
| ---------------------------------------------- | --------------------------------------------------------------------------------- | ------------- |
| [Dice Check](./rpg.md) `dice-check`            | Risky actions are decided by dice that are rolled in advance                      |               |
| [Tabletop Rules](./rpg.md) `tabletop-rules`    | Assigns attribute points at the start, and lets the player start attribute checks |               |
| [Quest Log](./rpg.md) `core-quest`             | Records quests and objectives, with localized status badges                       |               |
| [Inventory](./rpg.md) `inventory`              | Records what the player character carries; items can be used and dropped          |               |
| [Affinity](./rpg.md) `affinity`                | Records each character's attitude toward the player character                     |               |
| [Hidden Story Events](./rpg.md) `story-events` | Story events that only happen when their conditions are met                       |               |

### Characters and world

| Plugin                                                 | What it does                                                              | On by default |
| ------------------------------------------------------ | ------------------------------------------------------------------------- | ------------- |
| [Pre-Game Setup](./world.md) `pregame`                 | Collects the player's choices when a game starts                          | Yes           |
| [Character Creator](./world.md) `char-creator`         | Creates the player character, and updates characters during play          | Yes           |
| [Character Profiles](./world.md) `character-blueprint` | Holds the characters and portraits the world provides                     |               |
| [World Dimensions](./world.md) `world-init`            | Prepares character attributes and dimensions, and updates dimension state | Yes           |
| [World Time](./world.md) `world-time`                  | Time passing, and day and night                                           | Yes           |
| [World Rules](./world.md) `living-world-rules`         | Brings the world's rules into every turn, with localized category badges  |               |
| [Codex](./world.md) `codex`                            | Records people, places and things, with localized category badges         |               |
| [Relationship Graph](./world.md) `npc-graph`           | Records a graph of relationships between people, groups and factions      |               |
| [World Fact Extraction](./world.md) `world-ir`         | Sorts out what happened in each turn, for other plugins to use            |               |

### Stage and sound

| Plugin                                  | What it does                                          | On by default |
| --------------------------------------- | ----------------------------------------------------- | ------------- |
| [Scene Stage](./stage.md) `scene-stage` | Records the current scene and the characters on stage |               |
| [Soundtrack](./stage.md) `soundtrack`   | Plays the world's own music for each scene            |               |

## The four built-in worlds

Mistport, Haruka Academy and Lantern Barrow each show one play style: Mistport shows traditional narrative, Haruka Academy shows stage mode, and Lantern Barrow shows tabletop rules. Emberback is written in English and shows how one world can carry several languages.

| World                                                        | Gameplay                                                        | What is worth a look                                                                    |
| ------------------------------------------------------------ | --------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Mistport (雾港・裂潮纪) `mistport`                           | A dark-fantasy investigation in the traditional narrative style | Hidden story events, memory for investigation, portraits                                |
| Haruka Academy (遥风学园) `haruka-academy`                   | A campus ensemble in stage mode                                 | Dialogue narration, day and night scene pictures, transparent portraits                 |
| Emberback Relay `emberback`                                  | Sci-fi frontier mystery, written in English                     | Shows how one world can carry several languages (English first, with a Chinese edition) |
| Lantern Barrow: First Expedition (提灯古冢) `lantern-barrow` | Classic tabletop dungeon exploration                            | Point buy at the start, dice checks, dungeon panel                                      |

To build your own world based on these, the files are in the repository's [`worlds/`](../../../worlds) directory.

## More

Plugins such as image and voice generation are not built into Covel. You install them separately. See [Install plugins and world packages](../start/packages.md). To write your own, see [Develop plugins](../plugins/index.md).
