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

const NOT_IMPLEMENTED = "PostgreSQL store not yet implemented";

export class PgStore implements DataStore {
  async listWorlds(): Promise<WorldRecord[]> {
    throw new Error(NOT_IMPLEMENTED);
  }
  async getWorld(_id: string): Promise<WorldRecord | null> {
    throw new Error(NOT_IMPLEMENTED);
  }
  async upsertWorld(_world: WorldRecord): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }
  async deleteWorld(_id: string): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async listSessions(_worldId?: string): Promise<SessionRecord[]> {
    throw new Error(NOT_IMPLEMENTED);
  }
  async getSession(_id: string): Promise<SessionRecord | null> {
    throw new Error(NOT_IMPLEMENTED);
  }
  async upsertSession(_session: SessionRecord): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }
  async deleteSession(_id: string): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async listMessages(_sessionId: string): Promise<MessageRecord[]> {
    throw new Error(NOT_IMPLEMENTED);
  }
  async addMessage(_msg: MessageRecord): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }
  async clearMessages(_sessionId: string): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async listCharacters(_sessionId?: string): Promise<CharacterRecord[]> {
    throw new Error(NOT_IMPLEMENTED);
  }
  async upsertCharacter(_char: CharacterRecord): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }
  async deleteCharacter(_id: string): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async appendEvent(_event: EventRecord): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }
  async listEvents(_branchId: string): Promise<EventRecord[]> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async upsertRecord(_record: DomainRecord): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }
  async listRecords(_branchId: string, _kind?: string): Promise<DomainRecord[]> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async createSnapshot(_snapshot: SnapshotRecord): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }
  async getSnapshot(_id: string): Promise<SnapshotRecord | null> {
    throw new Error(NOT_IMPLEMENTED);
  }
  async listSnapshots(_branchId: string): Promise<SnapshotRecord[]> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async exportAll(): Promise<StoreSnapshot> {
    throw new Error(NOT_IMPLEMENTED);
  }
  async importAll(_data: StoreSnapshot): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }
  async clear(): Promise<void> {
    throw new Error(NOT_IMPLEMENTED);
  }
}
