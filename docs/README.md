# Covel 文档

Covel 是一个插件驱动的 AI 交互式叙事引擎 ([根目录 README](../README.md))。本目录收纳所有开发、参考、架构与发布相关文档。

> 🇬🇧 [English README](../README.en.md)

## 目录

```
docs/
├── README.md                # 中文索引（本文件）
├── CHANGELOG.md             # 版本发布记录（Keep a Changelog）
├── CONTRIBUTING.md / .en.md # 贡献指南
│
├── glossary.md              # 术语表（session / runtime / slot / …）
│
├── guide/                   # 上手与作者指南
│   ├── plugin-authoring.md
│   ├── plugin-ui-runtime-guidelines.md
│   ├── plugin-testing.md    # 插件测试（harness + 示例）
│   ├── e2e-plugin-verify.md
│   ├── e2e-testing.md
│   ├── desktop-config.md / .en.md  # 桌面版配置与数据目录
│   ├── themes.md
│   └── skills.md
│
├── reference/               # API / 协议 / 插件 / 工具参考
│   ├── README.md
│   ├── api.md
│   ├── protocol.md
│   ├── plugins.md
│   ├── tools.md
│   ├── ui-panels.md
│   ├── ui-components.md     # json-render 组件目录
│   ├── prompt-structure.md
│   ├── theme-packages.md
│   └── transactions.md
│
└── architecture/            # 系统设计与历史变更
    ├── flow.md
    ├── npc-graph.md
    └── changelog-session-state.md
```

## 开发者路径

1. **先看 README** — [`../README.md`](../README.md) 了解项目定位与快速开始
2. **贡献准备** — [`CONTRIBUTING.md`](./CONTRIBUTING.md) 的 Code style / Commit / Release 段
3. **写插件** — [`guide/plugin-authoring.md`](./guide/plugin-authoring.md) + [`reference/plugins.md`](./reference/plugins.md)
4. **做主题** — [`guide/themes.md`](./guide/themes.md) + [`reference/theme-packages.md`](./reference/theme-packages.md)
5. **理解执行** — [`architecture/flow.md`](./architecture/flow.md) 描述整条回合管线
6. **查 API** — [`reference/api.md`](./reference/api.md) 与 [`reference/protocol.md`](./reference/protocol.md)
7. **测试插件** — [`guide/plugin-testing.md`](./guide/plugin-testing.md) 的 harness / MockLLM / `e2e-plugin-verify` 选型
8. **查术语** — [`glossary.md`](./glossary.md) 对 session / runtime / slot / binding / proposal 等核心概念给出一页式定义
9. **发布** — [`CONTRIBUTING.md#release-process`](./CONTRIBUTING.md#release-process) + [`../apps/desktop/PACKAGING.md`](../apps/desktop/PACKAGING.md)（Electron）/ [`../apps/desktop-tauri/PACKAGING.md`](../apps/desktop-tauri/PACKAGING.md)（Tauri）

## 文档约定

- 任何影响框架能力（API / 插件 frontmatter / 工具 / UI slot）的代码改动，**必须**同步更新对应的 `reference/` 文档，否则 PR 视为未完成
- 架构讨论、设计决策、执行模型放在 `architecture/`，变化较慢
- `guide/` 面向「写插件」「做测试」「用 skills」这类 how-to
- 参见 [`CONTRIBUTING.md` 文档同步小节](./CONTRIBUTING.md#文档同步)
