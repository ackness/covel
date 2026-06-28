/**
 * Output parsing and presentation helpers for turn execution.
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

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Test-only export. Used by `tests/parse-final-output-envelope.test.ts` to
 * exercise the lenient-fallback contract documented in the body. Production
 * callers stay inside the runtime executor.
 */
export function __testOnly_parseFinalOutputEnvelope(
  finalContent: string,
): ReturnType<typeof parseFinalOutputEnvelope> {
  return parseFinalOutputEnvelope(finalContent);
}

export function parseFinalOutputEnvelope(finalContent: string): {
  readonly output: Record<string, unknown>;
  readonly parsedAsJson: boolean;
} {
  const stripped = finalContent
    .replace(/^```(?:json)?\s*\n?/i, "")
    .replace(/\n?```\s*$/i, "")
    .trim();

  try {
    const direct = JSON.parse(stripped);
    if (direct && typeof direct === "object" && !Array.isArray(direct)) {
      return { output: direct as Record<string, unknown>, parsedAsJson: true };
    }
  } catch {
    // fall through to lenient extraction below
  }

  // Lenient path: salvage a trailing JSON envelope from prose. This keeps
  // schema/event-chain plugins useful when a model emits a short preamble
  // before the object it was asked to return.
  const salvaged = extractLastBalancedJsonObject(stripped);
  if (salvaged) {
    return { output: salvaged, parsedAsJson: true };
  }

  return { output: { narrativeOutput: finalContent }, parsedAsJson: false };
}

/**
 * Find the last balanced JSON object embedded in `text` and parse it.
 *
 * Scans forward tracking brace depth and string state so braces inside JSON
 * string literals do not unbalance the count. Whenever depth returns to zero
 * the spanning slice is parsed; the latest successful parse wins.
 */
function extractLastBalancedJsonObject(
  text: string,
): Record<string, unknown> | null {
  let lastValid: Record<string, unknown> | null = null;
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      if (depth === 0) continue;
      depth--;
      if (depth === 0 && start >= 0) {
        const candidate = text.slice(start, i + 1);
        try {
          const parsed = JSON.parse(candidate);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            lastValid = parsed as Record<string, unknown>;
          }
        } catch {
          // not a complete JSON object yet; keep scanning
        }
        start = -1;
      }
    }
  }
  return lastValid;
}

/**
 * Pull the top-level `required: [...]` field names out of a JSON Schema so
 * schema-validation failures can surface them as a useful hint.
 */
export function extractRequiredFields(
  schema: Readonly<Record<string, unknown>>,
): readonly string[] {
  const required = schema.required;
  if (!Array.isArray(required)) return [];
  return required.filter(
    (field): field is string => typeof field === "string" && field.length > 0,
  );
}

export function shouldSuppressToolLoopNarrative(args: {
  outputKind?: string;
  executedToolCalls: readonly ExecutedToolCallState[];
  parsedAsJson: boolean;
}): boolean {
  return (
    args.outputKind === "system" &&
    args.executedToolCalls.length > 0 &&
    !args.parsedAsJson
  );
}

export function findPresentableToolOutput(
  executedToolCalls: readonly ExecutedToolCallState[],
): Record<string, unknown> | null {
  for (let i = executedToolCalls.length - 1; i >= 0; i--) {
    const result = executedToolCalls[i]?.result;
    if (!isRecord(result)) continue;
    if (Array.isArray(result.ui) || isRecord(result.interaction)) {
      return { ...result };
    }
  }
  return null;
}

export function findLastStructuredToolOutput(
  executedToolCalls: readonly ExecutedToolCallState[],
): Record<string, unknown> | null {
  for (let i = executedToolCalls.length - 1; i >= 0; i--) {
    const result = executedToolCalls[i]?.result;
    if (isRecord(result)) return { ...result };
  }
  return null;
}

export function extractToolFailureMessage(result: string): string | undefined {
  try {
    const parsed = JSON.parse(result) as { error?: unknown };
    if (typeof parsed.error === "string" && parsed.error.length > 0) {
      return parsed.error;
    }
  } catch {
    // Ignore parse failures and fall back to the raw text below.
  }
  return result.length > 0 ? result : undefined;
}

export function formatToolLoopFailure(args: {
  runtimeId: string;
  reason: "max_steps" | "timeout" | "tool_failed_without_output";
  maxSteps?: number;
  failedToolCalls: readonly FailedToolCallState[];
}): string {
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

export function shouldRetryMalformedToolArguments(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("function.arguments") && message.includes("JSON format")
  );
}

function isMetaChoiceParagraph(paragraph: string): boolean {
  const plain = paragraph.replace(/\*\*/g, "").trim();
  return /^(?:现在，你需要(?:做出选择|做出决定)|你的选择是|你需要决定|你要如何选择|你会怎么做|请选择)/u.test(
    plain,
  );
}

export function sanitizeStoryNarrativeText(content: string): string {
  const paragraphs = content
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

  while (
    paragraphs.length > 0 &&
    isMetaChoiceParagraph(paragraphs[paragraphs.length - 1]!)
  ) {
    paragraphs.pop();
  }

  return paragraphs.join("\n\n").trim();
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
