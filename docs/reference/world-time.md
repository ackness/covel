# 世界时间

世界时间是故事里的时间：现在是哪一天、几点，或者处在哪个时段。这一页说明世界作者怎样定义自己的历法和时间流动方式，以及插件怎样读取时钟。

世界作者看 Definition 一节。写插件的人再看 Runtime and state 一节。

世界时间和另外两种“时间”互不相干：

- **玩家回合数**：框架用来计数的回合。故事时间倒流，回合数不会倒退，记忆检索和审计仍然按回合的先后顺序。
- **真实时间**：现实世界的时间戳。

## Definition

世界包用一个文件声明时间。把它放在 `data/time.yaml`，就会被自动读取。

```yaml
id: world
definition:
  kind: calendar
  name: 学园时间
  calendar:
    era: 学园历
    months:
      - { name: 春月, days: 30 }
      - { name: 夏月, days: 31 }
    hoursPerDay: 24
    minutesPerHour: 60
    periods:
      - { startHour: 0, name: 深夜 }
      - { startHour: 6, name: 早晨 }
      - { startHour: 12, name: 午后 }
      - { startHour: 18, name: 晚间 }
  initial: { year: 1, month: 1, day: 8, hour: 8, minute: 20 }
  evolution:
    mode: forward
    defaultStep: 5
    maxStep: 1440
    prompt: 对话通常几分钟，睡眠或明确的次日转场应跨日。回忆不改变当前日期。
```

文件的内容是 `{ id: world, definition: ... }`：`id` 固定写 `world`，`definition` 是时间的定义。

文件放在别的路径时，在 descriptor（`data/world.data.yaml`）里加一个 source：

```yaml
sources:
  timeDefinition:
    kind: yaml
    path: data/calendar.yaml
    schema: contract:world.time-definition@1
    to: contract:world.time-definition@1
    key: id
```

> [!NOTE]
> 时间不是世界维度。把 `time` 写进 `dimensions` 不被接受；请改成上面的数据文件。改了之后，原来的开发世界需要重新创建。

### 两种时间模型

`kind` 选一种：

- `calendar`：有年月日和钟点的历法。
- `phases`：只有按顺序循环的几个时段，没有精确的钟点。

| 字段     | `calendar`                                                                | `phases`                                               |
| -------- | ------------------------------------------------------------------------- | ------------------------------------------------------ |
| `name`   | 时间名称，支持 i18n                                                       | 同左                                                   |
| 定义     | `calendar.era`；`months: [{name, days}]`；`hoursPerDay`；`minutesPerHour` | `phases`：按顺序排列的时段名称；`cycleLabel`：周期名称 |
| 可选时段 | `calendar.periods: [{name, startHour}]`，起点严格递增                     | 无精确钟点，不需要另外定义                             |
| 初值     | `initial: {year, month, day, hour, minute}`；月份和日期从 1 开始          | `initial: {cycle, phase}`；phase 从 0 开始             |
| 基础单位 | 该历法的一分钟                                                            | 一个时段                                               |
| 工具单位 | `minute`、`hour`、`day`                                                   | `phase`、`cycle`                                       |

“基础单位”是这个时钟最小的一格。下面 `evolution` 里的步长都用它来数。

补充：

- **星期**：`calendar.weekdays` 可以定义一周里每天的名字，名字和天数都随意。同时用 `initial.weekday`（从 0 开始）说明开局是星期几。往前和往后跨日时，星期都会跟着算，不依赖现实的公历。
- 各个月可以有不同的天数。年、日和钟点都用整数换算，时间倒流跨年也没问题。
- 这里没有现实世界的闰年、时区和天文换算。
- 十二时辰这类粗粒度的历法，可以直接写十二个 `phases`，不必假装成分钟。

### 时间怎样流动（`evolution`）

| 字段          | 说明                                                                                                                 |
| ------------- | -------------------------------------------------------------------------------------------------------------------- |
| `mode`        | 必须明确写出。`forward`（向前）、`backward`（倒流）、`bidirectional`（按叙事决定方向）、`random`（在范围内随机跳转） |
| `defaultStep` | 正文没有明确说明花了多久时，建议走多少个基础单位。可以是 0                                                           |
| `maxStep`     | 每回合最多移动多少个基础单位（不分方向）。这是工具强制检查的上限                                                     |
| `prompt`      | 作者给模型的计时说明，可以翻译。例如对话、睡眠、旅行各算多久，回忆会不会影响当前时间                                 |
| `randomRange` | `{min, max}`，`random` 模式必填。带正负号的闭区间，单位是基础单位，绝对值不能超过 `maxStep`                          |

`random` 模式下，插件通过 `ctx.random` 抽取步长，模型不生成随机数。固定 `COVEL_RANDOM_SEED` 后，同一脚本的取数序列可以重现，与会话和回合 ID 无关。同一回合重复调用工具会复用已缓冲或保存的结果，不再抽取。

粗粒度倒流的例子：

```yaml
id: world
definition:
  kind: phases
  name: 梦境时间
  cycleLabel: 梦回
  phases: [黎明, 白昼, 黄昏, 深夜]
  initial: { cycle: 3, phase: 2 }
  evolution:
    mode: backward
    defaultStep: 1
    maxStep: 4
    prompt: 每轮向更早的梦境阶段移动；同一瞬间的连续对话可保持时间不变。
```

把 `evolution` 换成下面这样，时间就会随机向前或向后跳：

```yaml
evolution:
  mode: random
  defaultStep: 1
  maxStep: 4
  randomRange: { min: -4, max: 4 }
  prompt: 时间可能前进、停滞或倒流；人物保留经历，环境遵循新的阶段。
```

### 没有声明时间的世界

没有 `data/time.yaml` 的世界使用一个通用的世界历：

- 12 个月，每月 30 天；每天 24 小时，每小时 60 分钟。
- 从 1 年 1 月 1 日 08:00 开始。
- 默认每回合前进 10 分钟。

它不是公历。

### 可以参考的内置世界

| 世界                    | 模型       | 看点                         |
| ----------------------- | ---------- | ---------------------------- |
| `worlds/haruka-academy` | `calendar` | 十二个月、星期、一天四个时段 |
| `worlds/emberback`      | `calendar` | 配合倒计时维度               |
| `worlds/mistport`       | `phases`   | 用潮汐做时段                 |
| `worlds/lantern-barrow` | `phases`   | 地城探索的时段               |

### 给插件作者和工具开发者

- 时间定义是一份公开的数据契约 `world.time-definition@1`。内置的 `world-time` 插件拥有定义的 schema、历法和推进逻辑。框架只负责通用的部分：导入数据、安排运行顺序、传递输入和事务。
- 别的插件可以用同一个契约接收世界数据，不需要沿用 `world-time` 的插件 ID 或 namespace。
- 导入后，定义写进接收插件的 `definitions/world`。
- JSON Schema 在 `plugins/world-time/schemas/time-definition.schema.json`，由同目录的 `schema.js` 生成。
- 字段的结构在导入时校验。跨字段的历法约束（例如 `defaultStep` 不能超过 `maxStep`）由插件在使用定义时校验。
- AI 生成世界时，生成器自己不带时间的 schema，使用调用方提供的公开数据 schema。它在 `WORLD_PACKAGE_YAML.contractData` 里产生 `{ contract, key, value }`，其中 `key` 与 `value.id` 一致。保存成文件时写成数据文件；只存数据库或只返回结果时保存在 `metadata.contractData`。浏览器同步之后仍然走同样的导入校验，由同样的规则找到接收的插件。

## Runtime and state

内置的 `world-time` 是核心插件，有两个 runtime：

1. **`world-time/context`**（回合开始时运行，不调用模型）：读取这局游戏的时钟；还没有时钟时读世界定义的初值。它把结果发布为契约 `world-time-context@1`。初值和按语言显示的文本通过 proposal 保存。
   - 导入了定义的世界，第一次叙事之前面板就显示规则。
   - 没有导入定义时，面板显示默认历法的说明。
2. **`world-time/advance`**（叙事之后运行，调用模型）：读取本回合成功的叙事和时间起点，然后调用工具 `advance-world-time`。
   - 模型只提议“走多久、往哪个方向”。历法运算和规则检查由插件完成。
   - 单位取自 `currentTime.value.units`。
   - 时长为 0 时任何单位都接受，因为零时长和单位无关。
   - 时长不为 0 却用了这个时钟没有的单位，会被拒绝，错误信息列出可用的单位。
   - 工具成功就结束。默认的 20 步工具预算、超时和循环检测仍然有效。

### 本回合结束时的时钟

`world-time/advance` 的输出是公开契约 `world-time-evolution@1`：本回合结算**之后**的时钟。它和上面的 `world-time-context@1` 是同一个时钟的两个时刻：

| 契约                     | 时刻         |
| ------------------------ | ------------ |
| `world-time-context@1`   | 本回合的起点 |
| `world-time-evolution@1` | 本回合的终点 |

输出包含结算后的 `definition`、`tick`、`display`、`lastDelta`、`reason`，以及专门给其他 runtime 读取的 `summary`：

| `summary` 字段      | 含义                                                                 |
| ------------------- | -------------------------------------------------------------------- |
| `display`           | 结算后的时间显示文本，已按会话内容语言解析                           |
| `unit`              | 两个计数使用的基础单位：calendar 为 `minute`，phases 为 `phase`      |
| `elapsedSinceStart` | 当前刻度减去世界定义的 `initial`，即开局以来经过的基础单位数         |
| `elapsedThisTurn`   | 本轮移动的基础单位数（即 `lastDelta`）；时间倒流时两个计数都可为负数 |

需要按“本回合结束时的时间”记账的 runtime（在叙事之后运行），用一个可选输入读取它：

```yaml
io:
  inputs:
    worldTime:
      from: { contract: world-time-evolution@1 }
      select: /summary
      required: false
```

- 不要把 `world-time-evolution@1` 写进根 `PLUGIN.md` 的 `requires`：不写时它是可选的，没有时间插件的会话里这个输入不存在。
- 这个输入同时决定了顺序：读取它的 runtime 排在时间结算之后，所以读到的是本回合的值。
- 用 `scope: committed` 读，或者在回合开始时读 `world-time-context@1`，得到的都是上一回合结束时的值。
- 时间没有结算时，这个输入不存在，读取它的 runtime 照常运行。两种情况会这样：模型调用失败；或者这是一次递归的子叙事，时间由外层结算（这时输出只有 `reason`）。

内置的 `world-init/dimension-tracker` 和 `world-init/dimension-clock` 就是这样读取时钟的。前者让模型按时间结算规则；后者不调用模型，按 `elapsedSinceStart` 计算世界声明为 `x-derive` 的维度字段（倒计时、阶段），见[动态世界维度](./dynamic-dimensions.md#由时钟推导的字段)。

### 叙事怎样读取时间

叙事插件在 `RUNTIME.md` 里这样接入：

```yaml
io:
  inputs:
    worldTime:
      from: { contract: world-time-context@1 }
      required: false
```

`worldTime.value` 是本回合的**起点**，包含：

- `definition`：时间定义；
- `tick`：整数刻度；
- `display`：显示文本；
- `units`：这个时钟可用的时长单位。calendar 是 `minute` / `hour` / `day`，phases 是 `phase` / `cycle`，第一个是基础单位；
- calendar 的年月日时分，或 phases 的 `cycle` / `phase`。

叙事按世界的 `prompt` 写，明确写出花了多久、有没有转场。回合结束后再结算结束时间。旧的记忆和以前的叙事不能覆盖这个起点。`scene` 记忆只描述氛围；当前的日期和时刻由时钟维护。

### 时钟存在哪里

- 时钟保存在插件 `clock` 数据集的 `clock/current` 这一条数据里，和普通的会话数据一样进入快照、存档点和分支。数据集允许 `set`、`merge`、`inc`：初始化写整个记录，已有时钟的刻度以 `inc` 推进，派生显示字段以 `merge` 写入。
- 保存时按 `schemas/clock.schema.json` 校验记录；不符合 schema 的记录以 `dataset-violation` 拒绝，本轮该时间结算单元的其他写入也不保存。并发提交会累加刻度，显示字段仍取工具预测的值。
- 定义在第一次保存时复制进会话。之后编辑世界或重新导入定义，不会重置已有的时钟。读档时也不会因为世界文件变了而重新解释旧的刻度。
- `lastTurnId` 防止同一回合里重复调用工具；`lastDelta` 和 `reason` 记录这一次的变化。
- 所有写入都走 proposal。叙事失败或保存失败时，时间一起回滚。
- 递归的子叙事不单独结算时间。

### `/time` 命令

玩家输入 `/time`，会调用插件声明的命令 `world-time:time`，直接显示当前已保存的时钟。

- 它用会话的语言和存档里的时间定义来显示，不读后来修改过的世界初值。
- 它不调用模型，不生成叙事，不推进玩家回合，也不推进时钟。随机模式下也不会重新抽一次。
- 还没有时钟记录时，返回一条明确的提示。命令本身不会初始化时钟。
- RPC 返回 `{ ok, message, data }`。`data.initialized` 区分“还没有记录”和“已有记录”；已有记录时还包含结构化的时钟和最近一次的变化。
- 命令的发现、参数校验和审计与其他插件命令相同。

### 失败与边界

- 模型没能给出时长时，时钟留在起点，并报告这个 runtime 失败。不会把默认步长当成“从剧情里确认的时长”。重新生成和人工恢复按框架通用的 runtime 恢复方式进行。
- 舞台的 `timeOfDay`（白天 / 夜晚）不会根据世界时间自动切换。潮汐、梦境或倒流的阶段未必能对应到白天和夜晚；展示用的插件需要世界给出明确的对应规则之后，才能使用它。
