/**
 * Trust & Policy Layer
 *
 * Guards runtime execution, tool calls, and proposal commits.
 * Current implementation: permissive (allow-all).
 *
 * TODO: Replace with real policy engine when needed:
 * - Workspace-level restrictions (enterprise controls)
 * - Source-based trust (builtin vs community plugins)
 * - Capability-based permissions (which tools a runtime can invoke)
 * - Rate/budget limits per plugin
 */

// ── Decision ───────────────────────────────────────────────────────

export interface TrustDecision {
  allowed: boolean;
  reason?: string;
}

// ── Evaluation contexts ────────────────────────────────────────────

export interface RuntimeTrustContext {
  runtimeId: string;
  pluginId: string;
  kind: string;
  /** Where the plugin came from. */
  source?: "builtin" | "user" | "community";
}

export interface ToolTrustContext {
  toolId: string;
  pluginId: string;
  runtimeId: string;
  /** Tool mutation category from manifest. */
  kind: "query" | "mutation" | "side_effect";
}

export interface ProposalTrustContext {
  proposalId: string;
  pluginId: string;
  runtimeId: string;
  items: ReadonlyArray<{ kind: string }>;
}

// ── Policy interface ───────────────────────────────────────────────

export interface TrustPolicy {
  /** Check if a runtime is allowed to execute in this turn. */
  canExecuteRuntime(context: RuntimeTrustContext): TrustDecision;
  /** Check if a tool call is allowed. */
  canCallTool(context: ToolTrustContext): TrustDecision;
  /** Check if a proposal can be committed. */
  canCommitProposal(context: ProposalTrustContext): TrustDecision;
}

// ── Default: allow-all ─────────────────────────────────────────────

const ALLOW: TrustDecision = Object.freeze({ allowed: true });

/**
 * Permissive trust policy — allows everything.
 *
 * This is the default for development and single-player scenarios.
 * Replace with a restrictive policy for multi-tenant or community
 * plugin environments.
 */
export function createPermissiveTrustPolicy(): TrustPolicy {
  return {
    canExecuteRuntime: () => ALLOW,
    canCallTool: () => ALLOW,
    canCommitProposal: () => ALLOW,
  };
}
