/**
 * PostgreSQL-backed server store.
 *
 * Persistent data (worlds, sessions, messages, characters, trace events) is stored in PG.
 * State patches are also DB-backed.
 */
import { randomUUID } from "node:crypto";
import type { CharacterCard, CharacterCreateInput, I18nText, SessionPhase, WorldDimensions } from "@covel/shared";
import { humanId } from "human-id";
import { loadWorldPackages } from "./world-package-loader.js";
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

export interface PgServerStoreOptions {
  databaseUrl: string;
  worldsDir?: string;
}

export async function createPgServerStore(opts: PgServerStoreOptions): Promise<ServerStore> {
  const sql = pgClient(opts.databaseUrl);

  // Create tables
  await sql`
    CREATE TABLE IF NOT EXISTS sv_worlds (
      id TEXT PRIMARY KEY,
      name JSONB NOT NULL DEFAULT '""'::jsonb,
      description JSONB NOT NULL DEFAULT '""'::jsonb,
      lore JSONB,
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

  await sql`
    CREATE TABLE IF NOT EXISTS sv_state_patches (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      package_name TEXT NOT NULL DEFAULT '',
      data JSONB,
      created_at TEXT NOT NULL
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS sv_trace_events (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      request_id TEXT NOT NULL,
      trace_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      flow_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      timestamp TEXT NOT NULL,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS sv_state_snapshots (
      session_id TEXT PRIMARY KEY,
      data JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TEXT NOT NULL
    )
  `;

  // Indexes for common queries
  await sql`CREATE INDEX IF NOT EXISTS idx_sv_sessions_world ON sv_sessions(world_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_sv_messages_session ON sv_messages(session_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_sv_characters_run ON sv_characters(run_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_sv_state_patches_session ON sv_state_patches(session_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_sv_trace_events_session ON sv_trace_events(session_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_sv_trace_events_session_turn ON sv_trace_events(session_id, turn_id)`;

  // ── Migrate legacy TEXT columns to JSONB ─────────────────────────
  // Existing databases may have name/description/lore as TEXT; convert to JSONB.
  for (const col of ["name", "description", "lore"] as const) {
    const [info] = await sql<{ data_type: string }[]>`
      SELECT data_type FROM information_schema.columns
      WHERE table_name = 'sv_worlds' AND column_name = ${col}`;
    if (info && info.data_type === "text") {
      await sql.unsafe(
        `ALTER TABLE sv_worlds ALTER COLUMN ${col} TYPE JSONB USING to_jsonb(${col})`,
      );
    }
  }

  // ── Migrate: add columns added after initial schema ───────────────
  await sql`ALTER TABLE sv_worlds ADD COLUMN IF NOT EXISTS dimensions JSONB`;
  await sql`ALTER TABLE sv_worlds ADD COLUMN IF NOT EXISTS package_id TEXT`;

  // ── Worlds ──────────────────────────────────────────────────────

  async function listWorlds(): Promise<WorldRecord[]> {
    return worldCache.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async function createWorld(
    name: I18nText,
    description: I18nText,
    opts?: { id?: string; lore?: I18nText; locale?: string; tags?: string[]; dimensions?: WorldDimensions },
  ): Promise<WorldRecord> {
    const world: WorldRecord = {
      id: opts?.id ?? uid("world"),
      name,
      description,
      lore: opts?.lore,
      locale: opts?.locale,
      tags: opts?.tags,
      dimensions: opts?.dimensions,
      createdAt: new Date().toISOString(),
    };
    await persistWorld(world);
    worldCache.push(world);
    worldMap.set(world.id, world);
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
    await persistWorld(updated);
    worldMap.set(id, updated);
    const idx = worldCache.findIndex((w) => w.id === id);
    if (idx >= 0) worldCache[idx] = updated;
    return updated;
  }

  async function persistWorld(w: WorldRecord): Promise<void> {
    const nameJson = sql.json(w.name as JSONValue);
    const descJson = sql.json(w.description as JSONValue);
    const loreJson = w.lore != null ? sql.json(w.lore as JSONValue) : null;
    await sql`
      INSERT INTO sv_worlds (id, name, description, lore, locale, tags, dimensions, package_id, created_at, updated_at)
      VALUES (${w.id}, ${nameJson}, ${descJson}, ${loreJson}, ${w.locale ?? null},
              ${w.tags ? sql.json(w.tags as JSONValue) : null}, ${w.dimensions ? sql.json(w.dimensions as JSONValue) : null},
              ${w.packageId ?? null}, ${w.createdAt}, ${w.updatedAt ?? null})
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name, description = EXCLUDED.description,
        lore = EXCLUDED.lore, locale = EXCLUDED.locale,
        tags = EXCLUDED.tags, dimensions = EXCLUDED.dimensions,
        package_id = EXCLUDED.package_id,
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
    id?: string;
    worldId: string;
    presetId?: string;
    taskBindings?: Record<string, string>;
  }): Promise<SessionRecord> {
    const session: SessionRecord = {
      id: opts.id ?? humanSessionId(),
      worldId: opts.worldId,
      status: "active",
      phase: "init",
      presetId: opts.presetId,
      taskBindings: opts.taskBindings,
      createdAt: new Date().toISOString(),
    };
    await persistSession(session);
    sessionCache.push(session);
    sessionMap.set(session.id, session);
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
    await persistSession(updated);
    sessionMap.set(id, updated);
    const idx = sessionCache.findIndex((s) => s.id === id);
    if (idx >= 0) sessionCache[idx] = updated;
    return updated;
  }

  async function updateSessionPhase(id: string, phase: SessionPhase): Promise<SessionRecord | undefined> {
    return updateSession(id, { phase });
  }

  async function deleteSession(id: string): Promise<boolean> {
    const session = sessionMap.get(id);
    if (!session) return false;
    // Cascade delete all associated data
    await sql`DELETE FROM sv_messages WHERE session_id = ${id}`;
    await sql`DELETE FROM sv_state_patches WHERE session_id = ${id}`;
    await sql`DELETE FROM sv_characters WHERE run_id = ${id}`;
    await sql`DELETE FROM sv_trace_events WHERE session_id = ${id}`;
    await sql`DELETE FROM sv_state_snapshots WHERE session_id = ${id}`;
    await sql`DELETE FROM sv_sessions WHERE id = ${id}`;
    // Update cache
    sessionMap.delete(id);
    const idx = sessionCache.findIndex((s) => s.id === id);
    if (idx >= 0) sessionCache.splice(idx, 1);
    // Remove cached characters
    for (const [charId, card] of characterMap) {
      if (card.runId === id) characterMap.delete(charId);
    }
    return true;
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

  async function clearMessages(sessionId: string): Promise<void> {
    await sql`DELETE FROM sv_messages WHERE session_id = ${sessionId}`;
  }

  // ── State Patches (DB-backed) ───────────────────────────────────

  interface StatePatchRow {
    id: string;
    session_id: string;
    summary: string;
    package_name: string;
    data: unknown | null;
    created_at: string;
  }

  function rowToStatePatch(r: StatePatchRow): StatePatchRecord {
    return {
      id: r.id,
      sessionId: r.session_id,
      summary: r.summary,
      packageName: r.package_name,
      data: r.data ?? undefined,
      createdAt: r.created_at,
    };
  }

  async function listStatePatches(sessionId: string): Promise<StatePatchRecord[]> {
    const rows = await sql<StatePatchRow[]>`
      SELECT * FROM sv_state_patches WHERE session_id = ${sessionId} ORDER BY created_at
    `;
    return rows.map(rowToStatePatch);
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
    await sql`
      INSERT INTO sv_state_patches (id, session_id, summary, package_name, data, created_at)
      VALUES (${record.id}, ${record.sessionId}, ${record.summary}, ${record.packageName},
              ${record.data !== undefined ? sql.json(record.data as JSONValue) : null}, ${record.createdAt})
    `;
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
    await persistCharacter(card);
    characterMap.set(card.id, card);
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
    await persistCharacter(updated);
    characterMap.set(id, updated);
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

  // ── Trace Events (DB-backed) ─────────────────────────────────────

  interface TraceEventRow {
    id: string;
    type: string;
    request_id: string;
    trace_id: string;
    session_id: string;
    turn_id: string;
    flow_id: string;
    seq: number;
    timestamp: string;
    payload: Record<string, unknown>;
  }

  function rowToTraceEvent(r: TraceEventRow): TraceEvent {
    return {
      type: r.type,
      requestId: r.request_id,
      traceId: r.trace_id,
      sessionId: r.session_id,
      turnId: r.turn_id,
      flowId: r.flow_id,
      seq: r.seq,
      timestamp: r.timestamp,
      payload: r.payload,
    };
  }

  async function addTraceEvent(_sessionId: string, event: TraceEvent): Promise<void> {
    const id = `te_${randomUUID()}`;
    await sql`
      INSERT INTO sv_trace_events (id, type, request_id, trace_id, session_id, turn_id, flow_id, seq, timestamp, payload)
      VALUES (${id}, ${event.type}, ${event.requestId}, ${event.traceId},
              ${event.sessionId}, ${event.turnId}, ${event.flowId}, ${event.seq},
              ${event.timestamp}, ${sql.json(event.payload as JSONValue)})
    `;
  }

  async function listTraceEvents(sessionId: string): Promise<TraceEvent[]> {
    const rows = await sql<TraceEventRow[]>`
      SELECT * FROM sv_trace_events
      WHERE session_id = ${sessionId}
      ORDER BY timestamp ASC, seq ASC
    `;
    return rows.map(rowToTraceEvent);
  }

  // ── State Snapshots (DB-backed) ──────────────────────────────────

  async function saveStateSnapshot(sessionId: string, snapshot: Record<string, unknown>): Promise<void> {
    const now = new Date().toISOString();
    await sql`
      INSERT INTO sv_state_snapshots (session_id, data, updated_at)
      VALUES (${sessionId}, ${sql.json(snapshot as JSONValue)}, ${now})
      ON CONFLICT (session_id) DO UPDATE SET
        data = EXCLUDED.data, updated_at = EXCLUDED.updated_at
    `;
  }

  async function getStateSnapshot(sessionId: string): Promise<Record<string, unknown> | null> {
    const rows = await sql<{ data: Record<string, unknown> }[]>`
      SELECT data FROM sv_state_snapshots WHERE session_id = ${sessionId}
    `;
    return rows.length > 0 ? rows[0].data : null;
  }

  // ── Load existing data from PG into cache ───────────────────────

  interface WorldRow {
    id: string; name: I18nText; description: I18nText;
    lore: I18nText | null; locale: string | null;
    tags: string[] | null; dimensions: WorldDimensions | null;
    package_id: string | null;
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
    packageId: r.package_id ?? undefined,
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

  // ── Upsert world packages (always, so dimensions stay current) ────
  // Uses stable IDs (world_<packageId>) so re-runs are idempotent.

  if (opts.worldsDir) {
    const seeds = await loadWorldPackages(opts.worldsDir);
    for (const seed of seeds) {
      const now = new Date().toISOString();
      const nameJson = sql.json(seed.name as JSONValue);
      const descJson = sql.json(seed.description as JSONValue);
      const loreJson = seed.lore != null ? sql.json(seed.lore as JSONValue) : null;
      await sql`
        INSERT INTO sv_worlds (id, name, description, lore, locale, tags, dimensions, package_id, created_at)
        VALUES (
          ${seed.id}, ${nameJson}, ${descJson}, ${loreJson},
          ${seed.locale ?? null}, ${seed.tags ? sql.json(seed.tags as JSONValue) : null},
          ${seed.dimensions ? sql.json(seed.dimensions as JSONValue) : null},
          ${seed.packageId ?? null}, ${now}
        )
        ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name,
          description = EXCLUDED.description,
          dimensions = EXCLUDED.dimensions,
          lore = EXCLUDED.lore,
          tags = EXCLUDED.tags,
          package_id = EXCLUDED.package_id,
          updated_at = ${now}
      `;
      if (worldMap.has(seed.id)) {
        const existing = worldMap.get(seed.id)!;
        existing.dimensions = seed.dimensions;
        existing.lore = seed.lore;
        existing.tags = seed.tags;
      } else {
        const world: WorldRecord = {
          id: seed.id,
          packageId: seed.packageId,
          name: seed.name,
          description: seed.description,
          lore: seed.lore,
          locale: seed.locale,
          tags: seed.tags,
          dimensions: seed.dimensions,
          createdAt: now,
        };
        worldCache.push(world);
        worldMap.set(world.id, world);
      }
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
    deleteSession,
    listMessages,
    addMessage,
    clearMessages,
    listStatePatches,
    addStatePatch,
    createCharacter,
    getCharacter,
    getSessionCharacters,
    updateCharacter,
    addTraceEvent,
    listTraceEvents,
    saveStateSnapshot,
    getStateSnapshot,
  };
}
