import type { CursorPage } from "@covel/shared";
import type {
  DataStore,
  SessionRecord as StoreSessionRecord,
  WorldRecord as StoreWorldRecord,
} from "@covel/store";
import type { SessionStatus } from "../api.js";
import type {
  MessageRecord,
  SessionRecord,
  StatePatchRecord,
  WorldRecord,
} from "../api.js";
import i18n from "i18next";
import { resolveI18nText } from "@covel/shared";
import * as api from "../api.js";
import { isNotFound } from "../api/request.js";
import * as appKv from "../app-kv-store.js";
import { createBrowserDataStore } from "../storage/index.js";
import { ignoreError } from "@/lib/ignore-error.js";
import {
  toFrontendMessage,
  toFrontendSession,
  toFrontendWorld,
} from "./mappers.js";
import { LOCAL_SEED_WORLDS } from "./seed-worlds.js";
import type { DataService, WorldPatch } from "./types.js";

type Writable<T> = { -readonly [K in keyof T]: T[K] };

/** Default keyset page size when a caller omits `limit` (mirrors the API default). */
const DEFAULT_MESSAGES_PAGE_LIMIT = 80;

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

export class LocalDataService implements DataService {
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

  // Worlds

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

  async updateWorld(id: string, patch: WorldPatch): Promise<WorldRecord> {
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

  // Sessions

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
    // Evict before the store teardown, not after: the in-memory list is
    // authoritative once hydrated, so it must not survive a delete that failed
    // partway through.
    this.statePatches.delete(sessionId);
    const store = await this.getStore();
    await store.deleteSession(sessionId);
    appKv
      .removeStateSnapshot(sessionId)
      .catch(ignoreError("remove state snapshot on delete"));
    appKv
      .removeStatePatches(sessionId)
      .catch(ignoreError("remove state patches on delete"));
    appKv
      .removeSubmittedBlocks(sessionId)
      .catch(ignoreError("remove submitted blocks on delete"));
  }

  // Messages

  async listMessages(sessionId: string): Promise<MessageRecord[]> {
    const store = await this.getStore();
    const messages = await store.listMessages(sessionId);
    return messages
      .map(toFrontendMessage)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async listMessagesPage(
    sessionId: string,
    opts: { limit?: number; before?: { createdAt: string; id: string } },
  ): Promise<CursorPage<MessageRecord>> {
    const store = await this.getStore();
    const limit = opts.limit ?? DEFAULT_MESSAGES_PAGE_LIMIT;
    // 直连 IDB 拿到 oldest-first 的一页（store 已按 (createdAt, id) 键集切片）。
    const rows = await store.listMessagesPage(sessionId, {
      limit,
      before: opts.before,
    });
    const items = rows.map(toFrontendMessage);
    // 按契约：拿满一页（可能还有更旧）时游标指向最旧一条，否则到历史开头 → null。
    const nextCursor =
      items.length >= limit && items.length > 0
        ? { createdAt: items[0].createdAt, id: items[0].id }
        : null;
    return { items, nextCursor };
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

  // State patches

  async listStatePatches(sessionId: string): Promise<StatePatchRecord[]> {
    return this.hydrateStatePatches(sessionId);
  }

  /**
   * The in-memory map is empty after a page reload, so appending straight to it
   * and writing the result back to IDB used to overwrite the whole persisted
   * array with a single patch — the session's entire state history, gone on the
   * first turn after a refresh. Read through IDB before touching the list.
   */
  private async hydrateStatePatches(
    sessionId: string,
  ): Promise<StatePatchRecord[]> {
    const cached = this.statePatches.get(sessionId);
    if (cached) return cached;
    const persisted = (await appKv.getStatePatches(sessionId)) ?? [];
    // Re-read: an append may have landed while the IDB read was in flight.
    const raced = this.statePatches.get(sessionId);
    if (raced) return raced;
    this.statePatches.set(sessionId, persisted);
    return persisted;
  }

  async addStatePatch(
    sessionId: string,
    patch: StatePatchRecord,
  ): Promise<void> {
    const hydrated = await this.hydrateStatePatches(sessionId);
    // Re-read after the await. One turn commonly commits several `state.changed`
    // events that arrive in a single flush, and `sse-handler` fires this
    // fire-and-forget per event: without the re-read, two appends resolving in
    // the same tick both build on the same base list and the second overwrites
    // the first. Each continuation's `set` below is synchronous, so re-reading
    // here always observes the previous append.
    const list = this.statePatches.get(sessionId) ?? hydrated;
    const next = [...list, patch];
    this.statePatches.set(sessionId, next);
    // Persist to IDB (fire-and-forget)
    appKv
      .saveStatePatches(sessionId, next)
      .catch(ignoreError("save state patches"));
  }

  // State snapshot persistence (IndexedDB)

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

  // Submitted blocks

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

  // Sync to server

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

    // Ensure world exists on server (pass local ID so server uses the same ID).
    // Only a 404 means "not there yet" — a transient 500 must not be answered
    // by creating a second, empty world over the top of the real one.
    try {
      await api.getWorld(serverWorldId);
    } catch (err) {
      if (!isNotFound(err)) throw err;
      await api.createWorld(
        resolveI18nText(world.name, i18n.language) ?? "",
        resolveI18nText(world.description, i18n.language) ?? "",
        serverWorldId,
      );
    }

    // Ensure session exists on server (pass local ID so server uses the same ID)
    try {
      await api.getSession(serverSessionId);
    } catch (err) {
      if (!isNotFound(err)) throw err;
      await api.createSession(serverWorldId, session.presetId, serverSessionId);
    }

    // Upload messages so the server kernel can build LLM context. This is NOT
    // optional: silently skipping it means the next turn runs with empty
    // history and the narrator visibly loses the whole story, with no error
    // shown. Let it reject — `start-game` already has an error path.
    if (messages.length > 0) {
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
    }

    // Upload state snapshot so the server kernel can rehydrate game state
    const snapshot = await this.loadStateSnapshot(session.id);
    if (snapshot) {
      await api.saveStateSnapshot(serverSessionId, snapshot);
    }
  }

  async saveExecutionSteps(sessionId: string, steps: unknown[]): Promise<void> {
    await appKv.saveExecutionSteps(sessionId, steps);
  }

  async loadExecutionSteps(sessionId: string): Promise<unknown[]> {
    return appKv.getExecutionSteps(sessionId);
  }
}
