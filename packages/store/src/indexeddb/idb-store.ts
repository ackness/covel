import { openDB, type IDBPDatabase } from "idb";
import type {
  DataStore,
  WorldRecord,
  SessionRecord,
  MessageRecord,
  CharacterRecord,
  EventRecord,
  DomainRecord,
  SnapshotRecord,
  TraceEventRecord,
  StatePatchRecord,
  StateSnapshotRecord,
  StoreSnapshot,
} from "../types.js";

const STORE_NAMES = [
  "worlds",
  "sessions",
  "messages",
  "characters",
  "events",
  "records",
  "snapshots",
  "traceEvents",
  "statePatches",
  "stateSnapshots",
] as const;

type StoreName = (typeof STORE_NAMES)[number];

export interface IdbStoreOptions {
  dbName?: string;
  dbVersion?: number;
}

export class IdbStore implements DataStore {
  private dbPromise: Promise<IDBPDatabase> | null = null;
  private readonly dbName: string;
  private readonly dbVersion: number;

  constructor(options?: IdbStoreOptions) {
    this.dbName = options?.dbName ?? "covel";
    // NOTE: Increment dbVersion when adding new object stores or indexes.
    // Existing clients with version 1 won't get schema updates unless version increases.
    this.dbVersion = options?.dbVersion ?? 2;
  }

  private getDb(): Promise<IDBPDatabase> {
    if (this.dbPromise == null) {
      this.dbPromise = openDB(this.dbName, this.dbVersion, {
        upgrade(db, oldVersion) {
          if (oldVersion < 1) {
            db.createObjectStore("worlds", { keyPath: "id" });

            const sessions = db.createObjectStore("sessions", { keyPath: "id" });
            sessions.createIndex("worldId", "worldId");

            const messages = db.createObjectStore("messages", { keyPath: "id" });
            messages.createIndex("sessionId", "sessionId");

            const characters = db.createObjectStore("characters", {
              keyPath: "id",
            });
            characters.createIndex("sessionId", "sessionId");

            const events = db.createObjectStore("events", { keyPath: "id" });
            events.createIndex("branchId", "branchId");

            const records = db.createObjectStore("records", { keyPath: "id" });
            records.createIndex("branchId", "branchId");
            records.createIndex("branchId_kind", ["branchId", "kind"]);

            const snapshots = db.createObjectStore("snapshots", {
              keyPath: "id",
            });
            snapshots.createIndex("branchId", "branchId");
          }

          if (oldVersion < 2) {
            const traceEvents = db.createObjectStore("traceEvents", { keyPath: "id" });
            traceEvents.createIndex("sessionId", "sessionId");

            const statePatches = db.createObjectStore("statePatches", { keyPath: "id" });
            statePatches.createIndex("sessionId", "sessionId");

            const stateSnapshots = db.createObjectStore("stateSnapshots", { keyPath: "id" });
            stateSnapshots.createIndex("sessionId", "sessionId");
          }
        },
      });
    }
    return this.dbPromise;
  }

  // World

  async listWorlds(): Promise<WorldRecord[]> {
    const db = await this.getDb();
    return db.getAll("worlds");
  }

  async getWorld(id: string): Promise<WorldRecord | null> {
    const db = await this.getDb();
    return (await db.get("worlds", id)) ?? null;
  }

  async upsertWorld(world: WorldRecord): Promise<void> {
    const db = await this.getDb();
    await db.put("worlds", world);
  }

  async deleteWorld(id: string): Promise<void> {
    const db = await this.getDb();
    await db.delete("worlds", id);
  }

  // Session

  async listSessions(worldId?: string): Promise<SessionRecord[]> {
    const db = await this.getDb();
    if (worldId != null) {
      return db.getAllFromIndex("sessions", "worldId", worldId);
    }
    return db.getAll("sessions");
  }

  async getSession(id: string): Promise<SessionRecord | null> {
    const db = await this.getDb();
    return (await db.get("sessions", id)) ?? null;
  }

  async upsertSession(session: SessionRecord): Promise<void> {
    const db = await this.getDb();
    await db.put("sessions", session);
  }

  async deleteSession(id: string): Promise<void> {
    const db = await this.getDb();
    await db.delete("sessions", id);
  }

  // Message

  async listMessages(sessionId: string): Promise<MessageRecord[]> {
    const db = await this.getDb();
    return db.getAllFromIndex("messages", "sessionId", sessionId);
  }

  async addMessage(msg: MessageRecord): Promise<void> {
    const db = await this.getDb();
    await db.put("messages", msg);
  }

  async clearMessages(sessionId: string): Promise<void> {
    const db = await this.getDb();
    const tx = db.transaction("messages", "readwrite");
    const index = tx.store.index("sessionId");
    let cursor = await index.openCursor(sessionId);
    while (cursor) {
      await cursor.delete();
      cursor = await cursor.continue();
    }
    await tx.done;
  }

  // Character

  async listCharacters(sessionId?: string): Promise<CharacterRecord[]> {
    const db = await this.getDb();
    if (sessionId != null) {
      return db.getAllFromIndex("characters", "sessionId", sessionId);
    }
    return db.getAll("characters");
  }

  async upsertCharacter(char: CharacterRecord): Promise<void> {
    const db = await this.getDb();
    await db.put("characters", char);
  }

  async deleteCharacter(id: string): Promise<void> {
    const db = await this.getDb();
    await db.delete("characters", id);
  }

  // Event

  async appendEvent(event: EventRecord): Promise<void> {
    const db = await this.getDb();
    await db.put("events", event);
  }

  async listEvents(branchId: string): Promise<EventRecord[]> {
    const db = await this.getDb();
    return db.getAllFromIndex("events", "branchId", branchId);
  }

  // Record

  async upsertRecord(record: DomainRecord): Promise<void> {
    const db = await this.getDb();
    await db.put("records", record);
  }

  async listRecords(branchId: string, kind?: string): Promise<DomainRecord[]> {
    const db = await this.getDb();
    if (kind != null) {
      return db.getAllFromIndex("records", "branchId_kind", [branchId, kind]);
    }
    return db.getAllFromIndex("records", "branchId", branchId);
  }

  // Snapshot

  async createSnapshot(snapshot: SnapshotRecord): Promise<void> {
    const db = await this.getDb();
    await db.put("snapshots", snapshot);
  }

  async getSnapshot(id: string): Promise<SnapshotRecord | null> {
    const db = await this.getDb();
    return (await db.get("snapshots", id)) ?? null;
  }

  async listSnapshots(branchId: string): Promise<SnapshotRecord[]> {
    const db = await this.getDb();
    return db.getAllFromIndex("snapshots", "branchId", branchId);
  }

  // Trace Events

  async addTraceEvent(event: TraceEventRecord): Promise<void> {
    const db = await this.getDb();
    await db.put("traceEvents", event);
  }

  async listTraceEvents(sessionId: string): Promise<TraceEventRecord[]> {
    const db = await this.getDb();
    return db.getAllFromIndex("traceEvents", "sessionId", sessionId);
  }

  // State Patches

  async addStatePatch(patch: StatePatchRecord): Promise<void> {
    const db = await this.getDb();
    await db.put("statePatches", patch);
  }

  async listStatePatches(sessionId: string): Promise<StatePatchRecord[]> {
    const db = await this.getDb();
    return db.getAllFromIndex("statePatches", "sessionId", sessionId);
  }

  // State Snapshots

  async saveStateSnapshot(snapshot: StateSnapshotRecord): Promise<void> {
    const db = await this.getDb();
    // Remove previous snapshot for this session, then insert new one
    const tx = db.transaction("stateSnapshots", "readwrite");
    const index = tx.store.index("sessionId");
    let cursor = await index.openCursor(snapshot.sessionId);
    while (cursor) {
      await cursor.delete();
      cursor = await cursor.continue();
    }
    await tx.store.put(snapshot);
    await tx.done;
  }

  async getStateSnapshot(sessionId: string): Promise<StateSnapshotRecord | null> {
    const db = await this.getDb();
    const results = await db.getAllFromIndex("stateSnapshots", "sessionId", sessionId);
    return results[0] ?? null;
  }

  // Bulk

  async exportAll(): Promise<StoreSnapshot> {
    const db = await this.getDb();
    const [worlds, sessions, messages, characters, events, records, snapshots, traceEvents, statePatches, stateSnapshots] =
      await Promise.all([
        db.getAll("worlds"),
        db.getAll("sessions"),
        db.getAll("messages"),
        db.getAll("characters"),
        db.getAll("events"),
        db.getAll("records"),
        db.getAll("snapshots"),
        db.getAll("traceEvents"),
        db.getAll("statePatches"),
        db.getAll("stateSnapshots"),
      ]);

    return {
      version: "covel-export/v1",
      exportedAt: new Date().toISOString(),
      data: {
        worlds,
        sessions,
        messages,
        characters,
        events,
        records,
        snapshots,
        traceEvents,
        statePatches,
        stateSnapshots,
      },
      config: {},
    };
  }

  async importAll(data: StoreSnapshot): Promise<void> {
    const db = await this.getDb();
    const tx = db.transaction([...STORE_NAMES], "readwrite");

    // Clear all stores
    await Promise.all(STORE_NAMES.map((name) => tx.objectStore(name).clear()));

    // Populate stores
    const puts: Promise<unknown>[] = [];
    const addAll = (storeName: StoreName, items: unknown[]) => {
      const store = tx.objectStore(storeName);
      for (const item of items) {
        puts.push(store.put(item));
      }
    };

    addAll("worlds", data.data.worlds);
    addAll("sessions", data.data.sessions);
    addAll("messages", data.data.messages);
    addAll("characters", data.data.characters);
    addAll("events", data.data.events);
    addAll("records", data.data.records);
    addAll("snapshots", data.data.snapshots);
    addAll("traceEvents", data.data.traceEvents ?? []);
    addAll("statePatches", data.data.statePatches ?? []);
    addAll("stateSnapshots", data.data.stateSnapshots ?? []);

    await Promise.all(puts);
    await tx.done;
  }

  async clear(): Promise<void> {
    const db = await this.getDb();
    const tx = db.transaction([...STORE_NAMES], "readwrite");
    await Promise.all(STORE_NAMES.map((name) => tx.objectStore(name).clear()));
    await tx.done;
  }
}
