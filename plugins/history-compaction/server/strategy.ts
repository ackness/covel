import {
  canonicalizeLocale,
  DEFAULT_LOCALE,
  localeRegistry,
  localeDisplayName,
  resolveI18nText,
  interpolate,
  estimateTokens,
  type I18nText,
  type SimpleCompletionAdapter,
  type TokenEstimator,
  type HistoryCompactInput as HistoryCompactionInput,
  type HistoryCompactOutput as HistoryCompactionOutput,
  type ExtensionHistoryMessage as TurnMessageRecord,
  type HistoryCompactSummary as SessionSummaryRecord,
} from "@covel/plugin-handlers-utils";
import {
  createPromptLoader,
  type PromptLoader,
} from "@covel/plugin-handlers-utils/prompts";
import { fileURLToPath } from "node:url";
const loadPrompt = createPromptLoader(
  fileURLToPath(new URL("../prompts", import.meta.url)),
);
function resolveLocaleLanguageName(locale: string): string {
  const canonical = canonicalizeLocale(locale);
  if (!canonical) return locale;
  const definition = localeRegistry.resolve(canonical);
  return definition
    ? (resolveI18nText(definition.label, canonical) ?? definition.code)
    : localeDisplayName(canonical);
}
export type CompactorLLMAdapter = SimpleCompletionAdapter<"user">;
export interface CompactionPolicyOptions {
  protectLastNUserTurns?: number;
  protectLastNMessages?: number;
  focusSections?: readonly string[];
}
const DEFAULT_PROTECT_LAST_USER_TURNS = 2;
const DEFAULT_PROTECT_LAST_N_MESSAGES = 5;

/**
 * Default focus sections used when the caller does not supply any. The actual
 * text is locale-aware so the summary LLM gets a sensible bullet list to expand
 * on.
 */
const DEFAULT_FOCUS_SECTIONS: readonly I18nText[] = [
  {
    "zh-CN": "关键事件",
    "en-US": "Key events",
    "ru-RU": "Ключевые события",
  },
  {
    "zh-CN": "人物关系",
    "en-US": "Character relationships",
    "ru-RU": "Отношения персонажей",
  },
  {
    "zh-CN": "环境状态",
    "en-US": "World state",
    "ru-RU": "Состояние мира",
  },
];

const COMPACTOR_TEXT = {
  mergeSummary: {
    "zh-CN":
      "请把所选连续摘要合并成一份摘要，不能遗漏仍有效的名称、约定、位置、关系、状态和因果。最终摘要不超过约 {{ maxSummaryTokens }} tokens。\n\n<所选历史摘要>\n{{ prior }}\n</所选历史摘要>",
    "en-US":
      "Merge only the selected consecutive historical summaries into one summary. Preserve all still-valid names, agreements, locations, relationships, states, and causal links. Keep the final summary under approximately {{ maxSummaryTokens }} tokens.\n\n<selected_history_summaries>\n{{ prior }}\n</selected_history_summaries>",
    "ru-RU":
      "Объедини выбранные последовательные исторические резюме в одно резюме. Сохрани все по-прежнему актуальные имена, договорённости, места, отношения, состояния и причинно-следственные связи. Итоговое резюме должно занимать не более примерно {{ maxSummaryTokens }} токенов.\n\n<selected_history_summaries>\n{{ prior }}\n</selected_history_summaries>",
  },
  summarize: {
    "zh-CN":
      "请将以下对话历史摘要化，最终摘要不超过约 {{ maxSummaryTokens }} tokens：\n\n{{ messages }}",
    "en-US":
      "Please summarize the following conversation history in approximately {{ maxSummaryTokens }} tokens or fewer:\n\n{{ messages }}",
    "ru-RU":
      "Кратко изложи следующую историю диалога, уложившись примерно в {{ maxSummaryTokens }} токенов:\n\n{{ messages }}",
  },
  language: {
    "zh-CN":
      "[LANGUAGE] 所有自然语言的摘要内容必须用{{ languageName }}（{{ locale }}）书写。",
    "en-US":
      "[LANGUAGE] Write all natural-language summary content in {{ languageName }} ({{ locale }}).",
    "ru-RU":
      "[LANGUAGE] Всё содержание резюме на естественном языке пиши на этом языке: {{ languageName }} ({{ locale }}).",
  },
  truncated: {
    "zh-CN": "\n[摘要已按上下文预算截断]",
    "en-US": "\n[Summary truncated to context budget]",
    "ru-RU": "\n[Резюме обрезано по бюджету контекста]",
  },
} as const satisfies Record<string, I18nText>;

function compactorText(
  key: keyof typeof COMPACTOR_TEXT,
  locale: string,
): string {
  return (
    resolveI18nText(COMPACTOR_TEXT[key], locale) ??
    resolveI18nText(COMPACTOR_TEXT[key], "en-US") ??
    ""
  );
}

/**
 * Build the framework system prompt for the summary LLM call.
 *
 * The template lives at `prompts/server/compactor.<locale>.md`, with an English
 * canonical fallback, and is loaded via `loadPrompt()` so prompt edits do not
 * require a rebuild.
 *
 * The single template variable is `{{ sections }}`. To preserve the
 * pre-externalization rendering (one section per bullet line), we join the
 * `focusSections` array with `\n- ` so the leading `- ` from the markdown
 * template lines up with the first item.
 */
async function buildCompactorSystemPrompt(
  locale: string,
  focusSections: readonly string[],
  loader: PromptLoader,
): Promise<string> {
  const effective =
    focusSections.length > 0
      ? focusSections
      : DEFAULT_FOCUS_SECTIONS.map(
          (section) => resolveI18nText(section, locale) ?? "",
        );
  const template = await loader("server", "compactor", locale);
  const canonicalLocale = canonicalizeLocale(locale) ?? DEFAULT_LOCALE;
  const languageName = resolveLocaleLanguageName(canonicalLocale);
  // The language rule is in the language of the template it follows.
  const languageRule = interpolate(compactorText("language", locale), {
    languageName,
    locale: canonicalLocale,
  });
  return `${interpolate(template, {
    sections: effective.join("\n- "),
  }).trimEnd()}\n\n${languageRule}`;
}

/**
 * Build the user prompt: list of sections + the messages to compact.
 */
function buildCompactorUserPrompt(
  messages: readonly TurnMessageRecord[],
  locale: string,
  priorSummaries: readonly SessionSummaryRecord[],
  maxSummaryTokens: number,
): string {
  // Empty rows only carry trigger accounting or UI attachments; they are still
  // compacted (the prefix must stay contiguous) but add nothing to summarize.
  const formatted = messages
    .filter((m) => m.content.trim())
    .map((m) => `[${m.role}]: ${m.content}`)
    .join("\n\n");
  const prior = priorSummaries
    .map((summary) => summary.content)
    .join("\n\n---\n\n");

  return interpolate(
    compactorText(prior ? "mergeSummary" : "summarize", locale),
    {
      prior,
      messages: formatted,
      maxSummaryTokens,
    },
  );
}

function boundSummaryContent(
  content: string,
  maxTokens: number,
  estimator: TokenEstimator,
  locale: string,
): { readonly content: string; readonly truncated: boolean } {
  const trimmed = content.trim();
  if (estimator(trimmed) <= maxTokens) {
    return { content: trimmed, truncated: false };
  }

  const marker = compactorText("truncated", locale);
  if (estimator(marker.trim()) > maxTokens) {
    return {
      content: trimmed.slice(0, Math.max(1, maxTokens)),
      truncated: true,
    };
  }
  let low = 0;
  let high = trimmed.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const candidate = `${trimmed.slice(0, mid).trimEnd()}${marker}`;
    if (estimator(candidate) <= maxTokens) low = mid;
    else high = mid - 1;
  }
  return {
    content: `${trimmed.slice(0, low).trimEnd()}${marker}`,
    truncated: true,
  };
}

/**
 * Walk backwards through the message list to find the index at which the
 * protect window begins — mirrors the logic in budget.ts.
 *
 * Protects:
 * - the last `protectLastNUserTurns` user messages (and everything after them)
 * - at least the last `protectLastNMessages` messages overall
 *
 * Returns the index of the first protected message. Everything at/after this
 * index is off-limits for compaction.
 */
function computeProtectStart(
  messages: readonly TurnMessageRecord[],
  protectLastNUserTurns: number,
  protectLastNMessages: number,
): number {
  const n = messages.length;
  if (n === 0) return 0;

  // Absolute tail protection
  const tailProtect = Math.max(0, n - protectLastNMessages);

  // User-turn protection. A zero count disables this rule, leaving only the
  // absolute tail protection; without the explicit branch, the first user
  // encountered satisfied `userSeen >= 0` and was accidentally protected.
  let userTurnProtect = n;
  if (protectLastNUserTurns > 0) {
    let userSeen = 0;
    for (let i = n - 1; i >= 0; i--) {
      if (messages[i]!.role === "user") {
        userSeen += 1;
        if (userSeen >= protectLastNUserTurns) {
          userTurnProtect = i;
          break;
        }
      }
    }
    if (userSeen < protectLastNUserTurns) {
      userTurnProtect = 0; // protect entire list
    }
  }

  // The more conservative (earlier) boundary wins
  return Math.min(tailProtect, userTurnProtect);
}

/**
 * An attempt to compact that could not finish. The host skips a provider that
 * throws, logs the message and reports it with the turn's trace, so the message
 * is the reason an author reads there. Returning `null` stays for "nothing to
 * compact".
 */
export class HistoryCompactionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "HistoryCompactionError";
  }
}

export async function compactHistory(
  input: HistoryCompactionInput,
  deps: {
    fastSlotLlm: CompactorLLMAdapter;
    estimator?: TokenEstimator;
    loadPrompt?: PromptLoader;
  },
  opts: CompactionPolicyOptions = {},
): Promise<HistoryCompactionOutput> {
  const { messages, existingSummaries, locale } = input;
  const estimator = deps.estimator ?? estimateTokens;
  const protectStart = computeProtectStart(
    messages,
    opts.protectLastNUserTurns ?? DEFAULT_PROTECT_LAST_USER_TURNS,
    opts.protectLastNMessages ?? DEFAULT_PROTECT_LAST_N_MESSAGES,
  );
  const lastCompactedIndex = messages.findLastIndex(
    (m) => m.compactedAtTurnId != null,
  );
  let toCompact = messages.slice(lastCompactedIndex + 1, protectStart);
  if (!toCompact.length) return null;
  const { summaryBudget } = input;
  const focusSections = [...new Set(opts.focusSections ?? [])];
  const freshSystemPrompt = await buildCompactorSystemPrompt(
    locale,
    focusSections,
    deps.loadPrompt ?? loadPrompt,
  ).catch((error: unknown) => {
    throw new HistoryCompactionError(
      `The summary prompt template could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  });
  // Pick the largest contiguous prefix that the fast model can actually read.
  // Never truncate a source message: its original content stays visible until
  // a complete summary can replace it.
  let low = 0;
  let high = toCompact.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const prompt = buildCompactorUserPrompt(
      toCompact.slice(0, mid),
      locale,
      [],
      summaryBudget.maxSegmentTokens,
    );
    if (estimator(freshSystemPrompt) + estimator(prompt) <= input.inputWindow)
      low = mid;
    else high = mid - 1;
  }
  toCompact = toCompact.slice(0, low);
  if (!toCompact.length)
    throw new HistoryCompactionError(
      "The oldest message does not fit the summary model's input window",
    );
  const sourceTokens = toCompact.reduce(
    (n, message) => n + estimator(message.content),
    0,
  );
  let newBudget = Math.min(
    summaryBudget.maxSegmentTokens,
    Math.max(128, Math.ceil(sourceTokens * 0.25)),
  );
  const summarize = async (
    selectedMessages: readonly TurnMessageRecord[],
    selectedSummaries: readonly SessionSummaryRecord[],
    maxTokens: number,
    sections: readonly string[],
  ) => {
    const systemPrompt =
      selectedSummaries.length === 0
        ? freshSystemPrompt
        : await buildCompactorSystemPrompt(
            locale,
            sections,
            deps.loadPrompt ?? loadPrompt,
          );
    const userPrompt = buildCompactorUserPrompt(
      selectedMessages,
      locale,
      selectedSummaries,
      maxTokens,
    );
    if (estimator(systemPrompt) + estimator(userPrompt) > input.inputWindow)
      throw new HistoryCompactionError(
        "The summary request does not fit the summary model's input window",
      );
    const response = await deps.fastSlotLlm.complete({
      systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    });
    if (!response.content.trim())
      throw new HistoryCompactionError(
        "The summary model returned an empty summary",
      );
    const bounded = boundSummaryContent(
      response.content,
      maxTokens,
      estimator,
      locale,
    );
    if (!bounded.content.trim() || estimator(bounded.content) > maxTokens)
      throw new HistoryCompactionError(
        "The summary could not be bounded to its token budget",
      );
    return {
      content: bounded.content,
      focusSections: sections,
      truncated: bounded.truncated,
    };
  };
  let fresh = await summarize(toCompact, [], newBudget, focusSections);
  const totalExistingTokens = existingSummaries.reduce(
    (n, summary) => n + estimator(summary.content),
    0,
  );
  let mergeCount = 0;
  let retainedTokens = totalExistingTokens;
  let mergeBudget = 0;
  let freshTokens = estimator(fresh.content);
  if (
    existingSummaries.length > 0 &&
    totalExistingTokens + freshTokens > summaryBudget.maxTokens
  ) {
    // A tiny window cannot hold two full-sized segments. Bound only this
    // fresh result once more, reserving room for the old prefix's merge.
    newBudget = Math.min(newBudget, Math.floor(summaryBudget.maxTokens / 2));
    if (newBudget < 1)
      throw new HistoryCompactionError(
        "The summary budget is too small to merge older segments",
      );
    const bounded = boundSummaryContent(
      fresh.content,
      newBudget,
      estimator,
      locale,
    );
    if (estimator(bounded.content) > newBudget)
      throw new HistoryCompactionError(
        "The new summary could not be bounded to leave room for the merge",
      );
    fresh = {
      ...fresh,
      content: bounded.content,
      truncated: fresh.truncated || bounded.truncated,
    };
    freshTokens = estimator(fresh.content);
  }
  // Use actual generated sizes rather than the maximum allocation: small
  // segments must not trigger an unnecessary rewrite of older history.
  while (
    mergeCount < existingSummaries.length &&
    (existingSummaries.length - mergeCount + 1 + (mergeCount > 0 ? 1 : 0) >
      summaryBudget.maxSegments ||
      retainedTokens + freshTokens + mergeBudget > summaryBudget.maxTokens)
  ) {
    retainedTokens -= estimator(existingSummaries[mergeCount]!.content);
    mergeCount += 1;
    const selectedTokens = totalExistingTokens - retainedTokens;
    mergeBudget = Math.min(
      summaryBudget.maxSegmentTokens,
      Math.max(1, summaryBudget.maxTokens - freshTokens - retainedTokens),
      Math.max(1, Math.ceil(selectedTokens * 0.75)),
    );
  }
  const summaries: NonNullable<HistoryCompactionOutput>["summaries"][number][] =
    [];
  if (mergeCount > 0) {
    const selected = existingSummaries.slice(0, mergeCount);
    const mergedSections = [
      ...new Set(selected.flatMap((summary) => summary.focusSections)),
    ];
    const merged = await summarize([], selected, mergeBudget, mergedSections);
    summaries.push({
      ...merged,
      messageIds: [],
      replacesSummaryIds: selected.map((summary) => summary.id),
    });
  }
  summaries.push({
    ...fresh,
    messageIds: toCompact.map((message) => message.id),
    replacesSummaryIds: [],
  });
  return { summaries };
}
