---
name: pregame
description:
  zh: 游戏初始化插件。仅在 session 首轮触发，读取世界信息、欢迎玩家、上报 preGameDone。纯函数执行，不调用 LLM。
  en: Game initialization plugin. Fires only on the first turn of a session — reads world metadata, greets the player, and reports preGameDone. Pure function runtime, never calls the LLM.
pluginType: core-plugin
priority: 10
runtimeType: function
outputKind: system
handler: ./handler.js
tags:
  - role:pre-game
  - cost:function
trigger:
  type: scheduled
  interval: 1
  maxTriggerCount: 1
relations: {}
---

# Pre-Game 初始化插件

此插件是 `runtimeType: function` 类型，不调用 LLM，而是直接执行 `handler.js` 中的纯函数。

## 执行时机

Priority 10，属于 Pre-Game band (0-99)，仅在 session 首轮（turnCount=0）执行。maxTriggerCount: 1 保证一次性运行。完成后内核把该 runtime 加入 session.preGameCompleted。

## 职责

1. 读取世界信息构建欢迎通知
2. 返回 narrativeOutput 给后续插件作为上下文
3. 报告 preGameDone: true 以允许内核推进 turnCount 到 1

## 输出

```json
{
  "narrativeOutput": "世界观摘要文本...",
  "notifications": [{ "level": "info", "title": "...", "message": "..." }],
  "initialized": true,
  "preGameDone": true
}
```
