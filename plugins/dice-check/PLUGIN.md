---
name: dice-check
displayName:
  zh: 骰子判定
  en: Dice Check
description:
  zh: 为有失败风险的行动提供骰子判定：预掷骰池、规则化成败、可视化回执。
  en: Dice checks for risky actions — pre-rolled dice pools, rule-based outcomes, and visible receipts.
pluginType: plugin
---

Dice Check turns "does my lockpicking succeed?" from narrative-LLM freestyle into an auditable roll: a pre-turn runtime rolls the turn's d20 pool and injects it (with the check rules) into the narrative engine, which resolves risky actions against it and emits `check.resolved` receipts. This root `PLUGIN.md` is metadata only — see `runtimes/roller/PLUGIN.md` (the pre-roll injector) and `runtimes/recorder/PLUGIN.md` (the receipt recorder + UI) for the executable runtimes.
