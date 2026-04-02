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
    this.dbVersion = options?.dbVersion ?? 1;
  }

  private getDb(): Promise<IDBPDatabase> {
    if (this.dbPromise == null) {
      this.dbPromise = openDB(this.dbName, this.dbVersion, {
        upgrade(db) {
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

  // Bulk

  async exportAll(): Promise<StoreSnapshot> {
    const db = await this.getDb();
    const [worlds, sessions, messages, characters, events, records, snapshots] =
      await Promise.all([
        db.getAll("worlds"),
        db.getAll("sessions"),
        db.getAll("messages"),
        db.getAll("characters"),
        db.getAll("events"),
        db.getAll("records"),
        db.getAll("snapshots"),
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
