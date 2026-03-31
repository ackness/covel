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

  // Track state.patch keys for conflict detection
  const patchKeys = new Map<string, string>(); // key → first proposalId

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
      if (item.kind === "state.patch") {
        const payload = item.payload as Record<string, unknown>;
        for (const key of Object.keys(payload)) {
          const existing = patchKeys.get(key);
          if (existing && existing !== envelope.proposalId) {
            isValid = false;
            rejectReason = `State key "${key}" conflict with proposal "${existing}"`;
            break;
          }
          patchKeys.set(key, envelope.proposalId);
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
