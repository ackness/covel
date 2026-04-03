/**
 * PostgreSQL-backed server store.
 *
 * Persistent data (worlds, sessions, messages, characters) is stored in PG.
 * Ephemeral data (state patches, trace events) remains in memory.
 */
import { randomUUID } from "node:crypto";
import type { CharacterCard, CharacterCreateInput, SessionPhase, WorldDimensions } from "@covel/shared";
import { humanId } from "human-id";
import { SEED_WORLDS } from "./seed-worlds.js";
import type {
  ServerStore,
  WorldRecord,
  SessionRecord,
  MessageRecord,
  StatePatchRecord,
  TraceEvent,
} from "./types.js";
import pgClient, { type JSONValue } from "postgres";

function uid(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

function humanSessionId(): string {
  const words = humanId({ separator: "-", capitalize: false });
  const hex = Math.random().toString(16).slice(2, 6);
  return `${words}-${hex}`;
}

const MAX_TRACE_EVENTS_PER_SESSION = 2000;

export interface PgServerStoreOptions {
  databaseUrl: string;
}

export async function createPgServerStore(opts: PgServerStoreOptions): Promise<ServerStore> {
  const sql = pgClient(opts.databaseUrl);

  // Create tables
  await sql`
    CREATE TABLE IF NOT EXISTS sv_worlds (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      lore TEXT,
      locale TEXT,
      tags JSONB,
      dimensions JSONB,
      created_at TEXT NOT NULL,
      updated_at TEXT
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS sv_sessions (
      id TEXT PRIMARY KEY,
      world_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      phase TEXT NOT NULL DEFAULT 'init',
      preset_id TEXT,
      task_bindings JSONB,
      created_at TEXT NOT NULL
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS sv_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      turn_id TEXT,
      runtime_id TEXT,
      block JSONB,
      created_at TEXT NOT NULL
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS sv_characters (
      id TEXT PRIMARY KEY,
      world_id TEXT NOT NULL,
      run_id TEXT,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'player',
      description TEXT NOT NULL DEFAULT '',
      portrait TEXT,
      fields JSONB NOT NULL DEFAULT '{}'::jsonb,
      extensions JSONB NOT NULL DEFAULT '{}'::jsonb,
      version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT
    )
  `;

  // Indexes for common queries
  await sql`CREATE INDEX IF NOT EXISTS idx_sv_sessions_world ON sv_sessions(world_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_sv_messages_session ON sv_messages(session_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_sv_characters_run ON sv_characters(run_id)`;

  // In-memory ephemeral stores
  const statePatches = new Map<string, StatePatchRecord[]>();
  const traceEvents = new Map<string, TraceEvent[]>();

  // ── Worlds ──────────────────────────────────────────────────────

  async function listWorlds(): Promise<WorldRecord[]> {
    return worldCache.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async function createWorld(
    name: string,
    description: string,
    opts?: { lore?: string; locale?: string; tags?: string[]; dimensions?: WorldDimensions },
  ): Promise<WorldRecord> {
    const world: WorldRecord = {
      id: uid("world"),
      name,
      description,
      lore: opts?.lore,
      locale: opts?.locale,
      tags: opts?.tags,
      dimensions: opts?.dimensions,
      createdAt: new Date().toISOString(),
    };
    worldCache.push(world);
    worldMap.set(world.id, world);
    await persistWorld(world);
    return world;
  }

  async function getWorld(id: string): Promise<WorldRecord | undefined> {
    return worldMap.get(id);
  }

  async function updateWorld(
    id: string,
    patch: Partial<Omit<WorldRecord, "id" | "createdAt">>,
  ): Promise<WorldRecord | undefined> {
    const world = worldMap.get(id);
    if (!world) return undefined;
    const updated: WorldRecord = {
      ...world,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    worldMap.set(id, updated);
    const idx = worldCache.findIndex((w) => w.id === id);
    if (idx >= 0) worldCache[idx] = updated;
    await persistWorld(updated);
    return updated;
  }

  async function persistWorld(w: WorldRecord): Promise<void> {
    await sql`
      INSERT INTO sv_worlds (id, name, description, lore, locale, tags, dimensions, created_at, updated_at)
      VALUES (${w.id}, ${w.name}, ${w.description}, ${w.lore ?? null}, ${w.locale ?? null},
              ${w.tags ? sql.json(w.tags as JSONValue) : null}, ${w.dimensions ? sql.json(w.dimensions as JSONValue) : null},
              ${w.createdAt}, ${w.updatedAt ?? null})
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name, description = EXCLUDED.description,
        lore = EXCLUDED.lore, locale = EXCLUDED.locale,
        tags = EXCLUDED.tags, dimensions = EXCLUDED.dimensions,
        updated_at = EXCLUDED.updated_at
    `;
  }

  // ── Sessions ────────────────────────────────────────────────────

  async function listSessions(worldId: string): Promise<SessionRecord[]> {
    return sessionCache
      .filter((s) => s.worldId === worldId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async function createSession(opts: {
    worldId: string;
    presetId?: string;
    taskBindings?: Record<string, string>;
  }): Promise<SessionRecord> {
    const session: SessionRecord = {
      id: humanSessionId(),
      worldId: opts.worldId,
      status: "active",
      phase: "init",
      presetId: opts.presetId,
      taskBindings: opts.taskBindings,
      createdAt: new Date().toISOString(),
    };
    sessionCache.push(session);
    sessionMap.set(session.id, session);
    await persistSession(session);
    return session;
  }

  async function getSession(id: string): Promise<SessionRecord | undefined> {
    return sessionMap.get(id);
  }

  async function updateSession(
    id: string,
    patch: Partial<Pick<SessionRecord, "status" | "phase" | "presetId" | "taskBindings">>,
  ): Promise<SessionRecord | undefined> {
    const session = sessionMap.get(id);
    if (!session) return undefined;
    const validPatch: Partial<SessionRecord> = {};
    if (patch.status !== undefined) validPatch.status = patch.status;
    if (patch.phase !== undefined) validPatch.phase = patch.phase;
    if (patch.presetId !== undefined) validPatch.presetId = patch.presetId;
    if (patch.taskBindings !== undefined) validPatch.taskBindings = patch.taskBindings;
    const updated = { ...session, ...validPatch };
    sessionMap.set(id, updated);
    const idx = sessionCache.findIndex((s) => s.id === id);
    if (idx >= 0) sessionCache[idx] = updated;
    await persistSession(updated);
    return updated;
  }

  async function updateSessionPhase(id: string, phase: SessionPhase): Promise<SessionRecord | undefined> {
    return updateSession(id, { phase });
  }

  async function persistSession(s: SessionRecord): Promise<void> {
    await sql`
      INSERT INTO sv_sessions (id, world_id, status, phase, preset_id, task_bindings, created_at)
      VALUES (${s.id}, ${s.worldId}, ${s.status}, ${s.phase}, ${s.presetId ?? null},
              ${s.taskBindings ? sql.json(s.taskBindings as JSONValue) : null}, ${s.createdAt})
      ON CONFLICT (id) DO UPDATE SET
        status = EXCLUDED.status, phase = EXCLUDED.phase,
        preset_id = EXCLUDED.preset_id, task_bindings = EXCLUDED.task_bindings
    `;
  }

  // ── Messages (DB-backed, no in-memory cache) ───────────────────

  // Raw row type matching PG snake_case columns
  interface MessageRow {
    id: string; session_id: string; role: string; content: string;
    turn_id: string | null; runtime_id: string | null;
    block: Record<string, unknown> | null; created_at: string;
  }

  function rowToMessage(r: MessageRow): MessageRecord {
    return {
      id: r.id,
      sessionId: r.session_id,
      role: r.role as MessageRecord["role"],
      content: r.content,
      turnId: r.turn_id ?? undefined,
      runtimeId: r.runtime_id ?? undefined,
      block: r.block ?? undefined,
      createdAt: r.created_at,
    };
  }

  async function listMessages(sessionId: string): Promise<MessageRecord[]> {
    const rows = await sql<MessageRow[]>`
      SELECT * FROM sv_messages WHERE session_id = ${sessionId} ORDER BY created_at
    `;
    return rows.map(rowToMessage);
  }

  async function addMessage(
    sessionId: string,
    role: MessageRecord["role"],
    content: string,
    meta?: { turnId?: string; runtimeId?: string; block?: Record<string, unknown> },
  ): Promise<MessageRecord> {
    const msg: MessageRecord = {
      id: uid("msg"),
      sessionId,
      role,
      content,
      ...(meta?.turnId ? { turnId: meta.turnId } : {}),
      ...(meta?.runtimeId ? { runtimeId: meta.runtimeId } : {}),
      ...(meta?.block ? { block: meta.block } : {}),
      createdAt: new Date().toISOString(),
    };
    await persistMessage(msg);
    return msg;
  }

  async function persistMessage(m: MessageRecord): Promise<void> {
    await sql`
      INSERT INTO sv_messages (id, session_id, role, content, turn_id, runtime_id, block, created_at)
      VALUES (${m.id}, ${m.sessionId}, ${m.role}, ${m.content},
              ${m.turnId ?? null}, ${m.runtimeId ?? null},
              ${m.block ? sql.json(m.block as JSONValue) : null}, ${m.createdAt})
    `;
  }

  // ── State Patches (in-memory) ──────────────────────────────────

  async function listStatePatches(sessionId: string): Promise<StatePatchRecord[]> {
    return statePatches.get(sessionId) ?? [];
  }

  async function addStatePatch(
    sessionId: string,
    patch: { id: string; summary: string; packageName: string; data?: unknown },
  ): Promise<StatePatchRecord> {
    const record: StatePatchRecord = {
      id: patch.id,
      sessionId,
      summary: patch.summary,
      packageName: patch.packageName,
      data: patch.data,
      createdAt: new Date().toISOString(),
    };
    const list = statePatches.get(sessionId) ?? [];
    statePatches.set(sessionId, [...list, record]);
    return record;
  }

  // ── Characters ──────────────────────────────────────────────────

  async function createCharacter(sessionId: string, input: CharacterCreateInput): Promise<CharacterCard> {
    const session = sessionMap.get(sessionId);
    if (!session) throw new Error("Session not found: " + sessionId);
    const card: CharacterCard = {
      id: uid("char"),
      worldId: session.worldId,
      runId: sessionId,
      name: input.name,
      type: input.type ?? "player",
      description: input.description ?? "",
      fields: input.fields ?? {},
      extensions: {},
      createdAt: new Date().toISOString(),
      version: 1,
    };
    characterMap.set(card.id, card);
    await persistCharacter(card);
    return card;
  }

  async function getCharacter(id: string): Promise<CharacterCard | undefined> {
    return characterMap.get(id);
  }

  async function getSessionCharacters(sessionId: string): Promise<CharacterCard[]> {
    return Array.from(characterMap.values()).filter((c) => c.runId === sessionId);
  }

  async function updateCharacter(id: string, patch: Partial<CharacterCard>): Promise<CharacterCard | undefined> {
    const card = characterMap.get(id);
    if (!card) return undefined;
    const updated: CharacterCard = {
      ...card,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.type !== undefined ? { type: patch.type } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.portrait !== undefined ? { portrait: patch.portrait } : {}),
      ...(patch.fields !== undefined ? { fields: patch.fields } : {}),
      ...(patch.extensions !== undefined ? { extensions: patch.extensions } : {}),
      version: card.version + 1,
    };
    characterMap.set(id, updated);
    await persistCharacter(updated);
    return updated;
  }

  async function persistCharacter(c: CharacterCard): Promise<void> {
    const now = new Date().toISOString();
    await sql`
      INSERT INTO sv_characters (id, world_id, run_id, name, type, description, portrait, fields, extensions, version, created_at, updated_at)
      VALUES (${c.id}, ${c.worldId}, ${c.runId ?? null}, ${c.name}, ${c.type},
              ${c.description ?? ""}, ${c.portrait ?? null},
              ${sql.json((c.fields ?? {}) as JSONValue)}, ${sql.json((c.extensions ?? {}) as JSONValue)},
              ${c.version}, ${c.createdAt}, ${now})
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name, type = EXCLUDED.type, description = EXCLUDED.description,
        portrait = EXCLUDED.portrait, fields = EXCLUDED.fields, extensions = EXCLUDED.extensions,
        version = EXCLUDED.version, updated_at = EXCLUDED.updated_at
    `;
  }

  // ── Trace Events (in-memory) ────────────────────────────────────

  async function addTraceEvent(sessionId: string, event: TraceEvent): Promise<void> {
    const list = traceEvents.get(sessionId) ?? [];
    const updated = [...list, event];
    traceEvents.set(sessionId, updated.length > MAX_TRACE_EVENTS_PER_SESSION
      ? updated.slice(-MAX_TRACE_EVENTS_PER_SESSION)
      : updated);
  }

  async function listTraceEvents(sessionId: string): Promise<TraceEvent[]> {
    return traceEvents.get(sessionId) ?? [];
  }

  // ── Load existing data from PG into cache ───────────────────────

  interface WorldRow {
    id: string; name: string; description: string;
    lore: string | null; locale: string | null;
    tags: string[] | null; dimensions: WorldDimensions | null;
    created_at: string; updated_at: string | null;
  }
  interface SessionRow {
    id: string; world_id: string; status: string; phase: string;
    preset_id: string | null; task_bindings: Record<string, string> | null;
    created_at: string;
  }
  interface CharacterRow {
    id: string; world_id: string; run_id: string | null;
    name: string; type: string; description: string;
    portrait: string | null; fields: Record<string, unknown>;
    extensions: Record<string, unknown>; version: number; created_at: string;
  }

  const worldRows = await sql<WorldRow[]>`SELECT * FROM sv_worlds`;
  const worldCache: WorldRecord[] = worldRows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    lore: r.lore ?? undefined,
    locale: r.locale ?? undefined,
    tags: r.tags ?? undefined,
    dimensions: r.dimensions ?? undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at ?? undefined,
  }));
  const worldMap = new Map<string, WorldRecord>(worldCache.map((w) => [w.id, w]));

  const sessionRows = await sql<SessionRow[]>`SELECT * FROM sv_sessions`;
  const sessionCache: SessionRecord[] = sessionRows.map((r) => ({
    id: r.id,
    worldId: r.world_id,
    status: r.status as SessionRecord["status"],
    phase: r.phase as SessionRecord["phase"],
    presetId: r.preset_id ?? undefined,
    taskBindings: r.task_bindings ?? undefined,
    createdAt: r.created_at,
  }));
  const sessionMap = new Map<string, SessionRecord>(sessionCache.map((s) => [s.id, s]));

  // Messages are now loaded lazily per session via listMessages() — no startup cache.

  const charRows = await sql<CharacterRow[]>`SELECT * FROM sv_characters`;
  const characterMap = new Map<string, CharacterCard>();
  for (const r of charRows) {
    const card: CharacterCard = {
      id: r.id,
      worldId: r.world_id,
      runId: r.run_id ?? "",
      name: r.name,
      type: r.type as CharacterCard["type"],
      description: r.description ?? "",
      portrait: r.portrait ?? undefined,
      fields: r.fields ?? {},
      extensions: r.extensions ?? {},
      version: r.version ?? 1,
      createdAt: r.created_at,
    };
    characterMap.set(card.id, card);
  }

  // ── Seed worlds if DB is empty ──────────────────────────────────

  if (worldCache.length === 0) {
    for (const seed of SEED_WORLDS) {
      await createWorld(seed.name, seed.description, {
        lore: seed.lore,
        locale: seed.locale,
        tags: seed.tags,
        dimensions: seed.dimensions,
      });
    }
  }

  return {
    listWorlds,
    createWorld,
    getWorld,
    updateWorld,
    listSessions,
    createSession,
    getSession,
    updateSession,
    updateSessionPhase,
    listMessages,
    addMessage,
    listStatePatches,
    addStatePatch,
    createCharacter,
    getCharacter,
    getSessionCharacters,
    updateCharacter,
    addTraceEvent,
    listTraceEvents,
  };
}
