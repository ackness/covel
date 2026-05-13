# Covel Docs Strategy

本页定义 Covel 文档的组织方式、信息分层和未来文档站策略。

## Decision

当前文档源继续放在主仓库 `docs/`。先把 `docs/` 做成稳定的信息架构，再引入静态站点生成器。只有当文档发布、版本切换、多语言、站内搜索和社区贡献流程成熟后，再把站点外壳拆成独立项目。

## Why

Covel 当前处在框架契约快速变化阶段。插件 manifest、world data、API、协议、store contract 和 runtime 行为都需要和代码同 PR 同步。主仓库内维护能让 CI、代码 review、测试和文档同步规则使用同一套变更上下文。

独立文档项目适合下面这些条件成立之后：

- 文档发布节奏和代码发布节奏需要解耦。
- 多版本文档需要长期保留，例如 `latest`, `stable`, `0.1`, `0.2`。
- 社区贡献者主要改文档，不需要拉完整应用仓库。
- 文档站需要独立构建、预览、搜索索引、翻译流程或内容权限。
- API/schema 可以从主仓库自动导出，独立站点只消费生成物。

## Reference Projects

Pi 的文档把入口分成 `Start here`, `Customization`, `Programmatic usage`, `Reference`, `Platform setup`, `Development`，每个页面有 `View source` 和 `Edit on GitHub`。这个结构适合 Covel：插件、skills、theme、programmatic API 都是一级导航。

SillyTavern 的文档站使用独立 `SillyTavern-Docs` 仓库，并按安装、使用、扩展、贡献等主题组织。它适合成熟社区文档，但会增加代码契约同步成本。

Covel 的当前策略是吸收两者的信息架构，不急于拆仓库。

## Information Architecture

| Section              | Purpose              | Source of truth                       |
| -------------------- | -------------------- | ------------------------------------- |
| `docs/README.md`     | 文档总入口和搜索地图 | 当前文档树                            |
| `docs/guide/`        | 任务型教程           | reference + 示例插件                  |
| `docs/reference/`    | 权威契约             | schema、types、routes、runtime、tests |
| `docs/architecture/` | 模块边界和设计原因   | 实现代码 + 历史决策                   |
| `docs/glossary.md`   | 统一术语             | reference 页面                        |
| Internal notes       | 草案、审计、迁移计划 | 对应实现落地后迁移到 `docs/`          |

## Static Site Plan

第一阶段保留 Markdown 文件结构，并在主仓库内新增文档站 workspace，例如 `apps/docs` 或 `docs-site`。推荐候选：

| Tool       | Fit                                          |
| ---------- | -------------------------------------------- |
| VitePress  | 简洁，Markdown 优先，适合当前 `docs/` 树。   |
| Starlight  | Astro 生态，搜索、多语言、侧边栏体验好。     |
| Docusaurus | 版本化强，适合文档和博客规模继续扩大后采用。 |
| Retype     | SillyTavern 同类站点风格，配置简单。         |

当前优先选择 VitePress 或 Starlight。两者都可以直接消费主仓库 `docs/**/*.md`，并保留 GitHub 可读性。

## Split Criteria

满足以下条件时再拆独立文档项目：

1. `docs/` 已有稳定 sidebar、站内搜索、broken-link check 和 preview deploy。
2. `reference/` 中的 API/schema 页面可以从代码生成或用 CI 校验。
3. 每个 release tag 都能发布对应文档版本。
4. 文档贡献量足以证明独立 issue/PR 队列有价值。
5. 主仓库内 `docs/` 和独立站点之间有自动同步机制。

拆分后推荐保留主仓库 `docs/` 的关键 reference 源文件，独立站点仓库负责站点配置、导航、翻译和生成内容。

## Authoring Rules

- `guide/` 页面回答“怎么做”，第一页就给最小可运行路径。
- `reference/` 页面回答“合法值是什么”，字段表必须列出枚举、默认值、阶段和代码来源。
- `architecture/` 页面回答“为什么这样设计”，必须包含模块边界和失败模式。
- 草案和审计资料保持为内部资料；落地后把稳定契约迁移到 `docs/reference/` 或 `docs/guide/`。
- 新增文档要从 `docs/README.md` 或对应目录 `README.md` 可达。
