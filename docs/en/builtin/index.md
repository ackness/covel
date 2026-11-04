# Built-in Plugins and Features

Bundled worlds use the same prefixed `plugins` selection as community worlds. All host packs remain available; unavailable content produces notices and play can start.

See [world data receivers](../reference/world-data.md#data-receivers) for static discovery, inferred selection and omission notices. Data acceptance does not satisfy service or runtime capability dependencies.

Covel comes with a set of plugins and four worlds. This chapter tells you what each one is, what you will see in the game, and what you can adjust. To find out which plugin gives you a certain panel, or whether a feature can be turned off, look here.

The built-in plugins and worlds are only demos, and you do not have to use them.

Manage session policy providers and execution limits in [orchestration settings](./features.md#session-orchestration-settings). Plugin list refreshes preserve unsaved orchestration edits.

Storytellers supply location and mood cues when they change, for the stage and music to read; see [Narrative and Memory](./story.md).

Dimension tools report schema-invalid values as correctable input errors; see [update-dimensions](../reference/tools.md#update-dimensions).

Opening character templates must include a placeholder for every collected field. Template/default errors are correctable `invalid-input` failures; see [character tools](../reference/tools.md#opening-character-form).

If a concurrent change makes an affinity or clock calculation stale, that derived update is skipped while an independent successful story survives. A later explicit retry reads and recalculates it; see [read-baseline conflicts](../reference/transactions.md#read-baselines).

All four bundled worlds keep their complete dimension tables in `data/dimensions.yaml`; manifests carry no dimensions. See [dimension sources](../reference/world-data.md#dimension-sources) for the distinction between definitions and session values.

## What is in this chapter

| Page                                   | What it covers                                                                                        |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| [Narrative and Memory](./story.md)     | Who writes the story, action suggestions, other versions of a reply, and how the story is remembered  |
| [RPG Mechanics](./rpg.md)              | Dice checks, point buy at the start, quests, inventory, affinity, hidden story events                 |
| [Characters and World](./world.md)     | Setup at the start, creating a character, character profiles, world state, time, codex, relationships |
| [Stage and Sound](./stage.md)          | Stage mode, scenes and characters on stage, background music                                          |
| [Built-in App Features](./features.md) | Features that belong to no plugin: views, appearance, AI world creation, debugging, and more          |

## Gameplay packs: pick a set of plugins at once

When you start a game, you do not need to choose plugins one by one. A **gameplay pack** is a ready-made set of plugins. Pick one on the session-prep screen. There are seven built in:

| Gameplay pack                     | Good for                                   | Plugins it includes                                                                                                |
| --------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Classic Story `traditional-story` | Long exploration, reading a story          | Storyteller, Action Suggestions, Almanac, Relationships, World Rules                                               |
| Dialogue `dialogue-mode`          | Character dialogue, visual novel           | Chat Storyteller, Stage Scene, Action Suggestions, Character Profiles, World Rules, Alternative Replies            |
| Budget `low-cost`                 | Keeping model costs down                   | Storyteller, World Rules                                                                                           |
| Story Only `narrative-only`       | Just reading the story, at the lowest cost | Storyteller                                                                                                        |
| Game Master `dm-mode`             | Game-master narration                      | Pregame, world initialization, Storyteller, Game Master Panel; no character creation                               |
| Ensemble `ensemble-dialogue`      | A cast performs together                   | Pregame, world initialization, character creation, Chat Storyteller, Character Voice, Who Speaks Next, Stage Scene |
| Spectator `spectator`             | Observe advancing NPCs                     | The ensemble composition with Game Master Panel, without player character creation                                 |

The first three packs also include Get Ready, World State and Character Creator, and they recommend turning on Story Memory. Story Only turns off the other plugins that are on by default: there is no opening form, character creation or world dimensions, and no world time, Story Memory or history compaction. The world's declared dimensions are not imported, and the session starts as usual.

The "Back to the minimal set" button on the session-prep screen selects this combination in one click: only narrative plugins and any plugins they or the world require.

A world can add plugins to a built-in pack and give that combination a name. For example, Lantern Barrow calls its Classic Story setup with Ability Checks, Dice Check, Quest Log, Bag and Affinity “Classic Tabletop”. This does not create another pack available globally. After you pick a pack, you can still add or remove plugins under "Customize plugins and advanced settings" on the session-prep screen.

## All built-in plugins

Game Master and Spectator request Game Master Panel; Ensemble recommends it without changing default views, roles or policy. Almanac and Relationships provide only right panels, which “Expand panel” opens larger. The panels make no model calls; story actions retain the selected providers’ costs.

Plugins marked "On by default" are added to every game automatically, and you can turn them off on the session-prep screen. Some plugins require capabilities from other plugins. If a provider is missing, its dependents are disabled and the interface explains what is missing; other features keep working. The others are chosen by the gameplay pack, the world, or you.

### Narrative and memory

| Plugin                                                             | What it does                                                                   | On by default |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------ | ------------- |
| [Storyteller](./story.md) `narrator`                               | Writes the story text for each turn                                            | Yes           |
| [Chat Storyteller](./story.md) `chat-mode-narrator`                | Tells the story as character dialogue; works alone, Stage Scene is optional    |               |
| [Character Voice](./story.md) `character-agent`                    | Plays the selected character's public speech/actions                           |               |
| [Who Speaks Next](./story.md) `turn-policy`                        | One service with five strategy settings                                        |               |
| [Game Master Panel](./story.md#dm-console-dm-console) `dm-console` | Public cast, interactions, story and current-role input                        |               |
| [Action Suggestions](./story.md) `guide`                           | Gives a few actions you can tap below the story text                           |               |
| [Alternative Replies](./story.md) `branch-reply`                   | Writes another version of the same turn                                        |               |
| [Story Memory](./story.md) `memory`                                | Remembers the ongoing plot, the current scene and the player character's state | Yes           |
| [Long-Story Memory](./story.md) `history-compaction`               | When the conversation gets long, summarizes the older part                     | Yes           |

A session may have several player characters. The two narrator plugins follow the character you are currently playing (see [Storyteller · The character you play](./story.md#the-character-you-play) and [Seats](../reference/world-model.md#seats)). Story Memory, Bag, Dice Check, Ability Checks, Character Creator and Character Profiles follow the action’s actor, falling back to the primary seat’s current character. Stage Scene still uses the first player character.

### RPG mechanics

[Bag](./rpg.md#inventory-inventory) checks changes already handled by tools, including batches with long descriptions, to avoid duplicate bookkeeping.

| Plugin                                        | What it does                                                                                  | On by default |
| --------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------- |
| [Dice Check](./rpg.md) `dice-check`           | Pre-rolled dice decide risky actions; no attribute label appears when no ability is available |               |
| [Ability Checks](./rpg.md) `tabletop-rules`   | Assigns attribute points at the start, and lets the player start attribute checks             |               |
| [Quest Log](./rpg.md) `core-quest`            | Records quests and objectives, with localized status badges                                   |               |
| [Bag](./rpg.md) `inventory`                   | Looks up carried items, settles trades, and records item changes                              |               |
| [Affinity](./rpg.md) `affinity`               | Tracks numeric player–NPC affinity and supplies current scores to narration                   |               |
| [Hidden Plot Events](./rpg.md) `story-events` | Story events that only happen when their conditions are met                                   |               |

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
| [Relationships](./world.md) `npc-graph`                | Records a graph of relationships between people, groups and factions       |               |
| [Story Notes](./world.md) `world-ir`                   | Extracts current facts and reviews open quest objectives for other plugins |               |

### Stage and sound

| Plugin                                  | What it does                                                                                             | On by default |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------- |
| [Stage Scene](./stage.md) `scene-stage` | Updates scenes and cast, with optional character attributes; dialogue opts into committed segment reveal |               |
| [Soundtrack](./stage.md) `soundtrack`   | Plays the world's own music for each scene                                                               |               |

## The four built-in worlds

Mistport, Harukaze Academy and Lantern Barrow each show one play style: Mistport shows traditional narrative, Harukaze Academy shows stage mode, and Lantern Barrow shows tabletop rules. Emberback is written in English and shows how a world can offer editions in several languages.

| World                                                       | Gameplay                                                        | What is worth a look                                                                    |
| ----------------------------------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Mistport (雾港・裂潮纪) `mistport`                          | A dark-fantasy investigation in the traditional narrative style | Hidden story events, memory for investigation, portraits                                |
| Harukaze Academy (遥风学园) `haruka-academy`                | A campus ensemble in stage mode                                 | Campus timetable, dialogue narration, day/night scenes, transparent portraits           |
| Emberback Relay `emberback`                                 | Sci-fi frontier mystery, written in English                     | Shows how one world can carry several languages (English first, with a Chinese edition) |
| Lantern Barrow: The First Delve (提灯古冢) `lantern-barrow` | Classic tabletop dungeon exploration                            | Point buy at the start, dice checks, dungeon panel                                      |

To build your own world based on these, the files are in the repository's [`worlds/`](../../../worlds) directory.

## More

Plugins such as image and voice generation are not built into Covel. You install them separately. See [Install plugins and world packages](../start/packages.md). To write your own, see [Develop plugins](../plugins/index.md).

Generic policy selection and delegation caps are in [session orchestration settings](./features.md#session-orchestration-settings). The bundled policy resolves automatically as the sole service; choose explicitly only when another provider is active. Change the strategy in its own settings.

The story interface also provides the host’s [advancement and Stop controls](../start/first-session.md#while-the-story-advances-automatically). The story provider decides whether to request another round. Ensemble dialogue can follow policy advice to continue and yields to the player when no actor contributes.

Parallel plans dispatch independent actors concurrently within the existing limits; accepted contributions remain in plan order, and actor model-call costs remain. Sequential plans still delegate individually. Ensemble actors respond from their own witnessed history; the shared brief does not automatically tell newcomers about private exchanges from the previous scene. See [ensemble dialogue](./story.md#ensemble-dialogue-and-character-actors).

New compositions remain plugin lists plus a world-generation default view. They do not select a role, perspective or strategy. For Game Master, set Storyteller Perspective to Game master. Ensemble works with the default Player role and mention strategy. To play a human DM, turn off character creation and select Game master in preparation. For Spectator, choose that role at creation, then list, random or director and Advance. Choose Game master instead to direct/narrate the same NPC composition. World allowed-pack lists remain authoritative and saved views are not overwritten. Recommendations stay optional; missing actors/policies preserve narrator-only play.

Ensemble sessions without an eligible sub-agent target receive no delegation tools. When a plan's required target is unavailable, the narrator completes the story alone and yields to the player.

## Story-driven presentation

Stage Scene and Soundtrack story-cue selectors adopt zero-budget [presentation functions](../reference/plugins.md#presentation-runtimes). They add no generation charges; absent plugins or assets degrade only their display. See [stage and sound](./stage.md).

Stage Scene dialogue templates use speaker-scoped portraits with local enlargement. The current cast updates immediately while cast and direction providers explicitly opt into host-owned departure fades; see [Stage and sound](./stage.md).

Stage Scene also offers an initially-off [reading appearance](./stage.md#optional-reading-appearance), selected explicitly under This game's theme in the Menu and recoverable through Restore default appearance.

When extending these bundled agents, follow the [output submission contract](../reference/plugins.md#agent-output-submission). Function runtimes continue returning their business value directly.

World initialization, time, facts, event planning and action suggestions retain their validated tool results. Retrying final confirmation does not repeat successful business writes.
