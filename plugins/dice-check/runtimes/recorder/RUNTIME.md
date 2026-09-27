---
type: function
description:
  zh: 记录叙事发回的骰子判定回执，沉淀审计轨并驱动消息区的判定结果块。
  en: >-
    Records dice-check receipts emitted by the narrative, keeping an audit log
    and powering the in-message result block.
schedule:
  trigger:
    type: event
    topic: check.resolved
io:
  inputs:
    dicePool:
      from:
        runtime: dice-check/roller
      select: /dice
      required: true
  visibility: system
function:
  handler: ./handler.js
---

骰子判定回执记录器（function runtime）。

订阅 `check.resolved` 事件（由叙事引擎按 `dice-check/roller` 注入的规则经 emit-event 发射）：

1. 防御性读取事件 payload——`checks` 数组逐项按预掷骰顺序校验，缺必填字段（action / roll / modifier / dc / difficulty / total / outcome）、类型不对或计算关系不一致的项跳过，全部无效才整体 skip
2. 每条判定记录写入 `plugin_data[checks]`（key = `<turnId>-<序号>`），含展示字段（结果标签/配色/骰式文本），倒序面板直接消费
3. 本回合判定数组写入 `plugin_data[message]`（key = turnId，值带 `__turnId` 绑定到本回合消息），消息区判定结果块直接消费

> payload 为何是批量：`emit-event` 对同一 topic 每回合去重，逐次发射时第二次会被丢弃；因此契约要求叙事引擎把整回合的判定合并进一个 `checks` 数组一次发完。

Note: `events[].schema` paths resolve relative to the **plugin root** (`plugins/dice-check/`), not this runtime's directory; only `handler` and `ui.*` paths resolve relative to this runtime's own directory.
