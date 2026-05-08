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

import type { I18nText } from "@covel/shared";
import type {
  DataStore,
  WorldRecord as StoreWorldRecord,
  SessionRecord as StoreSessionRecord,
} from "@covel/store";
import type {
  GeneratedWorldSaveTarget,
  WorldRecord,
  SessionRecord,
  MessageRecord,
  StatePatchRecord,
  SessionStatus,
} from "./api.js";
import * as api from "./api.js";
import * as appKv from "./app-kv-store.js";
import {
  createBrowserDataStore,
  getStorageMode as getStorageModeFromFacade,
  setStorageMode as setStorageModeFromFacade,
  storageModeForServerBackend as storageModeForServerBackendFromFacade,
  storageModeForServerStorage as storageModeForServerStorageFromFacade,
  type ServerStoreBackend,
  type ServerStorageCapabilities,
  type StorageMode,
} from "./storage/index.js";
import { text } from "@/components/world/editor-helpers.js";

type Writable<T> = { -readonly [K in keyof T]: T[K] };
export type { ServerStoreBackend, StorageMode } from "./storage/index.js";

// ── Interface ─────────────────────────────────────────────────────

export interface DataService {
  // Worlds
  listWorlds(): Promise<WorldRecord[]>;
  getWorld(id: string): Promise<WorldRecord | null>;
  createWorld(name: string, description: string): Promise<WorldRecord>;
  saveGeneratedWorld(world: WorldRecord): Promise<WorldRecord>;
  updateWorld(
    id: string,
    patch: Partial<
      Pick<
        WorldRecord,
        "name" | "description" | "lore" | "locale" | "tags" | "dimensions"
      >
    >,
  ): Promise<WorldRecord>;

  // Sessions
  listSessions(worldId: string): Promise<SessionRecord[]>;
  getSession(sessionId: string): Promise<SessionRecord | null>;
  createSession(
    worldId: string,
    presetId?: string,
    id?: string,
    plugins?: string[],
    locale?: string,
  ): Promise<SessionRecord>;
  updateSession(
    sessionId: string,
    updates: Partial<Pick<SessionRecord, "status" | "presetId">>,
  ): Promise<SessionRecord>;
  deleteSession(sessionId: string): Promise<void>;

  // Messages
  listMessages(sessionId: string): Promise<MessageRecord[]>;
  addMessage(msg: MessageRecord): Promise<void>;

  // State patches
  listStatePatches(sessionId: string): Promise<StatePatchRecord[]>;
  addStatePatch(sessionId: string, patch: StatePatchRecord): Promise<void>;

  /**
   * Persist post-commit state snapshot from the kernel.
   * T1/T2 (local): writes to IndexedDB.
   * T3 (remote): no-op (server handles persistence).
   */
  persistStateSnapshot(
    sessionId: string,
    snapshot: Record<string, unknown>,
  ): Promise<void>;

  /**
   * Load the most recent state snapshot for a session.
   * Returns null if no snapshot exists (fresh session).
   */
  loadStateSnapshot(sessionId: string): Promise<Record<string, unknown> | null>;

  /**
   * Persist submitted block IDs and their submitted form values for a session.
   * Tracks which interactive blocks have been submitted (locks their UI) and
   * keeps the values around so disabled forms can re-display the input.
   */
  saveSubmittedBlocks(
    sessionId: string,
    blockIds: string[],
    values: Record<string, Record<string, unknown>>,
  ): Promise<void>;

  /**
   * Load submitted block IDs + values for a session. Both default to empty.
   * Legacy storage that holds only `string[]` is migrated transparently.
   */
  loadSubmittedBlocks(sessionId: string): Promise<{
    ids: string[];
    values: Record<string, Record<string, unknown>>;
  }>;

  /**
   * Sync session context to server MemoryStore before sending actions.
   * In remote mode this is a no-op. In local mode it pushes
   * world + session + messages so the stateless server can process the turn.
   */
  syncToServer(sessionId: string): Promise<void>;

  /** Persist accumulated execution timeline steps for a session. */
  saveExecutionSteps(sessionId: string, steps: unknown[]): Promise<void>;
  /** Load persisted execution timeline steps for a session. */
  loadExecutionSteps(sessionId: string): Promise<unknown[]>;
}

// ── Storage mode ──────────────────────────────────────────────────

export function storageModeForServerBackend(
  backend: ServerStoreBackend,
): StorageMode {
  return storageModeForServerBackendFromFacade(backend);
}

export function storageModeForServerStorage(
  storage: ServerStorageCapabilities | null | undefined,
): StorageMode | null {
  return storageModeForServerStorageFromFacade(storage);
}

export function generatedWorldSaveTargetForBackend(
  backend: ServerStoreBackend | null | undefined,
): GeneratedWorldSaveTarget {
  if (backend === "memory") return "return-only";
  if (backend === "sqlite" || backend === "pg") return "server-store";
  return "server-file";
}

export function getStorageMode(): StorageMode {
  return getStorageModeFromFacade();
}

export function setStorageMode(mode: StorageMode): void {
  setStorageModeFromFacade(mode);
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
  async saveGeneratedWorld(world: WorldRecord) {
    return world;
  }
  async updateWorld(
    id: string,
    patch: Partial<
      Pick<
        WorldRecord,
        "name" | "description" | "lore" | "locale" | "tags" | "dimensions"
      >
    >,
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
  async createSession(
    worldId: string,
    presetId?: string,
    id?: string,
    plugins?: string[],
    locale?: string,
  ) {
    return api.createSession(worldId, presetId, id, plugins, locale);
  }
  async updateSession(
    sessionId: string,
    updates: Partial<Pick<SessionRecord, "status" | "presetId">>,
  ) {
    return api.updateSession(sessionId, updates);
  }
  async deleteSession(sessionId: string) {
    return api.deleteSession(sessionId);
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
  async addStatePatch(_sessionId: string, _patch: StatePatchRecord) {
    // Remote mode: server stores patches during action SSE flow
  }

  async persistStateSnapshot() {
    // No-op: T3 server handles persistence directly
  }

  async loadStateSnapshot(sessionId: string) {
    // T3: load from server API
    try {
      return await api.loadStateSnapshot(sessionId);
    } catch {
      return null;
    }
  }

  async saveSubmittedBlocks(
    sessionId: string,
    blockIds: string[],
    values: Record<string, Record<string, unknown>>,
  ) {
    // T3: use client-side IDB — submitted block state is a UI concern.
    // Could be promoted to a server endpoint if cross-device resume is needed.
    await appKv.saveSubmittedBlocks(sessionId, blockIds, values);
  }

  async loadSubmittedBlocks(sessionId: string) {
    return appKv.getSubmittedBlocks(sessionId);
  }

  async syncToServer() {
    // No-op: server already has the data
  }

  async saveExecutionSteps(sessionId: string, steps: unknown[]) {
    await appKv.saveExecutionSteps(sessionId, steps);
  }

  async loadExecutionSteps(sessionId: string) {
    return appKv.getExecutionSteps(sessionId);
  }
}

// ── Local implementation (IndexedDB) ──────────────────────────────

function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function humanSessionId(): string {
  const words = [
    "brave",
    "calm",
    "dark",
    "eager",
    "fair",
    "glad",
    "keen",
    "mild",
    "noble",
    "pure",
    "rare",
    "sage",
    "true",
    "vast",
    "warm",
    "wise",
  ];
  const nouns = [
    "dawn",
    "dusk",
    "fire",
    "gale",
    "haze",
    "lake",
    "moon",
    "rain",
    "snow",
    "star",
    "tide",
    "vale",
    "wave",
    "wind",
    "wood",
    "glow",
  ];
  const pick = (arr: string[]) => arr[Math.floor(Math.random() * arr.length)];
  const hex = Math.random().toString(16).slice(2, 6);
  return `${pick(words)}-${pick(nouns)}-${pick(words)}-${hex}`;
}

/** Minimal seed worlds for first-time local mode users. */
const LOCAL_SEED_WORLDS: Array<{
  name: I18nText;
  description: I18nText;
  tags: string[];
}> = [
  {
    name: { "zh-CN": "雾港・裂潮纪", "en-US": "Mistport Chronicles" },
    description: {
      "zh-CN": "一座被永恒浓雾包裹的港口城市。潮汐带来远古遗物，也带来危险。",
      "en-US":
        "A port city shrouded in eternal fog. The tides bring ancient relics—and danger.",
    },
    tags: ["dark-fantasy", "mystery", "exploration"],
  },
  {
    name: { "zh-CN": "霓虹脊・2087", "en-US": "Neon Ridge 2087" },
    description: {
      "zh-CN": "赛博朋克都市，义体改造与数据黑市交织的霓虹丛林。",
      "en-US":
        "A cyberpunk metropolis where body augmentation and data black markets intertwine beneath neon lights.",
    },
    tags: ["cyberpunk", "augmentation", "hacker"],
  },
  {
    name: { "zh-CN": "九州・云梦泽", "en-US": "Nine Realms: Cloud Marsh" },
    description: {
      "zh-CN": "修仙世界，灵脉纵横，宗门林立，一场席卷九州的劫变正在酝酿。",
      "en-US":
        "A cultivation world of spirit veins, rival sects, and a looming tribulation that threatens all Nine Realms.",
    },
    tags: ["xianxia", "cultivation", "sects"],
  },
];

function toFrontendWorld(w: StoreWorldRecord): WorldRecord {
  return {
    id: w.id,
    name: w.name as I18nText,
    description: w.description as I18nText,
    lore: w.lore as I18nText | undefined,
    locale: w.locale,
    tags: w.tags ? [...w.tags] : undefined,
    dimensions:
      w.dimensions ?? (w.metadata?.dimensions as WorldRecord["dimensions"]),
    metadata: w.metadata as WorldRecord["metadata"],
    createdAt: w.createdAt,
    updatedAt: w.updatedAt,
  };
}

function toFrontendSession(s: StoreSessionRecord): SessionRecord {
  return {
    id: s.id,
    worldId: s.worldId ?? "",
    status: s.status,
    turnCount: s.turnCount,
    preGameCompleted: s.preGameCompleted,
    activePlugins: s.activePlugins,
    presetId: s.presetId,
    runtimeModelOverrides: s.runtimeModelOverrides
      ? { ...s.runtimeModelOverrides }
      : undefined,
    createdAt: s.createdAt,
  };
}

class LocalDataService implements DataService {
  private idbStore: DataStore | null = null;
  private statePatches = new Map<string, StatePatchRecord[]>();
  private initPromise: Promise<void> | null = null;

  private async getStore(): Promise<DataStore> {
    if (this.idbStore) return this.idbStore;
    if (!this.initPromise) {
      this.initPromise = (async () => {
        this.idbStore = await createBrowserDataStore();
        // Seed minimal worlds for offline/no-server scenarios
        const existing = await this.idbStore.listWorlds();
        if (existing.length === 0) {
          for (const seed of LOCAL_SEED_WORLDS) {
            await this.idbStore.upsertWorld({
              id: uid("world"),
              name: seed.name as StoreWorldRecord["name"],
              description: seed.description as StoreWorldRecord["description"],
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
    return worlds
      .map(toFrontendWorld)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async getWorld(id: string): Promise<WorldRecord | null> {
    const store = await this.getStore();
    const w = await store.getWorld(id);
    return w ? toFrontendWorld(w) : null;
  }

  async createWorld(name: string, description: string): Promise<WorldRecord> {
    const store = await this.getStore();
    const world: WorldRecord = {
      id: uid("world"),
      name,
      description,
      createdAt: new Date().toISOString(),
    };
    await store.upsertWorld(world as StoreWorldRecord);
    return world;
  }

  async saveGeneratedWorld(world: WorldRecord): Promise<WorldRecord> {
    const store = await this.getStore();
    const now = new Date().toISOString();
    const metadata: Record<string, unknown> = {
      ...world.metadata,
      source: "browser-indexeddb",
      storage: {
        scope: "browser",
        backend: "indexeddb",
        durable: true,
      },
    };
    delete metadata.worldDataPath;
    delete metadata.worldData;
    const record = {
      ...world,
      metadata,
      updatedAt: now,
      createdAt: world.createdAt ?? now,
    };
    await store.upsertWorld(record as StoreWorldRecord);
    return record;
  }

  async updateWorld(
    id: string,
    patch: Partial<
      Pick<
        WorldRecord,
        "name" | "description" | "lore" | "locale" | "tags" | "dimensions"
      >
    >,
  ): Promise<WorldRecord> {
    const store = await this.getStore();
    const existing = await store.getWorld(id);
    if (!existing) throw new Error("World not found: " + id);
    const updated: StoreWorldRecord = {
      ...existing,
      ...patch,
      updatedAt: new Date().toISOString(),
    } as StoreWorldRecord;
    await store.upsertWorld(updated);
    return toFrontendWorld(updated);
  }

  // ── Sessions ────────────────────────────────────────────────────

  async listSessions(worldId: string): Promise<SessionRecord[]> {
    const store = await this.getStore();
    const sessions = await store.listSessions();
    return sessions
      .filter((s) => !worldId || s.worldId === worldId)
      .map(toFrontendSession)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async getSession(sessionId: string): Promise<SessionRecord | null> {
    const store = await this.getStore();
    const s = await store.getSession(sessionId);
    return s ? toFrontendSession(s) : null;
  }

  async createSession(
    worldId: string,
    presetId?: string,
    _id?: string,
    _plugins?: string[],
    locale?: string,
  ): Promise<SessionRecord> {
    const store = await this.getStore();
    const nowIso = new Date().toISOString();
    const session: SessionRecord = {
      id: humanSessionId(),
      worldId,
      status: "active",
      turnCount: 0,
      preGameCompleted: [],
      presetId,
      createdAt: nowIso,
    };
    await store.createSession({
      id: session.id,
      worldId,
      status: "active",
      turnCount: 0,
      preGameCompleted: [],
      locale: locale ?? "zh-CN",
      activePlugins: _plugins ?? [],
      presetId,
      metadata: presetId ? { presetId } : undefined,
      createdAt: nowIso,
      updatedAt: nowIso,
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
    const nextStatus = (updates.status ??
      existing.status ??
      "active") as SessionStatus;
    const updated: SessionRecord = {
      id: existing.id,
      worldId: existing.worldId ?? "",
      status: nextStatus,
      turnCount: existing.turnCount ?? 0,
      preGameCompleted: existing.preGameCompleted ?? [],
      presetId: updates.presetId ?? existing.presetId,
      createdAt: existing.createdAt,
    };
    const patch: Writable<Partial<StoreSessionRecord>> = {
      updatedAt: new Date().toISOString(),
    };
    if (updates.status !== undefined) patch.status = nextStatus;
    if ("presetId" in updates) patch.presetId = updates.presetId;
    await store.updateSession(sessionId, patch);
    return updated;
  }

  async deleteSession(sessionId: string): Promise<void> {
    const store = await this.getStore();
    await store.deleteSession(sessionId);
    appKv.removeStateSnapshot(sessionId).catch(() => {});
    appKv.removeStatePatches(sessionId).catch(() => {});
    appKv.removeSubmittedBlocks(sessionId).catch(() => {});
  }

  // ── Messages ────────────────────────────────────────────────────

  async listMessages(sessionId: string): Promise<MessageRecord[]> {
    const store = await this.getStore();
    const messages = await store.listMessages(sessionId);
    return messages
      .map(
        (m) =>
          ({
            id: m.id,
            sessionId: m.sessionId,
            role: m.role,
            content: m.content,
            ...(m.metadata as {
              turnId?: string;
              runtimeId?: string;
              kind?: string;
              block?: Record<string, unknown>;
            }),
            createdAt: m.createdAt,
          }) as MessageRecord,
      )
      .sort((a: { createdAt: string }, b: { createdAt: string }) =>
        a.createdAt.localeCompare(b.createdAt),
      );
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
        ...(msg.kind ? { kind: msg.kind } : {}),
        ...(msg.block ? { block: msg.block } : {}),
      },
      createdAt: msg.createdAt,
    });
  }

  // ── State patches ───────────────────────────────────────────────

  async listStatePatches(sessionId: string): Promise<StatePatchRecord[]> {
    // Try loading from IDB first, fall back to in-memory cache
    const persisted = await appKv.getStatePatches(sessionId);
    if (persisted && persisted.length > 0) return persisted;
    return this.statePatches.get(sessionId) ?? [];
  }

  async addStatePatch(
    sessionId: string,
    patch: StatePatchRecord,
  ): Promise<void> {
    const list = this.statePatches.get(sessionId) ?? [];
    this.statePatches.set(sessionId, [...list, patch]);
    // Persist to IDB (fire-and-forget)
    appKv.saveStatePatches(sessionId, [...list, patch]).catch(() => {});
  }

  // ── State snapshot persistence (IndexedDB) ─────────────────────

  async persistStateSnapshot(
    sessionId: string,
    snapshot: Record<string, unknown>,
  ): Promise<void> {
    await appKv.saveStateSnapshot(sessionId, snapshot);
  }

  async loadStateSnapshot(
    sessionId: string,
  ): Promise<Record<string, unknown> | null> {
    return appKv.getStateSnapshot(sessionId);
  }

  // ── Submitted blocks ────────────────────────────────────────────

  async saveSubmittedBlocks(
    sessionId: string,
    blockIds: string[],
    values: Record<string, Record<string, unknown>>,
  ): Promise<void> {
    await appKv.saveSubmittedBlocks(sessionId, blockIds, values);
  }

  async loadSubmittedBlocks(sessionId: string) {
    return appKv.getSubmittedBlocks(sessionId);
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

    // Sanitize IDs: server schema requires /^[a-z0-9-]+$/, but older local IDs
    // may contain underscores (generated before the uid() fix). Replace them.
    const serverWorldId = world.id.replace(/_/g, "-");
    const serverSessionId = session.id.replace(/_/g, "-");

    // Ensure world exists on server (pass local ID so server uses the same ID)
    try {
      await api.getWorld(serverWorldId);
    } catch {
      await api.createWorld(
        text(world.name),
        text(world.description),
        serverWorldId,
      );
    }

    // Ensure session exists on server (pass local ID so server uses the same ID)
    try {
      await api.getSession(serverSessionId);
    } catch {
      await api.createSession(serverWorldId, session.presetId, serverSessionId);
    }

    // Upload messages so the server kernel can build LLM context
    if (messages.length > 0) {
      try {
        await api.syncMessages(
          serverSessionId,
          messages.map((m) => ({
            role: m.role,
            content: m.content,
            turnId: m.turnId,
            runtimeId: m.runtimeId,
            block: m.block,
          })),
        );
      } catch {
        // Non-critical: server may not have sync endpoint
      }
    }

    // Upload state snapshot so the server kernel can rehydrate game state
    const snapshot = await this.loadStateSnapshot(session.id);
    if (snapshot) {
      try {
        await api.saveStateSnapshot(serverSessionId, snapshot);
      } catch {
        // Non-critical: server may not have state-snapshot endpoint in T1 mode
      }
    }
  }

  async saveExecutionSteps(sessionId: string, steps: unknown[]): Promise<void> {
    await appKv.saveExecutionSteps(sessionId, steps);
  }

  async loadExecutionSteps(sessionId: string): Promise<unknown[]> {
    return appKv.getExecutionSteps(sessionId);
  }
}

// ── Factory ───────────────────────────────────────────────────────

let cachedService: DataService | null = null;
let cachedMode: StorageMode | null = null;

export function getDataService(): DataService {
  const mode = getStorageMode();
  if (cachedService && cachedMode === mode) return cachedService;
  cachedMode = mode;
  cachedService =
    mode === "local" ? new LocalDataService() : new RemoteDataService();
  return cachedService;
}

/** Reset cached service (call after mode switch). */
export function resetDataService(): void {
  cachedService = null;
  cachedMode = null;
}
