# Framework Reference

Covel 框架能力注册表与 API 参考。内容与 `@covel/shared`、`@covel/runtime`、`apps/server/src/routes/api/` 保持一致。

> 文档索引见 [`../README.md`](../README.md)。

## API

| 文档 | 描述 |
|------|------|
| [api.md](api.md) | HTTP API 参考 — 所有 API 端点（含插件数据 CRUD）、请求/响应格式、curl 示例、存储模式说明 |

## 协议

| 文档 | 描述 |
|------|------|
| [protocol.md](protocol.md) | 通讯协议 — SSE 事件类型、命令类型、envelope 格式、前端事件路由、Transport 抽象 |

## 前端

| 文档 | 描述 |
|------|------|
| [ui-panels.md](ui-panels.md) | 右侧面板 Tab 与 json-render 声明式 UI — 7 个 Tab 的职责、数据源、扩展指南 |

## Prompt 组装

| 文档 | 描述 |
|------|------|
| [prompt-structure.md](prompt-structure.md) | V2 三段式 Prompt Assembler — 10 段结构、Author's Note / Post-History、Anthropic cache_control 注入、V1→V2 迁移 playbook |

## 事务与持久化

| 文档 | 描述 |
|------|------|
| [transactions.md](transactions.md) | `DataStore` 事务契约（begin/commit/rollback）、四种后端的实现策略、`COVEL_COMMIT_TXN_V1` flag |

## 注册表

| 文档 | 描述 |
|------|------|
| [plugins.md](plugins.md) | 插件注册表 — 所有已实现的插件（含 core-world-init 多 runtime）、元信息、触发方式、依赖关系 |
| [tools.md](tools.md) | 工具注册表 — 所有可用工具（含 plugin-data 工具）、短 ID 系统、审批策略、创建指南 |

## 相关目录

- 开发指南：[`../guide/`](../guide/)
- 架构与历史：[`../architecture/`](../architecture/)

## 计划中

| 文档 | 描述 |
|------|------|
| slots.md | 模型 slot 配置参考 — slot 命名、provider 配置、优先级解析链 |
| store-backends.md | 存储后端参考 — Memory/SQLite/IDB/PG 四种后端的能力对比与配置 |
| events.md | 事件系统参考 — 事件类型、topic 命名、订阅模式 |
| approval.md | 审批系统参考 — 权限规则、审批流程、自定义策略 |
