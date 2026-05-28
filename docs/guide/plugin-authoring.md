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

| 你想做的事                                                  | 看这里                                                                                                                                                                 |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 看所有已实现插件的 frontmatter、调度层级、capabilities 标签 | [docs/reference/plugins.md](../reference/plugins.md)                                                                                                                   |
| 写 json-render UI 面板（`ui.right` / `ui.message`）         | [docs/guide/plugin-ui-runtime-guidelines.md](./plugin-ui-runtime-guidelines.md)                                                                                        |
| 写生命周期 hook（工具调用前校验、commit 前审批、审计日志）  | [docs/reference/plugins.md#hooks](../reference/plugins.md#hooks)                                                                                                       |
| 写图像生成 / 媒体资产插件                                   | [docs/guide/plugin-authoring-advanced.md#图像生成的设计](./plugin-authoring-advanced.md#图像生成的设计) · [docs/reference/media-store.md](../reference/media-store.md) |
| 让插件配套世界数据、角色卡、媒体或 override 包              | [docs/reference/world-data.md](../reference/world-data.md)                                                                                                             |
| 写单元 / 集成 / 真实 LLM E2E 测试                           | [docs/guide/plugin-testing.md](./plugin-testing.md) · [docs/guide/e2e-plugin-verify.md](./e2e-plugin-verify.md)                                                        |
| 看内置工具完整清单 + 审批策略                               | [docs/reference/tools.md](../reference/tools.md)                                                                                                                       |
| 看 prompt 如何组装（10 段 + cache_control）                 | [docs/reference/prompt-structure.md](../reference/prompt-structure.md)                                                                                                 |
| 程序化发现框架和插件提供哪些字段、工具、数据 namespace      | [docs/reference/api.md 插件管理](../reference/api.md#插件管理)                                                                                                         |

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

> **要做手动按钮 / 后台任务 / 多 runtime 协作 / 图像生成**？这些范式没有内置插件作为模板,直接看 [`.claude/skills/create-plugin/references/example-plugins.md`](../../.claude/skills/create-plugin/references/example-plugins.md) 的 dashscope-image-gen 综合样例。

### C. Hook 组合行为

`PLUGIN.md` 可以声明 `hooks`，用于接入工具调用、runtime 执行、状态提交、回合开始和结束等生命周期点。

```yaml
hooks:
  - event: PreToolUse
    handler: ./hooks/validate-tool.ts
    enforce: pre
    timeoutMs: 3000
```

`PreRuntime`、`PreToolUse`、`PreStateCommit` 使用 `sequential` 语义：handler 按顺序执行，`replace` 会成为下一个 handler 的输入，`abort` 会停止该生命周期动作。

`TurnStart`、`PostRuntime`、`PostToolUse`、`PostStateCommit`、`TurnStop` 使用 `parallel` 语义：handler 并发执行，适合审计、日志、指标和通知这类观察型副作用。返回 `replace` 或 `abort` 会进入 hook trace；主 payload 保持原值。

排序先看 `enforce: pre | normal | post`，再看全局 hook 与插件 hook 分组，最后保持声明顺序。完整事件表见 [插件参考 / hooks](../reference/plugins.md#hooks)。

### D. 文件结构速查

```
plugins/<plugin-id>/
├── README.md             # 必需：给人类 / 开发者看的插件说明
├── PLUGIN.md              # 必需：frontmatter + 提示词
├── package.json           # 必需：workspace 依赖
├── .npmrc                 # 必需：供应链防护（minimum-release-age=10080）
├── vitest.config.ts       # 可选：测试配置
├── tools/                 # 可选：本地工具
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
