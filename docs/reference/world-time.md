# World time

世界内时间是世界定义的领域状态，与框架的玩家回合计数、真实时间戳相互独立。倒流故事时间不会倒退 `completedPlayerTurns`，也不会改变记忆检索和审计的逻辑回合顺序。

## Definition

世界包在 `dimensions.time` 声明时间，也可以在 `dimensionSources.time` 引用单独文件，或使用 `worldData` 中指向 `world:metadata.dimensions` 的数据源。导入、导出和维度校验共用 `worldTimeSchema`。世界作者提供规则和 prompt，插件提供演进逻辑；框架只处理调度、输入绑定和事务。

两种时间模型：

| 字段     | `calendar`                                                                | `phases`                                               |
| -------- | ------------------------------------------------------------------------- | ------------------------------------------------------ |
| `name`   | 时间名称，支持 i18n                                                       | 同左                                                   |
| 定义     | `calendar.era`；`months: [{name, days}]`；`hoursPerDay`；`minutesPerHour` | `phases`：按顺序排列的时段名称；`cycleLabel`：周期名称 |
| 可选时段 | `calendar.periods: [{name, startHour}]`，起点严格递增                     | 无精确钟点，不需要另外定义                             |
| 初值     | `initial: {year, month, day, hour, minute}`；月份和日期从 1 开始          | `initial: {cycle, phase}`；phase 从 0 开始             |
| 基础单位 | 该历法的一分钟                                                            | 一个时段                                               |
| 工具单位 | `minute`、`hour`、`day`                                                   | `phase`、`cycle`                                       |

`calendar.weekdays` 可定义一周的任意名称与长度，同时用 `initial.weekday`（从 0 开始）锚定初始星期；正向与逆向跨日都会确定性更新星期，不依赖现实公历。

月份可以有不同天数；年、日和时钟通过整数运算转换，支持跨年倒流。这里没有现实闰年、时区和天文换算。十二时辰等粗粒度历法可以直接使用十二个 `phases`，无需把它们伪装成分钟。

`evolution` 字段：

- `mode`：`forward`（默认正向策略）、`backward`（倒流）、`bidirectional`（按叙事选择方向）、`random`（在世界范围内随机跳转）。必须显式声明。
- `defaultStep`：无明确耗时证据时建议的基础单位跨度，允许 0。
- `maxStep`：每轮可移动的最大绝对基础单位跨度，是工具强制校验的上限。
- `prompt`：世界作者的演进指导，可使用 i18n 文本。例如对话、睡眠、旅行分别如何计时，回忆是否影响当前世界。
- `randomRange: {min, max}`：random 模式必填，基础单位的有符号闭区间，绝对值不能超过 maxStep。由代码依据回合标识抽样，模型不生成随机数。

粗粒度倒流示例：

```yaml
time:
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

将 evolution 替换为下面的定义即可随机双向跳转：

```yaml
evolution:
  mode: random
  defaultStep: 1
  maxStep: 4
  randomRange: { min: -4, max: 4 }
  prompt: 时间可能前进、停滞或倒流；人物保留经历，环境遵循新的阶段。
```

内置学园世界展示 calendar，雾港展示潮汐 phases。未声明时间的世界使用通用世界历：12 个 30 天月、每天 24 小时、每小时 60 分钟，起点 1 年 1 月 1 日 08:00，默认前进 10 分钟。它不声称是公历。

## Runtime and state

内置 `world-time` 是 core-plugin，包含两个 runtime：

1. `world-time/context`（pre-turn function）读取会话时钟或世界初值，发布 `world-time-context` capability。初值和本地化显示更新通过 proposal 暂存。
2. `world-time/advance`（post-turn agent）通过 required inputs 读取本轮成功叙事和时间起点，调用 `advance-world-time`。模型只提议跨度/方向，插件完成历法运算和策略校验。工具成功即结束；默认 20 步工具预算、超时和循环检测仍有效。

叙事插件接入：

```yaml
inputs:
  worldTime:
    from: { capability: world-time-context, cardinality: one }
    required: false
```

`worldTime.value` 包含 `definition`、整数 `tick`、`display`，以及 calendar 的年月日时分或 phases 的 cycle/phase。它是本轮起点。叙事遵循世界的 prompt，明确耗时/转场；post-turn 阶段再结算结束时间。旧记忆和历史叙事不能覆盖该起点。`scene` 记忆仅描述氛围，当前日期和时刻由结构化时钟维护。

状态存放在插件的 `clock/current` 行，随普通会话数据进入快照、检查点和分支。定义在首次提交时复制到会话，后续世界编辑仅影响新会话；读档不因全局世界文件变化而重解释旧刻度。`lastTurnId` 防止同轮重复工具调用，`lastDelta` 和 `reason` 记录本次变化。所有写入都经过已有 proposal 事务；叙事失败、提案提交失败均回滚时间。递归子叙事不独立结算。

输入 `/time` 调用插件声明的 `world-time:time` 命令，直接展示当前已提交的时钟。它使用会话 locale 格式化存档中的时间定义，不读取后来修改的世界初值，不调用模型、不生成叙事、不推进玩家回合或时钟；随机模式也不会重新抽样。尚无时钟记录时返回明确提示，命令本身不初始化状态。RPC 返回 `{ ok, message, data }`，`data.initialized` 区分未记录与已记录；已记录时还包含结构化时钟和最近演进信息。命令执行遵循已有的插件命令发现、参数校验和审计链路。

模型提取失败会保留起点并报告 runtime 失败；不会把默认步长伪装成从剧情确认的耗时。再次生成和人工恢复仍遵循框架的运行时恢复语义。舞台 `timeOfDay` 的自动替换不属于当前契约：潮汐、梦境或倒流阶段未必能映射为 day/night，展示插件需要明确的世界映射规则后再消费。
