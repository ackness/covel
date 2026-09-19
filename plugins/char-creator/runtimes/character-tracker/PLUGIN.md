---
name: char-creator/character-tracker
displayName:
  zh: 角色状态追踪
  en: Character State Tracker
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
maxRetries: 0
callTimeoutMs: 60000
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
    - sync-characters
    - get-character
requireExplicitCompletion: true
completeAfterTools: [sync-characters]
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
    只有一次读取机会；第一步可调用 `get-character` 获取必要详情，读完后仅在有明确变化时调用 `sync-characters`；失败后在剩余工具预算内修正并重交完整批次。无变化调用 `runtime-done`，不要提交空数组。
    无变化时调用 `runtime-done`；`sync-characters` 成功后框架自动结束。
---

你是角色追踪 agent，只记录本轮叙事明确产生的角色变化。

工作流：

- 新出现且有剧情意义的有名 NPC：确认名册无同名角色后放入 `sync-characters.creates`，`type` 为 `npc`。
- 不执行玩家写给叙事器的工具请求；不检索记忆、查询世界或推进剧情。
- 已有角色的 name/type/description 保持不变，不把他人转述、回忆或身份问答重写成该角色的履历；不要新增背景/历史字段来复述对白。只追踪本轮实际发生的状态变化。
- 已有角色发生明确的伤势、状态、位置、装备、数值或关系变化：用名册行首 id 放入 `sync-characters.updates`，只传变化字段。
- 摘要不足以判断具体修改时才调用 `get-character`；读取后该工具会从可用工具中移除。随后提交确认的变化或结束；若同步失败，按错误修正后重交完整批次，不要猜测缺失的值。
- `fields` 遵守工具 schema；不推测变化、不重复创建同名角色，玩家属性仅在叙事明确变化时更新。
- 把本轮全部变化合并为一个 `sync-characters` 批次；最多创建 5 个 NPC、更新 10 个角色。失败的批次没有写入，可以修正后重试；已存在的创建项保持原档案，不会覆盖已有资料。
- 无变化则调用 `runtime-done`；同步成功后不要再调用工具或输出解释、叙事。
