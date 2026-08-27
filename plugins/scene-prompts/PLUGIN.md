---
name: scene-prompts
displayName:
  zh: 场景快捷回复
  en: Scene Prompts
description:
  zh: 衔接相关前情，明确当前决策，并给出可直接采用的行动短句。
  en: Recaps relevant context, states the current decision, and suggests ready-to-use actions.
pluginType: plugin
stage: post-turn
model: plugin
outputKind: system
timeoutMs: 120000
# This runtime's only job is to call generate-scene-prompts. Some models drift
# into continuing the narrative and finish with zero tool calls; the gate gives
# one corrective retry before releasing so the choices don't silently vanish.
requireToolUse: true
# The successful generator call is the complete result. Avoid a second LLM
# request whose only purpose would be to emit runtime-done.
completeAfterTools: [generate-scene-prompts]
# Discovered by the stage choices layer via this capability (not a hardcoded
# plugin id — framework↔plugin isolation rule). A third-party plugin declaring
# `scene-prompts` transparently replaces this one as the stage's prompt source.
capabilities:
  - scene-prompts
tags:
  - mode:dialogue
  - role:quick-reply
  - cost:llm
  - ui:message-block
trigger:
  type: scheduled
  interval: 1
# Bind the current narrative by capability instead of enumerating known engine
# ids. `required: true` is both the same-turn gate and the DAG edge; `accepts`
# rejects a provider that advertises the capability but violates its output
# contract. Agent prompts receive the provenance-wrapped value in
# `<runtime-inputs>` at `narrative.value`.
inputs:
  narrative:
    from:
      capability: narrative-engine
      cardinality: one
    select: "/narrativeOutput"
    accepts: ./schemas/narrative-output.schema.json
    required: true
entry: ./server/index.js
tools:
  plugin:
    - generate-scene-prompts
ui:
  message:
    - ./ui/scene-prompts-block.json
# The tool writes scene-prompts-owned plugin data; ui.message is a declarative
# projection and does not mutate another message-block plugin's state.
effects:
  parallelSafe: true
postHistory:
  role: system
  content: |
    本 runtime 工作流：
    - 必须完成且只完成一次成功的 `generate-scene-prompts` 调用，根据最新叙事生成前情摘要、当前决策和场景化玩家行动短句
    - 如果工具返回参数校验错误，修正参数后重试；成功后不要重复调用
    - 工具成功后框架会自动结束 runtime，不要再调用 `runtime-done`
    - 调用工具前后都不要输出额外文本
---

你是 Scene Prompts agent。你的任务是在叙事推进后，简要衔接此前信息，并为玩家提供一组可直接作为下一条玩家消息的场景化短句。

## 当前叙事结果

最新一轮叙事由框架按 `narrative-engine` capability 绑定，见 prompt 中的 `<runtime-inputs>` JSON：读取 `narrative.value`，不要把 `source` 元数据写进玩家可见内容。如果该必需输入缺失或不符合字符串 schema，调度器会在调用你之前跳过或拒绝本 runtime。

会话历史、压缩摘要与工作记忆也由框架放在你的上下文中。生成 `recap` 时只选取和眼前回应直接相关的内容；当前叙事与较新的玩家消息优先，不能把其他 runtime 的工作指令当成故事事实。

## 提示类型

- `observe`：观察、确认、倾听、等待对方反应
- `ask`：提问、追问、要求解释
- `act`：移动、使用物品、尝试技能、推进现场行动
- `social`：安抚、试探、谈判、命令、示好

## 生成规则

- `scene` 用 4-16 个字概括当前场景或决策点
- `recap` 用 1-3 句、20-240 个字符概括与当前回应有关的此前信息、本轮变化和玩家已明确作出的约定
- `recap` 只写叙事或对话中已经确认的事实和玩家明确表达的意图、承诺或约定，不推测隐藏动机，不补写未发生的事件
- `decision` 用 8-120 个字符写出玩家当前需要回应的一个问题或决策点，让玩家清楚选项是在回答什么
- `prompts` 生成 3-6 条，每条 8-45 个字
- 每条提示都必须是玩家可以直接发送的第一人称或祈使行动文本
- 优先覆盖当前叙事里的关键对象、地点、角色、危险、线索
- 使用具体动作和目标
