import { eq, and, asc } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import pgClient from "postgres";
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
import * as schema from "./schema.js";

export interface PgStoreOptions {
  databaseUrl: string;
}

export class PgStore implements DataStore {
  private readonly db;
  private readonly sql;

  constructor(opts: PgStoreOptions) {
    this.sql = pgClient(opts.databaseUrl);
    this.db = drizzle(this.sql, { schema });
  }

  /** Run schema push (create tables if not exist). Call once at startup. */
  async initialize(): Promise<void> {
    // Create tables via raw SQL inside a transaction for atomicity.
    await this.sql.begin(async (_tx) => {
      const tx = _tx as unknown as typeof this.sql;
      await tx`
        CREATE TABLE IF NOT EXISTS worlds (
          id TEXT PRIMARY KEY,
          name JSONB NOT NULL,
          description JSONB NOT NULL DEFAULT '""',
          lore JSONB,
          tags JSONB,
          created_at TEXT NOT NULL
        )
      `;
      // Migration: ensure worlds name/description/lore columns are JSONB (C1 fix)
      await tx`
        DO $$ BEGIN
          IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'worlds' AND column_name = 'name' AND data_type = 'text'
          ) THEN
            ALTER TABLE worlds ALTER COLUMN name TYPE JSONB USING to_jsonb(name);
            ALTER TABLE worlds ALTER COLUMN description TYPE JSONB USING to_jsonb(description);
            ALTER TABLE worlds ALTER COLUMN lore TYPE JSONB USING to_jsonb(lore);
          END IF;
        END $$
      `;
      await tx`
        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY,
          world_id TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active',
          phase TEXT NOT NULL DEFAULT 'init',
          preset_id TEXT,
          settings JSONB,
          created_at TEXT NOT NULL
        )
      `;
      await tx`
        CREATE TABLE IF NOT EXISTS messages (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          metadata JSONB,
          created_at TEXT NOT NULL
        )
      `;
      await tx`
        CREATE TABLE IF NOT EXISTS characters (
          id TEXT PRIMARY KEY,
          world_id TEXT NOT NULL,
          session_id TEXT,
          name TEXT NOT NULL,
          type TEXT NOT NULL DEFAULT 'npc',
          description TEXT,
          fields JSONB,
          extensions JSONB,
          version INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `;
      await tx`
        CREATE TABLE IF NOT EXISTS events (
          id TEXT PRIMARY KEY,
          branch_id TEXT NOT NULL,
          turn_id TEXT NOT NULL,
          type TEXT NOT NULL,
          source TEXT NOT NULL,
          locale TEXT,
          payload JSONB,
          created_at TEXT NOT NULL
        )
      `;
      await tx`
        CREATE TABLE IF NOT EXISTS domain_records (
          id TEXT PRIMARY KEY,
          branch_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          key TEXT NOT NULL,
          value JSONB,
          summary TEXT,
          locale TEXT,
          updated_at TEXT NOT NULL
        )
      `;
      await tx`
        CREATE TABLE IF NOT EXISTS snapshots (
          id TEXT PRIMARY KEY,
          branch_id TEXT NOT NULL,
          turn_id TEXT NOT NULL,
          label TEXT,
          summary TEXT,
          data JSONB NOT NULL,
          created_at TEXT NOT NULL
        )
      `;
    });
  }

  /** Close the underlying connection pool. */
  async close(): Promise<void> {
    await this.sql.end();
  }

  // ── World ───────────────────────────────────────────────────────

  async listWorlds(): Promise<WorldRecord[]> {
    const rows = await this.db.select().from(schema.worlds);
    return rows.map(toWorldRecord);
  }

  async getWorld(id: string): Promise<WorldRecord | null> {
    const rows = await this.db
      .select()
      .from(schema.worlds)
      .where(eq(schema.worlds.id, id));
    return rows.length > 0 ? toWorldRecord(rows[0]) : null;
  }

  async upsertWorld(world: WorldRecord): Promise<void> {
    await this.db
      .insert(schema.worlds)
      .values({
        id: world.id,
        name: world.name,
        description: world.description,
        lore: world.lore ?? null,
        tags: world.tags ?? null,
        createdAt: world.createdAt,
      })
      .onConflictDoUpdate({
        target: schema.worlds.id,
        set: {
          name: world.name,
          description: world.description,
          lore: world.lore ?? null,
          tags: world.tags ?? null,
        },
      });
  }

  async deleteWorld(id: string): Promise<void> {
    await this.db.delete(schema.worlds).where(eq(schema.worlds.id, id));
  }

  // ── Session ─────────────────────────────────────────────────────

  async listSessions(worldId?: string): Promise<SessionRecord[]> {
    if (worldId != null) {
      const rows = await this.db
        .select()
        .from(schema.sessions)
        .where(eq(schema.sessions.worldId, worldId));
      return rows.map(toSessionRecord);
    }
    const rows = await this.db.select().from(schema.sessions);
    return rows.map(toSessionRecord);
  }

  async getSession(id: string): Promise<SessionRecord | null> {
    const rows = await this.db
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.id, id));
    return rows.length > 0 ? toSessionRecord(rows[0]) : null;
  }

  async upsertSession(session: SessionRecord): Promise<void> {
    await this.db
      .insert(schema.sessions)
      .values({
        id: session.id,
        worldId: session.worldId,
        status: session.status,
        phase: session.phase,
        presetId: session.presetId ?? null,
        settings: session.settings ?? null,
        createdAt: session.createdAt,
      })
      .onConflictDoUpdate({
        target: schema.sessions.id,
        set: {
          worldId: session.worldId,
          status: session.status,
          phase: session.phase,
          presetId: session.presetId ?? null,
          settings: session.settings ?? null,
        },
      });
  }

  async deleteSession(id: string): Promise<void> {
    await this.db.delete(schema.sessions).where(eq(schema.sessions.id, id));
  }

  // ── Message ─────────────────────────────────────────────────────

  async listMessages(sessionId: string): Promise<MessageRecord[]> {
    const rows = await this.db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.sessionId, sessionId))
      .orderBy(asc(schema.messages.createdAt));
    return rows.map(toMessageRecord);
  }

  async addMessage(msg: MessageRecord): Promise<void> {
    await this.db.insert(schema.messages).values({
      id: msg.id,
      sessionId: msg.sessionId,
      role: msg.role,
      content: msg.content,
      metadata: msg.metadata ?? null,
      createdAt: msg.createdAt,
    });
  }

  async clearMessages(sessionId: string): Promise<void> {
    await this.db
      .delete(schema.messages)
      .where(eq(schema.messages.sessionId, sessionId));
  }

  // ── Character ───────────────────────────────────────────────────

  async listCharacters(sessionId?: string): Promise<CharacterRecord[]> {
    if (sessionId != null) {
      const rows = await this.db
        .select()
        .from(schema.characters)
        .where(eq(schema.characters.sessionId, sessionId));
      return rows.map(toCharacterRecord);
    }
    const rows = await this.db.select().from(schema.characters);
    return rows.map(toCharacterRecord);
  }

  async upsertCharacter(char: CharacterRecord): Promise<void> {
    await this.db
      .insert(schema.characters)
      .values({
        id: char.id,
        worldId: char.worldId,
        sessionId: char.sessionId ?? null,
        name: char.name,
        type: char.type,
        description: char.description ?? null,
        fields: char.fields ?? null,
        extensions: char.extensions ?? null,
        version: char.version,
        createdAt: char.createdAt,
        updatedAt: char.updatedAt,
      })
      .onConflictDoUpdate({
        target: schema.characters.id,
        set: {
          worldId: char.worldId,
          sessionId: char.sessionId ?? null,
          name: char.name,
          type: char.type,
          description: char.description ?? null,
          fields: char.fields ?? null,
          extensions: char.extensions ?? null,
          version: char.version,
          updatedAt: char.updatedAt,
        },
      });
  }

  async deleteCharacter(id: string): Promise<void> {
    await this.db
      .delete(schema.characters)
      .where(eq(schema.characters.id, id));
  }

  // ── Event ───────────────────────────────────────────────────────

  async appendEvent(event: EventRecord): Promise<void> {
    await this.db.insert(schema.events).values({
      id: event.id,
      branchId: event.branchId,
      turnId: event.turnId,
      type: event.type,
      source: event.source,
      locale: event.locale ?? null,
      payload: event.payload ?? null,
      createdAt: event.createdAt,
    });
  }

  async listEvents(branchId: string): Promise<EventRecord[]> {
    const rows = await this.db
      .select()
      .from(schema.events)
      .where(eq(schema.events.branchId, branchId))
      .orderBy(asc(schema.events.createdAt));
    return rows.map(toEventRecord);
  }

  // ── Record ──────────────────────────────────────────────────────

  async upsertRecord(record: DomainRecord): Promise<void> {
    await this.db
      .insert(schema.domainRecords)
      .values({
        id: record.id,
        branchId: record.branchId,
        kind: record.kind,
        key: record.key,
        value: record.value as Record<string, unknown> | null,
        summary: record.summary ?? null,
        locale: record.locale ?? null,
        updatedAt: record.updatedAt,
      })
      .onConflictDoUpdate({
        target: schema.domainRecords.id,
        set: {
          branchId: record.branchId,
          kind: record.kind,
          key: record.key,
          value: record.value as Record<string, unknown> | null,
          summary: record.summary ?? null,
          locale: record.locale ?? null,
          updatedAt: record.updatedAt,
        },
      });
  }

  async listRecords(branchId: string, kind?: string): Promise<DomainRecord[]> {
    if (kind != null) {
      const rows = await this.db
        .select()
        .from(schema.domainRecords)
        .where(
          and(
            eq(schema.domainRecords.branchId, branchId),
            eq(schema.domainRecords.kind, kind),
          ),
        );
      return rows.map(toDomainRecord);
    }
    const rows = await this.db
      .select()
      .from(schema.domainRecords)
      .where(eq(schema.domainRecords.branchId, branchId));
    return rows.map(toDomainRecord);
  }

  // ── Snapshot ────────────────────────────────────────────────────

  async createSnapshot(snapshot: SnapshotRecord): Promise<void> {
    await this.db.insert(schema.snapshots).values({
      id: snapshot.id,
      branchId: snapshot.branchId,
      turnId: snapshot.turnId,
      label: snapshot.label ?? null,
      summary: snapshot.summary ?? null,
      data: snapshot.data,
      createdAt: snapshot.createdAt,
    });
  }

  async getSnapshot(id: string): Promise<SnapshotRecord | null> {
    const rows = await this.db
      .select()
      .from(schema.snapshots)
      .where(eq(schema.snapshots.id, id));
    return rows.length > 0 ? toSnapshotRecord(rows[0]) : null;
  }

  async listSnapshots(branchId: string): Promise<SnapshotRecord[]> {
    const rows = await this.db
      .select()
      .from(schema.snapshots)
      .where(eq(schema.snapshots.branchId, branchId))
      .orderBy(asc(schema.snapshots.createdAt));
    return rows.map(toSnapshotRecord);
  }

  // ── Bulk ────────────────────────────────────────────────────────

  async exportAll(): Promise<StoreSnapshot> {
    const [w, s, m, c, e, r, sn] = await Promise.all([
      this.listWorlds(),
      this.listSessions(),
      this.db.select().from(schema.messages).then((rows) => rows.map(toMessageRecord)),
      this.listCharacters(),
      this.db.select().from(schema.events).then((rows) => rows.map(toEventRecord)),
      this.db.select().from(schema.domainRecords).then((rows) => rows.map(toDomainRecord)),
      this.db.select().from(schema.snapshots).then((rows) => rows.map(toSnapshotRecord)),
    ]);
    return {
      version: "covel-export/v1",
      exportedAt: new Date().toISOString(),
      data: {
        worlds: w,
        sessions: s,
        messages: m,
        characters: c,
        events: e,
        records: r,
        snapshots: sn,
      },
      config: {},
    };
  }

  async importAll(data: StoreSnapshot): Promise<void> {
    // Use a transaction so a partial failure rolls back instead of leaving
    // the database in a half-imported state after clear() wiped existing data.
    // postgres.js TransactionSql extends Omit<Sql, ...> which strips the call
    // signature in TypeScript. Cast to the base sql type to restore it.
    await this.sql.begin(async (_tx) => {
      const tx = _tx as unknown as typeof this.sql;
      // Clear all tables inside the transaction
      await tx`DELETE FROM snapshots`;
      await tx`DELETE FROM domain_records`;
      await tx`DELETE FROM events`;
      await tx`DELETE FROM messages`;
      await tx`DELETE FROM characters`;
      await tx`DELETE FROM sessions`;
      await tx`DELETE FROM worlds`;

      // Import all data — JSONB columns need JSON.stringify + ::jsonb cast
      const jsonVal = (v: unknown) => v != null ? JSON.stringify(v) : null;
      for (const w of data.data.worlds) {
        await tx`INSERT INTO worlds (id, name, description, lore, tags, created_at)
          VALUES (${w.id}, ${jsonVal(w.name ?? "")}::jsonb, ${jsonVal(w.description ?? "")}::jsonb, ${jsonVal(w.lore)}::jsonb, ${jsonVal(w.tags)}::jsonb, ${w.createdAt})`;
      }
      for (const s of data.data.sessions) {
        await tx`INSERT INTO sessions (id, world_id, status, phase, preset_id, settings, created_at)
          VALUES (${s.id}, ${s.worldId}, ${s.status}, ${s.phase}, ${s.presetId ?? null}, ${jsonVal(s.settings)}::jsonb, ${s.createdAt})`;
      }
      for (const m of data.data.messages) {
        await tx`INSERT INTO messages (id, session_id, role, content, metadata, created_at)
          VALUES (${m.id}, ${m.sessionId}, ${m.role}, ${m.content}, ${jsonVal(m.metadata)}::jsonb, ${m.createdAt})`;
      }
      for (const c of data.data.characters) {
        await tx`INSERT INTO characters (id, world_id, session_id, name, type, description, fields, extensions, version, created_at, updated_at)
          VALUES (${c.id}, ${c.worldId}, ${c.sessionId ?? null}, ${c.name}, ${c.type}, ${c.description ?? null},
                  ${jsonVal(c.fields)}::jsonb, ${jsonVal(c.extensions)}::jsonb, ${c.version}, ${c.createdAt}, ${c.updatedAt})`;
      }
      for (const e of data.data.events) {
        await tx`INSERT INTO events (id, branch_id, turn_id, type, source, locale, payload, created_at)
          VALUES (${e.id}, ${e.branchId}, ${e.turnId}, ${e.type}, ${e.source}, ${e.locale ?? null}, ${jsonVal(e.payload)}::jsonb, ${e.createdAt})`;
      }
      for (const r of data.data.records) {
        await tx`INSERT INTO domain_records (id, branch_id, kind, key, value, summary, locale, updated_at)
          VALUES (${r.id}, ${r.branchId}, ${r.kind}, ${r.key}, ${jsonVal(r.value)}::jsonb, ${r.summary ?? null}, ${r.locale ?? null}, ${r.updatedAt})`;
      }
      for (const s of data.data.snapshots) {
        await tx`INSERT INTO snapshots (id, branch_id, turn_id, label, summary, data, created_at)
          VALUES (${s.id}, ${s.branchId}, ${s.turnId}, ${s.label ?? null}, ${s.summary ?? null}, ${jsonVal(s.data)}::jsonb, ${s.createdAt})`;
      }
    });
  }

  async clear(): Promise<void> {
    // Delete all tables in a single transaction to avoid partial state on interruption.
    await this.sql.begin(async (_tx) => {
      const tx = _tx as unknown as typeof this.sql;
      await tx`DELETE FROM snapshots`;
      await tx`DELETE FROM domain_records`;
      await tx`DELETE FROM events`;
      await tx`DELETE FROM messages`;
      await tx`DELETE FROM characters`;
      await tx`DELETE FROM sessions`;
      await tx`DELETE FROM worlds`;
    });
  }
}

// ── Validation sets for DB→Record mapping ────────────────────────────
const VALID_STATUSES = new Set(["active", "waiting_for_input", "archived"]);
const VALID_PHASES = new Set(["init", "character_creation", "playing", "ended"]);
const VALID_ROLES = new Set(["system", "user", "assistant"]);
const VALID_CHARACTER_TYPES = new Set(["player", "npc", "companion"]);

// ── Row → Record mappers ──────────────────────────────────────────

function toWorldRecord(row: typeof schema.worlds.$inferSelect): WorldRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    ...(row.lore != null ? { lore: row.lore } : {}),
    ...(row.tags != null ? { tags: row.tags } : {}),
    createdAt: row.createdAt,
  };
}

function toSessionRecord(row: typeof schema.sessions.$inferSelect): SessionRecord {
  const status = VALID_STATUSES.has(row.status) ? row.status as SessionRecord["status"] : "active" as const;
  const phase = VALID_PHASES.has(row.phase) ? row.phase as SessionRecord["phase"] : "init" as const;
  return {
    id: row.id,
    worldId: row.worldId,
    status,
    phase,
    ...(row.presetId != null ? { presetId: row.presetId } : {}),
    ...(row.settings != null ? { settings: row.settings } : {}),
    createdAt: row.createdAt,
  };
}

function toMessageRecord(row: typeof schema.messages.$inferSelect): MessageRecord {
  const role = VALID_ROLES.has(row.role) ? row.role as MessageRecord["role"] : "user" as const;
  return {
    id: row.id,
    sessionId: row.sessionId,
    role,
    content: row.content,
    ...(row.metadata != null ? { metadata: row.metadata } : {}),
    createdAt: row.createdAt,
  };
}

function toCharacterRecord(row: typeof schema.characters.$inferSelect): CharacterRecord {
  const type = VALID_CHARACTER_TYPES.has(row.type) ? row.type as CharacterRecord["type"] : "npc" as const;
  return {
    id: row.id,
    worldId: row.worldId,
    ...(row.sessionId != null ? { sessionId: row.sessionId } : {}),
    name: row.name,
    type,
    ...(row.description != null ? { description: row.description } : {}),
    ...(row.fields != null ? { fields: row.fields } : {}),
    ...(row.extensions != null ? { extensions: row.extensions } : {}),
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toEventRecord(row: typeof schema.events.$inferSelect): EventRecord {
  return {
    id: row.id,
    branchId: row.branchId,
    turnId: row.turnId,
    type: row.type,
    source: row.source,
    ...(row.locale != null ? { locale: row.locale } : {}),
    ...(row.payload != null ? { payload: row.payload } : {}),
    createdAt: row.createdAt,
  };
}

function toDomainRecord(row: typeof schema.domainRecords.$inferSelect): DomainRecord {
  return {
    id: row.id,
    branchId: row.branchId,
    kind: row.kind,
    key: row.key,
    value: row.value,
    ...(row.summary != null ? { summary: row.summary } : {}),
    ...(row.locale != null ? { locale: row.locale } : {}),
    updatedAt: row.updatedAt,
  };
}

function toSnapshotRecord(row: typeof schema.snapshots.$inferSelect): SnapshotRecord {
  return {
    id: row.id,
    branchId: row.branchId,
    turnId: row.turnId,
    ...(row.label != null ? { label: row.label } : {}),
    ...(row.summary != null ? { summary: row.summary } : {}),
    data: row.data,
    createdAt: row.createdAt,
  };
}
