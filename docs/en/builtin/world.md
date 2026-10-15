# Characters and World

This page covers the start of a game and the world itself: what happens when a game begins, how the player character is created, and how the people, rules, time and new discoveries in the world are recorded.

The page follows the order you meet them in a game. First come the four that run at the start, then the five that keep updating as the story goes on.

| Plugin                                     | In short                                                                             |
| ------------------------------------------ | ------------------------------------------------------------------------------------ |
| Pre-Game Setup (`pregame`)                 | Reads the world material at the start and prepares the first part of the adventure   |
| Character Creator (`char-creator`)         | Asks you to fill in your character at the start, and records the people in the story |
| Character Profiles (`character-blueprint`) | Keeps the character profiles and portraits the world sets up                         |
| World Dimensions (`world-init`)            | Prepares the character attributes and world dimensions, and keeps them updated       |
| World Time (`world-time`)                  | Records the date and time of day in the world                                        |
| World Rules (`living-world-rules`)         | Shows the rules and taboos that hold for the whole world                             |
| Codex (`codex`)                            | Automatically organizes newly found places, people and items                         |
| Relationship Graph (`npc-graph`)           | Records relationships between people                                                 |
| World Fact Extraction (`world-ir`)         | Sorts out the facts of each turn in the background, for other plugins to use         |

> [!NOTE]
> None of the plugins on this page has settings for you to adjust, so there is no "What you can change" section below. Plugins that are on by default (`kind: core`) can be turned off on the session-prep screen. Other plugins are chosen by the world or the gameplay pack. For how to install and manage them, see [Install and manage](../start/packages.md).

## Pre-Game Setup (`pregame`)

Reads the world material before the game starts, prepares the first part of the adventure, and shows a welcome notice. It does not call a model, so it finishes almost at once.

**What you will see**: a notice that says "Welcome to [world name]".

**When it is on**: on by default (`kind: core`). You can turn it off on the session-prep screen.

## Character Creator (`char-creator`)

At the start, it guides you through creating the player character. It gives you an opening passage that describes arriving in the world, then a short form. Once you fill in the form, the story begins. During play, it also records important new people in the story as characters, and updates their status, injuries and equipment.

**What you will see**

- The character form at the start. The first field is the character's name. Up to three more fields follow, taken from the text or choice attributes the world defines for characters. Numeric attributes are not filled in on the form. They use the world's default values.
- A list of characters in the "Characters" tab on the right. Each character is an expandable card with a portrait. The alias is shown under the name. The cards are read-only.

**When it is on**: on by default (`kind: core`). You can turn it off on the session-prep screen. Traditional Story, Dialogue Mode and Low Cost all include it.

**Notes**

- A character's name cannot be the same as a name or alias of a character already in the world. If it is, the form shows a note under the name. Change the name and submit again.
- If the world later stops accepting some of what you entered before, the form appears again. The answers that still work are already filled in, and the form explains why.
- People who already appear in the story are not recorded a second time. If the narrative uses a different form of their name, it only adds an alias to the original character.
- A character's name, type and description are protected. They are not rewritten by what other people say about them or by memories in the story.

## Character Profiles (`character-blueprint`)

Keeps the people that the world author has written in advance: personality, way of speaking, secrets, and relationships with others. When one of these people appears in the story, the narrative plays them according to this profile. The profile's "secrets" are known only to the narrative. They are not stated directly until the plot reveals them.

**What you will see**

- "Preset Characters" in the "Characters" tab on the right. It lists the world's preset people. It is read-only.
- The "Character Portraits" tab: each character's avatar and portrait. You can upload an image to replace one. During play you cannot add or change character cards.

**When it is on**: optional. The Dialogue Mode pack includes it, and worlds with their own characters, such as Mistport, add it to their own packs. Traditional Story and Low Cost do not include it.

> [!NOTE]
> The preset characters' "secrets" and rules are stored in public plugin data. The character panel does not show them, but the "Database" tab on the right shows all of the public plugin data as it is. If you do not want to spoil the story for yourself, do not open that page.

**What world authors can preset**

| Content                   | File                        |
| ------------------------- | --------------------------- |
| Preset character profiles | `characters/main-cast.json` |
| Portrait mapping          | `media/presence.json`       |
| Portrait images           | `media/portraits/`          |

Do not write the portrait mapping by hand. It is produced when you generate portraits. For how to do that, see [Character portraits](../worlds/portraits.md). For fields and examples, see [World data](../reference/world-data.md). You can also run `pnpm describe:authoring` in the repository root.

**Works with**: a character's profile is given to the narrative only when that character is already in the session. Characters who are not present are not included. Each card can have up to 300 characters per line, and the total length is limited. If it does not fit, first delete the sample lines, then delete rules.

## World Dimensions (`world-init`)

At the start, it prepares the character attributes and the "dimensions" of this world. Dimensions are data that the world records and that can change, such as reputation, the state of the city walls, or a countdown. During play, after each turn ends, it changes the values of the dimensions according to the update rules the world author wrote.

**What you will see**

- "Overview" and "Character Traits" in the "World Details" tab on the right. Character Traits reads the current session character schema, so a save with an existing schema shows it immediately. Type and category badges follow the UI language.
- The current value of each dimension is shown in the panel, and you can change it by hand. If a turn's settlement fails, the panel tells you. You can retry, mark it as handled manually, or skip it explicitly. Before your next action, the system automatically retries once.

**When it is on**: on by default (`kind: core`). You can turn it off on the session-prep screen. All three built-in packs include it.

**What world authors can preset**: declare the structure, starting values and update rules of each dimension in `data/dimensions.yaml`. For how to write them, see [World data](../reference/world-data.md). For how dimensions update, see [Dynamic world dimensions](../reference/dynamic-dimensions.md).

**Notes**

- The starting values that the world author writes are not overwritten by play. The current value of each game is kept separately.
- If the world already has enough data, the start does not generate it again, and it does not reset values that have already changed. When a plugin upgrade reruns setup, it only adopts newly declared dimensions and does not write another system message.
- Dimensions that change over time, such as a countdown, follow the world's time.

## World Time (`world-time`)

Gives the world its own calendar. After each turn of the story ends, it judges from the story how much time has passed, and updates the date and time of day. Before the next turn's narrative begins, it tells the narrative the current time.

**What you will see**

- The "World Time" panel: the current time.
- The "Time rules" panel: how time works in this world. You can see it before the first turn.
- A line in the status summary: "World time: ...".
- Type `/time` to see the current world time. It only reads the time. It does not call a model and does not advance the turn. If the story has not started yet, it says the time has not been recorded.

**When it is on**: on by default (`kind: core`). You can turn it off on the session-prep screen. Each successful narrative turn usually adds one model call.

**What world authors can preset**: `data/time.yaml`, with an `id: world` and a `definition`. The world can have a simple cycle of a few times of day, or a calendar with months and days. You can also set time to run forward, run backward, run both ways, or run at random, and describe in a paragraph how long various actions take. For the fields, see [World time](../reference/world-time.md).

**Notes**

- If the world does not define time, it uses a generic world calendar: 12 months a year, 30 days a month, 24 hours a day, starting at 08:00 on January 1 of year 1. This is not the Gregorian calendar.
- Once a game has started recording time, the time definition is fixed. If you change the world file later, existing saves keep their time. The change only applies to a new game.
- If the narrative fails, or the turn is rolled back, time does not move forward.

## World Rules (`living-world-rules`)

Shows the rules that hold for the whole world over time: customs, taboos, laws, and special settings. These rules go into the prompt, so the story does not contradict itself.

**What you will see**: "World Rules" in the "World Details" tab on the right. It is read-only. During play you cannot add or change rules. Category badges follow the UI language.

**When it is on**: optional. All three built-in packs include it.

**What world authors can preset**: `data/rules/world-rules.yaml`. Each rule states one thing the narrative must not break, in plain sentences that explain the rule and its consequences. Do not repeat numbers that dimensions already record. For fields, see [World data](../reference/world-data.md). You can also run `pnpm describe:authoring`.

## Codex (`codex`)

When a named place, person, item, skill, legend or monster first appears in the story, it is recorded in the codex automatically, and you can look it up any time. If the same name appears again, it only adds to the existing entry. It does not create a duplicate.

**What you will see**: the "Codex" tab on the right. You can search it, and filter entries by Characters, Locations, Items, Skills, Lore and Monsters. At the bottom it shows "N entries collected". Below each turn there is also a "Found this turn" card. Entry badges use the same localized names as the category tabs; the codex panel declares its rarity colors.

**When it is on**: optional. The Traditional Story pack includes it. It needs "World Fact Extraction", which is turned on together with it.

**Notes**

- It is strict. It would rather miss an entry than record one wrongly. It records at most 3 entries per turn, and most turns record nothing.
- Character status and relationships are not recorded here. Those belong to Character Creator and Relationship Graph. People in the codex are recorded only for background: passersby, people from legends, or their origins and references.
- Each time it sorts entries, it makes one more model call.

## Relationship Graph (`npc-graph`)

A development save with duplicate open versions of one relation is refused instead of repaired during play. Recreate the affected graph data or start a new session. Current relations without `invalidAt` remain valid open versions.

Records relationships between people, groups and factions. It checks existing nodes and relationships when recording new ones. When the story mentions them again, the narrative recalls these relationships, so it is less likely to contradict itself.

**What you will see**: the "Relationship Graph" tab on the right. Nodes are people or factions. Green lines are positive relationships, red lines are negative ones, and gray lines are neutral. Click a node to see its profile.

**When it is on**: optional. The Traditional Story pack includes it, and Dialogue Mode recommends it. It needs "World Fact Extraction", which is turned on together with it.

**Notes**

- When a relationship changes, the old one is folded away and the new one takes its place. Two contradicting relationships never exist at the same time.
- The graph only includes people, groups and factions. Places and items are not in the graph.
- It updates after each new passage of the narrative, which adds one model call.

## World Fact Extraction (`world-ir`)

You cannot see this plugin, and it has no panel. After each turn ends, it sorts out the people, relationships, events and clues from that turn into a list. It passes the list to the codex, relationship graph, quest log, inventory and similar plugins. This way, each plugin does not have to read the story again on its own.

If you use any of these plugins, keep this one on. If you turn it off, the plugins that depend on it get no facts, and they cannot be turned on. It adds one model call per turn. If you want to save money, remove it together with the plugins that depend on it. The "Low Cost" pack is the simplest choice.

**When it is on**: optional. When you turn on a plugin that depends on it, it is turned on automatically. You do not need to select it separately.

## Next

- [Built-in plugin overview](./index.md)
- [Narrative and story](./story.md)
- [First world](../worlds/first-world.md)
- [Preset quests, items and affinity for a world](../recipes/starting-content.md)
- [World data reference](../reference/world-data.md)
