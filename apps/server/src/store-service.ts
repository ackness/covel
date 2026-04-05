/**
 * StoreService — thin adapter that wraps a DataStore (from @covel/store)
 * with the high-level API that server routes expect (ServerStore-compatible).
 *
 * This enables a single `STORE_BACKEND` env var to switch between
 * memory / indexeddb / postgres for ALL storage.
 */
import { randomUUID } from "node:crypto";
import { humanId } from "human-id";
import type {
  DataStore,
  WorldRecord,
  SessionRecord,
  MessageRecord,
  TraceEventRecord,
  StatePatchRecord,
  StateSnapshotRecord,
} from "@covel/store";
import type {
  CharacterCard,
  CharacterCreateInput,
  I18nText,
  SessionPhase,
  WorldDimensions,
} from "@covel/shared";

// ── ID generation helpers ────────────────────────────────────────

function uid(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

function humanSessionId(): string {
  const words = humanId({ separator: "-", capitalize: false });
  const hex = Math.random().toString(16).slice(2, 6);
  return `${words}-${hex}`;
}

// ── StoreService interface ───────────────────────────────────────

/** High-level server store API backed by a DataStore. */
export interface StoreService {
  /** Access the underlying low-level DataStore (for bulk ops, export/import). */
  readonly dataStore: DataStore;

  // Worlds
  listWorlds(): Promise<WorldRecord[]>;
  createWorld(
    name: I18nText,
    description: I18nText,
    opts?: { id?: string; lore?: I18nText; locale?: string; tags?: string[]; dimensions?: WorldDimensions },
  ): Promise<WorldRecord>;
  getWorld(id: string): Promise<WorldRecord | undefined>;
  updateWorld(
    id: string,
    patch: Partial<Omit<WorldRecord, "id" | "createdAt">>,
  ): Promise<WorldRecord | undefined>;

  // Sessions
  listSessions(worldId: string): Promise<SessionRecord[]>;
  createSession(opts: {
    id?: string;
    worldId: string;
    presetId?: string;
    taskBindings?: Record<string, string>;
  }): Promise<SessionRecord>;
  getSession(id: string): Promise<SessionRecord | undefined>;
  updateSession(
    id: string,
    patch: Partial<Pick<SessionRecord, "status" | "phase" | "presetId"> & { taskBindings?: Record<string, string> }>,
  ): Promise<SessionRecord | undefined>;
  updateSessionPhase(id: string, phase: SessionPhase): Promise<SessionRecord | undefined>;
  deleteSession(id: string): Promise<boolean>;

  // Messages
  listMessages(sessionId: string): Promise<MessageRecord[]>;
  addMessage(
    sessionId: string,
    role: MessageRecord["role"],
    content: string,
    meta?: { turnId?: string; runtimeId?: string; kind?: string; block?: Record<string, unknown> },
  ): Promise<MessageRecord>;
  clearMessages(sessionId: string): Promise<void>;

  // State Patches
  listStatePatches(sessionId: string): Promise<StatePatchRecord[]>;
  addStatePatch(
    sessionId: string,
    patch: { id: string; summary: string; packageName: string; data?: unknown },
  ): Promise<StatePatchRecord>;

  // Characters
  createCharacter(sessionId: string, input: CharacterCreateInput): Promise<CharacterCard>;
  getCharacter(id: string): Promise<CharacterCard | undefined>;
  getSessionCharacters(sessionId: string): Promise<CharacterCard[]>;
  updateCharacter(id: string, patch: Partial<CharacterCard>): Promise<CharacterCard | undefined>;

  // Trace Events
  addTraceEvent(sessionId: string, event: {
    type: string;
    requestId: string;
    traceId: string;
    turnId: string;
    flowId: string;
    seq: number;
    timestamp?: string;
    payload: Record<string, unknown>;
  }): Promise<void>;
  listTraceEvents(sessionId: string): Promise<TraceEventRecord[]>;

  // State Snapshots
  saveStateSnapshot(sessionId: string, snapshot: Record<string, unknown>): Promise<void>;
  getStateSnapshot(sessionId: string): Promise<Record<string, unknown> | null>;
}

// ── Implementation ───────────────────────────────────────────────

export function createStoreService(store: DataStore): StoreService {
  const now = () => new Date().toISOString();

  return {
    dataStore: store,

    // ── Worlds ─────────────────────────────────────────────────

    async listWorlds() {
      return store.listWorlds();
    },

    async createWorld(name, description, opts) {
      const world: WorldRecord = {
        id: opts?.id ?? uid("world"),
        name,
        description,
        ...(opts?.lore != null ? { lore: opts.lore } : {}),
        ...(opts?.locale != null ? { locale: opts.locale } : {}),
        ...(opts?.tags != null ? { tags: opts.tags } : {}),
        ...(opts?.dimensions != null ? { dimensions: opts.dimensions } : {}),
        createdAt: now(),
      };
      await store.upsertWorld(world);
      return world;
    },

    async getWorld(id) {
      return (await store.getWorld(id)) ?? undefined;
    },

    async updateWorld(id, patch) {
      const existing = await store.getWorld(id);
      if (!existing) return undefined;
      const updated: WorldRecord = { ...existing, ...patch };
      await store.upsertWorld(updated);
      return updated;
    },

    // ── Sessions ───────────────────────────────────────────────

    async listSessions(worldId) {
      return store.listSessions(worldId);
    },

    async createSession(opts) {
      const session: SessionRecord = {
        id: opts.id ?? humanSessionId(),
        worldId: opts.worldId,
        status: "active",
        phase: "init",
        ...(opts.presetId != null ? { presetId: opts.presetId } : {}),
        ...(opts.taskBindings != null ? { taskBindings: opts.taskBindings } : {}),
        createdAt: now(),
      };
      await store.upsertSession(session);
      return session;
    },

    async getSession(id) {
      return (await store.getSession(id)) ?? undefined;
    },

    async updateSession(id, patch) {
      const existing = await store.getSession(id);
      if (!existing) return undefined;
      const updated: SessionRecord = { ...existing, ...patch };
      await store.upsertSession(updated);
      return updated;
    },

    async updateSessionPhase(id, phase) {
      const existing = await store.getSession(id);
      if (!existing) return undefined;
      const updated: SessionRecord = { ...existing, phase };
      await store.upsertSession(updated);
      return updated;
    },

    async deleteSession(id) {
      const existing = await store.getSession(id);
      if (!existing) return false;
      // Clean up associated data
      await store.clearMessages(id);
      await store.deleteSession(id);
      return true;
    },

    // ── Messages ───────────────────────────────────────────────

    async listMessages(sessionId) {
      return store.listMessages(sessionId);
    },

    async addMessage(sessionId, role, content, meta) {
      const msg: MessageRecord = {
        id: uid("msg"),
        sessionId,
        role,
        content,
        ...(meta != null
          ? {
              metadata: {
                ...(meta.turnId != null ? { turnId: meta.turnId } : {}),
                ...(meta.runtimeId != null ? { runtimeId: meta.runtimeId } : {}),
                ...(meta.kind != null ? { kind: meta.kind } : {}),
                ...(meta.block != null ? { block: meta.block } : {}),
              },
            }
          : {}),
        createdAt: now(),
      };
      await store.addMessage(msg);
      return msg;
    },

    async clearMessages(sessionId) {
      await store.clearMessages(sessionId);
    },

    // ── State Patches ──────────────────────────────────────────

    async listStatePatches(sessionId) {
      return store.listStatePatches(sessionId);
    },

    async addStatePatch(sessionId, patch) {
      const record: StatePatchRecord = {
        id: patch.id,
        sessionId,
        summary: patch.summary,
        packageName: patch.packageName,
        ...(patch.data != null ? { data: patch.data } : {}),
        createdAt: now(),
      };
      await store.addStatePatch(record);
      return record;
    },

    // ── Characters ─────────────────────────────────────────────

    async createCharacter(sessionId, input) {
      const id = uid("char");
      const ts = now();
      const card: CharacterCard = {
        id,
        worldId: "", // Resolved by caller or from session
        runId: "",
        name: input.name,
        type: input.type ?? "npc",
        description: input.description ?? "",
        fields: input.fields ?? {},
        extensions: {},
        createdAt: ts,
        version: 1,
      };
      // Store as CharacterRecord
      await store.upsertCharacter({
        id,
        worldId: card.worldId,
        sessionId,
        name: card.name,
        type: card.type,
        description: card.description,
        fields: card.fields,
        extensions: card.extensions,
        version: card.version,
        createdAt: ts,
        updatedAt: ts,
      });
      return card;
    },

    async getCharacter(id) {
      const chars = await store.listCharacters();
      const found = chars.find((c) => c.id === id);
      if (!found) return undefined;
      return toCharacterCard(found);
    },

    async getSessionCharacters(sessionId) {
      const chars = await store.listCharacters(sessionId);
      return chars.map(toCharacterCard);
    },

    async updateCharacter(id, patch) {
      const chars = await store.listCharacters();
      const existing = chars.find((c) => c.id === id);
      if (!existing) return undefined;
      const updated = {
        ...existing,
        ...(patch.name != null ? { name: patch.name } : {}),
        ...(patch.type != null ? { type: patch.type } : {}),
        ...(patch.description != null ? { description: patch.description } : {}),
        ...(patch.fields != null ? { fields: patch.fields } : {}),
        ...(patch.extensions != null ? { extensions: patch.extensions } : {}),
        version: existing.version + 1,
        updatedAt: now(),
      };
      await store.upsertCharacter(updated);
      return toCharacterCard(updated);
    },

    // ── Trace Events ───────────────────────────────────────────

    async addTraceEvent(sessionId, event) {
      await store.addTraceEvent({
        id: uid("trace"),
        sessionId,
        type: event.type,
        requestId: event.requestId,
        traceId: event.traceId,
        turnId: event.turnId,
        flowId: event.flowId,
        seq: event.seq,
        payload: event.payload,
        createdAt: event.timestamp ?? now(),
      });
    },

    async listTraceEvents(sessionId) {
      return store.listTraceEvents(sessionId);
    },

    // ── State Snapshots ────────────────────────────────────────

    async saveStateSnapshot(sessionId, snapshot) {
      await store.saveStateSnapshot({
        id: uid("ss"),
        sessionId,
        data: snapshot,
        createdAt: now(),
      });
    },

    async getStateSnapshot(sessionId) {
      const snap = await store.getStateSnapshot(sessionId);
      return snap?.data ?? null;
    },
  };
}

// ── Helper: CharacterRecord → CharacterCard ──────────────────────

function toCharacterCard(rec: {
  id: string;
  worldId: string;
  sessionId?: string;
  name: string;
  type: string;
  description?: string;
  fields?: Record<string, unknown>;
  extensions?: Record<string, unknown>;
  version: number;
  createdAt: string;
}): CharacterCard {
  return {
    id: rec.id,
    worldId: rec.worldId,
    runId: rec.sessionId ?? "",
    name: rec.name,
    type: rec.type as CharacterCard["type"],
    description: rec.description ?? "",
    fields: rec.fields ?? {},
    extensions: rec.extensions ?? {},
    createdAt: rec.createdAt,
    version: rec.version,
  };
}
