# Wave 3 audit remediation

## Goal

Close the actionable Critical, High, and bounded Medium findings in
`audits/2026-07-15_wave-3-review/REPORT.md` while preserving self/desktop
behavior and the existing plugin/runtime architecture.

## Scope

- Hosted operator authorization for global mutations and generation routes.
- End-to-end Web owner/operator credential propagation, including forks.
- Operator-authorized, session-scoped community server-code approval and revocation.
- Cross-pod event ordering, gap reset, bounded SSE delivery, and complete Web
  rehydration.
- IDB snapshot metadata pagination, streaming/export correctness, request-log
  redaction, and Turbo desktop outputs.
- Focused regression tests and matching API/protocol/tool documentation.

## Assumptions

- `self` and desktop tiers remain token-free and keep current behavior.
- `demo`/`commercial` use `COVEL_DESKTOP_REST_TOKEN` as the current operator
  primitive; full user identity and tenant billing remain product work.
- Community server code executes in-process: hosted tiers treat its import as
  operator-level global trust plus a per-session grant. Full multi-tenant code
  isolation remains a separate worker/process architecture project.
- PostgreSQL LISTEN/NOTIFY remains best-effort in this wave. A detected gap
  must force reset even though durable cross-pod cursors remain future work.

## Risks

- Broad auth middleware can accidentally block public read endpoints or local
  workflows.
- Approval changes touch plugin activation order and can alter first-turn hook
  behavior.
- Reset/rehydration changes can race live events without an explicit revision
  boundary.
- IDB schema changes require safe upgrade behavior for existing databases.

## Steps

1. Add centralized hosted operator/owner header helpers and negative route-graph
   tests; wire all browser session calls and child fork credentials.
2. Gate process-global community import with hosted operator authorization;
   check per-session grants on runtime/hook execution and revoke pending grants.
3. Split transport sequence from local replay sequence, invalidate replay state
   on transport gaps, serialize/bound SSE writes, and expand Web reset hydration.
4. Add true IDB keyset metadata access, preserve authoritative completed-message
   IDs, sanitize request logging, and declare desktop staging outputs.
5. Update API/protocol/tools/transactions documentation and run targeted then
   full repository validation.

## Validation

- Hosted auth integration: anonymous global mutation rejection; owner flow for
  create/action/media/approval/fork.
- Community activation: normal turn without grant stays dormant; session grant
  isolation and revoke behavior.
- Events: bidirectional interleave has no false gap; real gap emits reset;
  bounded client delivery; reset restores plugin data/suspensions/world.
- Store/Web/build focused suites, then `pnpm lint:ci`, `pnpm test`, `pnpm build`,
  `pnpm format:check`, and `pnpm check:i18n`.

## Rollback

- Revert by subsystem commit/patch: auth, approval, events, then performance and
  build changes are intentionally kept separable.
- IDB changes must be additive; rollback leaves new indexes/stores harmless.
- No destructive data migration is permitted in this wave.

## Implemented result

- Hosted global mutations and community code fail closed behind the operator
  credential; Web propagates owner/operator tokens, including fork children,
  and exposes browser-local operator credential setup with reload-based
  rehydration.
- Community entry import uses a fixed `plugin:server-code` approval before
  action discovery. The Web client processes the expected server-code and
  action approvals in a bounded two-stage loop. Hooks/runtime execution remain
  session-gated; entry factory store access and community guard side effects
  are denied.
- Event transport validates every fresh receive stream from sequence 1, uses
  per-stream ordering and reset-on-gap, and combines bounded SSE queues with
  revisioned Web rehydration.
- IDB v12 stores snapshot metadata for keyset reads; streaming rows subscribe by
  message id; authoritative message ids drive completion/export dedupe.
- Request logs redact tokens and Turbo tracks route generation plus desktop
  staging output.
