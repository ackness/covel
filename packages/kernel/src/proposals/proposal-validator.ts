import type { KernelProposalEnvelope, ValidatedProposalEnvelope } from "@covel/shared";

const VALID_KINDS = new Set([
  "narrative.append",
  "state.patch",
  "event.emit",
  "record.upsert",
  "ui.render",
  "asset.generate",
]);

export interface ValidationResult {
  valid: ValidatedProposalEnvelope[];
  rejected: Array<{ envelope: KernelProposalEnvelope; reason: string }>;
}

/**
 * Validate proposal envelopes.
 *
 * First-round checks:
 * - All items have a valid proposal kind
 * - Basic schema validation (payload exists)
 * - Same-key conflict detection across envelopes
 */
export function validateProposals(
  envelopes: KernelProposalEnvelope[]
): ValidationResult {
  const valid: ValidatedProposalEnvelope[] = [];
  const rejected: Array<{ envelope: KernelProposalEnvelope; reason: string }> = [];

  // Track state.patch keys for conflict detection: full key → { runtimeId, proposalId }
  const patchKeys = new Map<string, { runtimeId: string; proposalId: string }>();

  for (const envelope of envelopes) {
    let isValid = true;
    let rejectReason = "";

    for (const item of envelope.items) {
      // Check valid kind
      if (!VALID_KINDS.has(item.kind)) {
        isValid = false;
        rejectReason = `Invalid proposal kind: "${item.kind}"`;
        break;
      }

      // Check payload exists
      if (item.payload === undefined || item.payload === null) {
        isValid = false;
        rejectReason = `Missing payload for "${item.kind}"`;
        break;
      }

      // Conflict detection for state.patch
      // Scope isolation: different scopes never conflict.
      // Same full key from different runtimes = conflict (same runtime can patch same key multiple times).
      if (item.kind === "state.patch") {
        const payload = item.payload as Record<string, unknown>;
        for (const key of Object.keys(payload)) {
          const existing = patchKeys.get(key);
          if (existing && existing.runtimeId !== envelope.runtimeId) {
            isValid = false;
            rejectReason = `State key "${key}" conflict: runtime "${envelope.runtimeId}" vs "${existing.runtimeId}" (proposal "${existing.proposalId}")`;
            break;
          }
          patchKeys.set(key, { runtimeId: envelope.runtimeId, proposalId: envelope.proposalId });
        }
        if (!isValid) break;
      }
    }

    if (isValid) {
      valid.push({
        ...envelope,
        validatedAt: new Date().toISOString(),
      });
    } else {
      rejected.push({ envelope, reason: rejectReason });
    }
  }

  return { valid, rejected };
}
