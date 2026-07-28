---
name: mimo-tts/manual-narrate
description:
  zh: 点击「朗读」按钮后，为当前段落生成语音。
  en: Generates speech for the current passage when the Read Aloud button is clicked.
pluginType: plugin
runtimeType: function
handler: ./handler.js
outputKind: plugin
capabilities: [tts, narrative-audio, manual-invoke]
# No `inputs` block on purpose: a manual activation resolves no turn input
# bindings (ctx.inputs is always empty for manual targets), so the paragraph
# text arrives exclusively via the Speak button's payload — its $state
# bindings read turnId + text from the message-surface record auto-narrate
# writes each turn.
execution: background
timeoutMs: 120000
trigger:
  type: manual
userSettings:
  - key: modelPresetId
    type: slot
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
    description:
      zh: 推荐使用常见音频格式，方便直接播放。
      en: Common audio formats are recommended so playback works directly.
    options:
      - { value: mp3, label: { zh: MP3, en: MP3 } }
      - { value: wav, label: { zh: WAV, en: WAV } }
  - key: maxChars
    type: number
    default: 1500
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
    default: 90000
    min: 5000
    max: 600000
    label:
      zh: 请求超时(ms)
      en: Request timeout (ms)
    description:
      zh: 单次朗读最多等待多久，避免语音任务一直停住。
      en: Maximum wait for one narration, so an audio task does not stay stuck.
ui:
  message:
    - ./ui/play-button.json
---

manual-narrate 是函数 runtime，不会进入 LLM 提示词。具体逻辑见 ./handler.js。

按钮位置：`ui.message`——朗读按钮锚定在每条剧情消息下方。消息层 spec 依赖
`message` namespace 的 plugin-data 才会渲染：auto-narrate 每回合（即使玩家关闭
自动朗读）都会写入 `{ turnId, text }` 记录，按钮的 `$state` 绑定从中取段落文本
作为 invoke payload。
