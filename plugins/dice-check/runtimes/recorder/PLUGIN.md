---
name: dice-check/recorder
description:
  zh: 记录叙事发回的骰子判定回执，沉淀审计轨并驱动消息区的判定结果块。
  en: Records dice-check receipts emitted by the narrative, keeping an audit log and powering the in-message result block.
pluginType: plugin
runtimeType: function
handler: ./handler.js
outputKind: system
tags:
  - role:check-log
  - cost:function
  - ui:message-block
  - ui:right-panel
trigger:
  type: event
  topic: check.resolved
events:
  - topic: check.resolved
    schema: ./schemas/check-resolved.event.json
    description:
      zh: "发射条件：本回合完成过至少一次骰子判定时必须发射，且整回合只发一次——把所有判定装进 checks 数组（先判定完、再一次性发射）。每项：action 填行动简述；roll 填消耗的预掷骰原值；modifier 填属性修正；total = roll + modifier；dc/difficulty 填难度；outcome 按 total vs DC 判定，天然 20 为 critical-success、天然 1 为 critical-failure。无风险行动不判定也不发射。"
      en: "Emission condition: MUST emit when at least one dice check was resolved this turn, and only ONCE per turn — put every resolved check into the checks array (resolve all first, then emit once). Per item: action = short description of the attempt; roll = the consumed pre-rolled d20 value; modifier = the attribute modifier; total = roll + modifier; dc/difficulty = the difficulty; outcome follows total vs DC, with natural 20 = critical-success and natural 1 = critical-failure. Risk-free actions never roll or emit."
ui:
  message:
    - ./ui/check-message.json
  right:
    - ./ui/checks-panel.json
---

骰子判定回执记录器（function runtime）。

订阅 `check.resolved` 事件（由叙事引擎按 `dice-check/roller` 注入的规则经 emit-event 发射）：

1. 容错读取事件 payload——`checks` 数组逐项校验，缺必填字段（action / roll / total / outcome）或类型不对的项跳过，全部无效才整体 skip，不让一条坏回执拖垮回合
2. 每条判定记录写入 `plugin_data[checks]`（key = `<turnId>-<序号>`），含展示字段（结果标签/配色/骰式文本），倒序面板直接消费
3. 本回合判定数组写入 `plugin_data[message]`（key = turnId，值带 `__turnId` 绑定到本回合消息），消息区判定结果块直接消费

> payload 为何是批量：`emit-event` 对同一 topic 每回合去重，逐次发射时第二次会被丢弃；因此契约要求叙事引擎把整回合的判定合并进一个 `checks` 数组一次发完。

Note: `events[].schema` paths resolve relative to the **plugin root** (`plugins/dice-check/`), not this runtime's directory; only `handler` and `ui.*` paths resolve relative to this runtime's own directory.
