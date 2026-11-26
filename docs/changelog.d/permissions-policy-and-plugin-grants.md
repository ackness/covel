### Added

- **Instance permission policy and per-plugin persistent grants (`/api/permissions/*`).** Added the L2 `permissions.policy` server setting (overridable via `COVEL_PERMISSIONS_POLICY`) and the L3 `plugin_grants` store table bound to each community package's content digest and capability snapshot; unified `GET /api/permissions/snapshot`, `PUT /api/permissions/policy`, `GET /api/permissions/plugins`, and `PUT` / `DELETE /api/permissions/plugins/:pluginId/grants` endpoints, plus additive `grants` listing on `GET /api/sessions/:id/approvals` and `"persistent-grant"` on `serverCodeApprovedBy`. See [HTTP API](../en/reference/api.md), [Environment registry](../en/reference/env-registry.md), and [Security](../en/internals/security.md).

### Security

- **Fail-closed L1 → L2 → L3 pre-checks and sticky denies across plugin approvals.** `RpcApprovalGate` enforces host capability ceilings, instance policies, and persistent plugin grants before queuing or honoring session approvals; digest tamper or capability escalation invalidates persisted `allow` grants while sticky `deny` entries persist across updates and override implicit `trust.sources` grants.
