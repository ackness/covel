/**
 * The `story-context@1` kernel input: how the kernel turns the notes of
 * pre-turn runtimes into one ranked, budgeted value, and how an agent sees it.
 *
 * Every rule here is pure and deterministic, so each reader of one execution
 * gets the same value from the same results:
 *
 * 1. A contribution that is `null`, empty or missing is no note. One that has
 *    the wrong shape or is too long is left out as `invalid`; its provider is
 *    not affected.
 * 2. Notes rank by priority (`high`, `normal`, `low`), then `order`
 *    ascending, then package ID and runtime ID by code unit.
 * 3. A note whose text equals a higher-ranked one is left out as `duplicate`.
 * 4. Notes go in by rank while their estimated tokens fit the budget. One
 *    that does not fit is left out whole as `budget` (never cut, since a cut
 *    rule reads as a different rule); smaller notes after it still go in.
 */
import {
  STORY_CONTEXT_INPUT,
  STORY_CONTEXT_LIMITS,
  storyContextContributionSchema,
  type StoryContextItem,
  type StoryContextOmission,
  type StoryContextOmissionReason,
  type StoryContextPriority,
  type StoryContextSource,
  type StoryContextValue,
} from "@covel/plugin-handlers-utils";
import type { InputSlot } from "@covel/shared";
import type { TokenEstimator } from "./budget.js";
import { escapeXmlContent } from "./prompt-internals.js";

/** One pre-turn result that declared `io.storyContext`. */
export interface StoryContextCandidate {
  readonly source: StoryContextSource;
  /** Defaults to `normal`. */
  readonly priority?: StoryContextPriority;
  /** Defaults to `0`. */
  readonly order?: number;
  /** The title of a note that has none: the package's display name. */
  readonly defaultTitle: string;
  /** The value at `select`; `undefined` when the pointer found nothing. */
  readonly value: unknown;
  /** The provider handles hidden content: its trace rows keep the title only. */
  readonly concealed?: boolean;
}

/** One trace row of a note; a concealed provider's row has its title only. */
export interface StoryContextTraceRow {
  readonly title: string;
  readonly pluginId?: string;
  readonly runtimeId?: string;
  /** Estimated tokens of the rendered note. Absent for an invalid one. */
  readonly tokens?: number;
  readonly reason?: StoryContextOmissionReason;
}

export interface StoryContextSelection {
  readonly value: StoryContextValue;
  /** The candidates whose note the value carries, in ranked order. */
  readonly included: readonly StoryContextCandidate[];
  readonly budgetTokens: number;
  readonly usedTokens: number;
  readonly trace: {
    readonly included: readonly StoryContextTraceRow[];
    readonly omitted: readonly StoryContextTraceRow[];
  };
}

const PRIORITY_RANK: Readonly<Record<StoryContextPriority, number>> = {
  high: 0,
  normal: 1,
  low: 2,
};

// Code-unit compare keeps the order identical across ICU builds, as in
// `selectPromptSegments`.
const codeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function rank(a: StoryContextCandidate, b: StoryContextCandidate): number {
  return (
    PRIORITY_RANK[a.priority ?? "normal"] -
      PRIORITY_RANK[b.priority ?? "normal"] ||
    (a.order ?? 0) - (b.order ?? 0) ||
    codeUnit(a.source.pluginId, b.source.pluginId) ||
    codeUnit(a.source.runtimeId, b.source.runtimeId)
  );
}

/**
 * The token budget of all notes: the smaller of 3,000 and 10% of the story
 * model's input window. Without a known window it is 3,000.
 */
export function storyContextBudget(inputWindow?: number): number {
  const cap = STORY_CONTEXT_LIMITS.maxTokens;
  if (
    inputWindow === undefined ||
    !Number.isFinite(inputWindow) ||
    inputWindow <= 0
  )
    return cap;
  return Math.min(
    cap,
    Math.floor(inputWindow * STORY_CONTEXT_LIMITS.windowShare),
  );
}

type Normalized =
  | { readonly kind: "none" }
  | { readonly kind: "invalid" }
  | { readonly kind: "note"; readonly title: string; readonly content: string };

function normalize(candidate: StoryContextCandidate): Normalized {
  if (candidate.value === undefined) return { kind: "none" };
  const parsed = storyContextContributionSchema.safeParse(candidate.value);
  if (!parsed.success) return { kind: "invalid" };
  const contribution = parsed.data;
  if (contribution === null) return { kind: "none" };
  const content = (
    typeof contribution === "string" ? contribution : contribution.content
  ).trim();
  if (content === "") return { kind: "none" };
  const title =
    (typeof contribution === "string"
      ? ""
      : (contribution.title ?? "")
    ).trim() ||
    candidate.defaultTitle.trim() ||
    candidate.source.pluginId;
  return { kind: "note", title, content };
}

/** One note as an agent reads it inside `<story-context>`. */
export function renderStoryContextNote(
  note: Pick<StoryContextItem, "title" | "content">,
): string {
  const title = escapeXmlContent(note.title).replace(/"/g, "&quot;");
  return `<note title="${title}">${escapeXmlContent(note.content)}</note>`;
}

/** Rank, deduplicate and fit the contributions of one execution. */
export function selectStoryContext(
  candidates: readonly StoryContextCandidate[],
  options: {
    readonly budgetTokens: number;
    readonly estimator: TokenEstimator;
  },
): StoryContextSelection {
  const items: StoryContextItem[] = [];
  const omitted: StoryContextOmission[] = [];
  const included: StoryContextCandidate[] = [];
  const traceIncluded: StoryContextTraceRow[] = [];
  const traceOmitted: StoryContextTraceRow[] = [];
  const seen = new Set<string>();
  let usedTokens = 0;
  const row = (
    candidate: StoryContextCandidate,
    title: string,
    extra: Omit<StoryContextTraceRow, "title">,
  ): StoryContextTraceRow =>
    candidate.concealed
      ? {
          title,
          ...(extra.reason !== undefined ? { reason: extra.reason } : {}),
        }
      : {
          title,
          pluginId: candidate.source.pluginId,
          runtimeId: candidate.source.runtimeId,
          ...extra,
        };
  const omit = (
    candidate: StoryContextCandidate,
    title: string,
    reason: StoryContextOmissionReason,
    tokens?: number,
  ) => {
    omitted.push({ title, source: { ...candidate.source }, reason });
    traceOmitted.push(
      row(candidate, title, {
        reason,
        ...(tokens !== undefined ? { tokens } : {}),
      }),
    );
  };
  for (const candidate of [...candidates].sort(rank)) {
    const note = normalize(candidate);
    if (note.kind === "none") continue;
    if (note.kind === "invalid") {
      omit(
        candidate,
        candidate.defaultTitle.trim() || candidate.source.pluginId,
        "invalid",
      );
      continue;
    }
    const tokens = options.estimator(renderStoryContextNote(note));
    if (seen.has(note.content)) {
      omit(candidate, note.title, "duplicate", tokens);
      continue;
    }
    seen.add(note.content);
    if (usedTokens + tokens > options.budgetTokens) {
      omit(candidate, note.title, "budget", tokens);
      continue;
    }
    usedTokens += tokens;
    items.push({
      title: note.title,
      content: note.content,
      priority: candidate.priority ?? "normal",
      source: { ...candidate.source },
    });
    included.push(candidate);
    traceIncluded.push(row(candidate, note.title, { tokens }));
  }
  return {
    value: { items, omitted },
    included,
    budgetTokens: options.budgetTokens,
    usedTokens,
    trace: { included: traceIncluded, omitted: traceOmitted },
  };
}

/** Whether an input slot carries the `story-context@1` kernel input. */
export function isStoryContextSlot(slot: InputSlot): boolean {
  return (
    slot.cardinality === "one" &&
    slot.source.pluginId === KERNEL_INPUT_PLUGIN_ID &&
    slot.source.runtimeId === STORY_CONTEXT_INPUT
  );
}

/** The provenance plugin ID of every kernel input slot. */
export const KERNEL_INPUT_PLUGIN_ID = "__kernel";

/**
 * The `<story-context>` block of an agent's turn context: the kernel's header
 * in the instruction language, then one note per item. Empty without items.
 */
export function renderStoryContextBlock(
  value: Pick<StoryContextValue, "items"> | undefined,
  header: string,
): string {
  const items = value?.items ?? [];
  if (items.length === 0) return "";
  return [
    "<story-context>",
    header.trim(),
    ...items.map((item) => renderStoryContextNote(item)),
    "</story-context>",
  ].join("\n");
}
