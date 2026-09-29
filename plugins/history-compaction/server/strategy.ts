import {
  canonicalizeLocale,
  DEFAULT_LOCALE,
  localeRegistry,
  localeDisplayName,
  resolveI18nText,
  type I18nText,
  type SimpleCompletionAdapter,
  type HistoryCompactionInput,
  type HistoryCompactionOutput,
} from "@covel/shared";
import {
  createPromptLoader,
  interpolate,
  estimateTokens,
  type PromptLoader,
  type TokenEstimator,
} from "@covel/context";
import type { TurnMessageRecord, SessionSummaryRecord } from "@covel/store";
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
const SUMMARY_TOKEN_FRACTION = 0.04;
const MIN_SUMMARY_TOKENS = 128;
const MAX_SUMMARY_TOKENS = 1_024;

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
      "请把已有滚动摘要与新增对话合并成一份完整摘要，不能遗漏仍有效的名称、约定、位置、关系、状态和因果。最终摘要不超过约 {{ maxSummaryTokens }} tokens。\n\n<已有滚动摘要>\n{{ prior }}\n</已有滚动摘要>\n\n<新增对话>\n{{ messages }}\n</新增对话>",
    "en-US":
      "Merge the existing rolling summary and new conversation into one complete summary. Preserve all still-valid names, agreements, locations, relationships, states, and causal links. Keep the final summary under approximately {{ maxSummaryTokens }} tokens.\n\n<existing_rolling_summary>\n{{ prior }}\n</existing_rolling_summary>\n\n<new_conversation>\n{{ messages }}\n</new_conversation>",
    "ru-RU":
      "Объедини существующее накопительное резюме и новый диалог в одно полное резюме. Сохрани все по-прежнему актуальные имена, договорённости, места, отношения, состояния и причинно-следственные связи. Итоговое резюме должно занимать не более примерно {{ maxSummaryTokens }} токенов.\n\n<existing_rolling_summary>\n{{ prior }}\n</existing_rolling_summary>\n\n<new_conversation>\n{{ messages }}\n</new_conversation>",
  },
  summarize: {
    "zh-CN":
      "请将以下对话历史摘要化，最终摘要不超过约 {{ maxSummaryTokens }} tokens：\n\n{{ messages }}",
    "en-US":
      "Please summarize the following conversation history in approximately {{ maxSummaryTokens }} tokens or fewer:\n\n{{ messages }}",
    "ru-RU":
      "Кратко изложи следующую историю диалога, уложившись примерно в {{ maxSummaryTokens }} токенов:\n\n{{ messages }}",
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
  return `${interpolate(template, {
    sections: effective.join("\n- "),
  }).trimEnd()}\n\n[LANGUAGE] Write all natural-language summary content in ${languageName} (${canonicalLocale}).`;
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
  const formatted = messages
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

function resolveSummaryTokenBudget(contextWindow: number): number {
  return Math.min(
    MAX_SUMMARY_TOKENS,
    Math.max(
      MIN_SUMMARY_TOKENS,
      Math.floor(contextWindow * SUMMARY_TOKEN_FRACTION),
    ),
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

export async function compactHistory(
  input: HistoryCompactionInput,
  deps: {
    fastSlotLlm: CompactorLLMAdapter;
    estimator?: TokenEstimator;
    loadPrompt?: PromptLoader;
  },
  opts: CompactionPolicyOptions = {},
): Promise<HistoryCompactionOutput> {
  const { messages, existingSummaries, contextWindow, locale } = input;
  const estimator = deps.estimator ?? estimateTokens;
  const protectStart = computeProtectStart(
    messages,
    opts.protectLastNUserTurns ?? 2,
    opts.protectLastNMessages ?? 5,
  );
  const lastCompactedIndex = messages.findLastIndex(
    (m) => m.compactedAtTurnId != null,
  );
  const toCompact = messages.slice(lastCompactedIndex + 1, protectStart);
  if (!toCompact.length) return null;
  const maxSummaryTokens = resolveSummaryTokenBudget(contextWindow);
  const mergedFocusSections = [
    ...new Set([
      ...existingSummaries.flatMap((s) => s.focusSections),
      ...(opts.focusSections ?? []),
    ]),
  ];
  try {
    const systemPrompt = await buildCompactorSystemPrompt(
      locale,
      mergedFocusSections,
      deps.loadPrompt ?? loadPrompt,
    );
    const response = await deps.fastSlotLlm.complete({
      systemPrompt,
      messages: [
        {
          role: "user",
          content: buildCompactorUserPrompt(
            toCompact,
            locale,
            existingSummaries,
            maxSummaryTokens,
          ),
        },
      ],
    });
    if (!response.content.trim()) return null;
    const bounded = boundSummaryContent(
      response.content,
      maxSummaryTokens,
      estimator,
      locale,
    );
    return {
      messageIds: toCompact.map((m) => m.id),
      content: bounded.content,
      focusSections: mergedFocusSections,
      truncated: bounded.truncated,
    };
  } catch (error) {
    console.warn(
      `[history-compaction] Failed to load prompt template or generate summary: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}
