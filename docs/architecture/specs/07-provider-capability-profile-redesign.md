# 07. Provider、Capability 与 Profile 重构说明

更新时间：

- `2026-03-25`

## 1. 背景

当前仓库已经有：

- `modules/model-gateway`
- `ProviderRegistry`
- `ModelProfileRegistry`
- runtime preset 持久化

但这套实现仍偏向：

- 单一 `session.presetId`
- text/object/stream/embed 为主
- provider fallback 主要围绕文本模型

这不足以支撑下面这些正式需求：

- 小模型用于选项生成、分类、轻量辅助逻辑
- 专门的图片模型用于 `story.image`
- TTS 模型用于故事朗读
- STT 模型用于语音输入
- extension 按任务调用能力，而不是自己选择裸模型

因此 v1 规范已正式收敛为：

1. `Connection Profile`
2. `Task Preset`
3. `Binding Profile`
4. `Capability Gateway`

## 2. 外部方案调研摘要

这次设计不只参考 `LiteLLM`。

主要参考来源：

- `LiteLLM`
  - https://docs.litellm.ai/
- `Portkey`
  - https://portkey.ai/docs/introduction/feature-overview
- `OpenRouter Presets / Routing`
  - https://openrouter.ai/docs/guides/features/presets
  - https://openrouter.ai/docs/guides/routing/provider-selection
  - https://openrouter.ai/docs/guides/routing/model-fallbacks
- `Helicone Gateway`
  - https://docs.helicone.ai/getting-started/integration-method/gateway-fallbacks/
- `TensorZero`
  - https://www.tensorzero.com/docs/gateway/guides/retries-fallbacks
- `Vercel AI SDK`
  - https://ai-sdk.dev/docs/ai-sdk-core/provider-management
  - https://ai-sdk.dev/docs/reference/ai-sdk-core/provider-registry
  - https://ai-sdk.dev/docs/ai-sdk-core/middleware
- `PydanticAI`
  - https://ai.pydantic.dev/models/overview/
- `SillyTavern Connection Profiles`
  - https://docs.sillytavern.app/usage/core-concepts/connection-profiles/
- `Open WebUI Models`
  - https://docs.openwebui.com/features/ai-knowledge/models/
- `LibreChat Presets / Agents`
  - https://www.librechat.ai/docs/user_guides/presets
  - https://www.librechat.ai/docs/features/agents

调研共识：

- 基础设施层应借鉴 `LiteLLM / Portkey / Helicone / TensorZero`
- 能力接口层应借鉴 `Vercel AI SDK / PydanticAI`
- 产品层 preset / profile 组织应借鉴 `SillyTavern / Open WebUI / LibreChat / OpenRouter`

## 3. 正式设计决策

### 3.1 Capability-first，而不是 chat-first

`covel` 的 provider kernel 不再以“聊天模型接口”为中心。

对业务层暴露的正式能力至少包括：

- `generateText`
- `generateObject`
- `streamText`
- `embed`
- `generateImage`
- `synthesizeSpeech`
- `transcribeAudio`

规则：

- image / speech / transcription 一旦实现，必须走同一 provider kernel
- 不允许某个 extension 直接在业务层调用外部图片、TTS、STT SDK

### 3.2 三层 Profile 结构

#### Connection Profile

只负责连接与路由。

典型内容：

- provider
- protocol
- baseUrl
- auth strategy
- default headers
- provider routing options
- privacy / BYOK metadata

#### Task Preset

只负责“某类任务如何调用某项能力”。

典型内容：

- capability
- connectionProfileId
- model
- default params
- system prompt
- output mode
- fallbackPresetIds

#### Binding Profile

只负责把任务映射到 preset。

典型内容：

```json
{
  "story.narration": "story-narration",
  "story.choice-generation": "choice-generator-fast",
  "story.image": "scene-illustration",
  "story.tts": "story-tts"
}
```

### 3.3 Extension 只声明任务，不直接选模型

extension 的职责是声明：

- 我要做什么任务
- 我要哪类 capability

extension 不负责：

- provider 选择
- model 选择
- fallback 条件
- routing policy

例子：

- `story.narration`
- `story.choice-generation`
- `story.image`
- `story.tts`
- `memory.summary`
- `npc.dialogue.fast`

## 4. Fallback 的正式归属

fallback 不应被实现成：

- 某个 extension 内部的 if / else
- 某个固定写死的 OpenRouter free 模型
- 某个 session 上的单一 preset hack

正式归属应分两层：

1. `TaskPreset.fallbackPresetIds`
2. 某个 `ConnectionProfile` 内部的 provider routing / model routing

这意味着：

- “回退到 OpenRouter free”只是某个 preset 的配置
- 不是系统写死逻辑

## 5. World / Session 绑定粒度

不再推荐只保存一个 `session.presetId`。

更合理的正式目标是：

- `world.taskBindings`
- `session.taskBindings`

至少应覆盖：

- `story.narration`
- `story.choice-generation`
- `story.image`
- `story.tts`

更通用时直接使用：

- `taskBindings: Record<string, string>`

## 6. 对当前实现的影响

当前实现中这些方向应视为“过渡态”：

- 单一 runtime preset
- 单一 `session.presetId`
- 以 text/object/stream 为主的 provider kernel

它们可以作为过渡实现继续存在，但不应继续向深处扩展，避免后续整体返工。

优先迁移方向应为：

1. 先把 `session.presetId` 收敛成 `session.taskBindings`
2. 再把 preset 从“模型元数据”提升成 `TaskPreset`
3. 再引入 `ConnectionProfile`
4. 最后把 image / speech / transcription 纳入统一 provider kernel

## 7. 实施顺序建议

建议顺序：

1. 先修改架构文档与数据结构定义
2. 再改 storage schema
3. 再改 runtime host 与 web host 的编辑入口
4. 再改 `modules/model-gateway` 的 capability interface
5. 最后补 extension task routing

## 8. 当前约束

在正式进入实现前，下面这些约束已固定：

- 不把 `LiteLLM`、`OpenRouter DSL`、`AI SDK` 的某一套 API 直接当作内部主抽象
- `modules/model-gateway` 继续是唯一模型出口
- 业务层与 extension 不得直连 provider SDK / HTTP
- profile / preset / binding 必须可持久化、可编辑、可测试
- 原始 provider secret 不得出现在业务可见 metadata 响应中
