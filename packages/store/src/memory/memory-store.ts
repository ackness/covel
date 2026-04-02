import type {
  DataStore,
  WorldRecord,
  SessionRecord,
  MessageRecord,
  CharacterRecord,
  EventRecord,
  DomainRecord,
  SnapshotRecord,
  StoreSnapshot,
} from "../types.js";

export class MemoryStore implements DataStore {
  private worlds = new Map<string, WorldRecord>();
  private sessions = new Map<string, SessionRecord>();
  private messages = new Map<string, MessageRecord>();
  private characters = new Map<string, CharacterRecord>();
  private events = new Map<string, EventRecord>();
  private records = new Map<string, DomainRecord>();
  private snapshots = new Map<string, SnapshotRecord>();

  // World

  async listWorlds(): Promise<WorldRecord[]> {
    return [...this.worlds.values()];
  }

  async getWorld(id: string): Promise<WorldRecord | null> {
    return this.worlds.get(id) ?? null;
  }

  async upsertWorld(world: WorldRecord): Promise<void> {
    this.worlds.set(world.id, world);
  }

  async deleteWorld(id: string): Promise<void> {
    this.worlds.delete(id);
  }

  // Session

  async listSessions(worldId?: string): Promise<SessionRecord[]> {
    const all = [...this.sessions.values()];
    if (worldId != null) {
      return all.filter((s) => s.worldId === worldId);
    }
    return all;
  }

  async getSession(id: string): Promise<SessionRecord | null> {
    return this.sessions.get(id) ?? null;
  }

  async upsertSession(session: SessionRecord): Promise<void> {
    this.sessions.set(session.id, session);
  }

  async deleteSession(id: string): Promise<void> {
    this.sessions.delete(id);
  }

  // Message

  async listMessages(sessionId: string): Promise<MessageRecord[]> {
    return [...this.messages.values()].filter(
      (m) => m.sessionId === sessionId,
    );
  }

  async addMessage(msg: MessageRecord): Promise<void> {
    this.messages.set(msg.id, msg);
  }

  async clearMessages(sessionId: string): Promise<void> {
    for (const [id, msg] of this.messages) {
      if (msg.sessionId === sessionId) {
        this.messages.delete(id);
      }
    }
  }

  // Character

  async listCharacters(sessionId?: string): Promise<CharacterRecord[]> {
    const all = [...this.characters.values()];
    if (sessionId != null) {
      return all.filter((c) => c.sessionId === sessionId);
    }
    return all;
  }

  async upsertCharacter(char: CharacterRecord): Promise<void> {
    this.characters.set(char.id, char);
  }

  async deleteCharacter(id: string): Promise<void> {
    this.characters.delete(id);
  }

  // Event

  async appendEvent(event: EventRecord): Promise<void> {
    this.events.set(event.id, event);
  }

  async listEvents(branchId: string): Promise<EventRecord[]> {
    return [...this.events.values()].filter((e) => e.branchId === branchId);
  }

  // Record

  async upsertRecord(record: DomainRecord): Promise<void> {
    this.records.set(record.id, record);
  }

  async listRecords(branchId: string, kind?: string): Promise<DomainRecord[]> {
    return [...this.records.values()].filter((r) => {
      if (r.branchId !== branchId) return false;
      if (kind != null && r.kind !== kind) return false;
      return true;
    });
  }

  // Snapshot

  async createSnapshot(snapshot: SnapshotRecord): Promise<void> {
    this.snapshots.set(snapshot.id, snapshot);
  }

  async getSnapshot(id: string): Promise<SnapshotRecord | null> {
    return this.snapshots.get(id) ?? null;
  }

  async listSnapshots(branchId: string): Promise<SnapshotRecord[]> {
    return [...this.snapshots.values()].filter(
      (s) => s.branchId === branchId,
    );
  }

  // Bulk

  async exportAll(): Promise<StoreSnapshot> {
    return {
      version: "covel-export/v1",
      exportedAt: new Date().toISOString(),
      data: {
        worlds: [...this.worlds.values()],
        sessions: [...this.sessions.values()],
        messages: [...this.messages.values()],
        characters: [...this.characters.values()],
        events: [...this.events.values()],
        records: [...this.records.values()],
        snapshots: [...this.snapshots.values()],
      },
      config: {},
    };
  }

  async importAll(data: StoreSnapshot): Promise<void> {
    await this.clear();

    for (const w of data.data.worlds) this.worlds.set(w.id, w);
    for (const s of data.data.sessions) this.sessions.set(s.id, s);
    for (const m of data.data.messages) this.messages.set(m.id, m);
    for (const c of data.data.characters) this.characters.set(c.id, c);
    for (const e of data.data.events) this.events.set(e.id, e);
    for (const r of data.data.records) this.records.set(r.id, r);
    for (const s of data.data.snapshots) this.snapshots.set(s.id, s);
  }

  async clear(): Promise<void> {
    this.worlds.clear();
    this.sessions.clear();
    this.messages.clear();
    this.characters.clear();
    this.events.clear();
    this.records.clear();
    this.snapshots.clear();
  }
}
