/**
 * Pure business logic for the core-memory plugin.
 * All functions are side-effect-free and testable without LLM access.
 */

import { resolve } from "node:path";
import { loadPrompt, interpolate } from "@covel/context";

const PROMPTS_DIR = resolve(import.meta.dirname, "../prompts");

// ── Types ───────────────────────────────────────────────────────

export interface MemoryArchive {
  readonly summary: string;
  readonly version: number;
  readonly lastTurnId?: string;
}

export interface ParsedSummaryResponse {
  readonly summary: string;
  readonly keyEvents: readonly string[];
}

export interface MemoryProposal {
  readonly kind: string;
  readonly payload: unknown;
}

// ── Prompt Building ─────────────────────────────────────────────

/**
 * Build the LLM prompt for generating a rolling summary.
 * Combines existing summary, new narrative, and recent events into
 * a structured prompt that instructs the LLM to produce JSON output.
 */
export async function buildSummaryPrompt(
  narrative: string,
  existingSummary: string | undefined,
  events: ReadonlyArray<{ readonly type?: string; readonly payload?: unknown }>,
  locale: string
): Promise<string> {
  const isZh = locale.startsWith("zh");

  const eventLines = events
    .map((e) => {
      const type = e.type ?? "unknown";
      const detail =
        typeof e.payload === "string"
          ? e.payload
          : JSON.stringify(e.payload ?? {});
      return `- [${type}] ${detail}`;
    })
    .join("\n");

  const template = await loadPrompt(PROMPTS_DIR, "summary-prompt", locale);
  return interpolate(template, {
    existingSummary: existingSummary
      ? existingSummary
      : (isZh ? "（无，这是首次摘要）" : "(None — this is the first summary)"),
    narrative: narrative || (isZh ? "（无新叙事）" : "(No new narrative)"),
    eventLines: eventLines || (isZh ? "（无近期事件）" : "(No recent events)"),
  });
}

// ── Response Parsing ────────────────────────────────────────────

/**
 * Parse the LLM response into a structured summary result.
 * Tolerates markdown code fences, extra whitespace, and partial JSON.
 */
export function parseSummaryResponse(response: string): ParsedSummaryResponse {
  const trimmed = response.trim();

  // Strip markdown code fences if present
  const jsonStr = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();

  try {
    const parsed: unknown = JSON.parse(jsonStr);

    if (typeof parsed !== "object" || parsed === null) {
      return { summary: trimmed, keyEvents: [] };
    }

    const obj = parsed as Record<string, unknown>;
    const summary =
      typeof obj.summary === "string" ? obj.summary.trim() : trimmed;
    const keyEvents = Array.isArray(obj.keyEvents)
      ? obj.keyEvents.filter((e): e is string => typeof e === "string")
      : [];

    return { summary, keyEvents };
  } catch {
    // If JSON parsing fails, treat the entire response as the summary
    return { summary: trimmed, keyEvents: [] };
  }
}

// ── Proposal Building ───────────────────────────────────────────

/**
 * Build the kernel proposals from a parsed summary response.
 * Emits a state.patch for the rolling summary and record.upsert entries
 * for each key event.
 */
export function buildMemoryProposals(
  parsed: ParsedSummaryResponse,
  turnId: string,
  currentVersion: number
): readonly MemoryProposal[] {
  const nextVersion = currentVersion + 1;

  const proposals: MemoryProposal[] = [
    {
      kind: "state.patch",
      payload: {
        memoryArchive: {
          summary: parsed.summary,
          version: nextVersion,
          lastTurnId: turnId,
        } satisfies MemoryArchive,
      },
    },
  ];

  for (const event of parsed.keyEvents) {
    proposals.push({
      kind: "record.upsert",
      payload: {
        type: "memory.key_event",
        turnId,
        version: nextVersion,
        content: event,
      },
    });
  }

  return proposals;
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
