# PLUGIN.md Frontmatter Schema Reference

Schema 使用 Zod **strict** 模式（`runtimeManifestSchema`）— 不允许未定义字段，拼错会直接报错。

> 如果插件有多个 runtime，把 **每个** runtime 放到 `runtimes/<sub>/PLUGIN.md`，每个 PLUGIN.md 独立按本 schema 校验。框架自动扫描 `runtimes/*/PLUGIN.md`；不需要根目录合并列表。

## 核心字段

| 字段 | 类型 | 必需 | 约束 / 默认 |
|------|------|------|------|
| `name` | string | ✓ | 正则 `^[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)*$`。格式 `plugin-id` 或 `plugin-id/runtime-id` |
| `description` | string | ✓ | 至少 1 字符 |
| `priority` | int | | 0–1000（0–99 Pre-Game / 100–499 Pre-Turn / 500 Narrator / 501–999 After-Turn / 1000 Audit） |
| `version` | string | | 语义版本，可选 |
| `runtimeType` | enum | | `agent`（默认） / `function` |
| `handler` | string | | `runtimeType: function` 必需;也可用作 `agent` guard 的入口。必须是相对路径、`.js`/`.mjs`/`.cjs` 结尾 |
| `guard` | string | | agent-only:LLM 前置门控,相对路径 `.js` |
| `model` | string | | `runtimeType: agent` 用的 slot 名（`default` / `fast` / `balance` / `image` / 自定义） |
| `pluginType` | enum | | `core-plugin` / `plugin`（默认） |
| `outputKind` | enum | | `story` / `plugin`（默认） / `system` — 决定前端展示 |
| `capabilities` | string[] | | 能力标签数组，框架按标签发现插件。常用:`narrative`、`world-data-provider`、`image-generation`、`memory-panel` |
| `upstreamRequired` | string[] | | runtime ID 数组;任一 upstream 本 turn 不是 `success`,本 runtime 直接 `skipped`（不跑 guard/LLM） |
| `execution` | enum | | **仅对手动触发(`POST /plugin-rpc`)的 runtime 生效。** `sync`（默认） / `background`。background 返回 202 + `jobId`,框架写 `_jobs/<jobId>`,前端通过 `plugin-data.changed` SSE 感知 |
| `promptVersion` | `1` \| `2` | | V2 prompt assembler 闸门(需 `COVEL_PROMPT_V2=1`) |

## 超时与重试（agent only）

| 字段 | 类型 | 默认 | 含义 |
|------|------|------|------|
| `timeoutMs` | int | 60000 | 运行总时长硬上限 |
| `maxSteps` | int | 10 | 工具循环单轮最多调几次。1–2 适合单步插件 |
| `maxRetries` | int | 1 | transient 错误/超时/循环时重试次数。`0` 禁用,最多 5 |
| `callTimeoutMs` | int | `min(60000, floor(timeoutMs/(maxRetries+1)))` | 单次 LLM 调用超时 |
| `firstTokenTimeoutMs` | int | 30000 | 流式首 token (TTFB) 上限 |
| `loopDetectionThreshold` | int | 3 | 连续相同工具调用次数,命中则扰动。`0` 关 |

## `trigger`

```yaml
trigger:
  type: auto|manual|scheduled|event|error-retry   # 必需
  interval: <int>              # scheduled 时每隔 N 轮(正整数)
  maxTriggerCount: <int>       # 整个 session 最多触发次数
  startTurn: <int>             # 从第 N 主循环 turn 起介入(0-based)
  topic: <string>              # event 时订阅的事件 topic
  maxRetryCount: <int>         # error-retry 时
  cooldownTurns: <int>         # 上次触发后多少轮内不再触发
```

> **`conditional` is reserved (audit P2-9)**: schema 仍接受这个值，但 `packages/runtime/src/trigger.ts` 不解析任何条件表达式，runtime 永远不会被触发，并会在 console 打印一次性 warning。在条件表达式引擎落地前请使用 `auto`/`scheduled`/`event` 等替代。

**手动触发常用组合:**

```yaml
trigger: { type: manual }     # 只能从 POST /plugin-rpc 触发,调度器不自动调用
```

**事件链 chain:**

```yaml
trigger: { type: event, topic: image.generate.requested }  # 监听前序 runtime 发出的事件
```

## `tools`

```yaml
tools:
  builtin:                   # 框架内置工具(见 tools 清单)
    - create-form
    - create-choices
    - create-notification
    - plugin-data-set
    - plugin-data-get
    - plugin-data-list
    - plugin-data-set-batch
  local:                     # 插件自定义工具,相对 PLUGIN.md 的路径
    - ./tools/my-tool.js
```

## `input.inject`（prompt 上下文注入）

两种注入源,**discriminated** by `kind`:

```yaml
input:
  inject:
    # (1) runtime kind — 读前序 runtime 的 output 字段
    - from: narrator             # kind 省略即 runtime
      field: narrativeOutput
      as: "<narrator-output>"

    # (2) plugin-data kind — 读本插件自己的 plugin-data 状态
    - kind: plugin-data
      namespace: entries              # 本插件的 namespace
      as: "<existing-entries>"
      format: summary                 # summary(默认) / ids-only / full
      maxEntries: 50                  # 1–500,默认 50
  tools:
    - plugin: world-init
      runtime: schema-gen
```

> 使用 `plugin-data` kind 时,框架自动切到异步 context 装配路径。

## `output`

```yaml
output:
  schema: ./schemas/out.json    # JSON Schema 路径
  recordAs: my-card             # 作为 record 落库的名字
```

Agent runtime 产出 `{ output: { events: [{topic, data}] } }` 时,这些事件会在同 turn 的事件总线上发布,触发 `trigger.type: event` 的下游 runtime。

## `ui`（json-render UI 槽位）

```yaml
ui:
  right: [./ui/gallery.json]    # 右侧面板 spec 路径
  message: [./ui/card.json]     # 消息流内联 spec
  left: [./ui/sidebar.json]     # 左侧边栏 spec
```

每个 spec 文件通过 json-render 渲染。按钮点击通过 `on.click.action: "invokeRuntime"` 触发本插件的 runtime(框架默认 handler,不需要自己写)。

## `userSettings`（玩家可调设置）

```yaml
userSettings:
  - key: promptMode                        # [a-zA-Z][a-zA-Z0-9_-]*
    type: select                           # text / number / toggle / select / textarea
    default: plain
    label: { zh: "提示词模式", en: "Prompt mode" }
    description: { zh: "...", en: "..." }   # 可选
    options:                                # select 时必需
      - { value: plain,     label: { zh: "纯文本", en: "Plain" } }
      - { value: image-json, label: { zh: "结构化", en: "JSON" } }
    min: 0        # number 时可选
    max: 100
    step: 1
```

前端自动生成设置面板,值通过统一的 **SettingsStore**(`apps/web/src/settings/registry/plugin.ts`)持久化——桌面端写 `~/.covel/settings.json`,纯 Web 端写 `localStorage: covel:settings`。**没有** `/plugin-settings` REST 端点。

> **第三方插件的 `ctx.store` 是窄接口（audit P0-3）**：`pluginType: plugin`（社区/第三方）的 function runtime 收到的 `ctx.store` 是 `FunctionStoreView`（仅 `getPluginData / listPluginData / getSession / listTurnMessages`），调用 `setPluginData` 等写入方法会得到 `undefined` 并立即 TypeError。要写数据请用：
> - `ctx.pluginData.set(namespace, key, value)`：作用域绑定 sessionId+pluginId 的 placeholder 写入。
> - 在 handler 返回值的 `pluginData: [{ namespace, key, value }]`：走 proposal/commit pipeline。
> - `ctx.logger.info / warn / error`：写入插件 `_logs` 命名空间，UI/调试可消费。
>
> `pluginType: core-plugin` 才会拿到完整 `DataStore`，社区插件请勿尝试声明 `core-plugin`，bootstrap 会按 `getPluginTrustInfo` 重新分类。

浏览器发起任何需要 userSettings 的请求(例如 `POST /api/sessions/:id/plugin-rpc`)时,前端把整个 `plugin.*` 分支做成 `X-Plugin-User-Settings: base64(JSON)` 头。服务端 `apps/server/src/routes/api/plugin-rpc.ts` 解码后:

1. 塞进 `TurnInput.userSettings`(map<pluginId, map<key, value>>)。
2. 经 `resolveUserSettings`(`packages/runtime/src/turn-executor-helpers.ts`)与 `manifest.userSettings[].default` 合并——缺失键总是填回默认值,handler 可以依赖所有声明键都有值。
3. 同时暴露到两条通道:
   - **function runtime**: 作为 `ctx.userSettings`——handler 读 `ctx.userSettings.<key>` 即可;
   - **agent runtime prompt**: 作为 `{{ userSettings.<key> }}` 模板变量——PLUGIN.md 直接插值;
   - **agent runtime `guard`**(仅限声明了 `guard`/`authModule` 的 runtime): 作为 `ctx.userSettings`——`guard` 可决定 `skip` / `preGameDone`。

Agent runtime 的 **LLM 工具调用** 不会自动看到 userSettings——如果 agent 需要把用户设置传给工具,要么在 PLUGIN.md 里用 `{{ userSettings.* }}` 把值塞进 prompt,要么用 `guard` 把值塞进 `completedResults.output`。

## `hooks`

```yaml
hooks:
  - event: TurnStart               # TurnStart/PreRuntime/PostRuntime/PreToolUse/PostToolUse/PreStateCommit/PostStateCommit/TurnStop
    handler: ./hooks/audit.js
    match: { runtimeId: "narrator" }    # 可选过滤
    timeoutMs: 5000
```

## `rpc`（对前端暴露的 action handler）

```yaml
rpc:
  regenerate:                               # kebab-case,不能以 framework- 开头
    handler: ./rpc/regenerate.js
    input: ./rpc/regenerate.schema.json     # 可选 JSON Schema
    trustLevel: community                   # builtin/official/community,覆盖插件默认
    streaming: false
    description: 重新生成上一段叙事
```

前端通过 `POST /api/sessions/:id/plugin-rpc` `{pluginId, action, payload}` 调用。community 信任等级第一次会弹审批对话。

## `authorsNote` / `postHistory`（V2 prompt 段）

```yaml
authorsNote:
  content: "Stay in character."
  depth: 4               # 插入到倒数第 N 条消息之前
  role: system           # system/user/assistant

postHistory:
  content: "[System: never break the fourth wall]"
  role: system           # system/user
```

## `config`（插件级配置)

```yaml
config:
  <field>:
    type: string|integer|number|boolean|enum  # 必需
    default: <value>
    min: <number>
    max: <number>
    options: [<string>]     # enum 必需
    label: <string>
    description: <string>
```

## `i18n`

```yaml
i18n:
  en-US: ./PLUGIN.en.md    # 语言切换时换一个正文
```

## 可用 builtin 工具清单

| 工具 | 用途 |
|------|------|
| `create-form` | 创建玩家填写表单（含 `narrativeTemplate` 占位符） |
| `create-choices` | 创建选项列表 |
| `create-notification` | 显示通知消息 |
| `plugin-data-set` | 写入插件持久化数据 |
| `plugin-data-get` | 读取当前插件持久化数据 |
| `plugin-data-list` | 列出当前插件持久化数据 |
| `plugin-data-set-batch` | 批量写入 |
| `create-character` / `update-character` / `list-characters` / `get-character` | 角色记录 |

## 文件结构

```
plugins/<id>/
├── PLUGIN.md              # 单 runtime 必需
├── package.json           # 必需:{ "name": "@covel/plugin-<id>", "type": "module", "private": true }
├── PLUGIN.en.md           # 可选:i18n 分语言正文
├── tools/                 # 可选:本地 JS 工具
├── hooks/                 # 可选:hook handler
├── rpc/                   # 可选:RPC action handler
├── schemas/               # 可选:output schema / tool-factory schema
├── ui/                    # 可选:json-render spec(*.json)
├── references/            # 可选:按需加载的参考资料
└── runtimes/              # 多 runtime 插件:每个子 runtime 一个 PLUGIN.md
    └── <sub>/
        └── PLUGIN.md
```

## Handler 模块规范

**function runtime handler** (`runtimeType: function`,由 manifest `handler` 指向)。
**单参签名** —— 运行时只传 `ctx`:

```js
export default async function handler(ctx) {
  // ctx.manualPayload 来自 POST /plugin-rpc 的 payload(仅 manual 触发)
  // ctx.triggerEvent = { topic, data } (仅 event 触发)
  // ctx.gateway 是 PluginRuntimeGateway — 调 LLM/图像的唯一入口
  // ctx.completedResults: Map<runtimeId, output>,读取前序 runtime 输出
  return {
    // 任意 JSON 字段作为 runtime output 持久化给下游。以下字段会被框架
    // normalizeOutput 提取为 Proposal,走标准 commit pipeline:
    events: [{ topic: 'my.event', data: {} }],                    // → event.emit
    pluginData: [{ namespace: 'ns', key: 'k', value: { ... } }],  // → plugin.data / plugin.data.batch
    statePatches: [{ table: 'world', field: 'time', value: 'night' }], // → state.patch
    interactions: [{ type: 'form', interactionId: 'f1', ... }],   // → interaction.request
  };
}
```

> 不要在顶层返回 `proposals: [...]` 字段 —— 那是工具层的 Symbol channel,不是
> handler 公开 API,会被 normalizeOutput 忽略。

**RPC action handler** (`rpc.<action>.handler`):

```js
export default async function handler(payload, { sessionId, pluginId, action, store }) {
  // store 是窄封装(getSession / listTurnMessages / savePlayerInput /
  //   可选 plugin-data 三件套),不是完整 DataStore
  return { /* 返回 JSON 给前端 */ };
}
```

## 校验

在生成完 PLUGIN.md 后 **必须** 跑:

```bash
node --input-type=module -e "
import matter from 'gray-matter';
import { readFileSync } from 'fs';
import { validatePluginManifest, formatValidationErrors } from '@covel/shared';
const { data } = matter(readFileSync('plugins/<id>/PLUGIN.md','utf-8'));
const r = validatePluginManifest(data);
if(!r.valid){console.error(formatValidationErrors(r.errors));process.exit(1)}
console.log('OK');
"
```

如果插件不在本仓库（比如放在 `~/.covel/plugins/`），需要到 `packages/plugin-loader/` 子目录执行上面脚本（它依赖 `gray-matter` 和 `@covel/shared`）。
