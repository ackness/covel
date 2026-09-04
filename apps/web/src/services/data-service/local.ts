import {
  DEFAULT_LOCALE,
  characterBlueprintToCharacterUpsert,
  decodePageCursor,
  encodePageCursor,
  resolveI18nText,
  type CharacterBlueprint,
  type CursorPage,
  type WorldCreateRequest,
  type WorldPatchRequest,
} from "@covel/shared";
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

function serverWorldRequest(world: StoreWorldRecord): WorldCreateRequest {
  return {
    id: world.id,
    name: resolveI18nText(world.name, i18n.language) || world.id,
    description: resolveI18nText(world.description, i18n.language) ?? undefined,
    lore: world.lore
      ? (resolveI18nText(world.lore, i18n.language) ?? undefined)
      : undefined,
    tags: world.tags ? [...world.tags] : undefined,
    locale: world.locale,
    dimensions: world.dimensions,
    metadata: world.metadata ? { ...world.metadata } : undefined,
    createdAt: world.createdAt,
  };
}

function serverWorldPatch(world: StoreWorldRecord): WorldPatchRequest {
  const {
    id: _id,
    createdAt: _createdAt,
    ...patch
  } = serverWorldRequest(world);
  return patch;
}

/**
 * Browser-authored worlds may retain locale maps for display, while the
 * server's WorldRecord and public API use the locale-resolved string shape.
 * Keep that conversion at the browser-workspace boundary so an uploaded
 * checkpoint cannot replace the transient server world with a non-wire shape.
 */
function serverCheckpointWorld(world: StoreWorldRecord): StoreWorldRecord {
  const input = serverWorldRequest(world);
  return {
    id: input.id ?? world.id,
    name: input.name,
    description: input.description ?? "",
    lore: input.lore,
    tags: input.tags,
    locale: input.locale,
    dimensions: input.dimensions as StoreWorldRecord["dimensions"],
    metadata: input.metadata,
    createdAt: input.createdAt ?? world.createdAt,
    updatedAt: world.updatedAt,
  };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizePortableCharacterBlueprint(
  value: unknown,
): CharacterBlueprint | null {
  if (!isRecord(value) || value.schemaVersion !== 1) return null;
  if (typeof value.id !== "string" || value.id.length === 0) return null;
  if (typeof value.name !== "string" || value.name.length === 0) return null;
  return value as unknown as CharacterBlueprint;
}

function portableWorldContent(
  session: StoreSessionRecord,
  world: StoreWorldRecord | null,
  now: string,
): Pick<BrowserCheckpoint, "characters" | "lorebookEntries"> {
  const metadata = isRecord(world?.metadata) ? world.metadata : {};
  const rawCharacters = Array.isArray(metadata.characterBlueprints)
    ? metadata.characterBlueprints.slice(0, 64)
    : [];
  const characters = rawCharacters.flatMap((value) => {
    const blueprint = normalizePortableCharacterBlueprint(value);
    if (!blueprint) return [];
    const baseId =
      typeof blueprint.instantiate?.characterId === "string" &&
      blueprint.instantiate.characterId.length > 0
        ? blueprint.instantiate.characterId
        : `char-${blueprint.id}`;
    const scopedId = `${session.id}-${baseId}`;
    const characterId =
      scopedId.length <= 180 ? scopedId : `${session.id}-${blueprint.id}`;
    const upsert = characterBlueprintToCharacterUpsert(blueprint, {
      now,
      characterId,
    });
    return [
      {
        id: upsert.id,
        sessionId: session.id,
        name: upsert.name,
        type: upsert.type ?? "npc",
        ...(upsert.description !== undefined
          ? { description: upsert.description }
          : {}),
        ...(upsert.fields !== undefined ? { fields: upsert.fields } : {}),
        version: upsert.version ?? 1,
        createdAt: upsert.createdAt ?? now,
        updatedAt: now,
      },
    ];
  });

  const rawLorebook = Array.isArray(metadata.embeddedLorebook)
    ? metadata.embeddedLorebook.slice(0, 128)
    : [];
  const seenLoreIds = new Set<string>();
  const lorebookEntries = rawLorebook.flatMap((value, index) => {
    if (!isRecord(value)) return [];
    if (
      typeof value.id !== "string" ||
      !value.id ||
      seenLoreIds.has(value.id) ||
      typeof value.content !== "string" ||
      !value.content
    ) {
      return [];
    }
    seenLoreIds.add(value.id);
    const keys = Array.isArray(value.keys)
      ? value.keys
          .filter((key): key is string => typeof key === "string")
          .slice(0, 32)
      : [];
    return [
      {
        id: value.id,
        sessionId: session.id,
        pluginId: "world-data",
        keys,
        content: value.content,
        strategy:
          value.strategy === "selective"
            ? ("selective" as const)
            : ("constant" as const),
        position:
          value.position === "before_plugin" ? "before_plugin" : "after_plugin",
        insertionOrder:
          typeof value.insertionOrder === "number"
            ? value.insertionOrder
            : 100 + index,
        enabled: value.enabled !== false,
        ...(value.extra !== undefined ? { extra: value.extra } : {}),
        createdAt: now,
        updatedAt: now,
      },
    ];
  });
  return { characters, lorebookEntries };
}

function initialCheckpoint(
  session: StoreSessionRecord,
  world: StoreWorldRecord | null,
): BrowserCheckpoint {
  const committedAt = new Date().toISOString();
  const portableContent = portableWorldContent(session, world, committedAt);
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
    characters: portableContent.characters,
    pluginData: [],
    workingMemory: [],
    lorebookEntries: portableContent.lorebookEntries,
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

function isFreshLocalCheckpoint(checkpoint: BrowserCheckpoint): boolean {
  return (
    checkpoint.revision === 1 &&
    checkpoint.actionId === `local:create:${checkpoint.sessionId}`
  );
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

  private async mutateCheckpointNow(
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

  private mutateCheckpoint(
    sessionId: string,
    domain: string,
    mutate: (checkpoint: BrowserCheckpoint) => BrowserCheckpoint,
  ): Promise<BrowserCheckpoint> {
    return this.enqueueWorkspace(() =>
      this.mutateCheckpointNow(sessionId, domain, mutate),
    );
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
    delete metadata.characterBlueprintSources;
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

  async prepareWorldForServer(worldId: string): Promise<void> {
    return this.enqueueWorkspace(async () => {
      const world = await (await this.ready()).getWorld(worldId);
      if (!world) throw new Error(`World not found: ${worldId}`);
      await this.syncWorldToServerNow(world);
    });
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
      locale: locale ?? DEFAULT_LOCALE,
      phase: "setup",
      completedPlayerTurns: 0,
      setupRuntimes: {},
      activePlugins: _plugins ?? [],
      presetId,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    const storeSession: StoreSessionRecord = {
      id: session.id,
      worldId,
      status: "active",
      phase: "setup",
      completedPlayerTurns: 0,
      setupRuntimes: {},
      locale: locale ?? DEFAULT_LOCALE,
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
    opts: { limit?: number; cursor?: import("@covel/shared").PageCursor },
  ): Promise<CursorPage<MessageRecord>> {
    const limit = opts.limit ?? DEFAULT_MESSAGES_PAGE_LIMIT;
    const all = [
      ...((await (await this.ready()).getLatestCheckpoint(sessionId))
        ?.messages ?? []),
    ].sort(
      (a, b) =>
        a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    );
    const before = opts.cursor ? decodePageCursor(opts.cursor) : undefined;
    const eligible = before
      ? all.filter(
          (row) =>
            row.createdAt < before.createdAt ||
            (row.createdAt === before.createdAt && row.id < before.id),
        )
      : all;
    const rows = eligible.slice(-limit);
    const items = rows.map(toFrontendMessage);
    // 按契约：拿满一页（可能还有更旧）时游标指向最旧一条，否则到历史开头 → null。
    const nextCursor =
      items.length >= limit && items.length > 0
        ? encodePageCursor({ createdAt: items[0].createdAt, id: items[0].id })
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

  async stageServerCommit(sessionId: string, actionId: string): Promise<void> {
    await (await this.ready()).stagePendingCommit(sessionId, actionId);
  }

  async syncToServer(sessionId: string): Promise<void> {
    return this.enqueueWorkspace(() => this.syncToServerNow(sessionId));
  }

  private async syncWorldToServerNow(world: StoreWorldRecord): Promise<void> {
    try {
      await api.getWorld(world.id, { silentErrors: true });
      await api.updateWorld(world.id, serverWorldPatch(world));
    } catch (err) {
      if (!isNotFound(err)) throw err;
      await api.createWorld(serverWorldRequest(world));
    }
  }

  private async syncToServerNow(sessionId: string): Promise<void> {
    const vault = await this.ready();
    const pendingActionId = await vault.getPendingCommit(sessionId);
    if (pendingActionId) {
      try {
        await this.commitFromServerNow(sessionId, pendingActionId);
      } catch (error) {
        // A missing transient session means the MemoryStore restarted and the
        // pending result no longer exists. The browser checkpoint remains the
        // only durable authority and can safely rebuild a fresh mirror.
        if (!isNotFound(error)) throw error;
        await vault.clearPendingCommit(sessionId, pendingActionId);
      }
    }
    let checkpoint = await vault.getLatestCheckpoint(sessionId);
    if (!checkpoint) return;
    const world = checkpoint.session.worldId
      ? await vault.getWorld(checkpoint.session.worldId)
      : null;
    if (!world) return;
    if (JSON.stringify(checkpoint.world) !== JSON.stringify(world)) {
      checkpoint = await this.mutateCheckpointNow(
        sessionId,
        "world",
        (current) => ({ ...current, world }),
      );
    }
    const session = toFrontendSession(checkpoint.session);

    // Server and browser validators both accept underscores. Preserve IDs
    // exactly: actions continue to address the local SessionRecord id, so
    // creating a differently named server mirror would make every turn 404.
    const serverWorldId = world.id;
    const serverSessionId = session.id;

    // Keep the transient mirror current as well as present. Plugin planning and
    // world-data preflight run before session creation and depend on metadata.
    await this.syncWorldToServerNow(world);

    // Ensure session exists on server (pass local ID so server uses the same ID)
    try {
      await api.getSession(serverSessionId, { silentErrors: true });
    } catch (err) {
      if (!isNotFound(err)) throw err;
      const created = await api.createSession(
        serverWorldId,
        session.presetId,
        serverSessionId,
        [...session.activePlugins],
        session.locale,
      );
      // Only a never-hydrated local session needs the server to resolve its
      // initial setup band. When rebuilding an ephemeral mirror after a server
      // restart, the browser checkpoint is already authoritative and must not
      // be reset to the newly created server session's empty clock.
      if (isFreshLocalCheckpoint(checkpoint)) {
        checkpoint = await this.mutateCheckpointNow(
          sessionId,
          "server-clock",
          (current) => ({
            ...current,
            session: {
              ...current.session,
              phase: created.phase,
              completedPlayerTurns: created.completedPlayerTurns,
              setupRuntimes: created.setupRuntimes,
            },
          }),
        );
      }
    }

    await api.uploadBrowserCheckpoint(serverSessionId, {
      ...checkpoint,
      world: serverCheckpointWorld(world),
    });
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
    // The server mirror deliberately uses locale-resolved WorldRecord strings.
    // The browser remains authoritative for the richer local world document,
    // so do not let a returned execution commit downgrade its i18n fields.
    const browserWorld = current.session.worldId
      ? await vault.getWorld(current.session.worldId)
      : current.world;
    await vault.applySessionCommit({
      ...commit,
      checkpoint: {
        ...commit.checkpoint,
        world: browserWorld,
      },
    });
    await vault.clearPendingCommit(sessionId, actionId);
  }

  async saveExecutionSteps(sessionId: string, steps: unknown[]): Promise<void> {
    await appKv.saveExecutionSteps(sessionId, steps);
  }

  async loadExecutionSteps(sessionId: string): Promise<unknown[]> {
    return appKv.getExecutionSteps(sessionId);
  }
}
