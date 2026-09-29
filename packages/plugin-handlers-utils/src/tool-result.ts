import type { PluginProposal } from "./plugin-api.js";

/** An event produced by a tool and dispatched by the host after validation. */
export interface EmittedEvent {
  readonly topic: string;
  readonly data: Record<string, unknown>;
}

/**
 * Explicit tool output and effects. All fields are enumerable, so object
 * spread, structuredClone and JSON transport preserve the complete result.
 * The host validates effects before committing them; this is not authority.
 */
export interface PluginToolResult<T = unknown> {
  readonly kind: "covel.tool-result";
  readonly content: T;
  readonly pendingProposals: readonly PluginProposal[];
  readonly emittedEvents?: readonly EmittedEvent[];
}

function isToolResult<T>(value: unknown): value is PluginToolResult<T> {
  return (
    value !== null &&
    typeof value === "object" &&
    "kind" in value &&
    value.kind === "covel.tool-result"
  );
}

/** Return an explicit result without mutating the content or an earlier result. */
export function withPendingProposals<T>(
  content: T | PluginToolResult<T>,
  pendingProposals: readonly PluginProposal[],
): PluginToolResult<T> {
  const emittedEvents = getEmittedEvents(content);
  return {
    kind: "covel.tool-result",
    content: getToolContent(content),
    pendingProposals: [...pendingProposals],
    ...(emittedEvents ? { emittedEvents: [...emittedEvents] } : {}),
  };
}

/** Compose events with an existing result, retaining its proposal channel. */
export function withEmittedEvents<T>(
  content: T | PluginToolResult<T>,
  emittedEvents: readonly EmittedEvent[],
): PluginToolResult<T> {
  return {
    kind: "covel.tool-result",
    content: getToolContent(content),
    pendingProposals: [...getPendingProposals(content)],
    emittedEvents: [...emittedEvents],
  };
}

export function getToolContent<T>(value: T | PluginToolResult<T>): T {
  return isToolResult<T>(value) ? value.content : value;
}

export function getPendingProposals(value: unknown): readonly PluginProposal[] {
  return isToolResult(value) ? value.pendingProposals : [];
}

export function getEmittedEvents(
  value: unknown,
): readonly EmittedEvent[] | undefined {
  return isToolResult(value) ? value.emittedEvents : undefined;
}
