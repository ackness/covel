---
name: dice-check/roller
description:
  zh: 每回合预掷三个 d20 组成骰池，连同判定规则注入叙事引擎。
  en: Pre-rolls three d20s each turn and hands the dice pool plus check rules to the narrative engine.
pluginType: plugin
# Narrator-prep layer — the `pre-turn` stage runs before the `narrative` stage,
# so the narrative engine's inject of `checkContext` is populated by the time it runs.
stage: pre-turn
runtimeType: function
handler: ./handler.js
outputKind: system
capabilities: [dice-check, check-context]
tags:
  - role:dice
  - cost:function
trigger:
  type: scheduled
  interval: 1
---

骰子判定预掷器（function runtime）。

每个游戏回合开始前自动运行：

1. 用 `node:crypto` 的 `randomInt` 掷 3 个 d20 —— 骰值在叙事 LLM 看到玩家输入之前就已固定，成败不再是自由心证
2. 输出 `checkContext` 字段（markdown）：本回合骰池（#1..#3 点数）+ 判定规则文本（何时判定、如何加属性修正、DC 分档、大成功/大失败、整回合的判定合并为一次 `check.resolved` 批量回执）
3. 骰池原值同时写入 `plugin_data[rolls]`（key = turnId）作为审计轨——即使叙事没有用骰，掷了什么也可追溯

`checkContext` 由叙事引擎（narrator / chat-mode-narrator）通过 `input.inject` 消费；判定完成后的回执由 `dice-check/recorder` 订阅记录。本 runtime 自身不做任何判定，也不依赖任何上游。
