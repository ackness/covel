---
name: mimo-tts/auto-narrate
description:
  zh: 每轮故事结束后自动生成旁白语音。
  en: Automatically narrates each turn's story output as speech.
pluginType: plugin
# Narrator-downstream: runs in the post-turn stage after the narrative engine.
# (Migrated from legacy `priority: 700`.)
stage: post-turn
runtimeType: function
handler: ./handler.js
outputKind: plugin
capabilities: [tts, narrative-audio]
# Engine-agnostic gate: run only when the active narrative engine succeeded,
# discovered by capability so it works under narrator (traditional) AND
# chat-mode-narrator (dialogue). (Migrated from legacy `upstreamRequired: [narrator]`,
# which hardcoded `narrator` and never fired in dialogue mode.)
needs:
  - capability: narrative-engine
# Pull the active engine's narrativeOutput as a provenance-wrapped InputSlot
# (`ctx.inputs.narrative.value`) instead of reading `completedResults` by a
# hardcoded runtime name.
inputs:
  narrative:
    from:
      capability: narrative-engine
      cardinality: one
    select: "/narrativeOutput"
    required: false
execution: sync
timeoutMs: 90000
trigger:
  type: auto
userSettings:
  - key: enabled
    type: toggle
    default: true
    label:
      zh: 自动朗读
      en: Auto narrate
    description:
      zh: 每轮故事结束后自动生成旁白。关闭后可以用「朗读」按钮手动生成。
      en: Creates narration automatically after each story turn. Turn it off to use the Speak button manually.
  - key: modelPresetId
    type: text
    default: mimo-tts
    label:
      zh: 服务配置
      en: Service setup
    description:
      zh: 选择设置里用于朗读的服务配置。默认使用 mimo-tts。
      en: Choose the service setup used for narration. Defaults to mimo-tts.
  - key: voice
    type: text
    default: mimo_default
    label:
      zh: 音色
      en: Voice
    description:
      zh: 选择朗读声音。需要自定义声音时，在服务后台创建后填写对应名称。
      en: Choose the speaking voice. For custom voices, create one in the service console and enter its name here.
  - key: format
    type: select
    default: mp3
    label:
      zh: 音频格式
      en: Audio format
    options:
      - { value: mp3, label: { zh: MP3, en: MP3 } }
      - { value: wav, label: { zh: WAV, en: WAV } }
    description:
      zh: 推荐使用常见音频格式，方便直接播放。
      en: Common audio formats are recommended so playback works directly.
  - key: maxChars
    type: number
    default: 1200
    min: 100
    max: 4000
    label:
      zh: 单次最大字符数
      en: Max chars per request
    description:
      zh: 单次朗读的最长文字。太长的内容会自动截短，避免等待过久。
      en: Maximum text length for one narration. Longer text is shortened to avoid long waits.
  - key: requestTimeoutMs
    type: number
    default: 60000
    min: 5000
    max: 600000
    label:
      zh: 请求超时(ms)
      en: Request timeout (ms)
    description:
      zh: 单次朗读最多等待多久，避免语音任务一直停住。
      en: Maximum wait for one narration, so an audio task does not stay stuck.
ui:
  right:
    - ./ui/audio-tab.json
---

auto-narrate 是函数 runtime，不会进入 LLM 提示词。具体逻辑见 ./handler.js。
