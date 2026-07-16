# Covel 插件开发指南

> Covel 是一个 AI RPG 框架，核心理念：**插件承载游戏逻辑，内核提供原语和编排**。`PLUGIN.md` 是运行时文件：YAML frontmatter 定义元信息，agent runtime 的 Markdown 正文会进入模型提示词。`README.md` 是人类文档，用来说明插件用途、实现情况和维护方式。

这份指南按三个难度层次拆成三份文档。先决定自己属于哪条路径，再从对应的文档开始读。

## 三条路径

| 路径                                 | 面向的人                       | 前置要求                                                             | 你将产出什么                                                                                          | 文档                                                             |
| ------------------------------------ | ------------------------------ | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| **零代码**                           | 内容创作者，只写 Markdown      | 会用 YAML + Markdown                                                 | 一个只含 `PLUGIN.md` 的插件，能自动触发、调用内置 UI 工具、按关键词加载 `references/`、打包成世界包   | [plugin-authoring-zero-code.md](./plugin-authoring-zero-code.md) |
| **进阶（agent + 本地 JS）**          | 已经会零代码，要加一点 JS      | 会写基础 JS/TS、会用 Zod                                             | 本地 `tools/*.js`、`interaction` 返回的玩家交互块、`input.inject` 跨插件注入、`rpc:` action、集成测试 | [plugin-authoring-agent.md](./plugin-authoring-agent.md)         |
| **高级（TypeScript + 审批 + 发布）** | 要发布社区插件或做复杂游戏系统 | 熟悉 TS 类型系统、vitest、SillyTavern/NovelAI 之类的 prompt 工程概念 | 完整 TS 类型约束、多 runtime 插件、自定义审批、`I18nText` 合规、发布 checklist                        | [plugin-authoring-advanced.md](./plugin-authoring-advanced.md)   |

## 交叉引用

| 你想做的事                                                       | 看这里                                                                                                                                                                                                                                                     |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 先理解为什么这么设计、agent/function/组合三种写法怎么选          | [docs/architecture/design-principles.md](../architecture/design-principles.md)                                                                                                                                                                             |
| 看所有已实现插件的 frontmatter、调度层级、capabilities 标签      | [docs/reference/plugins.md](../reference/plugins.md)                                                                                                                                                                                                       |
| 写 json-render UI 面板（`ui.right` / `ui.message`）              | [docs/guide/plugin-ui-runtime-guidelines.md](./plugin-ui-runtime-guidelines.md)                                                                                                                                                                            |
| 让 `ui.message` block 首次出现（避免"只有手动按钮无法自举"死锁） | [docs/reference/ui-panels.md#消息-block-声明](../reference/ui-panels.md#消息-block-声明)                                                                                                                                                                   |
| 写生命周期 hook（工具调用前校验、commit 前审批、审计日志）       | [docs/reference/plugins.md#hooks](../reference/plugins.md#hooks)                                                                                                                                                                                           |
| 写图像生成 / 媒体资产插件                                        | [docs/guide/plugin-authoring-advanced.md 第 6 节](./plugin-authoring-advanced.md#6-函数-runtime手动触发与后台执行)（`ctx.images` 契约 + `registerImageWire`）· [docs/reference/media-store.md](../reference/media-store.md#metadata-conventions--querying) |
| 让插件配套世界数据、角色卡、媒体或 override 包                   | [docs/reference/world-data.md](../reference/world-data.md)                                                                                                                                                                                                 |
| 写单元 / 集成 / 真实 LLM E2E 测试                                | [docs/guide/plugin-testing.md](./plugin-testing.md) · [docs/guide/e2e-plugin-verify.md](./e2e-plugin-verify.md)                                                                                                                                            |
| 看内置工具完整清单 + 审批策略                                    | [docs/reference/tools.md](../reference/tools.md)                                                                                                                                                                                                           |
| 看 prompt 如何组装（10 段 + cache_control）                      | [docs/reference/prompt-structure.md](../reference/prompt-structure.md)                                                                                                                                                                                     |
| 程序化发现框架和插件提供哪些字段、工具、数据 namespace           | [docs/reference/api.md 插件管理](../reference/api.md#插件管理)                                                                                                                                                                                             |

---

## World Data 与插件数据契约

插件可以通过 `PLUGIN.md` frontmatter 的 `dataSchemas` 声明可导入的 `plugin_data` namespace。世界包在 `data/world.data.yaml` 中使用 `schema: plugin://<pluginId>/<namespace>` 和 `to: plugin:<pluginId>/<namespace>` 引用该契约；服务器会在创建 session 前做 preflight，确认 schema URI 与 target namespace 兼容，并用插件包内 JSON Schema 校验每条 source item。

```yaml
dataSchemas:
  relationships:
    schemaVersion: 1
    acceptsWorldData: true
    schema: ./schemas/relationships.schema.json
    description: Importable relationship records.
```

字段规则：

- `schema` 相对插件根目录，并经过 realpath containment 校验。
- 多 runtime 插件的 `dataSchemas` 会合并为 plugin-level registry；同一 namespace 的声明需要完全一致。
- world-data importer 只接受 `acceptsWorldData: true` 的 namespace。
- 导入的数据写入 `plugin_data`、`lorebook`、`characters` 或 media index 后，会记录到 `world_data_import_ledger`，供 `/api/worlds/:id/sync-data` 做 dry-run、冲突检测和同步。

世界包引用示例：

```yaml
sources:
  social-links:
    kind: yaml
    path: data/social/links.yaml
    schema: plugin://social-sim/relationships
    to: plugin:social-sim/relationships
    key: id
```

完整 target URI、override 目录、preflight 和 sync API 见 [World Data reference](../reference/world-data.md)。

## 声明核心记忆块（`memoryBlocks`）

核心记忆（Letta 式 in-context memory）是框架原语：`@covel/memory` 负责「按块定义跑一次 LLM 抽取 + 持久化 + 渲染」，**块的语义（标签、显示名、抽取提示词）由插件以数据声明**，框架不硬编码任何块。插件在 `PLUGIN.md` frontmatter 用 `memoryBlocks` 声明自己的块，框架会聚合所有插件的声明来驱动每轮记忆更新。

```yaml
memoryBlocks:
  - label: suspects
    displayName: { zh: 嫌疑人, en: Suspects }
    icon: UserSearch
    extractionHint:
      zh: 已知嫌疑人、其动机、不在场证明与可信度变化。
      en: Known suspects, their motives, alibis, and shifts in credibility.
```

builtin `memory` 插件声明默认四块（`story_state` / `character_relationships` / `scene` / `player_profile`）。换一种游戏类型只需声明你自己的块，无需改动框架。字段规则（`label` / `displayName` / `extractionHint` / `icon` / `maxChars`）见 [plugins.md #memoryblocks核心记忆块](../reference/plugins.md#memoryblocks核心记忆块)。**世界包**也能在 `world.yaml` 顶层声明 `memoryBlocks`（按 session 合并到插件块之上），让题材专属的记忆维度随世界走——见 [world-data.md #世界记忆块memoryblocks](../reference/world-data.md#世界记忆块memoryblocks)。

## 运行时文案的 i18n（重要）

CI 的 `check-plugin-i18n` 校验 `ui/*.json` spec、`PLUGIN.md` frontmatter，**以及** 工具/hook handler `.js` 里 `label:` / `title:` / `placeholder:` 的裸 CJK 字面量。但工具/handler **写入 plugin_data 或 prompt 的运行时文案**仍需作者自觉处理，否则 en 会话会看到中文：

- **写给前端展示的标签**（如徽标 label）：存成 `I18nText` 对象 `{ zh, en }`，前端的 `Badge`/`Text` 等组件经 `resolveI18n` 按 locale 解析。例：`scene-prompts` 的 `prompt{N}Label`、`guide` 的 `category{N}Label`。
- **写给模型 / 通知的纯文本**（如 prompt 前言、欢迎通知）：用 `ctx.locale`（function runtime）或 hook payload 的 `locale` 在写入时解析成单一语言。例：`director` 的导演前言、`pregame` 的欢迎语。
- **agent runtime 的 `PLUGIN.md` 正文**（agent skill prompt）按 locale 解析 `PLUGIN.<locale>.md` → `PLUGIN.md`。正文含 CJK 的 agent 插件应配套提供 `PLUGIN.en.md`（如 `narrator` / `chat-mode-narrator`），否则 en 会话喂给模型的是中文指令。

## 程序化发现能力

第三方开发者和 AI Agent 可以先调用 discovery API，再决定该读哪份文档或写哪个字段：

- `GET /api/framework/capabilities`：框架支持的 manifest 枚举、builtin tools、proposal types、world-data target/schema URI、plugin-data 写入路径。
- `GET /api/plugins/:id/contract`：某个插件声明的 runtimes、capabilities、tools、rpc actions、UI slots、`dataSchemas` 和 plugin-data namespace。
- `GET /api/plugins/:id/plugin-data-contract`：某个插件的 plugin-data namespace/schema 子集。
- `GET /api/sessions/:id/plugin-data/:pluginId/_index`：某个 session 下插件实际已有的 namespace/key 索引，不返回 value。

这组 API 回答“当前框架和插件声明支持什么”；具体字段含义仍以 `docs/reference/`、插件 JSON Schema 和插件自己的 `PLUGIN.md` 为准。

## 附录

### A. 内置 UI 工具快速参考

| 工具                  | 参数                                                    | 用途         |
| --------------------- | ------------------------------------------------------- | ------------ |
| `create-form`         | formId, title, fields[], submitLabel, narrativeTemplate | 创建玩家表单 |
| `create-choices`      | choiceId, prompt, choices[]                             | 创建选项列表 |
| `create-notification` | level, title, message, icon?                            | 显示通知消息 |

完整工具清单（含 `plugin-data-*`、`create-character` 等）见 [docs/reference/tools.md](../reference/tools.md)。

### B. 现有插件参考

来源：`plugins/**/PLUGIN.md` 的 frontmatter（截至 v0.0.4）。

| Runtime                          | 优先级 | 触发            | 类型          | 工具 / 关键能力       | 学习价值                        |
| -------------------------------- | ------ | --------------- | ------------- | --------------------- | ------------------------------- |
| `pregame`                        | 10     | scheduled(首轮) | function      | 无                    | 最简 function runtime,纯初始化  |
| `world-init/schema-gen`          | 40     | scheduled(首轮) | agent + guard | local 工具            | guard 在 LLM 前跳过门控,零开销  |
| `char-creator/player-init`       | 50     | scheduled(首轮) | agent         | builtin (create-form) | 首轮表单 + Pre-Game 闸门        |
| `npc-graph/rag-retriever`        | 400    | auto            | function      | —                     | 给 narrator 预拉结构化检索      |
| `narrator`                       | 500    | auto            | agent         | 无                    | 零代码主叙事                    |
| `codex`                          | 600    | auto            | agent         | local + builtin       | JS 工具 + plugin-data inject    |
| `guide`                          | 600    | auto            | agent         | builtin               | inject narrator output 生成选项 |
| `npc-graph/extractor`            | 600    | auto            | agent         | local                 | NPC 关系抽取 + 写入图谱         |
| `char-creator/character-tracker` | 600    | auto            | agent         | local                 | 跟踪 NPC 状态变化               |
| `memory`                         | —      | UI only         | UI            | —                     | 纯前端面板,不占调度槽           |

完整注册表（含 priority bands、capabilities、frontmatter 全字段）见 [docs/reference/plugins.md](../reference/plugins.md)。

> **要做手动按钮 / 后台任务 / 多 runtime 协作**？这些范式没有内置插件作为模板,直接看 [`.claude/skills/create-plugin/references/example-plugins.md`](../../.claude/skills/create-plugin/references/example-plugins.md) 的 dashscope-image-gen 综合样例（注意：该样例的图像生成部分示范的是 `resolveSlot` 自管 wire 这条逃生口路径；新插件写**图像生成**本身请优先看 [plugin-authoring-advanced.md 第 6 节的 `ctx.images`](./plugin-authoring-advanced.md#6-函数-runtime手动触发与后台执行)）。

### C. Hook 组合行为

hook 在统一服务端入口（frontmatter `entry` 字段指向的模块）里用 `covel.on` 注册，接入工具调用、runtime 执行、状态提交、回合开始和结束等生命周期点：

```js
// server/index.js（PLUGIN.md: entry: ./server/index.js）
import validateTool from "../hooks/validate-tool.js";

export default function (covel) {
  covel.on("PreToolUse", validateTool, { enforce: "pre", timeoutMs: 3000 });
}
```

> 旧的 frontmatter `hooks:` 声明式写法已弃用（保留一个发布周期），事件表与执行语义与 `covel.on` 完全一致；`covel.on` 的 `match` 是谓词函数 `(payload) => boolean`，比旧的浅层等值 map 更灵活。

entry 工厂的完整类型（`PluginAPI` / `PluginToolkit` / `PluginEntryFactory`）从 `@covel/runtime` 导入：JS 用 JSDoc `@param {import('@covel/runtime').PluginAPI} covel`，TS 直接 `import type { PluginAPI } from "@covel/runtime"`——服务端实现按同一类型做编译期对齐，作者代码与框架不会悄悄漂移。

`PreRuntime`、`PostContextAssembly`、`PreLLMCall`、`PostLLMResponse`、`PreToolUse`、`PostToolUse`、`PreStateCommit` 使用 `sequential` 语义：handler 按顺序执行，`replace` 会成为下一个 handler 的输入，`abort` 会停止该生命周期动作。

围绕上下文与 LLM 调用的几个事件可改写模型交互本身：`PostContextAssembly` 在 `buildContext` 之后、进 loop 之前 turn 级（每 runtime 一次）改写已装配的 `systemPrompt` / 投影历史；`PreLLMCall` 在每次调用前非破坏性改写发往模型的 `messages` / `model` / `tools`（不动底层 transcript）；`PostLLMResponse` 在响应返回后、工具派发前 patch `content` / `toolCalls`。`PostToolUse` 还可用 `replace.terminate: true` 在记录工具结果后提前结束工具循环。

回合级还有一对压缩 hook：`PreCompaction`（`sequential`，`abort` 可让本回合跳过历史压缩、保留完整上下文）与 `PostCompaction`（`parallel`，观察压缩结果 `compacted` / `summaryId`）。另有 `PreSchedule`（`sequential`）：在触发选择之后、调度之前用 `replace.triggered` 收窄本回合实际运行的 runtime 集（条件门控 / 成本控制）。

会话级（无回合）有 `SessionStart`（会话创建后,payload `{sessionId, worldId}`）与 `SessionEnd`（状态→`ended` 或 DELETE,payload `{sessionId, reason}`）两个 `parallel` 观察 hook,适合 session 级初始化 / 清理。它们在 server 的 session 路由触发,`turnId` 为空。

**所有 hook 都是 session 作用域的**：pipeline 虽是全局单例,但执行时按当前 session 的激活插件集过滤——你的 hook **只对启用了你插件的 session 触发**(框架 hook 始终触发)。无需在 handler 里自行判断插件是否激活;`HookContext.activePluginIds` 可读当前激活集。

> **community 插件注意**：`entry` 里注册的 hook 从**插件激活时**（审批通过 / 首次 runtime 调度）起生效，而非 boot 时——激活点之前发生的早期事件（如本会话的 `SessionStart`）收不到。builtin/official 的 entry 在 boot 时运行,无此限制。

**读取本插件的会话级设置（`ctx.getOwnSettings`）**：hook handler 的 `ctx` 上有一个只读取数器 `getOwnSettings`，让 hook 行为可以「每会话可配」——无需声明 inject、也无需做工具调用往返。它复用了上面的 session 作用域（与 `activePluginIds` 同一个 ALS scope），由 pipeline 在调用每个 handler 前按其 `pluginId` 注入：

```ts
// hooks/validate-tool.ts
export default async function validateTool(ctx, payload) {
  const settings = ctx.getOwnSettings?.() ?? {};
  if (settings.strictMode === true) {
    // 按玩家保存的设置改变 hook 行为
    return { action: "abort", reason: "strict mode blocks this tool" };
  }
  return { action: "continue" };
}
```

约定与边界：

- **只读**：返回的是冻结快照（`Object.freeze`），不能写；hook 仍然只能 guard / rewrite / audit，没有任何写库或 eventBus 通道。
- **只看自己**：仅暴露 handler 所属插件的 `userSettings`（manifest 默认值与玩家保存值合并后的结果，回合起始拍一次），读不到其它插件的设置。
- **安全降级**：框架 / 全局 hook（无 `pluginId`）返回 `{}`；非回合作用域（session / resume / commit / characters 等只带 `activePluginIds`、不带 settings 的 scope）也返回 `{}`；在完全无作用域（例如单测直接调 `pipeline.run`）时 `ctx.getOwnSettings` 可能为 `undefined`——务必写成 `ctx.getOwnSettings?.() ?? {}`。

`TurnStart`、`PostCompaction`、`PostRuntime`、`PostStateCommit`、`TurnStop` 使用 `parallel` 语义：handler 并发执行，适合审计、日志、指标和通知这类观察型副作用。返回 `replace` 或 `abort` 会进入 hook trace；主 payload 保持原值。

排序先看 `enforce: pre | normal | post`，再看全局 hook 与插件 hook 分组，最后保持声明顺序。完整事件表见 [插件参考 / hooks](../reference/plugins.md#hooks)。

### D. 文件结构速查

```
plugins/<plugin-id>/
├── README.md             # 必需：给人类 / 开发者看的插件说明
├── PLUGIN.md              # 必需：frontmatter + 提示词
├── package.json           # 必需：workspace 依赖
├── .npmrc                 # 必需：供应链防护（minimum-release-age=10080）
├── vitest.config.ts       # 可选：测试配置
├── server/                # 可选：统一服务端入口（frontmatter entry 指向）
│   └── index.js           #   export default function (covel) { 注册工具/hook/RPC/wire }
├── tools/                 # 可选：本地工具（由 server/index.js 导入并 registerTool）
│   └── my-tool.ts
├── tests/                 # 可选：测试文件
│   └── my-plugin.test.ts
├── references/            # 可选：按需加载的参考资料
│   └── lore-data.md
└── runtimes/              # 可选：多 runtime 子目录
    └── sub-runtime/
        └── PLUGIN.md
```

`README.md` 写给人类和开发者，建议包含：插件用途、玩家能看到什么、运行时组成、数据读写位置、主要文件、测试方式和已知限制。`PLUGIN.md` 写给框架和模型；单 runtime 插件的正文是提示词，多 runtime 插件的子目录 `PLUGIN.md` 正文才是各 runtime 的提示词。

> **多 runtime 插件的根 PLUGIN.md**：当 `runtimes/` 存在时，框架不再把根 `PLUGIN.md` 当成 runtime——但仍会读它的 frontmatter `name`/`description` 作为整个插件的展示信息。**没有**根 PLUGIN.md 时，UI 会回退显示 plugin id（如 `dashscope-image-gen`），不直观。详见 [plugins.md 多 runtime 插件](../reference/plugins.md#多-runtime-插件)。

### E. 供应链防护（`.npmrc`）

每个插件根目录必须包含 `.npmrc`，内容固定为：

```ini
# 供应链防护：拒绝安装发布不足 7 天的依赖版本（10080 分钟）
# 仅在本插件作为独立项目安装时生效；在 Covel 主仓 workspace 内会被根配置接管。
minimum-release-age=10080
```

**为什么需要每个插件单独配置：**

- `minimumReleaseAge` 是**安装方**（consumer-side）的策略，不是发布到 npm 的元数据；它由"谁在跑 `pnpm install`"决定，不会随 package 元信息分发。
- 在 Covel 主仓 workspace 内，根 `pnpm-workspace.yaml` 已声明 `minimumReleaseAge: 10080`，覆盖所有 workspace member。本字段对 workspace 内插件是冗余但无害。
- 当插件被**第三方独立 clone / 安装 / 作为 community plugin 通过 `COVEL_PLUGINS_DIR` 加载**时，下游用户在插件目录里跑 `pnpm install` 会读到本 `.npmrc`，7 天延迟规则即时生效。这是阻断"刚发布的恶意包"进入插件运行环境的最后一道防线。

**注意：**

- `.npmrc` 用 kebab-case (`minimum-release-age`)；`pnpm-workspace.yaml` 用 camelCase (`minimumReleaseAge`)。pnpm 两边都吃，但**不要混写**。
- `scripts/create-plugin.js` 生成的新插件骨架已自动带上此文件；如果是从已有插件 fork，请手动补齐。
- 如需为内部 scope 例外（例如自家 `@covel/*` 私包要立即生效），追加：
  ```ini
  minimum-release-age-exclude[]=@covel/*
  ```

### F. 依赖分层与复用规范

插件依赖声明的位置不是随意的——它由两条硬约束决定：**插件由玩家按需启用**，且**桌面打包只 stage 插件的 `dependencies`**（`apps/desktop/scripts/build.mjs` 的 `ensurePluginWorkspaceDeps`）。声明错位置 = 玩家启用该插件时 `ERR_MODULE_NOT_FOUND`。

**依赖分层（哪些进 `dependencies`、哪些进 `devDependencies`）：**

| 用途                                    | 位置              | 例子                                               |
| --------------------------------------- | ----------------- | -------------------------------------------------- |
| handler.js / guard.js **运行时 import** | `dependencies`    | `@covel/plugin-handlers-utils`、`@covel/tools`     |
| 仅 JSDoc / `import type` 引用的类型     | `devDependencies` | `@covel/plugin-loader`（`FunctionHandlerContext`） |
| 仅测试用                                | `devDependencies` | `@covel/plugin-test-utils`、`vitest`               |

- `function` runtime 必须把 handler 运行时依赖放 `dependencies`；`agent` / `zero-code` 没有 handler.js，通常不声明任何 `@covel` 运行时依赖。
- 脚手架（`@covel/create`）已按模板生成正确分层；从已有插件 fork 时手动核对，**不要把运行时依赖留在 `devDependencies`**（dev 能跑、打包后会缺）。

**共用包提取阈值（避免过度抽象）：**

`@covel/plugin-handlers-utils` 收纳 function-runtime handler 的纯函数 helper（输入规范化 + `makeProposal`）。提取门槛是经验法则：

- **≥3 个插件真实复用** → 提取到 `plugin-handlers-utils`。
- **1–2 个插件用** → 内联在插件本地，接受少量重复——去重收益只有在 3 个以上调用方时才盖过"多一条依赖边 + 多一处声明"的成本（YAGNI）。
- 有合法定制需求时（例如 `branch-reply` 的本地 `normalizeRequiredString` 额外强制长度上限）→ 本地定义优先，加一行注释说明为何不用共用版本。

**类型依赖显式化：** 只用到类型的 `@covel` 包，`.ts` 里用 `import type`、`.js` 里用 JSDoc `@param {import('@covel/...').Type}`，并放 `devDependencies`。这样 `package.json` 自我说明：`dependencies` = 运行时真需要，`devDependencies` = 开发期才需要。

**依赖卫生（自动对账）：** CI 的 `pnpm deps:check`（knip）拦截 unused / missing 依赖——声明了不用、或用了没声明都会让 CI 失败。knip 能识别 JSDoc 类型引用和测试文件，type-only / test-only 依赖不会被误判。本地可随时 `pnpm deps:check` 自查。
