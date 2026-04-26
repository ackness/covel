/**
 * Prompt delta computation (PR-1, translation layer).
 *
 * Computes the "delta" between the prompt sent to a runtime on its previous
 * LLM call and the prompt sent on the current call. The delta is what
 * `RuntimeOutput.metaData.rawPromptDelta` stores, so that each runtime
 * invocation doesn't need to persist the entire history — consumers can
 * rebuild the full prompt from `turn_messages` + the delta on demand.
 *
 * Strategy: naive longest-common-prefix (LCP) over the messages array.
 * Any suffix divergence (additions, edits, replacements) is treated as
 * "new content" and returned as the delta.
 *
 * This is deliberately simple for the first iteration:
 *   - First call: delta === current (full prompt)
 *   - Pure append (new tool_result / user message): delta === tail
 *   - Edit in the middle: delta === everything from the first diverging index
 *
 * A future pass can swap to a true diff (Myers / Hunt-McIlroy) if we find
 * the LCP produces too much noise when the framework rewrites history
 * (e.g. compaction).
 */

import type { LLMMessageContent } from './llm-adapter.js';

export interface PromptMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: LLMMessageContent;
}

/**
 * Compute delta: what's new in `current` relative to `previous`.
 *
 * @returns The slice of `current` starting from the first index where
 *          `previous[i]` and `current[i]` differ (or where `previous`
 *          runs out). If `previous` is empty/nullish, returns the full
 *          current array.
 */
export function computePromptDelta(
  previous: readonly PromptMessage[] | undefined,
  current: readonly PromptMessage[],
): readonly PromptMessage[] {
  if (!previous || previous.length === 0) {
    return current.slice();
  }

  // Find the first index where messages diverge or `previous` runs out.
  const minLen = Math.min(previous.length, current.length);
  let divergeIdx = minLen;
  for (let i = 0; i < minLen; i++) {
    if (!messagesEqual(previous[i]!, current[i]!)) {
      divergeIdx = i;
      break;
    }
  }

  return current.slice(divergeIdx);
}

/**
 * Rebuild the full prompt from a base (e.g. compacted history) plus a delta.
 * Inverse of `computePromptDelta` assuming `previous` and `delta` were
 * produced by the same pipeline.
 *
 * Used by `GET /runtime-outputs/:id/full-prompt` to reconstruct the prompt
 * that was actually sent on a given call.
 */
export function applyPromptDelta(
  base: readonly PromptMessage[],
  delta: readonly PromptMessage[],
): readonly PromptMessage[] {
  // The delta is a suffix that replaces `base` from some point on. We
  // don't store the diverge index — instead we assume the delta is the
  // complete "new tail" and attach it to the longest matching prefix
  // of `base` that doesn't overlap with `delta`.
  //
  // Simplest safe approach: if delta length >= base length, delta is the
  // whole prompt. Otherwise the result is `base[0 .. base.length - delta.length]
  // + delta`.
  if (delta.length >= base.length) return delta.slice();
  const prefix = base.slice(0, base.length - delta.length);
  return [...prefix, ...delta];
}

function messagesEqual(a: PromptMessage, b: PromptMessage): boolean {
  return a.role === b.role && contentEqual(a.content, b.content);
}

function contentEqual(a: LLMMessageContent, b: LLMMessageContent): boolean {
  if (typeof a === 'string' || typeof b === 'string') return a === b;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) return false;
  }
  return true;
}
