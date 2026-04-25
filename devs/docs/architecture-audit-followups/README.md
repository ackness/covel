# 2026-04-21 架构审计 · 剩余跟进项

2026-04-21 的架构审计识别了 6 个发现。F1 (phase 迁移收口)、F2 (hook pipeline 接入) 和 F6 (文档同步) 已在分支 `fix/architecture-audit-2026-04-21` 上实施并附带 follow-through 优化(见该分支的最新 commit)。原始审计产出在本地 `audits/2026-04-21-architecture-code-audit/`(gitignored 的 handoff bundle)。

这个目录收录**尚未实施**的 4 个跟进 ticket。每份文档自包含:原因 / 当前证据 / 实施方案 / 风险 / 验收标准 / 参考文件,足以让一个没有上下文的工程师或 agent 独立完成。

## 文档列表

| Ticket | 主题 | 预估 | 风险 | 阻塞场景 |
|--------|------|------|------|---------|
| [F3](./F3-plugin-data-commit-chain.md) | 把 `plugin-data` 写路径纳入统一 commit chain | 5–7h | 中(要迁 8 个 core 插件 local tool) | 需要 hook 拦截 plugin-data 写入时 |
| [F4](./F4-suspend-resume-web.md) | Web 端 suspend/resume 能力闭环 | 6–8h | 低(纯前端) | 使用 suspend 机制的插件有人部署时 |
| [F5](./F5-distributed-session-lock.md) | PostgreSQL 后端分布式 session lock | 7h | 中(需要 PG 测试环境) | 多实例生产部署 **前** 必须 |
| [F7](./F7-flow-diagram-refresh.md) | `flow.md` 架构图重绘 + Mermaid 化 | 2.5h | 低(纯文档) | 架构可信度维护 |
| [A2-P1-5](./A2-P1-5-function-runtime-trace.md) | function runtime gateway 调用补 trace | 3–5h | 低(纯增加事件类型) | 第三方异步插件调试 |
| [A2-P1-7](./A2-P1-7-latest-narrative-inject.md) | 新增 `runtime-output-history` inject kind | 4–6h | 低(向下兼容) | 图像 / 摘要类插件画面一致性 |
| [A2-P2-11](./A2-P2-11-hitl-approval-panel.md) | HITL 审批 UI 升级（替换浏览器 confirm） | 6–10h | 中(需要新增 Dialog + store 表) | 第三方生态启用 |

> F7 编号跳到 7 是因为原审计的 6 条里 F6(文档同步)已落地,不重复编号。

## 建议顺序(按 ROI)

1. **F7** — 最小工时, 恢复架构文档可信度
2. **F3** — 解决治理双轨制, 为未来审批/配额/回滚铺路
3. **A2-P1-5** — function runtime gateway trace, 第三方插件可观测性
4. **A2-P1-7** — `runtime-output-history` inject, 图像类插件画面一致性
5. **F4** — 把后端已有能力开放给用户
6. **A2-P2-11** — HITL 审批 UI 升级, 第三方生态前置项
7. **F5** — 生产多实例部署前的必做项

## 2026-04-25 audit (docs ↔ code framework alignment) follow-ups

| Ticket | 主题 | 状态 |
|--------|------|------|
| [A2-P1-5](./A2-P1-5-function-runtime-trace.md) | function-runtime gateway 调用补 trace | pending |
| [A2-P1-7](./A2-P1-7-latest-narrative-inject.md) | `runtime-output-history` inject kind | pending |
| [A2-P2-11](./A2-P2-11-hitl-approval-panel.md) | HITL 审批 UI 升级 | pending |

剩余 P0/P1 项已在主分支落地 —— 详见 `audits/2026-04-25-docs-code-framework-alignment/RECOMMENDATIONS.md`，对应 commit 在本会话归档。

## 每份文档独立执行的前提

- 已经 checkout `fix/architecture-audit-2026-04-21` 分支或从它再开子分支
- 运行过 `pnpm install` 使依赖齐备
- 能跑 `pnpm lint` / `pnpm test`
- F5 需要 `pnpm db:up` 能起本地 PG

## 原审计报告

完整背景在本地 `audits/2026-04-21-architecture-code-audit/{README,verification}.md` —— 该目录是 gitignored 的 handoff bundle,不随仓库分发。每份 ticket 文档都抽取了与自身相关的审计证据并内嵌,独立阅读不需要原报告。
