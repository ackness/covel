import type { RuntimeContextView } from "@covel/shared";
import type { TextMessage } from "@covel/ai-provider";

/** Default max characters for context sections to prevent overflow. */
const DEFAULT_MAX_CONTEXT_CHARS = 32_000;

export interface PromptBuilderOptions {
  /** System instructions (e.g. from PLUGIN.md). */
  instructions?: string;
  /** Locale directive injected into system message. */
  locale?: string;
  /** Max characters for context sections (prevent overflow). */
  maxContextChars?: number;
}

/**
 * Build a messages array from RuntimeContextView + instructions.
 *
 * Message structure:
 * 1. System message (instructions + locale + structured context)
 * 2. Chat history (if available)
 * 3. Current narrative (if available)
 */
export function buildPrompt(
  context: RuntimeContextView,
  options: PromptBuilderOptions = {}
): TextMessage[] {
  const messages: TextMessage[] = [];
  const maxCtx = options.maxContextChars ?? DEFAULT_MAX_CONTEXT_CHARS;

  // ── System message ─────────────────────────────────────────────
  const systemParts: string[] = [];

  if (options.instructions) {
    systemParts.push(options.instructions);
  }

  const locale = options.locale ?? context.locale;
  if (locale) {
    systemParts.push(`[Locale: ${locale}]`);
  }

  // Inject structured context sections
  const contextSections = buildContextSections(context, maxCtx);
  if (contextSections) {
    systemParts.push(contextSections);
  }

  if (systemParts.length > 0) {
    messages.push({ role: "system", content: systemParts.join("\n\n") });
  }

  // ── Chat history ───────────────────────────────────────────────
  if (context.chat && Array.isArray(context.chat)) {
    for (const msg of context.chat as Array<{ role: string; content: string }>) {
      messages.push({ role: msg.role, content: msg.content });
    }
  }

  // ── Current narrative as last context ──────────────────────────
  if (context.narrative?.content) {
    messages.push({
      role: "assistant",
      content: context.narrative.content,
    });
  }

  return messages;
}

function buildContextSections(
  context: RuntimeContextView,
  maxChars: number
): string | null {
  const sections: string[] = [];
  let totalChars = 0;

  function addSection(label: string, data: unknown) {
    if (data === undefined || data === null) return;
    const text =
      typeof data === "string" ? data : JSON.stringify(data, null, 2);
    if (totalChars + text.length > maxChars) return;
    sections.push(`<${label}>\n${text}\n</${label}>`);
    totalChars += text.length;
  }

  // World context
  addSection("world", context.world);

  // Characters
  if (context.characters && context.characters.length > 0) {
    addSection("characters", context.characters);
  }

  // Game state
  addSection("state", context.state);

  // Records/lore
  if (context.record && context.record.length > 0) {
    addSection("records", context.record);
  }

  // Archive summary
  if (context.archive?.summary) {
    addSection("archive", context.archive.summary);
  }

  // Runtime settings
  if (context.runtimeSettings?.flat) {
    addSection("settings", context.runtimeSettings.flat);
  }

  return sections.length > 0 ? sections.join("\n\n") : null;
}
