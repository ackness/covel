# `FunctionHandlerContext` 全字段参考

`function` runtime 的 handler **唯一**入参。本文是 SDK 级合约——插件作者写 handler 不需要看任何框架代码。

> **承诺**：列表内所有字段都已穷举。如发现 framework 暴露新字段而本表没列，是 skill 的 bug，请提 issue。

```ts
export default async function handler(ctx: FunctionHandlerContext) {
  // ctx 的全字段见下方
  return {
    /* normalized output, 见末尾「返回值」一节 */
  };
}
```

## 必有字段（每次调用都存在）

| 字段               | 类型                                    | 用途                                                                                                           |
| ------------------ | --------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `sessionId`        | `string`                                | 当前 session id（写 plugin-data / media 时不用关心，框架已绑定）                                               |
| `turnId`           | `string`                                | 当前 turn id；常用作 plugin-data key                                                                           |
| `pluginId`         | `string`                                | 本 runtime 所属 plugin id（不是 runtime name）                                                                 |
| `playerMessage`    | `string`                                | 玩家本轮的输入                                                                                                 |
| `completedResults` | `ReadonlyMap<string, unknown>`          | runtimeId → 该 runtime 本 turn 的 output。读上游用 `completedResults.get('narrator')?.output?.narrativeOutput` |
| `config`           | `Readonly<Record<string, unknown>>`     | manifest `config:` 字段定义的插件级配置                                                                        |
| `recursiveCall`    | `(delta, opts?) => Promise<TurnResult>` | 递归调一次 nested turn（受 governance 深度限制；插件**几乎用不到**，慎用）                                     |
| `recursionDepth`   | `number`                                | 当前递归深度，顶层 = 0                                                                                         |
| `store`            | `FunctionStoreView \| DataStore`        | **第三方插件**收到 `FunctionStoreView`（仅 4 个只读方法）；`pluginType: core-plugin` 才拿全 `DataStore`        |

## 可选字段（依宿主和触发方式存在）

| 字段            | 何时存在                                      | 内容                                                      |
| --------------- | --------------------------------------------- | --------------------------------------------------------- |
| `locale`        | 客户端传 `locale` 时                          | `'zh-CN' \| 'en-US' \| ...`                               |
| `gateway`       | 生产环境总在；测试 harness 可能为 `undefined` | LLM/图像 gateway facade，见 [§gateway](#ctxgateway)       |
| `utils`         | 生产环境总在                                  | SSRF + retry 工具，见 [§utils](#ctxutils)                 |
| `media`         | 生产环境总在                                  | MediaStore 接口，见 [§media](#ctxmedia)                   |
| `assetProgress` | 媒体生成插件用                                | `(progress) => Promise<void>` 发 `asset.progress` SSE     |
| `manualPayload` | **仅** `trigger.type: manual` 触发时          | 来自 `POST /plugin-rpc` 的 `payload` 字段                 |
| `triggerEvent`  | **仅** `trigger.type: event` 触发时           | `{ topic, data }`，上游 runtime emit 的 event             |
| `userSettings`  | 声明了 `userSettings:` 时                     | manifest 默认值已与玩家覆盖合并；**所有声明键都保证存在** |
| `pluginData`    | 接了 store 时（生产总在）                     | scoped writer，见 [§pluginData](#ctxplugindata)           |
| `logger`        | 接了 store 时（生产总在）                     | 写入插件 `_logs` 命名空间，见 [§logger](#ctxlogger)       |

> **核心原则**：handler 只能用 `ctx` 提供的接口。**禁止** `import` 任何 `@covel/*` 内部模块（上层包的 export 可能变；插件靠 ctx 这个稳定 API 解耦）。

---

## `ctx.gateway`

只暴露 **3 个方法**——`generateText` / `generateObject` / `resolveSlot`。**没有** `generateImage` / `generateAudio` / `embed` / `streamText`。图像 / 音频 / 视频 / embed / streaming 一律走 `resolveSlot` 自管 wire——见 [`provider-quirks.md`](./provider-quirks.md)。

### `gateway.generateText(input)`

```ts
const { text, finishReason, usage } = await ctx.gateway.generateText({
  presetId: "default", // 可选，默认走第一个 slot
  system: "...", // 可选；二选一：system/prompt 或 messages
  prompt: "...",
  // 或：
  messages: [{ role: "user", content: "..." }],
  providerRequestMetadata: {}, // 可选，merge 到 provider 请求 body
  signal: ctx.someSignal, // 可选 AbortSignal
});
```

返回 `{ text: string, finishReason: string, usage: { inputTokens, outputTokens } }`。

### `gateway.generateObject<T>(input)`

⚠️ **生产环境默认 throw**——框架没有给 function runtime 注入 JSON-Schema → Zod 转换器。结构化输出请改用 **agent runtime + `output.schema`**。如果 function 必须用，开 issue 让 framework 注入 converter。

### `gateway.resolveSlot(input)` — 自管 wire 必用

```ts
const slot = ctx.gateway.resolveSlot({
  presetId: "mimo-tts", // 必传：你 README 让用户配的 [covel.<presetId>] 名字
  fallbackTag: "speech", // 可选：'text' | 'image' | 'embedding' | 'speech' | 'transcription'
  // 找不到 presetId 时按 tag 回退到第一个 tag 匹配的 slot
});

if (!slot) {
  return { status: "failed", error: 'Slot "mimo-tts" not configured. ...' };
}

// slot 完整字段（ResolvedSlotForPlugin）：
slot.presetId; // string
slot.provider; // string — 透传 llm.toml 的 provider 字段
slot.protocol; // 'openai-chat-v1' | 'openai-responses-v1' | 'anthropic-messages-v1'
slot.baseUrl; // string | undefined — 自管 wire 时必检
slot.apiKey; // string | undefined — 已按 provider 名从 keys.env / X-Provider-Keys 解析
slot.headers; // Readonly<Record<string,string>> | undefined — provider 自定义头（少见）
slot.model; // string
slot.tag; // string
slot.metadata; // Readonly<Record<string,unknown>> — providerRequestMetadata 等
```

---

## `ctx.utils`

```ts
// SSRF guard（默认开放公网，仅 block RFC1918/link-local/cloud metadata/非 https）
const verdict = ctx.utils.validateBaseUrl('https://api.example.com');
// { ok: true } | { ok: false, reason: 'baseUrl rejected by SSRF policy: ... (private/link-local IP, cloud metadata host, or non-loopback http).' }

// fetch + 指数退避重试 429/5xx，遵守 Retry-After
const response = await ctx.utils.fetchWithRetry('https://api.example.com/...', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ ... }),
  maxRetries: 3,        // 默认 3，传 0 禁用
  signal: someSignal,
});
```

**何时用**：所有自管 wire 的 fetch 一律走 `fetchWithRetry`，user 给的 URL 一律先过 `validateBaseUrl`。直接用裸 `fetch` 不会出错但失去框架统一退避策略。

---

## `ctx.media`

### `MediaRef`

```ts
{
  id: string,        // sha256 hex (64 chars)，内容寻址，重复 put 同字节会 dedupe
  mime: string,      // 'image/png' | 'audio/mpeg' | 'audio/wav' | 'video/mp4' | ...
  size: number,      // 字节数
  url?: string,      // 极少有，通常省略
  meta?: Record<string, unknown>, // put 时传的 meta
}
```

### `media.put(blob, mime, meta?)` — 写入字节

```ts
const ref = await ctx.media.put(bytes, "audio/mpeg", {
  plugin: "mimo-tts",
  turnId: ctx.turnId,
  voice: "mimo_default",
});
// 自动绑定 ownership 给当前 sessionId+pluginId；同字节复 put 会 dedupe（first-writer-wins）
```

### `media.ingestUrl(url, opts?)` — 从短链/外部 URL 摄取

```ts
const ref = await ctx.media.ingestUrl(
  "https://provider.example.com/output/xxx.png",
  {
    allowedMimes: ["image/png", "image/jpeg", "image/webp"], // MIME 白名单（支持 'image/*' 通配）
    maxBytes: 50 * 1024 * 1024, // 默认 50 MiB
    timeoutMs: 30_000, // 默认 30 秒
    meta: { provider: "dashscope", taskId },
    signal: someSignal,
  },
);
// 内部走 utils.fetchWithRetry + SSRF 校验 + 重定向数限制 + content-type sniffing
```

适用场景：DashScope wan2.x 这种 24h 短链——直接 ingest，避免链接过期后画廊空白。

### `media.get(ref)` — 读字节（受 session ownership 限制）

```ts
const blob = await ctx.media.get(ref);
// throws 'media not accessible by this session' 当 ref 不属于当前 session 且没有 ref 行
```

### `media.resolveUrl(ref)` — ⚠️ 别误以为是 fetchable URL

```ts
const url = await ctx.media.resolveUrl(ref); // → 'media:<id>'，**不是** http(s) URL
```

返回的是 **opaque sentinel**——你**不能**塞给 `<img src=...>` 让浏览器请求。前端拿到 MediaRef 后会通过 `resolveMediaSrc` 走 token 化 `/api/media/:id` 端点。插件几乎用不到这个方法。

### 推荐流程：bytes → MediaStore → assetGenerations[] → frontend

```ts
// 1. 拿到 bytes（自管 wire 调 provider）
const bytes = await synthesizeAudio(...);

// 2. 入 MediaStore
const ref = await ctx.media.put(bytes, 'audio/mpeg', { ... });

// 3. 同时 plugin-data 索引 + assetGenerations[] 触发 asset.generate proposal
return {
  pluginData: [{
    namespace: 'tracks',
    key: ctx.turnId,
    value: { ref, status: 'done', ... },   // 注意是 `ref` 而不是裸 url/base64
  }],
  assetGenerations: [{
    ref,
    modality: 'audio',          // 'image' | 'audio' | 'video' | 'file'
    meta: { plugin: 'X', ... },
  }],
};

// 4. UI spec 用 <Media as="audio" ref={...} /> 直接渲染（见 ui-components-quickref.md）
```

---

## `ctx.pluginData`

Scoped 到 `(sessionId, pluginId)`，跨插件**不可见**。

```ts
await ctx.pluginData.set("namespace", "key", { foo: "bar" });
//   value === null 等价于 delete
const row = await ctx.pluginData.get("namespace", "key");
// → { value: ... } | null

const all = await ctx.pluginData.list("namespace");
// → ReadonlyArray<{ key, value }>，按 store ordering（最新在前）

await ctx.pluginData.delete("namespace", "key");
```

**绕过 proposal pipeline 直接落库**——立即可被 SSE `plugin-data.changed` 观察到，前端 spec 立刻刷新。常用于 placeholder（pending state），最终成品再通过 `return { pluginData: [...] }` 走 proposal。

> **保留 namespace**：以 `_` 开头的（`_jobs`, `_logs`）是框架保留，插件**不要写**——`_jobs` 由 `execution: background` 框架自动管理，`_logs` 由 `ctx.logger` 自动写。

---

## `ctx.logger`

```ts
await ctx.logger.debug("foo.event", { meta: "data" });
await ctx.logger.info("image.completed", { imageId, durationMs });
await ctx.logger.warn("cache.miss", { key });
await ctx.logger.error("synthesis.failed", { error: err.message });
```

每次调用都在 plugin 的 `_logs` namespace 追加一行，时间戳+uuid 排序。可在 `/api/sessions/:id/plugin-data/:pluginId/_logs` 取，前端 `/debug` 也消费。

---

## `ctx.completedResults` 怎么用

来源：本 turn 已跑完的 runtime 们的 output。**严格按 priority + DAG 顺序**，所以你声明 `upstreamRequired:[narrator]` + `priority: 700`（narrator 是 500）就保证 narrator 已经在 map 里了。

```ts
// 取 narrator 本轮 narrativeOutput
const narrator = ctx.completedResults.get("narrator"); // 注意是 runtimeId（多 runtime 时 = 'plugin/sub'）
if (!narrator) return { status: "skipped", reason: "narrator missing" };
const text = narrator.output?.narrativeOutput; // string | undefined

// 如果上游已经 emit 过 event，框架会传给 ctx.triggerEvent — 不用从 completedResults 里挖
```

**坑**：`runtimeId` 不是 `pluginId`！多 runtime 插件取 `narrator/main`、`char-creator/player-init` 这种全名。单 runtime 插件 runtimeId = pluginId。

---

## Handler 返回值（normalizeOutput 契约）

返回 `Record<string, unknown>`。框架识别**这些字段**并转成 Proposal：

| 返回字段                                     | 转成 Proposal                                       | 仅当                                                                                                                 |
| -------------------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `narrativeOutput` 或 `content`               | `narrative.append`                                  | `manifest.outputKind === 'story'`；其他 outputKind 时这个字段被**静默丢弃**到 chat（仍保留为 runtime output 给下游） |
| `interactions: [{type, interactionId, ...}]` | `interaction.request`                               | type ∈ `'form' \| 'choices' \| ...`                                                                                  |
| `statePatches: [{table, field, value}]`      | `state.patch`                                       | 一对一                                                                                                               |
| `events: [{topic, data}]`                    | `event.emit`                                        | 同 turn 内下游 `trigger:{type:event,topic}` runtime 会被拉起                                                         |
| `assetGenerations: [...]` 或 `assets: [...]` | `asset.generate`                                    | `[{ref: MediaRef, modality, meta?}]`；`assets` 是 alias，两者都接受                                                  |
| `pluginData: [{namespace, key, value}]`      | `plugin.data`（1 条）/ `plugin.data.batch`（≥2 条） | 框架自动选                                                                                                           |
| `notifications: [{title, message}]`          | `narrative.append`（kind=system）                   | 走 chat feed                                                                                                         |

**其它字段**：原样存为 `RuntimeResult.output`，下游 runtime 通过 `ctx.completedResults.get(myId)?.output?.<field>` 读。

⚠️ **不要返回顶层 `proposals: [...]`**——这是 tools 层的内部 Symbol channel，handler 输出里的 `proposals` 字段会被 normalizeOutput **完全忽略**。

⚠️ **特殊状态字段**：handler 输出里可以放 `status: 'failed' | 'skipped' | 'done'` 和 `error` / `reason`。这些不被 normalizeOutput 翻译成 proposal，但会上报到 `RuntimeResult.status` 和 trace。

---

## 插件类型 vs `ctx.store` 的关键差别

| Manifest `pluginType`         | `ctx.store` 是                                                                                       | 写入策略                                                                 |
| ----------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `core-plugin`                 | 完整 `DataStore`（含跨插件读写）                                                                     | bootstrap 仅给特定 builtin 插件用，**社区插件无法声明**                  |
| `plugin`（默认；社区/第三方） | `FunctionStoreView`（只读 4 方法：`getPluginData / listPluginData / getSession / listTurnMessages`） | 写入只能用 `ctx.pluginData.set(...)` 或 handler 返回 `pluginData: [...]` |

`pluginType: core-plugin` 由 framework trust signal 决定。社区插件（`~/.covel/plugins/` 下）即使把 `pluginType` 写成 `core-plugin` 也会被 bootstrap 降级到 `plugin`。第三方作者**只能**写 `pluginType: plugin`。

---

## 速查 cheatsheet

```ts
export default async function handler(ctx) {
  const { turnId, gateway, utils, media, pluginData, logger, userSettings } = ctx;

  // 1. 先 null check 关键依赖
  if (!gateway || !media) {
    return { status: 'failed', error: 'gateway/media unavailable; framework too old' };
  }

  // 2. 配置（manifest userSettings 已合并默认值）
  const presetId = userSettings?.modelPresetId ?? 'my-plugin';

  // 3. 解析 slot
  const slot = gateway.resolveSlot({ presetId, fallbackTag: 'speech' });
  if (!slot?.baseUrl || !slot?.apiKey) {
    return {
      status: 'failed',
      error: `Slot "${presetId}" missing baseUrl/apiKey — fix [covel.${presetId}] in llm.toml`,
    };
  }

  // 4. SSRF 检查
  const guard = utils.validateBaseUrl(slot.baseUrl);
  if (!guard.ok) return { status: 'failed', error: `Invalid baseUrl: ${guard.reason}` };

  // 5. 自管 wire（见 provider-quirks.md）
  const bytes = await myProviderClient(slot, ...);

  // 6. 落 MediaStore
  const ref = await media.put(bytes, 'audio/mpeg', { turnId });

  // 7. 立即写 placeholder（前端 SSE 看到）
  await pluginData.set('tracks', turnId, { ref, status: 'done' });
  await logger.info('done', { turnId, bytes: bytes.byteLength });

  // 8. 返回让 normalizeOutput 走 commit pipeline + asset.generate
  return {
    status: 'done',
    pluginData: [{ namespace: 'tracks', key: turnId, value: { ref, status: 'done' } }],
    assetGenerations: [{ ref, modality: 'audio', meta: { turnId } }],
  };
}
```
