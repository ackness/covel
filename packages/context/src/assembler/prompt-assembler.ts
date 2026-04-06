import type { RuntimeContextView } from "@covel/shared";
import type { TextMessage } from "@covel/ai-provider";
import type { TurnContextStore } from "../store/turn-context-store.js";
import type {
  PromptResult,
  SectionMeta,
  ContextFragment,
} from "../types.js";
import { formatSection, formatPreviousOutputs } from "../sections/index.js";
import { normalizeMessages, type NormalizeProvider } from "../normalizer/message-normalizer.js";

/** Runtime info needed for prompt assembly */
export interface RuntimeInfo {
  runtimeId: string;
  pluginId: string;
  kind: string;
  priority: number;
  allowedTools: string[];
  providerTag?: string;
  budget?: { maxSteps?: number; timeoutMs?: number; maxTokens?: number };
  isolation?: { readScopes?: string[]; writeScopes?: string[] };
}

export interface PromptAssemblerOptions {
  /** Max characters for context sections */
  maxContextChars?: number;
  /** Target LLM provider for message normalization */
  provider?: NormalizeProvider;
  /** Enable prompt cache hints (splits system message into stable prefix + volatile tail) */
  enableCaching?: boolean;
}

export interface AssembleInput {
  store: TurnContextStore;
  runtime: RuntimeInfo;
  /** Instructions loaded from PLUGIN.md */
  instructions?: string;
  /** Context fragments from context providers */
  contextFragments?: ContextFragment[];
  options?: PromptAssemblerOptions;
}

/**
 * Assemble a complete prompt for a specific runtime.
 *
 * Prompt structure (when enableCaching = true, splits into 2 system messages):
 *
 * System message 1 (stable prefix — cacheable):
 *   - Context provider fragments (sorted by priority desc)
 *   - Runtime instructions (PLUGIN.md)
 *   - [Locale: xx-XX]
 *   - <world> (rarely changes)
 *
 * System message 2 (volatile tail — changes per turn):
 *   - <characters>, <state>, <archive>, <settings>
 *   - Previous runtime outputs
 *
 * When enableCaching = false (default), all parts go into a single system message.
 *
 * Then:
 * - Chat history
 * - Current narrative (as last assistant message)
 */
export function assemblePrompt(input: AssembleInput): PromptResult {
  const { store, runtime, instructions, contextFragments } = input;
  const maxCtx = input.options?.maxContextChars ?? 32_000;
  const enableCaching = input.options?.enableCaching ?? false;
  const messages: TextMessage[] = [];
  const sections: SectionMeta[] = [];
  let totalChars = 0;

  // ── Build stable prefix parts ─────────────────────────────────
  const stableParts: string[] = [];

  // 1. Context provider fragments (sorted by priority descending)
  if (contextFragments && contextFragments.length > 0) {
    const sorted = [...contextFragments].sort(
      (a, b) => b.priority - a.priority
    );
    const fragmentText = sorted.map((f) => f.content).join("\n\n");
    stableParts.push(fragmentText);
    sections.push({
      name: "contextFragments",
      charCount: fragmentText.length,
      included: true,
    });
    totalChars += fragmentText.length;
  }

  // 2. Runtime instructions
  if (instructions) {
    stableParts.push(instructions);
    sections.push({
      name: "instructions",
      charCount: instructions.length,
      included: true,
    });
    totalChars += instructions.length;
  }

  // 3. Locale directive
  const locale = store.getLocale();
  if (locale) {
    stableParts.push(`[Locale: ${locale}]`);
  }

  // 4a. World context (stable — rarely changes between turns)
  const addSectionTo = (
    target: string[],
    name: string,
    data: unknown
  ): void => {
    if (data === undefined || data === null) return;
    const text =
      typeof data === "string" ? data : JSON.stringify(data, null, 2);
    if (totalChars + text.length > maxCtx) {
      sections.push({ name, charCount: text.length, included: false });
      return;
    }
    target.push(formatSection(name, text));
    sections.push({ name, charCount: text.length, included: true });
    totalChars += text.length;
  };

  addSectionTo(stableParts, "world", store.getWorld());

  // ── Build volatile tail parts ─────────────────────────────────
  const volatileParts: string[] = [];

  const characters = store.getCharacters();
  if (characters.length > 0) {
    addSectionTo(volatileParts, "characters", characters);
  }

  addSectionTo(volatileParts, "state", store.getState());

  const archive = store.getArchive();
  if (archive?.summary) {
    addSectionTo(volatileParts, "archive", archive.summary);
  }

  const settings = store.getRuntimeSettings();
  if (settings?.flat && Object.keys(settings.flat).length > 0) {
    addSectionTo(volatileParts, "settings", settings.flat);
  }

  // 5. Previous runtime outputs (narrative + proposals from higher-priority runtimes)
  const completedIds = store.getCompletedRuntimeIds();
  if (completedIds.length > 0) {
    const narrative = store.getNarrative();
    const proposals = store.getProposals();
    const prevOutput = formatPreviousOutputs(narrative, proposals);
    if (prevOutput && totalChars + prevOutput.length <= maxCtx) {
      volatileParts.push(prevOutput);
      sections.push({
        name: "previous_outputs",
        charCount: prevOutput.length,
        included: true,
      });
      totalChars += prevOutput.length;
    }
  }

  // ── Assemble system messages ──────────────────────────────────
  if (enableCaching) {
    // Split into stable (cacheable) + volatile (per-turn)
    if (stableParts.length > 0) {
      messages.push({
        role: "system",
        content: stableParts.join("\n\n"),
        cacheControl: { type: "ephemeral" },
      });
    }
    if (volatileParts.length > 0) {
      messages.push({
        role: "system",
        content: volatileParts.join("\n\n"),
      });
    }
  } else {
    // Single system message (backward compatible)
    const allParts = [...stableParts, ...volatileParts];
    if (allParts.length > 0) {
      messages.push({ role: "system", content: allParts.join("\n\n") });
    }
  }

  // ── Chat history ───────────────────────────────────────────────
  const chat = store.getChat();
  if (chat && Array.isArray(chat)) {
    for (const msg of chat as Array<{ role: string; content: string }>) {
      messages.push({ role: msg.role, content: msg.content });
    }
  }

  // ── Current narrative as last context ──────────────────────────
  const narrative = store.getNarrative();
  if (narrative) {
    messages.push({ role: "assistant", content: narrative });
  }

  // ── Normalize wire messages ─────────────────────────────────────
  const { messages: normalized, repairs } = normalizeMessages(messages, {
    provider: input.options?.provider,
  });

  if (repairs.length > 0) {
    sections.push({
      name: "normalization",
      charCount: 0,
      included: true,
    });
  }

  // Estimate tokens (~4 chars per token)
  const tokenEstimate = Math.ceil(totalChars / 4);

  return { messages: normalized, tokenEstimate, sections };
}

/**
 * Build a RuntimeContextView from the store (for backward compatibility).
 * Used by runtimes that still expect the old context format (e.g., custom handlers).
 */
export function buildContextView(
  store: TurnContextStore,
  runtime: RuntimeInfo
): RuntimeContextView {
  return {
    run: {
      runId: store.getRunId(),
      branchId: store.getBranchId(),
      turnId: store.getTurnId(),
    },
    locale: store.getLocale(),
    world: store.getWorld(),
    chat: store.getChat(),
    characters: store.getCharacters(),
    state: store.getState(),
    record: [],
    events: [],
    runtimeSettings: store.getRuntimeSettings(),
    narrative: store.getNarrative()
      ? { content: store.getNarrative() }
      : undefined,
    archive: store.getArchive(),
    runtime: {
      runtimeId: runtime.runtimeId,
      pluginId: runtime.pluginId,
      kind: runtime.kind,
      // Map numeric priority to phase field for backward compatibility
      priority: runtime.priority,
      allowedTools: runtime.allowedTools,
      providerTag: runtime.providerTag,
      budget: runtime.budget,
      isolation: runtime.isolation,
    } as RuntimeContextView["runtime"],
  };
}
