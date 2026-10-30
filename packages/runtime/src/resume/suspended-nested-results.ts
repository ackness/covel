/**
 * `ctx.recursiveCall` results of a suspended function runtime.
 *
 * Nested results normally ride on their parent under a symbol and commit with
 * the parent's own success. A parent that suspends has not succeeded yet, so
 * its nested results are saved with the suspension instead and attached again
 * when the resumed handler succeeds. The symbols do not survive JSON, so the
 * saved form spells out what they carried: the result with its buffered
 * proposals, the conversation rows it adds and its trigger-ledger entry.
 */

import type { RuntimeResult } from "@covel/shared";
import type { SuspendedNestedResult, SuspensionRecord } from "@covel/store";
import {
  attachExecutionJournal,
  attachRuntimeTrigger,
  journalOf,
  runtimeTriggerOf,
} from "../execution-journal.js";
import { inCommitOrder } from "../turn-executor/nested-results.js";

/**
 * The saved form of `nested`, flattened in commit order. A nested run that
 * itself suspended is left out: its continuation was never saved, so
 * nothing could resume it. Those are returned as `dropped`.
 */
export function suspendNestedResults(nested: readonly RuntimeResult[]): {
  readonly saved: SuspendedNestedResult[];
  readonly dropped: RuntimeResult[];
} {
  const saved: SuspendedNestedResult[] = [];
  const dropped: RuntimeResult[] = [];
  for (const result of inCommitOrder(nested)) {
    if (result.status === "suspended") {
      dropped.push(result);
      continue;
    }
    const journal = journalOf(result);
    const trigger = runtimeTriggerOf(result);
    saved.push({
      result: structuredClone(result),
      ...(journal.length > 0 ? { journal: structuredClone(journal) } : {}),
      ...(trigger !== undefined ? { trigger } : {}),
    });
  }
  return { saved, dropped };
}

/** Owned results with their journal rows and trigger entries attached again. */
export function restoreNestedResults(
  saved: readonly SuspendedNestedResult[],
): RuntimeResult[] {
  return saved.map((entry) => {
    const result = structuredClone(entry.result) as RuntimeResult;
    if (entry.trigger !== undefined)
      attachRuntimeTrigger(result, entry.trigger);
    if (entry.journal?.length)
      attachExecutionJournal(
        result,
        structuredClone(entry.journal) as Parameters<
          typeof attachExecutionJournal
        >[1],
      );
    return result;
  });
}

/**
 * The runtimes whose results a suspension holds, read from the saved form
 * without trusting it: an entry without string ids is ignored. Their
 * `ctx.progress` tasks follow the suspended runtime.
 */
export function nestedRuntimesOf(
  suspension: Pick<SuspensionRecord, "pendingContinuation">,
): { readonly pluginId: string; readonly runtimeId: string }[] {
  const seen = new Set<string>();
  const runtimes: { pluginId: string; runtimeId: string }[] = [];
  for (const entry of suspension.pendingContinuation.nestedResults ?? []) {
    const { pluginId, runtimeId } = (entry?.result ?? {}) as {
      pluginId?: unknown;
      runtimeId?: unknown;
    };
    if (typeof pluginId !== "string" || typeof runtimeId !== "string") continue;
    const key = `${pluginId}\u0000${runtimeId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    runtimes.push({ pluginId, runtimeId });
  }
  return runtimes;
}
