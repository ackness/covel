# Your first world

This page takes you through writing a small world package by hand. It is called "潮灯镇" (Tidelamp). You will validate it, and then start a game with it in Covel. When you finish, you have a world made of four files that you can keep expanding.

It takes about twenty minutes. You do not need to write code.

## Before you start

- You have finished [your first game](../start/first-session.md), so you know how a game plays.
- You have [run Covel from source](../start/run-from-source.md) once. The command that validates a world is in the repository.
- A text editor.

> [!NOTE]
> If you use only the desktop app and do not want the source code, you can still make a world. Write the same files as on this page, put them in `~/.covel/data/worlds/`, and reopen Covel. You just cannot use the validation command, so you find mistakes only when you start a game.

## What you will make

```text
tidelamp/
├── world.yaml
├── WORLD.md
├── data/
│   └── lorebook.yaml
└── characters/
    └── characters.json
```

## 1. Create the folder

Worlds go in the user worlds folder. By default that is `~/.covel/worlds/`. Name the folder the same as the world ID. Use only lowercase letters, digits, and hyphens, and start with a letter.

```bash
mkdir -p ~/.covel/worlds/tidelamp/data ~/.covel/worlds/tidelamp/characters
```

## 2. Write `world.yaml`

This file states the world's identity and the gameplay it wants. Create `~/.covel/worlds/tidelamp/world.yaml`:

```yaml
id: tidelamp
name: 潮灯镇
version: 0.1.0
summary: 每逢大退潮，海床上会露出一条通往旧灯塔的石路。今夜潮水退得比任何一年都远，熄了四十年的灯塔亮了。
defaultLocale: zh-CN
tags:
  - mystery
  - coastal
pluginPolicy:
  presetId: traditional-story
characterSchema:
  types:
    - npc
  attributes:
    - id: resolve
      name: 胆识
      type: number
      category: stats
      min: 1
      max: 5
      defaultValue: 3
      description: 面对未知时能不能稳住。
```

Here is what each part says:

| Field                   | What it does                                                                                                      |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `id`                    | The world's ID. Two worlds in the same folder cannot use the same ID                                              |
| `name`, `summary`       | The name and the short description shown on the world card                                                        |
| `defaultLocale`         | The language the world is written in. Every file here uses this one language                                      |
| `pluginPolicy.presetId` | The gameplay pack used by default when a game starts. `traditional-story` is the built-in traditional story set   |
| `characterSchema`       | The types and attributes of characters in this world. Here, one attribute is defined: "胆识" (nerve), from 1 to 5 |

There are four built-in gameplay packs: `traditional-story` (Traditional Story), `dialogue-mode` (Dialogue Mode), `low-cost` (Low Cost, which saves tokens), and `narrative-only` (Narrative Only).

## 3. Write `WORLD.md`

This is the main text of the world setting. The narrator model reads it on every turn, so it sets the tone of the story. Create `~/.covel/worlds/tidelamp/WORLD.md`:

```markdown
# 潮灯镇

潮灯镇建在一道黑色礁岬上，镇民靠采集退潮后露出的海床为生。镇外三里的旧灯塔已经熄了四十年。只有大退潮的夜里，海床上才会露出一条通往它的石路。

## 规矩

- 潮水每六个时辰涨落一次，石路只在退潮的两个时辰内可以通行。
- 镇民从不在夜里谈论灯塔，被问起时会岔开话题。

## 开局

今夜是十年一遇的大退潮。主角是刚到镇上的外乡人，在码头客栈落脚。入夜后，所有人都看见旧灯塔的顶层亮了。

<!-- narrator-only -->

## 暗线

灯是守塔人的女儿点的。四十年前她随灯塔一起“失踪”，其实一直住在塔底的潮洞里。主角踏上石路之前不要说破。

<!-- /narrator-only -->
```

Two things are worth noting:

- **Write the opening clearly.** The model needs to know the moment and the place where the story starts.
- **Put the secret between the `narrator-only` markers.** Players can also read `WORLD.md` in the game. The model reads what is between the two marker lines as usual, but players do not see it. Each marker must be on a line by itself.

> [!TIP]
> A good length for the main text is 800 to 1500 characters. It goes into the prompt on every turn. If it is too long, it costs more and gets cut short. Put details that do not need to appear on every turn into the lorebook in the next step.

## 4. Add a lorebook

Lorebook entries are given to the model only when they are mentioned. Each entry has a set of trigger words. When one of these words appears during play, that entry's content goes into the prompt. Create `~/.covel/worlds/tidelamp/data/lorebook.yaml`:

```yaml
- id: old-lighthouse
  keys: [灯塔, 旧灯塔]
  content: 旧灯塔高七层，塔门朝向大海而不是镇子。塔身的石头比镇上任何建筑都老。
- id: stone-road
  keys: [石路, 退潮]
  content: 石路由整块的黑石铺成，平时沉在水下两丈。走完全程要一个时辰，潮水回来时没有地方可躲。
```

Put the file at the standard path `data/lorebook.yaml`, and it is imported automatically. You do not need to register it anywhere else.

## 5. Add a preset character

Create `~/.covel/worlds/tidelamp/characters/characters.json`:

```json
[
  {
    "id": "npc-he-sanniang",
    "name": "何三娘",
    "type": "npc",
    "description": "码头客栈的掌柜，五十出头。她记得每一个在大退潮夜离开镇子的人。",
    "fields": { "resolve": 4 }
  }
]
```

`type` must be one of the types listed in `characterSchema.types`. Each key in `fields` must be an attribute defined in `characterSchema.attributes`. Do not write the protagonist here. The player creates the protagonist when the game starts.

> [!IMPORTANT]
> When the same person, place, or item appears in more than one file, the name and the ID must match exactly, and must be written the same way as in `WORLD.md`. The model matches them by name.

## 6. Validate

Run this in the root folder of the Covel repository:

```bash
pnpm validate:world ~/.covel/worlds/tidelamp
```

When it passes, it prints one line:

```text
✓ /Users/you/.covel/worlds/tidelamp/world.yaml
```

The validator checks the manifest fields, the main world text, the plugin IDs, and every record in each data file. When there is an error, it gives the file, the location, and the reason. For example, if you write `category: stat` instead of `category: stats`:

```text
✗ /Users/you/.covel/worlds/tidelamp/world.yaml
  error   world.yaml · characterSchema.attributes.0.category
          Invalid option: expected one of "stats"|"bio"|"abilities"|"equipment"|"social"
```

Fix what it points to, and run it again until it passes.

## 7. Open it in the game

Start Covel (use `pnpm dev` when running from source; if it is already running, restart it once), and open the world selection page. You will see "潮灯镇" (Tidelamp) in the list.

Click "Enter". On the session-prep screen, check that the gameplay pack is "Traditional Story." Then click "Start Game". After you create the protagonist, the first part of the story should begin at the inn on the harbor on the night of the great low tide.

Try these things to confirm that each file is working:

| What you do                                   | What you should see                                                              | Which file it comes from               |
| --------------------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------- |
| Read the opening text                         | The story starts at the harbor inn, with the lighthouse lit                      | `WORLD.md`                             |
| Open the "World" tab on the right             | You can read the setting, but the "暗线" (hidden thread) section does not appear | The `narrator-only` part of `WORLD.md` |
| Ask 何三娘 (He Sanniang) about the lighthouse | Her identity and personality match the setting                                   | `characters/characters.json`           |
| Head toward the stone road                    | The narration mentions the black stones and the one-hour walk                    | `data/lorebook.yaml`                   |

## When it does not work as expected

| Symptom                                                 | Cause and fix                                                                                                                               |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| The world is not in the world list                      | The folder is not in the user worlds folder, or `world.yaml` has an error. Run the validation command to check                              |
| Validation reports `Multiple world packages declare id` | Two folders in the same parent folder use the same `id`. This usually happens when you copy a folder and forget to change the ID            |
| Validation reports `Unrecognized key`                   | You wrote a field that the manifest does not have. Check it against the [world manifest field table](../reference/schema/world-manifest.md) |
| The opening does not match `WORLD.md`                   | The "Opening" section is not specific enough. Add the time, the place, and the protagonist's situation                                      |
| The model reveals the secret too early                  | In the hidden thread, state until when the secret must not be revealed                                                                      |

## Next steps

You now have a world you can play. You can keep going in these directions:

- **Try a different style of play.** Change `presetId` to `dialogue-mode`. Or add `dice-check`, `core-quest`, `inventory`, and `affinity` to `pluginPolicy.requested`, so the world becomes an adventure with checks and quests.
- **Add more preset content.** Run `pnpm describe:authoring` in the repository. It lists every kind of content you can preset in the current version, the path each file goes in, and a valid example.
- **See a finished world.** The repository's `worlds/` folder has four complete worlds. `worlds/emberback` is a reference that uses checks, quests, inventory, and affinity.
- **Add pictures.** See [world portraits](./portraits.md) and [world scenes](./scenes.md).

For all the content you can preset and the import rules, see the [world data reference](../reference/world-data.md).
