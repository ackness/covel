# Provider 自管 Wire 指引

什么时候让框架管 wire，什么时候自己管，怎么排查"奇怪 provider"。

## 决策树

```
我的 provider 是什么类型？
│
├─ 文本 chat completions，OpenAI 完全兼容（Authorization: Bearer + 标准 messages）
│   └─ 用 ctx.gateway.generateText({ presetId, messages })，框架管一切
│
├─ 文本但鉴权头不是 Bearer（api-key、x-api-key、自定义 header）
│   └─ 自管 wire：ctx.gateway.resolveSlot(...) 取 baseUrl/apiKey/model，自己 fetch
│
├─ 图像 / 音频 / 视频生成
│   └─ 一定自管 wire（gateway 没有 generateImage / generateAudio）
│
├─ Embedding / 转录（ASR）
│   └─ 一定自管 wire（gateway 不暴露这两类）
│
├─ Async submit + poll（DashScope wan2.x、某些视频 API）
│   └─ 一定自管 wire（框架的 generateText 不会等任务）
│
├─ 流式音频（PCM frames）
│   └─ 自管 wire 但不在第一版做（前端 <audio> 直接喂 PCM 不行；先做非流式）
│
└─ Structured JSON 输出（function 不能 generateObject）
    └─ 用 agent runtime 配 output.schema，**不要**在 function runtime 强求结构化
```

## 自管 wire 标准模板

```js
import { ... } from './your-helpers.js';

export default async function handler(ctx) {
  const { gateway, utils, userSettings, pluginData, logger, media } = ctx;

  // 1. 依赖检查
  if (!gateway?.resolveSlot) return failed('framework too old: needs gateway.resolveSlot');
  if (!utils?.validateBaseUrl) return failed('framework too old: needs utils');

  // 2. 解析 slot
  const presetId = userSettings?.modelPresetId ?? '<plugin-id>';
  const slot = gateway.resolveSlot({ presetId, fallbackTag: 'speech' /* 或 image/embedding/transcription */ });
  if (!slot) {
    return failed(`Slot "${presetId}" not configured. README 让用户在 ~/.covel/llm.toml 加 [covel.${presetId}].`);
  }
  if (!slot.baseUrl || !slot.apiKey) {
    return failed(`Slot "${presetId}" missing baseUrl/apiKey. Set <PROVIDER>_API_KEY in ~/.covel/keys.env.`);
  }

  // 3. SSRF 校验
  const guard = utils.validateBaseUrl(slot.baseUrl);
  if (!guard.ok) return failed(`Invalid baseUrl: ${guard.reason}`);

  // 4. 拼 URL（容错 /v1 后缀）
  const cleanBase = slot.baseUrl.replace(/\/$/, '').replace(/\/v1$/, '');
  const url = `${cleanBase}/v1/chat/completions`;   // 或 provider 文档要求的 path

  // 5. 调用（用 utils.fetchWithRetry，自动 429/5xx 退避）
  const response = await utils.fetchWithRetry(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      // 关键：每个 provider 的鉴权头不一样，下方查表
      'api-key': slot.apiKey,
      // 或：'authorization': `Bearer ${slot.apiKey}`
      // 或：'x-api-key': slot.apiKey
    },
    body: JSON.stringify(buildRequestBody(slot.model, ...)),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    return failed(`HTTP ${response.status} ${response.statusText} — ${text.slice(0, 240)}`);
  }

  // 6. 解析 + 落 MediaStore
  const payload = await response.json();
  const bytes = decodeBytesFrom(payload);
  const ref = await media.put(bytes, sniffedMime, { plugin: '<plugin-id>', turnId: ctx.turnId });

  // 7. 返回（normalizeOutput 走 commit pipeline）
  return {
    status: 'done',
    pluginData: [{ namespace: 'tracks', key: ctx.turnId, value: { ref, ... } }],
    assetGenerations: [{ ref, modality: 'audio', meta: {...} }],
  };
}

function failed(msg) { return { status: 'failed', error: msg }; }
```

## 鉴权头差异表（常见 provider）

| Provider                       | header                                                   | 示例                                 |
| ------------------------------ | -------------------------------------------------------- | ------------------------------------ |
| OpenAI / DeepSeek / 大多数兼容 | `Authorization`                                          | `Bearer sk-...`                      |
| Anthropic                      | `x-api-key` + `anthropic-version`                        | `x-api-key: sk-ant-...`              |
| Xiaomi MiMo                    | `api-key`                                                | `api-key: tp-...`                    |
| DashScope (Aliyun)             | `Authorization` + 异步可能加 `X-DashScope-Async: enable` | —                                    |
| Google / Vertex                | `Authorization` (Bearer 短期 token)                      | OAuth2 流程，复杂                    |
| Azure OpenAI                   | `api-key`                                                | 但 path 含 deployment / version 参数 |

> **永远不要硬编码 apiKey**——一律从 `slot.apiKey` 取。slot 由框架按 user 的 `[covel.<X>].provider` + `keys.env` 解析。

## Body 形态差异表（常见踩雷）

| Provider                | 写法                                           | 注意                               |
| ----------------------- | ---------------------------------------------- | ---------------------------------- |
| OpenAI / 多数兼容       | `messages: [{role:'user', content}]`           | 标准                               |
| Xiaomi MiMo TTS         | `messages: [{role:'assistant', content}]` ⚠️   | 文本要塞在 **assistant** role      |
| Anthropic               | `messages` + 顶级 `system`                     | 不允许 `messages` 里有 system role |
| DashScope wan2.x        | `input.messages: [{content:[{text}]}]`         | 嵌套两层                           |
| Image (DashScope async) | submit 拿 `task_id`，poll `/api/v1/tasks/<id>` | 24h URL 过期，要 ingestUrl 入库    |

## 响应解析差异表

| 内容类型            | 在响应的什么字段                                                                     |
| ------------------- | ------------------------------------------------------------------------------------ |
| 文本（OpenAI 兼容） | `choices[0].message.content`                                                         |
| 文本（Anthropic）   | `content[0].text`                                                                    |
| 流式文本（SSE）     | `data: {...}` chunks，每个 chunk `choices[0].delta.content`                          |
| 音频 base64         | `choices[0].message.audio.data`（OpenAI audio API 风格）                             |
| 图像 url（同步）    | `data[0].url` 或 `images[0].url` 或 `output.results[0].url`                          |
| 图像 base64         | `data[0].b64_json` 或 `images[0].base64`                                             |
| Async 任务 id       | `output.task_id`                                                                     |
| Async 任务结果      | `output.task_status` (`SUCCEEDED`/`FAILED`/`PENDING`/`RUNNING`) + `output.results[]` |

## 排查不熟悉 provider 的标准流程

1. **找官方前端示例**：很多中国厂商有公开的 web demo 或 GitHub repo（直接搜 `<provider> chat web` / `<provider> playground source`）。前端代码里能看到真实的 fetch URL + headers + body shape——比 PDF 文档 + WebFetch 看官网准。
2. **用 curl 复现**：先用 curl + 真实 key 打通最小成功路径，把整个 cmd 贴在 handler 注释里：
   ```
   curl -X POST https://api.example.com/v1/chat/completions \
     -H 'api-key: <KEY>' \
     -H 'content-type: application/json' \
     -d '{"model":"...","messages":[...]}'
   ```
3. **第一次 4xx 一定打全 body**：`text.slice(0, 240)` 喂进 error.message——80% 错误信息直接告诉你字段名错了/缺字段。
4. **保存 reproducible script**：handler 顶部写一段 `// curl 调通的最小命令` 注释，未来任何人接手都能立刻复现。

## 推荐的 lib/ 布局

复杂自管 wire 抽到 `lib/<provider>.js`，handler 只剩"读 slot → 调 lib → 落 MediaStore → 返回"骨架：

```
my-plugin/
├── lib/
│   └── my-provider.js       # synthesize(args) -> { bytes, mime } 纯函数，方便 vitest mock fetch
└── runtimes/
    ├── auto/
    │   ├── PLUGIN.md
    │   └── handler.js       # 调 lib/my-provider.js
    └── manual/
        ├── PLUGIN.md
        └── handler.js       # 调同一个 lib
```

`lib/<provider>.js` 测试只需要 `vi.fn()` mock 全局 `fetch`，不需要 framework runtime——单测又快又稳。

## 失败处理通用范式

1. 先**预占** plugin-data（pending）→ 让前端 SSE 立刻看到"正在生成"
2. **每一段 try/catch** 都要写 `recordFailure` 方法把 status: 'failed' + error 写回**同一个** key，前端就从 pending 切到 failed
3. **error message 必须 actionable**：错在配置就告诉怎么改 llm.toml；错在 key 就告诉 env 变量名；错在 provider 限流就建议 `requestTimeoutMs` 调大

```js
async function recordFailure(ctx, key, message) {
  const value = {
    status: "failed",
    error: message,
    completedAt: new Date().toISOString(),
  };
  await ctx.pluginData.set("tracks", key, value);
  await ctx.logger.error("failed", { key, error: message });
  return {
    status: "failed",
    error: message,
    pluginData: [{ namespace: "tracks", key, value }],
  };
}
```

## 流式响应（参考）

第一版插件**不做流式**。如果未来要做：

- **OpenAI 风格 SSE**：循环 `response.body.getReader()`，按 `data: {...}` 切分；每个 chunk `choices[0].delta.content` 拼到累积 buffer，期间 `ctx.pluginData.set('tracks', turnId, { partial: buffer, status: 'streaming' })` 让前端实时看到字
- **PCM 流式音频**：浏览器 `<audio>` 不能直接吃 PCM frames，需要前端 framework 改进（提供 `<AudioStream>` 组件解码 PCM → Web Audio buffer），或后端先聚合再 mp3 转码。**当前框架不支持**。
- **结构化 JSON 流式**：function runtime 用不上，agent runtime 配 `output.schema` + `responseFormat` 框架已自动处理。
