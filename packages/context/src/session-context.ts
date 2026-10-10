/** Captures committed world state and caller-resolved history summaries once per execution. */

import {
  instructionLocaleFor,
  localizedWorldText,
  narratorLore,
} from "@covel/shared";
import type {
  LorebookEntryRecord,
  SessionContextReadStore,
  SessionRecord,
  WorldRecord,
} from "./session-context-store.js";
import type {
  CharacterSummary,
  ContextContribution,
  LorebookEntryView,
  LorebookPromptPosition,
  SessionContextSnapshot,
  SummaryRecord,
} from "./types.js";
import { buildWorldContextView } from "./session-context-views.js";

/**
 * Options for `buildSessionContextSnapshot`. Caller supplies optional
 * inputs (core memory, summaries) already resolved; the snapshot loader
 * does not inspect environment configuration.
 */
export interface BuildSessionContextSnapshotOpts {
  /** Locale for this turn. Usually resolved from request → session → world default → app default (`zh-CN`). */
  readonly locale: string;
  /** Current turn number (player messages completed pre-turn). Caller computes. */
  readonly turnNumber: number;
  /** World this session is bound to. Used to load `WorldContextView`. */
  readonly worldId?: string;
  readonly worldContext?: {
    readonly schema?: Record<string, unknown>;
    readonly entries?: Record<string, unknown>;
    readonly dimensions?: import("@covel/shared").DimensionSnapshot;
    readonly dimensionProviderPluginId?: string;
  };
  /**
   * Pre-loaded session summaries. Caller decides whether to load them
   * based on compactor/store availability. Defaults to `[]`.
   */
  readonly summaries?: readonly SummaryRecord[];
  /** Current player text for selective lorebook activation. */
  readonly playerMessage?: string;
  /** Committed recent messages for per-entry extra.scanDepth (0–20). */
  readonly recentMessages?: readonly { readonly content: string }[];
  /**
   * Rows the caller has already read for this execution. A field that is set
   * is used as given and not read again, so the prompt shows the rows the
   * execution's runtimes got; `null` says the caller looked and found none.
   */
  readonly loaded?: {
    readonly session?: Pick<SessionRecord, "metadata"> | null;
    readonly characters?: readonly CharacterSummary[];
    readonly lastFormValues?: Readonly<Record<string, unknown>> | null;
  };
}

export async function buildSessionContextSnapshot(
  store: SessionContextReadStore,
  sessionId: string,
  opts: BuildSessionContextSnapshotOpts,
): Promise<SessionContextSnapshot> {
  const { loaded } = opts;
  // Session read is for completeness — caller already gates on active status.
  // None of these reads needs the result of another.
  const [
    sessionRecord,
    characters,
    lastFormValues,
    lorebookRecords,
    storedWorldRecord,
  ] = await Promise.all([
    loaded?.session !== undefined
      ? loaded.session
      : safeGetSession(store, sessionId),
    loaded?.characters ?? loadCharacters(store, sessionId),
    loaded?.lastFormValues !== undefined
      ? (loaded.lastFormValues ?? undefined)
      : loadLastFormValues(store, sessionId),
    loadLorebookRecords(store, sessionId),
    opts.worldId ? safeGetWorld(store, opts.worldId) : null,
  ]);

  const loreOverride = sessionRecord?.metadata?.loreOverride;
  const lore =
    typeof loreOverride === "string"
      ? loreOverride
      : localizedWorldText(storedWorldRecord, opts.locale).lore;
  // The model reads the narrator-only parts too, without their marker lines.
  const worldRecord = storedWorldRecord
    ? {
        ...storedWorldRecord,
        lore: lore === undefined ? undefined : narratorLore(lore),
      }
    : null;

  const worldSchema = opts.worldContext?.schema;
  const worldEntriesMap = {
    ...lorebookWorldEntriesMap(lorebookRecords),
    ...opts.worldContext?.entries,
  };

  return {
    sessionId,
    turnNumber: opts.turnNumber,
    locale: opts.locale,
    sessionMeta: { turnNumber: opts.turnNumber, characters, lastFormValues },
    world: buildWorldContextView({
      worldId: opts.worldId,
      worldRecord,
      schemaMap: worldSchema,
      entriesMap: worldEntriesMap,
      dimensions: opts.worldContext?.dimensions,
      dimensionProviderPluginId: opts.worldContext?.dimensionProviderPluginId,
      locale: opts.locale,
    }),
    characters,
    loreEntries: lorebookRecords.map(toLorebookEntryView),
    summaries: opts.summaries ?? [],
    contributions: [
      ...compileLorebookContributions(
        lorebookRecords,
        opts.playerMessage ?? "",
        opts.locale,
        opts.recentMessages ?? [],
      ),
    ],
  };
}

// ── Per-source loaders ──────────────────────────────────────────────

async function safeGetSession(
  store: SessionContextReadStore,
  sessionId: string,
) {
  try {
    return await store.getSession(sessionId);
  } catch {
    return null;
  }
}

/**
 * Log a per-source loader failure before degrading to an empty fallback. The
 * loaders never throw (graceful degradation is intentional), but swallowing the
 * error with no log turned a transient store failure into empty world/character
 * context injected into the LLM — invisible to operators. Warn so it's visible.
 */
function warnLoadFailure(
  loader: string,
  sessionId: string,
  err: unknown,
): void {
  const message = err instanceof Error ? err.message : String(err);
  console.warn(
    `[session-context] ${loader} failed for session ${sessionId}: ${message}. ` +
      `Degrading to empty — the prompt may omit this context.`,
  );
}

async function loadCharacters(
  store: SessionContextReadStore,
  sessionId: string,
): Promise<readonly CharacterSummary[]> {
  try {
    const records = await store.listCharacters(sessionId);
    return records.map((c) => ({
      id: c.id,
      name: c.name,
      type: c.type,
      description: c.description,
      fields:
        c.fields && typeof c.fields === "object"
          ? (c.fields as Record<string, unknown>)
          : undefined,
    }));
  } catch (err) {
    warnLoadFailure("loadCharacters", sessionId, err);
    return [];
  }
}

async function loadLastFormValues(
  store: SessionContextReadStore,
  sessionId: string,
): Promise<Readonly<Record<string, unknown>> | undefined> {
  // Non-critical: player inputs may not exist yet
  try {
    const latest = await store.getLatestPlayerInput(sessionId);
    if (latest?.values && typeof latest.values === "object") {
      return latest.values as Record<string, unknown>;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

async function loadLorebookRecords(
  store: SessionContextReadStore,
  sessionId: string,
): Promise<readonly LorebookEntryRecord[]> {
  if (typeof store.listSessionLorebookEntries !== "function") return [];
  try {
    return await store.listSessionLorebookEntries(sessionId);
  } catch (err) {
    warnLoadFailure("loadLorebookRecords", sessionId, err);
    return [];
  }
}

function compileLorebookContributions(
  records: readonly LorebookEntryRecord[],
  playerMessage: string,
  locale: string,
  recentMessages: readonly { readonly content: string }[],
): readonly ContextContribution[] {
  return records
    .filter((record) => record.enabled)
    .filter((record) =>
      isLorebookEntryActive(record, playerMessage, recentMessages),
    )
    .slice()
    .sort(
      (a, b) => a.insertionOrder - b.insertionOrder || a.id.localeCompare(b.id),
    )
    .map((record) => {
      const extra = normalizeLorebookExtra(record.extra);
      const coordinate = normalizeLorebookCoordinate(
        record.position,
        extra.coordinate,
      );
      return {
        kind: "lore_entry",
        sourceType: "world",
        sourceId: record.id,
        content: formatLorebookContributionContent(record, locale, extra.title),
        position: coordinate.position ?? DEFAULT_LOREBOOK_POSITION,
        ...(coordinate.depth !== undefined ? { depth: coordinate.depth } : {}),
        order: record.insertionOrder,
        debugTrace: {
          owner: record.owner,
          strategy: record.strategy,
          keys: record.keys,
          ...(extra.sourceRuleId ? { sourceRuleId: extra.sourceRuleId } : {}),
        },
      };
    });
}

const LATIN_WORD_EDGE =
  "(?:[^\\p{L}\\p{N}_]|[\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}])";

function isLorebookEntryActive(
  record: LorebookEntryRecord,
  playerMessage: string,
  recentMessages: readonly { readonly content: string }[],
): boolean {
  if (record.strategy === "constant") return true;
  if (!record.keys || record.keys.length === 0) return false;
  const rawDepth = normalizeLorebookExtra(record.extra).scanDepth;
  const depth =
    typeof rawDepth === "number" && Number.isInteger(rawDepth)
      ? Math.max(0, Math.min(20, rawDepth))
      : 0;
  const haystack = [
    ...(depth > 0
      ? recentMessages.slice(-depth).map((message) => message.content)
      : []),
    playerMessage,
  ]
    .join("\n")
    .toLowerCase();
  return record.keys.some((key) => {
    if (!key.trim()) return false;
    const needle = key.toLowerCase();
    if (!/^[\x20-\x7e]+$/.test(needle) || !/[a-z]/.test(needle))
      return haystack.includes(needle);
    // A Latin key matches as a whole word, so `art` is not found in `start`.
    // The word may carry a plural or possessive ending: an author who writes
    // `lantern` means `lanterns` and `lantern's` too.
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Chinese, Japanese and Korean text puts no space around a Latin name, so
    // a character of those scripts ends a word too.
    return new RegExp(
      `(?:^|${LATIN_WORD_EDGE})${escaped}(?:e?s|['’]s)?(?=$|${LATIN_WORD_EDGE})`,
      "u",
    ).test(haystack);
  });
}

interface NormalizedLorebookExtra {
  readonly scanDepth?: number;
  readonly title?: string;
  readonly coordinate?: {
    readonly position?: unknown;
    readonly depth?: unknown;
  };
  readonly sourceRuleId?: string;
}

function normalizeLorebookExtra(value: unknown): NormalizedLorebookExtra {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const root = value as Record<string, unknown>;
  const nestedExtra =
    root.extra && typeof root.extra === "object" && !Array.isArray(root.extra)
      ? (root.extra as Record<string, unknown>)
      : undefined;
  const source = nestedExtra ?? root;
  return {
    ...(typeof source.scanDepth === "number"
      ? { scanDepth: source.scanDepth }
      : {}),
    ...(typeof source.title === "string" && source.title.length > 0
      ? { title: source.title }
      : {}),
    ...(source.coordinate &&
    typeof source.coordinate === "object" &&
    !Array.isArray(source.coordinate)
      ? {
          coordinate:
            source.coordinate as NormalizedLorebookExtra["coordinate"],
        }
      : {}),
    ...(typeof source.sourceRuleId === "string"
      ? { sourceRuleId: source.sourceRuleId }
      : {}),
  };
}

/**
 * Documented default lore position, applied only when a record carries no
 * recognizable position (see {@link normalizeLorebookCoordinate}).
 */
const DEFAULT_LOREBOOK_POSITION: LorebookPromptPosition = "after_plugin";

function normalizeLorebookCoordinate(
  recordPosition: string,
  extraCoordinate: NormalizedLorebookExtra["coordinate"],
): {
  readonly position?: LorebookPromptPosition;
  readonly depth?: number;
} {
  const candidate =
    typeof extraCoordinate?.position === "string"
      ? extraCoordinate.position
      : recordPosition;
  // Strict rejection, mirroring `normalizePersonaCoordinate`: no undocumented
  // aliases and no silent downgrade. An unrecognized value yields `undefined`
  // plus a warning; the caller applies the documented default so the mistake
  // is diagnosable instead of quietly relocating the lore.
  const position = parseLorebookPosition(candidate);
  if (position === undefined) {
    console.warn(
      `[session-context] unrecognized lorebook position "${candidate}"; ` +
        `defaulting to "${DEFAULT_LOREBOOK_POSITION}". Expected one of: ` +
        `before_plugin, after_plugin, at_depth.`,
    );
  }
  const depth =
    typeof extraCoordinate?.depth === "number" &&
    Number.isFinite(extraCoordinate.depth)
      ? Math.max(0, Math.round(extraCoordinate.depth))
      : undefined;
  return {
    ...(position !== undefined ? { position } : {}),
    ...(position === "at_depth" && depth !== undefined ? { depth } : {}),
  };
}

function parseLorebookPosition(
  value: string,
): LorebookPromptPosition | undefined {
  if (
    value !== "before_plugin" &&
    value !== "after_plugin" &&
    value !== "at_depth"
  ) {
    return undefined;
  }
  return value;
}

function formatLorebookContributionContent(
  record: LorebookEntryRecord,
  locale: string,
  title?: string,
): string {
  const label =
    title ??
    (record.keys && record.keys.length > 0 ? record.keys[0] : record.id);
  // The heading is in the instruction language, like the prompt it goes into.
  const heading =
    instructionLocaleFor(locale) === "zh"
      ? `[世界规则：${label}]`
      : `[World Rule: ${label}]`;
  return [heading, record.content].join("\n");
}

function toLorebookEntryView(r: LorebookEntryRecord): LorebookEntryView {
  const extraFromRecord =
    r.extra && typeof r.extra === "object"
      ? (r.extra as Record<string, unknown>)
      : undefined;
  return {
    id: r.id,
    owner: r.owner,
    content: r.content,
    keys: r.keys,
    enabled: r.enabled,
    extra: {
      strategy: r.strategy,
      position: r.position,
      insertionOrder: r.insertionOrder,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      ...(extraFromRecord ? { extra: extraFromRecord } : {}),
    },
  };
}

async function safeGetWorld(
  store: SessionContextReadStore,
  worldId: string,
): Promise<WorldRecord | null> {
  try {
    return await store.getWorld(worldId);
  } catch (err) {
    warnLoadFailure("safeGetWorld", worldId, err);
    return null;
  }
}

function lorebookWorldEntriesMap(
  records: readonly LorebookEntryRecord[],
): Record<string, unknown> | undefined {
  const relevant = records
    .filter(
      (e) => e.owner.kind === "world" && e.strategy === "constant" && e.enabled,
    )
    .slice()
    .sort((a, b) => a.insertionOrder - b.insertionOrder);
  if (relevant.length === 0) return undefined;
  const map: Record<string, unknown> = {};
  for (const entry of relevant) {
    const key = entry.keys?.[0] ?? entry.id;
    map[key] = entry.content;
  }
  return map;
}
