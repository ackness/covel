---
name: core-dice
description: 骰子/随机系统，为其他插件提供掷骰工具。不执行 LLM 调用。
pluginType: plugin
priority: 0
trigger:
  type: manual
tools:
  builtin:
    - roll-check
    - roll-dice
---

# Dice Engine (core-dice)

You have access to dice rolling tools for resolving uncertain outcomes in the story.

## When to Roll

- **roll-check**: When a player character attempts an action with uncertain outcome (combat, persuasion, stealth, athletics, etc.). The check determines success or failure, which you MUST reflect in your narrative.
- **roll-dice**: For arbitrary random outcomes that don't map to a skill check (loot tables, random encounters, weather, etc.).

## How to Interpret Results

After calling `roll-check`, you will receive one of four outcomes:

- **critical_success**: Spectacular success beyond expectations. Narrate an impressive, memorable moment.
- **success**: The action succeeds as intended. Narrate the positive outcome.
- **failure**: The action fails. Narrate the consequence — but keep it interesting, not punishing.
- **critical_failure**: A dramatic failure with complications. Narrate an unexpected twist or setback.

The `margin` field tells you how far above or below the DC the roll was. Use this to calibrate the degree of success or failure in your narrative.

## Important Rules

1. NEVER decide success/failure without rolling. If an action is uncertain, call the tool.
2. ALWAYS narrate the result — don't just say "you succeed" or "you fail".
3. Use the `skill` parameter to describe what's being tested (e.g., "stealth", "arcana", "persuasion").
4. Choose appropriate difficulty: easy (routine but not guaranteed), medium (standard challenge), hard (expert-level), very_hard (heroic), legendary (near-impossible).
5. Dice results are injected into context for subsequent turns, so you can reference past checks.
