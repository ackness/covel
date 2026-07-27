# PLUGIN.md Frontmatter Schema Reference

Schema 使用 Zod **strict** 模式 — 不允许未定义字段，拼错会直接报错。有两套 schema（`packages/shared/src/schemas/plugin-schemas.ts`）：

- **`runtimeManifestAuthoringSchema`（新插件按这个写）** — 严格授权目标：`auto` / `scheduled` runtime **必须声明 `stage`**。
- **`runtimeManifestSchema`（loader 实际用的）** — 与上者**共享同一份字段集**（同一个 `runtimeManifestCommonShape`，同样 `.strict()`），差别**只在跨字段约束**：它不强制「auto/scheduled 必须有 stage」，其余一致。

> **两套 schema 的字段集完全相同，不存在「compat 超集」。** `priority` / `upstreamRequired` / `jobStatus` 已被整体删除（v0.0.19 的 `refactor!: remove the legacy priority / upstreamRequired / jobStatus surface`），**任何一套都会因未知键直接判加载失败**——不存在「priority 折叠出 stage」或「upstreamRequired 别名 needs」这类兼容行为。调度只能用 `stage` + `needs` / `after` / `inputs` 表达。

两套 schema 都**拒绝** `trigger.type: conditional / error-retry`（已从枚举移除，声明即加载失败）。

> 如果插件有多个 runtime，把 **每个** runtime 放到 `runtimes/<sub>/PLUGIN.md`，每个 PLUGIN.md 独立按本 schema 校验。框架自动扫描 `runtimes/*/PLUGIN.md`；不需要根目录合并列表。
>
> **可选的根 PLUGIN.md（多 runtime 场景）**：在根目录额外放一份**仅含摘要 frontmatter** 的 `PLUGIN.md`（只读 `name` / `description` / `pluginType`，**不**作为 runtime），框架用它做包级 displayName，决定 UI 上展示的插件名。**没有**根 PLUGIN.md 时，UI 会回退显示 plugin id（如 `dashscope-image-gen`）。第三方插件作者强烈建议提供。`name` 推荐写 `I18nText`：`{ "zh-CN": "DashScope", "en-US": "DashScope" }`。

## 核心字段

| 字段 | 类型 | 必需 | 约束 / 默认 |
|------|------|------|------|
| `name` | string | ✓ | 正则 `^[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)*$`。格式 `plugin-id` 或 `plugin-id/runtime-id` |
| `description` | string \| I18nText | ✓ | 单 string 或 `{ zh: "...", en: "..." }` map（**推荐 I18nText**，map 至少一个 locale 条目）。loader 会折叠成单 string 供 trace/工具注册使用，UI 仍读原始 I18nText |
| `stage` | enum | auto/scheduled 必需 | `setup` / `pre-turn` / `narrative` / `post-turn` / `audit`。见下「调度声明」 |
| `after` | array | | 弱排序依赖（只排序不设门）。见下「调度声明」 |
| `needs` | array | | 强依赖（排序 + 门控）。见下「调度声明」 |
| `inputs` | map | | 类型化同回合数据绑定 → `ctx.inputs.<name>`。见下「调度声明」 |
| `version` | string | | 语义版本，可选 |
| `runtimeType` | enum | | `agent`（默认） / `function` |
| `handler` | string | | `runtimeType: function` 必需;也可用作 `agent` guard 的入口。必须是相对路径、`.js`/`.mjs`/`.cjs` 结尾 |
| `guard` | string | | agent-only:LLM 前置门控,相对路径 `.js` |
| `model` | string | | `runtimeType: agent` 用的 slot 名（`default` / `fast` / `balance` / `image` / 自定义） |
| `pluginType` | enum | | `core-plugin` / `plugin`（默认） |
| `outputKind` | enum | | `story` / `plugin`（默认） / `system` — 决定前端展示 |
| `capabilities` | string[] | | 能力标签数组，框架按标签发现插件。常用:`narrative-engine`、`world-data-provider`、`image-generation`、`memory-panel`。自由标签合法，但拼错框架已知标签会在 bootstrap 时 warn |
| `execution` | enum | | **仅对手动触发(`POST /plugin-rpc`)的 runtime 生效。** `sync`（默认） / `background`。background 返回 202 + `jobId`,框架走 kernel job-status 流,前端通过 `plugin-data.changed` SSE 感知 |
| `resultFormat` | enum | | `legacy`（默认）/ `envelope-v1`。envelope-v1 时 handler 返回 `{outcome: success\|suspended\|skipped\|failed, ...}` 判别联合；setup 完成信号用 `completion: "done"` |
| `effects` | object | | `{reads?, writes?, parallelSafe?}` 显式读写集声明，用于同层并行冒险检测。资源键如 `state:*`、`plugin-data:self:<ns>`、`event:<topic>`、`http:https://<host>` |
| `permissions` | object | | `{http: [{origin, methods?}]}` — 出网 allowlist，管的是 `ctx.utils.fetchWithRetry`（entry 侧同一组 helper 叫 `covel.http`）。`origin` 必须是规范 https origin（无路径/查询），`methods` 默认仅 GET。**只对 community 插件 fail-closed 强制**；builtin / official 视为可信直接放行（SSRF 校验两边都照跑） |
| `relations` | object | | `{provides?, requires?, recommends?, conflicts?}`，元素是插件 id 或 `{id, ...}`。**插件选择 UI 和 pack 解析读它**——`requires` 会把上游插件一并带进会话。它不改变执行语义（那是 trigger + 调度声明的事），但少写会让玩家只勾了你的插件时缺依赖 |
| `dataSchemas` | map | | 本插件 plugin-data 各 namespace 的 schema 声明：`{namespace, schemaVersion, acceptsWorldData, schema（JSON Schema 相对路径）, description?}`。`acceptsWorldData: true` 才允许世界包的 worldData 往这个 namespace 灌数据 |
| `memoryBlocks` | array | | 本插件贡献的 core-memory 块（`label` / `displayName` / `extractionHint` 必需，`icon` / `maxChars` 可选）。框架跨全部活跃插件聚合后驱动回合后抽取与 prompt 渲染；世界包也能加自己的块 |
| `summaryFocus` | string[] | | 历史压缩（Compactor）时要求保留的主题，如 `['narrative', 'world-facts']`。框架聚合全部活跃 runtime 的声明后交给摘要 LLM |
| `maxRecursionDepth` | number | | 本 runtime 的 `ctx.recursiveCall()` 最大嵌套深度，默认取执行器上限（当前 10） |

## 调度声明（stage / after / needs / inputs）

调度用**命名阶段 + 依赖**声明（数字 `priority` 调度器已删除）。语义详版见 `docs/guide/plugin-authoring.md#调度声明`。

- **`stage`** — `setup`（游戏初始化，`phase === "setup"` 时运行）· `pre-turn` · `narrative` · `post-turn` · `audit`（主循环按此顺序，阶段间严格屏障）。同阶段内先后**只由依赖决定**，无依赖并发跑。
- **`after`** — 弱排序：目标失败/缺席不拦本 runtime。每项：`"runtime-id"` 或 `{ runtime }` 或 `{ capability, cardinality? }`。
- **`needs`** — 排序 + 门控：目标本次未成功 → 本 runtime `skipped`。每项额外可带 `scope`：`turn`（默认，同回合成功）/ `session`（对执行开始时冻结的持久快照判定，仅 setup 用）。`cardinality: one`（默认，任一提供者成功即可）/ `all`。
- **`inputs`** — 把上游依赖升级为类型化绑定，function 解析进 `ctx.inputs.<name>`（provenance 包装的 InputSlot），agent 注入保留 prompt 块：

```yaml
needs:
  - capability: narrative-engine   # 门控:叙事引擎本轮成功才跑
inputs:
  narrative:
    from: { capability: narrative-engine, cardinality: one }
    select: "/narrativeOutput"     # RFC 6901 JSON Pointer,指进生产方成功 value
    required: false                # true 蕴含 needs(turn) 门;false 蕴含 after
    # accepts: ./schemas/x.json    # 可选:runtime 目录相对 JSON Schema 校验注入值
```

handler 里读：`ctx.inputs.narrative?.value`（`cardinality: all` 时是 `.items[].value`）。参考 `plugins/mimo-tts/runtimes/auto-narrate/`。

**跨字段硬约束**（违反即校验失败）：

- `auto` / `scheduled` runtime **必须**声明 `stage`（authoring schema）；`event` / `manual` runtime **不可**声明 `stage`（它们由事件/RPC 拉起，不进阶段 DAG）。
- `stage: setup` 的 trigger 必须是 `auto`，且不可带 `interval` / `startTurn` / `cooldownTurns`（`maxTriggerCount` 可作重试预算）。setup runtime 通过输出 `preGameDone: true`（legacy）或 `completion: "done"`（envelope-v1）报告完成。
- `needs` 的 `scope: session` **只在 `stage: setup` 上合法**（它对准持久 setup 快照判定；其它 stage 声明会被两套 schema 直接拒绝）。
- `event` / `manual` + `execution: background` 的 runtime 不可声明 `inputs` 绑定（永远 detached，绑定无法满足）。

> 另有一条 server 装载期 warning：`auto` / `scheduled` 却没有 `stage`、又不是纯 ui / hooks / entry / wires 注册面的 runtime，会收到 `schedulable-missing-stage` 警告（这类声明被当作 UI-only 习语，永不调度）。按本文档生成的插件不会触发它。

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
  type: auto|manual|scheduled|event   # 仅这四种；conditional / error-retry 已从枚举移除,声明即加载失败
  interval: <int>              # scheduled 时每隔 N 轮(正整数)
  maxTriggerCount: <int>       # 整个 session 最多触发次数(setup runtime 时 = 重试预算)
  startTurn: <int>             # 从第 N 主循环 turn 起介入(0-based)
  topic: <string>              # event 时必需:订阅的事件 topic(跨字段强制)
  cooldownTurns: <int>         # 上次触发后多少轮内不再触发
```

**手动触发常用组合:**

```yaml
trigger: { type: manual }     # 只能从 POST /plugin-rpc 触发,调度器不自动调用
```

**事件链 chain:**

```yaml
trigger: { type: event, topic: image.generate.requested }  # 监听前序 runtime 发出的事件
```

## `events`（事件契约声明，统一事件层）

消费方 runtime 在 frontmatter 声明它订阅/发出的事件契约（参考实现：`plugins/scene-stage/runtimes/resolver/PLUGIN.md`）：

```yaml
events:
  - topic: scene.set                        # 事件 topic
    schema: ./schemas/scene-set.event.json  # 插件根相对 JSON Schema，校验 data payload
    description:                            # I18nText，会进发射方的 <available-events> 目录
      zh: "发射条件：开场确立场景 / 场景切换 / 昼夜变化"
      en: "Emit on opening scene, scene change, or day-night shift"
  - topic: my-plugin.internal.signal
    schema: ./schemas/signal.event.json
    advertise: false                        # 内部信令：agent 不可经 emit-event 发射，也不进目录
```

发射方 agent 配套声明：

```yaml
advertiseEvents: true    # prompt 段 5 自动注入当前 session 所有 advertise 事件目录
tools:
  builtin:
    - emit-event         # LLM 命中契约时调用；未知 topic / payload 不合 schema 会拿到可读错误重试
```

同 topic 每回合去重（重复 emit 被跳过并提示 LLM）。schema 路径必须是插件根相对路径（zod 拒绝绝对路径和 `..`）。

## `requireToolUse`（agent only）

```yaml
requireToolUse: true # 零成功工具调用就收场时，注入一条纠正消息重试一次（第二次放行 + warn）
```

适合唯一职责就是调某个工具、却容易漂移成续写正文的 runtime（如 `scene-prompts` 每回合必须调 `generate-scene-prompts`）。

## `tools`

```yaml
tools:
  builtin: # 框架内置工具,写名字
    - create-form
    - plugin-data-set
  plugin: # 本插件自有工具,写工具 NAME(不是路径),由 entry 模块注册
    - generate-guide
  defer: true # 可选:true 延迟整份白名单;或 [名字] 只延迟这几个(tool-search 按需拉取)
```

内置工具全集（权威清单见 `docs/reference/tools.md`）：

```
create-character  create-choices  create-form  create-notification  emit-event
get-character  list-characters  render-ui  runtime-done  suspend  update-character
memory-get-block  memory-search  memory-update-block  world-dimension-get
plugin-data-get  plugin-data-list  plugin-data-set  plugin-data-set-batch
```

> **`tools.local` 已被移除**（schema strict，声明即加载失败，报错会指向替代写法）。插件自有工具改走 `entry` 模块注册：工厂放 `tools/`，`entry: ./server/index.js` 里 `covel.registerTool(...)`，然后把**工具名**列进 `tools.plugin`。完整写法见 `references/tool-factory.md`。

## `input.inject`（prompt 上下文注入）

三种注入源,**discriminated** by `kind`（`kind` 必填,不可省略）:

```yaml
input:
  schema: ./schemas/activation.json  # 可选:校验激活载荷(manual RPC / event payload),派发前强制
  inject:
    # (1) runtime kind — 读前序 runtime 的 output 字段(同回合)
    - kind: runtime
      from: narrator
      field: narrativeOutput
      as: "<narrator-output>"

    # (2) plugin-data kind — 读本插件自己的 plugin-data 状态
    - kind: plugin-data
      namespace: entries              # 本插件的 namespace
      as: "<existing-entries>"
      format: summary                 # summary(默认) / ids-only / full
      maxEntries: 50                  # 1–500,默认 50

    # (3) runtime-export kind — 跨执行读生产方持久化的 recordAs 导出
    #     (读"本次执行开始前最后一次 commit"的版本;生产方需声明 output.recordAs + output.schema)
    - kind: runtime-export
      name: worldSchema               # 绑定名 → ctx.exports.worldSchema
      from: { capability: world-data-provider }
      recordAs: world-schema          # 生产方 output.recordAs 的名字
      required: false
  tools:
    - plugin: world-init
      runtime: schema-gen
```

> 使用 `plugin-data` kind 时,框架自动切到异步 context 装配路径。
> 同回合读上游优先用顶层 `inputs` 绑定(见「调度声明」),`kind: runtime` 是它的 legacy 前身。

## `output`

```yaml
output:
  schema: ./schemas/out.json    # JSON Schema 路径
  recordAs: my-card             # 作为持久化导出落库的名字(供下游 kind: runtime-export 消费)
```

> 跨字段约束:声明 `recordAs` 必须同时声明 `schema`(导出值必须可校验)。

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
2. 经 `resolveUserSettings`(`packages/runtime/src/turn-executor/turn-executor-helpers.ts`)与 `manifest.userSettings[].default` 合并——缺失键总是填回默认值,handler 可以依赖所有声明键都有值。
3. 同时暴露到两条通道:
   - **function runtime**: 作为 `ctx.userSettings`——handler 读 `ctx.userSettings.<key>` 即可;
   - **agent runtime prompt**: 作为 `{{ userSettings.<key> }}` 模板变量——PLUGIN.md 直接插值;
   - **agent runtime `guard`**(仅限声明了 `guard`/`authModule` 的 runtime): 作为 `ctx.userSettings`——`guard` 可决定 `skip` / `preGameDone`。

Agent runtime 的 **LLM 工具调用** 不会自动看到 userSettings——如果 agent 需要把用户设置传给工具,在 PLUGIN.md 里用 `{{ userSettings.* }}` 把值塞进 prompt,让 LLM 把值填进工具参数。

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

## ~~`config`~~（已废弃）

`config` 字段已移除——loader 会剥离它并打 deprecation warning。玩家可调配置一律用 `userSettings`（见上）。

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
| `emit-event` | 发射已声明契约的事件（配 `advertiseEvents: true`；payload 按声明方 schema 校验，同 topic 每回合去重） |

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
  // ctx.inputs.<name> — frontmatter inputs 绑定的解析结果(读同回合上游的唯一通道,见「调度声明」)
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

在生成完 PLUGIN.md 后 **必须** 跑（仓库根目录）:

```bash
pnpm validate:plugin plugins/<id>            # 或 ~/.covel/plugins/<id>;目录自动含 runtimes/*/PLUGIN.md
```

一次跑两道：loader compat 解析（能否加载，报错带行号；自动折叠 I18nText `description`）+ strict authoring schema（缺 stage / 误写 legacy 字段直接报错）。`--compat` 只用于存量 legacy manifest。脚本源码：`packages/plugin-loader/scripts/validate-manifest.ts`。
