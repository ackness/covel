# Covel 插件开发指南

> Covel 是一个 AI RPG 框架，核心理念：**插件承载游戏逻辑，内核提供原语和编排**。每个插件本质上是一个 `PLUGIN.md` 文件——YAML frontmatter 定义元信息，Markdown 正文就是 LLM 的 system prompt。

这份指南按三个难度层次拆成三份文档。先决定自己属于哪条路径，再从对应的文档开始读。

## 三条路径

| 路径 | 面向的人 | 前置要求 | 你将产出什么 | 文档 |
|------|---------|---------|-------------|------|
| **零代码** | 内容创作者，只写 Markdown | 会用 YAML + Markdown | 一个只含 `PLUGIN.md` 的插件，能自动触发、调用内置 UI 工具、按关键词加载 `references/`、打包成世界包 | [plugin-authoring-zero-code.md](./plugin-authoring-zero-code.md) |
| **进阶（agent + 本地 JS）** | 已经会零代码，要加一点 JS | 会写基础 JS/TS、会用 Zod | 本地 `tools/*.js`、`interaction` 返回的玩家交互块、`input.inject` 跨插件注入、`rpc:` action、集成测试 | [plugin-authoring-agent.md](./plugin-authoring-agent.md) |
| **高级（TypeScript + 审批 + 发布）** | 要发布社区插件或做复杂游戏系统 | 熟悉 TS 类型系统、vitest、SillyTavern/NovelAI 之类的 prompt 工程概念 | 完整 TS 类型约束、多 runtime 插件、自定义审批、`I18nText` 合规、发布 checklist | [plugin-authoring-advanced.md](./plugin-authoring-advanced.md) |

## 交叉引用

| 你想做的事 | 看这里 |
|-----------|-------|
| 看所有已实现插件的 frontmatter、调度层级、capabilities 标签 | [docs/reference/plugins.md](../reference/plugins.md) |
| 写 json-render UI 面板（`ui.right` / `ui.message`） | [docs/guide/plugin-ui-runtime-guidelines.md](./plugin-ui-runtime-guidelines.md) |
| 写单元 / 集成 / 真实 LLM E2E 测试 | [docs/guide/plugin-testing.md](./plugin-testing.md) · [docs/guide/e2e-plugin-verify.md](./e2e-plugin-verify.md) |
| 看内置工具完整清单 + 审批策略 | [docs/reference/tools.md](../reference/tools.md) |
| 看 prompt 如何组装（10 段 + cache_control） | [docs/reference/prompt-structure.md](../reference/prompt-structure.md) |

---

## 附录

### A. 内置 UI 工具快速参考

| 工具 | 参数 | 用途 |
|------|------|------|
| `create-form` | formId, title, fields[], submitLabel, narrativeTemplate | 创建玩家表单 |
| `create-choices` | choiceId, prompt, choices[] | 创建选项列表 |
| `create-notification` | level, title, message, icon? | 显示通知消息 |

完整工具清单（含 `plugin-data-*`、`create-character` 等）见 [docs/reference/tools.md](../reference/tools.md)。

### B. 现有插件参考

| 插件 | 优先级 | 触发 | 工具 | 复杂度 |
|------|--------|------|------|--------|
| core-narrator | 500 | auto | 无 | 零代码 |
| core-codex | 650 | auto | local + builtin | JS 工具 |
| core-char-creator | 700 | scheduled(1次) | builtin (create-form) | inject + 内置工具 |

完整注册表（含 `core-pregame` / `core-world-init` / `core-npc-graph` / `core-guide` 等）见 [docs/reference/plugins.md](../reference/plugins.md)。

### C. 文件结构速查

```
plugins/<plugin-id>/
├── PLUGIN.md              # 必需：frontmatter + 提示词
├── package.json           # 必需：workspace 依赖
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
