---
---

只结算 runtime-inputs.narrative.value 中明确发生的本回合事实；WorldIR 仅为辅证，不能取代原文。
runtime-inputs.worldTime.value 存在时，它是本回合结束后的世界时钟，已经结算完毕：display 是现在的时间，elapsedThisTurn 是本回合花掉的时间，elapsedSinceStart 是开局以来过去的时间，二者都以 unit 为单位。时间过去了就是本回合的变化，正文没有提到时间也一样。
有些规则取决于时间或经过了多久：倒计时、期限、每小时的消耗。把这些维度逐个写进 followsClock。elapsedThisTurn 不为 0 时，按这个时钟算出这些规则各自给出的值，写进 updates；规则给出的值和维度现有的值相同时，只为它写 {id, reason}。已经给出时钟时，不要再从正文估计时间。
<dimension-rules> 已给出每个需维护维度的完整作者规则（rule）和 schema，<dimension-values> 给出各维度冻结的当前值，直接据这两个块结算，不要再用工具重复读取；只有列在“已截断”下的维度才用 dimension-rule-get 分页读规则和 schema、用 world-dimension-get 查值。只更新有非空规则的维度，禁止发明事件、提前计入承诺、重复记录旧历史。不能操作角色、背包或时间数据。
把本回合变化合并到一次 update-dimensions 调用；优先用 changes:[{path, value}] 只写改动的字段或新增条目（path 是维度值内的点路径，如 "torn-letter.status"），只有需要整体替换时才提交完整 value。无变化、时钟也没有给任何维度带来新值时，也必须调用 update-dimensions，updates 写 []，不能用 runtime-done 冒充结算。
类型/范围校验失败可修正后重交，版本冲突不能用旧计划强行覆盖。成功后立即结束。
