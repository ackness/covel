# Covel Documentation Policy

本页定义 Covel 正式文档的组织方式和信息分层。

## Decision

面向用户和开发者的正式文档源放在主仓库 `docs/`。任务计划、审查记录、实施日志、临时分析和交接材料放在 `devs/docs/`。

## Why

插件 manifest、world data、API、协议、store contract 和 runtime 行为都需要和代码在同一 PR 中同步。主仓库内维护能让 CI、代码 review、测试和文档同步规则使用同一套变更上下文。

## Information Architecture

| Section              | Purpose                                      | Source of truth                       |
| -------------------- | -------------------------------------------- | ------------------------------------- |
| `docs/README.md`     | 文档总入口和搜索地图                         | 当前文档树                            |
| `docs/guide/`        | 任务型教程                                   | reference + 示例插件                  |
| `docs/reference/`    | 权威契约                                     | schema、types、routes、runtime、tests |
| `docs/architecture/` | 模块边界和设计原因                           | 实现代码 + 历史决策                   |
| `docs/glossary.md`   | 统一术语                                     | reference 页面                        |
| `devs/docs/`         | 任务计划、审查、实施日志、临时分析与交接材料 | 稳定结论提炼后迁入正式 `docs/` 分类   |

## Authoring Rules

- `guide/` 页面回答“怎么做”，第一页就给最小可运行路径。
- `reference/` 页面回答“合法值是什么”，字段表必须列出枚举、默认值、阶段和代码来源。
- `architecture/` 页面回答“为什么这样设计”，必须包含模块边界和失败模式。
- 开发过程资料统一放在 `devs/docs/`；落地后只把面向用户或开发者的稳定结论提炼到 `docs/guide/`、`docs/reference/` 或 `docs/architecture/`。
- 新增文档要从 `docs/README.md` 或对应目录 `README.md` 可达。
