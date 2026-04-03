/**
 * DataService — abstraction for game data CRUD operations.
 *
 * Two implementations:
 *   - RemoteDataService: delegates to server API (T3 commercial)
 *   - LocalDataService:  uses IndexedDB in-browser (T1/T2 self-deploy / demo)
 *
 * LLM execution, config, and plugin APIs always go through the server
 * regardless of storage mode.
 */

import type { WorldDimensions } from "@covel/shared";
import type {
  WorldRecord,
  SessionRecord,
  MessageRecord,
  StatePatchRecord,
  SessionPhase,
} from "./api.js";
import * as api from "./api.js";

// ── Interface ─────────────────────────────────────────────────────

export interface DataService {
  // Worlds
  listWorlds(): Promise<WorldRecord[]>;
  getWorld(id: string): Promise<WorldRecord | null>;
  createWorld(name: string, description: string): Promise<WorldRecord>;
  updateWorld(
    id: string,
    patch: Partial<Pick<WorldRecord, "name" | "description" | "lore" | "locale" | "tags" | "dimensions">>,
  ): Promise<WorldRecord>;

  // Sessions
  listSessions(worldId: string): Promise<SessionRecord[]>;
  getSession(sessionId: string): Promise<SessionRecord | null>;
  createSession(worldId: string, presetId?: string): Promise<SessionRecord>;
  updateSession(
    sessionId: string,
    updates: Partial<Pick<SessionRecord, "status" | "presetId">>,
  ): Promise<SessionRecord>;

  // Messages
  listMessages(sessionId: string): Promise<MessageRecord[]>;
  addMessage(msg: MessageRecord): Promise<void>;

  // State patches (ephemeral — only in-memory for local mode)
  listStatePatches(sessionId: string): Promise<StatePatchRecord[]>;

  /**
   * Sync session context to server MemoryStore before sending actions.
   * In remote mode this is a no-op. In local mode it pushes
   * world + session + messages so the stateless server can process the turn.
   */
  syncToServer(sessionId: string): Promise<void>;
}

// ── Storage mode ──────────────────────────────────────────────────

const STORAGE_MODE_KEY = "covel:storageMode";

export type StorageMode = "local" | "remote";

export function getStorageMode(): StorageMode {
  const val = localStorage.getItem(STORAGE_MODE_KEY);
  return val === "remote" ? "remote" : "local";
}

export function setStorageMode(mode: StorageMode): void {
  localStorage.setItem(STORAGE_MODE_KEY, mode);
}

// ── Remote implementation ─────────────────────────────────────────

class RemoteDataService implements DataService {
  async listWorlds() {
    return api.listWorlds();
  }
  async getWorld(id: string) {
    try {
      return await api.getWorld(id);
    } catch {
      return null;
    }
  }
  async createWorld(name: string, description: string) {
    return api.createWorld(name, description);
  }
  async updateWorld(
    id: string,
    patch: Partial<Pick<WorldRecord, "name" | "description" | "lore" | "locale" | "tags" | "dimensions">>,
  ) {
    return api.updateWorld(id, patch);
  }

  async listSessions(worldId: string) {
    return api.listSessions(worldId);
  }
  async getSession(sessionId: string) {
    try {
      return await api.getSession(sessionId);
    } catch {
      return null;
    }
  }
  async createSession(worldId: string, presetId?: string) {
    return api.createSession(worldId, presetId);
  }
  async updateSession(
    sessionId: string,
    updates: Partial<Pick<SessionRecord, "status" | "presetId">>,
  ) {
    return api.updateSession(sessionId, updates);
  }

  async listMessages(sessionId: string) {
    return api.listMessages(sessionId);
  }
  async addMessage(_msg: MessageRecord) {
    // Remote mode: server stores messages during action SSE flow
  }

  async listStatePatches(sessionId: string) {
    return api.listStatePatches(sessionId);
  }

  async syncToServer() {
    // No-op: server already has the data
  }
}

// ── Local implementation (IndexedDB) ──────────────────────────────

function uid(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function humanSessionId(): string {
  const words = [
    "brave", "calm", "dark", "eager", "fair", "glad", "keen", "mild",
    "noble", "pure", "rare", "sage", "true", "vast", "warm", "wise",
  ];
  const nouns = [
    "dawn", "dusk", "fire", "gale", "haze", "lake", "moon", "rain",
    "snow", "star", "tide", "vale", "wave", "wind", "wood", "glow",
  ];
  const pick = (arr: string[]) => arr[Math.floor(Math.random() * arr.length)];
  const hex = Math.random().toString(16).slice(2, 6);
  return `${pick(words)}-${pick(nouns)}-${pick(words)}-${hex}`;
}

/** Minimal seed worlds for first-time local mode users. */
const LOCAL_SEED_WORLDS = [
  {
    name: "雾港・裂潮纪",
    description: "一座被永恒浓雾包裹的港口城市。潮汐带来远古遗物，也带来危险。",
    tags: ["港", "雾", "冒险"],
  },
  {
    name: "霓虹脊・2087",
    description: "赛博朋克都市，义体改造与数据黑市交织的霓虹丛林。",
    tags: ["赛博朋克", "义体", "黑客"],
  },
  {
    name: "九州・云梦泽",
    description: "修仙世界，灵脉纵横，宗门林立，一场席卷九州的劫变正在酝酿。",
    tags: ["修仙", "仙侠", "宗门"],
  },
  {
    name: "Mistport Chronicles",
    description: "A port city shrouded in eternal fog. The tides bring ancient relics—and danger.",
    tags: ["port", "fog", "adventure"],
  },
];

class LocalDataService implements DataService {
  private idbStore: import("@covel/store/idb").IdbStore | null = null;
  private statePatches = new Map<string, StatePatchRecord[]>();
  private initPromise: Promise<void> | null = null;

  private async getStore(): Promise<import("@covel/store/idb").IdbStore> {
    if (this.idbStore) return this.idbStore;
    if (!this.initPromise) {
      this.initPromise = (async () => {
        const { IdbStore } = await import("@covel/store/idb");
        this.idbStore = new IdbStore({ dbName: "covel-game" });
        // Seed worlds on first use
        const existing = await this.idbStore.listWorlds();
        if (existing.length === 0) {
          for (const seed of LOCAL_SEED_WORLDS) {
            await this.idbStore.upsertWorld({
              id: uid("world"),
              name: seed.name,
              description: seed.description,
              tags: seed.tags,
              createdAt: new Date().toISOString(),
            });
          }
        }
      })();
    }
    await this.initPromise;
    return this.idbStore!;
  }

  // ── Worlds ──────────────────────────────────────────────────────

  async listWorlds(): Promise<WorldRecord[]> {
    const store = await this.getStore();
    const worlds = await store.listWorlds();
    // Map DataStore WorldRecord to api.WorldRecord (superset with extra fields)
    return worlds.map((w) => ({
      id: w.id,
      name: w.name,
      description: w.description,
      lore: w.lore,
      tags: w.tags,
      createdAt: w.createdAt,
    })).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async getWorld(id: string): Promise<WorldRecord | null> {
    const store = await this.getStore();
    const w = await store.getWorld(id);
    if (!w) return null;
    return {
      id: w.id,
      name: w.name,
      description: w.description,
      lore: w.lore,
      tags: w.tags,
      createdAt: w.createdAt,
    };
  }

  async createWorld(name: string, description: string): Promise<WorldRecord> {
    const store = await this.getStore();
    const world: WorldRecord = {
      id: uid("world"),
      name,
      description,
      createdAt: new Date().toISOString(),
    };
    await store.upsertWorld({
      id: world.id,
      name: world.name,
      description: world.description,
      createdAt: world.createdAt,
    });
    return world;
  }

  async updateWorld(
    id: string,
    patch: Partial<Pick<WorldRecord, "name" | "description" | "lore" | "locale" | "tags" | "dimensions">>,
  ): Promise<WorldRecord> {
    const store = await this.getStore();
    const existing = await store.getWorld(id);
    if (!existing) throw new Error("World not found: " + id);
    const updated: WorldRecord = {
      ...existing,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    await store.upsertWorld({
      id: updated.id,
      name: updated.name,
      description: updated.description,
      lore: updated.lore,
      tags: updated.tags,
      createdAt: updated.createdAt,
    });
    return updated;
  }

  // ── Sessions ────────────────────────────────────────────────────

  async listSessions(worldId: string): Promise<SessionRecord[]> {
    const store = await this.getStore();
    const sessions = await store.listSessions(worldId);
    return sessions
      .map((s) => ({
        id: s.id,
        worldId: s.worldId,
        status: s.status,
        phase: s.phase as SessionPhase,
        presetId: s.presetId,
        createdAt: s.createdAt,
      }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async getSession(sessionId: string): Promise<SessionRecord | null> {
    const store = await this.getStore();
    const s = await store.getSession(sessionId);
    if (!s) return null;
    return {
      id: s.id,
      worldId: s.worldId,
      status: s.status,
      phase: s.phase as SessionPhase,
      presetId: s.presetId,
      createdAt: s.createdAt,
    };
  }

  async createSession(worldId: string, presetId?: string): Promise<SessionRecord> {
    const store = await this.getStore();
    const session: SessionRecord = {
      id: humanSessionId(),
      worldId,
      status: "active",
      phase: "init",
      presetId,
      createdAt: new Date().toISOString(),
    };
    await store.upsertSession({
      id: session.id,
      worldId: session.worldId,
      status: session.status,
      phase: session.phase,
      presetId: session.presetId,
      createdAt: session.createdAt,
    });
    return session;
  }

  async updateSession(
    sessionId: string,
    updates: Partial<Pick<SessionRecord, "status" | "presetId">>,
  ): Promise<SessionRecord> {
    const store = await this.getStore();
    const existing = await store.getSession(sessionId);
    if (!existing) throw new Error("Session not found: " + sessionId);
    const updated: SessionRecord = {
      id: existing.id,
      worldId: existing.worldId,
      status: updates.status ?? existing.status,
      phase: existing.phase as SessionPhase,
      presetId: updates.presetId ?? existing.presetId,
      createdAt: existing.createdAt,
    };
    await store.upsertSession({
      id: updated.id,
      worldId: updated.worldId,
      status: updated.status,
      phase: updated.phase,
      presetId: updated.presetId,
      createdAt: updated.createdAt,
    });
    return updated;
  }

  // ── Messages ────────────────────────────────────────────────────

  async listMessages(sessionId: string): Promise<MessageRecord[]> {
    const store = await this.getStore();
    const messages = await store.listMessages(sessionId);
    return messages
      .map((m) => ({
        id: m.id,
        sessionId: m.sessionId,
        role: m.role,
        content: m.content,
        ...(m.metadata as { turnId?: string; runtimeId?: string; block?: Record<string, unknown> } ?? {}),
        createdAt: m.createdAt,
      }))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async addMessage(msg: MessageRecord): Promise<void> {
    const store = await this.getStore();
    await store.addMessage({
      id: msg.id,
      sessionId: msg.sessionId,
      role: msg.role,
      content: msg.content,
      metadata: {
        ...(msg.turnId ? { turnId: msg.turnId } : {}),
        ...(msg.runtimeId ? { runtimeId: msg.runtimeId } : {}),
        ...(msg.block ? { block: msg.block } : {}),
      },
      createdAt: msg.createdAt,
    });
  }

  // ── State patches (in-memory only) ──────────────────────────────

  async listStatePatches(sessionId: string): Promise<StatePatchRecord[]> {
    return this.statePatches.get(sessionId) ?? [];
  }

  // ── Sync to server ──────────────────────────────────────────────

  async syncToServer(sessionId: string): Promise<void> {
    const [session, world, messages] = await Promise.all([
      this.getSession(sessionId),
      this.getSession(sessionId).then(async (s) =>
        s ? this.getWorld(s.worldId) : null,
      ),
      this.listMessages(sessionId),
    ]);

    if (!session || !world) return;

    // Ensure world exists on server
    try {
      await api.getWorld(world.id);
    } catch {
      await api.createWorld(world.name, world.description);
      // Server assigns its own ID — we need the server to know our world.
      // Use updateWorld to set the lore etc.
    }

    // Ensure session exists on server (server needs it for action routing)
    try {
      await api.getSession(session.id);
    } catch {
      await api.createSession(session.worldId, session.presetId);
    }

    // Messages will be rebuilt from SSE events on the server side during action execution.
    // The server's MemoryStore accumulates messages per session automatically.
    // For resume scenarios, we'd need a bulk-sync endpoint. For now, the server
    // rebuilds context from what it has.
  }
}

// ── Factory ───────────────────────────────────────────────────────

let cachedService: DataService | null = null;
let cachedMode: StorageMode | null = null;

export function getDataService(): DataService {
  const mode = getStorageMode();
  if (cachedService && cachedMode === mode) return cachedService;
  cachedMode = mode;
  cachedService = mode === "local" ? new LocalDataService() : new RemoteDataService();
  return cachedService;
}

/** Reset cached service (call after mode switch). */
export function resetDataService(): void {
  cachedService = null;
  cachedMode = null;
}
