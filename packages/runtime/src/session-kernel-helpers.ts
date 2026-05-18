/**
 * Session kernel shared helpers
 *
 * Internal module split from session-kernel.ts. Keep public imports routed
 * through session-kernel.ts unless a caller intentionally needs this boundary.
 */

import { isAssetGeneratePayload } from "@covel/shared";
import type {
  AssetGeneratePayload,
  Proposal,
  ProposalSource,
  ProposalType,
  SessionEvent,
} from "@covel/shared";

export function makeEvent(
  type: string,
  proposal: Proposal,
  payload: Record<string, unknown>,
): SessionEvent {
  return {
    id: crypto.randomUUID(),
    type,
    sessionId: proposal.sessionId,
    turnId: proposal.turnId,
    source: proposal.source,
    payload,
    timestamp: proposal.timestamp,
  };
}

export function collectUiBlocks(
  output: Record<string, unknown>,
  toolCalls?: ReadonlyArray<{ output?: unknown }>,
): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();

  const appendUi = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    const ui = (value as Record<string, unknown>).ui;
    if (!Array.isArray(ui)) return;

    for (const entry of ui) {
      if (!entry || typeof entry !== "object") continue;
      const block = entry as Record<string, unknown>;
      const key = JSON.stringify(block);
      if (seen.has(key)) continue;
      seen.add(key);
      blocks.push(block);
    }
  };

  appendUi(output);
  for (const call of toolCalls ?? []) {
    appendUi(call.output);
  }

  return blocks;
}

export function collectAssetGenerations(
  output: Record<string, unknown>,
): AssetGeneratePayload[] {
  const assets: AssetGeneratePayload[] = [];
  appendAssets(output.assetGenerations, assets);
  return assets;
}

function appendAssets(value: unknown, assets: AssetGeneratePayload[]): void {
  if (!Array.isArray(value)) return;
  for (const item of value) {
    if (isAssetGeneratePayload(item)) {
      assets.push(item);
    }
  }
}

export function resolveBlockType(payload: Record<string, unknown>): string {
  const type = typeof payload.type === "string" ? payload.type : "";
  if (type === "form") return "interactive_form";
  if (type === "choice") return "interactive_choice";
  if (type === "confirmation") return "interactive_confirmation";
  return type || "interactive_block";
}

export function makeProposal(
  type: ProposalType,
  source: ProposalSource,
  turnId: string,
  sessionId: string,
  payload: Record<string, unknown>,
): Proposal {
  return {
    id: crypto.randomUUID(),
    type,
    source,
    turnId,
    sessionId,
    payload,
    timestamp: new Date().toISOString(),
  };
}
