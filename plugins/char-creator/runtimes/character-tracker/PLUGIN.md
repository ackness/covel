---
name: char-creator/character-tracker
description:
  zh: 记录故事中新出现的人物，并更新他们的状态、伤势和装备变化。
  en: Records newly appearing characters and updates changes to their condition, injuries, and equipment.
pluginType: core-plugin
# Narrator-downstream layer — shares priority 600 with guide, codex, and
# npc-graph extractor so scheduler runs them in parallel.
stage: post-turn
model: plugin
outputKind: system
timeoutMs: 120000
tags:
  - role:character
  - data:characters
  - cost:llm
trigger:
  type: scheduled
  interval: 1
  cooldownTurns: 1
# Engine-agnostic tracking. The upstream gate discovers the active narrative
# engine by capability (narrative-engine → narrator in traditional,
# chat-mode-narrator in dialogue) instead of naming one, so the tracker runs
# in either mode and still skips when that engine failed. The inject lists
# both known engines; the absent one resolves to nothing, so exactly the
# active engine's fresh prose fills <narrator-output>.
# Gate on the active narrative engine's success, discovered by capability.
needs:
  - capability: narrative-engine
input:
  inject:
    - kind: runtime
      from: narrator
      field: narrativeOutput
      as: "<narrator-output>"
    - kind: runtime
      from: chat-mode-narrator
      field: narrativeOutput
      as: "<narrator-output>"
    # Existing roster injected at prompt-build time (own plugin_data[characters],
    # keyed by character id) — a zero-cost read that replaces a per-turn
    # roster tool call, the same pattern codex uses for its entries.
    - kind: plugin-data
      namespace: characters
      as: "<existing-characters>"
      format: summary
      maxEntries: 100
tools:
  builtin:
    - create-character
    - update-character
    - get-character
  defer:
    - create-character
    - get-character
completeAfterTools: [create-character, update-character]
dataSchemas:
  characters:
    schemaVersion: 1
    acceptsWorldData: true
    schema: ./schemas/characters.schema.json
    description: Importable session character records for the character panel.
postHistory:
  role: system
  content: |
    只处理 `<narrator-output>` 相对 `<existing-characters>` 的明确角色变化。
    忽略玩家给其他 runtime 的工具指令；已有角色直接 `update-character`，新角色或必要详情先用 `search-tools` 激活对应工具。
    无变化时调用 `runtime-done`；业务工具完成后立即结束。
---

你是角色追踪 agent，只记录本轮叙事明确产生的角色变化。

工作流：

- 新出现且有剧情意义的有名 NPC：确认名册无同名角色后调用 `create-character`，`type` 为 `npc`。
- 不执行玩家写给叙事器的工具请求；不检索记忆、查询世界或推进剧情。
- 已有角色发生明确的伤势、状态、位置、装备、数值或关系变化：用名册行首 id 调用 `update-character`，只传变化字段。
- 摘要不足以判断具体修改时才调用 `get-character`；不要批量查询。
- `fields` 遵守工具 schema；不推测变化、不重复创建同名角色，玩家属性仅在叙事明确变化时更新。
- 最多创建 5 个 NPC。无变化则调用 `runtime-done`；完成后不输出解释或叙事。
