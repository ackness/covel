# World Time

核心插件，维护世界内时间。`world-time/context` 在叙事前发布权威时间；`world-time/advance` 在叙事后依据世界规则与 prompt 提议跨度；`advance-world-time` 工具确定性计算结果，并通过 proposal 与故事一起提交。

- 世界包通过 `world.time-definition@1` 契约提供 `{ id: world, definition }`，导入插件的 `definitions/world`。schema 和类型属于本插件，世界维度不含时间。
- 时间规则面板在首次叙事前展示导入定义：作者的计时说明，加上带标签的摘要（时段与周期，或纪年、月数、每天小时数和星期；起点；流向；每回合默认和最多推进多少基础单位），不罗列原始字段。面板只按定义声明式展示，不往定义里加显示字段。无定义时显示默认历法说明。
- 无文件目录的世界通过 `metadata.contractData` 提供多语言文本时，面板也解析周期、纪年、时段和星期的显示文字；有目录的世界仍使用单语言文件和翻译 overlay。
- 支持不同月长、每日小时数、每小时分钟数、自定义纪年与时段，也支持只有粗粒度阶段的世界。
- 演进规则包括 `forward`、`backward`、`bidirectional`、`random`。随机结果由回合标识确定，重试不会重新抽样；零跨度表示时间暂停。这是有意不用 `ctx.random` 的少数例外：`ctx.random` 按抽取次数给数，同一回合重跑会得到另一个跨度，而这里要求同一回合永远得到同一个跨度。
- 时间状态在 `clock` 数据集的 `plugin_data[world-time/clock/current]`，包含当前定义、整数刻度、结构化日期/阶段和显示文本。初始化仍写整个记录（`set`）；已有时钟以 `inc` 推进刻度，派生字段以 `merge` 写入，保存时按宽松的 `schemas/clock.schema.json` 校验。并发提交会累加刻度，显示字段仍取工具预测的值。初次提交后定义固定在会话中，世界文件编辑或重新导入定义不会重解释旧存档；新会话采用新定义。
- 已提交的当前时间会作为一行出现在状态摘要里（`session.summary@1` 槽位）；尚未记录时不显示。
- 输入 `/time` 查看当前已提交的世界时间。命令直接读取时钟，不调用模型、不触发叙事或推进回合；尚未记录时明确提示，不写入初值。
- 内置两种叙事插件通过 `world-time-context` capability 接收时间；其他叙事插件可声明相同 input binding。面板使用标准插件 UI，不需要框架分支判断插件 ID。
- `world-time/advance` 的输出是公开契约 `world-time-evolution@1`（本轮结算后的时钟）。其他插件的 post-turn runtime 可用可选输入 `select: /summary` 读取显示文本和经过的时间（`unit`、`elapsedSinceStart`、`elapsedThisTurn`），例如维护倒计时的维度。
- 每个成功叙事回合通常增加一次 `plugin` 模型调用。参数错误可在默认 20 步预算内修正。模型失败保留原时间并报告 runtime 失败，不伪造一次成功结算。
- 递归叙事不独立结算，外层叙事拥有结算权。脱离本轮叙事的手动工具调用会拒绝；叙事失败或事务回滚不会推进时间。
- 未定义时使用 12 个 30 天月份、24 小时制的通用世界历，起点为第 1 年第 1 月第 1 日 08:00；这不是公历换算。

完整字段和倒流/随机示例见 [世界时间契约](../../docs/reference/world-time.md)。

验证：`pnpm --filter @covel/plugin-world-time test`。
