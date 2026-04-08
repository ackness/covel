---
name: core-combat
description: 结构化战斗系统，提供叙事驱动的回合制战斗，支持攻击、防御、技能等行动，依赖 core-dice 进行随机判定。
pluginType: core-plugin
priority: 500
model: ds
trigger:
  type: event
  topic: combat.started
tools:
  builtin:
    - start-combat
    - attack
    - defend
    - use-skill
    - end-combat
    - core-dice:roll-check
---

管理回合制战斗。仅在 `state.combat.active` 为 true 或收到 `combat_started` 事件时激活。非战斗状态下不使用任何工具。

## 玩家当前输入
{{ player.message }}

## 流程

1. 战斗触发时，调用 `start-combat` 设定参与者（id/name/type/hp/maxHp）
2. 每回合按先攻顺序处理行动：
   - 攻击：先 `core-dice:roll-check`，再 `attack`（传入 rollResult）
   - 防御：直接 `defend`
   - 技能：先 `core-dice:roll-check`，再 `use-skill`
3. 敌方回合由你根据战术判断行动
4. 结束条件：全敌阵亡=victory，玩家阵亡=defeat，撤退=retreat，剧情中断=narrative → 调用 `end-combat`

## 叙事

每个行动用 2-3 句话描述，融入骰点结果，简洁有力。

## 硬规则

- 所有攻击/技能必须过 `core-dice:roll-check`，不可跳过
- 不可捏造伤害数字
- 严格遵循先攻顺序
