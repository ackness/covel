import type { Proposal } from '@covel/shared';

const TOOL_PENDING_PROPOSALS = Symbol.for('covel.tools.pendingProposals');
const TOOL_EXECUTION_ENVELOPE = Symbol.for('covel.tools.executionEnvelope');

export interface ToolExecutionEnvelope<T = unknown> {
  readonly content: T;
  readonly pendingProposals?: readonly Proposal[];
  readonly [TOOL_EXECUTION_ENVELOPE]?: true;
}

interface PendingProposalCarrier {
  readonly [TOOL_PENDING_PROPOSALS]?: readonly Proposal[];
  readonly [TOOL_EXECUTION_ENVELOPE]?: true;
}

export function withPendingProposals<T extends object>(
  content: T,
  pendingProposals: readonly Proposal[],
): T;
export function withPendingProposals<T>(
  content: T,
  pendingProposals: readonly Proposal[],
): T | ToolExecutionEnvelope<T> {
  if (pendingProposals.length === 0) {
    return content;
  }

  const copied = [...pendingProposals];

  if (content !== null && typeof content === 'object') {
    try {
      Object.defineProperty(content, TOOL_PENDING_PROPOSALS, {
        value: copied,
        enumerable: false,
        configurable: true,
        writable: true,
      });
      return content;
    } catch {
      // Fall through to the explicit envelope path.
    }
  }

  const envelope = { content, pendingProposals: copied } as ToolExecutionEnvelope<T>;
  Object.defineProperty(envelope, TOOL_EXECUTION_ENVELOPE, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return envelope;
}

function isExecutionEnvelope<T>(value: unknown): value is ToolExecutionEnvelope<T> {
  return !!value
    && typeof value === 'object'
    && (value as PendingProposalCarrier)[TOOL_EXECUTION_ENVELOPE] === true;
}

export function getToolContent<T>(value: T | ToolExecutionEnvelope<T>): T {
  return isExecutionEnvelope<T>(value) ? value.content : value;
}

export function getPendingProposals(value: unknown): readonly Proposal[] {
  if (isExecutionEnvelope(value)) {
    return value.pendingProposals ?? [];
  }
  if (value !== null && typeof value === 'object') {
    const proposals = (value as PendingProposalCarrier)[TOOL_PENDING_PROPOSALS];
    if (Array.isArray(proposals)) {
      return proposals;
    }
  }
  return [];
}
