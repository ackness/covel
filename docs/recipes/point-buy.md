# 开局配点和掷骰判定

这一页教你把世界变成一场跑团：开局时让玩家给主角分配属性点，游玩中有风险的行动用骰子决定成败。

用的是[第一个世界](../worlds/first-world.md)里做的“潮灯镇”。

## 思路

两件事各由一个插件负责：

| 想要什么           | 负责的插件       | 你要做什么               |
| ------------------ | ---------------- | ------------------------ |
| 开局分配属性点     | `tabletop-rules` | 定义属性，写一份配点规则 |
| 有风险的行动掷骰子 | `dice-check`     | 启用它就行               |

## 1. 定义主角的属性

能分配点数的属性必须满足三个条件：是数字，有上下限，分类是 `abilities`。

打开 `world.yaml`，把 `characterSchema` 改成：

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

`description` 要写清楚这个属性管什么。模型靠它来判断一个行动该用哪个属性。

## 2. 启用两个插件

在 `pluginPolicy.plus` 里加上它们：

```yaml
pluginPolicy:
  preset: traditional-story
  plus:
    - tabletop-rules
    - dice-check
```

做到这里已经可以玩了。不写规则文件时，`tabletop-rules` 会自动把所有符合条件的属性拿来配点，额外给 4 点。

## 3. 写自己的配点规则（可选）

想自己定点数和上限，新建 `data/tabletop-rules.json`：

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

| 字段     | 意思                               |
| -------- | ---------------------------------- |
| `id`     | 固定写 `creation`                  |
| `budget` | 玩家一共能分配多少点。必须全部用完 |
| `base`   | 这个属性的起始值                   |
| `max`    | 这个属性开局最多能加到多少         |

每加 1 点花 1 点预算。

> [!NOTE]
> 这里的属性 `id` 必须和第 1 步里定义的一模一样，`base` 和 `max` 也要落在该属性的 `min` 和 `max` 之内。写错了，下一步的校验会报 `attribute-reference` 错误，并指出是哪一个。

## 4. 校验

```bash
pnpm validate:world ~/.covel/worlds/tidelamp
```

## 5. 在游戏里确认

重启 Covel，用潮灯镇新开一局。

| 什么时候             | 应该看到                                               |
| -------------------- | ------------------------------------------------------ |
| 创建角色之后         | 一张配点表单，三个属性各从 1 开始，一共有 4 点可以分配 |
| 点数没用完就提交     | 表单提示哪里不对，可以直接改                           |
| 做一个有风险的行动   | 正文里出现判定的算式，例如 `14 + 4 = 18 vs DC 12`      |
| 做一个没有风险的行动 | 不掷骰，故事直接往下走                                 |

骰子是在故事动笔**之前**掷好的，所以结果不会因为行文需要而被改掉。

## 两种判定方式

启用了这两个插件之后，玩家有两种掷骰的方式，可以同时存在：

- **自动判定**：`dice-check` 负责。主角做了有风险的事，由模型决定用哪个属性、难度多高，然后读取已经掷好的骰子。
- **主动发起**：`tabletop-rules` 负责。玩家在右侧“属性检定”面板点“发起属性检定”，自己选行动、属性和难度。

只想要其中一种，就只启用对应的那个插件。

## 没有按预期工作时

| 现象                   | 原因和处理                                                                                     |
| ---------------------- | ---------------------------------------------------------------------------------------------- |
| 开局没有出现配点表单   | 没有符合条件的属性。检查它们是不是数字、有没有 `min` 和 `max`、分类是不是 `abilities`          |
| 开局时配点这一步失败   | 规则文件里的属性 `id` 和 `world.yaml` 里的对不上。运行 `pnpm validate:world`，它会指出是哪一个 |
| 从来不掷骰             | `dice-check` 没有启用，或者行动确实没有风险                                                    |
| 判定用的属性总是不合适 | 属性的 `description` 写得太含糊。写清楚它管哪一类行动                                          |

## 看一个完整的例子

仓库里的 [`worlds/lantern-barrow`](../../worlds/lantern-barrow/world.yaml) 是一个完整的跑团世界：六个属性、配点规则、预置的队友和地城。
