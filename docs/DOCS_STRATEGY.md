# Covel Documentation Policy

本页定义 Covel 正式文档的组织方式和信息分层。

## Decision

面向用户和开发者的正式文档源放在主仓库 `docs/`。任务计划、审查记录、实施日志、临时分析和交接材料放在 `devs/docs/`。

## Why

插件 manifest、world data、API、协议、store contract 和 runtime 行为都需要和代码在同一 PR 中同步。主仓库内维护能让 CI、代码 review、测试和文档同步规则使用同一套变更上下文。

## Information Architecture

全部文档在 `docs/`，按读者接触产品的顺序分章。`apps/docs` 用 VitePress 把它构建成文档站，发布在官网的 `docs/` 路径下。

| 位置              | 回答的问题                         | 以什么为准                            |
| ----------------- | ---------------------------------- | ------------------------------------- |
| `docs/README.md`  | 从哪里开始，代码入口在哪           | 当前文档树                            |
| `docs/start/`     | 怎样从安装走到一局能继续的游戏     | 应用的实际界面和行为                  |
| `docs/worlds/`    | 怎样把一份设定做成可玩的世界       | 参考页 + 内置世界                     |
| `docs/plugins/`   | 怎样把一个需求做成独立的扩展       | 参考页 + 脚手架和内置插件             |
| `docs/ship/`      | 怎样证明别人安装后也能用           | 安装接口和测试工具的实际行为          |
| `docs/recipes/`   | 已有基础后，怎样完成一个具体需求   | 参考页 + 内置实现                     |
| `docs/reference/` | 字段、默认值和报错是什么           | schema、types、routes、runtime、tests |
| `docs/internals/` | 它为什么这样执行，怎样参与开发     | 实现代码 + 设计决定                   |
| `devs/docs/`      | 任务计划、审查、实施日志、临时分析 | 稳定结论提炼后写进 `docs/`            |

## Authoring Rules

完整的写作规则在 [`AGENTS.md`](./AGENTS.md)。要点：

- **说人话。** 句子短，一句一个意思。先说读者做什么、看到什么，再给内部概念起名字。一个术语只在需要时引入，用一句大白话解释，不用读者没见过的术语去解释另一个术语。
- **教程给出结果。** 开头写清读者最后会得到什么、需要先准备什么。每个会运行东西的步骤都给出预期结果，页尾有一张“出了问题怎么办”的表。
- **命令真的跑过。** 页面上的命令、字段、默认值和界面文字，都要能在当前的脚本、schema、实现或界面词典里核对到。不把计划中的行为写成已有功能。
- **一个规则只在一页里定义。** 字段表和限制放在 `reference/`，教程链接过去，不重复一份。
- **涉及花钱和删数据的步骤要先提醒。** 调用付费模型、对外写入、删除数据之前，标出影响，并给出试运行、测试环境或备份的办法。
- 开发过程资料放在 `devs/docs/`，落地后只把稳定的结论写进 `docs/`。
- 新增页面要加进文档站的侧边栏和 [`README.md`](./README.md) 的页面清单。

## Languages

- The documentation is written in Simplified Chinese. Those pages are the source.
- `docs/en/` is the English edition: one translated page per Chinese page at the same relative path, published under `/docs/en/` with a language switch in the site header. A change to a Chinese page is made in its English page in the same pull request (`docs/AGENTS.md`, "The English edition").
- `docs/CONTRIBUTING.md` has `docs/CONTRIBUTING.en.md` beside it, and the root `README.md` (English) has `README.zh-CN.md`; each pair is updated together.
- The changelog is English only.
