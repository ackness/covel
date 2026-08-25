import type { CursorPage } from "@covel/shared";
import type {
  BrowserCheckpoint,
  MessageRecord as StoreMessageRecord,
  SessionRecord as StoreSessionRecord,
  WorldRecord as StoreWorldRecord,
} from "@covel/store/browser-sync";
import { BROWSER_CHECKPOINT_SCHEMA_VERSION } from "@covel/store/browser-sync";
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
import { BrowserVault } from "../storage/index.js";
import { ignoreError } from "@/lib/ignore-error.js";
import {
  toFrontendMessage,
  toFrontendSession,
  toFrontendWorld,
} from "./mappers.js";
import { LOCAL_SEED_WORLDS } from "./seed-worlds.js";
import type { DataService, SessionPatch, WorldPatch } from "./types.js";

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
  const hex = crypto.randomUUID().slice(0, 8);
  return `${pick(words)}-${pick(nouns)}-${pick(words)}-${hex}`;
}

function jsonCheckpoint(checkpoint: BrowserCheckpoint): BrowserCheckpoint {
  return JSON.parse(JSON.stringify(checkpoint)) as BrowserCheckpoint;
}

function initialCheckpoint(
  session: StoreSessionRecord,
  world: StoreWorldRecord | null,
): BrowserCheckpoint {
  const committedAt = new Date().toISOString();
  return jsonCheckpoint({
    schemaVersion: BROWSER_CHECKPOINT_SCHEMA_VERSION,
    sessionId: session.id,
    profile: "browser-private",
    session,
    world,
    messages: [],
    turnMessages: [],
    turnResults: [],
    runtimeResults: [],
    toolCalls: [],
    runtimeOutputs: [],
    interactions: [],
    events: [],
    traceEvents: [],
    characters: [],
    pluginData: [],
    workingMemory: [],
    lorebookEntries: [],
    sessionSummaries: [],
    playerInputs: [],
    suspensions: [],
    snapshots: [],
    worldDataLedger: [],
    logicalTurnLedger: [],
    setupAttempts: [],
    jobStatus: [],
    runtimeExports: [],
    revision: 1,
    actionId: `local:create:${session.id}`,
    committedAt,
  });
}

export class LocalDataService implements DataService {
  private readonly vault: BrowserVault;
  private statePatches = new Map<string, StatePatchRecord[]>();
  private initPromise: Promise<void> | null = null;
  private workspaceTail: Promise<void> = Promise.resolve();

  constructor(vault?: BrowserVault) {
    this.vault = vault ?? new BrowserVault();
  }

  private async ready(): Promise<BrowserVault> {
    if (!this.initPromise) {
      this.initPromise = (async () => {
        const existing = await this.vault.listWorlds();
        if (existing.length === 0) {
          for (const seed of LOCAL_SEED_WORLDS) {
            await this.vault.upsertWorld({
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
    return this.vault;
  }

  private async mutateCheckpoint(
    sessionId: string,
    domain: string,
    mutate: (checkpoint: BrowserCheckpoint) => BrowserCheckpoint,
  ): Promise<BrowserCheckpoint> {
    const vault = await this.ready();
    const current = await vault.getLatestCheckpoint(sessionId);
    if (!current) throw new Error(`Session not found: ${sessionId}`);
    const actionId = `local:${domain}:${crypto.randomUUID()}`;
    const committedAt = new Date().toISOString();
    const checkpoint = jsonCheckpoint({
      ...mutate(current),
      schemaVersion: BROWSER_CHECKPOINT_SCHEMA_VERSION,
      sessionId,
      profile: "browser-private",
      revision: current.revision + 1,
      actionId,
      committedAt,
    });
    const result = await vault.applySessionCommit({
      baseRevision: current.revision,
      revision: checkpoint.revision,
      actionId,
      checkpoint,
    });
    return result.checkpoint;
  }

  private enqueueWorkspace<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.workspaceTail.then(operation, operation);
    this.workspaceTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  // Worlds

  async listWorlds(): Promise<WorldRecord[]> {
    const worlds = await (await this.ready()).listWorlds();
    return worlds
      .map(toFrontendWorld)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async getWorld(id: string): Promise<WorldRecord | null> {
    const w = await (await this.ready()).getWorld(id);
    return w ? toFrontendWorld(w) : null;
  }

  async createWorld(name: string, description: string): Promise<WorldRecord> {
    const vault = await this.ready();
    const world: WorldRecord = {
      id: uid("world"),
      name,
      description,
      createdAt: new Date().toISOString(),
    };
    await vault.upsertWorld(world as StoreWorldRecord);
    return world;
  }

  async saveGeneratedWorld(world: WorldRecord): Promise<WorldRecord> {
    const vault = await this.ready();
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
    await vault.upsertWorld(record as StoreWorldRecord);
    return record;
  }

  async updateWorld(id: string, patch: WorldPatch): Promise<WorldRecord> {
    const vault = await this.ready();
    const existing = await vault.getWorld(id);
    if (!existing) throw new Error("World not found: " + id);
    const updated: StoreWorldRecord = {
      ...existing,
      ...patch,
      updatedAt: new Date().toISOString(),
    } as StoreWorldRecord;
    await vault.upsertWorld(updated);
    return toFrontendWorld(updated);
  }

  // Sessions

  async listSessions(worldId: string): Promise<SessionRecord[]> {
    const vault = await this.ready();
    const sessions = await Promise.all(
      (await vault.listSessions()).map((head) =>
        vault.getLatestCheckpoint(head.sessionId),
      ),
    );
    return sessions
      .filter((checkpoint): checkpoint is BrowserCheckpoint => !!checkpoint)
      .map((checkpoint) => checkpoint.session)
      .filter((s) => !worldId || s.worldId === worldId)
      .map(toFrontendSession)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async getSession(sessionId: string): Promise<SessionRecord | null> {
    const s = (await (await this.ready()).getLatestCheckpoint(sessionId))
      ?.session;
    return s ? toFrontendSession(s) : null;
  }

  async createSession(
    worldId: string,
    presetId?: string,
    _id?: string,
    _plugins?: string[],
    locale?: string,
  ): Promise<SessionRecord> {
    const vault = await this.ready();
    const nowIso = new Date().toISOString();
    const session: SessionRecord = {
      id: _id ?? humanSessionId(),
      worldId,
      status: "active",
      locale: locale ?? "zh-CN",
      turnCount: 0,
      preGameCompleted: [],
      activePlugins: _plugins ?? [],
      presetId,
      createdAt: nowIso,
    };
    const storeSession: StoreSessionRecord = {
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
    };
    const world = await vault.getWorld(worldId);
    await vault.saveCheckpoint(initialCheckpoint(storeSession, world));
    return session;
  }

  async updateSession(
    sessionId: string,
    updates: SessionPatch,
  ): Promise<SessionRecord> {
    const existing = (await (await this.ready()).getLatestCheckpoint(sessionId))
      ?.session;
    if (!existing) throw new Error("Session not found: " + sessionId);
    const nextStatus = (updates.status ??
      existing.status ??
      "active") as SessionStatus;
    const updated = await this.mutateCheckpoint(
      sessionId,
      "session",
      (checkpoint) => ({
        ...checkpoint,
        session: {
          ...checkpoint.session,
          ...(updates.status !== undefined ? { status: nextStatus } : {}),
          ...("presetId" in updates ? { presetId: updates.presetId } : {}),
          ...(updates.runtimeModelOverrides !== undefined
            ? { runtimeModelOverrides: updates.runtimeModelOverrides }
            : {}),
          updatedAt: new Date().toISOString(),
        },
      }),
    );
    return toFrontendSession(updated.session);
  }

  async deleteSession(sessionId: string): Promise<void> {
    // Evict before the store teardown, not after: the in-memory list is
    // authoritative once hydrated, so it must not survive a delete that failed
    // partway through.
    this.statePatches.delete(sessionId);
    const vault = await this.ready();
    await Promise.all([
      vault.deleteSession(sessionId),
      // A local session may already have an authoritative server mirror from
      // syncToServer. Its cleanup is best-effort so offline users can still
      // delete their browser data, but always attempt it to avoid orphaned
      // sessions when startup rolls back after a partial or completed sync.
      api.deleteSession(sessionId).catch((error) => {
        if (!isNotFound(error)) {
          ignoreError("delete server session mirror")(error);
        }
      }),
    ]);
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
    const messages =
      (await (await this.ready()).getLatestCheckpoint(sessionId))?.messages ??
      [];
    return messages
      .map(toFrontendMessage)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async listMessagesPage(
    sessionId: string,
    opts: { limit?: number; before?: { createdAt: string; id: string } },
  ): Promise<CursorPage<MessageRecord>> {
    const limit = opts.limit ?? DEFAULT_MESSAGES_PAGE_LIMIT;
    const all = [
      ...((await (await this.ready()).getLatestCheckpoint(sessionId))
        ?.messages ?? []),
    ].sort(
      (a, b) =>
        a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    );
    const eligible = opts.before
      ? all.filter(
          (row) =>
            row.createdAt < opts.before!.createdAt ||
            (row.createdAt === opts.before!.createdAt &&
              row.id < opts.before!.id),
        )
      : all;
    const rows = eligible.slice(-limit);
    const items = rows.map(toFrontendMessage);
    // 按契约：拿满一页（可能还有更旧）时游标指向最旧一条，否则到历史开头 → null。
    const nextCursor =
      items.length >= limit && items.length > 0
        ? { createdAt: items[0].createdAt, id: items[0].id }
        : null;
    return { items, nextCursor };
  }

  async addMessage(msg: MessageRecord): Promise<void> {
    const record: StoreMessageRecord = {
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
    };
    await this.mutateCheckpoint(record.sessionId, "message", (checkpoint) => ({
      ...checkpoint,
      messages: [
        ...checkpoint.messages.filter((item) => item.id !== record.id),
        record,
      ],
    }));
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
    return this.enqueueWorkspace(() => this.syncToServerNow(sessionId));
  }

  private async syncToServerNow(sessionId: string): Promise<void> {
    const vault = await this.ready();
    let checkpoint = await vault.getLatestCheckpoint(sessionId);
    if (!checkpoint) return;
    const world = checkpoint.session.worldId
      ? await vault.getWorld(checkpoint.session.worldId)
      : null;
    if (!world) return;
    if (JSON.stringify(checkpoint.world) !== JSON.stringify(world)) {
      checkpoint = await this.mutateCheckpoint(
        sessionId,
        "world",
        (current) => ({ ...current, world }),
      );
    }
    const session = toFrontendSession(checkpoint.session);

    // Server and browser validators both accept underscores. Preserve legacy
    // IDs exactly: actions continue to address the local SessionRecord id, so
    // creating a differently named server mirror would make every turn 404.
    const serverWorldId = world.id;
    const serverSessionId = session.id;

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
      await api.createSession(
        serverWorldId,
        session.presetId,
        serverSessionId,
        session.activePlugins ? [...session.activePlugins] : undefined,
        session.locale,
      );
    }

    await api.uploadBrowserCheckpoint(serverSessionId, checkpoint);
  }

  async commitFromServer(sessionId: string, actionId: string): Promise<void> {
    return this.enqueueWorkspace(() =>
      this.commitFromServerNow(sessionId, actionId),
    );
  }

  private async commitFromServerNow(
    sessionId: string,
    actionId: string,
  ): Promise<void> {
    const vault = await this.ready();
    const current = await vault.getLatestCheckpoint(sessionId);
    if (!current) throw new Error(`Session not found: ${sessionId}`);
    const commit = await api.fetchBrowserCommit(
      sessionId,
      actionId,
      current.revision,
    );
    await vault.applySessionCommit(commit);
  }

  async saveExecutionSteps(sessionId: string, steps: unknown[]): Promise<void> {
    await appKv.saveExecutionSteps(sessionId, steps);
  }

  async loadExecutionSteps(sessionId: string): Promise<unknown[]> {
    return appKv.getExecutionSteps(sessionId);
  }
}
