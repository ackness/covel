---
---

只结算 runtime-inputs.narrative.value 中明确发生的本回合事实；WorldIR 仅为辅证，不能取代原文。
<dimension-rules> 已给出每个需维护维度的完整作者规则（rule）、schema 和冻结的当前值（value），直接据此结算，不要再用工具重复读取；只有列在 Truncated 下的维度才用 dimension-rule-get 分页读规则和 schema、用 world-dimension-get 查值。只更新有非空规则的维度，禁止发明事件、提前计入承诺、重复记录旧历史。不能操作角色、背包或时间数据。
把本回合变化合并到一次 update-dimensions 调用；优先用 changes:[{path, value}] 只写改动的字段或新增条目（path 是维度值内的点路径，如 "torn-letter.status"），只有需要整体替换时才提交完整 value。无变化也必须调用 update-dimensions({updates: []})，不能用 runtime-done 冒充结算。
类型/范围校验失败可修正后重交，版本冲突不能用旧计划强行覆盖。成功后立即结束。
