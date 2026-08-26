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

- `guide/` 页面回答“怎么做”，第一页就给适用场景、前置条件和最小可运行路径；步骤必须说明预期结果，并为常见失败给出定位入口。
- `reference/` 页面回答“合法值是什么”，字段表必须列出枚举、默认值、阶段和代码来源；面向外部调用的契约至少给一个可复制的规范示例，并说明错误、权限、事务或兼容性边界。
- `architecture/` 页面回答“为什么这样设计”，必须包含模块边界和失败模式。
- 命令默认从仓库根目录执行，除非页面明确写出工作目录。示例中的命令、字段和返回值必须能从当前脚本、schema、实现或测试验证；不要用尚未实现的理想 API 代替现状。
- 教程不能停在目录或字段罗列。读者完成页面后应得到一个可观察结果，例如通过校验、看到 API 响应、加载插件、生成 artifact 或定位到明确错误。
- 涉及密钥、付费 provider、外部写入或数据删除的步骤必须在执行前标出影响，并提供 dry-run、测试环境或备份路径（如果当前工具支持）。
- 开发过程资料统一放在 `devs/docs/`；落地后只把面向用户或开发者的稳定结论提炼到 `docs/guide/`、`docs/reference/` 或 `docs/architecture/`。
- 新增文档要从 `docs/README.md` 或对应目录 `README.md` 可达。
