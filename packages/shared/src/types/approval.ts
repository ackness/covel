/**
 * Approval pipeline types for human-in-the-loop tool authorization.
 */

export type ApprovalDecision = 'allow-once' | 'allow-session' | 'deny';

export interface ApprovalRequest {
  readonly toolName: string;
  readonly pluginId: string;
  readonly runtimeId: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly turnId: string;
  readonly sessionId: string;
}

export interface ApprovalRecord {
  readonly approvalId: string;
  readonly toolName: string;
  readonly pluginId: string;
  readonly decision: ApprovalDecision;
  readonly decidedAt: string;
  readonly turnId: string;
  readonly sessionId: string;
}

// ── PR-7: Plugin RPC approval ────────────────────────────────────

/**
 * Pending RPC approval request — created when a community-trust RPC call
 * arrives at `POST /api/sessions/:id/plugin-rpc` without a prior session
 * authorization. The frontend pulls these via `GET /api/approvals/...`,
 * shows a dialog, and posts the player decision back.
 */
export interface RpcApprovalPending {
  readonly approvalId: string;
  readonly sessionId: string;
  readonly pluginId: string;
  readonly action: string;
  readonly payload: unknown;
  readonly trustLevel: 'builtin' | 'official' | 'community';
  readonly requestedAt: string;
  /** One-line description from `RpcActionDecl.description`, surfaced to the user. */
  readonly description?: string;
}

/**
 * Player decision on a pending RPC approval. Two scopes:
 *
 *   - `once`: allow this single dispatch
 *   - `session`: cache approval for the (sessionId, pluginId, action) triple
 *                so subsequent calls in the same session bypass the dialog
 *
 * `deny` rejects the request and is never cached.
 */
export type RpcApprovalScope = 'once' | 'session';

export interface RpcApprovalDecision {
  readonly approvalId: string;
  readonly decision: 'allow' | 'deny';
  readonly scope?: RpcApprovalScope;
  readonly decidedAt: string;
}
