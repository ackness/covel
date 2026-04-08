import type { ApprovalService, ApprovalCheckInput, ApprovalDecision, ApprovalGrantInput } from "./types.js";

/**
 * In-memory approval service.
 * Tracks session+plugin+tool approval grants.
 */
export function createApprovalService(
  /** Plugin IDs in the whitelist (auto-approved). */
  whitelistedPlugins: ReadonlySet<string> = new Set(),
): ApprovalService {
  // Key: "sessionId:pluginId:toolId"
  const grants = new Set<string>();

  function grantKey(sessionId: string, pluginId: string, toolId: string): string {
    return `${sessionId}:${pluginId}:${toolId}`;
  }

  async function check(input: ApprovalCheckInput): Promise<ApprovalDecision> {
    // Whitelisted plugins are always approved
    if (whitelistedPlugins.has(input.pluginId)) {
      return { allowed: true };
    }

    // Check existing grant
    const key = grantKey(input.sessionId, input.pluginId, input.toolId);
    if (grants.has(key)) {
      return { allowed: true };
    }

    return { allowed: false, reason: "User approval required." };
  }

  async function grant(input: ApprovalGrantInput): Promise<void> {
    const key = grantKey(input.sessionId, input.pluginId, input.toolId);
    grants.add(key);
  }

  return { check, grant };
}
