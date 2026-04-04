/**
 * Pure business logic for the core-memory plugin.
 */

// ── Types ───────────────────────────────────────────────────────

export interface MemoryArchive {
  readonly summary: string;
  readonly version: number;
  readonly lastTurnId?: string;
}

// ── Context Formatting ──────────────────────────────────────────

/**
 * Format a memory archive for injection into runtime context.
 * Returns a human-readable summary string suitable for LLM consumption.
 */
export function formatMemoryContext(archive: unknown): string {
  if (
    typeof archive !== "object" ||
    archive === null ||
    !("summary" in archive)
  ) {
    return "";
  }

  const obj = archive as Record<string, unknown>;
  const summary =
    typeof obj.summary === "string" ? obj.summary.trim() : "";
  const version =
    typeof obj.version === "number" ? obj.version : 0;

  if (!summary) {
    return "";
  }

  return `[Memory Archive v${version}]\n${summary}`;
}
