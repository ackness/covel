# RPG Mechanics

This page covers six built-in plugins that make the story feel more like a game: Dice Check, point buy at the start, quests, inventory, affinity, and hidden story events. Each plugin section explains what you will see, when it is on, what you can change, and what world authors can preset.

| Plugin                              | In short                                                                                         |
| ----------------------------------- | ------------------------------------------------------------------------------------------------ |
| Dice Check (`dice-check`)           | Risky actions roll dice first, and the story is then written to match the result.                |
| Ability Checks (`tabletop-rules`)   | Assigns attribute points to the player character at the start, and lets the player start checks. |
| Quest Log (`core-quest`)            | Records quests, objectives and rewards automatically.                                            |
| Bag (`inventory`)                   | Records items gained, lost and equipped automatically.                                           |
| Affinity (`affinity`)               | Records how close you are with each NPC.                                                         |
| Hidden Plot Events (`story-events`) | Story plots set up by the world author. They happen when their conditions are met.               |

All six are optional. Gameplay requests select checks; matching seed data infers receivers under the [receiver rules](../reference/world-data.md#data-receivers). Players can still turn them off during preparation. For which worlds include them by default, see [the overview at the end of this page](#overview-of-when-they-are-on).

If a concurrent change makes an affinity or clock calculation stale, that derived update is skipped while an independent successful story survives. A later explicit retry reads and recalculates it; see [read-baseline conflicts](../reference/transactions.md#read-baselines).

## Dice Check and Ability Checks: what is different

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

Check modifiers use the action’s actor’s attributes, falling back to the primary seat’s current character.

### What you will see

- A check block in the story text: the action, the calculation, and the result, for example `14 + 4 = 18 vs DC 12`. Critical successes and critical failures are highlighted.
- A "Check Log" panel on the right, listing every check with its turn number and the attribute used (by the world's name for it). The panel has two quick buttons, "Roll d20" and "Roll 2d6".
- When the world sets costs for failure, a failed check gets one more line in its check block and in the "Check Log": the cost, for example "The water gets inside your clothes, and the cold bites deeper." with "Cold and wet +1 (2/4)". In the turn a clock fills, the check block also states the consequence that holds from then on.
- When a carried item adds to the check's modifier, the check block and the "Check Log" show a green badge, for example "Pocket torch +2". When a check is harder because someone will not cooperate or a clock is full, they show one more line with the reason and a red badge, for example "Graham Pike (Cold)" and "DC 12 → 16".
- When the world has failure clocks, a "Clocks" panel appears on the right with one progress bar per clock. A full clock shows its consequence.
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

### How items and relationships change a check

- **Carried items**: an item in the bag with `effects.check` adds to that attribute's modifier while the player character carries it (the best item for each attribute). The modifier list shows it as `Wayfinding 3/5 → +8 (+6, Pocket torch +2)`, and the total stays within ±10. Once the item is gone, the next turn no longer adds it.
- **People who will not cooperate**: an NPC whose affinity tier is below "Neutral" does not want to help the player character. When an action needs that person's help or agreement, the narrator puts the name in `with` in the receipt, and the check is one step harder for each tier below neutral ("Cold" one step, "Hostile" two), up to extreme.
- **Full clocks**: a clock with `raises` makes checks of those attributes one step harder once it is full.

The narrator chooses the difficulty from the fiction and reports it as usual, then reads the outcome as many columns to the right as the "Harder checks" section of the check rules says. The guard and the recorder check the receipt against the same data: a modifier without the item, or a difficulty that was not raised, sends the receipt back. Item data comes from the bag's read service `inventory.bag@2`, and affinity tiers from Affinity's read service `affinity.tier@1`; without the matching plugin, that part has no effect.

### When it is on

Optional. No built-in gameplay pack includes it, so a world has to include it. A world that brings cost-of-failure data also infers it under the [receiver rules](../reference/world-data.md#data-receivers).

| World            | How it is included      |
| ---------------- | ----------------------- |
| `lantern-barrow` | World default selection |
| `last-train`     | World default selection |

For other worlds, you can tick it on the getting-ready screen, or the world author can add it to `plugins`. See [Point buy and dice checks](../recipes/point-buy.md).

It has no settings you can change.

### Cost of failure

A world can make every failed check pay a cost the player can see: an item is lost, or a clock advances by some segments.

1. At the start of a turn, the plugin writes the costs this turn can still pay into the check rules for the narrator, one line per attribute. An item must still be on the player character, and a clock must not be full yet. Whether the item is still there is asked through the bag's public service.
2. After the narrator sends the check receipt, the recorder settles a cost for each failed check. Clocks advance in `clock-progress`; items are taken through `inventory.change@1`. If the item cannot be taken (for example, it was given away this turn), the check pays its next cost. The bag reconciles changes from the prose afterward and does not charge the same cost again. A retry after this step failed also charges once: when the bag already took the same item from the prose in the original turn, the retried recorder does not take it again.
3. When the prose uses none of a cost's words (`cues`), the story is sent back once to be rewritten, with a note naming the cost to add. The second submission is accepted as usual. The review and the settlement read the same receipt: when a narrative plugin returns a receipt in a tool result and also sends one with `emit-event`, both use the one in the tool result.

A failed check pays one cost only, the most specific one: a cost with an attribute comes before one without, and a cost with an `outcome` comes before one for both kinds of failure; between equally specific costs, the one earlier in the file wins. Once a clock is full, its consequence is written into the check rules every turn, and the narrator must keep to it.

Without these two data files, a failure shows only in the prose, as before.

### What world authors can preset

Define the player character's numeric attributes, and write a clear `description` for each one. The model uses these descriptions to decide which attribute applies. A world can also set costs for failure:

| Data             | File                           | Notes                                                                                                                                                                                                                                                                          |
| ---------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Costs of failure | `data/check-consequences.yaml` | Each entry has `id`, `text` (what happens), `cues` (words that prose showing this cost would use) and `cost`: `{ kind: item, item: <item name> }` or `{ kind: clock, clock: <clock id> }`. Optional `attribute` and `outcome` limit it to one attribute or one kind of failure |
| Failure clocks   | `data/check-clocks.yaml`       | Each clock has an `id`, a `name` shown to the player, a number of `segments`, and `full`, which becomes true once it fills; the optional `raises` lists attribute ids whose checks are one step harder once it is full                                                         |

Write at least one cost without `attribute` or `outcome`, so every failure has something to pay. `pnpm validate:world` reports a wrong `attribute`. For the fields, see [world data](../reference/world-data.md#check-consequences).

### Works with

- To use a different check system, such as d100, you can replace this plugin with another plugin that provides the same kind of function. Most players do not need to think about this.
- The narrative plugin in the gameplay pack (such as `narrator`) reads the check results. Without a narrative plugin, the checks have no effect.

## Ability Checks (`tabletop-rules`)

Adds one step after character creation: assigning points to the player character's attributes. During play, you can also start a check yourself, choosing the action, the attribute and the difficulty.

Point allocation and checks follow the action’s actor, falling back to the primary seat’s current character.

### What you will see

- After you create a character, an "Opening point allocation: distribute N points" form appears. Each attribute that can be adjusted has a starting value and a maximum. You must use up all the points exactly, then click "Finish allocation". If you enter something wrong, the form tells you what is wrong, and you can change it.
- An "Attribute checks" panel on the right. Click "Request an attribute check", fill in "Attempted action", choose "Attribute" and "Difficulty", then click "Resolve check". The result comes with a dice record, and retrying or restarting does not roll the dice again.
- Ordinary turns do not show this check form.

If the world has no attributes to assign points to (for example, a dialogue-only world), the point-buy step is skipped. The button in the panel tells you that this world cannot run checks.

### When it is on

Optional. Matching seed data infers a receiver under the [receiver rules](../reference/world-data.md#data-receivers); players can still turn it off during preparation.

| World            | How it is included      |
| ---------------- | ----------------------- |
| `lantern-barrow` | World default selection |

For other worlds, tick it on the getting-ready screen.

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

- A "Quest Log" panel on the right. You can search it, or filter by "All", "Active", "Completed" and "Failed". Each quest shows its objective, the person who gave it, and the reward. Status badges use the same localized names as the filter tabs. Quests and objectives with a deadline carry a `⌛ <deadline>` chip; a missed objective is marked `✗`.
- In a turn where a quest changes, a "Quest Log" block appears in the story text, marked "New", "Progress", "Completed" or "Failed". A quest past its deadline is marked "Failed" and a missed objective "Missed", followed by what missing it means. If nothing changed, it shows "No quest changes this turn."
- The session summary also includes a short overview of the quests.

### When it is on

Optional. Matching seed data infers a receiver under the [receiver rules](../reference/world-data.md#data-receivers); players can still turn it off during preparation.

| World            | How it is included      |
| ---------------- | ----------------------- |
| `lantern-barrow` | World default selection |
| `last-train`     | World default selection |
| `mistport`       | World default selection |
| `haruka-academy` | World default selection |

It has no settings you can change.

### What world authors can preset

| Data            | File               | Notes                                                                                                                              |
| --------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| Starting quests | `data/quests.yaml` | The main quest, plus up to a few side quests. `status` is `active`, `completed` or `failed`. Each objective has `text` and `done`. |

Quests are matched by name, so quest names and the names of people who give them must match what the setting says. For how to write them, see [Starting content](../recipes/starting-content.md).

### Quest deadlines

Quests and objectives can both have a `deadline`:

```yaml
deadline:
  when: { dimension: floodline, path: stage, in: [knee, battery] }
  label: Before the water is knee-deep
  missed: Nobody chose in time, and Dara cut the doors herself.
```

- `when` is a condition that holds once the deadline has passed. It can read a dimension (`{ dimension, path, <operator> }`), a number from world time (`{ time: elapsedSinceStart, gte: 45 }`, in the clock's base unit), how an NPC feels about the player character (`{ affinity: Graham Pike, path: tier, in: [cold, hostile] }`, reading `tier` or `score`, with Affinity on), or the turn number (`{ turnGte: 6 }`). The operators are the same as in hidden plot conditions.
- `label` is the deadline that the player and the narrator see, and `missed` is what happens once it is missed.

Each turn, before the story is written, the `deadline` runtime checks deadlines against this turn's dimensions, world time and affinity tiers. An active quest past its deadline becomes "Failed", and later story notes cannot move it back to active or completed. A missed objective can no longer be completed, while the quest itself goes on. The story reads through `story-context@1` what was just missed and that it must happen this turn, along with the deadlines still open. A whole-number time threshold in the clock's base unit can show a countdown. When the condition cannot be read (for example, the session has no such dimension, or Affinity is off), the deadline has not passed.

Dimensions, world time and affinity settle after the turn ends, so a deadline is judged in the turn after time runs out, and that turn's story is the first to write the consequence. This is on purpose: failing a quest after the story was written would put a failure in the quest log that no prose has shown.

### Works with

The quest log records and advances quests from the quest events that "Story Notes" (`world-ir`) sorts out, without calling a model itself. Without Story Notes, preset quests still show, but no quest is recorded or advanced during play.

## Bag (`inventory`)

Items that the story clearly gives you, takes from you, or equips are recorded in your bag automatically. You can check it on the right at any time.

Bookkeeping applies only item changes held by the action’s actor, falling back to the primary seat’s current character. Other player characters’ item changes do not enter the bag.

### What you will see

- An "Bag" panel on the right, with two sections: "Equipped" and "Backpack". Items have "Equip", "Unequip" and "Drop" buttons.
- In a turn where items change, an "Bag changes" block appears in the story text, marked "Gained", "Lost", "Equipped" or "Unequipped".
- Type `/bag` (or `/inventory`) to see your current bag and open the panel.
- The session summary says "Your bag contains N item entries."

Changes made with the panel buttons are validated and committed with that execution. A missing item or invalid request shows an error, and a rejected commit also leaves the bag unchanged. During a story turn, a click may need to wait or report that the game is busy.

During a purchase, trade or gift, the narrator can change the bag before writing the story. An unaffordable purchase is refused. If a staged change cannot be applied when the turn is saved, you see a notice and the story is still saved. If a purchase fails, other bag changes from that turn may be skipped. Changes made through the bag tool are not counted again from the story; batches with long item descriptions are also checked against the retained settlement results.

Only item changes that clearly happen in the story are recorded. Bag dataset records are checked when the turn is saved. An invalid record skips that bookkeeping step for this turn; the story is still saved.

### When it is on

Optional. Matching seed data infers a receiver under the [receiver rules](../reference/world-data.md#data-receivers); players can still turn it off during preparation.

| World            | How it is included      |
| ---------------- | ----------------------- |
| `lantern-barrow` | World default selection |
| `last-train`     | World default selection |

It has no settings you can change.

### What world authors can preset

Seeded items must pass the dataset’s `set` and record-schema checks. Sync may delete seeded items removed from their authoritative source.

| Data           | File              | Notes                                                                                                                                                                                                                                                                                                                 |
| -------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Starting items | `data/items.yaml` | Things the player starts with. `quantity` is a number. Players see the tags, so write them in the world's language, and give currency a tag that says so. Worn items get `equipped: true`. An item that helps one kind of check gets `effects: { check: { attribute: <attribute id>, modifier: 2 } }` (from -5 to 5). |

Keep the list short. Items gained during play are recorded automatically. For how to write them, see [Starting content](../recipes/starting-content.md).

### Works with

Both Storyteller (`narrator`) and Chat Storyteller (`chat-mode-narrator`) use the bag lookup and change tools when Bag is active. Without Bag, they continue telling the story as usual.

Bag adds the story's other item changes from the facts that "Story Notes" (`world-ir`) sorts out. Without Story Notes it adds none, and the bag changes only through the storyteller's bag tools and actions in the panel.

Dice Check (`dice-check`) reads an item's `effects.check` through the paginated read service `inventory.bag@2`; see [How items and relationships change a check](#how-items-and-relationships-change-a-check).

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

Optional. Matching seed data infers a receiver under the [receiver rules](../reference/world-data.md#data-receivers); players can still turn it off during preparation.

| World            | How it is included      |
| ---------------- | ----------------------- |
| `lantern-barrow` | World default selection |
| `last-train`     | World default selection |
| `haruka-academy` | World default selection |

> [!NOTE]
> It makes one more model call per turn to decide score changes, so it costs a little more money and time. If you want to save money, do not turn it on.

With "Story Notes" (`world-ir`) on, it looks for interactions in the sorted facts; without it, it reads this turn's story directly.

It has no settings you can change.

### What world authors can preset

Seeded affinity records must pass the dataset’s `set` and record-schema checks. Sync may delete seeded records removed from their authoritative source.

| Data              | File                 | Notes                                                                                                                                                           |
| ----------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Starting affinity | `data/affinity.yaml` | Key NPCs who already have a relationship with the player at the start. `score` is an integer from -100 to 100. `notes` explains the score in a sentence or two. |

The `id` and `name` must match the NPC's character setting. Later updates are matched by name. For how to write them, see [Starting content](../recipes/starting-content.md).

### Works with

Affinity provides the read service `affinity.tier@1`: it returns NPCs' scores and tiers by name (or a known alias), and `tiers` lists the tiers from lowest to highest. Dice Check uses it so that people who have gone cold do not cooperate, and Quest Log uses it as a condition of [quest deadlines](#quest-deadlines).

## Hidden Plot Events (`story-events`)

Event planning retains the validated tool result. Retrying final confirmation does not plan successful events again.

World authors can set up hidden plots, unlockable options, and hidden rewards that stay invisible until their conditions are met. Until then, neither the model nor the player can see their content. Conditions can be deterministic rules, natural-language descriptions judged by a concealed sub-agent, or a mix of both. Once met, the narrative works plot cues into the story naturally, unlocked hidden options appear among your choices, and hidden rewards are settled as declared.

### What you will see

There is no permanent side panel. Ordinary hidden plot events appear only in the story, as if they were turns the story took on its own. If the narrative leaves an event out, a reminder is sent on the next turn (each event gets only one reminder).

On turns when a hidden option unlocks or an announced hidden reward is granted, a lightweight block appears below the story text:

- In Read and Chat modes, tapping an option under "Unlocked hidden actions" fills the input box so you can send or adjust it.
- In Stage mode, unlocked hidden options merge directly into the stage choice bar so clicking sends them right away.
- Even if you reword an unlocked hidden option, background judging recognizes your intent and settles its plot cue and rewards.
- Hidden rewards can add items to your bag, add entries to the session lorebook, or surface as narrative gains; silent rewards settle without a banner.

### When it is on

Optional. Matching seed data infers a receiver under the [receiver rules](../reference/world-data.md#data-receivers); players can still turn it off during preparation.

| World            | How it is included      |
| ---------------- | ----------------------- |
| `lantern-barrow` | World default selection |
| `last-train`     | World default selection |
| `mistport`       | World default selection |
| `haruka-academy` | World default selection |

If a world has no hidden event data, turning this on does nothing.

### What you can change

| Setting                                           | What it does                                                                                                                                             | Default |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| Plan hidden events (`planner`)                    | Every 3 turns, calls the model to set up hidden events behind the scenes that happen later, based on the story                                           | Off     |
| Judge natural-language triggers (`semanticJudge`) | Lets a concealed sub-agent judge natural-language hidden conditions and rewritten hidden options; worlds without semantic conditions make no extra calls | On      |
| Max semantic checks per turn (`maxJudgedPerTurn`) | Upper bound on how many shortlisted natural-language hidden conditions are batched into one judge call each turn (1 to 16)                               | 8       |

Turning on `planner` adds model calls; `lantern-barrow`, `last-train` and `mistport` have already turned it on for you. `semanticJudge` only makes a concealed post-turn call (with no first-token delay, unless an entry explicitly requests pre-turn timing) when a world uses natural-language conditions whose deterministic gates pass, or when active hidden options need intent matching.

### What world authors can preset

| Data                | File                            | Notes                                                                                                                             |
| ------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Hidden story events | `data/hidden/story-events.yaml` | Each entry has a trigger condition `when` and at least one of `payload` (narrative cue), `options` (hidden choices), or `rewards` |

This data must be imported as hidden data (the conventional path `data/hidden/story-events.yaml` imports as hidden automatically), or players could see it.

- **Conditions (`when`)**: Can check dimensions, world time, NPC affinity (`affinity`), carried items (`item`), character attributes (`attribute`), whether another event happened (`revealed`), whether a hidden option was chosen (`selected`), or the turn number (`turnGte` / `turnLte`). You can also write a plain natural-language string or a `{ judge, id?, scope?, sticky?, watch? }` leaf, and combine leaves with `all`, `any` and `not`. Putting a `judge` leaf inside `all` alongside deterministic gates short-circuits when the deterministic gates fail, skipping model calls.
- **Payloads, options and rewards**: Write `payload` as a short hint for the narrative, not finished prose, and do not reveal later events in it. Entries in `options` stay hidden until unlocked, then expose only their public text until chosen, releasing their hidden `payload` and rewards only on selection. `rewards` support `item` (settled through Bag's write service, falling back to narrative context when Bag is off), `lorebook` (upserted into the session lorebook), and `narrative` (context cues), with optional `requireOutcome: true` to confirm the story achieved the outcome first or `announce: false` for silent settlement. For how to import data, see [World data](../reference/world-data.md).
- **AI world creation and revision**: In-app AI World Creation lists "Hidden plot events" as an optional plugin supplement that generates hidden events, options, and rewards with natural-language or hybrid conditions while keeping them hidden. You can also ask AI World Revision to add or edit hidden events and options in natural language.

A misspelled dimension ID, an invalid path inside a dimension, a candidate in `equals` / `notEquals` / `in` that does not satisfy the dimension schema, or an unknown character attribute ID produces a reference error. Both `pnpm validate:world` and session import check these fields; see [world data](../reference/world-data.md).

## Overview of when they are on

| Plugin           | `lantern-barrow` | `last-train` | `mistport` | `haruka-academy` |
| ---------------- | ---------------- | ------------ | ---------- | ---------------- |
| `dice-check`     | Yes              | Yes          |            |                  |
| `tabletop-rules` | Yes              |              |            |                  |
| `core-quest`     | Yes              | Yes          | Yes        | Yes              |
| `inventory`      | Yes              | Yes          |            |                  |
| `affinity`       | Yes              | Yes          |            | Yes              |
| `story-events`   | Yes              | Yes          | Yes        | Yes              |

The three general gameplay packs (Classic Story, Dialogue, Budget) do not themselves request these six plugins. Actual data can infer receivers; gameplay without seed data uses explicit world `plugins` requests or preparation choices.

## Next

- [Point buy and dice checks](../recipes/point-buy.md): turn a world into a tabletop game
- [Starting content](../recipes/starting-content.md): preset quests, items and affinity for a world
- [World data](../reference/world-data.md): how data files go into a world package
- [Built-in plugin overview](./index.md)

When extending these bundled agents, follow the [output submission contract](../reference/plugins.md#agent-output-submission). Function runtimes continue returning their business value directly.
