# Built-in Plugins and Features

Covel comes with a set of built-in plugins and four worlds. This chapter tells you what each one is, what you will see in the game, and what you can adjust. To find out which plugin gives you a certain panel, or whether a feature can be turned off, look here.

The built-in plugins and worlds are only demos, and you do not have to use them; community worlds use the same prefixed `plugins` selection as bundled worlds.

## What is in this chapter

| Page                                   | What it covers                                                                                          |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| [Narrative and Memory](./story.md)     | Who writes the story, action suggestions, other versions of a reply, and how the story is remembered    |
| [RPG Mechanics](./rpg.md)              | Dice checks, point buy at the start, quests, bag, affinity, hidden story events                         |
| [Characters and World](./world.md)     | Setup at the start, creating a character, character profiles, world state, time, almanac, relationships |
| [Stage and Sound](./stage.md)          | Stage mode, scenes and characters on stage, background music                                            |
| [Built-in App Features](./features.md) | Features that belong to no plugin: views, appearance, AI world creation, debugging, and more            |

## Gameplay packs: pick a set of plugins at once

When you start a game, you do not need to choose plugins one by one. A **gameplay pack** is a ready-made set of plugins. Pick one on the getting-ready screen. There are seven built in:

| Gameplay pack                     | Good for                                   | Plugins it includes                                                                                        |
| --------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| Classic Story `traditional-story` | Long exploration, reading a story          | Storyteller, Action Suggestions, Almanac, Relationships, World Rules                                       |
| Dialogue `dialogue-mode`          | Character dialogue, visual novel           | Chat Storyteller, Stage Scene, Action Suggestions, Character Profiles, World Rules, Alternative Replies    |
| Budget `low-cost`                 | Keeping model costs down                   | Storyteller, World Rules                                                                                   |
| Story Only `narrative-only`       | Just reading the story, at the lowest cost | Storyteller                                                                                                |
| Game Master `dm-mode`             | Game-master narration                      | Get Ready, World State, Storyteller, Game Master Panel; no character creation                              |
| Ensemble `ensemble-dialogue`      | A cast performs together                   | Get Ready, World State, Character Creator, Chat Storyteller, Character Voice, Who Speaks Next, Stage Scene |
| Spectator `spectator`             | Observe advancing NPCs                     | The ensemble composition with Game Master Panel, without player character creation                         |

The first three packs also include Get Ready, World State, and Character Creator, and they recommend turning on Story Memory. Story Only turns off the other plugins that are on by default: there is no opening form, character creation, or world dimensions, and no world time, Story Memory, or Long-Story Memory; the world's declared dimensions are not imported, and the game starts as usual.

The "Back to the minimal set" button on the getting-ready screen selects this combination in one click: only narrative plugins and any plugins they or the world require.

A world can declare extra capabilities in `plugins` (`pack:`, `plugin:`, `contract:`), pull in generic plugins automatically through conventional files under `data/` (such as Quest Log, Bag, Affinity, or Ability Checks), and give that combined setup a name. For example, Lantern Barrow explicitly requests `dice-check` and `action-check@1` on top of Classic Story and draws in Ability Checks, Quest Log, Bag, and Affinity from its data files under the name “Classic Tabletop”. This does not create another pack available globally. After you pick a pack, you can still add or remove plugins under "Customize plugins and advanced settings" on the getting-ready screen.

## All built-in plugins

Game Master and Spectator request Game Master Panel; Ensemble recommends it without changing default views, roles, or policy. Almanac and Relationships provide only right panels, which “Expand panel” opens larger. The panels make no model calls; story actions retain the selected AI roles’ costs.

Plugins marked "On by default" are added to every game automatically, and you can turn them off on the getting-ready screen. Some plugins require capabilities from other plugins. If a provider is missing, its dependents are disabled and the interface explains what is missing; other features keep working. The others are chosen by the gameplay pack, the world, or you.

### Narrative and memory

| Plugin                                                                    | What it does                                                                | On by default |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------- |
| [Storyteller](./story.md) `narrator`                                      | Writes the story text for each turn                                         | Yes           |
| [Chat Storyteller](./story.md) `chat-mode-narrator`                       | Tells the story as character dialogue; works alone, Stage Scene is optional |               |
| [Character Voice](./story.md) `character-agent`                           | Plays the selected character's public speech/actions                        |               |
| [Who Speaks Next](./story.md) `turn-policy`                               | One service with five strategy settings                                     |               |
| [Game Master Panel](./story.md#game-master-panel-dm-console) `dm-console` | Public cast, interactions, story and current-role input                     |               |
| [Action Suggestions](./story.md) `guide`                                  | Gives a few actions you can tap below the story text                        |               |
| [Alternative Replies](./story.md) `branch-reply`                          | Writes another version of the same turn                                     |               |
| [Story Memory](./story.md) `memory`                                       | Remembers plot and character state; worlds can add memory blocks            | Yes           |
| [Long-Story Memory](./story.md) `history-compaction`                      | When the conversation gets long, summarizes the older part                  | Yes           |

A session may have several player characters. The two narrator plugins follow the character you are currently playing (see [Storyteller · The character you play](./story.md#the-character-you-play) and [Seats](../reference/world-model.md#seats)). Story Memory, Bag, Dice Check, Ability Checks, Character Creator and Character Profiles follow the action’s actor, falling back to the primary seat’s current character. Stage Scene still uses the first player character.

### RPG mechanics

[Bag](./rpg.md#bag-inventory) checks changes already handled by tools and items already paid for a dice check, to avoid duplicate bookkeeping.

| Plugin                                        | What it does                                                                                                                          | On by default |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| [Dice Check](./rpg.md) `dice-check`           | Pre-rolled dice decide risky actions; carried items add to modifiers, and a failure loses an item or advances a clock from world data |               |
| [Ability Checks](./rpg.md) `tabletop-rules`   | Assigns attribute points at the start, and lets the player start attribute checks                                                     |               |
| [Quest Log](./rpg.md) `core-quest`            | Records quests and objectives; a quest or objective past its deadline fails on its own                                                |               |
| [Bag](./rpg.md) `inventory`                   | Looks up carried items, settles trades, and records item changes; an item can help one kind of check                                  |               |
| [Affinity](./rpg.md) `affinity`               | Tracks numeric player–NPC affinity and supplies it to narration; NPCs who have gone cold will not cooperate with checks               |               |
| [Hidden Plot Events](./rpg.md) `story-events` | Hidden plot events, options, and rewards unlocked by deterministic or semantic conditions                                             |               |

Bag and affinity world-seeded records pass dataset validation; sync can remove seeded records deleted from their authoritative source.

### Characters and world

Character, fact, and dimension tracking retain each narrative segment’s speaker or actor. The player message remains a separate source; see [Characters and World](./world.md).

| Plugin                                                 | What it does                                                               | On by default |
| ------------------------------------------------------ | -------------------------------------------------------------------------- | ------------- |
| [Get Ready](./world.md) `pregame`                      | Collects the player's choices when a game starts                           | Yes           |
| [Character Creator](./world.md) `char-creator`         | Creates the protagonist from form answers and updates character state      | Yes           |
| [Character Profiles](./world.md) `character-blueprint` | Holds the characters and portraits the world provides                      |               |
| [World State](./world.md) `world-init`                 | Prepares character attributes and dimensions, and updates dimension state  | Yes           |
| [World Time](./world.md) `world-time`                  | Time passing, day and night, and a rules summary                           | Yes           |
| [World Rules](./world.md) `living-world-rules`         | Brings the world's rules into every turn, with localized category badges   |               |
| [Almanac](./world.md) `codex`                          | Records people, places and things, with localized category badges          |               |
| [Relationships](./world.md) `npc-graph`                | Tracks people, groups and factions by canonical name and alias             |               |
| [Story Notes](./world.md) `world-ir`                   | Extracts current facts and reviews open quest objectives for other plugins |               |

### Stage and sound

| Plugin                                  | What it does                                                                                             | On by default |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------- |
| [Stage Scene](./stage.md) `scene-stage` | Updates scenes and cast, with optional character attributes; dialogue opts into committed segment reveal |               |
| [Soundtrack](./stage.md) `soundtrack`   | Plays the world's own music for each scene                                                               |               |

## The four built-in worlds

Mistport, Harukaze Academy, and Lantern Barrow each show one play style: Mistport shows Read mode without dice checks, Harukaze Academy shows Stage mode, and Lantern Barrow shows full tabletop rules. Last Train Out is a survival sandbox: the floodline counts down with world time, the lights, doors, and radio share one battery, and Control's orders and the photos passengers pass around have to be checked one by one. It is written in English and also shows how a world can offer editions in several languages.

| World                                                       | Gameplay                                  | What is worth a look                                                                                                                          |
| ----------------------------------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Mistport (雾港・裂潮纪) `mistport`                          | A dark-fantasy investigation in Read mode | Four investigations with tide deadlines, Case Board with sources & contradictions, evidence preservation, nine hidden events & hidden options |
| Harukaze Academy (遥风学园・春日薄荷) `haruka-academy`      | A campus ensemble in Stage mode           | Campus timetable, dialogue narration, day/night scenes, transparent portraits, and festival quests                                            |
| Last Train Out (末班地铁) `last-train`                      | Modern urban survival, written in English | Floodline countdown, a shared battery, message checking, ensemble cast threads, character-card customization; Chinese edition                 |
| Lantern Barrow: The First Delve (提灯古冢) `lantern-barrow` | Classic tabletop dungeon exploration      | Point buy at the start, failure clocks & item costs, gear check modifiers, dungeon map & Barrow Alarm panel                                   |

To build your own world based on these, the files are in the repository's [`worlds/`](../../../worlds) directory.

## More

Plugins such as image and voice generation are not built into Covel. You install them separately. See [Install plugins and world packages](../start/packages.md). To write your own, see [Develop plugins](../plugins/index.md).

- **Orchestration & automatic advancement**: See [session orchestration settings](./features.md#session-orchestration-settings) for policy selection and delegation caps, and [While the story advances automatically](../start/first-session.md#while-the-story-advances-automatically) for the Stop controls.
- **Ensemble & game master**: Ensemble defaults to the Player role and mention strategy. To play as a human GM, turn off character creation on the getting-ready screen and pick Game master, or set Storyteller's Perspective to Game master. When actors or a policy plugin are unavailable, Storyteller continues solo play and returns control to the player. See [ensemble dialogue](./story.md#ensemble-dialogue-and-character-actors).

## Story-driven presentation

- **Resizable panels & themes**: The Stage look supports resizing the story panel in Read and the response panel in Stage; Stage Scene also offers an initially off [reading appearance](./stage.md#optional-reading-appearance) under This game's theme in the Menu. See [Stage mode](./stage.md#stage-mode).
- **Presentation functions & extending**: Stage Scene and Soundtrack use zero-budget [presentation functions](../reference/plugins.md#presentation-runtimes) with no model-call cost. Authors extending bundled plugins should also check the [output submission contract](../reference/plugins.md#agent-output-submission), [world data receivers](../reference/world-data.md#data-receivers), and [read-baseline conflicts](../reference/transactions.md#read-baselines).
