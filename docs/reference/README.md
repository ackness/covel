# 框架参考文档

Covel 框架能力注册表与 API 参考。

## API

| 文档 | 描述 |
|------|------|
| [api.md](api.md) | HTTP API 参考 — 所有 API 端点（含插件数据 CRUD）、请求/响应格式、curl 示例、存储模式说明 |

## 协议

| 文档 | 描述 |
|------|------|
| [protocol.md](protocol.md) | 通讯协议参考 — 事件类型、命令类型、SSE 信封格式、前端事件路由、Transport 抽象 |

## 前端

| 文档 | 描述 |
|------|------|
| [ui-panels.md](ui-panels.md) | 右侧面板 Tab 定义 — 7 个 Tab 的职责、数据源、渲染模式、扩展指南 |

## 注册表

| 文档 | 描述 |
|------|------|
| [plugins.md](plugins.md) | 插件注册表 — 所有已实现的插件（含 core-world-init 多 runtime）、元信息、触发方式、依赖关系 |
| [tools.md](tools.md) | 工具注册表 — 所有可用工具（含 plugin-data 工具）、短 ID 系统、审批策略、创建指南 |

## 变更记录

| 文档 | 描述 |
|------|------|
| [changelog-session-state.md](changelog-session-state.md) | Session State & Narrative Flow 改动记录 — context 注入增强、phase 门控、消息持久化、已知问题清单 |

## 计划中

| 文档 | 描述 |
|------|------|
| slots.md | 模型 slot 配置参考 — slot 命名、provider 配置、优先级解析链 |
| store-backends.md | 存储后端参考 — Memory/SQLite/IDB/PG 四种后端的能力对比与配置 |
| events.md | 事件系统参考 — 事件类型、topic 命名、订阅模式 |
| approval.md | 审批系统参考 — 权限规则、审批流程、自定义策略 |
