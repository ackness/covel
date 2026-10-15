# Preset quests, items, and affinity at the start

By default, when a session starts, the protagonist has nothing in hand and no quests. This page shows you how to make the world start with a quest, a few items the character carries, and a relationship with one character.

It uses the world 潮灯镇 (Tidelamp) from the [first world](../worlds/first-world.md).

## The approach

Each of quests, items, and affinity is handled by one plugin. You need to do two things:

1. Tell the world in `world.yaml` to enable these three plugins.
2. Give each plugin a data file, placed where it expects it.

| What to preset | Plugin that handles it | Data file            |
| -------------- | ---------------------- | -------------------- |
| Quests         | `core-quest`           | `data/quests.yaml`   |
| Items          | `inventory`            | `data/items.yaml`    |
| Affinity       | `affinity`             | `data/affinity.yaml` |

## 1. Enable the plugins

Open `world.yaml`, and add `plus` under `pluginPolicy`:

```yaml
pluginPolicy:
  preset: traditional-story
  plus:
    - core-quest
    - inventory
    - affinity
```

`preset` chooses a base set of plugins (a built-in pack), and `plus` adds to it. When the player switches packs, the plugins in `plus` stay.

## 2. Write a starting quest

Create `data/quests.yaml`:

```yaml
- id: light-in-the-tower
  name: 塔里的光
  description: 熄了四十年的旧灯塔在大退潮之夜亮了。趁石路还露在水面上，去弄清是谁点的灯。
  status: active
  giver: 何三娘
  objectives:
    - id: ask-innkeeper
      text: 向何三娘打听灯塔的事
      done: false
    - id: cross-stone-road
      text: 在潮水回来之前走过石路
      done: false
```

- `status` can be `active` (in progress), `completed` (finished), or `failed` (failed).
- `objectives` are the small goals of the quest. When the player completes one during play, the quest plugin checks it off on its own.
- A few main and side quests are enough to preset. New quests that appear during play are recorded automatically.

## 3. Write starting items

Create `data/items.yaml`:

```yaml
- id: copper-coins
  name: 铜钱
  quantity: 30
  description: 镇上通用的铜钱。
  tags:
    - currency
- id: storm-lantern
  name: 防风灯
  quantity: 1
  description: 一盏带罩的油灯，油够烧一夜。
  tags:
    - tool
  equipped: true
```

- Money is marked with the `currency` tag.
- `equipped: true` means the protagonist is holding or wearing the item.
- Keep the list short. Things gained during play are recorded in the inventory automatically.

## 4. Write the starting affinity

Create `data/affinity.yaml`:

```yaml
- id: npc-he-sanniang
  name: 何三娘
  score: 10
  notes: 你付了三天的房钱，她对你还算客气，但不谈灯塔。
```

- `score` is an integer from -100 to 100, and 0 is neither good nor bad.
- `id` and `name` must be written exactly as this character is written in `characters/characters.json`. Later changes to affinity are matched by name.

## 5. Validate

```bash
pnpm validate:world ~/.covel/worlds/tidelamp
```

Validation checks every record against the rules of each plugin. For example, if the affinity is set to 200:

```text
✗ /Users/you/.covel/worlds/tidelamp/world.yaml
  error   data/affinity.yaml · [0] · source "affinity"
          record [0] (id "npc-he-sanniang") of source "affinity" failed schema validation: data/score must be <= 100
```

## 6. Check in the game

Preset content appears only in a **newly started session**. Existing saves do not change.

Restart Covel, start a new session in 潮灯镇, and then look at the right panel:

| Where to look | What you should see                                                          |
| ------------- | ---------------------------------------------------------------------------- |
| Quest Log     | "塔里的光" (The Light in the Tower), with two unfinished objectives below it |
| Inventory     | 30 copper coins, and a storm lantern that is already equipped                |
| Affinity      | 何三娘 (He Sanniang), with a score of 10                                     |

## When it does not work as expected

| Symptom                                             | Cause and fix                                                                                                  |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| The panel shows none of the preset content          | You are looking at an old save. Start a new session                                                            |
| Validation passes, but one kind does not appear     | That plugin is not enabled. Check that it is in `plus`, and that the session-prep screen has not turned it off |
| Character names in the story do not match the panel | Several files write the same person's name differently. Use the same name as in `WORLD.md`                     |

> [!NOTE]
> If you have written the data file but the matching plugin is not enabled, validation does not report an error, and the data is simply not used. So step 1 cannot be skipped.

## What else you can preset

Run this command in the repository to see every kind of content the current version can preset, where each file should go, and an example you can copy:

```bash
pnpm describe:authoring
```

Other common ones are: detailed character settings, world rules, memories, hidden story events, and time. For the full rules, see the [World data reference](../reference/world-data.md).
