# 插件开发指南 · 高级（TypeScript + 审批 + 发布）

> 面向**专业开发者**：要吃下完整类型系统、写复杂的 `TestHarness` 断言、自定义审批规则、拆多 runtime 插件，并最终发布到社区。

> **前置要求**：先完成 [零代码](./plugin-authoring-zero-code.md) 和 [进阶（agent + 本地 JS）](./plugin-authoring-agent.md)。

> **读完你能做到**
>
> - 从 `@covel/shared` / `@covel/plugin-loader` 导入并正确使用插件相关类型
> - 用 MockLLM 的响应队列 + 自定义工具 + 多轮 harness 做复杂集成测试
> - 用 `createApprovalPipeline` 定制工具审批规则（allow / ask / deny）
> - 在一个插件里组织多个 runtime（`runtimes/*/PLUGIN.md`）
> - 按发布 checklist 完成社区插件的上架准备
> - 满足 `I18nText` 规范让插件 UI 文本双语化
> - 为第三方 world 包约定 `plugin://<pluginId>/<namespace>` 数据 schema，并通过 `worldData` 导入插件数据

---

## 1. 完整的类型系统

所有插件相关类型都从 `@covel/shared` 导出：

```typescript
import type {
  // 插件类型
  PluginType, // 'core-plugin' | 'plugin'
  PluginManifest, // 完整插件清单
  RuntimeManifest, // 运行时清单（PLUGIN.md frontmatter 的解析结果）

  // 触发系统
  TriggerType, // 'auto' | 'manual' | 'scheduled' | 'event' | 'error-retry'（conditional 为 reserved）
  TriggerConfig, // { type, interval?, condition?, topic?, maxTriggerCount?, cooldownTurns? }

  // 输入/输出
  InputConfig, // { inject?, tools? }
  InputInjectDecl, // { from, field, as }
  OutputConfig, // { schema?, recordAs? }

  // 工具
  ToolsConfig, // { builtin?, local? }

  // 玩家可调设置（PLUGIN.md `userSettings`）
  PluginUserSettingSpec, // { key, type, default?, label, min?, max?, options? }

  // 运行时数据
  TurnInput, // 每轮输入
  TurnResult, // 每轮输出
  RuntimeResult, // 单个 runtime 的执行结果
} from "@covel/shared";
```

从 `@covel/plugin-loader` 获取加载相关类型：

```typescript
import type {
  ParsedPluginMd, // 解析后的 PLUGIN.md
  ParsedReference, // 解析后的参考文件
  PluginDiscoveryResult, // 发现结果
  LoadedRuntime, // 完全加载的 runtime
  PluginRegistryEntry, // 注册表条目
  PluginSource, // 'builtin' | 'official' | 'community'
  PluginTrustInfo, // { source, requiresApproval, autoLoad }
} from "@covel/plugin-loader";
```

## 2. TestHarness 高级用法

**自定义 MockLLM 响应队列：**

```typescript
const mockLLM = new MockLLM();

// 默认响应
mockLLM.defaultResponse = {
  content: "你来到了一片神秘的森林...",
  toolCalls: [],
  finishReason: "stop",
  usage: { inputTokens: 100, outputTokens: 50 },
};
```

**注入额外工具：**

```typescript
import { tool } from "@covel/tools";
import { z } from "zod";

const customTool = tool({
  name: "test-helper",
  description: "Test helper tool",
  parameters: z.object({ value: z.string() }),
  execute: async (params) => ({ echoed: params.value }),
});

const harness = await createTestHarness({
  pluginsDir: path.resolve(__dirname, "../../"),
  tools: [customTool], // 额外注册的工具
});
```

**断言 Store 状态：**

```typescript
const harness = await createTestHarness({ pluginsDir: "..." });
await harness.executeTurn("开始游戏");

// 通过 store 检查持久化的数据
const store = harness.store;
// store 实现了 DataStore 接口，可以查询 state、events、records 等
```

**多轮测试：**

```typescript
const harness = await createTestHarness({ pluginsDir: "..." });

// 第一轮
const result1 = await harness.executeTurn("开始游戏");

// 第二轮（TestHarness 自动递增 turnId）
const result2 = await harness.executeTurn("我要去探索森林");

// 断言跨轮状态变化
expect(mockLLM.calls).toHaveLength(2);
```

## 3. 审批管线

工具调用经过 `ApprovalPipeline` 审批。当前默认规则：

| 来源            | 规则  | 说明                   |
| --------------- | ----- | ---------------------- |
| `builtin:*`     | allow | 框架内置工具，始终放行 |
| `local:*`       | allow | 插件本地工具，自动放行 |
| `third-party:*` | deny  | 未知来源工具，拒绝执行 |

**自定义审批规则（用于测试或特殊场景）：**

```typescript
import { createApprovalPipeline } from "@covel/approval";
import type { PermissionRule } from "@covel/approval";

const rules: PermissionRule[] = [
  { pattern: "builtin:*", action: "allow" },
  { pattern: "local:*", action: "allow" },
  { pattern: "dangerous-tool", action: "ask" }, // 需要玩家确认
  { pattern: "third-party:*", action: "deny" },
];

const pipeline = createApprovalPipeline(store, rules);

// 检查工具是否需要审批
const result = pipeline.check(
  { toolName: "dangerous-tool", sessionId: "sess-1", turnId: "turn-1" },
  "local",
);
// result: { needsApproval: true, reason: 'rule-ask' }
```

**审批规则匹配逻辑：**

1. 按规则列表顺序匹配，第一个匹配的规则生效
2. `builtin:*`、`local:*`、`third-party:*` 按工具来源分类匹配
3. 具体工具名（如 `dangerous-tool`）精确匹配，不区分来源
4. 无规则匹配时默认 allow

**来源分类：**

框架 bootstrap 时自动分类：

- `builtinUITools` 中的工具 → `builtin`
- 插件 `tools/` 目录加载的工具 → `local`
- 其他 → `third-party`（预留给社区插件）

新插件只需在 PLUGIN.md 中声明 `tools.local`，bootstrap 自动发现、注册并归类，无需手动修改白名单。

**社区（community）信任级别的特殊处理：** 框架 bootstrap 不会立即 import community 插件的 `tools.local`，而是延后到首次 `POST /api/approvals/:approvalId/decision` 决策为 `allow` 时（或下一次 plugin-rpc 执行时 just-in-time），通过 `activatePluginLocalTools(pluginId)` 一次性导入并注册到 toolMap。激活是幂等的，社区插件作者无需做额外配置——声明 `tools.local` + 通过审批后即可执行。

## 4. World Data Schema 契约

插件要接收世界包或 override 包携带的数据，需要在 `PLUGIN.md` frontmatter 声明 `dataSchemas`。每个 namespace 对应一个插件根目录内的 JSON Schema 文件；world-data importer 会在 session 创建前校验目标插件启用状态、namespace 声明、schema URI 与 target namespace 兼容性，以及 source item schema。

```yaml
dataSchemas:
  relationships:
    schemaVersion: 1
    acceptsWorldData: true
    schema: ./schemas/relationships.schema.json
    description: Importable relationship records.
```

world 包使用 `plugin://<pluginId>/<namespace>` 作为 schema URI，并用 `plugin:<pluginId>/<namespace>` 作为导入目标：

```yaml
sources:
  relationships:
    kind: yaml
    path: data/social/relationships.yaml
    schema: plugin://social-sim/relationships
    to: plugin:social-sim/relationships
    key: id
```

同一个 `PLUGIN.md` frontmatter 可以声明目录元数据：

```yaml
tags:
  - mode:dialogue
  - role:scene-state
relations:
  provides:
    - scene-state
  requires:
    - chat-mode-narrator
  conflicts:
    - narrator
```

`tags` 用于玩家/作者筛选和世界 `pluginPolicy` 匹配；`capabilities` 仍表示框架可依赖的机器能力契约。世界包可通过 `pluginPolicy.preset` 引用内置前端组合包 `traditional-story`、`dialogue-mode`、`low-cost`，也可在 `pluginPolicy.packs` 中声明自定义组合。

导入成功后，每条 `plugin_data`、`lorebook`、`character` 和 media index 都会写入 `world_data_import_ledger`。`POST /api/worlds/:id/sync-data` 基于 ledger 做 dry-run、hash 冲突检测和同步。完整格式见 [World Data reference](../reference/world-data.md)。

## 5. 多 Runtime 插件

一个插件可以包含多个 runtime（每个 runtime 一份独立的 PLUGIN.md），适用于复杂的游戏系统：

```
plugins/my-combat/
├── PLUGIN.md              # 可选：包级摘要（仅 name/description/pluginType，不作为 runtime）
├── runtimes/
│   ├── combat-init/
│   │   └── PLUGIN.md      # 战斗初始化 runtime（name: my-combat/combat-init）
│   └── combat-resolve/
│       └── PLUGIN.md      # 战斗结算 runtime（name: my-combat/combat-resolve）
├── tools/
│   └── roll-dice.js
└── package.json
```

`runtimes/*/PLUGIN.md` 才是真正的 runtime，有自己的优先级、触发条件和 LLM 提示词。它们可以：

- 使用不同的 model slot（如战斗结算用 `balance`，初始化用 `fast`）
- 设置不同的 trigger（如一个 auto，一个 event）
- 通过 `input.inject` 互相传递数据
- 共享 `tools/` 目录下的工具

`discoverPlugins()` 在检测到 `runtimes/` 子目录后**只**收集 `runtimes/*/PLUGIN.md` 作为 runtime；根目录的 `PLUGIN.md`（如果存在）仅被 `loadPluginSummary()` 读取，用于提供包级 `name`（displayName）和 `description`。**没有**根 PLUGIN.md 时，框架会把展示名强制设为 plugin id（如 `my-combat`），UI 会显得冗长。第三方插件作者建议提供根 PLUGIN.md；详见 [plugins.md 多 runtime 插件](../reference/plugins.md#多-runtime-插件)。

> 注意：单 runtime 插件正好相反 —— 没有 `runtimes/` 时，根目录的 `PLUGIN.md` 本身就是唯一的 runtime（其 frontmatter 同时承担 runtime 字段和包级摘要两种职责）。

`PluginManifest` 类型反映了这种结构：

```typescript
interface PluginManifest {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly pluginType: PluginType;
  /** 单 runtime 插件 */
  readonly runtime?: RuntimeManifest;
  /** 多 runtime 插件 */
  readonly runtimes?: readonly RuntimeManifest[];
}
```

## 6. 函数 Runtime、手动触发与后台执行

`runtimeType: function` 表示"跳过 LLM,直接执行 JS 模块"。用于调用外部 API、做纯计算、写 plugin-data 等不需要 LLM 推理的场景。

### 函数 Runtime 的 Handler 签名

`handler` 字段指向一个 ESM 模块,必须 default-export 一个**单参**异步函数。运行时只传 `ctx`:

```ts
export default async function handler(
  ctx: FunctionHandlerContext,
): Promise<Record<string, unknown>> {
  return {
    // 任意 JSON 字段都会作为 runtime final output 持久化(供下游 runtime
    // 通过 ctx.completedResults 读到)。下面这几个字段是框架识别的"指令",
    // 由 normalizeOutput 转成 Proposal 走标准 commit pipeline:
    narrativeOutput: '...',                       // → narrative.append
    events: [{ topic: '...', data: {...} }],      // → event.emit
    statePatches: [{ table, field, value }],      // → state.patch
    pluginData: [{ namespace, key, value }],      // → plugin.data / plugin.data.batch
    interactions: [{ type: 'form', ... }],        // → interaction.request
    notifications: [{ title, message }],          // → narrative.append(kind='system')
    // 其它字段保持为 output JSON
  };
}
```

> **注意**: 函数 runtime **不能**返回顶层 `proposals: [...]` 数组 —— 那是工具层
> 通过非可枚举 Symbol 在内部传递的 channel,不在 handler 公开 API 里。要写入
> 插件命名空间数据,用上面的 `pluginData[]` 简写。

`FunctionHandlerContext` 暴露的字段(仅列和插件作者最相关的):

| 字段                     | 类型                    | 用途                                                                                                                                                                                                                                                                                                            |
| ------------------------ | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sessionId`              | `string`                | 当前 session ID                                                                                                                                                                                                                                                                                                 |
| `turnId`                 | `string`                | 当前 turn ID(触发该 runtime 的 turn)                                                                                                                                                                                                                                                                            |
| `pluginId` / `runtimeId` | `string`                | 本 runtime 的身份(和 manifest 里一致)                                                                                                                                                                                                                                                                           |
| `locale`                 | `string`                | `zh-CN` / `en` / ...,来自 session / 请求                                                                                                                                                                                                                                                                        |
| `store`                  | `FunctionStoreView`     | 绑定当前 session/plugin 的只读 DataStore 视图：`getPluginData(namespace, key)` / `listPluginData(namespace)` / `getSession()` / `listTurnMessages(limit?)`(传 `limit` 时返回**最近** N 条 turn 消息、按时间正序；不传则全量)。写入使用 `ctx.pluginData` 或 handler return 值                                    |
| `gateway`                | `PluginRuntimeGateway?` | 文本/object 生成 + slot 解析。签名见下                                                                                                                                                                                                                                                                          |
| `utils`                  | `PluginRuntimeUtils?`   | SSRF 安全的 URL 校验 + 带重试的 fetch。插件自管 wire 时使用                                                                                                                                                                                                                                                     |
| `media`                  | `MediaContext?`         | `put` / `get` / `resolveUrl` / `ingestUrl`——媒体库读写原语，`ingestUrl` 内置 SSRF/MIME/超时校验                                                                                                                                                                                                                 |
| `images`                 | `ImagesContext?`        | 统一图像生成原语（generate → 落库 → promptHash 去重），见下方图像生成小节。存在条件：executor 同时装配了 gateway 与 MediaStore                                                                                                                                                                                  |
| `speech`                 | `SpeechContext?`        | 统一语音原语：`generate`（TTS → 落库 → promptHash 去重）+ `transcribe`（STT → 纯文本）。存在条件与 `images` 相同                                                                                                                                                                                                |
| `manualPayload`          | `unknown?`              | 仅在 `POST /plugin-rpc` 手动触发时注入,为请求体的 `payload` 字段                                                                                                                                                                                                                                                |
| `triggerEvent`           | `{ topic, data }?`      | 仅 event 触发时存在,包含触发该 runtime 的事件                                                                                                                                                                                                                                                                   |
| `signal`                 | `AbortSignal?`          | 玩家中止本 turn 的信号。handler 里跑长任务（图像生成、TTS、自管 `fetch`）时应把它传下去（`ctx.images.generate({ signal })` / `fetch(url, { signal })`），玩家点停即取消在途请求而非跑完。无 `TurnControl` 的运行（测试 harness）里为 `undefined`。语义不变：handler 若忽略它并正常返回,产出的 proposal 仍会提交 |

**`ctx.gateway`:** function runtime 调用 LLM 的入口。绝不允许直接 `fetch` 文本 provider URL 或导入文本 SDK —— 这样会跳过 slot 解析、密钥管理、SSRF 防护和 replay cache。

```ts
// 文本补全
const res = await ctx.gateway.generateText({
  presetId: "fast", // 可选;缺省走 manifest.model / default slot
  messages: [{ role: "user", content: "..." }],
});
```

> 图像生成不走 `generateText` —— 见下方"图像生成:`ctx.images`"小节。

> **结构化 JSON 输出(未在函数 runtime 中可用,审计 F9):** `ctx.gateway.generateObject`
> 需要宿主向 gateway 注入 JSON Schema → Zod 的转换器,目前组合根未接入。若需要
> 结构化输出,请用 **agent runtime** 的 `output.schema` / `responseFormat` 路径 ——
> 框架在那里自动处理 schema → provider-specific grammar。
> 待某个插件真正需要 function-runtime 下的 `generateObject` 时,再引入转换器。

**`ctx.utils`:** 自管 wire(见下方逃生口小节)的插件必须经过这里调用网络,不要直接 `fetch`,以保持 SSRF 守卫和重试策略统一。`fetchWithRetry` 会在每次请求和重试前校验 DNS 的全部解析结果,并将连接固定到本次已验证的公网地址;媒体 URL 的每一跳重定向也会重新执行该流程,阻断私网 IPv4/IPv6 和 DNS rebinding。

```ts
const slot = ctx.gateway.resolveSlot({ presetId: "image", fallbackTag: "image" });
if (!slot) throw new Error("image slot not configured");

// SSRF 守卫 — 远端必须 https,loopback 才允许 http,阻断 RFC1918/169.254/cloud metadata
const guard = ctx.utils.validateBaseUrl(slot.baseUrl);
if (!guard.ok) throw new Error(`Bad baseUrl: ${guard.reason}`);

// fetch 包装 — 自动 429 / 5xx 指数退避重试,honor Retry-After
const response = await ctx.utils.fetchWithRetry(`${slot.baseUrl}/...`, {
  method: 'POST',
  headers: { authorization: `Bearer ${slot.apiKey}` },
  body: JSON.stringify({ ... }),
  maxRetries: 3,                                    // 默认 3,设 0 禁用
});
```

### 图像生成:`ctx.images`(推荐路径)

`ctx.images` 是框架统一的图像生成原语:选 wire、调 provider、落 `MediaStore`、按 `promptHash` 去重全部由框架完成 —— handler 只需要给 prompt 和业务 metadata,永远不接触字节流或供应商凭据。**新插件应该从这里开始,不要手写 HTTP 调用图像 provider。**

```ts
const { refs, warnings, cached } = await ctx.images.generate({
  presetId: "image", // 可选;缺省走 image tag 解析(现有 tag-aware fallback)
  prompt: "a rainy street at night, cinematic lighting",
  negativePrompt: "blurry, low quality",
  size: "1024x1024",
  n: 1,
  metadata: {
    // 业务 key,自由定义;框架会在后面追加 pluginId/promptHash,插件传同名字段也不会覆盖它们
    kind: "scene-background",
    sceneId: ctx.triggerEvent?.data?.sceneId,
  },
});
const [ref] = refs;
if (!ref) throw new Error("image provider returned no usable media");
```

- `refs: MediaRef[]` 已经落库,可以直接用在 `assetGenerations[]` / `pluginData[]` 里。
- `cached: true` 表示命中了同 `promptHash` 的既有资产,没有真的调用 provider(省钱,防重试风暴重复扣费)。
- `metadata` 只在**首次**调用时落地——同一组生成参数的后续调用即使传了不同 `metadata` 也会命中缓存并沿用第一次的值。完整的 metadata 约定和 `promptHash` 语义见 [media-store.md § Metadata Conventions & Querying](../reference/media-store.md#metadata-conventions--querying)。
- 存在条件:executor 同时装配了 gateway 与 `MediaStore`(生产环境始终满足;没接 store 的测试 harness 里 `ctx.images` 是 `undefined`,调用前按需 `ctx.images?.generate` 做空判断)。

### 语音合成与转写:`ctx.speech`

`ctx.speech` 是和 `ctx.images` 完全对称的语音原语。TTS 插件不再需要手写 HTTP wire、手动 `resolveSlot`、手动 `media.put`:

```ts
// TTS:文本 → 语音,返回已落库的 MediaRef
const { refs, warnings, cached } = await ctx.speech.generate({
  presetId: "mimo-tts", // 可选;缺省走 speech tag 解析
  text: narrativeText,
  voice: "mimo_default",
  format: "mp3",
  metadata: { turnId: ctx.turnId, triggeredBy: "auto" },
});
const [ref] = refs; // 单条音轨;数组形状与 images 对齐

// STT:语音 → 文本(不落库、不去重)
const { text } = await ctx.speech.transcribe({
  presetId: "whisper", // 可选;缺省走 transcription tag 解析
  audio: ref, // MediaRef,或 { data: Uint8Array, mimeType, fileName? }
});
```

- `generate` 按 `sha256(presetId, text, voice, format)` 去重:同一段文本重复触发直接 `cached: true` 返回既有资产,不重复计费。
- `transcribe` 输出纯文本直接返回 handler,无去重(需要缓存时插件可自行用 `ctx.pluginData` memoize)。
- wire 选择:slot 的 `providerRequestMetadata.speechWire` / `transcriptionWire`,缺省 `openai-speech` / `openai-transcription`(标准 OpenAI `/audio/speech`、`/audio/transcriptions` 协议)。非标厂商用下方 `wires` 字段注册自定义 wire。
- 存在条件与 `ctx.images` 相同,调用前 `ctx.speech?.generate` 空判断。

### 自管 wire(逃生口):`ctx.gateway.resolveSlot`

只有当框架内置的两个 wire(`openai-images` / `dashscope-wan`)都覆盖不了需求时才用这条路径 —— 比如要接一个响应形态特殊、`ctx.images` 尚未支持的 provider,或者单次调试性质、不想为它注册一个正式 wire。这时直接拿 slot 凭据自己发请求:

```ts
const slot = ctx.gateway.resolveSlot({
  presetId: "image",
  fallbackTag: "image",
});
if (slot) {
  // slot = { presetId, provider, baseUrl, apiKey, model, tag, metadata, ... }
  // 拿到凭据后用任意 SDK / fetch 调供应商(经 ctx.utils,见上)
}
```

这条路径下框架不再帮你落库或去重 —— `resolveSlot` 只给凭据,provider 返回的 `b64_json` 或临时 URL 必须自己写入 `ctx.media.put()` 或 `ctx.media.ingestUrl()`,完成态返回 `assetGenerations[]`。

### 注册自定义 wire:`wires` frontmatter 字段

如果是一个会被反复使用的新 provider 协议(而不是一次性调试),把它注册成正式的 wire —— 图像、TTS、STT 三个模态同一套机制,任何插件(包括 `~/.covel/plugins` 下的社区插件)都可以接入,不需要提交框架 PR:

**1. 在 PLUGIN.md frontmatter 声明 `wires` 字段**(插件根目录相对路径,整个插件声明一次即可):

```yaml
wires: lib/wires.js
```

**2. wires 模块 default export 三组 wire 数组**(都可选),或一个接受注入工具的工厂函数 —— 工厂形态让插件零依赖拿到框架的 SSRF 守卫和重试 fetch:

```js
// lib/wires.js — 纯 JS,无需 import 任何框架包
export default ({ fetchWithRetry, validateBaseUrl }) => ({
  speech: [
    {
      id: "mimo", // 注册后自动加插件前缀 → "mimo-tts/mimo"
      async synthesize(config, params) {
        // config = { baseUrl, apiKey, ... }(来自 slot 解析,key 已注入)
        // params = { model, text, voice?, format?, providerRequestMetadata? }
        // 返回 { audio: { mimeType, data: Uint8Array }, usage, warnings }
      },
    },
  ],
  image: [
    /* { id, async generate(config, params) } */
  ],
  transcription: [
    /* { id, async transcribe(config, params) } */
  ],
});
```

- **命名空间:** 注册 id 强制加 `<pluginId>/` 前缀 —— 不会撞内置 wire,两个插件可以各自有同名 wire。
- **加载时机与信任门控:** builtin/official 插件在服务启动时注册;community 插件在其 runtime 首次被加载时注册(与框架 `import()` 其 handler.js 同刻,时序必然早于 handler 里的任何 `ctx.images` / `ctx.speech` 调用)。
- **容错:** 路径逃逸、文件缺失、条目形状不对都只 warn 并跳过,不会拖垮启动;重复注册(dev 双重启动)也只 warn。
- bundled 插件如果更愿意直接 `import { registerImageWire } from "@covel/ai-provider"` 在模块顶层注册,仍然可行 —— `wires` 字段只是把这条路开放给了拿不到 workspace 依赖的第三方插件。

**3. 接上 slot:** 在 `llm.toml` 给对应 slot 的 `providerRequestMetadata` 指定 wire id(注意带插件前缀),`ctx.images` / `ctx.speech` / gateway 就会选中它:

```toml
[covel.mimo-tts]
provider = "xiaomi"
model = "mimo-v2.5-tts"
tag = "speech"
providerRequestMetadata = { speechWire = "mimo-tts/mimo" }
```

不设置时的缺省 wire:`imageWire` → `openai-images`、`speechWire` → `openai-speech`、`transcriptionWire` → `openai-transcription`。完整 slot 配置参考见 [slots.md](../reference/slots.md)。

### 手动触发: 前端 → RPC → 函数 Runtime

典型的"玩家点按钮 → 触发插件 runtime"链路:

1. 插件在 `ui/xxx.json` 里声明一个按钮,`on.click.action: "invokeRuntime"`,`params.runtimeId: "my-plugin/worker"`。**不需要**写任何 React 代码 —— `PluginPanel` 框架已经注册了 `invokeRuntime` 默认 handler。
2. 用户点击后,前端发 `POST /api/sessions/:id/plugin-rpc` `{ pluginId, runtimeId, payload }`。
3. 框架把 `payload` 注入到 `TurnInput.manualTrigger`,`executeTurn` 只跑目标 runtime 及其事件下游。
4. 目标 runtime 的 handler 收到 `ctx.manualPayload = payload`。

示例 UI spec(会自然被 `invokeRuntime` 默认 handler 处理):

```json
{
  "component": "Button",
  "props": { "label": "Generate" },
  "on": {
    "click": {
      "action": "invokeRuntime",
      "params": {
        "runtimeId": "my-plugin/prompt-generator",
        "payload": { "style": "cinematic" }
      }
    }
  }
}
```

### 事件契约声明与统一发射（`events` + `emit-event`）

统一事件发射层让**任意声明了事件契约的插件**都能被**任意具备发射能力的叙事 / agent runtime**驱动，框架和叙事插件都不需要硬编码谁消费什么事件。分两端：

**消费方：声明 `events` + 用 `trigger: { type: event }` 接住**

```yaml
# plugins/quest-tracker/PLUGIN.md frontmatter
name: quest-tracker
events:
  - topic: quest.updated
    schema: ./schemas/quest-updated.event.json
    description:
      zh: 任务状态更新
      en: Quest status updated
trigger:
  type: event
  topic: quest.updated
runtimeType: function
handler: ./handler.js
```

`schema`（插件根目录相对 JSON Schema 路径）校验事件的 `data` payload——同一份 schema 既供 `emit-event` 工具在执行前校验，也是作者自己核对契约的单一来源。`quest-tracker/handler.js` 通过 `ctx.triggerEvent.data` 读到事件负载：

```ts
export default async function handler(ctx) {
  const { questId, status } = ctx.triggerEvent?.data ?? {};
  // ... 更新 quest 状态
}
```

**发射方：`advertiseEvents: true` + `tools.builtin: [emit-event]`**

```yaml
advertiseEvents: true
tools:
  builtin:
    - emit-event
```

声明后，该 runtime 的 prompt 段 5 会自动收到当前 session 内所有 `advertise !== false` 事件的目录（`<available-events>` 块，逐条 `- topic: description (required: field1, field2)`），LLM 据此判断"当前叙事是否触发了某个已知领域事件"，命中时调用 `emit-event({ topic: "quest.updated", data: { questId: "q1", status: "completed" } })`（一次一个 topic）。校验失败（未知 topic / payload 不合 schema）会把可读错误文本原样回给 LLM 重试，不中断工具循环、也不产出重复事件。

聚合范围是**当前 session 的激活插件集**——`quest-tracker` 未启用时，narrator 的 `<available-events>` 目录里不会出现 `quest.updated`，`emit-event` 也会拒绝该 topic。跨插件同 topic 不同 schema 时按插件优先级首胜。完整字段表、冲突规则见 [plugins.md #events 声明与 advertiseEvents](../reference/plugins.md#events-声明与-advertiseevents统一事件发射层)，工具校验流程见 [tools.md #emit-event](../reference/tools.md#emit-event)。

> `narrator` / `chat-mode-narrator` 已接入为发射方参考实现。第一个落地的消费方是 `scene-stage/resolver`（`scene.set` 契约）：声明 `events`（含 `advertise: false` 的内部信令 topic）+ `trigger: {type: event, topic: scene.set}`，把事件解析成 `stage/current` 舞台状态并向后台生成 runtime 发内部事件——写事件消费方直接以 `plugins/scene-stage/runtimes/resolver/PLUGIN.md` 为参考实现。上面的 `quest.updated` 只是中性教学示例。

### `execution: sync` vs `execution: background`

```yaml
runtimeType: function
execution: background # 默认 sync
trigger: { type: manual }
handler: ./handler.js
```

- `sync`(默认):HTTP 响应阻塞到 runtime 完成。适合能秒级返回的任务。
- `background`:立即返回 202 + `jobId`,任务在 `setImmediate` 后台跑。框架在 `plugin_data` 表下 `_jobs/<jobId>` 写入 `{status: 'pending' → 'done' | 'failed', ...}` 三态,每次写入都通过 `plugin-data.changed` SSE 广播,前端通过订阅 `_jobs` 命名空间或你自己的业务命名空间(如 `images`)拿到最终态。

**background 下的两个强约束:**

1. 插件**禁止**直接写 `_jobs` 命名空间 —— 框架独占。业务状态请写到自己的命名空间(如 `images/{jobId}` `{status: 'pending'}` → `{status: 'ready', ref: ...}`)。
2. `setImmediate` 中抛出的异常**不会**映射为 5xx —— 响应已发。失败信息会被框架写入 `_jobs/<jobId>.value.error`,前端通过 SSE 感知。

**事件链 chain:** 无论 sync 还是 background,runtime emit 的 `event.emit` proposal 都会按 priority 触发同一 turn 内的下游 runtime,不需要额外协调。这让"按钮 → prompt-generator (agent) → image-generator (function, background)"这种多步 pipeline 完全声明式。

### 完整示例: 两段式图像生成插件

```yaml
# runtimes/prompt-generator/PLUGIN.md
name: my-image-gen/prompt-generator
priority: 600
runtimeType: agent # 用 LLM 生成 prompt
trigger: { type: manual }
# frontmatter 的 output 只接受 { schema, recordAs }(outputConfigSchema 是 strict)。
# 事件由 agent 在 runtime output JSON 里输出 events[] 数组,normalizeOutput
# 会转成 event.emit proposal。在 prompt 正文里要求模型输出:
#   { "prompt": "...", "events": [{"topic": "image.generate.requested", "data": {"prompt": "..."}}] }
```

```yaml
# runtimes/image-generator/PLUGIN.md
name: my-image-gen/image-generator
priority: 610
runtimeType: function # 纯 JS,直接调 provider
execution: background # 不阻塞 turn
trigger:
  type: event
  topic: image.generate.requested
handler: ./image-handler.js
```

```ts
// runtimes/image-generator/image-handler.js
//
// ctx.images 是框架统一的图像生成原语:选 wire、调 provider、落
// MediaStore、按 promptHash 去重全部由框架完成。handler 只编排 prompt
// 和业务 metadata,不接触字节流或供应商凭据、也不用管 openai-images 还是
// dashscope-wan —— 那由 llm.toml 里 image slot 的 providerRequestMetadata.imageWire 决定。
export default async function handler(ctx) {
  const prompt = ctx.triggerEvent?.data?.prompt;
  if (typeof prompt !== "string" || prompt.length === 0) {
    return {
      pluginData: [
        {
          namespace: "images",
          key: ctx.turnId,
          value: { status: "failed", error: "missing prompt" },
        },
      ],
    };
  }

  const { refs, warnings, cached } = await ctx.images.generate({
    presetId: "image",
    prompt,
    n: 1,
    metadata: { kind: "illustration" },
  });
  const [ref] = refs;
  if (!ref) throw new Error("image provider returned no usable media");

  return {
    imageId: ctx.turnId,
    status: "done",
    ref,
    // framework picks this up → commits one plugin.data proposal for gallery indexing
    pluginData: [
      {
        namespace: "images",
        key: ctx.turnId,
        value: { status: "done", ref, prompt, cached, warnings },
      },
    ],
    // framework normalizes this to Proposal{ type: 'asset.generate' }
    assetGenerations: [{ ref, modality: "image", meta: { prompt } }],
  };
}
```

> 需要接入 `openai-images` / `dashscope-wan` 都不支持的 provider?看上面"注册自定义 wire"小节,给它注册一个 `ImageWire` 再照常调 `ctx.images.generate()` —— handler 代码不用变。

## 7. 发布和分享

### 插件信任等级

| 来源        | 标识          | 加载方式             |
| ----------- | ------------- | -------------------- |
| `builtin`   | 绿色徽章      | 自动加载，无需确认   |
| `official`  | 绿色徽章      | 白名单匹配，自动加载 |
| `community` | 橙色/红色警告 | 需用户确认后加载     |

### 插件最低要求

一个可发布的插件至少需要：

```
my-plugin/
├── README.md      # 必需：给人类 / 开发者看的插件说明
├── PLUGIN.md       # 必需：frontmatter + 提示词
└── package.json    # 必需：workspace 依赖声明
```

### 发布检查清单

- [ ] `README.md` 说明插件用途、运行时组成、数据读写、测试方式和已知限制
- [ ] `PLUGIN.md` frontmatter 通过 `runtimeManifestSchema` 校验
- [ ] `name` 字段唯一，建议用 `your-prefix-` 前缀避免冲突
- [ ] `description` 清晰描述插件功能
- [ ] 本地工具都有 Zod schema 和 `.describe()` 注解
- [ ] 不依赖内核内部 API（DB 表名、ORM 模型、内核私有模块）
- [ ] 所有数据写入通过 proposal 或工具返回值，不直接操作 store
- [ ] 有基本的集成测试
- [ ] references/ 文件有适当的 keywords 设置

### 插件作者约束

**允许依赖的公开 API：**

- PLUGIN.md manifest 格式
- `@covel/tools` 的 `tool()` 包装函数
- 内置工具（create-form、create-choices、create-notification）
- `input.inject` 声明
- 交互协议（interaction 返回值）
- `@covel/plugin-test-utils` 测试工具

**禁止依赖：**

- 数据库表名或 ORM 模型
- 内核调度器、路由器等内部模块
- 前端组件（UI 通过 blockSchema 或交互协议集成）
- 直接 SDK 调用（LLM 调用通过 model slot 绑定）

## 8. 插件国际化（i18n）

**所有面向玩家的 UI 字符串必须用 `I18nText` 对象（至少 `zh` + `en`）。** 详情见 [docs/reference/ui-panels.md 的「插件 UI 文本 I18nText 规范」](../reference/ui-panels.md#插件-ui-文本-i18ntext-规范)。

适用范围：

| 位置                        | 必须 I18nText 的字段                                                                                                        | 示例                                                |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `plugins/<id>/ui/*.json`    | `label` / `groupLabel` / `emptyState.message` / `searchPlaceholder` / `emptyMessage` / `footer`                             | `{ "label": { "zh": "角色", "en": "Characters" } }` |
| json-render spec 叶节点     | `Text.content` / `Button.label` / `Badge.label` / `Input.placeholder` / `FormField.label` / `Alert.title` / `Alert.message` | `{ "content": { "zh": "…", "en": "…" } }`           |
| `world.yaml` / `WORLD.*.md` | `name` / `description` / dimension 描述字段                                                                                 | 世界包通过 `WORLD.zh.md` / `WORLD.en.md` 提供正文   |

无需 i18n 的情形：纯标识符（`icon` 名称、`iconColor`、状态字符串、图像 URL）、多 locale 共用的短词（`"Ping"`、`"NEW"`）、数值或布尔常量。

**回退逻辑**：`resolveI18n(value, locale)` 优先匹配当前 locale，其次语言前缀（`zh-CN` → `zh`），再退到 `en-US` / `en`，最后取对象中任一字符串。切换语言时，json-render 子树会通过 `useI18nResolver()` 自动重渲染。

**合规脚本**：

- `node scripts/check-plugin-i18n.mjs` 扫描 `plugins/**/ui/*.json`，禁止出现没有 `en` 兄弟 key 的裸中文字符串
- `pnpm check:i18n` 会同时跑应用代码（`apps/web`）与插件 JSON 两套扫描；CI 里应作为必选 gate

复杂数据输入建议采用表单优先、JSON 进阶的双入口。常用字段放在 `Input` / `Textarea` / `Select` / `Switch` 中，插件 handler 把表单 payload 规范化为内部 JSON；完整导入、迁移或调试场景保留 `Textarea` JSON 入口。`character-blueprint` 的右侧面板采用这种模式：玩家可直接填写姓名、人设、标签、关系阶段，并通过同一个 handler 写入蓝图数据与角色镜像。

**常见错误**：

```json
// ✗ 裸中文会被扫描拒绝
{ "content": "已收录到图鉴" }

// ✗ 只有中文 locale，切到 en 时不会回退到 zh
{ "label": { "zh": "世界" } }

// ✓ zh + en 双 key
{ "label": { "zh": "世界", "en": "World" } }

// ✓ 纯标识符（非自然语言），允许单字符串
{ "icon": "book-open" }
```

---

## 下一步

- 想看所有已实现插件的完整 frontmatter、调度层级、本体设计？ → [插件注册表 `docs/reference/plugins.md`](../reference/plugins.md)
- 想写交互 UI 面板的 json-render spec？ → [插件 UI 与 runtime 指南](./plugin-ui-runtime-guidelines.md)
- 想跑 runtime cases、HTTP E2E 或真实 LLM 验证？ → [插件测试指南](./plugin-testing.md) · [E2E plugin verify](./e2e-plugin-verify.md)
- 想回到入口？ → [插件开发指南 · 索引](./plugin-authoring.md)
