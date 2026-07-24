---
name: mimo-tts
displayName:
  zh: 语音朗读
  en: MiMo TTS
description:
  zh-CN: "把故事内容朗读成语音，可自动朗读，也可以手动朗读某一段。"
  en-US: "Reads story text aloud, either automatically or one paragraph at a time."
pluginType: plugin
# Unified entry module: registers the MiMo speech wire via
# covel.registerWires() (the legacy `wires` frontmatter shim is sunsetting).
entry: ./server/index.js
---

# Mimo TTS

包级摘要，仅用于在前端展示包名。运行时 manifest 在 `runtimes/<sub>/PLUGIN.md`：

| Runtime                   | 触发                                                                             | 行为                                                                                                                                                                |
| ------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mimo-tts/auto-narrate`   | `auto`（`stage: post-turn`，叙事引擎之后，`needs: capability narrative-engine`） | 通过 `inputs.narrative` 绑定读取当前叙事引擎本轮 narrativeOutput（narrator 或 chat-mode-narrator），调 MiMo TTS，写入 `tracks` 命名空间。可在 userSettings 里关掉。 |
| `mimo-tts/manual-narrate` | `manual` + `execution: background`                                               | 由右侧/消息内 Button 触发，按需重读最新一段或指定 turnId。                                                                                                          |

UI 入口：右侧 `audio-tab` 列出全部 turn 的音轨（原生 audio 控件支持播放、暂停、拖动时间轴；通过浏览器 overflow 菜单可直接下载；右键可改播放速度）。
