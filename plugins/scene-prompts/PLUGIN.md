---
name: scene-prompts
displayName:
  zh: 场景快捷回复
  en: Scene Prompts
description:
  zh: 根据当前场景给出几句可直接采用的行动短句。
  en: Suggests short actions that fit the current scene and can be used right away.
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
# Engine-agnostic guidance. The upstream gate discovers the active narrative
# engine by capability (narrative-engine → chat-mode-narrator in dialogue,
# narrator in traditional) instead of naming one, so the same plugin gates
# correctly in either mode and still skips when that engine failed. The inject
# lists both known engines; the absent one resolves to nothing, so exactly the
# active engine's fresh prose fills <narrator-output>.
# Gate on the active narrative engine's success, discovered by capability.
needs:
  - capability: narrative-engine
input:
  inject:
    - kind: runtime
      from: chat-mode-narrator
      field: narrativeOutput
      as: "<narrator-output>"
    - kind: runtime
      from: narrator
      field: narrativeOutput
      as: "<narrator-output>"
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
    - 必须且只调用一次 `generate-scene-prompts`，根据最新叙事生成场景化玩家行动短句
    - 工具成功后框架会自动结束 runtime，不要再调用 `runtime-done`
    - 调用工具前后都不要输出额外文本
---

你是 Scene Prompts agent。你的任务是在叙事推进后，为玩家提供一组可直接作为下一条玩家消息的场景化短句。

## 当前叙事结果

最新一轮叙事见上方 `<narrator-output>` 区块（由当前模式的叙事引擎注入）。工具调用流程见结尾的强制两步说明。

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
