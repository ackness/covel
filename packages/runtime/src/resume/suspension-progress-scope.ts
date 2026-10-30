/**
 * The `ctx.progress` scope a suspension's runtime reported under. Usually its
 * own execution; a `ctx.recursiveCall` child reports under the root
 * execution's scope, which its saved suspension carries. Resume, a further
 * suspension and an abandon all settle the runtime's tasks there. The
 * execution identity (`executionContext.executionId`) stays separate: it keys
 * setup attempts and the resume's own context.
 */

import type { SuspensionRecord } from "@covel/store";

export function suspensionProgressScopeId(
  continuation: Pick<
    SuspensionRecord["pendingContinuation"],
    "progressScopeId" | "executionContext"
  >,
): string {
  return (
    continuation.progressScopeId ?? continuation.executionContext.executionId
  );
}
