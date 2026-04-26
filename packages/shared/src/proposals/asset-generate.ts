import type { AssetGeneratePayload, MediaRef, Proposal, ProposalSource } from '../types/index.js';
import { mediaRefSchema } from '../types/index.js';

export interface AssetGenerateView {
  readonly id: string;
  readonly type: 'asset.generate';
  readonly sessionId: string;
  readonly turnId: string;
  readonly source: ProposalSource;
  readonly ref: MediaRef;
  readonly modality: string;
  readonly meta?: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

export interface AssetGenerateLLMPlaceholder {
  readonly type: 'asset.generate';
  readonly supported: false;
  readonly reason: 'ai-provider-content-parts-pending';
  readonly ref: MediaRef;
  readonly modality: string;
  readonly meta?: Readonly<Record<string, unknown>>;
}

export function isAssetGeneratePayload(value: unknown): value is AssetGeneratePayload {
  if (!value || typeof value !== 'object') return false;
  const payload = value as Record<string, unknown>;
  if (typeof payload.modality !== 'string' || payload.modality.length === 0) return false;
  if (!mediaRefSchema.safeParse(payload.ref).success) return false;
  if (payload.meta !== undefined && !isPlainRecord(payload.meta)) return false;
  return true;
}

export function isAssetGenerateView(value: unknown): value is AssetGenerateView {
  if (!value || typeof value !== 'object') return false;
  const view = value as Record<string, unknown>;
  const source = view.source as Record<string, unknown> | undefined;
  if (view.type !== 'asset.generate') return false;
  if (typeof view.id !== 'string' || view.id.length === 0) return false;
  if (typeof view.sessionId !== 'string' || view.sessionId.length === 0) return false;
  if (typeof view.turnId !== 'string' || view.turnId.length === 0) return false;
  if (!source || typeof source.pluginId !== 'string' || typeof source.runtimeId !== 'string') return false;
  if (typeof view.modality !== 'string' || view.modality.length === 0) return false;
  if (!mediaRefSchema.safeParse(view.ref).success) return false;
  if (view.meta !== undefined && !isPlainRecord(view.meta)) return false;
  if (typeof view.createdAt !== 'string' || view.createdAt.length === 0) return false;
  return true;
}

export function assetGenerateToView(proposal: Proposal): AssetGenerateView {
  if (proposal.type !== 'asset.generate') {
    throw new Error(`assetGenerateToView expected asset.generate, received ${proposal.type}`);
  }
  if (!isAssetGeneratePayload(proposal.payload)) {
    throw new Error('assetGenerateToView expected payload { ref: MediaRef, modality: string, meta?: object }');
  }

  return {
    id: proposal.id,
    type: 'asset.generate',
    sessionId: proposal.sessionId,
    turnId: proposal.turnId,
    source: proposal.source,
    ref: proposal.payload.ref,
    modality: proposal.payload.modality,
    ...(proposal.payload.meta ? { meta: proposal.payload.meta } : {}),
    createdAt: proposal.timestamp,
  };
}

export function assetGenerateToLLM(proposal: Proposal): AssetGenerateLLMPlaceholder {
  const view = assetGenerateToView(proposal);
  return {
    type: 'asset.generate',
    supported: false,
    reason: 'ai-provider-content-parts-pending',
    ref: view.ref,
    modality: view.modality,
    ...(view.meta ? { meta: view.meta } : {}),
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
