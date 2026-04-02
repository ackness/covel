import type { PluginRegistrar } from "@covel/plugin-runtime";
import type {
  RuntimeHandlerContext,
  RuntimeHandlerResult,
  ContextProvider,
  ContextProviderInput,
} from "@covel/plugin-runtime";
import {
  buildSummaryPrompt,
  parseSummaryResponse,
  buildMemoryProposals,
  formatMemoryContext,
} from "./logic.js";
import type { MemoryArchive } from "./logic.js";

export default function register(registrar: PluginRegistrar): void {
  registrar.addRuntimeHandler("memory-summarizer", memorySummarizerHandler);
  registrar.addContextProvider("memory-archive", memoryContextProvider);
}

// ── Runtime Handler ─────────────────────────────────────────────

/**
 * Background runtime that summarizes recent narrative into a rolling memory.
 * Fires every N turns (configured via trigger.intervalTurns in plugin.json).
 *
 * Reads:
 *   - context.narrative.content (recent narrative text)
 *   - state.memoryArchive (existing rolling summary)
 *   - context.events (recent game events)
 *
 * Emits:
 *   - state.patch: updated memoryArchive { summary, version, lastTurnId }
 *   - record.upsert: individual key events for long-term storage
 */
async function memorySummarizerHandler(
  ctx: RuntimeHandlerContext
): Promise<RuntimeHandlerResult> {
  const view = ctx.context as Record<string, unknown>;

  // Extract narrative content
  const narrativeObj = view.narrative as
    | { content?: string }
    | undefined;
  const narrative = narrativeObj?.content ?? "";

  // Extract existing memory archive from state
  const stateObj = view.state as Record<string, unknown> | undefined;
  const existingArchive = stateObj?.memoryArchive as
    | MemoryArchive
    | undefined;
  const existingSummary = existingArchive?.summary;
  const currentVersion = existingArchive?.version ?? 0;

  // Extract recent events
  const events = (view.events ?? []) as ReadonlyArray<{
    type?: string;
    payload?: unknown;
  }>;

  // Extract turn ID
  const runObj = view.run as { turnId?: string } | undefined;
  const turnId = runObj?.turnId ?? "unknown";

  // Skip if there is no new narrative to summarize
  if (!narrative && events.length === 0) {
    return { proposals: [] };
  }

  // Build prompt and generate summary via LLM
  const prompt = buildSummaryPrompt(
    narrative,
    existingSummary,
    events,
    ctx.locale
  );

  let response: string;
  if (ctx.generateText) {
    try {
      response = await ctx.generateText(prompt);
    } catch (err: unknown) {
      console.warn('[core-memory] Memory summarization failed:', err instanceof Error ? err.message : err);
      return { proposals: [] };
    }
  } else {
    // No LLM available — cannot summarize
    return { proposals: [] };
  }

  // Parse LLM response and build proposals
  const parsed = parseSummaryResponse(response);
  const proposals = buildMemoryProposals(parsed, turnId, currentVersion);

  return { proposals: [...proposals] };
}

// ── Context Provider ────────────────────────────────────────────

/**
 * Injects the current memory archive summary into all runtimes' context.
 * Other runtimes see this as a compressed history section in their prompt.
 */
const memoryContextProvider: ContextProvider = async (
  ctx: ContextProviderInput
): Promise<unknown> => {
  const stateObj = ctx.state as Record<string, unknown> | undefined;
  const archive = stateObj?.memoryArchive;

  const content = formatMemoryContext(archive);

  if (!content) {
    return null;
  }

  return {
    title: "Memory Archive",
    content,
    priority: 80,
  };
};
