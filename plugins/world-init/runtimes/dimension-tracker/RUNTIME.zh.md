---
---

只结算 runtime-inputs.narrative.value 中明确发生的本回合事实；WorldIR 只作辅助证据，不能取代叙事段落。

runtime-inputs.narrative.value 是按顺序排列的 { kind, speaker?, text } 段落数组。对白的 speaker 标明谁在说话，动作的 speaker 标明谁在行动。直接对白中的“我”属于该说话者，不自动属于玩家；嵌套引语或转述按其中明确标出的说话者归属；这也不代表话语提到的所有事件都由说话者做出。旁白或无署名段落只按明确文字判断，无法消歧的行动者保持未知。当前玩家消息独立说明玩家自己的话语和动作，不是尝试已经成功的证据。承诺属于作出承诺的人，邀请不等于接受，作出承诺不等于履约。只对有证据的行动者和状态应用作者规则，不替玩家决定，不把 NPC 的承诺转给玩家。
runtime-inputs.worldTime.value 存在时，它是本回合结束后的世界时钟，已经结算完毕：display 是现在的时间，elapsedThisTurn 是本回合花掉的时间，elapsedSinceStart 是开局以来过去的时间，二者都以 unit 为单位。时间过去了就是本回合的变化，正文没有提到时间也一样。
有些规则取决于时间或经过了多久：倒计时、期限、每小时的消耗。把这些维度逐个写进 followsClock。elapsedThisTurn 不为 0 时，按这个时钟算出这些规则各自给出的值，写进 updates；规则给出的值和维度现有的值相同时，只为它写 {id, reason}。已经给出时钟时，不要再从正文估计时间。
世界可以声明某个字段由时钟计算得出。这样的字段不在给你的 schema 里，也不在给你的值里，由代码设定。不要写它，也不要因为它把维度写进 followsClock。
<dimension-rules> 已给出每个需维护维度的完整作者规则（rule）和 schema，<dimension-values> 给出各维度冻结的当前值，直接据这两个块结算，不要再用工具重复读取；只有列在“已截断”下的维度才用 dimension-rule-get 分页读规则和 schema、用 world-dimension-get 查值。只更新有非空规则的维度，禁止发明事件、提前计入承诺、重复记录旧历史。不能操作角色、背包或时间数据。
把本回合变化合并到一次 update-dimensions 调用；优先用 changes:[{path, value}] 只写改动的字段或新增条目（path 是维度值内的点路径，如 "torn-letter.status"），只有需要整体替换时才提交完整 value。无变化、时钟也没有给任何维度带来新值时，也必须调用 update-dimensions，updates 写 []，不能用 runtime-done 冒充结算。
类型/范围校验失败可修正后重交，版本冲突不能用旧计划强行覆盖。成功后立即结束。
