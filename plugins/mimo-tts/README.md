# @covel/plugin-mimo-tts

把 narrator 输出的剧情通过小米 **MiMo TTS** 朗读出来。每个 turn 自动产出一段音频（可关闭），右侧 Tab 列出全部音轨；剧情消息流里也有「朗读」按钮，仿照「插入图像」的交互。

## 包含什么

- `mimo-tts/auto-narrate` (function · auto · `stage: post-turn` · `needs: capability narrative-engine`)：当前叙事引擎（narrator 或 chat-mode-narrator）成功后自动朗读；同时每回合写入「朗读」按钮的消息层数据（关闭自动朗读也会写，按钮始终可用）。
- `mimo-tts/manual-narrate` (function · manual · `execution: background`)：「朗读」按钮触发，段落文本经按钮 payload 传入（manual 激活不解析 turn inputs，`payload.text` 必需）。
- `lib/wires.js`：MiMo TTS HTTP wire（`api-key` header + OpenAI 风格 `chat/completions` + `audio.format/voice`）；`lib/mimo-tts.js`：track 记录/展示字段辅助。
- 右侧 Tab `ui/audio-tab.json`：playlist 风格 — 每个 turn 一行，header（turn 标号 + AUTO/MANUAL + voice + 字节数）+ 一句文本提示 + 内联 `<audio controls>`。**故意不重复 narrator 全文**（聊天流里已有），用户按 turn 选择播放。
- 消息内按钮 `ui/play-button.json`：跟「插入图像」按钮同一交互层。

## 一次性配置

### 1. 配置 MiMo slot（`~/.covel/llm.toml`）

section 名默认应为 `[covel.mimo-tts]`（与插件 id 一致；插件两个 runtime 默认 `modelPresetId: "mimo-tts"`）：

```toml
[covel.mimo-tts]
provider = "xiaomi"
model    = "mimo-v2.5-tts"   # 或 mimo-v2-tts / mimo-v2.5-tts-voicedesign / mimo-v2.5-tts-voiceclone
baseUrl  = "https://token-plan-cn.xiaomimimo.com/v1"   # 或 https://api.xiaomimimo.com（按你的 key 套餐）
protocol = "openai-chat-v1"   # 必填字段，但本插件自管 wire 不会用到
tag      = "speech"
output   = ["audio"]
```

> **特殊性**：MiMo 用 `api-key: <KEY>` 头部（不是 `Authorization: Bearer`），且文本要塞在 `messages: [{role: 'assistant', content}]`（违反 OpenAI 习惯）。本插件 wire 客户端已固化这两点，框架 slot 解析只用来取 `baseUrl` / `apiKey` / `model`。
> **baseUrl 末尾的 `/v1`** 自动剥离，写或不写都行。

### 2. 写 API key

桌面端：编辑 `~/.covel/keys.env`，按 `{PROVIDER大写}_API_KEY` 约定（`provider = "xiaomi"` → `XIAOMI_API_KEY`）：

```bash
XIAOMI_API_KEY=sk-...
```

Web 端：在前端 Settings → API Keys 录入 `xiaomi`。

> **网络放行**：`token-plan-cn.xiaomimimo.com` / `api.xiaomimimo.com` 都是公网 https 域名，框架 SSRF guard 默认放行所有公网 host（只 block 私网 IP / 云元数据 / 非 https），**不需要任何 env 干预**。

### 3. 启用插件

插件是内置包（`plugins/mimo-tts/`），框架启动时自动发现；在建会话的插件选择里启用即可。

## 用户可调设置（`userSettings`）

| Runtime      | 关键字段           | 说明                                                                                       |
| ------------ | ------------------ | ------------------------------------------------------------------------------------------ |
| auto-narrate | `enabled`          | 关掉就只剩手动朗读                                                                         |
| 共用         | `modelPresetId`    | `slot` 类型（UI 渲染成已配置槽的选择器）；默认 `mimo-tts`，对应 `[covel.mimo-tts]`         |
| 共用         | `model`            | 留空走 slot；填写则 per-call 覆盖（切 voicedesign / voiceclone 用）                        |
| 共用         | `voice`            | 默认 `mimo_default`；voicedesign / voiceclone 用预生成的 id                                |
| 共用         | `format`           | `mp3` (默认，audio/mpeg) / `wav` (audio/wav)。`pcm` / `pcm16` 浏览器无法直接播放，已不暴露 |
| 共用         | `maxChars`         | 单次合成最大字符（避免触发 server 限制）                                                   |
| 共用         | `requestTimeoutMs` | 单次请求超时                                                                               |

> 「共用」= 两个 runtime 都声明、且**必须逐字相同**：存储键是插件级的 `plugin.mimo-tts.<key>`，声明不一致时只有一个生效。`pnpm validate:plugin plugins/mimo-tts` 会挡住漂移。

## 数据布局

- **plugin_data**: namespace=`tracks`，key 形如 `tts-auto-<turnId>` 或 `tts-manual-<turnId>-<rand>`，value 含 `ref` (MediaRef) + `triggeredBy` + `text` + 元数据。
- **plugin_data**: namespace=`message`，key=turnId，value=`{ turnId, text }`——「朗读」按钮的消息层锚点 + payload 来源，auto-narrate 每回合写入。
- **media_assets**: 音频字节由框架管线 `ctx.speech.generate()` 持久化到 MediaStore（promptHash 去重）；ownership 自动绑定到当前 session。
- **runtime output**: `assetGenerations: [{ref, modality:'audio', meta}]` → 框架收集为 `asset.generate` proposal，trace + SSE 链路自然广播。

## 测试

```bash
pnpm --filter @covel/plugin-mimo-tts test   # vitest run，覆盖 wire + 两个 handler
```

测试只 mock `fetch`（wire 层）与 `ctx.speech.generate` / `ctx.gateway.resolveSlot`（handler 层），不需要真实网络/MiMo key。

## 已知限制 & 路线图

| 项目                 | 状态                                                                                                                                                                                                                                          |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 自动播放（autoplay） | **限制**：`AudioPlayer` 组件（catalog 自绘、跟随 app theme）暂无 `autoPlay` prop，且多数浏览器会阻止 silent autoplay。`plugin_data.tracks[*].autoPlay = true` 字段已写好，框架加 prop 后即可点亮。                                            |
| pending 状态可见性   | Tab **故意只展示 done/failed** entry —— 没有"正在生成"占位。pending 通过 logger / SSE trace 暴露。                                                                                                                                            |
| 流式播放             | **未实现**：MiMo `stream: true` 把 format 退化成 `pcm`，浏览器 `<audio>` 不直接吃 PCM；需要在前端做 PCM → Web Audio buffer 的 worker，或后端转 mp3 后再 chunk。先把 wire 的非流式路径跑通，等 framework 补上 streaming media primitive 再切。 |
| 速度控制             | 浏览器原生支持，右键 `<audio>` 元素可调 0.5×/2×。需要按钮形式的话，后续可在 spec 里加自定义 component。                                                                                                                                       |
| 长文本分段           | 暂用 `maxChars` 截断；以后改成滑动窗口分段合成 + 顺序播放。                                                                                                                                                                                   |

## 参考

- 官方 wire 形式参考：[github.com/iChochy/mimo-tts-chat](https://github.com/iChochy/mimo-tts-chat)
- 框架文档：[docs/guide/plugin-authoring.md](https://github.com/your-org/covel/blob/main/docs/guide/plugin-authoring.md) · [docs/reference/media-store.md](https://github.com/your-org/covel/blob/main/docs/reference/media-store.md) · [docs/reference/ui-components.md](https://github.com/your-org/covel/blob/main/docs/reference/ui-components.md)
