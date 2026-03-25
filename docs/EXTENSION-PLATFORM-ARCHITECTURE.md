# MVP Extension Platform Architecture

> This document intentionally supersedes earlier extension-scope constraints in `docs/architecture/specs/*` for the package platform part of the MVP. If there is a conflict, follow this document for package/runtime design.

## 1. Scope

这份文档直接回答当前最重要的问题：

- `covel` 能不能把后续大部分玩法系统都做成 extension / package。
- 如果现在就是 MVP，允许破坏性改动，那么 package 平台应该一次性按什么形态定下来。

这份文档刻意不再写“分阶段迁移”。

结论也先写清楚：

- 当前实现还不够。
- 但当前仓库的模块边界已经足够支撑一次性的架构重排。
- 这次应该把 `Package manifest` 固定为项目自己的 `schemaVersion: "1.0"`，但重定义它在 MVP 中真正开放的能力。

## 2. Direct Decisions

### 2.1 Package Manifest 保持 v1

不引入项目内的 `v2 / v3`。

原因：

- 现在主框架本身还没完成。
- 引入多个 manifest 代际没有收益。
- 现在最需要的是把 `v1` 定成一个真正可用的 MVP 契约，而不是继续保留一个“只支持 commands”的过渡版。

因此本文中的 `Package manifest v1` 是：

- `schemaVersion: "1.0"`
- 但字段能力会比当前代码里实现的 `1.0` 更完整
- 这属于 pre-release 下允许的破坏性重定义

### 2.2 Package 是正式扩展单位

项目内统一采用：

- `Package`
  - 运行时装载单位
- `Extension Platform`
  - 这套整体能力平台
- `SKILL.md`
  - 面向 agent/LLM 的说明层，不是执行契约本体

### 2.3 只支持受信任 Package

MVP 先不做 Marketplace，也不做第三方 remote install。

信任模型固定为：

- 只支持仓库内第一方 package
- 或显式批准的本地 package

这意味着：

- 现在不需要像 Chrome Extension 一样处理开放生态审核
- 但仍然要保留声明式权限、批准、审计和宿主边界

### 2.4 不允许业务层和 Package 直连 Provider

所有模型调用必须继续走 `modules/model-gateway`。

Package 不允许：

- 直接请求 OpenAI / Anthropic / DashScope / OpenRouter HTTP API
- 直接持有 provider SDK client
- 自己管理 provider fallback

Package 只能声明：

- 我要执行什么任务
- 我要什么能力
- 我要什么输入输出 schema

宿主负责：

- preset / profile / task binding
- model / provider / fallback
- observability
- secret handling

## 3. External OSS Patterns Worth Borrowing

这次设计主要参考下面几类 OSS，而不是照搬其中任何一个系统：

### 3.1 VS Code

主要借这几个点：

- declarative contribution points
- activation events
- extension host boundary
- command + UI contribution 的明确宿主边界

适合借鉴的不是“编辑器 UI”，而是：

- extension 只声明贡献点
- 宿主决定什么时候激活
- 宿主决定哪些能力对 extension 开放

参考：

- <https://code.visualstudio.com/api/references/contribution-points>
- <https://code.visualstudio.com/api/references/activation-events>

### 3.2 Backstage

主要借：

- 明确的 extension points
- plugin / module 边界
- frontend 和 backend contribution 分离

适合 `covel` 的点是：

- package 不应该“任意侵入”
- 它必须挂在明确的 extension points 上

参考：

- <https://backstage.io/docs/plugins/new-backend-system>
- <https://backstage.io/docs/frontend-system/architecture/extensions>

### 3.3 n8n

主要借：

- 节点/能力声明和执行契约
- credential separation
- workflow composition

对 `covel` 最有价值的是：

- capability 自己是被声明和注册的
- credentials 是平台对象，不是节点私货
- 执行输入输出必须结构化

参考：

- <https://docs.n8n.io/integrations/creating-nodes/overview/>
- <https://docs.n8n.io/integrations/creating-nodes/build/reference/credentials-files/>

### 3.4 SillyTavern

主要借：

- connection profiles / presets / prompt composition
- 多层上下文拼装
- narrative 系统里的 profile 管理经验

对 `covel` 最有价值的是：

- story、choice、image、tts 不应共用一个裸 preset 概念
- prompt composition 必须是一等能力

参考：

- <https://docs.sillytavern.app/usage/core-concepts/connection-profiles/>
- <https://docs.sillytavern.app/usage/core-concepts/prompt-overview/>

### 3.5 ComfyUI 与 Flowise

主要借：

- typed node / typed IO
- artifact-oriented workflow
- graph execution
- tool/model/workflow 节点注册

对 `covel` 的启发是：

- image / audio 不该只是“再发一次文本模型”
- media 任务天然适合 capability + job + artifact 三段式

参考：

- <https://docs.comfy.org/>
- <https://docs.flowiseai.com/>

## 4. What The Current Repo Already Has

当前仓库里真正可继续沿用的基础：

- `modules/package-runtime`
  - discover / enable / manifest parse / path safety
- `modules/command-system`
  - slash command parse + dispatch
- `modules/flow-engine`
  - `send_message` / `execute_command` / `submit_block_response`
- `modules/contracts`
  - action / SSE / block envelope
- `modules/storage`
  - worlds / sessions / messages / artifacts / pending blocks / traces
- `modules/context-graph`
  - context node 去重排序
- `modules/prompt-graph`
  - prompt budget selection
- `modules/model-gateway`
  - text / object / stream / embed 基础出口

真正不能继续保持现状的地方：

- package 现在主要只接上 command
- `context` 贡献没有进 turn 主链路
- `renderer` 贡献没有进 Web Host
- 没有 capability runtime
- 没有 package state store
- 没有 image / speech / transcription gateway mode
- block response 现在还是“泛型恢复”，而不是 package-owned state machine

## 4.1 Current Frontend/Backend UI Scheme

这里专门澄清当前仓库真实采用的前后端交互方案，以及它和旧项目“后端/LLM 输出 schema，前端按预设组件渲染”的关系。

### 当前真实方案

#### 后端

- 主协议是：
  - `HTTP /actions`
  - `SSE` 返回流式事件
- 统一输出单位是 `BlockEnvelope`
  - 不再是随便一段 JSON
  - 结构由 `modules/contracts/src/block.ts` 定义
- package command 可以返回：
  - `content`
  - `blocks`
- 当前真正稳定产生 block 的路径主要是：
  - package command，例如 `core-guide`
  - 而不是普通 narration turn

#### 前端

- 前端消费 SSE
- `block.emitted` 会进入 `pendingBlock`
- 当前 Web Host 会直接渲染少数宿主已知 block 结构
  - 尤其是 `choices`
- package manifest 里虽然能声明 renderer
  - 但当前 Web Host 并没有真正动态加载 package renderer

### 这和旧方案的关系

你原先的做法更接近：

- 前端内置一批标准 UI 组件
- 后端或 LLM 输出 schema
- 前端根据 schema 和 type 渲染

当前 `covel` 则是：

- 已经有 `block envelope + schema path + response schema` 这层契约
- 但还没有真正形成完整的 `renderer registry + schema fallback runtime`

所以它现在是：

- typed block protocol 雏形

而不是：

- 完整的 schema-driven UI platform

### Current vs Target

| 维度 | 当前仓库 | 目标方案 |
|---|---|---|
| 后端输出 UI 的单位 | `BlockEnvelope` | `BlockEnvelope` |
| block 来源 | 主要来自 package command | 来自 package command、package hook、job completion、capability workflow |
| LLM 是否直接自由输出任意 UI JSON | 基本没有正式开放 | 不开放自由 JSON，只允许输出已声明 block schema 对应的数据 |
| schema 的角色 | 主要是声明和约束 | 声明、校验、前端 fallback 渲染、恢复协议的一部分 |
| renderer 的角色 | manifest 可声明，但前端未真正接线 | host renderer registry + schema fallback |
| 前端渲染方式 | 宿主硬编码少数 block UI | 已知 renderer 静态注册，未知 block 走 schema renderer |
| block response 恢复 | 泛型恢复，当前偏弱 | package-owned resume handler |

### Final UI Principle

最终方案里，前后端职责应当固定成这样：

- package / backend 负责：
  - 决定何时发 block
  - 生成符合 schema 的 `data`
  - 声明 `responseSchema`
  - 声明恢复 handler
- Web Host 负责：
  - 根据 `type` 选择 renderer
  - 找不到 renderer 时走 schema fallback
  - 收集用户输入
  - 发回 typed `submit_block_response`
- LLM 负责：
  - 生成业务语义
  - 在允许的任务里生成结构化 block data
  - 不直接控制前端组件实现

这和你旧方案最接近的最终表述是：

- 前端仍然提供预设 UI 组件
- 后端仍然提供结构化 schema / type / data
- 但中间必须有一层更正式的 block protocol，而不是让 LLM 直接决定 UI 实现细节

## 5. MVP Target Architecture

目标不是“扩展更多命令”，而是建立一个真正的 package host。

### 5.1 Runtime Topology

MVP 直接采用下面这组核心模块：

1. `PackageRegistry`
   - discover
   - validate
   - dependency resolution
   - approved enable set

2. `PackageHost`
   - 加载 package code
   - 注册 contributions
   - 暴露 package runtime API

3. `TurnEngine`
   - 一次 turn / command / block-response 的总编排器
   - 不是只会“发模型”或“发命令”

4. `ContextAssembly`
   - 调用 package context providers
   - 生成 `ContextGraph`

5. `PromptAssembly`
   - 从 `ContextGraph` 为不同任务编译 prompt
   - 不只服务 story narration，也服务 image / tts / summary

6. `CapabilityRuntime`
   - 统一执行 builtin / script / model / workflow / job capability

7. `BlockRuntime`
   - block schema validation
   - block emit
   - block response routing

8. `MediaRuntime`
   - image / audio artifact 生成和保存

9. `JobRuntime`
   - 持久化后台任务

### 5.2 Trust Model

MVP 下，package 运行边界定成这样：

- package code 默认运行在 runtime 进程内
- 不做多进程 extension host
- 但必须通过 `PackageRuntimeApi` 访问宿主能力
- package 不得直接拿原始 provider config
- script capability 单独走 runner

原因：

- 现在先追可用性和结构正确
- 进程隔离不是 MVP 首要目标
- 但 API 边界必须现在就定死，否则以后会失控

### 5.3 Lifecycle Phases

Package 可挂载的正式 phase 固定为：

- `onSessionStart`
- `onTurnStart`
- `buildContext`
- `beforeNarration`
- `afterNarration`
- `buildPresentation`
- `onBlockResponse`
- `onArtifactCreated`
- `onCommand`
- `onJob`

对应设计原则：

- `send_message` 不是“直接给 story model”
- 它必须成为一个 turn flow
- package 只通过 phase 介入

### 5.4 Trigger Model

每个 hook 都可以声明 trigger policy：

- `always`
- `manual`
- `event`
- `interval`
- `state-change`

例子：

- `story-image`
  - `event: narration.completed`
- `story-voice`
  - `event: narration.completed`
- `combat-dice`
  - `state-change: combat.check.pending`
- `guide-choices`
  - `manual` 或 `afterNarration`

## 6. Package Manifest v1 Reset

项目继续使用：

```json
{
  "schemaVersion": "1.0"
}
```

但 `1.0` 的正式契约重置为下面这组字段。

### 6.1 Top-level Shape

```json
{
  "schemaVersion": "1.0",
  "name": "story-image",
  "version": "0.1.0",
  "description": "Scene image package",
  "kind": "interaction",
  "defaultEnabled": true,
  "permissions": [],
  "dependencies": [],
  "contributes": {},
  "runtime": {},
  "settings": [],
  "state": []
}
```

### 6.2 Required Top-level Fields

- `schemaVersion`
- `name`
- `version`
- `description`
- `kind`
- `permissions`
- `contributes`

### 6.3 `kind`

建议限制在：

- `core`
- `content`
- `mechanic`
- `interaction`
- `media`
- `integration`

### 6.4 `permissions`

第一版直接做成可执行权限，不只是文档声明。

建议权限集合：

- `read:world`
- `read:session`
- `read:messages`
- `read:memory`
- `read:artifacts`
- `read:package-state`
- `write:package-state`
- `emit:block`
- `emit:artifact`
- `emit:message`
- `invoke:builtin`
- `invoke:script`
- `invoke:model`
- `invoke:job`

### 6.5 `contributes`

`contributes` 正式包含：

- `commands`
- `contextProviders`
- `hooks`
- `capabilities`
- `blockTypes`
- `renderers`
- `artifactTypes`

示例：

```json
{
  "contributes": {
    "commands": [],
    "contextProviders": [],
    "hooks": [],
    "capabilities": [],
    "blockTypes": [],
    "renderers": [],
    "artifactTypes": []
  }
}
```

### 6.6 `commands`

命令仍然保留，但不再是平台中心。

示例：

```json
{
  "name": "guide",
  "description": "Generate structured choices",
  "argsSchema": "schemas/commands/guide.args.json",
  "entry": "server/commands/guide.ts",
  "resume": false
}
```

### 6.7 `contextProviders`

正式替代当前的 `contributes.context`。

示例：

```json
{
  "id": "worldbook-context",
  "entry": "server/context/worldbook.ts",
  "reads": ["world", "session", "memory", "artifacts"],
  "priority": 80
}
```

返回值目标是 `ContextNode[]`，而不是 ad hoc note list。

### 6.8 `hooks`

示例：

```json
{
  "id": "story-image-after-narration",
  "phase": "afterNarration",
  "trigger": {
    "type": "event",
    "event": "narration.completed"
  },
  "entry": "server/hooks/after-narration.ts"
}
```

### 6.9 `capabilities`

这是 MVP 中最重要的新字段。

支持类型：

- `builtin`
- `script`
- `model`
- `workflow`
- `job`

示例：

```json
{
  "id": "dice.roll",
  "type": "builtin",
  "entry": "server/capabilities/dice-roll.ts",
  "inputSchema": "schemas/capabilities/dice-roll.input.json",
  "outputSchema": "schemas/capabilities/dice-roll.output.json",
  "timeoutMs": 3000
}
```

### 6.10 `blockTypes`

示例：

```json
{
  "type": "choice_set",
  "dataSchema": "schemas/blocks/choice-set.data.json",
  "responseSchema": "schemas/blocks/choice-set.response.json",
  "resume": {
    "handler": "guide.handleChoiceResponse"
  },
  "ui": {
    "component": "schema",
    "renderer": "choice-set"
  }
}
```

这里最关键的不是 renderer，而是：

- block type 自己就声明恢复 handler
- block response 必须路由到 package-owned logic

### 6.11 `renderers`

MVP 只支持：

- host-bundled renderer
- package 声明 renderer key
- Web Host 静态注册

不支持：

- 浏览器运行时动态加载任意第三方 UI 代码

示例：

```json
{
  "name": "choice-set",
  "entry": "client/renderers/choice-set.tsx"
}
```

### 6.12 `artifactTypes`

用于约束 package 可以创建什么 artifact。

示例：

```json
{
  "type": "scene-image",
  "kind": "image",
  "mediaType": "image/png"
}
```

### 6.13 `settings`

package 自己声明可编辑运行参数。

示例：

```json
{
  "key": "storyImage.autoGenerate",
  "type": "boolean",
  "default": false,
  "scope": "world"
}
```

### 6.14 `state`

package 自己声明状态集合。

示例：

```json
{
  "collection": "combat_checks",
  "scope": "session",
  "schema": "schemas/state/combat-check.json"
}
```

## 7. Runtime Contracts

### 7.1 Package Runtime API

宿主暴露给 package 的唯一正式运行时接口：

```ts
interface PackageRuntimeApi {
  locale: "zh-CN" | "en";
  session: { id: string; worldId: string };
  taskBindings: Record<string, string>;
  context: {
    requestId: string;
    traceId: string;
    turnId: string;
    flowId: string;
  };
  state: {
    get(collection: string, key: string): Promise<unknown | null>;
    put(collection: string, key: string, value: unknown): Promise<void>;
    patch(collection: string, key: string, value: Record<string, unknown>): Promise<void>;
    list(collection: string): Promise<Array<{ key: string; value: unknown }>>;
  };
  memory: {
    search(query: string): Promise<unknown[]>;
  };
  model: {
    callTask(task: string, input: Record<string, unknown>): Promise<unknown>;
  };
  capability: {
    invoke(id: string, input: Record<string, unknown>): Promise<unknown>;
  };
  emit: {
    message(input: { role?: "assistant"; content: string }): void;
    block(input: Record<string, unknown>): void;
    artifact(input: Record<string, unknown>): void;
    trace(input: Record<string, unknown>): void;
  };
  jobs: {
    enqueue(input: Record<string, unknown>): Promise<{ jobId: string }>;
  };
}
```

重点：

- package 看不到 provider secret
- package 不直接操作 repositories
- package 不直接 `fetch` provider
- package 通过 task/capability/job 三种入口完成工作

### 7.2 Task Binding

世界和会话不再只绑定一个 `presetId`。

MVP 直接上：

- `world.taskBindings`
- `session.taskBindings`

最少支持这些任务名：

- `story.narration`
- `story.choice.generate`
- `story.choice.resume`
- `media.image.prompt`
- `media.image.generate`
- `media.tts.script`
- `media.tts.synthesize`

例子：

```json
{
  "story.narration": "preset_story_primary",
  "story.choice.generate": "preset_choice_fast",
  "story.choice.resume": "preset_choice_resume",
  "media.image.prompt": "preset_image_prompt",
  "media.image.generate": "preset_image_render",
  "media.tts.script": "preset_tts_script",
  "media.tts.synthesize": "preset_tts_cn"
}
```

### 7.3 Capability Types

#### `builtin`

平台内建能力。

适合：

- 随机数
- 骰子表达式求值
- 时间
- 模板变换
- 文本截断

#### `script`

适合：

- 复杂规则计算
- legacy simulator
- 可复用的 deterministic mechanics

要求：

- path 不得逃逸 package root
- timeout
- 审计
- 最小环境变量

#### `model`

适合：

- text
- object
- image
- speech
- transcription

但 package 只调 task，不直连 provider。

#### `workflow`

适合：

- prompt optimize -> image generate
- summarize -> tts script -> synthesize
- choice generation -> block emit -> state seed

#### `job`

适合：

- 背景出图
- 长时 TTS
- 批量世界导入

### 7.4 Job Model

MVP 直接引入持久化 job。

状态：

- `queued`
- `running`
- `completed`
- `failed`

字段最少要有：

- `jobId`
- `packageName`
- `jobType`
- `sessionId`
- `input`
- `output`
- `status`
- `attempt`
- `scheduledAt`
- `startedAt`
- `completedAt`

image / tts 默认走 job，不和主叙事 turn 强耦合。

### 7.5 Block Model

block 继续是统一 UI 交付单位，但恢复协议要加强。

必须新增：

- `meta.package`
- `meta.handler`
- `interaction.responseSchema`
- `interaction.submitAs`
- `interaction.resumePolicy`

且 pending block 持久化时要保存：

- 完整 block envelope
- package name
- resume handler id
- original flow context

不允许恢复时退化成：

- `type: "pending"`
- `data: {}`

### 7.6 Renderer Model

MVP 直接采用：

- host 静态注册 first-party renderers
- 其他 block 一律 schema fallback

这样可以立刻支持：

- choices
- dice result
- image card
- audio clip

同时避免浏览器端动态执行第三方 UI 代码。

## 8. Four Canonical Package Designs

这四个就是你当前最关心的典型方案。

---

## 8.1 Canonical Design A: Dice / Rule Resolution Package

### 目标

- 支持掷骰子
- 支持规则判定
- 支持把结果送回剧情
- 支持记录历史和审计

### 关键决定

基础随机数不要设计成普通 script。

原因：

- RNG 必须可审计
- RNG 最适合做宿主 builtin capability
- script 更适合在 RNG 之后执行复杂规则

因此这个 package 的推荐结构是：

- `builtin capability`: `core.random.roll`
- `package capability`: `mechanics.resolveCheck`
  - 可是 `workflow` 或 `script`

### Manifest Example

```json
{
  "schemaVersion": "1.0",
  "name": "mechanics-dice",
  "version": "0.1.0",
  "description": "Dice and rules resolution",
  "kind": "mechanic",
  "defaultEnabled": true,
  "permissions": [
    "read:session",
    "read:world",
    "read:package-state",
    "write:package-state",
    "emit:block",
    "emit:message",
    "invoke:builtin",
    "invoke:script"
  ],
  "contributes": {
    "hooks": [
      {
        "id": "resolve-pending-check",
        "phase": "afterNarration",
        "trigger": {
          "type": "state-change",
          "key": "combat.check.pending"
        },
        "entry": "server/hooks/resolve-pending-check.ts"
      }
    ],
    "capabilities": [
      {
        "id": "mechanics.resolveCheck",
        "type": "workflow",
        "entry": "server/capabilities/resolve-check.ts",
        "inputSchema": "schemas/capabilities/resolve-check.input.json",
        "outputSchema": "schemas/capabilities/resolve-check.output.json"
      }
    ],
    "blockTypes": [
      {
        "type": "dice_result",
        "dataSchema": "schemas/blocks/dice-result.data.json",
        "responseSchema": "schemas/blocks/dice-result.response.json",
        "resume": {
          "handler": "mechanics.acknowledgeResult"
        },
        "ui": {
          "component": "schema",
          "renderer": "dice-result"
        }
      }
    ],
    "renderers": [
      {
        "name": "dice-result",
        "entry": "client/renderers/dice-result.tsx"
      }
    ]
  },
  "state": [
    {
      "collection": "check_queue",
      "scope": "session",
      "schema": "schemas/state/check-queue.json"
    },
    {
      "collection": "roll_history",
      "scope": "session",
      "schema": "schemas/state/roll-history.json"
    }
  ]
}
```

### Runtime Flow

1. narrative 或某个 package 写入 `combat.check.pending`
2. `mechanics-dice` 的 hook 被触发
3. hook 调用：
   - `core.random.roll`
   - 如有复杂规则，再调 `mechanics.resolveCheck`
4. 结果写入 `roll_history`
5. package 发出：
   - `dice_result` block
   - 或 assistant message
6. 如果需要继续剧情：
   - package 再触发 `story.choice.resume` 或 `story.narration`

### 为什么这样设计

- 把 randomness 放到宿主 builtin，保证公平和审计
- 把复杂规则留给 package capability，保证玩法可扩展
- 不把“骰子结果”偷偷塞进 message 文本里

---

## 8.2 Canonical Design B: Choice Director Package

### 目标

- 根据剧情、世界状态、角色状态自动生成多个选项
- 前端直接展示
- 用户选择后恢复原流程
- 不要求用户每次都输入自由文本

### Manifest Example

```json
{
  "schemaVersion": "1.0",
  "name": "director-choices",
  "version": "0.1.0",
  "description": "Choice generation and resume flow",
  "kind": "interaction",
  "defaultEnabled": true,
  "permissions": [
    "read:session",
    "read:world",
    "read:messages",
    "read:package-state",
    "write:package-state",
    "emit:block",
    "emit:message",
    "invoke:model"
  ],
  "contributes": {
    "hooks": [
      {
        "id": "maybe-offer-choices",
        "phase": "afterNarration",
        "trigger": {
          "type": "event",
          "event": "narration.completed"
        },
        "entry": "server/hooks/maybe-offer-choices.ts"
      },
      {
        "id": "resume-choice-response",
        "phase": "onBlockResponse",
        "trigger": {
          "type": "event",
          "event": "block.choice_set.submitted"
        },
        "entry": "server/hooks/resume-choice-response.ts"
      }
    ],
    "blockTypes": [
      {
        "type": "choice_set",
        "dataSchema": "schemas/blocks/choice-set.data.json",
        "responseSchema": "schemas/blocks/choice-set.response.json",
        "resume": {
          "handler": "director.resumeChoice"
        },
        "ui": {
          "component": "schema",
          "renderer": "choice-set"
        }
      }
    ],
    "renderers": [
      {
        "name": "choice-set",
        "entry": "client/renderers/choice-set.tsx"
      }
    ]
  },
  "state": [
    {
      "collection": "choice_state",
      "scope": "session",
      "schema": "schemas/state/choice-state.json"
    }
  ]
}
```

### Runtime Flow

1. narration 完成
2. `director-choices` 收集：
   - 当前场景
   - 最近消息
   - 活跃状态
   - 世界规则
3. package 调用 `story.choice.generate`
4. 产出结构化 `choice_set`
5. Web Host 渲染
6. 用户点击选项
7. `submit_block_response`
8. `director.resumeChoice` 接收 typed response
9. package 先写状态，再决定：
   - 直接继续 narration
   - 先触发 mechanic capability
   - 或发出新的 block

### 核心要求

这一条必须和当前实现切开：

- 不能把 block response 简单 `JSON.stringify` 后再丢给 story model
- 必须先进入 package-owned resume handler

否则 package 永远做不成真正的交互状态机。

---

## 8.3 Canonical Design C: Story Image Package

### 目标

- 根据当前剧情、世界状态、角色状态和历史图片生成图片
- 允许先优化 prompt，再调用图片模型
- 结果作为 artifact 保存，并在前端展示

### 关键决定

图像工作流拆成两个任务：

- `media.image.prompt`
- `media.image.generate`

原因：

- prompt 优化和图片生成常常用不同模型
- 这样更容易切 preset 和 fallback

### Manifest Example

```json
{
  "schemaVersion": "1.0",
  "name": "story-image",
  "version": "0.1.0",
  "description": "Story image generation",
  "kind": "media",
  "defaultEnabled": true,
  "permissions": [
    "read:session",
    "read:world",
    "read:messages",
    "read:artifacts",
    "read:package-state",
    "write:package-state",
    "emit:artifact",
    "emit:block",
    "invoke:model",
    "invoke:job"
  ],
  "contributes": {
    "hooks": [
      {
        "id": "queue-scene-image",
        "phase": "afterNarration",
        "trigger": {
          "type": "event",
          "event": "narration.completed"
        },
        "entry": "server/hooks/queue-scene-image.ts"
      },
      {
        "id": "publish-scene-image",
        "phase": "onJob",
        "trigger": {
          "type": "event",
          "event": "job.story-image.completed"
        },
        "entry": "server/hooks/publish-scene-image.ts"
      }
    ],
    "blockTypes": [
      {
        "type": "image_card",
        "dataSchema": "schemas/blocks/image-card.data.json",
        "responseSchema": "schemas/blocks/image-card.response.json",
        "resume": {
          "handler": "storyImage.handleImageAction"
        },
        "ui": {
          "component": "schema",
          "renderer": "image-card"
        }
      }
    ],
    "renderers": [
      {
        "name": "image-card",
        "entry": "client/renderers/image-card.tsx"
      }
    ],
    "artifactTypes": [
      {
        "type": "scene-image",
        "kind": "image",
        "mediaType": "image/png"
      }
    ]
  },
  "settings": [
    {
      "key": "storyImage.autoGenerate",
      "type": "boolean",
      "default": false,
      "scope": "world"
    },
    {
      "key": "storyImage.usePreviousFrameAsReference",
      "type": "boolean",
      "default": true,
      "scope": "world"
    }
  ],
  "state": [
    {
      "collection": "image_jobs",
      "scope": "session",
      "schema": "schemas/state/image-jobs.json"
    }
  ]
}
```

### Runtime Flow

1. narration 完成
2. `story-image` hook 判定是否应该出图
3. package 组装 `image prompt context`
   - 当前 scene
   - 当前叙事摘要
   - 角色外观
   - 世界风格
   - 上一张图 artifact
4. package enqueue job
5. job worker 先调用 `media.image.prompt`
6. 得到优化后的 prompt object
7. 再调用 `media.image.generate`
8. `MediaRuntime` 保存 artifact：
   - kind = image
   - prompt metadata
   - parent artifact ids
   - source package
9. `publish-scene-image` 发 `image_card` block

### 为什么这样设计

- 出图一般不该阻塞主 turn
- prompt 优化和图像生成要分开建模
- artifact 必须是一等对象，而不是“消息里塞一个 URL”

---

## 8.4 Canonical Design D: Story Voice / TTS Package

### 目标

- 把剧情文本转成语音
- 支持按角色/语言选择 voice
- 支持前端直接播放
- 结果保存为 audio artifact

### Manifest Example

```json
{
  "schemaVersion": "1.0",
  "name": "story-voice",
  "version": "0.1.0",
  "description": "Narration TTS package",
  "kind": "media",
  "defaultEnabled": false,
  "permissions": [
    "read:session",
    "read:messages",
    "read:package-state",
    "write:package-state",
    "emit:artifact",
    "emit:block",
    "invoke:model",
    "invoke:job"
  ],
  "contributes": {
    "hooks": [
      {
        "id": "queue-tts",
        "phase": "afterNarration",
        "trigger": {
          "type": "event",
          "event": "narration.completed"
        },
        "entry": "server/hooks/queue-tts.ts"
      },
      {
        "id": "publish-audio",
        "phase": "onJob",
        "trigger": {
          "type": "event",
          "event": "job.story-voice.completed"
        },
        "entry": "server/hooks/publish-audio.ts"
      }
    ],
    "blockTypes": [
      {
        "type": "audio_clip",
        "dataSchema": "schemas/blocks/audio-clip.data.json",
        "responseSchema": "schemas/blocks/audio-clip.response.json",
        "resume": {
          "handler": "storyVoice.handleAudioAction"
        },
        "ui": {
          "component": "schema",
          "renderer": "audio-clip"
        }
      }
    ],
    "renderers": [
      {
        "name": "audio-clip",
        "entry": "client/renderers/audio-clip.tsx"
      }
    ],
    "artifactTypes": [
      {
        "type": "narration-audio",
        "kind": "audio",
        "mediaType": "audio/mpeg"
      }
    ]
  },
  "settings": [
    {
      "key": "storyVoice.autoPlay",
      "type": "boolean",
      "default": false,
      "scope": "session"
    },
    {
      "key": "storyVoice.voice.zh-CN",
      "type": "string",
      "default": "narrator-cn-1",
      "scope": "world"
    },
    {
      "key": "storyVoice.voice.en",
      "type": "string",
      "default": "narrator-en-1",
      "scope": "world"
    }
  ]
}
```

### Runtime Flow

1. narration 完成
2. package 提取本轮需要朗读的文本
3. 如需要，先调用 `media.tts.script`
   - 把叙事文本整理成更适合朗读的脚本
4. 再调用 `media.tts.synthesize`
5. `MediaRuntime` 保存 audio artifact
6. package 发 `audio_clip` block
7. Web Host 渲染播放器并支持自动播放

### 为什么这样设计

- TTS 不是 message 附属功能，而是 media workflow
- 朗读脚本和音频合成常常是两个任务
- artifact 保存后才能支持重播、缓存和导出

## 9. What This Means For The Core Framework

如果要让上面 4 个典型方案都成立，主框架必须一次性接受下面这些重排。

### 9.1 `modules/package-runtime`

不再只支持：

- `context`
- `commands`
- `blocks`
- `renderers`

而是要支持：

- `contextProviders`
- `hooks`
- `capabilities`
- `blockTypes`
- `renderers`
- `artifactTypes`

### 9.2 `modules/flow-engine`

不再只做：

- send_message -> model
- execute_command -> command
- submit_block_response -> model resume

而是要改成：

- `TurnEngine`
- 带 phase execution
- 带 package hook dispatch
- 带 job/event integration

### 9.3 `modules/model-gateway`

能力面直接扩成：

- `generateText`
- `generateObject`
- `streamText`
- `embed`
- `generateImage`
- `synthesizeSpeech`
- `transcribeAudio`

### 9.4 `modules/storage`

新增正式仓储：

- `PackageStateRepository`
- `JobRepository`

并且 block persistence 需要存完整 envelope。

### 9.5 `apps/web`

新增：

- renderer registry
- `image_card`
- `audio_clip`
- `dice_result`
- 更完整的 block response dispatch

但仍保持：

- host 负责 UI runtime
- package 不直接控制宿主框架

## 10. Design Rules That Should Not Be Compromised

### 10.1 不要把随机数实现成普通脚本能力

脚本可以做规则计算。

但随机数本身最好是宿主 builtin：

- 可审计
- 可重放
- 可做 seed 控制

### 10.2 不要把 block response 退化成一段 prompt 文本

block response 必须先进入 package-owned resume handler。

否则所有复杂交互都会退化成 prompt hack。

### 10.3 不要把图像和 TTS 做成 runtime 旁路特例

image 和 tts 必须走：

- task binding
- model gateway
- artifact store
- block runtime

否则 extension 平台永远无法统一。

### 10.4 不要让 package 自己选 provider

package 只声明任务。

宿主负责把任务绑定到 preset/profile。

### 10.5 不要开放浏览器端动态加载任意第三方 renderer

MVP 只支持 host-bundled renderer。

这是最合理的安全边界。

## 11. Final Recommendation

如果目标是：

- 以后大部分玩法都做成 package
- 掷骰、选项、图像、TTS 都走 package
- 现在就按 MVP 一次性把架构定对

那么推荐结论就是：

1. 保持项目自己的 `Package manifest v1`
2. 直接把 v1 重定义成“commands + hooks + capabilities + blocks + renderers + artifact types + state + settings”
3. 让 `TurnEngine` 成为真正的 phase orchestrator
4. 把 `PackageStateRepository`、`JobRepository`、`generateImage`、`synthesizeSpeech` 一次性纳入核心
5. 把 4 类典型 package 当成第一批正式目标：
   - `mechanics-dice`
   - `director-choices`
   - `story-image`
   - `story-voice`

这比继续在当前 `command + placeholder context + hardcoded renderer` 路线上打补丁要正确得多。

它也更符合你真正要的系统形态：

- 玩法逻辑是 package
- UI 交互是 package block
- 多模态产物是 package artifact
- 模型调用是宿主 task binding
- 整个 runtime 围绕 flow 和 capability 编排，而不是只围绕 chat 文本生成

## 12. Concrete Implementation Blueprint

这一节不再讲原则，只讲代码层面的落点。

### 12.1 Direct File Plan

#### `modules/package-runtime`

必须修改：

- [modules/package-runtime/src/manifest.ts](/Users/wuyong/codes/game/covel/modules/package-runtime/src/manifest.ts)
  - 用新的 `Package manifest v1` 契约替换当前 schema
  - `contributes.context` 重命名为 `contributes.contextProviders`
  - 新增 `hooks`
  - 新增 `capabilities`
  - 新增 `artifactTypes`
  - 新增 top-level `settings`
  - 新增 top-level `state`
- [modules/package-runtime/src/runtime.ts](/Users/wuyong/codes/game/covel/modules/package-runtime/src/runtime.ts)
  - 新增 `listHooks()`
  - 新增 `listCapabilities()`
  - 新增 `getBlockType()`
  - 新增 `listArtifactTypes()`
  - `enable()` 时真正加载：
    - command modules
    - hook modules
    - capability modules
  - `contextProvider` 不再只做 path check，要真正 import

建议新增：

- `modules/package-runtime/src/package-api.ts`
  - 定义 package handler runtime API
- `modules/package-runtime/src/load-hook-module.ts`
- `modules/package-runtime/src/load-capability-module.ts`

#### `modules/domain`

必须修改：

- [modules/domain/src/entities.ts](/Users/wuyong/codes/game/covel/modules/domain/src/entities.ts)
  - `World` 增加 `taskBindings?: Record<string, string>`
  - `Session` 增加 `taskBindings?: Record<string, string>`
  - 新增 `PackageStateRecord`
  - 新增 `JobRecord`
- [modules/domain/src/repositories.ts](/Users/wuyong/codes/game/covel/modules/domain/src/repositories.ts)
  - 新增 `PackageStateRepository`
  - 新增 `JobRepository`

#### `modules/storage`

必须修改：

- [modules/storage/src/in-memory-storage-repositories.ts](/Users/wuyong/codes/game/covel/modules/storage/src/in-memory-storage-repositories.ts)
  - 实现 package state
  - 实现 job repository
  - pending block 改为保存完整 envelope
- [modules/storage/src/postgres-storage-port.ts](/Users/wuyong/codes/game/covel/modules/storage/src/postgres-storage-port.ts)
  - 新增 package state 表
  - 新增 jobs 表
  - pending block 表增加：
    - block envelope json
    - package name
    - resume handler id
    - action payload / metadata

建议新增：

- `modules/storage/src/package-state-store.ts`
- `modules/storage/src/job-store.ts`

#### `modules/contracts`

必须修改：

- [modules/contracts/src/block.ts](/Users/wuyong/codes/game/covel/modules/contracts/src/block.ts)
  - `meta` 增加 `handler`
  - `interaction` 增加 package-owned resume metadata
  - 允许 `data` 和 `response` 走更严格 typed contract
- [modules/contracts/src/action-request.ts](/Users/wuyong/codes/game/covel/modules/contracts/src/action-request.ts)
  - `submit_block_response` 保留
  - 不新增无必要 action type
  - 但 `payload.response` 必须允许 renderer 传结构化 action

建议新增：

- `modules/contracts/src/job.ts`
- `modules/contracts/src/package-state.ts`
- `modules/contracts/src/task-binding.ts`

#### `modules/model-gateway`

必须修改：

- [modules/model-gateway/src/model-profile-registry.ts](/Users/wuyong/codes/game/covel/modules/model-gateway/src/model-profile-registry.ts)
  - `SupportedMode` 扩成：
    - `text`
    - `object`
    - `stream`
    - `embed`
    - `image`
    - `speech`
    - `transcription`
- [modules/model-gateway/src/provider-registry.ts](/Users/wuyong/codes/game/covel/modules/model-gateway/src/provider-registry.ts)
  - adapter 接口增加：
    - `generateImage`
    - `synthesizeSpeech`
    - `transcribeAudio`
- [modules/model-gateway/src/runtime.ts](/Users/wuyong/codes/game/covel/modules/model-gateway/src/runtime.ts)
  - gateway 增加对应方法

建议新增：

- `modules/model-gateway/src/task-router.ts`
  - 负责：
    - 从 `world.taskBindings` / `session.taskBindings` 解任务
    - 解析 preset/profile
    - 调用具体 mode

#### `modules/flow-engine`

当前建议直接重写 [modules/flow-engine/src/runtime.ts](/Users/wuyong/codes/game/covel/modules/flow-engine/src/runtime.ts)。

方向：

- `FlowEngine` 改造成 `TurnEngine`
- 统一处理：
  - turn lifecycle
  - command lifecycle
  - block response lifecycle
  - job completion lifecycle
- 移除当前这条逻辑：
  - block response -> `JSON.stringify(response.response)` -> `modelGateway.generateText(...)`

建议新增：

- `modules/flow-engine/src/phases.ts`
- `modules/flow-engine/src/package-hook-runner.ts`
- `modules/flow-engine/src/block-runtime.ts`
- `modules/flow-engine/src/job-runtime.ts`

#### `apps/runtime`

必须修改：

- [apps/runtime/src/composition.ts](/Users/wuyong/codes/game/covel/apps/runtime/src/composition.ts)
  - 组合：
    - package host
    - task router
    - capability runtime
    - job runtime
    - turn engine
  - command 注册不再是 package 的唯一入口
- [apps/runtime/src/server.ts](/Users/wuyong/codes/game/covel/apps/runtime/src/server.ts)
  - `/actions` 继续保留
  - 新增 jobs / artifacts 读接口
  - `/packages` 返回 package summary，而不是内部结构

建议新增：

- `apps/runtime/src/package-api.ts`
- `apps/runtime/src/capability-runtime.ts`
- `apps/runtime/src/task-router.ts`
- `apps/runtime/src/job-worker.ts`

#### `apps/web`

必须修改：

- [apps/web/src/App.tsx](/Users/wuyong/codes/game/covel/apps/web/src/App.tsx)
  - 去掉硬编码 `choices` block 渲染
  - 改为 renderer registry
- [apps/web/src/types.ts](/Users/wuyong/codes/game/covel/apps/web/src/types.ts)
  - 补 artifact / job / richer block types
- [apps/web/src/state.ts](/Users/wuyong/codes/game/covel/apps/web/src/state.ts)
  - pending block 维护完整 envelope

建议新增：

- `apps/web/src/block-renderer-registry.ts`
- `apps/web/src/components/blocks/choice-set.tsx`
- `apps/web/src/components/blocks/dice-result.tsx`
- `apps/web/src/components/blocks/image-card.tsx`
- `apps/web/src/components/blocks/audio-clip.tsx`

### 12.2 Files That Should Stop Driving Architecture

下面这些现状不应该继续成为平台核心：

- [apps/web/src/App.tsx](/Users/wuyong/codes/game/covel/apps/web/src/App.tsx)
  - 里面的硬编码 pending block UI 只能作为过渡实现
- [extensions/core-guide/client/renderers/choices.tsx](/Users/wuyong/codes/game/covel/extensions/core-guide/client/renderers/choices.tsx)
  - 当前 placeholder 不能再被当成“renderer 能力已存在”
- [extensions/*/server/context.ts](/Users/wuyong/codes/game/covel/extensions/core-guide/server/context.ts)
  - 当前 `return []` 的 context 文件不能再继续扩散
- [modules/flow-engine/src/runtime.ts](/Users/wuyong/codes/game/covel/modules/flow-engine/src/runtime.ts)
  - 当前恢复逻辑不能再沿用

## 13. Exact Type Resets

### 13.1 `World` / `Session`

建议直接重置为：

```ts
export interface World {
  id: string;
  name: string;
  description: string;
  taskBindings?: Record<string, string>;
  createdAt: Date;
}

export interface Session {
  id: string;
  worldId: string;
  status: "active" | "waiting_for_input" | "archived";
  taskBindings?: Record<string, string>;
  createdAt: Date;
}
```

### 13.2 `PackageStateRecord`

```ts
export interface PackageStateRecord {
  scope: "world" | "session";
  ownerId: string;
  packageName: string;
  collection: string;
  key: string;
  value: Record<string, unknown>;
  updatedAt: Date;
}
```

### 13.3 `JobRecord`

```ts
export interface JobRecord {
  id: string;
  packageName: string;
  jobType: string;
  sessionId?: string;
  status: "queued" | "running" | "completed" | "failed";
  input: Record<string, unknown>;
  output?: Record<string, unknown>;
  error?: string;
  attempt: number;
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
}
```

### 13.4 `SupportedMode`

```ts
export type SupportedMode =
  | "text"
  | "object"
  | "stream"
  | "embed"
  | "image"
  | "speech"
  | "transcription";
```

### 13.5 `BlockEnvelope`

建议把 block 元信息补成：

```ts
meta: {
  package: string;
  handler: string;
  requestId: string;
  traceId: string;
  sessionId: string;
  turnId: string;
}
```

`interaction` 建议补成：

```ts
interaction: {
  requiresResponse: boolean;
  responseSchema?: string;
  submitAs?: string;
  resumePolicy?: string;
  resumeHandler?: string;
}
```

### 13.6 `PackageRuntime` Registrations

`PackageRuntime` 不应只暴露：

- commands
- contexts
- blocks
- renderers

而应至少暴露：

- commands
- contextProviders
- hooks
- capabilities
- blockTypes
- renderers
- artifactTypes

## 14. Concrete Runtime Behavior Resets

### 14.1 Turn Input

`send_message` 的正式执行顺序应改成：

1. `onTurnStart`
2. `buildContext`
3. `beforeNarration`
4. `story.narration`
5. `afterNarration`
6. `buildPresentation`
7. emit outputs
8. persist traces / jobs / package state

### 14.2 Command Input

`execute_command` 的执行顺序应改成：

1. resolve package command
2. 进入 `onCommand`
3. command handler 可：
   - emit message
   - emit block
   - write package state
   - invoke capability
   - enqueue job

### 14.3 Block Response

`submit_block_response` 的执行顺序应改成：

1. 从 pending block store 取完整 envelope
2. 找 `resumeHandler`
3. 运行 package resume handler
4. resume handler 决定后续：
   - write state
   - invoke capability
   - call task
   - emit message / block / artifact

### 14.4 Job Completion

job worker 完成后应进入：

1. persist output
2. emit `job.<type>.completed`
3. 触发 package `onJob`
4. package 决定是否 publish artifact block

## 15. Package Examples To Actually Build

如果你准备把这个架构真正跑起来，建议第一批就做这 4 个 package，不要先做抽象空壳：

### 15.1 `mechanics-dice`

必须包含：

- builtin RNG use
- deterministic rule resolution
- `dice_result` block
- roll history state

### 15.2 `director-choices`

必须包含：

- narrative-driven choice generation
- `choice_set` block
- package-owned resume handler

### 15.3 `story-image`

必须包含：

- image prompt optimization
- image generation job
- artifact persistence
- `image_card` renderer

### 15.4 `story-voice`

必须包含：

- optional narration rewriting for speech
- speech synthesis job
- audio artifact persistence
- `audio_clip` renderer

## 16. Test Matrix To Add Before Implementation Ends

### 16.1 Package Runtime

- manifest v1 accepts hooks/capabilities/artifactTypes/state/settings
- path traversal blocked for command/hook/capability entries
- package enable loads hook/capability modules

### 16.2 Turn Engine

- turn flow executes package phases in order
- block response routes to package resume handler
- job completion re-enters package hook path

### 16.3 Model Gateway

- image mode route resolves correctly
- speech mode route resolves correctly
- task binding chooses correct preset

### 16.4 Storage

- package state persists across runtime restart
- job records persist and resume
- pending blocks retain full envelope

### 16.5 Web Host

- renderer registry resolves known block types
- unknown block type falls back to schema renderer
- `choice_set`, `dice_result`, `image_card`, `audio_clip` render and submit correctly

## 17. Short Implementation Order

如果现在立刻开始写代码，最合理的顺序是：

1. 重写 manifest schema 和 package runtime
2. 增加 domain/storage 的 `taskBindings + package state + jobs`
3. 扩展 model gateway 到 `image/speech/transcription`
4. 重写 flow engine 为 turn engine
5. 接上 Web renderer registry
6. 落地 4 个 canonical packages

这一顺序不是迁移路线，而是最短闭环顺序。
