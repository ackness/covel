/**
 * Output presentation and tool failure helpers for turn execution.
 *
 * These functions are deliberately pure so the main turn executor can focus on
 * orchestration, hooks, scheduling, and persistence.
 */

import type { RuntimeResult } from "@covel/shared";

export interface ExecutedToolCallState {
  readonly name: string;
  readonly arguments: string;
  readonly result: unknown;
  readonly success: boolean;
  /** A failed call the tool refused; see `ToolCallResult.refused`. */
  readonly refused?: true;
}

export interface FailedToolCallState {
  readonly toolName: string;
  readonly message?: string;
}

/**
 * Heuristic: does `content` look like structured (non-narrative) runtime
 * output that the narrator should NOT ingest as prior prose? Covers:
 *
 *  - Raw JSON (starts with `{` or `[`)
 *  - Markdown-fenced JSON: ```` ```json ```` / ```` ```ts ```` / ```` ``` ````
 *    wrapping an object/array body
 *  - Bare backtick-wrapped bodies (codex EntryCard text dumps)
 *  - `<tool>`-prefixed transcripts that tool-using plugins occasionally log
 *
 * Any false positive here just reduces context the narrator sees, which is
 * safer than leaking structured JSON into the prose stream and nudging the
 * narrator to mimic a schema.
 *
 * Exported for unit testing (see turn-executor-story-filter.test.ts).
 */
export function looksLikeStructuredRuntimeOutput(
  raw: string | undefined | null,
): boolean {
  if (!raw) return false;
  let s = raw.trim();
  if (s.length === 0) return false;

  const fence = s.match(/^```[\w-]*\s*([\s\S]*?)\s*```$/);
  if (fence && fence[1]) {
    s = fence[1].trim();
  }

  if (s.startsWith("{") || s.startsWith("[")) return true;

  if (s.startsWith("`") && s.endsWith("`")) {
    const inner = s.slice(1, -1).trim();
    if (inner.startsWith("{") || inner.startsWith("[")) return true;
  }

  if (/^<tool[- >]/i.test(s)) return true;

  return false;
}

export function extractToolFailureMessage(result: string): string | undefined {
  try {
    const parsed = JSON.parse(result) as { error?: { message?: unknown } };
    if (
      typeof parsed.error?.message === "string" &&
      parsed.error.message.length > 0
    ) {
      return parsed.error.message;
    }
  } catch {
    // Ignore parse failures and fall back to the raw text below.
  }
  return result.length > 0 ? result : undefined;
}

export function formatToolLoopFailure(args: {
  runtimeId: string;
  reason:
    | "max_steps"
    | "timeout"
    | "tool_failed_without_output"
    | "stopped_by_hook"
    | "context_overflow";
  maxSteps?: number;
  /** Hook cancellation or the original context overflow message. */
  message?: string;
  failedToolCalls: readonly FailedToolCallState[];
}): string {
  if (args.reason === "context_overflow")
    return (
      args.message ??
      `Runtime "${args.runtimeId}" stopped because the request no longer fits the model's context window.`
    );
  if (args.reason === "stopped_by_hook")
    return `Runtime "${args.runtimeId}" was stopped by a PreStep hook${
      args.message ? `: ${args.message}` : "."
    }`;
  const reasonText =
    args.reason === "max_steps"
      ? `exhausted the tool loop after ${args.maxSteps ?? 0} steps without producing final output`
      : args.reason === "timeout"
        ? "timed out while waiting for final output after tool execution"
        : "stopped without final output after a tool failure";
  const lastFailure = args.failedToolCalls.at(-1);
  if (!lastFailure) {
    return `Runtime "${args.runtimeId}" ${reasonText}.`;
  }
  return `Runtime "${args.runtimeId}" ${reasonText}. Last tool failure: ${lastFailure.toolName}${lastFailure.message ? ` - ${lastFailure.message}` : ""}`;
}

export function isRequiredUpstreamSatisfied(
  upstream: RuntimeResult | undefined,
): boolean {
  if (!upstream) return false;
  if (upstream.status === "success") return true;
  if (upstream.status !== "skipped") return false;
  const output = upstream.output ?? {};
  return output.preGameDone === true || output.initialized === true;
}
