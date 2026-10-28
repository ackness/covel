# 给世界预置任务、物品和好感

默认情况下，一局游戏开始时主角两手空空，也没有任务。这一页教你让世界在开局时就带上一个任务、几件随身物品，以及和某个角色的关系。

用的是[第一个世界](../worlds/first-world.md)里做的“潮灯镇”。

## 思路

任务、物品和好感各由一个插件负责。你要做两件事：

1. 在 `world.yaml` 里告诉世界要启用这三个插件。
2. 给每个插件准备一个数据文件，放在它约定的位置。

| 想预置什么 | 负责的插件   | 数据文件             |
| ---------- | ------------ | -------------------- |
| 任务       | `core-quest` | `data/quests.yaml`   |
| 物品       | `inventory`  | `data/items.yaml`    |
| 好感       | `affinity`   | `data/affinity.yaml` |

## 1. 启用插件

打开 `world.yaml`，在 `pluginPolicy` 下面加上 `plus`：

```yaml
pluginPolicy:
  preset: traditional-story
  plus:
    - core-quest
    - inventory
    - affinity
```

`preset` 选的是一组基础插件（一个内置玩法包），`plus` 是在它之上再加的。玩家换玩法包时，`plus` 里的插件保留。

## 2. 写一个开局任务

新建 `data/quests.yaml`：

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

- `status` 可以是 `active`（进行中）、`completed`（已完成）或 `failed`（已失败）。
- `objectives` 是任务的几个小目标。游玩中完成了哪一个，任务插件会自己勾上。
- 只预置主线和少量支线就够了。玩的过程中出现的新任务会被自动记下来。

## 3. 写开局物品

新建 `data/items.yaml`：

```yaml
- id: copper-coins
  name: 铜钱
  quantity: 30
  description: 镇上通用的铜钱。
  tags:
    - 货币
- id: storm-lantern
  name: 防风灯
  quantity: 1
  description: 一盏带罩的油灯，油够烧一夜。
  tags:
    - 工具
  equipped: true
```

- 标签会显示给玩家，用世界的语言写。钱加一个表示货币的标签，这里是 `货币`。
- `equipped: true` 表示主角正拿着或穿着它。
- 列表保持简短。游玩中得到的东西会自动记入行囊。

## 4. 写初始好感

新建 `data/affinity.yaml`：

```yaml
- id: npc-he-sanniang
  name: 何三娘
  score: 10
  notes: 你付了三天的房钱，她对你还算客气，但不谈灯塔。
```

- `score` 是 -100 到 100 的整数，0 是不好不坏。
- `id` 和 `name` 要和 `characters/characters.json` 里这个角色的写法完全一样。之后好感的变化是按名字对上的。

## 5. 校验

```bash
pnpm validate:world ~/.covel/worlds/tidelamp
```

校验会按每个插件的规则检查每一条记录。例如把好感写成了 200：

```text
✗ /Users/you/.covel/worlds/tidelamp/world.yaml
  error   data/affinity.yaml · [0] · source "affinity"
          record [0] (id "npc-he-sanniang") of source "affinity" failed schema validation: data/score must be <= 100
```

## 6. 在游戏里确认

预置的内容只在**新开的一局**里出现。已有的存档不会变。

重启 Covel，用潮灯镇新开一局，然后看右侧面板：

| 看哪里 | 应该看到                           |
| ------ | ---------------------------------- |
| 任务   | “塔里的光”，下面有两个未完成的目标 |
| 行囊   | 30 枚铜钱，和一盏已经装备的防风灯  |
| 好感   | 何三娘，分数是 10                  |

## 没有按预期工作时

| 现象                       | 原因和处理                                                           |
| -------------------------- | -------------------------------------------------------------------- |
| 面板里没有预置的内容       | 你看的是旧存档。新开一局                                             |
| 校验通过了，但某一类没出现 | 那个插件没有启用。检查 `plus` 里有没有它，以及准备页里有没有把它取消 |
| 叙事里的人名和面板对不上   | 几个文件里对同一个人的写法不一样。统一成和 `WORLD.md` 相同的名字     |

> [!NOTE]
> 数据文件写好了，但对应的插件没启用时，校验不会报错，那份数据只是不会被用上。所以第 1 步不能省。

## 还能预置什么

在仓库里运行这条命令，可以看到当前版本能预置的每一种内容、文件该放在哪里，以及一份可以照抄的示例：

```bash
pnpm describe:authoring
```

常用的还有：角色的详细设定、世界规则、记忆、隐藏剧情和时间。完整的规则见[世界数据参考](../reference/world-data.md)。
