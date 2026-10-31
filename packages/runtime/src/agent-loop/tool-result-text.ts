import { instructionLocaleFor, modelFacingJson } from "@covel/shared";
import type { ToolErrorCode, ToolModelView } from "@covel/shared";

export interface ToolResultError {
  readonly code: ToolErrorCode;
  readonly message: string;
  readonly hint?: string;
}

interface ToolSuccessText {
  summary?: string;
  data?: unknown;
  staged?: { count: number; kinds: string[]; notice: string };
}

/** Player UI blocks are kept in content, outside the model's default data view. */
function withoutUiBlocks(content: unknown): unknown {
  if (!content || typeof content !== "object" || Array.isArray(content))
    return content;
  const { ui, ...rest } = content as Record<string, unknown>;
  return Array.isArray(ui) ? rest : content;
}

/** Render in a fixed key order so repeated tool results share prompt prefixes. */
export function renderToolSuccess(args: {
  content?: unknown;
  model?: ToolModelView;
  pendingProposals?: readonly { readonly type: string }[];
  emittedEvents?: readonly unknown[];
  /**
   * Write-service operations the call staged: one per successful write call,
   * with the proposal types of their writes.
   */
  stagedOperations?: {
    readonly count: number;
    readonly kinds: readonly string[];
  };
  locale?: string;
}): string {
  const result: ToolSuccessText = {};
  if (args.model?.summary !== undefined) result.summary = args.model.summary;
  const data = modelFacingJson(
    args.model ? args.model.data : withoutUiBlocks(args.content),
  );
  if (data !== undefined) result.data = data;
  const proposals = args.pendingProposals ?? [];
  const events = args.emittedEvents ?? [];
  const operations = args.stagedOperations?.count ?? 0;
  if (proposals.length + events.length + operations > 0) {
    result.staged = {
      count: proposals.length + events.length + operations,
      kinds: [
        ...new Set([
          ...proposals.map((p) => p.type),
          ...(operations > 0 ? (args.stagedOperations?.kinds ?? []) : []),
          ...(events.length ? ["event"] : []),
        ]),
      ],
      notice:
        instructionLocaleFor(args.locale) === "zh"
          ? "已暂存，回合结束时生效（可能被拒绝）。"
          : "Staged: it takes effect when the turn ends and may still be rejected.",
    };
  }
  if (Object.keys(result).length === 0)
    result.summary =
      instructionLocaleFor(args.locale) === "zh" ? "完成。" : "Done.";
  return JSON.stringify(result);
}

export function renderToolError(error: ToolResultError): string {
  return JSON.stringify({
    error: {
      code: error.code,
      message: error.message,
      ...(error.hint !== undefined ? { hint: error.hint } : {}),
    },
  });
}

/** Parse model-facing tool text without changing the code-facing result. */
export function parseToolResultText(
  text: string,
): ToolSuccessText | { error: ToolResultError } {
  return JSON.parse(text) as ToolSuccessText | { error: ToolResultError };
}
