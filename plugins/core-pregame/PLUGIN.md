---
name: core-pregame
description: 游戏初始化插件。仅在 session 首轮触发，初始化世界状态、设置 phase、欢迎玩家。纯函数执行，不调用 LLM。
pluginType: core-plugin
priority: 10
runtimeType: function
outputKind: system
handler: ./handler.js
trigger:
  type: scheduled
  interval: 1
  maxTriggerCount: 1
---

# Pre-Game 初始化插件

此插件是 `runtimeType: function` 类型，不调用 LLM，而是直接执行 `handler.js` 中的纯函数。

## 执行时机

Priority 0，属于 Pre-Game 阶段（0-100），仅在 session 第一个 Turn 执行。

## 职责

1. 初始化世界状态（从 world manifest 读取维度信息）
2. 设置 session phase → `playing`（或 `character_creation`，取决于是否有 char-creator 插件）
3. 返回欢迎通知和世界观摘要供后续插件引用

## 输出

```json
{
  "narrativeOutput": "世界观摘要文本...",
  "phase": "character_creation",
  "notifications": [{ "level": "info", "title": "...", "message": "..." }],
  "initialized": true
}
```
