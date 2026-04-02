# Public Plugin API 规格

时间：2026-03-29  
状态：草案  
类型：实现规格

## 1. 目的

定义插件可稳定依赖的公开接口，明确：

- 插件能依赖什么
- 插件不能依赖什么
- manifest、runtime、tool、hook、UI、provider 的合同
- 兼容边界与首轮约束

本文件的目标是保护插件生态不与 kernel 内部实现耦合。

## 2. 范围

### 2.1 纳入范围

- plugin package 最小结构
- manifest contract
- runtime spec contract
- runtime context contract
- tool contract
- hook contract
- UI slot contract
- provider binding contract
- proposal output contract

### 2.2 不纳入范围

- 内部数据库实现
- 内核调度算法细节
- 前端私有页面树
- 插件市场流程

## 3. Public 与 Internal 的边界

### 3.1 Public

插件可依赖：

- manifest 字段合同
- runtime spec
- runtime context view
- tool 注册和调用合同
- hook 注册合同
- UI slot 注入合同
- provider binding 声明合同
- proposal 输出合同

### 3.2 Internal

插件不得依赖：

- 数据库表名
- ORM 模型
- kernel 内部排序细节
- 前端私有组件树
- 任意内部 helper

## 4. Plugin Package 合同

推荐最小结构：

```text
plugin/
  plugin.json
  PLUGIN.md
```

推荐完整结构：

```text
plugin/
  plugin.json
  PLUGIN.md
  schemas/
  server/
  client/
  scripts/
  references/
```

规则：

- manifest 中声明的路径必须存在
- 声明的 runtime / tool / hook / ui 必须能被解析
- `PLUGIN.md` 必须足够说明 runtime 的行为边界

## 5. Manifest 合同

manifest 至少应声明：

- `schemaVersion`
- `id`
- `displayName`
- `version`
- `author`
- `description`
- `defaultLocale`
- `supportedLocales`
- `loadingOrder`
- `requires`
- `supersedes`
- `conflicts`
- `compatibility`
- `runtimes`
- `tools`
- `hooks`
- `ui`
- `runtimeSettings`
- `permissions`
- `providers`

目的：

- 插件发现
- 安装与升级
- 兼容性检查
- 能力入口注册

补充约束：

- `displayName` 和 `description` 使用 `I18nText`
- 插件必须显式声明 `defaultLocale` 与 `supportedLocales`
- `defaultLocale` 默认应为 `zh-CN`
- `supportedLocales` 至少包含 `zh-CN` 和 `en-US`
- 插件若暴露用户可调参数，应通过 `runtimeSettings` 声明

## 6. i18n Public Contract

Public Plugin API 需要显式暴露最小国际化契约。

```ts
export type I18nText = string | Record<string, string>;
```

规则：

- 简单字符串表示仅提供默认语言版本
- 对象形式表示 locale 到文本的映射
- Public Plugin API 的最低支持语言集合固定为 `zh-CN` 和 `en-US`
- 插件 metadata、设置标题、UI 文案等用户可见文本应优先使用 `I18nText`
- locale 解析由应用层和 kernel 负责，插件负责按给定 locale 产出结果
- 前端页面必须支持多语言，插件上下文必须跟随前端当前选择的语言

## 7. Runtime Public Contract

```ts
export interface PublicRuntimeSpec {
  id: string;
  pluginId: string;
  kind: "story" | "plugin" | "background" | "verifier";
  phase: "pre_story" | "story" | "post_story" | "background";
  trigger: RuntimeTriggerSpec;
  providerBinding?: string;
  instructionsRef?: string;
  tools: string[];
  hooks: string[];
  budget?: RuntimeBudget;
  output?: RuntimeOutputSpec;
  failurePolicy?: "continue" | "stop" | "retry" | "disable_runtime";
  isolation?: RuntimeIsolationSpec;
}
```

首轮约束：

- `verifier` 可声明，但 loader 应返回未支持状态
- runtime 调度粒度是 `runtime`，不是 `plugin`
- runtime 仅能使用显式声明的 tools / hooks / provider binding
- runtime 是完整的独立运行时单元，可被单独调用
- 主对话后触发是常见默认 profile，但不是唯一时机

补充说明：

- gameplay runtime 常见于 `post_story`
- 资产类 runtime 常见于 `manual` 或显式动作事件
- 其他 runtime 可绑定到 `pre_story`、`background` 或条件事件
- `trigger.mode` 首轮支持 `always / interval / manual / event`
- `interval` 适用于每 N 轮或周期性检查
- `event` 表示 runtime 仅在 `onEvents` 中声明的事件到达时触发
- 目标达成、context 阈值等条件触发应通过显式事件进入 `onEvents`

## 8. Runtime Context Public Contract

```ts
export interface RuntimeContextView {
  run: {
    runId: string;
    worldId?: string;
    branchId: string;
    turnId: string;
    status?: string;
    phase?: string;
    defaultLocale?: string;
    activeBranchId?: string;
  };
  locale: string;
  world?: WorldContextSlice;
  chat?: ChatContextSlice;
  characters?: CharacterContextSlice[];
  state?: ScopedStateView;
  record?: RecordSearchHit[];
  events?: RuntimeTriggerEvent[];
  runtimeSettings?: {
    flat?: Record<string, unknown>;
    byPlugin?: Record<string, Record<string, unknown>>;
  };
  narrative?: {
    content: string;
    messageId?: string;
  };
  archive?: {
    activeVersion?: number;
    latestVersion?: number;
    summary?: string;
  };
  runtime: {
    runtimeId: string;
    pluginId: string;
    kind: string;
    phase: string;
    allowedTools: string[];
    providerBinding?: string;
    budget?: RuntimeBudget;
    isolation?: RuntimeIsolationSpec;
  };
}
```

约束：

- context 为只读
- 插件不能直接获取全局可变对象
- 插件不能假设某个 slice 永远存在
- 插件输出应适配 `locale`
- 插件不得把 `locale` 当成可忽略提示
- `runtimeSettings`、`narrative`、`archive` 都属于可选 slice
- 插件只能读取这些 slice，不能直接修改其底层状态
- 若缺失对应语言资源，插件应接受 kernel 提供的 fallback 结果，而不是自行猜测语言

## 9. Runtime Settings Public Contract

Public Plugin API 需要支持声明式运行时设置，以便配置驱动调度和行为切换。

```ts
export interface RuntimeSettingField {
  key: string;
  type: "string" | "number" | "integer" | "boolean" | "enum";
  label: I18nText;
  description?: I18nText;
  scope?: "project" | "run" | "request";
  component?: "input" | "textarea" | "toggle" | "select";
  default?: unknown;
  options?: Array<{ label: I18nText; value: string | number | boolean }>;
  affects?: string[];
}
```

规则：

- 插件通过声明字段参与 runtime settings 合并
- 字段默认值是最低优先级配置来源
- 首轮作用域固定为 `project -> run -> request`
- 自动触发 / 间隔触发开关应优先通过 runtime settings 暴露

## 10. Tool Public Contract

```ts
export interface PublicToolDefinition<I = unknown, O = unknown> {
  id: string;
  kind:
    | "query"
    | "mutate"
    | "emit"
    | "render"
    | "generate"
    | "orchestration"
    | "script"
    | "proxy";
  permissions?: string[];
  execute(input: ToolExecutionContext<I>): Promise<ToolExecutionResult<O>>;
}
```

公开域首轮固定为：

- `chat.*`
- `state.*`
- `event.*`
- `record.*`
- `provider.*`
- `ui.*`
- `script.*`

约束：

- 所有公开 tool 必须有 schema
- 高风险 tool 必须声明权限
- `query` 优先直接返回结果
- 写操作应通过 proposal 链影响系统

## 11. Hook Public Contract

```ts
export interface PublicHookDefinition {
  id: string;
  event:
    | "TurnStart"
    | "PreToolUse"
    | "PostToolUse"
    | "PreStateCommit"
    | "PostStateCommit"
    | "TurnStop";
  handlerKind: "command" | "prompt" | "async-command";
  match?: HookMatch;
}
```

约束：

- hook lifecycle point 不等于 runtime trigger event
- hook 可守卫、改写、审计、阻断
- hook 不得绕过 commit layer
- 插件的实际触发时间通常由 hook 和 trigger 共同决定

## 12. UI Public Contract

```ts
export interface PublicUiExtension<Props = unknown> {
  id: string;
  slot: "settings_panel" | "message_block" | "world_panel" | "action_panel";
  component: unknown;
  propsSchema?: unknown;
}
```

首轮稳定 slot：

- `settings_panel`
- `message_block`
- `world_panel`
- `action_panel`

约束：

- 插件只能通过 slot 注入 UI
- 插件不得依赖页面骨架和私有组件树
- UI 扩展中的用户可见文本应支持 locale 切换

## 13. Provider Binding Contract

```ts
export interface PublicProviderBinding {
  id: string;
  kind: "llm" | "image" | "tts" | "script-host";
  configRef?: string;
  permissions?: string[];
}
```

规则：

- 插件声明 provider binding，而不是直接持有 provider SDK
- provider 调用必须能进入 trace
- provider 输出必须回到 runtime / proposal / side-effect 主链

补充约束：

- 首轮建议区分 narrative model binding 与 plugin model binding
- 未声明 plugin 侧 binding 时，默认回退到 narrative binding

### 13.1 Model Slot

runtime 通过 `providerBinding` 引用命名 model slot（如 `"default"`、`"fast"`），而非具体 provider。slot 是一层抽象，将 runtime 的模型需求与具体 provider 配置解耦。

`llm.toml` 中第一个定义的 slot 自动成为 `default`，其原始名称也可访问。

预定义 slot：

| Slot | 用途 | 典型场景 |
|------|------|----------|
| `default` | 主叙事、复杂推理（自动别名） | core-narrator |
| `fast` | 轻量判断、插件默认 | core-guide, core-char-tracker |
| `balance` | 裁判类插件、复杂逻辑代理 | 未来扩展 |
| `image` | 图片生成（可选） | 未来扩展 |

回退链：请求 slot → `default` slot → 第一个可用 slot。

规则：

- 插件在 manifest 或 runtime spec 中声明 slot 名称，不直接引用 provider SDK 或 API key
- 用户通过前端配置面板为每个 slot 绑定不同的 provider preset
- 未配置的 slot 自动回退到 `default`
- slot 名称属于公开合同，插件可稳定依赖

### 13.2 Model Capability

每个 slot 绑定的模型附带能力描述（`ModelCapability`），插件可通过 runtime context 查询当前 slot 的能力信息，用于条件功能启用和优雅降级。

```ts
interface ModelCapability {
  input:   InputModality[];   // 模型接受的输入模态
  output:  OutputModality[];  // 模型产出的输出模态
  features: ModelFeature[];   // 功能标签
  contextWindow?: number;     // 上下文窗口（token 数）
  maxOutputTokens?: number;   // 最大输出 token 数
  pricing?: ModelPricing;     // 价格信息（每百万 token）
}

type InputModality  = "text" | "image" | "audio" | "video" | "file";
type OutputModality = "text" | "image" | "audio" | "embedding";
type ModelFeature   = "function_calling" | "structured_output" | "streaming"
                    | "reasoning" | "vision" | "prompt_caching"
                    | "web_search" | "computer_use";
```

**方向性模态**：`image` 在 `input` = 看图（vision），在 `output` = 生图；`audio` 在 `input` = 语音识别，在 `output` = 语音合成。插件不应假设 input 和 output 模态对称。

**插件用法示例**：

- 检查 `capability.features.includes("function_calling")` 决定是否提供 tool
- 检查 `capability.input.includes("image")` 决定是否接受图片输入
- 使用 `capability.contextWindow` 估算可用上下文预算
- 使用 `capability.pricing` 预估调用成本

**能力来源**：系统自动从多源解析（llm.toml 覆盖 > 内置模型库 > LiteLLM 数据库 > 协议默认值），插件无需关心解析逻辑，只消费最终结果。

## 14. Proposal Output Contract

```ts
export interface PublicProposalOutput {
  items: Array<
    | { kind: "narrative.append"; payload: unknown }
    | { kind: "state.patch"; payload: unknown }
    | { kind: "event.emit"; payload: unknown }
    | { kind: "record.upsert"; payload: unknown }
    | { kind: "ui.render"; payload: unknown }
    | { kind: "asset.generate"; payload: unknown }
  >;
}
```

规则：

- runtime 影响系统事实应通过 proposal 输出
- 插件不得直接跳过 proposal / validate / commit
- 用户可见 proposal payload 若含文本，应遵循当前 `locale`

## 15. 权限模型

Public Plugin API 仅暴露声明式权限，不暴露底层宿主能力。

首轮最小权限模型：

- tool permission scopes
- provider permission scopes
- runtime tool whitelist
- context read scope

原则：

- 权限随声明进入 manifest
- 权限随 runtime 进入执行链
- 高风险能力默认关闭，显式开启

## 16. 兼容策略

兼容性基于以下对象：

- `schemaVersion`
- `plugin version`
- `compatibility`
- loader 的支持矩阵

规则：

- 首轮公开合同以向后兼容为优先
- 未支持能力必须显式报错或 warning
- 不允许静默忽略核心能力声明
- locale 支持能力的缺失必须有明确 fallback，而不是隐式降级
- 不满足 `zh-CN` 和 `en-US` 最低支持集合的插件不应视为稳定兼容插件
- runtime settings 字段变更必须遵守兼容策略，避免破坏既有配置

## 17. 首轮明确不支持的做法

- 直接依赖数据库表结构
- 直接依赖前端私有组件树
- 插件直接写状态或事件存储
- 未声明权限即访问高风险能力
- 通过未公开内部模块扩展系统
- 将用户可见文本永久硬编码为不可本地化字符串
- 绕过 runtime settings 声明直接读取隐式配置键

## 18. 首轮必须稳定的公开对象

1. `plugin.json` 的核心元数据字段
2. runtime spec 的核心字段
3. runtime context 的只读视图模式
4. tool 的 schema + permission + execute 合同
5. hook 的生命周期点与 handlerKind
6. UI slot 名称
7. provider binding 的声明模式
8. proposal output 的基本结构
9. `I18nText` 和 `locale` 的基本传播约束
10. runtime settings 字段声明合同

## 19. 首轮明确延期项

- 更多 UI slot
- 更复杂 hook handler 种类
- 更宽的 tool domain
- 更细粒度 provider 生命周期控制
- 更复杂的平台分发和审核接口
- 完整翻译资源打包和热切换机制
- 更复杂的跨插件配置依赖图
- 插件级生命周期钩子（onInstall / onEnable / onDisable / onUninstall）

## 20. 结论

Public Plugin API 的目标不是一次性开放所有能力，而是把真正需要长期稳定维护的接口收敛成一个小而清晰的公开面。  
只要这层稳定，插件生态增长不会直接绑死 kernel 内部实现。
