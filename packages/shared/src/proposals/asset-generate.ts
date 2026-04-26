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

export interface AssetGenerateLLMTextPart {
  readonly type: 'text';
  readonly text: string;
}

export interface AssetGenerateLLMImagePart {
  readonly type: 'image';
  readonly image: MediaRef;
}

export type AssetGenerateLLMPart = AssetGenerateLLMTextPart | AssetGenerateLLMImagePart;
export type AssetGenerateLLMContent = readonly AssetGenerateLLMPart[];

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

export function assetGenerateToLLM(proposal: Proposal): AssetGenerateLLMContent {
  return assetGenerateViewToLLM(assetGenerateToView(proposal));
}

/**
 * View-based counterpart to {@link assetGenerateToLLM}. Useful when the
 * view is already in hand (e.g. read back from `MessageRecord.metadata.block.data`
 * during LLM-history assembly) and reconstructing a full {@link Proposal}
 * envelope would be wasteful.
 *
 * Output shape mirrors {@link assetGenerateToLLM} byte-for-byte: a `text`
 * summary first, followed by an `image` part for any image-modality
 * asset. Adapters that cannot accept image parts (text-only models)
 * collapse the array back to its summary text — see the per-adapter
 * fallback in `@covel/ai-provider`.
 */
export function assetGenerateViewToLLM(view: AssetGenerateView): AssetGenerateLLMContent {
  const summary = [
    `Generated ${view.modality} asset`,
    `id=${view.ref.id}`,
    `mime=${view.ref.mime}`,
    `size=${view.ref.size}`,
  ].join(' ');

  const parts: AssetGenerateLLMPart[] = [{ type: 'text', text: summary }];
  if (view.modality === 'image' || view.ref.mime.startsWith('image/')) {
    parts.push({ type: 'image', image: view.ref });
  }
  return parts;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
