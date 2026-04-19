# Covel 文档

Covel 是一个插件驱动的 AI 交互式叙事引擎 ([根目录 README](../README.md))。本目录收纳所有开发、参考、架构与发布相关文档。

> 🇬🇧 [English index](./README.en.md)

## 目录

```
docs/
├── README.md                # 中文索引（本文件）
├── README.en.md             # 英文 README / 项目简介
├── CHANGELOG.md             # 版本发布记录（Keep a Changelog）
├── CONTRIBUTING.md / .en.md # 贡献指南
│
├── guide/                   # 上手与作者指南
│   ├── plugin-authoring.md
│   ├── plugin-ui-runtime-guidelines.md
│   ├── e2e-plugin-verify.md
│   ├── e2e-testing.md
│   └── skills.md
│
├── reference/               # API / 协议 / 插件 / 工具参考
│   ├── README.md
│   ├── api.md
│   ├── protocol.md
│   ├── plugins.md
│   ├── tools.md
│   ├── ui-panels.md
│   ├── prompt-structure.md
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
4. **理解执行** — [`architecture/flow.md`](./architecture/flow.md) 描述整条回合管线
5. **查 API** — [`reference/api.md`](./reference/api.md) 与 [`reference/protocol.md`](./reference/protocol.md)
6. **发布** — [`CONTRIBUTING.md#release-process`](./CONTRIBUTING.md#release-process) + [`../apps/desktop/PACKAGING.md`](../apps/desktop/PACKAGING.md)

## 文档约定

- 任何影响框架能力（API / 插件 frontmatter / 工具 / UI slot）的代码改动，**必须**同步更新对应的 `reference/` 文档，否则 PR 视为未完成
- 架构讨论、设计决策、执行模型放在 `architecture/`，变化较慢
- `guide/` 面向「写插件」「做测试」「用 skills」这类 how-to
- 参见 [`CONTRIBUTING.md` 文档同步小节](./CONTRIBUTING.md#文档同步)
