# A2-P2-11 · HITL 审批 UI 升级

来源：`audits/2026-04-25-docs-code-framework-alignment/RECOMMENDATIONS.md` §P2-11

## 问题

当前 community runtime 首次调用走浏览器原生 `confirm()` 弹窗（`apps/web/src/components/session/plugin-panel.tsx` 中的 `handleApprovalRequired`）：

- 弹窗里只显示一句"approval required"，没有 plugin id / source / declared tools / 动作摘要。
- 没有"允许一次 / 允许 session / 拒绝"三档。
- 没有撤销已授权插件的入口。

对玩家友好度低；对插件作者也无法把"我要用什么 capability"传达出去。

## 实施方案

### 后端

- `packages/approval/src/rpc-approval.ts` 已有 `evaluate / resolve` 流程，扩展 `verdict` 元数据：
  - `pluginId / source / requestedAction / declaredTools[]`。
- `apps/server/src/routes/api/approvals.ts` 暴露：
  - `GET /api/sessions/:id/approvals` —— 当前 session 已批准的插件列表 + 范围（once / session）。
  - `POST /api/sessions/:id/approvals/:pluginId/revoke` —— 撤销。

### 前端

- 新建 `apps/web/src/components/session/approval-dialog.tsx`：
  - 用 shadcn `Dialog` 取代浏览器 confirm。
  - 字段展示：pluginId、source（社区/官方/builtin）、要执行的 runtime/action、声明的 tools.local + tools.builtin、风险标签。
  - 按钮：`允许一次`、`整段 session 允许`、`拒绝`。
- 新建 `apps/web/src/components/session/approval-panel.tsx`：
  - 在 session 设置抽屉里展示已授权插件 + 撤销按钮。
- 更新 `plugin-panel.tsx` 的 `handleApprovalRequired`：
  - 用 dialog 取代 `window.confirm`。
  - 拿到 verdict 后回放原 RPC 请求。

### 协议

- `audits/2026-04-25-docs-code-framework-alignment/RECOMMENDATIONS.md` 已概述 approval 元数据。`docs/reference/api.md` 同步更新 `approvals` 端点形状。

## 风险

- 「session 范围允许」需要持久化到 store（`approvals` 表或 plugin_data 内置 namespace）。要确认现有 `approval-pipeline` 是否已支持 session-scoped cache（看上去是 in-memory），否则新建 store 表。
- Dialog 阻塞性：要保证用户拒绝/关闭 dialog 时原 RPC 不会被错误地视作"通过"。

## 验收标准

- 第三方插件首次点击触发，会弹出新版 dialog，显示 pluginId / source / 风险标签 / 工具列表。
- `允许一次`：通过原 RPC 一次后下次再点击仍弹窗。
- `整段 session 允许`：本 session 内不再弹窗。
- `撤销` 按钮在 session 设置中可用，撤销后下次点击重新弹窗。
- E2E 测试覆盖三档行为。

## 参考文件

- `apps/web/src/components/session/plugin-panel.tsx`
- `apps/server/src/routes/api/approvals.ts`
- `packages/approval/src/rpc-approval.ts`
- `apps/web/src/components/ui/dialog.tsx`
