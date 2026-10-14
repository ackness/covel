# 第一个世界

这一页带你手写一个最小的世界包“潮灯镇”，校验它，并在 Covel 里用它开一局。完成后，你会有一个由四个文件组成、可以继续扩充的世界。

全程约二十分钟。不需要写代码。

## 开始之前

- 已经完成[第一局游戏](../start/first-session.md)，知道一局游戏是怎样进行的。
- 已经[从源码运行](../start/run-from-source.md)过一次。校验世界的命令在仓库里。
- 一个文本编辑器。

> [!NOTE]
> 只用桌面版、不想获取源码也可以做世界：照着这一页写出同样的文件，放进 `~/.covel/data/worlds/`，重新打开 Covel 即可。你只是用不了校验命令，写错的地方要到开局时才会发现。

## 你将做出什么

```text
tidelamp/
├── world.yaml
├── WORLD.md
├── data/
│   └── lorebook.yaml
└── characters/
    └── characters.json
```

## 1. 创建文件夹

世界放在用户世界目录里，默认是 `~/.covel/worlds/`。给文件夹起一个和世界 ID 相同的名字：只用小写字母、数字和连字符，并且以字母开头。

```bash
mkdir -p ~/.covel/worlds/tidelamp/data ~/.covel/worlds/tidelamp/characters
```

## 2. 写 `world.yaml`

这个文件说明世界的身份和它想要的玩法。新建 `~/.covel/worlds/tidelamp/world.yaml`：

```yaml
schemaVersion: "1.0"
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

逐段看它说了什么：

| 字段                    | 作用                                                             |
| ----------------------- | ---------------------------------------------------------------- |
| `id`                    | 世界的 ID。同一个目录里不能有两个世界使用相同的 ID               |
| `name`、`summary`       | 世界卡片上显示的名字和简介                                       |
| `defaultLocale`         | 这个世界是用什么语言写的。这里的所有文件都用这一种语言           |
| `pluginPolicy.presetId` | 开局默认的玩法包。`traditional-story` 是内置的传统叙事组合       |
| `characterSchema`       | 这个世界的角色有哪些类型和属性。这里只定义了一个 1 到 5 的“胆识” |

内置的玩法包有四个：`traditional-story`（传统叙事）、`dialogue-mode`（角色对话）、`low-cost`（省 token）、`narrative-only`（只要叙事）。

## 3. 写 `WORLD.md`

这是世界观正文。叙事模型每个回合都会读到它，所以它决定了故事的基调。新建 `~/.covel/worlds/tidelamp/WORLD.md`：

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

两件事值得注意：

- **写清楚开局。** 模型需要知道故事从哪一刻、哪个地点开始。
- **谜底放在 `narrator-only` 标记之间。** 玩家也能在游戏里读到 `WORLD.md`。两行标记之间的内容模型照常读到，玩家看不到。每个标记要独占一行。

> [!TIP]
> 正文写 800 到 1500 字比较合适。它每个回合都会进入提示词，太长既费钱，也会被截断。不需要每回合都出现的细节，放进下一步的资料库。

## 4. 加一份资料库

资料库里的条目只在被提到时才交给模型。每条有一组触发词，游玩中出现这些词时，对应的内容才会进入提示词。新建 `~/.covel/worlds/tidelamp/data/lorebook.yaml`：

```yaml
- id: old-lighthouse
  keys: [灯塔, 旧灯塔]
  content: 旧灯塔高七层，塔门朝向大海而不是镇子。塔身的石头比镇上任何建筑都老。
- id: stone-road
  keys: [石路, 退潮]
  content: 石路由整块的黑石铺成，平时沉在水下两丈。走完全程要一个时辰，潮水回来时没有地方可躲。
```

文件放在 `data/lorebook.yaml` 这个约定的路径上，就会被自动导入，不需要在别处登记。

## 5. 预置一个角色

新建 `~/.covel/worlds/tidelamp/characters/characters.json`：

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

`type` 必须是 `characterSchema.types` 里列出的类型，`fields` 里的键必须是 `characterSchema.attributes` 里定义的属性。主角不写在这里：主角由玩家在开局时创建。

> [!IMPORTANT]
> 同一个人物、地点或物品在不同文件里出现时，名字和 ID 要完全一致，并且和 `WORLD.md` 里的写法相同。模型按名字把它们对应起来。

## 6. 校验

在 Covel 仓库的根目录运行：

```bash
pnpm validate:world ~/.covel/worlds/tidelamp
```

通过时输出一行：

```text
✓ /Users/you/.covel/worlds/tidelamp/world.yaml
```

校验器检查清单字段、世界观正文、插件 ID 和每个数据文件里的每条记录。有错误时，它给出文件、位置和原因。例如把 `category: stats` 误写成 `category: stat`：

```text
✗ /Users/you/.covel/worlds/tidelamp/world.yaml
  error   world.yaml · characterSchema.attributes.0.category
          Invalid option: expected one of "stats"|"bio"|"abilities"|"equipment"|"social"
```

按提示改完再运行，直到通过。

## 7. 在游戏里打开它

启动 Covel（源码运行用 `pnpm dev`；已经在运行的话重启一次），打开世界选择页。你会在列表里看到“潮灯镇”。

点“进入”，在准备页确认玩法包是“传统故事模式”，然后“开始游戏”。创建主角之后，第一段故事应该从大退潮之夜的码头客栈讲起。

试着做这几件事，确认每个文件都在起作用：

| 做什么               | 应该看到                         | 来自哪个文件                  |
| -------------------- | -------------------------------- | ----------------------------- |
| 看开场正文           | 故事从码头客栈和亮起的灯塔开始   | `WORLD.md`                    |
| 打开右侧的“世界”页签 | 能读到世界观，但看不到“暗线”一节 | `WORLD.md` 的 `narrator-only` |
| 问何三娘关于灯塔的事 | 她的身份和性格与设定一致         | `characters/characters.json`  |
| 走向石路             | 叙事提到黑石、一个时辰的路程     | `data/lorebook.yaml`          |

## 没有按预期工作时

| 现象                                        | 原因和处理                                                                        |
| ------------------------------------------- | --------------------------------------------------------------------------------- |
| 世界列表里没有它                            | 文件夹不在用户世界目录里，或者 `world.yaml` 有错。运行校验命令查看                |
| 校验报 `Multiple world packages declare id` | 同一个目录里有两个文件夹使用了相同的 `id`，通常是复制文件夹后忘了改               |
| 校验报 `Unrecognized key`                   | 写了清单里没有的字段，对照[世界清单字段表](../reference/schema/world-manifest.md) |
| 开场和 `WORLD.md` 对不上                    | “开局”一节写得不够具体，补上时间、地点和主角的处境                                |
| 模型过早说破了谜底                          | 在暗线里写明什么时候之前不要说破                                                  |

## 接下来

你已经有了一个可以玩的世界。可以沿着这些方向继续：

- **换一种玩法。** 把 `presetId` 换成 `dialogue-mode`，或者在 `pluginPolicy.requested` 里加上 `dice-check`、`core-quest`、`inventory`、`affinity`，让它变成一场带判定和任务的冒险。
- **预置更多内容。** 在仓库里运行 `pnpm describe:authoring`，它列出当前版本能预置的每一种内容、文件该放的路径和一份合法的示例。
- **看成品。** 仓库的 `worlds/` 目录里有四个完整的世界，`worlds/emberback` 是带判定、任务、行囊和好感的参考。
- **加上画面。** 见[世界立绘](./portraits.md)和[世界场景](./scenes.md)。

全部可预置的内容和导入规则见[世界数据参考](../reference/world-data.md)。
