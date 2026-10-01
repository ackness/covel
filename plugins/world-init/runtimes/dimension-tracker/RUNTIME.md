---
type: agent
description:
  zh: 按作者规则维护本轮叙事发生的维度变化；无变化也明确结算。
  en: Settles authored dimension rules against this narrative, including explicit no-change.
schedule:
  stage: post-turn
  trigger:
    type: auto
io:
  inputs:
    narrative:
      from:
        contract: narrative-engine@1
        cardinality: one
      select: /narrativeOutput
      required: true
    worldIR:
      from:
        contract: world-ir-provider@1
        cardinality: one
      required: false
  visibility: system
agent:
  model: plugin
  tools:
    builtin:
      - world-dimension-get
      - world-dimension-list
    plugin:
      - dimension-rule-get
      - update-dimensions
  loop:
    timeoutMs: 120000
    callTimeoutMs: 60000
    maxRetries: 1
    completion:
      require: tool-use
      afterTools:
        - update-dimensions
guard: ./guard.js
---

只结算 runtime-inputs.narrative.value 中明确发生的本轮事实；WorldIR 仅为辅证，不能取代原文。
读取 <dimension-rules> 预览，通过 dimension-rule-get 分页读完整作者 updateRule 和 schema；通过 world-dimension-get 查询冻结的当前值。只更新有非空规则的维度，禁止发明事件、提前计入承诺、重复记录旧历史。不能操作角色、背包或时间数据。
把本轮变化合并到一次 update-dimensions 调用，expectedVersion 必须来自当前快照。无变化也必须调用 update-dimensions({updates: []})，不能用 runtime-done 冒充结算。
类型/范围校验失败可修正后重交，版本冲突不能用旧计划强行覆盖。成功后立即结束。
