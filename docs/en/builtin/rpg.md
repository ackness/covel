# RPG Mechanics

This page covers six built-in plugins that make the story feel more like a game: Dice Check, point buy at the start, quests, inventory, affinity, and hidden story events. Each plugin section explains what you will see, when it is on, what you can change, and what world authors can preset.

| Plugin                               | In short                                                                                         |
| ------------------------------------ | ------------------------------------------------------------------------------------------------ |
| Dice Check (`dice-check`)            | Risky actions roll dice first, and the story is then written to match the result.                |
| Tabletop Rules (`tabletop-rules`)    | Assigns attribute points to the player character at the start, and lets the player start checks. |
| Quest Log (`core-quest`)             | Records quests, objectives and rewards automatically.                                            |
| Inventory (`inventory`)              | Records items gained, lost and equipped automatically.                                           |
| Affinity (`affinity`)                | Records how close you are with each NPC.                                                         |
| Hidden Story Events (`story-events`) | Story plots set up by the world author. They happen when their conditions are met.               |

All six are optional and are not turned on automatically. For which worlds include them by default, see [the overview at the end of this page](#overview-of-when-they-are-on).

## Dice Check and Tabletop Rules: what is different

Both plugins involve dice, but they do different jobs. You can use one, or both together.

|                                       | `dice-check`                                                                               | `tabletop-rules`                                     |
| ------------------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| What it handles                       | Risky actions during play                                                                  | Point buy at the start, and checks the player starts |
| Who triggers it                       | The story has the player character do something risky, and the model decides automatically | The player clicks a button in the right-hand panel   |
| Who sets the attribute and difficulty | The model                                                                                  | The player                                           |
| Dice                                  | Three d20s are rolled before each turn. The model can only use them in order               | Settled on the spot after the player submits         |
| Has a start-of-game form?             | No                                                                                         | Yes, a point-buy form                                |

When used together:

- At the start, `tabletop-rules` lets you assign points to attributes.
- During play, ordinary risky actions are decided automatically by `dice-check`.
- A check you start yourself from the "Attribute checks" panel is settled by `tabletop-rules`. In that turn, `dice-check` steps aside and does not roll again.

For full setup steps, see [Point buy and dice checks](../recipes/point-buy.md).

## Dice Check (`dice-check`)

When the player character does something with a risk of failing, such as picking a lock, climbing a wall, or persuading a guard, the result is not left to the model's guess. The dice are rolled before the story is written. The model can only read the result under the rules, and the success or failure it writes must match the dice. If it does not match, the text is sent back for a rewrite. Actions without risk do not roll dice.

### What you will see

- A check block in the story text: the action, the calculation, and the result, for example `14 + 4 = 18 vs DC 12`. Critical successes and critical failures are highlighted.
- A "Check Log" panel on the right, listing every check with its turn number and the attribute used (by the world's name for it). The panel has two quick buttons, "Roll d20" and "Roll 2d6".
- You can roll dice yourself by typing `/roll` in the input box. `/roll 2d6` rolls two six-sided dice. If you do not write a dice expression, it rolls `1d20`. `/r` is a short form. Dice are written as `NdM`: 1 to 100 dice at a time, each with 2 to 1000 sides.

Dice you roll yourself are shown as a result only. They do not change the checks in the story.

### Difficulty

The model picks one of four difficulty levels. Each one has a target number (DC):

| Difficulty | Target number |
| ---------- | ------------- |
| easy       | 8             |
| normal     | 12            |
| hard       | 16            |
| extreme    | 20            |

If the d20 plus the attribute modifier reaches the target, the check succeeds. A natural 20 is a critical success. A natural 1 is a critical failure.

If a numeric attribute of the player character is in the `abilities` category and has minimum and maximum values, the plugin scales it to a modifier from 0 to +10 and lists it for the narrator. Values such as health or trust (`stats`, `social`) are not used for checks. So put the attributes checks use in `abilities` and give them proper `min` and `max` values. If no ranged ability is available or character data is missing, checks still roll with modifier 0 and show no attribute label.

### When it is on

Optional. No built-in gameplay pack includes it, so a world has to include it.

| World            | How it is included                              |
| ---------------- | ----------------------------------------------- |
| `lantern-barrow` | "Classic Tabletop" gameplay pack, on by default |
| `emberback`      | "Emberback Rescue" gameplay pack, on by default |

For other worlds, you can tick it on the session-prep screen, or the world author can add it to `pluginPolicy`. See [Point buy and dice checks](../recipes/point-buy.md).

It has no settings you can change.

### What world authors can preset

It takes no world data. What a world can do is define the player character's numeric attributes, and write a clear `description` for each one. The model uses these descriptions to decide which attribute applies.

### Works with

- To use a different check system, such as d100, you can replace this plugin with another plugin that provides the same kind of function. Most players do not need to think about this.
- The narrative plugin in the gameplay pack (such as `narrator`) reads the check results. Without a narrative plugin, the checks have no effect.

## Tabletop Rules (`tabletop-rules`)

Adds one step after character creation: assigning points to the player character's attributes. During play, you can also start a check yourself, choosing the action, the attribute and the difficulty.

### What you will see

- After you create a character, an "Opening point allocation: distribute N points" form appears. Each attribute that can be adjusted has a starting value and a maximum. You must use up all the points exactly, then click "Finish allocation". If you enter something wrong, the form tells you what is wrong, and you can change it.
- An "Attribute checks" panel on the right. Click "Request an attribute check", fill in "Attempted action", choose "Attribute" and "Difficulty", then click "Resolve check". The result comes with a dice record, and retrying or restarting does not roll the dice again.
- Ordinary turns do not show this check form.

If the world has no attributes to assign points to (for example, a dialogue-only world), the point-buy step is skipped. The button in the panel tells you that this world cannot run checks.

### When it is on

Optional, and not turned on automatically.

| World            | How it is included                              |
| ---------------- | ----------------------------------------------- |
| `lantern-barrow` | "Classic Tabletop" gameplay pack, on by default |

For other worlds, tick it on the session-prep screen.

> [!NOTE]
> If you turn it on partway through a game, the existing player character is not rebuilt, and the point-buy form is not shown again. Only later checks become available. After turning it on, continue one turn so the plugin can finish setting up, then start a check.

It has no settings you can change.

### What world authors can preset

| Data            | File                       | Notes                                                                                         |
| --------------- | -------------------------- | --------------------------------------------------------------------------------------------- |
| Point-buy rules | `data/tabletop-rules.json` | The total points `budget`, and for each attribute a starting value `base` and a maximum `max` |

If this file is missing, the plugin uses every numeric attribute in the world (category `abilities`, with `min` and `max`) for point buy, and adds 4 extra points. Resources such as health and stamina are not included automatically.

Each attribute `id` must match the one defined in `world.yaml`. `pnpm validate:world` identifies attributes that do not meet these requirements; session import also checks them. For how to write and check the rules, see [Point buy and dice checks](../recipes/point-buy.md). For how data gets into a world package, see [World data](../reference/world-data.md).

## Quest Log (`core-quest`)

When the story clearly gives a commission or an objective, it is logged as a quest automatically. When objectives are completed, or a quest ends in success or failure, it is updated automatically. You do not need to record anything yourself.

### What you will see

- A "Quest Log" panel on the right. You can search it, or filter by "All", "Active", "Completed" and "Failed". Each quest shows its objective, the person who gave it, and the reward. Status badges use the same localized names as the filter tabs.
- In a turn where a quest changes, a "Quest Log" block appears in the story text, marked "New", "Progress", "Completed" or "Failed". If nothing changed, it shows "No quest changes this turn."
- The session summary also includes a short overview of the quests.

### When it is on

Optional, and not turned on automatically.

| World            | How it is included                              |
| ---------------- | ----------------------------------------------- |
| `lantern-barrow` | "Classic Tabletop" gameplay pack, on by default |
| `emberback`      | "Emberback Rescue" gameplay pack, on by default |

It has no settings you can change.

### What world authors can preset

| Data            | File               | Notes                                                                                                                              |
| --------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| Starting quests | `data/quests.yaml` | The main quest, plus up to a few side quests. `status` is `active`, `completed` or `failed`. Each objective has `text` and `done`. |

Quests are matched by name, so quest names and the names of people who give them must match what the setting says. For how to write them, see [Starting content](../recipes/starting-content.md).

## Inventory (`inventory`)

Items that the story clearly gives you, takes from you, or equips are recorded in your bag automatically. You can check it on the right at any time.

### What you will see

- An "Inventory" panel on the right, with two sections: "Equipped" and "Backpack". Items have "Equip", "Unequip" and "Drop" buttons.
- In a turn where items change, an "Inventory changes" block appears in the story text, marked "Gained", "Lost", "Equipped" or "Unequipped".
- Type `/bag` (or `/inventory`) to see your current bag and open the panel.
- The session summary says "Your bag contains N item entries."

Only item changes that clearly happen in the story are recorded. Inventory dataset records are checked when the turn is saved. An invalid record skips that bookkeeping step for this turn; the story is still saved.

### When it is on

Optional, and not turned on automatically.

| World            | How it is included                              |
| ---------------- | ----------------------------------------------- |
| `lantern-barrow` | "Classic Tabletop" gameplay pack, on by default |
| `emberback`      | "Emberback Rescue" gameplay pack, on by default |

It has no settings you can change.

### What world authors can preset

| Data           | File              | Notes                                                                                                                                                                                      |
| -------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Starting items | `data/items.yaml` | Things the player starts with. `quantity` is a number. Players see the tags, so write them in the world's language, and give currency a tag that says so. Worn items get `equipped: true`. |

Keep the list short. Items gained during play are recorded automatically. For how to write them, see [Starting content](../recipes/starting-content.md).

## Affinity (`affinity`)

Records your relationship with each NPC. When you have a clear interaction with an NPC, such as chatting, giving a gift, helping, a conflict, or a betrayal, that NPC's score changes.

### What you will see

- An "Affinity" panel on the right, with one row per NPC showing the score and level. Scores range from -100 to 100, and 0 is neutral.
- In a turn where a score changes, an "Affinity changes" note appears in the story text.

Affinity dataset records are checked when the turn is saved. An invalid record skips that bookkeeping step for this turn; the story is still saved.

The narrator can read committed current scores directly, including seeded records that have no tier yet. This read adds no model call. Scores and tiers are not romance-route stages; an omitted NPC is not assumed to have a score of 0. Turning the plugin off also removes this context.

Levels are set by score:

| Score       | Level    |
| ----------- | -------- |
| -100 to -60 | Hostile  |
| -59 to -20  | Cold     |
| -19 to 19   | Neutral  |
| 20 to 59    | Friendly |
| 60 to 84    | Close    |
| 85 to 100   | Devoted  |

Worlds can seed starting affinity; during play, new records are created only for named NPCs you actually interact with. Passersby and people who are just present are not. A routine interaction changes the score by 1 to 5. A major event can change it by up to 20.

### When it is on

Optional, and not turned on automatically.

| World            | How it is included                                           |
| ---------------- | ------------------------------------------------------------ |
| `lantern-barrow` | "Classic Tabletop" gameplay pack, on by default              |
| `emberback`      | "Emberback Rescue" gameplay pack, on by default              |
| `haruka-academy` | "Campus Romance · Visual Novel" gameplay pack, on by default |

> [!NOTE]
> It makes one more model call per turn to decide score changes, so it costs a little more money and time. If you want to save money, do not turn it on.

It has no settings you can change.

### What world authors can preset

| Data              | File                 | Notes                                                                                                                                                           |
| ----------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Starting affinity | `data/affinity.yaml` | Key NPCs who already have a relationship with the player at the start. `score` is an integer from -100 to 100. `notes` explains the score in a sentence or two. |

The `id` and `name` must match the NPC's character setting. Later updates are matched by name. For how to write them, see [Starting content](../recipes/starting-content.md).

## Hidden Story Events (`story-events`)

World authors can set up plots that happen only when certain conditions are met. Until the conditions are met, neither the model nor the player can see the content. In the turn when the conditions are met, the narrative works the event into the story naturally.

### What you will see

There is no dedicated panel. You only meet these events in the story, as if they were turns the story took on its own.

If the narrative leaves an event out, a reminder is sent on the next turn. Each event gets only one reminder.

### When it is on

Optional, and not turned on automatically.

| World            | How it is included                                           |
| ---------------- | ------------------------------------------------------------ |
| `lantern-barrow` | "Classic Tabletop" gameplay pack, on by default              |
| `emberback`      | "Emberback Rescue" gameplay pack, on by default              |
| `mistport`       | "Mistport Investigation" gameplay pack, on by default        |
| `haruka-academy` | "Campus Romance · Visual Novel" gameplay pack, on by default |

If a world has no hidden event data, turning this on does nothing.

### What you can change

| Setting                   | What it does                                                                                                   | Default |
| ------------------------- | -------------------------------------------------------------------------------------------------------------- | ------- |
| Story planner (`planner`) | Every 3 turns, calls the model to set up hidden events behind the scenes that happen later, based on the story | Off     |

Turning it on adds model calls. The worlds `lantern-barrow`, `emberback` and `mistport` have already turned it on for you.

### What world authors can preset

| Data                | File                            | Notes                                                                                   |
| ------------------- | ------------------------------- | --------------------------------------------------------------------------------------- |
| Hidden story events | `data/hidden/story-events.yaml` | Each event has a trigger condition `when` and a short hint for the narrative, `payload` |

This data must be imported as hidden data, or players could see it. A condition can check dimensions, world time, whether another event has happened, or the turn number. You can combine them with `all`, `any` and `not`. Write `payload` as a short hint for the narrative, not as finished text. Do not reveal later events in it. For how to import data, see [World data](../reference/world-data.md).

A misspelled dimension ID, an invalid path inside a dimension, or a candidate in `equals` / `notEquals` / `in` that does not satisfy the dimension schema produces a `dimension-reference` error. Both `pnpm validate:world` and session import check these fields; see [world data](../reference/world-data.md).

## Overview of when they are on

| Plugin           | `lantern-barrow` | `emberback` | `mistport` | `haruka-academy` |
| ---------------- | ---------------- | ----------- | ---------- | ---------------- |
| `dice-check`     | Yes              | Yes         |            |                  |
| `tabletop-rules` | Yes              |             |            |                  |
| `core-quest`     | Yes              | Yes         |            |                  |
| `inventory`      | Yes              | Yes         |            |                  |
| `affinity`       | Yes              | Yes         |            | Yes              |
| `story-events`   | Yes              | Yes         | Yes        | Yes              |

None of the three general gameplay packs (Traditional Story, Dialogue Mode, Low Cost) include these six plugins. To use them in other worlds, tick them on the session-prep screen.

## Next

- [Point buy and dice checks](../recipes/point-buy.md): turn a world into a tabletop game
- [Starting content](../recipes/starting-content.md): preset quests, items and affinity for a world
- [World data](../reference/world-data.md): how data files go into a world package
- [Built-in plugin overview](./index.md)
