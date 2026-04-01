import type { CharacterCard, CharacterCreateInput } from "./character.js";

/**
 * Plugin Data Access interface.
 *
 * Provides unified read/write access to game data for plugins.
 * - Read operations return data directly.
 * - Write operations return proposal items (to go through the commit chain).
 */
export interface PluginDataAccess {
  // ── State reads ──
  state: {
    get(scope: string, key: string): unknown;
    getScope(scope: string): Record<string, unknown>;
    getAll(): Record<string, unknown>;
  };

  // ── Record reads ──
  records: {
    get(key: string): unknown;
    find(query: RecordQuery): RecordEntry[];
    list(recordType?: string): RecordEntry[];
  };

  // ── Character reads ──
  characters: {
    get(id: string): CharacterCard | undefined;
    findByName(name: string): CharacterCard | undefined;
    list(): CharacterCard[];
    listByType(type: string): CharacterCard[];
  };

  // ── Event reads ──
  events: {
    recent(limit?: number): EventEntry[];
    findByType(eventType: string, limit?: number): EventEntry[];
  };

  // ── Write helpers (return proposal items) ──
  propose: {
    statePatch(scope: string, patch: Record<string, unknown>): ProposalItem;
    eventEmit(eventType: string, data?: Record<string, unknown>): ProposalItem;
    recordUpsert(recordType: string, key: string, fields: Record<string, unknown>): ProposalItem;
    narrativeAppend(text: string): ProposalItem;
    uiRender(blockType: string, data: unknown, interaction?: BlockInteraction): ProposalItem;
    characterCreate(input: CharacterCreateInput): ProposalItem;
    characterUpdate(id: string, patch: Partial<Pick<CharacterCard, "name" | "description" | "fields" | "extensions">>): ProposalItem;
  };
}

export interface RecordEntry {
  key: string;
  recordType: string;
  fields: Record<string, unknown>;
}

export interface EventEntry {
  eventType: string;
  data?: Record<string, unknown>;
  turnId?: string;
  timestamp?: string;
}

export interface ProposalItem {
  kind: string;
  payload: unknown;
}

export interface BlockInteraction {
  requiresResponse: boolean;
  blockType?: string;
}

export interface RecordQuery {
  recordType?: string;
  fieldMatch?: Record<string, unknown>;
  limit?: number;
}
