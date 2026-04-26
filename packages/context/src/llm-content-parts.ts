/**
 * Bridge helpers that lift wire-format message metadata into the
 * {@link LLMMessage} multimodal `content` shape.
 *
 * Background — committed `asset.generate` proposals are persisted as
 * wire-format `MessageRecord` rows where the asset itself lives under
 * `metadata.block.data` as an {@link AssetGenerateView}. Until P1 of the
 * 2026-04-26 multimodal audit landed, the LLM-history bridge dropped that
 * metadata on the floor: subsequent vision-capable runtimes therefore
 * never saw the image they themselves had generated.
 *
 * `messageContentFromHistoryRecord` rebuilds a structured
 * `readonly ContentPart[]` for those messages while preserving the
 * legacy plain-string path for ordinary text history. Adapters in
 * `@covel/ai-provider` that target text-only models collapse the array
 * back to its leading text summary, so the upgraded shape is safe to
 * emit even when the downstream model cannot ingest images.
 */

import {
  type AssetGenerateView,
  type ContentPart,
  assetGenerateViewToLLM,
  isAssetGenerateView,
} from '@covel/shared';
import type { MessageHistoryRecord } from './types.js';

/**
 * Resolve the `LLMMessage.content` value for a single history record.
 *
 * Returns the original `record.content` string by default. When the
 * record carries `metadata.block` for an `asset.generate` block with a
 * valid {@link AssetGenerateView} payload, returns a multimodal
 * `readonly ContentPart[]` built via {@link assetGenerateViewToLLM}.
 *
 * Defensive narrowing means malformed / partial metadata silently falls
 * back to the plain-string path — callers that do not understand block
 * metadata stay byte-identical to the pre-bridge behaviour.
 */
export function messageContentFromHistoryRecord(
  record: Pick<MessageHistoryRecord, 'content' | 'metadata'>,
): string | readonly ContentPart[] {
  const view = extractAssetGenerateView(record.metadata);
  if (!view) return record.content;
  return assetGenerateViewToLLM(view);
}

function extractAssetGenerateView(metadata: unknown): AssetGenerateView | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const meta = metadata as { readonly block?: unknown };
  const block = meta.block;
  if (!block || typeof block !== 'object') return null;
  const candidate = (block as { readonly type?: unknown; readonly data?: unknown });
  if (candidate.type !== 'asset.generate') return null;
  if (!isAssetGenerateView(candidate.data)) return null;
  return candidate.data;
}
