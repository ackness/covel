/**
 * Local copies of the record shapes the context package consumes from a
 * `SessionContextStore` (see `session-context-store.ts`). These deliberately
 * mirror the canonical `@covel/store` records but are kept local so
 * `@covel/context` does not depend on `@covel/store` directly. The concrete
 * `DataStore` satisfies `SessionContextStore` via structural typing.
 *
 * Wire-shape rules:
 *  - ISO timestamps as `string` — no `Date` objects.
 *  - JSON payloads as `unknown` — narrow at consumption sites.
 *  - Only fields the context package actually reads are included.
 */

export interface SessionRecord {
  readonly id: string;
  readonly worldId?: string;
  readonly status: string;
  readonly turnCount: number;
  readonly preGameCompleted: readonly string[];
  readonly locale: string;
  readonly activePlugins: readonly string[];
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly embeddingModelId?: number | null;
  readonly embeddingLockedAt?: string | null;
  readonly runtimeModelOverrides?: Readonly<Record<string, string>>;
}

export interface WorldRecord {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly lore?: string;
  readonly tags?: readonly string[];
  readonly locale?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly updatedAt?: string;
}

/**
 * The character fields read by `loadCharacters` in `session-context.ts`.
 * Named `CharacterSummaryRecord` (not `CharacterRecord`) so it is clear this
 * is the slim read view the context package needs, not a full DB row.
 */
export interface CharacterSummaryRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly name: string;
  readonly type: string;
  readonly description?: string;
  readonly fields?: unknown;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PlayerInputRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly formId: string;
  readonly values: unknown;
  readonly createdAt: string;
}

export interface WorkingMemoryRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly key: string;
  readonly scope: "player" | "story" | "shared";
  readonly value: unknown;
  readonly schemaRef?: string;
  readonly updatedAt: string;
}

export interface LorebookEntryRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly pluginId: string;
  readonly keys: readonly string[];
  readonly content: string;
  readonly strategy: "constant" | "selective";
  readonly position: string;
  readonly insertionOrder: number;
  readonly enabled: boolean;
  readonly extra?: unknown;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PluginDataRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly pluginId: string;
  readonly namespace: string;
  readonly key: string;
  readonly value: unknown;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TurnMessageRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly sourceType: string;
  readonly sourcePluginId?: string;
  readonly sourceRuntimeId?: string;
  readonly role: string;
  readonly name?: string;
  readonly content: string;
  readonly ui?: unknown;
  readonly pendingInput?: unknown;
  readonly order: number;
  readonly createdAt: string;
  readonly compactedAtTurnId?: string;
}

export interface SessionSummaryRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly turnRangeStart: string;
  readonly turnRangeEnd: string;
  readonly content: string;
  readonly focusSections: readonly string[];
  readonly createdAt: string;
}

export interface TraceEventRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly type: string;
  readonly traceId: string;
  readonly turnId: string;
  readonly payload: unknown;
  readonly createdAt: string;
}
