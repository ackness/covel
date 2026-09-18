# World Time

核心插件，维护世界内时间。`world-time/context` 在叙事前发布权威时间；`world-time/advance` 在叙事后依据世界规则与 prompt 提议跨度；`advance-world-time` 工具确定性计算结果，并通过 proposal 与故事一起提交。

- 世界包在 `dimensions.time` 或 `world:metadata.dimensions` 数据源的 `time` 维度定义时间。
- 支持不同月长、每日小时数、每小时分钟数、自定义纪年与时段，也支持只有粗粒度阶段的世界。
- 演进规则包括 `forward`、`backward`、`bidirectional`、`random`。随机结果由回合标识确定，重试不会重新抽样；零跨度表示时间暂停。
- 时间状态在 `plugin_data[world-time/clock/current]`，包含当前定义、整数刻度、结构化日期/阶段和显示文本。初次提交后定义固定在会话中，世界文件编辑不会重解释旧存档；新会话采用新定义。
- 内置两种叙事插件通过 `world-time-context` capability 接收时间；其他叙事插件可声明相同 input binding。面板使用标准插件 UI，不需要框架分支判断插件 ID。
- 每个成功叙事回合通常增加一次 `plugin` 模型调用。参数错误可在默认 20 步预算内修正。模型失败保留原时间并报告 runtime 失败，不伪造一次成功结算。
- 递归叙事不独立结算，外层叙事拥有结算权。脱离本轮叙事的手动工具调用会拒绝；叙事失败或事务回滚不会推进时间。
- 未定义时使用 12 个 30 天月份、24 小时制的通用世界历，起点为第 1 年第 1 月第 1 日 08:00；这不是公历换算。

完整字段和倒流/随机示例见 [世界时间契约](../../docs/reference/world-time.md)。

验证：`pnpm --filter @covel/plugin-world-time test`。
