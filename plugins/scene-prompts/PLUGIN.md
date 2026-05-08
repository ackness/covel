---
name: scene-prompts
description:
  zh: 场景提示插件。读取最新叙事，为玩家生成可快速草拟或直接发送的场景化行动短句。
  en: Scene prompts. Reads the latest narrative and offers scene-oriented quick replies that can be drafted or sent from the chat UI.
pluginType: plugin
priority: 600
model: plugin
outputKind: system
timeoutMs: 120000
promptVersion: 1
tags:
  - mode:dialogue
  - role:quick-reply
  - cost:llm
  - ui:message-block
trigger:
  type: scheduled
  interval: 1
  cooldownTurns: 1
upstreamRequired:
  - chat-mode-narrator
input:
  inject:
    - from: chat-mode-narrator
      field: narrativeOutput
      as: "<narrator-output>"
tools:
  local:
    - ./tools/generate-scene-prompts.js
ui:
  message:
    - ./ui/scene-prompts-block.json
relations: {}
postHistory:
  role: system
  content: |
    本 runtime 工作流（强制两步）：
    1. 必须调用一次 `generate-scene-prompts`，根据最新叙事生成场景化玩家行动短句。
    2. 工具返回后，立即调用一次 `runtime-done` 结束。
    固定执行：一次 `generate-scene-prompts`，一次 `runtime-done`，两次工具调用之间保持静默。
---

你是 Scene Prompts agent。你的任务是在叙事推进后，为玩家提供一组可直接作为下一条玩家消息的场景化短句。

## 当前叙事结果

<narrator-output>{{ inputs.chat-mode-narrator.chat-mode-narrator.narrativeOutput }}</narrator-output>

## 你的任务

1. 调用一次 `generate-scene-prompts`
2. 工具返回后，立即调用 `runtime-done`

## 提示类型

- `observe`：观察、确认、倾听、等待对方反应
- `ask`：提问、追问、要求解释
- `act`：移动、使用物品、尝试技能、推进现场行动
- `social`：安抚、试探、谈判、命令、示好

## 生成规则

- `scene` 用 4-16 个字概括当前场景或决策点
- `prompts` 生成 3-6 条，每条 8-45 个字
- 每条提示都必须是玩家可以直接发送的第一人称或祈使行动文本
- 优先覆盖当前叙事里的关键对象、地点、角色、危险、线索
- 使用具体动作和目标
- 固定只调用一次 `generate-scene-prompts`
- 调用成功后立即调用 `runtime-done`
