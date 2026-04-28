# 插件开发指南 · 高级（TypeScript + 审批 + 发布）

> 面向**专业开发者**：要吃下完整类型系统、写复杂的 `TestHarness` 断言、自定义审批规则、拆多 runtime 插件，并最终发布到社区。

> **前置要求**：先完成 [零代码](./plugin-authoring-zero-code.md) 和 [进阶（agent + 本地 JS）](./plugin-authoring-agent.md)。

> **读完你能做到**
> - 从 `@covel/shared` / `@covel/plugin-loader` 导入并正确使用插件相关类型
> - 用 MockLLM 的响应队列 + 自定义工具 + 多轮 harness 做复杂集成测试
> - 用 `createApprovalPipeline` 定制工具审批规则（allow / ask / deny）
> - 在一个插件里组织多个 runtime（`runtimes/*/PLUGIN.md`）
> - 按发布 checklist 完成社区插件的上架准备
> - 满足 `I18nText` 规范让插件 UI 文本双语化

---

## 1. 完整的类型系统

所有插件相关类型都从 `@covel/shared` 导出：

```typescript
import type {
  // 插件类型
  PluginType,           // 'core-plugin' | 'plugin'
  PluginManifest,       // 完整插件清单
  RuntimeManifest,      // 运行时清单（PLUGIN.md frontmatter 的解析结果）

  // 触发系统
  TriggerType,          // 'auto' | 'manual' | 'scheduled' | 'event' | 'error-retry'（conditional 为 reserved）
  TriggerConfig,        // { type, interval?, condition?, topic?, maxTriggerCount?, cooldownTurns? }

  // 输入/输出
  InputConfig,          // { inject?, tools? }
  InputInjectDecl,      // { from, field, as }
  OutputConfig,         // { schema?, recordAs? }

  // 工具
  ToolsConfig,          // { builtin?, local? }

  // 配置
  ConfigFieldType,      // 'string' | 'integer' | 'number' | 'boolean' | 'enum'
  PluginConfigField,    // { type, default?, min?, max?, options?, label?, description? }

  // 运行时数据
  TurnInput,            // 每轮输入
  TurnResult,           // 每轮输出
  RuntimeResult,        // 单个 runtime 的执行结果
} from '@covel/shared';
```

从 `@covel/plugin-loader` 获取加载相关类型：

```typescript
import type {
  ParsedPluginMd,       // 解析后的 PLUGIN.md
  ParsedReference,      // 解析后的参考文件
  PluginDiscoveryResult,// 发现结果
  LoadedRuntime,        // 完全加载的 runtime
  PluginRegistryEntry,  // 注册表条目
  PluginSource,         // 'builtin' | 'official' | 'community'
  PluginTrustInfo,      // { source, requiresApproval, autoLoad }
} from '@covel/plugin-loader';
```

## 2. TestHarness 高级用法

**自定义 MockLLM 响应队列：**

```typescript
const mockLLM = new MockLLM();

// 默认响应
mockLLM.defaultResponse = {
  content: '你来到了一片神秘的森林...',
  toolCalls: [],
  finishReason: 'stop',
  usage: { inputTokens: 100, outputTokens: 50 },
};
```

**注入额外工具：**

```typescript
import { tool } from '@covel/tools';
import { z } from 'zod';

const customTool = tool({
  name: 'test-helper',
  description: 'Test helper tool',
  parameters: z.object({ value: z.string() }),
  execute: async (params) => ({ echoed: params.value }),
});

const harness = await createTestHarness({
  pluginsDir: path.resolve(__dirname, '../../'),
  tools: [customTool],  // 额外注册的工具
});
```

**断言 Store 状态：**

```typescript
const harness = await createTestHarness({ pluginsDir: '...' });
await harness.executeTurn('开始游戏');

// 通过 store 检查持久化的数据
const store = harness.store;
// store 实现了 DataStore 接口，可以查询 state、events、records 等
```

**多轮测试：**

```typescript
const harness = await createTestHarness({ pluginsDir: '...' });

// 第一轮
const result1 = await harness.executeTurn('开始游戏');

// 第二轮（TestHarness 自动递增 turnId）
const result2 = await harness.executeTurn('我要去探索森林');

// 断言跨轮状态变化
expect(mockLLM.calls).toHaveLength(2);
```

## 3. 审批管线

工具调用经过 `ApprovalPipeline` 审批。当前默认规则：

| 来源 | 规则 | 说明 |
|------|------|------|
| `builtin:*` | allow | 框架内置工具，始终放行 |
| `local:*` | allow | 插件本地工具，自动放行 |
| `third-party:*` | deny | 未知来源工具，拒绝执行 |

**自定义审批规则（用于测试或特殊场景）：**

```typescript
import { createApprovalPipeline } from '@covel/approval';
import type { PermissionRule } from '@covel/approval';

const rules: PermissionRule[] = [
  { pattern: 'builtin:*', action: 'allow' },
  { pattern: 'local:*', action: 'allow' },
  { pattern: 'dangerous-tool', action: 'ask' },    // 需要玩家确认
  { pattern: 'third-party:*', action: 'deny' },
];

const pipeline = createApprovalPipeline(store, rules);

// 检查工具是否需要审批
const result = pipeline.check(
  { toolName: 'dangerous-tool', sessionId: 'sess-1', turnId: 'turn-1' },
  'local',
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

## 4. 多 Runtime 插件

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
  readonly config?: Readonly<Record<string, PluginConfigField>>;
}
```

## 4.1 函数 Runtime、手动触发与后台执行

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

| 字段 | 类型 | 用途 |
|------|------|------|
| `sessionId` | `string` | 当前 session ID |
| `turnId` | `string` | 当前 turn ID(触发该 runtime 的 turn) |
| `pluginId` / `runtimeId` | `string` | 本 runtime 的身份(和 manifest 里一致) |
| `locale` | `string` | `zh-CN` / `en` / ...,来自 session / 请求 |
| `store` | `FunctionStoreView` | 绑定当前 session/plugin 的只读 DataStore 视图：`getPluginData(namespace, key)` / `listPluginData(namespace)` / `getSession()` / `listTurnMessages(limit?)`。写入使用 `ctx.pluginData` 或 handler return 值 |
| `gateway` | `PluginRuntimeGateway?` | 文本/object 生成 + slot 解析。签名见下 |
| `utils` | `PluginRuntimeUtils?` | SSRF 安全的 URL 校验 + 带重试的 fetch。插件自管 wire 时使用 |
| `manualPayload` | `unknown?` | 仅在 `POST /plugin-rpc` 手动触发时注入,为请求体的 `payload` 字段 |
| `triggerEvent` | `{ topic, data }?` | 仅 event 触发时存在,包含触发该 runtime 的事件 |

**`ctx.gateway`:** function runtime 调用 LLM 的入口。绝不允许直接 `fetch` 文本 provider URL 或导入文本 SDK —— 这样会跳过 slot 解析、密钥管理、SSRF 防护和 replay cache。

```ts
// 文本补全
const res = await ctx.gateway.generateText({
  presetId: 'fast',                                // 可选;缺省走 manifest.model / default slot
  messages: [{ role: 'user', content: '...' }],
});

// 解析 slot 配置(图像 / 自管 wire 的插件用)
const slot = ctx.gateway.resolveSlot({ presetId: 'image', fallbackTag: 'image' });
if (slot) {
  // slot = { presetId, provider, baseUrl, apiKey, model, tag, metadata, ... }
  // 拿到凭据后用任意 SDK / fetch 调供应商
}
```

> **图像生成的设计:** 框架提供 `resolveSlot` / `ctx.media` / `asset.generate` 三个稳定原语。图像 wire(OpenAI Images / DashScope wan2.x 异步轮询 / Replicate / fal 队列 / Midjourney)由插件自管:可以用 Vercel AI SDK、`openai` SDK、原生 fetch、自写状态机。provider 返回的 `b64_json` 或临时 URL 只作为 wire 层响应处理,handler 必须立即写入 `ctx.media.put()` 或 `ctx.media.ingestUrl()`,完成态返回 `assetGenerations[]`。参考 `dashscope-image-gen` / `openai-image-gen` 两个内置实现。

> **结构化 JSON 输出(未在函数 runtime 中可用,审计 F9):** `ctx.gateway.generateObject`
> 需要宿主向 gateway 注入 JSON Schema → Zod 的转换器,目前组合根未接入。若需要
> 结构化输出,请用 **agent runtime** 的 `output.schema` / `responseFormat` 路径 ——
> 框架在那里自动处理 schema → provider-specific grammar。
> 待某个插件真正需要 function-runtime 下的 `generateObject` 时,再引入转换器。

**`ctx.utils`:** 自管 wire 的插件必须经过这里调用网络,不要直接 `fetch`,以保持 SSRF 守卫和重试策略统一。

```ts
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

### `execution: sync` vs `execution: background`

```yaml
runtimeType: function
execution: background    # 默认 sync
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
runtimeType: agent                     # 用 LLM 生成 prompt
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
runtimeType: function                  # 纯 JS,直接调 provider
execution: background                  # 不阻塞 turn
trigger:
  type: event
  topic: image.generate.requested
handler: ./image-handler.js
```

```ts
// runtimes/image-generator/image-handler.js
//
// Plugin-owned wire: 框架只通过 ctx.gateway.resolveSlot() 给凭据,
// 不参与图像 HTTP 形态。可换成 Vercel AI SDK / openai SDK / 直 fetch /
// 自写轮询;参考 dashscope-image-gen 或 openai-image-gen 两个内置实现。
export default async function handler(ctx) {
  const prompt = ctx.triggerEvent?.data?.prompt;

  // 1. 拿 slot 凭据(凭据全部住在 ~/.covel/llm.toml,不复制到插件设置)
  const slot = ctx.gateway.resolveSlot({ presetId: 'image', fallbackTag: 'image' });
  if (!slot) throw new Error('image slot not configured in llm.toml');

  // 2. SSRF 守卫
  const guard = ctx.utils.validateBaseUrl(slot.baseUrl);
  if (!guard.ok) throw new Error(`Bad baseUrl: ${guard.reason}`);

  // 3. 任选 SDK 或裸 fetch 调供应商。这里演示 OpenAI Images API 同步形态。
  const response = await ctx.utils.fetchWithRetry(`${slot.baseUrl}/images/generations`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${slot.apiKey}`,
    },
    body: JSON.stringify({ model: slot.model, prompt, n: 1, response_format: 'b64_json' }),
  });
  const payload = await response.json();
  const first = payload.data?.[0] ?? {};
  const mimeType = 'image/png';
  let ref = null;
  if (typeof first.b64_json === 'string') {
    ref = await ctx.media.put(Buffer.from(first.b64_json, 'base64'), mimeType, {
      prompt,
      provider: slot.provider,
      model: slot.model,
    });
  } else if (typeof first.url === 'string') {
    ref = await ctx.media.ingestUrl(first.url, {
      allowedMimes: ['image/png', 'image/jpeg', 'image/webp'],
      meta: { prompt, provider: slot.provider, model: slot.model },
    });
  }
  if (!ref) throw new Error('image provider returned no usable media');

  return {
    imageId: ctx.turnId,
    status: 'done',
    ref,
    // framework picks this up → commits one plugin.data proposal for gallery indexing
    pluginData: [
      { namespace: 'images', key: ctx.turnId, value: { status: 'done', ref, prompt, mimeType } },
    ],
    // framework normalizes this to Proposal{ type: 'asset.generate' }
    assetGenerations: [
      {
        ref,
        modality: 'image',
        meta: { prompt, provider: slot.provider, model: slot.model },
      },
    ],
  };
}
```

## 5. 发布和分享

### 插件信任等级

| 来源 | 标识 | 加载方式 |
|------|------|---------|
| `builtin` | 绿色徽章 | 自动加载，无需确认 |
| `official` | 绿色徽章 | 白名单匹配，自动加载 |
| `community` | 橙色/红色警告 | 需用户确认后加载 |

### 插件最低要求

一个可发布的插件至少需要：

```
my-plugin/
├── PLUGIN.md       # 必需：frontmatter + 提示词
└── package.json    # 必需：workspace 依赖声明
```

### 发布检查清单

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

## 6. 插件国际化（i18n）

**所有面向玩家的 UI 字符串必须用 `I18nText` 对象（至少 `zh` + `en`）。** 详情见 [docs/reference/ui-panels.md 的「插件 UI 文本 I18nText 规范」](../reference/ui-panels.md#插件-ui-文本-i18ntext-规范)。

适用范围：

| 位置 | 必须 I18nText 的字段 | 示例 |
|------|---------------------|------|
| `plugins/<id>/ui/*.json` | `label` / `groupLabel` / `emptyState.message` / `searchPlaceholder` / `emptyMessage` / `footer` | `{ "label": { "zh": "角色", "en": "Characters" } }` |
| json-render spec 叶节点 | `Text.content` / `Button.label` / `Badge.label` / `Input.placeholder` / `FormField.label` / `Alert.title` / `Alert.message` | `{ "content": { "zh": "…", "en": "…" } }` |
| `world.yaml` / `WORLD.*.md` | `name` / `description` / dimension 描述字段 | 世界包通过 `WORLD.zh.md` / `WORLD.en.md` 提供正文 |

无需 i18n 的情形：纯标识符（`icon` 名称、`iconColor`、状态字符串、图像 URL）、多 locale 共用的短词（`"Ping"`、`"NEW"`）、数值或布尔常量。

**回退逻辑**：`resolveI18n(value, locale)` 优先匹配当前 locale，其次语言前缀（`zh-CN` → `zh`），再退到 `en-US` / `en`，最后取对象中任一字符串。切换语言时，json-render 子树会通过 `useI18nResolver()` 自动重渲染。

**合规脚本**：
- `node scripts/check-plugin-i18n.mjs` 扫描 `plugins/**/ui/*.json`，禁止出现没有 `en` 兄弟 key 的裸中文字符串
- `pnpm check:i18n` 会同时跑应用代码（`apps/web`）与插件 JSON 两套扫描；CI 里应作为必选 gate

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
- 想跑端到端 API harness + 真实 LLM 验证？ → [插件测试指南](./plugin-testing.md) · [E2E plugin verify](./e2e-plugin-verify.md)
- 想回到入口？ → [插件开发指南 · 索引](./plugin-authoring.md)
