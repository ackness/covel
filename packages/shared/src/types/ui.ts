/**
 * UI component types for LLM-driven rendering.
 */

export type UIComponentType =
  | "stat-bar"
  | "card"
  | "choice-list"
  | "image"
  | "table"
  | "notification"
  | "dialog"
  | "inventory"
  | "map-marker"
  | "progress";

export type UIPartStatus =
  "pending" | "streaming" | "success" | "error" | "paused";

export type UIRenderLayout = "stream" | "split" | "overlay";

export interface UIRenderPartRetry {
  readonly count: number;
  readonly lastError?: string;
}

export interface UIRenderPart {
  /** Stable identifier for fine-grained status updates across re-renders. */
  readonly id: string;
  readonly type: UIComponentType | string;
  readonly status: UIPartStatus;
  readonly content: unknown;
  readonly retry?: UIRenderPartRetry;
}

export interface UIRenderPartsInstruction {
  readonly parts: readonly UIRenderPart[];
  readonly layout?: UIRenderLayout;
  /** Aggregate status derived by producers or consumers from `parts`. */
  readonly status?: UIPartStatus;
}

export type UIRenderInstruction = UIRenderPartsInstruction;

export function isUIRenderPartsInstruction(
  value: unknown,
): value is UIRenderPartsInstruction {
  return (
    !!value &&
    typeof value === "object" &&
    Array.isArray((value as { parts?: unknown }).parts)
  );
}

function normalizePartStatus(value: unknown): UIPartStatus {
  return value === "pending" ||
    value === "streaming" ||
    value === "success" ||
    value === "error" ||
    value === "paused"
    ? value
    : "success";
}

function inferInstructionStatus(parts: readonly UIRenderPart[]): UIPartStatus {
  if (parts.some((part) => part.status === "error")) return "error";
  if (parts.some((part) => part.status === "paused")) return "paused";
  if (parts.some((part) => part.status === "streaming")) return "streaming";
  if (parts.some((part) => part.status === "pending")) return "pending";
  return "success";
}

export function normalizeUIRenderInstruction(
  instruction: UIRenderInstruction,
  fallbackId = "ui-1",
): UIRenderPartsInstruction {
  const parts = instruction.parts.map((rawPart, index) => {
    const part = rawPart as unknown as Record<string, unknown>;
    return {
      id:
        typeof part.id === "string" && part.id.length > 0
          ? part.id
          : `${fallbackId}-part-${index + 1}`,
      type:
        typeof part.type === "string" && part.type.length > 0
          ? part.type
          : "card",
      status: normalizePartStatus(part.status),
      content: "content" in part ? part.content : {},
      ...(part.retry && typeof part.retry === "object"
        ? { retry: part.retry as UIRenderPartRetry }
        : {}),
    };
  });
  return {
    parts,
    ...(instruction.layout ? { layout: instruction.layout } : {}),
    status: normalizePartStatus(
      instruction.status ?? inferInstructionStatus(parts),
    ),
  };
}

/**
 * JSON Schema-based block schema declaration for plugin UI rendering.
 */
