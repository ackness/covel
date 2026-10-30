# Starting point buy and dice checks

This page shows you how to turn a world into a tabletop role-playing game. At the start, the player spends points on the protagonist's attributes. During play, risky actions are decided by dice.

It uses the world 潮灯镇 (Tidelamp) from the [first world](../worlds/first-world.md).

## The idea

Each of two jobs is handled by one plugin:

| What you want                           | The plugin that handles it | What you do                                       |
| --------------------------------------- | -------------------------- | ------------------------------------------------- |
| Spend points on attributes at the start | `tabletop-rules`           | Define the attributes, and write a point-buy rule |
| Roll dice for risky actions             | `dice-check`               | Turn it on                                        |

## 1. Define the hero's attributes

An attribute that players can spend points on must meet three conditions: it is a number, it has a lower and an upper limit, and its category is `abilities`.

Open `world.yaml`, and change `characterSchema` to:

```yaml
characterSchema:
  types:
    - npc
  attributes:
    - id: resolve
      name: 胆识
      type: number
      category: abilities
      min: 0
      max: 5
      defaultValue: 1
      description: 面对未知时能不能稳住。
    - id: footing
      name: 脚力
      type: number
      category: abilities
      min: 0
      max: 5
      defaultValue: 1
      description: 在湿滑的礁石和海床上奔跑、攀爬。
    - id: insight
      name: 眼力
      type: number
      category: abilities
      min: 0
      max: 5
      defaultValue: 1
      description: 看出不对劲的细节，听出话里没说的部分。
```

Make the `description` clear about what the attribute covers. The model uses it to decide which attribute an action should use.

## 2. Turn on the two plugins

Add them to `pluginPolicy.plus`:

```yaml
pluginPolicy:
  preset: traditional-story
  plus:
    - tabletop-rules
    - dice-check
```

At this point you can already play. If you do not write a rules file, `tabletop-rules` uses all the attributes that qualify for point buy, and gives 4 extra points.

## 3. Write your own point-buy rules (optional)

To set your own point total and limits, create `data/tabletop-rules.json`:

```json
{
  "id": "creation",
  "budget": 4,
  "attributes": [
    { "id": "resolve", "label": "胆识", "base": 1, "max": 4 },
    { "id": "footing", "label": "脚力", "base": 1, "max": 4 },
    { "id": "insight", "label": "眼力", "base": 1, "max": 4 }
  ]
}
```

| Field    | Meaning                                                                   |
| -------- | ------------------------------------------------------------------------- |
| `id`     | Always write `creation`                                                   |
| `budget` | The total number of points the player can spend. All of them must be used |
| `base`   | The starting value of this attribute                                      |
| `max`    | The most this attribute can be raised to at the start                     |

Each point added costs 1 point of budget.

> [!NOTE]
> The attribute `id`s here must match exactly the ones you defined in step 1, and `base` and `max` must lie inside the `min` and `max` of that attribute. If you get one wrong, the next step identifies the attribute and explains what must be corrected.

## 4. Validate

```bash
pnpm validate:world ~/.covel/worlds/tidelamp
```

## 5. Check in the game

Restart Covel, and start a new session in 潮灯镇.

| When                            | What you should see                                                                   |
| ------------------------------- | ------------------------------------------------------------------------------------- |
| After you create the character  | A point-buy form. Each of the three attributes starts at 1, and 4 points can be spent |
| You submit with points unspent  | The form tells you what is wrong, and you can change it right away                    |
| You take a risky action         | The story shows the check as a calculation, for example `14 + 4 = 18 vs DC 12`        |
| You take an action with no risk | No dice are rolled, and the story just continues                                      |

The dice are rolled **before** the story is written, so the result cannot be changed to suit the wording of the text.

## Two ways to make a check

When both plugins are on, the player has two ways to roll, and both can be used together:

- **Automatic check**: handled by `dice-check`. When the protagonist does something risky, the model decides which attribute to use and how hard it is. Then it reads the dice that were already rolled.
- **Player-started check**: handled by `tabletop-rules`. In the "Attribute checks" panel on the right, the player clicks "Request an attribute check" and chooses the action, the attribute, and the difficulty.

If you want only one of these, turn on only the matching plugin.

## When it does not work as expected

| Symptom                                         | Cause and fix                                                                                                                      |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| The point-buy form does not appear at the start | No attribute qualifies. Check whether they are numbers, whether they have `min` and `max`, and whether the category is `abilities` |
| The point-buy step fails at the start           | An attribute `id` in the rules file does not match the one in `world.yaml`. Run `pnpm validate:world`; it says which one           |
| Dice are never rolled                           | `dice-check` is not turned on, or the action really has no risk                                                                    |
| The check always uses a poor-fit attribute      | The attribute's `description` is too vague. Make it clear which kind of action it covers                                           |

## See a complete example

The [`worlds/lantern-barrow`](../../../worlds/lantern-barrow/world.yaml) in the repository is a complete tabletop world. It has six attributes, point-buy rules, and preset companions and a dungeon.
