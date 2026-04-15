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

## 开发指南

| 文档 | 描述 |
|------|------|
| [../guide/plugin-authoring.md](../guide/plugin-authoring.md) | 插件作者完整指南 — 零代码到进阶,含 PR-3 RPC action 声明、PR-5 段职责约束 |
| [../guide/plugin-ui-runtime-guidelines.md](../guide/plugin-ui-runtime-guidelines.md) | 插件 UI 与交互运行时指南 — `ui.message / ui.right`、`plugin_data`、`submitBehavior`、session 起始流程与图谱/图鉴边界 |
| [../guide/e2e-plugin-verify.md](../guide/e2e-plugin-verify.md) | 插件端到端验证脚本 — `scripts/e2e-plugin-verify.ts` 的 7-Phase 流程、CLI 参数、触发断言、artefact 落盘约定 |
| [../guide/skills.md](../guide/skills.md) | Skills 使用与编写指南(PR-4) — 外部代理可加载的 markdown skill 包,`skills/` 目录结构,SKILL.md 模板,与 framework 边界 |

## Prompt 组装

| 文档 | 描述 |
|------|------|
| [prompt-structure.md](prompt-structure.md) | V2 三段式 Prompt Assembler — 10 段结构、Author's Note / Post-History、Anthropic cache_control 注入、V1→V2 迁移 playbook |

## 注册表

| 文档 | 描述 |
|------|------|
| [plugins.md](plugins.md) | 插件注册表 — 所有已实现的插件（含 core-world-init 多 runtime）、元信息、触发方式、依赖关系 |
| [tools.md](tools.md) | 工具注册表 — 所有可用工具（含 plugin-data 工具）、短 ID 系统、审批策略、创建指南 |

## 变更记录

| 文档 | 描述 |
|------|------|
| [changelog-session-state.md](changelog-session-state.md) | Session State & Narrative Flow 改动记录 — context 注入增强、phase 门控、消息持久化、已知问题清单 |

## 近期能力(本 session 新增)

| 能力 | 文档 | 说明 |
|------|------|------|
| **PR-1 翻译层** | [api.md](api.md) `runtime-outputs`/`interaction-records` 端点 | `RuntimeOutput` + `InteractionRecord` 统一观测格式,跨 runtime 消费的标准化输出 |
| **PR-2 startTurn** | [plugins.md](plugins.md) 触发字段 | `playingTurnNumber` 按 playing 阶段从 0 计数,`trigger.startTurn` 在此基础上做门控 |
| **PR-3 Plugin RPC** | [api.md](api.md#post-apisessionsidplugin-rpc) + [protocol.md](protocol.md#插件-rpcpr-3) | `POST /api/sessions/:id/plugin-rpc` 统一通道(action 级 + runtime 级),PLUGIN.md 新 `rpc:` 字段,框架默认 `submit-form` handler |
| **PR-4 Skills** | [../guide/skills.md](../guide/skills.md) | 外部代理可加载的 markdown skill 包 |
| **PR-5 段职责** | [../guide/plugin-authoring.md](../guide/plugin-authoring.md) §1.4.1 | pre / narrator / post 段写约定(软约束),core-codex 函数化清理,player-init 转 agent runtime |
| **PR-6 Per-Session 模型覆盖** | [api.md](api.md#patch-apisessionsid) `runtimeModelOverrides` | `PATCH /api/sessions/:id` 接受 runtime → slot 映射,turn-executor 每次执行前快照应用 |
| **PR-7 RPC Approval** | [api.md](api.md#rpc-approval-流程pr-7) + [protocol.md](protocol.md#rpc-approvalpr-7) | community-trust 插件 RPC 调用的 human-in-loop 批准,`once` / `session` 双 scope,排队封顶 |

## 计划中

| 文档 | 描述 |
|------|------|
| slots.md | 模型 slot 配置参考 — slot 命名、provider 配置、优先级解析链 |
| store-backends.md | 存储后端参考 — Memory/SQLite/IDB/PG 四种后端的能力对比与配置 |
| events.md | 事件系统参考 — 事件类型、topic 命名、订阅模式 |
| approval.md | 审批系统参考 — 权限规则、审批流程、自定义策略 |
