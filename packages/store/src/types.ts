import type { I18nText } from "@covel/shared";

export interface WorldRecord {
  id: string;
  name: I18nText;
  description: I18nText;
  lore?: I18nText;
  tags?: string[];
  createdAt: string;
}

export interface SessionRecord {
  id: string;
  worldId: string;
  status: "active" | "waiting_for_input" | "archived";
  phase: "init" | "character_creation" | "playing" | "ended";
  presetId?: string;
  settings?: Record<string, unknown>;
  createdAt: string;
}

export interface MessageRecord {
  id: string;
  sessionId: string;
  role: "system" | "user" | "assistant";
  content: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface CharacterRecord {
  id: string;
  worldId: string;
  sessionId?: string;
  name: string;
  type: "player" | "npc" | "companion";
  description?: string;
  fields?: Record<string, unknown>;
  extensions?: Record<string, unknown>;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface EventRecord {
  id: string;
  branchId: string;
  turnId: string;
  type: string;
  source: string;
  locale?: string;
  payload?: Record<string, unknown>;
  createdAt: string;
}

export interface DomainRecord {
  id: string;
  branchId: string;
  kind: string;
  key: string;
  value: unknown;
  summary?: string;
  locale?: string;
  updatedAt: string;
}

export interface SnapshotRecord {
  id: string;
  branchId: string;
  turnId: string;
  label?: string;
  summary?: string;
  data: Record<string, unknown>;
  createdAt: string;
}

export interface StoreSnapshot {
  version: "covel-export/v1";
  exportedAt: string;
  data: {
    worlds: WorldRecord[];
    sessions: SessionRecord[];
    messages: MessageRecord[];
    characters: CharacterRecord[];
    events: EventRecord[];
    records: DomainRecord[];
    snapshots: SnapshotRecord[];
  };
  config: Record<string, unknown>;
}

export interface DataStore {
  // World
  listWorlds(): Promise<WorldRecord[]>;
  getWorld(id: string): Promise<WorldRecord | null>;
  upsertWorld(world: WorldRecord): Promise<void>;
  deleteWorld(id: string): Promise<void>;

  // Session
  listSessions(worldId?: string): Promise<SessionRecord[]>;
  getSession(id: string): Promise<SessionRecord | null>;
  upsertSession(session: SessionRecord): Promise<void>;
  deleteSession(id: string): Promise<void>;

  // Message
  listMessages(sessionId: string): Promise<MessageRecord[]>;
  addMessage(msg: MessageRecord): Promise<void>;
  clearMessages(sessionId: string): Promise<void>;

  // Character
  listCharacters(sessionId?: string): Promise<CharacterRecord[]>;
  upsertCharacter(char: CharacterRecord): Promise<void>;
  deleteCharacter(id: string): Promise<void>;

  // Event
  appendEvent(event: EventRecord): Promise<void>;
  listEvents(branchId: string): Promise<EventRecord[]>;

  // Record
  upsertRecord(record: DomainRecord): Promise<void>;
  listRecords(branchId: string, kind?: string): Promise<DomainRecord[]>;

  // Snapshot
  createSnapshot(snapshot: SnapshotRecord): Promise<void>;
  getSnapshot(id: string): Promise<SnapshotRecord | null>;
  listSnapshots(branchId: string): Promise<SnapshotRecord[]>;

  // Bulk
  exportAll(): Promise<StoreSnapshot>;
  importAll(data: StoreSnapshot): Promise<void>;
  clear(): Promise<void>;
}
