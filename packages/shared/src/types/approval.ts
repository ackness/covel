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
  readonly decision: ApprovalDecision;
  readonly decidedAt: string;
  readonly turnId: string;
  readonly sessionId: string;
}
